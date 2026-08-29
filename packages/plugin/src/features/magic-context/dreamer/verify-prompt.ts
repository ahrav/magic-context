/**
 * verify prompt + manifest parser.
 *
 * verify checks each in-scope project memory against the CURRENT source and
 * emits ONE XML manifest (verified / update / archive). The agent reads code
 * and changes nothing; the HOST parses the manifest and applies the DB writes
 * (so the agent never needs a mutation tool). Calibrated in the shadow harness
 * with planted ground-truth controls (4/4: caught a stale number → update, a
 * wrong tool-count → archive, a same-session change → archive, and kept the
 * correct control verified). See .alfonso/plans/dreamer-v2-rework.md.
 *
 * The DANGEROUS failure mode is WRONG ARCHIVAL (deleting a TRUE memory), so the
 * prompt and the host apply both bias hard toward keeping memories.
 */

import type { ClaimMutationToken } from "../memory/claim-operation-contract";
import { ANTI_MEMORY_CATEGORY } from "../memory/constants";
import {
    assertManifestCoversExactly,
    assertNoDuplicateManifestIds,
    assertParsedManifestNonEmpty,
    describeUnrecognizedManifestShape,
    extractCompleteManifestBody,
} from "./manifest-parser";

export const VERIFY_SYSTEM_PROMPT = `You are a memory verifier for the magic-context system. You verify project memories against the CURRENT code.

Each memory below comes with its backing file(s) — the code it makes a claim about. For EACH memory: read its backing files (you may read more if needed) and decide whether the memory is still accurate.

Tools (read-only): read, grep, glob, aft_search, aft_outline, aft_zoom. You read code to check claims; you change nothing.

Decide ONE of three outcomes per memory:
- VERIFIED — still accurate. Keep it as-is.
- UPDATE — the underlying fact is still true but a DETAIL drifted (a renamed symbol, moved file, changed number/name). Provide corrected content in terse present tense ("X uses Y", not "X was changed to Y"). Only update for genuine drift, not style.
- ARCHIVE — the code CLEARLY contradicts the memory, or the thing it describes no longer exists.

BE CONSERVATIVE ABOUT ARCHIVING. Wrong archival of a TRUE memory is the worst possible outcome — far worse than leaving a slightly-stale memory. If you cannot find the code, or you are unsure, or it might still be true somewhere you didn't look: mark it VERIFIED, never archived. Archive ONLY when you have positive evidence the code contradicts it.

Anti-memory records (${ANTI_MEMORY_CATEGORY}) invert that archival bias because retaining an obsolete rejection creates a false warning. Check current project evidence even when no backing files are listed. Use ARCHIVE when the rejection no longer clearly holds; the host preserves it as labeled stale history rather than deleting it. VERIFIED extends its validity window. UPDATE must return the complete field-labeled anti-memory content.

Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<verify>
<verified claim="mcm_..." files="path/a.ts,path/b.ts"/>
<update claim="mcm_..." files="path/c.ts">corrected present-tense content</update>
<archive claim="mcm_..." reason="specific evidence the code contradicts it"/>
</verify>

Rules:
- Every input public claim id MUST appear exactly once, in exactly one of verified/update/archive.
- files = the COMPLETE current backing set (repo-relative, comma-separated). It may differ from the given mapping if a file moved — record what you actually verified against.
- Default to VERIFIED. update and archive are the exceptions, not the norm.`;

export interface VerifyPromptMemory {
    publicClaimId: string;
    revisionLocator: string;
    contentDigest: string;
    mutationToken: ClaimMutationToken;
    category: string;
    content: string;
    mappedFiles: string[];
}

export function buildVerifyPrompt(projectPath: string, memories: VerifyPromptMemory[]): string {
    const list = memories
        .map(
            (m) =>
                `[${m.publicClaimId}] ${m.category}\nRevision: ${m.revisionLocator}\nContent digest: ${m.contentDigest}\nContent: ${m.content}\nBacking files: ${m.mappedFiles.length === 0 ? "(none; inspect current project evidence)" : m.mappedFiles.join(", ")}`,
        )
        .join("\n\n");
    return `## Verify these memories against the code

Project: ${projectPath}

Read each memory's backing files, decide verified / update / archive (default verified; be conservative about archiving), then output ONE <verify> manifest covering every public claim id.

<memories>
${list}
</memories>`;
}

export interface ParsedVerifyManifest {
    verified: Array<{ publicClaimId: string; files: string[] }>;
    updated: Array<{ publicClaimId: string; files: string[]; content: string }>;
    archived: Array<{ publicClaimId: string; reason: string }>;
}

function attrOf(s: string, name: string): string | null {
    const m = s.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
    return m ? m[1] : null;
}

function filesOf(s: string): string[] {
    return (attrOf(s, "files") ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
}

function verifyIds(parsed: ParsedVerifyManifest): string[] {
    return [...parsed.verified, ...parsed.updated, ...parsed.archived].map(
        (entry) => entry.publicClaimId,
    );
}

function verifyBody(text: string): string {
    try {
        return extractCompleteManifestBody(text, "verify");
    } catch (error) {
        const described = describeUnrecognizedManifestShape(text, "verify", "verified");
        if (!described.startsWith("parsed zero entries")) throw new Error(described);
        throw error;
    }
}

/** Parse the agent's complete `<verify>` manifest. The root close tag is
 *  mandatory so truncated output cannot apply a partial set of verdicts.
 *  A well-formed root with no recognized entries is a format miss, not success. */
export function parseVerifyManifest(
    text: string,
    allowFilelessClaimIds: ReadonlySet<string> = new Set(),
): ParsedVerifyManifest {
    const out: ParsedVerifyManifest = { verified: [], updated: [], archived: [] };
    const body = verifyBody(text);

    for (const m of body.matchAll(/<verified\b([^>]*)\/?>/g)) {
        const publicClaimId = attrOf(m[1], "claim");
        if (!publicClaimId) throw new Error("verify manifest entry missing public claim id");
        const files = filesOf(m[1]);
        if (files.length === 0 && !allowFilelessClaimIds.has(publicClaimId)) {
            throw new Error(`verify manifest entry ${publicClaimId} is missing backing files`);
        }
        out.verified.push({ publicClaimId, files });
    }
    for (const m of body.matchAll(/<update\b([^>]*?)(?:\/>|>([\s\S]*?)<\/update>)/g)) {
        const publicClaimId = attrOf(m[1], "claim");
        if (!publicClaimId) throw new Error("verify manifest entry missing public claim id");
        const files = filesOf(m[1]);
        if (files.length === 0 && !allowFilelessClaimIds.has(publicClaimId)) {
            throw new Error(`verify manifest entry ${publicClaimId} is missing backing files`);
        }
        out.updated.push({
            publicClaimId,
            files,
            content: (m[2] ?? "").trim(),
        });
    }
    for (const m of body.matchAll(/<archive\b([^>]*)\/?>/g)) {
        const publicClaimId = attrOf(m[1], "claim");
        if (!publicClaimId) throw new Error("verify manifest entry missing public claim id");
        out.archived.push({ publicClaimId, reason: attrOf(m[1], "reason") ?? "" });
    }
    if (verifyIds(out).length === 0 && body.trim().length > 0) {
        throw new Error(describeUnrecognizedManifestShape(text, "verify", "verified"));
    }
    assertNoDuplicateManifestIds(verifyIds(out), "verify");
    return out;
}

/** Retry-time contract: non-empty parse + exact id coverage. Apply still
 *  re-asserts coverage as the final belt. */
export function validateVerifyManifest(
    text: string,
    expectedIds: ReadonlySet<string>,
    allowFilelessClaimIds: ReadonlySet<string> = new Set(),
): ParsedVerifyManifest {
    const parsed = parseVerifyManifest(text, allowFilelessClaimIds);
    const ids = verifyIds(parsed);
    assertParsedManifestNonEmpty(ids.length, expectedIds.size, text, "verify", "verified");
    assertManifestCoversExactly(ids, expectedIds, "verify");
    return parsed;
}
