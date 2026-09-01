/**
 *
 * renderMural.
 *
 *
 */

import { extractCompleteManifestBody } from "../dreamer/manifest-parser";

export interface CompressCuesPromptMemory {
    id: string;
    category: string;
    importance: number;
    content: string;
}

/**
 * */
export const CUE_BUDGET_HIGH = 90;
export const CUE_BUDGET_LOW = 50;

export function cueBudgetFor(importance: number): number {
    return importance >= 70 ? CUE_BUDGET_HIGH : CUE_BUDGET_LOW;
}

export const COMPRESS_CUES_SYSTEM_PROMPT = `You compress project memories into mnemonic mural cues. Each cue is a compact pidgin anchor that lets a reader recall the full memory at a glance — NOT a sentence, NOT a summary. You do not select, rank, group, merge, or reword the underlying facts; you compress each supplied memory into one cue, independently.

### Cue grammar
- A cue is mnemonic shorthand, not prose. Prefer one to three distinctive tokens plus a relation. Use the symbols → ← ⊘ ∵ ≺ ≻ ∅ ∀ when they are shorter than words.
- Preserve exact identifiers, paths, commands, flags, versions, filenames, hashes, and code tokens VERBATIM. These are the anchor — never abbreviate or paraphrase them.
- Per-cue hard budget (in characters): ${CUE_BUDGET_HIGH} when importance >= 70, else ${CUE_BUDGET_LOW}. Exceeding the budget makes the cue unusable, so compress harder rather than overrun.
- Never put a source claim id (e.g. mcm_0123abcd...) in a cue.
- XML-escape &, <, >, and quotes in cue text (&amp; &lt; &gt; &quot;).
- A PROHIBITION must mark the excluded thing as ⊘thing followed IMMEDIATELY by a terse parenthesized mechanism, e.g. ⊘cache write (ABI break). Keep parentheses balanced. Positive facts must be phrased WITHOUT trigger words (must not / never / without / instead of / exclude).
- Do not invent facts, add commentary, or restate the category. Compress only what the memory says.

### Output contract
Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<cues>
<cue id="mcm_00000000000000000000000000000001">terse anchor → relation</cue>
<cue id="mcm_00000000000000000000000000000002">⊘cache write (ABI break)</cue>
</cues>

Rules:
- Emit exactly one <cue> per memory in the pool below, using its id.
- The complete <cues> root must be closed. Do not wrap it in a Markdown fence.`;

function renderPool(memories: CompressCuesPromptMemory[]): string {
    return memories
        .map(
            (memory) =>
                `[${memory.id}] ${memory.category} importance=${memory.importance} (budget ${cueBudgetFor(memory.importance)})\n${memory.content}`,
        )
        .join("\n\n");
}

/**
 * */
export function buildCompressCuesPrompt(args: {
    projectPath: string;
    memories: CompressCuesPromptMemory[];
}): string {
    return `## Task: Compress Project Memory Cues

**Project:** ${args.projectPath}

Compress EVERY memory in the pool below into one mural cue. Emit one <cues> manifest with exactly one <cue> per id.

### Memory pool to compress
${renderPool(args.memories)}`;
}

export interface ParsedCue {
    id: string;
    cue: string;
}

function unescapeXml(value: string): string {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
}

/**
 */
export function parseCuesManifest(text: string): ParsedCue[] {
    const body = extractCompleteManifestBody(text, "cues");
    const out: ParsedCue[] = [];
    for (const match of body.matchAll(/<cue\s+id="([^"]+)"\s*>([\s\S]*?)<\/cue>/g)) {
        const id = (match[1] ?? "").trim();
        if (id.length === 0) continue;
        out.push({ id, cue: unescapeXml(match[2] ?? "").trim() });
    }
    return out;
}
