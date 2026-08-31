/**
 * The module performs a non-agentic single-shot classification transform.
 *
 * The classifier derives importance, scope, and shareability from memory text only; it does not inspect code.
 * The host renders one prompt for the zero-tool classifier agent.
 * The agent emits one XML manifest, and the host batch-applies revision-bound claim attributes under one operation receipt.
 * The host makes no per-claim tool calls.
 *
 */

import {
    assertManifestCoversExactly,
    assertNoDuplicateManifestIds,
    assertParsedManifestNonEmpty,
    describeUnrecognizedManifestShape,
    extractCompleteManifestBody,
} from "./manifest-parser";

export interface ClassifyPromptMemory {
    publicClaimId: string;
    revisionLocator: string;
    contentDigest: string;
    category: string;
    content: string;
    importance: number;
    scope: "project" | "ecosystem" | "universe";
    shareable: number | boolean;
}

/** In large pools, anchors calibrate new and changed memories against the existing score distribution.
 * */
export interface ClassifyAnchorMemory {
    publicClaimId: string;
    category: string;
    content: string;
    importance: number;
}

const SCORING_GUIDANCE = `### How to score importance (1-100)
Importance decides which memories survive when the injected memory block is over budget: high scores stay in context, low scores drop first. So the score is only useful if it **discriminates** — if most memories land in the same band, you have not classified them, you have just labelled them.

Use judgment, not a formula. Blend:
- **Durability / decay-rate value:** Will this fact still matter weeks from now, across sessions?
- **Operational impact:** Would missing this fact cause wrong code, wasted time, broken workflows, or violated constraints?

Most memories are ordinary working facts — they belong in the middle, not the top. Reserve the high band for the genuinely load-bearing handful a teammate would be sunk without; push routine observations, one-off details, and now-obvious facts down. A "real, true fact" is not automatically important — truth is not importance.

Rough anchors (not quotas — spread naturally within them): transient/obvious observations 1-30, ordinary helpful project facts 40-65, load-bearing rules/architecture/constraints 70-100. A constraint that is a genuine must/never/always rule the project actively depends on floors around 60; but not every memory in a category is load-bearing — a niche, dated, or narrowly-scoped external quirk can sit lower even if it is a "constraint". Score the fact, not the label. If you assigned most of the pool to one band, re-read and differentiate.

One hard floor: an operating rule whose VIOLATION causes a public-facing or irreversible mistake — posting under the wrong identity, committing/pushing without approval, leaking private content, running destructive commands — scores at least 80. These rules only work if they are always in view; a mid-band score silently drops them from context exactly when the pool grows, and the violation happens. Judge by consequence-of-forgetting, not by how mundane the rule text reads.

### Scope
- \`project\` — only meaningful inside this repository/product (default when uncertain).
- \`ecosystem\` — useful to sibling projects in the same stack, harness, provider, or company ecosystem.
- \`universe\` — broadly true outside this codebase (protocol/platform/API facts), still written as a concise memory.

### Shareability
Shareability is about EXPOSURE, not scope: **would a teammate working on THIS SAME project benefit from seeing this memory, and is it free of anything personal, local, or sensitive?** If yes, set \`shareable="true"\`. This is the COMMON case — most project knowledge is exactly what you'd hand a new teammate: architecture, design rules, conventions, constraints, file locations, hard-won gotchas. Mark those shareable even though they are specific to this repo's internals.

Keep \`shareable="false"\` only for what is tied to the USER or their machine rather than the project: personal/absolute paths, usernames, local or private endpoints (e.g. localhost), credentials/secrets/tokens, customer data, machine-specific config, and personal working-style preferences. A fact's scope does NOT decide shareability. The host also fails closed and forces secret/credential/personal-path text to private regardless.`;

const OUTPUT_CONTRACT = `Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<classify>
<memory claim="mcm_..." importance="75" scope="project" shareable="true"/>
<memory claim="mcm_..." importance="20" scope="universe" shareable="false"/>
</classify>

Rules:
- Every memory in the pool below MUST appear exactly once.
- importance is an integer 1-100; scope is one of project|ecosystem|universe; shareable is true|false.`;

export const CLASSIFY_SYSTEM_PROMPT = `You are a memory classifier for the magic-context system. You classify project memories by metadata only. You do NOT rewrite, merge, archive, verify, or create memories, and you do NOT read code — you judge each memory from its own text.

${SCORING_GUIDANCE}

${OUTPUT_CONTRACT}`;

function renderPool(memories: ClassifyPromptMemory[]): string {
    return memories
        .map(
            (m) =>
                `[${m.publicClaimId}] ${m.category} revision=${m.revisionLocator} digest=${m.contentDigest} (current: importance=${m.importance} scope=${m.scope} shareable=${Boolean(m.shareable)})\n${m.content}`,
        )
        .join("\n\n");
}

function renderAnchors(anchors: ClassifyAnchorMemory[]): string {
    if (anchors.length === 0) return "";
    const list = anchors
        .map((a) => `[${a.publicClaimId}] ${a.category} importance=${a.importance}\n${a.content}`)
        .join("\n\n");
    return `### Already-classified reference memories (calibrate against these — do NOT re-score them, they are NOT in your output)
${list}

`;
}

/**
 * Anchors calibrate new and changed memories against the existing score distribution in large pools.
 */
export function buildClassifyPrompt(args: {
    projectPath: string;
    memories: ClassifyPromptMemory[];
    anchors?: ClassifyAnchorMemory[];
}): string {
    return `## Task: Classify Project Memories

**Project:** ${args.projectPath}

Score EVERY memory in the pool below. Emit one <classify> manifest covering every id.

${renderAnchors(args.anchors ?? [])}### Memory pool to classify
${renderPool(args.memories)}`;
}

export interface ParsedClassification {
    publicClaimId: string;
    importance?: number;
    scope?: "project" | "ecosystem" | "universe";
    shareable?: boolean;
}

const SCOPES = new Set(["project", "ecosystem", "universe"]);

function classifyBody(text: string): string {
    try {
        return extractCompleteManifestBody(text, "classify");
    } catch (error) {
        const described = describeUnrecognizedManifestShape(text, "classify", "memory");
        if (!described.startsWith("parsed zero entries")) throw new Error(described);
        throw error;
    }
}

/**
 * The parser treats zero `<memory>` entries as a format error. */
export function parseClassifyManifest(text: string): ParsedClassification[] {
    const out: ParsedClassification[] = [];
    const body = classifyBody(text);
    for (const m of body.matchAll(/<memory\b([^>]*)\/?>/g)) {
        const attrs = m[1];
        const claimMatch = attrs.match(/\bclaim\s*=\s*"([^"]+)"/);
        if (!claimMatch) throw new Error("classify manifest entry missing public claim id");
        const publicClaimId = claimMatch[1];

        const entry: ParsedClassification = { publicClaimId };
        const impMatch = attrs.match(/\bimportance\s*=\s*"(\d+)"/);
        if (impMatch) {
            const imp = Number.parseInt(impMatch[1], 10);
            if (Number.isInteger(imp)) entry.importance = Math.max(1, Math.min(100, imp));
        }
        const scopeMatch = attrs.match(/\bscope\s*=\s*"([a-z]+)"/i);
        if (scopeMatch) {
            const scope = scopeMatch[1].toLowerCase();
            if (!SCOPES.has(scope)) throw new Error(`classify manifest invalid scope ${scope}`);
            entry.scope = scope as ParsedClassification["scope"];
        }
        const shareMatch = attrs.match(/\bshareable\s*=\s*"(true|false|1|0)"/i);
        if (shareMatch) {
            const v = shareMatch[1].toLowerCase();
            entry.shareable = v === "true" || v === "1";
        }
        if (entry.importance === undefined && !entry.scope && entry.shareable === undefined) {
            throw new Error(
                `classify manifest entry ${publicClaimId} missing classification fields`,
            );
        }
        out.push(entry);
    }
    if (out.length === 0 && body.trim().length > 0) {
        throw new Error(describeUnrecognizedManifestShape(text, "classify", "memory"));
    }
    assertNoDuplicateManifestIds(
        out.map((entry) => entry.publicClaimId),
        "classify",
    );
    return out;
}

/**
 * */
export function validateClassifyManifest(
    text: string,
    expectedIds: ReadonlySet<string>,
): ParsedClassification[] {
    const parsed = parseClassifyManifest(text);
    assertParsedManifestNonEmpty(parsed.length, expectedIds.size, text, "classify", "memory");
    assertManifestCoversExactly(
        parsed.map((entry) => entry.publicClaimId),
        expectedIds,
        "classify",
    );
    return parsed;
}
