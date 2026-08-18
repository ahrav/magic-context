/**
 * Shared token-budgeted rendering for explicit `ctx_search` output.
 *
 * OpenCode and Pi both render through this module so caps, ordering, and
 * formatted text cannot drift between harnesses (R39-R40). Each dynamic
 * result field is bounded to MAX_DYNAMIC_FIELD_BYTES of valid UTF-8 before
 * any tokenization, and packing keeps a ranked prefix of complete result
 * blocks under MAX_RENDERED_RESULT_TOKENS with reserved header, expand
 * hints, and omission notice.
 */

import type { UnifiedSearchResult } from "../../features/magic-context/search";
import {
    boundDynamicField,
    MAX_RENDERED_RESULT_TOKENS,
} from "../../features/magic-context/search-bounds";
import { estimateTokens } from "../../shared/token-estimator";

const NOTE_EXPAND_HINT =
    "Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.";
const MESSAGE_EXPAND_HINT =
    "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.";

function formatAge(committedAtMs: number): string {
    const ageMs = Date.now() - committedAtMs;
    if (ageMs < 0) return "future";
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months === 1) return "1mo ago";
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? "1y ago" : `${years}y ago`;
}

function formatResult(
    result: UnifiedSearchResult,
    index: number,
    currentSessionId: string,
): string {
    if (result.source === "memory") {
        const source = result.sourceName ? ` source=${boundDynamicField(result.sourceName)}` : "";
        return [
            `[${index}] [memory] score=${result.score.toFixed(2)} id=${result.memoryId} category=${boundDynamicField(result.category)}${source} match=${result.matchType}`,
            boundDynamicField(result.content),
        ].join("\n");
    }

    if (result.source === "git_commit") {
        return [
            `[${index}] [git_commit] score=${result.score.toFixed(2)} sha=${boundDynamicField(result.shortSha)} ${formatAge(result.committedAtMs)} match=${result.matchType}`,
            boundDynamicField(result.content),
        ].join("\n");
    }

    if (result.source === "primer") {
        return [
            `[${index}] [primer] score=${result.score.toFixed(2)} id=${result.primerId} support=${result.support} match=${result.matchType}`,
            boundDynamicField(result.content),
        ].join("\n");
    }

    if (result.source === "note") {
        const anchor =
            result.anchorOrdinal !== null && result.sourceSessionId === currentSessionId
                ? ` @msg ${result.anchorOrdinal}`
                : "";
        return [
            `[${index}] [note] score=${result.score.toFixed(2)} id=#${result.noteId} status=${result.status} ${formatAge(result.createdAt)}${anchor}`,
            boundDynamicField(result.content),
        ].join("\n");
    }

    if (result.source === "compartment") {
        return [
            `[${index}] [message] score=${result.score.toFixed(2)} compartment_id=${result.compartmentId} range=${result.startOrdinal}-${result.endOrdinal} match=${result.matchType} title=${boundDynamicField(result.title)}`,
            result.snippet
                ? `Snippet: ${boundDynamicField(result.snippet)}`
                : boundDynamicField(result.content),
        ].join("\n");
    }

    const expandStart = Math.max(1, result.messageOrdinal - 3);
    const expandEnd = result.messageOrdinal + 3;
    return [
        `[${index}] [message] score=${result.score.toFixed(2)} ordinal=${result.messageOrdinal} range=${expandStart}-${expandEnd} role=${result.role}`,
        boundDynamicField(result.content),
    ].join("\n");
}

/** Body parts (blocks + applicable expand hints) for a rendered prefix. */
function bodyPartsFor(
    blocks: readonly string[],
    rendered: readonly UnifiedSearchResult[],
    currentSessionId: string,
): string[] {
    const parts = [...blocks];
    if (rendered.some((result) => result.source === "message" || result.source === "compartment")) {
        parts.push(MESSAGE_EXPAND_HINT);
    }
    if (
        rendered.some(
            (result) =>
                result.source === "note" &&
                result.anchorOrdinal !== null &&
                result.sourceSessionId === currentSessionId,
        )
    ) {
        parts.push(NOTE_EXPAND_HINT);
    }
    return parts;
}

function assemble(header: string, parts: readonly string[]): string {
    return `${header}\n\n${parts.join("\n\n")}`;
}

/**
 * Render a full search response within the token budget. Under-budget output
 * is byte-identical to the historical per-harness formatting; over-budget
 * output keeps a ranked prefix of complete blocks and appends an omission
 * notice — no block is partially emitted.
 */
export function formatSearchResults(
    query: string,
    results: UnifiedSearchResult[],
    currentSessionId: string,
): string {
    const boundedQuery = boundDynamicField(query);
    if (results.length === 0) {
        return `No results found for "${boundedQuery}" across notes, memories, primers, git commits, or message history.`;
    }

    const header = `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${boundedQuery}":`;
    const blocks = results.map((result, index) =>
        formatResult(result, index + 1, currentSessionId),
    );

    const full = assemble(header, bodyPartsFor(blocks, results, currentSessionId));
    if (estimateTokens(full) <= MAX_RENDERED_RESULT_TOKENS) {
        return full;
    }

    for (let kept = results.length - 1; kept >= 0; kept -= 1) {
        const omitted = results.length - kept;
        const notice = `(${omitted} result${omitted === 1 ? "" : "s"} omitted to fit the output budget — refine the query or lower the limit)`;
        const parts =
            kept === 0
                ? [notice]
                : [
                      ...bodyPartsFor(
                          blocks.slice(0, kept),
                          results.slice(0, kept),
                          currentSessionId,
                      ),
                      notice,
                  ];
        const candidate = assemble(header, parts);
        if (estimateTokens(candidate) <= MAX_RENDERED_RESULT_TOKENS) {
            return candidate;
        }
    }

    return assemble(header, [
        `(${results.length} result${results.length === 1 ? "" : "s"} omitted to fit the output budget — refine the query or lower the limit)`,
    ]);
}
