/**
 *
 * The hint must nudge the agent to run ctx_search rather than provide an answer.
 *
 * The renderer uses only the subject line because commit bodies do not change the recall trigger.
 *
 * Guardrails:
 * The renderer bounds every dynamic source field to MAX_RENDER_FIELD_BYTES of valid UTF-8 before compression or tokenization, keeping budget checks bounded.
 * Anti-memory warnings use bounded fields so their complete warning contract remains visible.
 * The caller excludes sources already present in visible session history.
 * The packer omits an over-budget fragment whole while retaining the wrapper and footer cue.
 */

import type { UnifiedSearchResult } from "../../features/magic-context/search";
import {
    boundDynamicField,
    MAX_AUTO_HINT_TOKENS,
    renderAntiMemoryWarningLine,
} from "../../features/magic-context/search-bounds";
import { formatAge } from "../../shared/format-age";
import { estimateTokens } from "../../shared/token-estimator";
import { cavemanCompress } from "./caveman";

const MAX_FRAGMENTS = 3;
const FRAGMENT_CHAR_CAP = 80; // ~20 tokens at 3.5 chars/token
const WARNING_FIELD_CHAR_CAP = 72;

export interface AutoSearchHintOptions {
    maxFragments?: number;
    fragmentCharCap?: number;
    /**
     * The injectable reference clock makes rendering deterministic across wall-clock days. */
    nowMs?: number;
    /** warningScoreThreshold sets the minimum score required to claim the reserved first slot.
     * warningScoreThreshold defaults to 0, reserving the slot for any warning present. */
    warningScoreThreshold?: number;
}

function truncate(text: string, limit: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function warningField(text: string): string {
    return truncate(boundDynamicField(text), WARNING_FIELD_CHAR_CAP);
}

function renderCompactAntiMemoryWarning(
    result: Extract<UnifiedSearchResult, { source: "anti_memory" }>,
): string {
    // The renderer caps each warning field at 72 characters and omits locator citations to fit the hint budget.
    // The renderer omits locator citations to direct the agent to ctx_search for the full record.
    return renderAntiMemoryWarningLine({
        trigger: result.trigger,
        rejectedStrategy: result.rejectedStrategy,
        rejectionReason: result.rejectionReason,
        saferAlternative: result.saferAlternative,
        boundField: warningField,
    });
}

function renderFragment(result: UnifiedSearchResult, charCap: number, nowMs: number): string {
    switch (result.source) {
        case "anti_memory":
            return renderCompactAntiMemoryWarning(result);
        case "memory": {
            const compressed = cavemanCompress(boundDynamicField(result.content), "ultra");
            return truncate(compressed, charCap);
        }
        case "git_commit": {
            // The renderer preserves the short SHA and relative age so the agent can decide whether the age is relevant.
            const bounded = boundDynamicField(result.content);
            const subject = bounded.split(/\r?\n/)[0] ?? bounded;
            const body = truncate(subject, Math.max(10, charCap - 20));
            return `commit ${boundDynamicField(result.shortSha)} ${formatAge(result.committedAtMs, nowMs)}: ${body}`;
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

/** `delivered` contains exactly the results whose fragments appear in `text`, in fragment order.
 * `text` is null when no fragment packs. */
export interface PackedAutoSearchHint {
    text: string | null;
    delivered: UnifiedSearchResult[];
    tokenCount: number;
    omittedCount: number;
}

/**
 * The packer drops over-budget fragments whole from the tail.
 * When no fragment fits the budget, return null text and an empty delivered list.
 *
 * Only `anti_memory` results are filtered by `warningScoreThreshold`.
 * `packAutoSearchHint` applies `warningScoreThreshold` because it reserves the first fragment slot for an `anti_memory` result.
 */
export function packAutoSearchHint(
    results: UnifiedSearchResult[],
    options: AutoSearchHintOptions = {},
): PackedAutoSearchHint {
    const maxFragments = Math.max(1, options.maxFragments ?? MAX_FRAGMENTS);
    const fragmentCharCap = Math.max(20, options.fragmentCharCap ?? FRAGMENT_CHAR_CAP);
    const nowMs = options.nowMs ?? Date.now();
    const warningScoreThreshold = options.warningScoreThreshold ?? 0;

    // An eligible `anti_memory` result occupies the first fragment slot.
    const eligible = results.filter(
        (result) => result.source !== "anti_memory" || result.score >= warningScoreThreshold,
    );
    const warning = eligible.find((result) => result.source === "anti_memory");
    const picks = warning
        ? [warning, ...eligible.filter((result) => result.source !== "anti_memory")].slice(
              0,
              maxFragments,
          )
        : eligible.slice(0, maxFragments);
    const kept: Array<{ result: UnifiedSearchResult; line: string }> = [];

    for (const result of picks) {
        const fragment = renderFragment(result, fragmentCharCap, nowMs);
        if (fragment.length === 0) continue;
        kept.push({ result, line: `- ${fragment}` });
    }

    // The token budget includes the assembled wrapper and footer.
    while (kept.length > 0) {
        const wrapped = assembleHint(kept.map((entry) => entry.line));
        const tokenCount = estimateTokens(wrapped);
        if (tokenCount <= MAX_AUTO_HINT_TOKENS) {
            return {
                text: wrapped,
                delivered: kept.map((entry) => entry.result),
                tokenCount,
                omittedCount: results.length - kept.length,
            };
        }
        kept.pop();
    }
    return { text: null, delivered: [], tokenCount: 0, omittedCount: results.length };
}

/**
 * packAutoSearchHint returns `null` when no assembled fragment set fits MAX_AUTO_HINT_TOKENS.
 */
export function buildAutoSearchHint(
    results: UnifiedSearchResult[],
    options: AutoSearchHintOptions = {},
): string | null {
    return packAutoSearchHint(results, options).text;
}

export interface AntiMemoryWarningDelivery {
    /** `warningResults` preserves delivery order. */
    warningResults: Extract<UnifiedSearchResult, { source: "anti_memory" }>[];
    /**
     * */
    memoryFragments: Array<{ id: number; hash: string }>;
}

/**
 * */
export function collectAntiMemoryWarningFragments(
    delivered: readonly UnifiedSearchResult[],
): AntiMemoryWarningDelivery {
    const warningResults = delivered.filter(
        (result): result is Extract<UnifiedSearchResult, { source: "anti_memory" }> =>
            result.source === "anti_memory",
    );
    return {
        warningResults,
        memoryFragments: warningResults.map((result) => ({
            id: result.claimId,
            hash: result.normalizedHash,
        })),
    };
}
