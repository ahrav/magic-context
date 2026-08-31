import { existsSync, statSync } from "node:fs";
import path from "node:path";

import type { ClaimMutationToken } from "../memory/claim-operation-contract";
import {
    assertManifestCoversExactly,
    assertNoDuplicateManifestIds,
    assertParsedManifestNonEmpty,
    describeUnrecognizedManifestShape,
    extractCompleteManifestBody,
} from "./manifest-parser";

/**
 *
 * The mapping lets verify check only files changed since each memory's last verification.
 * The host records each memory's backing-file mapping.
 * Without a mapping, the first verify checks the whole pool and can time out.
 *
 * The agent locates backing files; the host parses the XML manifest and appends exact-revision applicability paths.
 */

export const MAP_MEMORIES_SYSTEM_PROMPT = `You are a memory mapper for the magic-context system. You map project memories to the repository files that back them.

A memory's BACKING FILES are the file(s) whose code the memory makes a claim about — the files you would open to check whether the memory is accurate. You do NOT judge accuracy, rewrite, or remove anything. You only LOCATE backing files.

Tools (read-only): read, grep, glob, aft_search, aft_outline, aft_zoom. Each memory may come with "Likely files" already named in it and confirmed to exist — confirm those FIRST (cheap) instead of searching. Use search/grep to FIND code only when no likely files are given. Do not guess — confirm a file exists and genuinely backs the memory before listing it. Keep reads minimal: you do not need to read a whole file to confirm it backs a one-line claim.

For each memory decide ONE of:
- Backing files found → the COMPLETE set of repo-relative paths whose code the memory is about.
- File-independent → the memory describes EXTERNAL behavior (a provider / API / platform / protocol limit, e.g. "Anthropic returns 400 on empty content"), or a pure process / workflow / philosophy rule, with NO specific local file that backs it.

Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<mappings>
<memory claim="mcm_..." files="path/a.ts,path/b.ts"/>
<memory claim="mcm_..." independent="true"/>
</mappings>

Rules:
- Every input public claim id MUST appear exactly once.
- files: repo-relative, comma-separated, no spaces inside a path. Only files that actually exist and genuinely back the memory.
- A BACKING FILE is CODE that implements or handles the claim — not a file that merely mentions it. A markdown doc (.md), a PARITY/notes file, or a test that only DESCRIBES an external fact is NOT a backing file. If the only place a memory's fact appears is prose/docs/a test (no code implements or handles it), mark it independent="true".
- Many CONSTRAINTS are HYBRID: "external system does X, and OUR code handles it here." Map those to the HANDLING code (you can verify the handling, even though you can't verify the external behavior). Only mark independent when there is NO local code that implements or handles the fact.
- Prefer the most specific file(s); do not pad with tangential files. Most memories map to one file; some to a few.
- When you genuinely cannot find any local backing and it is not clearly external, still emit the memory with independent="true" (do not drop it).`;

// Seed at most three path strings per memory to bound context.
// The seeder includes paths, never file contents, to stay within the context limit.
export const MAX_SEED_PATHS_PER_MEMORY = 3;

// Seed only paths named by the memory; validate their existence before seeding because paths can be stale or renamed.
// Each call creates a new regex because a shared /g regex retains lastIndex across calls and skips initial matches in later inputs.
const PATH_PATTERN =
    "`?((?:[\\w.-]+\\/)+[\\w.-]+\\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|json|jsonc|sql|toml|sh))`?";

/**
 * The seeder does not read file contents or call an LLM. */
export function extractMemoryCandidatePaths(content: string, repoDir: string): string[] {
    const found = new Set<string>();
    const root = path.resolve(repoDir);
    for (const match of content.matchAll(new RegExp(PATH_PATTERN, "g"))) {
        const rel = match[1];
        if (rel.includes("..")) continue;
        const abs = path.resolve(repoDir, rel);
        if (!abs.startsWith(`${root}/`)) continue;
        try {
            if (existsSync(abs) && statSync(abs).isFile()) found.add(rel);
        } catch {
            /* */
        }
        if (found.size >= MAX_SEED_PATHS_PER_MEMORY) break;
    }
    return [...found];
}

export interface MapMemoryInput {
    publicClaimId: string;
    revisionLocator: string;
    contentDigest: string;
    mutationToken: ClaimMutationToken;
    category: string;
    content: string;
    candidates: string[];
}

export function buildMapMemoriesPrompt(projectPath: string, memories: MapMemoryInput[]): string {
    const list = memories
        .map((m) => {
            const seed = m.candidates.length
                ? `\nLikely files (named in the memory, confirmed to exist): ${m.candidates.join(", ")}`
                : "";
            return `[${m.publicClaimId}] ${m.category} revision=${m.revisionLocator} digest=${m.contentDigest}\n${m.content}${seed}`;
        })
        .join("\n\n");
    return `## Map these memories to their backing files

Project: ${projectPath}

For each memory below, find the repo file(s) it makes a claim about, or mark it file-independent. When "Likely files" are listed, those paths are named in the memory and confirmed to exist — START there: confirm each actually backs the claim (a quick read/outline), drop any that don't, add others only if genuinely needed. Search from scratch only when no likely files are given. Then output ONE <mappings> manifest covering every public claim id.

<memories>
${list}
</memories>`;
}

export interface ParsedMemoryMapping {
    publicClaimId: string;
    files: string[];
    independent: boolean;
}

const MEMORY_ELEMENT_PATTERN = "<memory\\b([^>]*)(?:\\/>|>([\\s\\S]*?)<\\/memory>)";
const NESTED_FILE_PATTERN = "<file\\b([^>]*)\\/?>";

function extractNestedFilePaths(inner: string): string[] {
    const files: string[] = [];
    for (const match of inner.matchAll(new RegExp(NESTED_FILE_PATTERN, "gi"))) {
        const pathMatch = match[1].match(/\bpath\s*=\s*"([^"]+)"/);
        if (pathMatch) files.push(pathMatch[1].trim());
    }
    return files.filter(Boolean);
}

function mappingsBody(text: string): string {
    try {
        return extractCompleteManifestBody(text, "mappings");
    } catch (error) {
        const described = describeUnrecognizedManifestShape(text, "mappings", "memory");
        // Treat a wrong root or JSON as format errors, not truncation, so a length-capped `<mappings>` reports truncation rather than an unrecognized shape.
        if (!described.startsWith("parsed zero entries")) throw new Error(described);
        throw error;
    }
}

/** A missing `</mappings>` rejects the whole batch as truncation.
 * The parser honors `independent` only when it equals `"true"`.
 * Do not treat a missing `files` attribute as file-independent; doing so excludes the memory from verify.
 *  `<file path="…"/>` children are accepted as an unambiguous alias. */
export function parseMapMemoriesManifest(text: string): ParsedMemoryMapping[] {
    const out: ParsedMemoryMapping[] = [];
    const body = mappingsBody(text);
    for (const m of body.matchAll(new RegExp(MEMORY_ELEMENT_PATTERN, "gi"))) {
        const attrs = m[1];
        const inner = m[2];
        const claimMatch = attrs.match(/\bclaim\s*=\s*"([^"]+)"/);
        if (!claimMatch) throw new Error("mappings manifest entry missing public claim id");
        const publicClaimId = claimMatch[1];
        const independent = /\bindependent\s*=\s*"(?:true|1)"/i.test(attrs);
        const filesMatch = attrs.match(/\bfiles\s*=\s*"([^"]*)"/);
        const attrFiles = filesMatch
            ? filesMatch[1]
                  .split(",")
                  .map((f) => f.trim())
                  .filter(Boolean)
            : [];
        const nestedFiles = inner ? extractNestedFilePaths(inner) : [];
        const files = attrFiles.length > 0 ? attrFiles : nestedFiles;
        if (!independent && files.length === 0) {
            throw new Error(
                `mappings manifest entry ${publicClaimId} has neither files nor independent="true"`,
            );
        }
        out.push({
            publicClaimId,
            files: independent && files.length === 0 ? [] : files,
            independent: independent && files.length === 0,
        });
    }
    if (out.length === 0 && body.trim().length > 0) {
        throw new Error(describeUnrecognizedManifestShape(text, "mappings", "memory"));
    }
    assertNoDuplicateManifestIds(
        out.map((entry) => entry.publicClaimId),
        "mappings",
    );
    return out;
}

/**
 * */
export function validateMapMemoriesManifest(
    text: string,
    expectedIds: ReadonlySet<string>,
): ParsedMemoryMapping[] {
    const parsed = parseMapMemoriesManifest(text);
    assertParsedManifestNonEmpty(parsed.length, expectedIds.size, text, "mappings", "memory");
    assertManifestCoversExactly(
        parsed.map((entry) => entry.publicClaimId),
        expectedIds,
        "mappings",
    );
    return parsed;
}
