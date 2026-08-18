/**
 * Build a compact "you may recall something related" hint from unified search
 * results, ready to append to a user message.
 *
 * The hint intentionally compresses fragments so they feel like vague recall
 * rather than a drop-in answer — the goal is to nudge the agent to run
 * ctx_search for full context, not to provide the answer itself.
 *
 * Compression strategy per source:
 *   - memory → caveman-ultra via `cavemanCompress()` (token-dense)
 *   - git_commit → raw commit subject (already terse); prefixed with SHA + age
 *   - message → caveman-ultra, role tag
 *
 * Guardrails:
 *   - Every dynamic source field is bounded to MAX_RENDER_FIELD_BYTES of
 *     valid UTF-8 BEFORE compression or tokenization, so the budget check
 *     itself never performs unbounded work
 *   - Per-fragment token cap (~20 tokens, ~80 chars) with ellipsis truncation
 *   - Skip fragments whose source is already present in visible session-history
 *     (caller handles) — this module only knows about search results
 *   - Total output is token-packed under MAX_AUTO_HINT_TOKENS: an over-budget
 *     fragment is omitted whole while the wrapper and footer cue stay intact
 */

import type { UnifiedSearchResult } from "../../features/magic-context/search";
import {
    boundDynamicField,
    MAX_AUTO_HINT_TOKENS,
} from "../../features/magic-context/search-bounds";
import { formatAge } from "../../shared/format-age";
import { estimateTokens } from "../../shared/token-estimator";
import { cavemanCompress } from "./caveman";

const MAX_FRAGMENTS = 3;
const FRAGMENT_CHAR_CAP = 80; // ~20 tokens at 3.5 chars/token

export interface AutoSearchHintOptions {
    maxFragments?: number;
    fragmentCharCap?: number;
}

function truncate(text: string, limit: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function renderFragment(result: UnifiedSearchResult, charCap: number): string {
    switch (result.source) {
        case "memory": {
            const compressed = cavemanCompress(boundDynamicField(result.content), "ultra");
            return truncate(compressed, charCap);
        }
        case "git_commit": {
            // Use only the subject line (first line) — bodies add noise without
            // changing the recall trigger. Preserve the short SHA + relative age
            // so the agent can decide if the age is even relevant.
            const bounded = boundDynamicField(result.content);
            const subject = bounded.split(/\r?\n/)[0] ?? bounded;
            const body = truncate(subject, Math.max(10, charCap - 20));
            return `commit ${boundDynamicField(result.shortSha)} ${formatAge(result.committedAtMs)}: ${body}`;
        }
        case "message": {
            const compressed = cavemanCompress(boundDynamicField(result.content), "ultra");
            return truncate(compressed, charCap);
        }
        case "compartment": {
            const source = boundDynamicField(result.snippet ?? result.title);
            const compressed = cavemanCompress(source, "ultra");
            return truncate(compressed, charCap);
        }
        case "primer": {
            const compressed = cavemanCompress(boundDynamicField(result.content), "ultra");
            return truncate(compressed, charCap);
        }
        case "note": {
            const compressed = cavemanCompress(boundDynamicField(result.content), "ultra");
            return truncate(compressed, charCap);
        }
    }
}

function assembleHint(lines: readonly string[]): string {
    const header =
        lines.length === 1
            ? "Your memory may contain 1 related fragment:"
            : `Your memory may contain ${lines.length} related fragments:`;
    const footer =
        "If the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.";
    const body = [header, ...lines, footer].join("\n");
    return `<ctx-search-hint>\n${body}\n</ctx-search-hint>`;
}

/**
 * Build the hint text. Returns null when `results` is empty, when no fragment
 * has meaningful content after compression, or when limits zero out the budget.
 *
 * This function does NOT enforce score thresholds or message-length rules —
 * callers (the transform-time auto-search wiring) apply those gates first.
 */
export function buildAutoSearchHint(
    results: UnifiedSearchResult[],
    options: AutoSearchHintOptions = {},
): string | null {
    const maxFragments = Math.max(1, options.maxFragments ?? MAX_FRAGMENTS);
    const fragmentCharCap = Math.max(20, options.fragmentCharCap ?? FRAGMENT_CHAR_CAP);

    const picks = results.slice(0, maxFragments);
    const lines: string[] = [];

    for (const result of picks) {
        const fragment = renderFragment(result, fragmentCharCap);
        if (fragment.length === 0) continue;
        lines.push(`- ${fragment}`);
    }

    // Token-pack whole fragments: drop from the tail until the assembled hint
    // (wrapper and footer included) fits the budget. A lone over-budget
    // fragment yields no hint rather than a partially emitted one.
    while (lines.length > 0) {
        const wrapped = assembleHint(lines);
        if (estimateTokens(wrapped) <= MAX_AUTO_HINT_TOKENS) {
            return wrapped;
        }
        lines.pop();
    }
    return null;
}
