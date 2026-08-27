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
    binarySearchLargestFit,
    boundDynamicField,
    MAX_RENDERED_RESULT_TOKENS,
} from "../../features/magic-context/search-bounds";
import { formatAge } from "../../shared/format-age";
import { estimateTokens } from "../../shared/token-estimator";

const NOTE_EXPAND_HINT =
    "Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.";
const MESSAGE_EXPAND_HINT =
    "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.";

function formatResult(
    result: UnifiedSearchResult,
    index: number,
    currentSessionId: string,
    nowMs: number,
): string {
    if (result.source === "memory") {
        const source = result.sourceName ? ` source=${boundDynamicField(result.sourceName)}` : "";
        const policy = result.policyLabel
            ? ` trust=[${boundDynamicField(result.policyLabel)}]`
            : "";
        return [
            `[${index}] [memory] score=${result.score.toFixed(2)} id=${result.publicClaimId} category=${boundDynamicField(result.category)}${source} match=${result.matchType}${policy}`,
            boundDynamicField(result.content),
        ].join("\n");
    }

    if (result.source === "git_commit") {
        return [
            `[${index}] [git_commit] score=${result.score.toFixed(2)} sha=${boundDynamicField(result.shortSha)} ${formatAge(result.committedAtMs, nowMs)} match=${result.matchType}`,
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
            `[${index}] [note] score=${result.score.toFixed(2)} id=#${result.noteId} status=${result.status} ${formatAge(result.createdAt, nowMs)}${anchor}`,
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

export type ExplicitDeliveryReason = "delivered" | "empty-results" | "packer-empty";

/** `delivered` contains exactly the results whose complete blocks appear in
 *  `text`, in rendered order. */
export interface PackedSearchResults {
    text: string;
    delivered: UnifiedSearchResult[];
    tokenCount: number;
    omittedCount: number;
    reason: ExplicitDeliveryReason;
}

/**
 * Packs the response under MAX_RENDERED_RESULT_TOKENS. Over-budget output
 * keeps a prefix of complete blocks and appends an omission notice — no
 * block is partially emitted. Empty results and a packer that cannot fit
 * even one block are completed empty-delivery outcomes, not failures.
 */
export function packSearchResults(
    query: string,
    results: UnifiedSearchResult[],
    currentSessionId: string,
    /** Reference clock for age wording; injectable so a fingerprinted
     *  benchmark scenario renders identical bytes on any day. */
    nowMs: number = Date.now(),
): PackedSearchResults {
    const boundedQuery = boundDynamicField(query);
    if (results.length === 0) {
        const text = `No results found for "${boundedQuery}" across notes, memories, primers, git commits, or message history.`;
        return {
            text,
            delivered: [],
            tokenCount: estimateTokens(text),
            omittedCount: 0,
            reason: "empty-results",
        };
    }

    const header = `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${boundedQuery}":`;
    const blocks = results.map((result, index) =>
        formatResult(result, index + 1, currentSessionId, nowMs),
    );

    const full = assemble(header, bodyPartsFor(blocks, results, currentSessionId));
    const fullTokens = estimateTokens(full);
    if (fullTokens <= MAX_RENDERED_RESULT_TOKENS) {
        return {
            text: full,
            delivered: [...results],
            tokenCount: fullTokens,
            omittedCount: 0,
            reason: "delivered",
        };
    }

    const noticeFor = (omitted: number) =>
        `(${omitted} result${omitted === 1 ? "" : "s"} omitted to fit the output budget — refine the query or lower the limit)`;
    const candidateFor = (kept: number) =>
        assemble(header, [
            ...bodyPartsFor(blocks.slice(0, kept), results.slice(0, kept), currentSessionId),
            noticeFor(results.length - kept),
        ]);

    // Token count grows monotonically with the kept prefix, so the largest
    // fitting prefix is found by binary search instead of re-tokenizing the
    // whole candidate once per dropped block.
    const bestIndex = binarySearchLargestFit(
        results.length - 2,
        (index) => estimateTokens(candidateFor(index + 1)) <= MAX_RENDERED_RESULT_TOKENS,
    );
    if (bestIndex >= 0) {
        const kept = bestIndex + 1;
        const text = candidateFor(kept);
        return {
            text,
            delivered: results.slice(0, kept),
            tokenCount: estimateTokens(text),
            omittedCount: results.length - kept,
            reason: "delivered",
        };
    }

    const text = assemble(header, [noticeFor(results.length)]);
    return {
        text,
        delivered: [],
        tokenCount: estimateTokens(text),
        omittedCount: results.length,
        reason: "packer-empty",
    };
}

export function formatSearchResults(
    query: string,
    results: UnifiedSearchResult[],
    currentSessionId: string,
    nowMs: number = Date.now(),
): string {
    return packSearchResults(query, results, currentSessionId, nowMs).text;
}
