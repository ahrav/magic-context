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
 *   - Ordinary fragments use a small character cap. Anti-memory warnings use
 *     bounded fields so their complete warning contract remains visible.
 *   - Skip fragments whose source is already present in visible session-history
 *     (caller handles) — this module only knows about search results
 *   - Total output is token-packed under MAX_AUTO_HINT_TOKENS: an over-budget
 *     fragment is omitted whole while the wrapper and footer cue stay intact
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
    /** Reference clock for age wording; injectable so a fingerprinted
     *  benchmark scenario renders identical bytes on any day. */
    nowMs?: number;
    /** Minimum score a warning must reach to claim the reserved first slot.
     *  Defaults to 0, which reserves the slot for any warning present. */
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
    // Same contract sentence as explicit search (`renderAntiMemoryWarning`),
    // with tighter per-field caps and no locator citation: the hint budget is
    // ~200 tokens and the agent is nudged toward ctx_search for the full record.
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
            // Use only the subject line (first line) — bodies add noise without
            // changing the recall trigger. Preserve the short SHA + relative age
            // so the agent can decide if the age is even relevant.
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

/** `delivered` contains exactly the results whose fragments appear in
 *  `text`, in fragment order. `text` is null when nothing packs. */
export interface PackedAutoSearchHint {
    text: string | null;
    delivered: UnifiedSearchResult[];
    tokenCount: number;
    omittedCount: number;
}

/**
 * Packs the hint under MAX_AUTO_HINT_TOKENS and reports which results
 * survived. An over-budget fragment is dropped whole from the tail; a lone
 * over-budget fragment yields a null text with an empty delivered list
 * rather than a partially emitted hint.
 *
 * This function does NOT enforce the caller's general score or message-length
 * gates — the transform-time auto-search wiring applies those first. The one
 * exception is `warningScoreThreshold`, because the reserved warning slot is
 * this function's own decision: it promotes a warning past the caller's
 * ranking, so the bar that warning must clear has to be enforced where the
 * promotion happens or every caller has to remember to pre-filter.
 */
export function packAutoSearchHint(
    results: UnifiedSearchResult[],
    options: AutoSearchHintOptions = {},
): PackedAutoSearchHint {
    const maxFragments = Math.max(1, options.maxFragments ?? MAX_FRAGMENTS);
    const fragmentCharCap = Math.max(20, options.fragmentCharCap ?? FRAGMENT_CHAR_CAP);
    const nowMs = options.nowMs ?? Date.now();
    const warningScoreThreshold = options.warningScoreThreshold ?? 0;

    // A warning is a first-person claim about the reader's own prior decision,
    // so a weak match is worse than no match: a warning below the bar is
    // dropped outright rather than demoted into the tail, and the reserved slot
    // goes to one that earned it on its own score — never to one riding another
    // lane's strong hit past the caller's top-result gate.
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

    // Token-pack whole fragments: drop from the tail until the assembled hint
    // (wrapper and footer included) fits the budget. A lone over-budget
    // fragment yields no hint rather than a partially emitted one.
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
 * Build the hint text. Returns null when `results` is empty, when no fragment
 * has meaningful content after compression, or when limits zero out the budget.
 */
export function buildAutoSearchHint(
    results: UnifiedSearchResult[],
    options: AutoSearchHintOptions = {},
): string | null {
    return packAutoSearchHint(results, options).text;
}

export interface AntiMemoryWarningDelivery {
    /** Delivered warning results, in delivery order. */
    warningResults: Extract<UnifiedSearchResult, { source: "anti_memory" }>[];
    /** Claim identity + normalized hash bindings for the persisted hint
     *  decision. A non-empty list marks the decision non-replayable: warning
     *  delivery always requires a fresh search rather than stored text. */
    memoryFragments: Array<{ id: number; hash: string }>;
}

/** One definition of "which delivered fragments are anti-memory warnings and
 * what identity binds them", shared by the OpenCode and Pi auto-search
 * runners so the deliver-or-replay contract cannot drift between harnesses. */
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
