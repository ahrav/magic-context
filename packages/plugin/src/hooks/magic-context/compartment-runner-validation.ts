import { withContentLanguageDirective } from "../../agents/language-directive";
import { parseCompartmentOutput } from "./compartment-parser";
import { mapParsedCompartmentsToChunk } from "./compartment-runner-mapping";
import type {
    StoredCompartmentRange,
    ValidatedHistorianPassResult,
} from "./compartment-runner-types";
import { completedToolArcCrossesBoundary } from "./read-session-true-raw-tokens";

const MIN_RECOMP_CHUNK_TOKEN_BUDGET = 20;
export const HISTORIAN_BOUNDARY_HEALING_SLACK = 2;

export interface HistorianValidationChunk {
    startIndex: number;
    endIndex: number;
    lines: Array<{ ordinal: number; messageId: string }>;
    /** Optional — when provided, gaps inside these ranges heal at any size. */
    toolOnlyRanges?: ReadonlyArray<{ start: number; end: number }>;
    /** These arcs represent completed invocation/result pairs visible in the raw snapshot. */
    completedToolArcs?: ReadonlyArray<{ start: number; end: number }>;
}

/**
 *
 *
 * The healer absorbs only gaps fully contained in `toolOnlyRanges`.
 *
 */
function healCompartmentGaps(
    compartments: Array<{ startMessage: number; endMessage: number }>,
    toolOnlyRanges: ReadonlyArray<{ start: number; end: number }> = [],
): void {
    for (let i = 1; i < compartments.length; i++) {
        const prev = compartments[i - 1];
        const curr = compartments[i];
        const gapStart = prev.endMessage + 1;
        const gapEnd = curr.startMessage - 1;
        const gapSize = gapEnd - gapStart + 1;

        if (gapSize <= 0) continue;

        const fullyInsideToolOnly = toolOnlyRanges.some(
            (range) => range.start <= gapStart && range.end >= gapEnd,
        );

        if (fullyInsideToolOnly) {
            prev.endMessage = gapEnd;
        }
    }
}

function boundarySplitsCompletedToolArc(
    boundary: number,
    arcs: ReadonlyArray<{ start: number; end: number }> = [],
): boolean {
    return arcs.some((arc) => completedToolArcCrossesBoundary(arc.start, arc.end, boundary));
}

function healTerminalCompletedToolArc(
    compartments: Array<{ endMessage: number }>,
    unprocessedFrom: number | null,
    arcs: ReadonlyArray<{ start: number; end: number }> = [],
    chunkEnd: number,
): number | null {
    const last = compartments[compartments.length - 1];
    if (!last) return unprocessedFrom;

    const originalEnd = last.endMessage;
    for (let pass = 0; pass <= arcs.length; pass += 1) {
        const boundary = last.endMessage + 1;
        let nextEnd = last.endMessage;
        for (const arc of arcs) {
            if (
                arc.end <= chunkEnd &&
                completedToolArcCrossesBoundary(arc.start, arc.end, boundary)
            ) {
                nextEnd = Math.max(nextEnd, arc.end);
            }
        }
        if (nextEnd === last.endMessage) break;
        last.endMessage = nextEnd;
    }

    return last.endMessage !== originalEnd && unprocessedFrom !== null
        ? last.endMessage + 1
        : unprocessedFrom;
}

/**
 * The function retains the last compartment within `HISTORIAN_BOUNDARY_HEALING_SLACK` of `chunk.endIndex` when discarding it would split a completed tool arc.
 */
export function shouldDiscardLastHistorianCompartment(
    compartments: ReadonlyArray<{ endMessage: number }>,
    chunk: Pick<HistorianValidationChunk, "endIndex" | "completedToolArcs">,
): boolean {
    if (compartments.length < 2) return false;

    const last = compartments[compartments.length - 1];
    const previous = compartments[compartments.length - 2];
    const lookaheadMargin = chunk.endIndex - last.endMessage;
    return (
        lookaheadMargin <= HISTORIAN_BOUNDARY_HEALING_SLACK &&
        !boundarySplitsCompletedToolArc(previous.endMessage + 1, chunk.completedToolArcs)
    );
}

export function validateHistorianOutput(
    text: string,
    _sessionId: string,
    chunk: HistorianValidationChunk,
    _priorCompartments: StoredCompartmentRange[],
    sequenceOffset: number,
): ValidatedHistorianPassResult {
    const parsed = parseCompartmentOutput(text);
    if (parsed.compartments.length === 0) {
        return {
            ok: false,
            error: "Historian returned no usable compartments.",
        };
    }

    healCompartmentGaps(parsed.compartments, chunk.toolOnlyRanges);
    parsed.unprocessedFrom = healTerminalCompletedToolArc(
        parsed.compartments,
        parsed.unprocessedFrom,
        chunk.completedToolArcs,
        chunk.endIndex,
    );

    const mapped = mapParsedCompartmentsToChunk(parsed.compartments, chunk, sequenceOffset);
    if (!mapped.ok) {
        return {
            ok: false,
            error: `Historian returned invalid compartment output: ${mapped.error}`,
        };
    }

    const parsedValidationError = validateParsedCompartments(
        parsed.compartments,
        chunk.startIndex,
        chunk.endIndex,
        parsed.unprocessedFrom,
    );
    if (parsedValidationError) {
        return {
            ok: false,
            error: `Historian returned invalid compartment output: ${parsedValidationError}`,
        };
    }

    const last = parsed.compartments[parsed.compartments.length - 1];
    if (last && boundarySplitsCompletedToolArc(last.endMessage + 1, chunk.completedToolArcs)) {
        return {
            ok: false,
            error: "Historian terminal boundary splits a completed tool invocation/result arc",
        };
    }

    return {
        ok: true,
        compartments: mapped.compartments,
        facts: parsed.facts,
        userObservations: parsed.userObservations.length > 0 ? parsed.userObservations : undefined,
        primerCandidates:
            parsed.primerCandidates.length > 0 ? parsed.primerCandidates.slice(0, 1) : undefined,
        events: parsed.events.length > 0 ? parsed.events : undefined,
    };
}

/**
 */
export const HISTORIAN_PERSISTENT_FAILURE_THRESHOLD = 3;

/**
 *
 *
 */
export function buildHistorianFailureNotice(failureCount: number, lastError: string): string {
    if (failureCount >= HISTORIAN_PERSISTENT_FAILURE_THRESHOLD) {
        return [
            "## Magic Context — history comparting needs attention",
            "",
            `Magic Context has been unable to compart this session's history ${failureCount} times in a row. This usually means the configured historian model is misconfigured or unreachable (Magic Context already retried every fallback model automatically).`,
            "",
            `Last error: ${lastError}`,
            "",
            "Check your historian model in magic-context.jsonc, then restart. Your conversation keeps working normally in the meantime — this only affects how older history is summarized.",
        ].join("\n");
    }
    return [
        "## Magic Context",
        "",
        "Hit a transient issue comparting history this turn — Magic Context will retry automatically on the next turn. Nothing is lost and your conversation continues normally. You'll only be alerted again if this keeps happening.",
    ].join("\n");
}

export function buildHistorianRepairPrompt(
    originalPrompt: string,
    previousOutput: string,
    validationError: string,
    language?: string,
): string {
    const prompt = [
        originalPrompt,
        "",
        "Your previous XML response was invalid and cannot be persisted.",
        `Validation error: ${validationError}`,
        "Return a corrected full XML response for the same existing state and new messages.",
        "Do not skip any displayed raw ordinal or displayed raw range, even if the message looks trivial.",
        "Every displayed message range must belong to exactly one compartment unless it is intentionally left in one trailing suffix marked by <unprocessed_from>.",
        "",
        "Previous invalid XML:",
        previousOutput,
    ].join("\n");
    return withContentLanguageDirective(prompt, language, { preserveUserQuotes: true });
}

export function validateStoredCompartments(
    compartments: Array<{ startMessage: number; endMessage: number }>,
): string | null {
    if (compartments.length === 0) {
        return null;
    }

    let expectedStart = 1;
    for (const compartment of compartments) {
        if (compartment.startMessage !== expectedStart) {
            if (compartment.startMessage < expectedStart) {
                return `overlap before message ${expectedStart} (saw ${compartment.startMessage}-${compartment.endMessage})`;
            }
            return `gap before message ${compartment.startMessage} (expected ${expectedStart})`;
        }
        if (compartment.endMessage < compartment.startMessage) {
            return `invalid range ${compartment.startMessage}-${compartment.endMessage}`;
        }
        expectedStart = compartment.endMessage + 1;
    }

    return null;
}

function validateParsedCompartments(
    compartments: Array<{ startMessage: number; endMessage: number; p1?: string }>,
    chunkStart: number,
    chunkEnd: number,
    unprocessedFrom: number | null,
): string | null {
    let expectedStart = chunkStart;

    for (const [index, compartment] of compartments.entries()) {
        if (!compartment.p1?.trim()) {
            return `compartment ${index + 1} is missing the tiered paraphrase structure (p1..p4); re-emit with all four tiers`;
        }
        if (compartment.endMessage < compartment.startMessage) {
            return `invalid range ${compartment.startMessage}-${compartment.endMessage}`;
        }
        if (compartment.startMessage < chunkStart || compartment.endMessage > chunkEnd) {
            return `range ${compartment.startMessage}-${compartment.endMessage} is outside chunk ${chunkStart}-${chunkEnd}`;
        }
        if (compartment.startMessage !== expectedStart) {
            if (compartment.startMessage < expectedStart) {
                return `overlap before message ${expectedStart} (saw ${compartment.startMessage}-${compartment.endMessage})`;
            }
            return `gap before message ${compartment.startMessage} (expected ${expectedStart})`;
        }
        expectedStart = compartment.endMessage + 1;
    }

    if (unprocessedFrom !== null) {
        if (unprocessedFrom === chunkEnd + 1) {
            return null;
        }
        if (unprocessedFrom < chunkStart || unprocessedFrom > chunkEnd) {
            return `<unprocessed_from> ${unprocessedFrom} is outside chunk ${chunkStart}-${chunkEnd}`;
        }
        if (unprocessedFrom !== expectedStart) {
            return `<unprocessed_from> ${unprocessedFrom} does not match next uncovered message ${expectedStart}`;
        }
        return null;
    }

    if (expectedStart <= chunkEnd) {
        return `output left uncovered messages ${expectedStart}-${chunkEnd} without <unprocessed_from>`;
    }

    return null;
}

export function validateChunkCoverage(chunk: {
    startIndex: number;
    endIndex: number;
    lines: Array<{ ordinal: number }>;
}): string | null {
    if (chunk.lines.length === 0) {
        return null;
    }

    let expectedOrdinal = chunk.startIndex;
    for (const line of chunk.lines) {
        if (line.ordinal !== expectedOrdinal) {
            return `chunk omits raw message ${expectedOrdinal} while still claiming coverage through ${chunk.endIndex}`;
        }
        expectedOrdinal += 1;
    }

    if (expectedOrdinal - 1 !== chunk.endIndex) {
        return `chunk coverage ends at ${expectedOrdinal - 1} but chunk end is ${chunk.endIndex}`;
    }

    return null;
}

export function getReducedRecompTokenBudget(currentBudget: number): number | null {
    const reducedBudget = Math.max(MIN_RECOMP_CHUNK_TOKEN_BUDGET, Math.floor(currentBudget / 2));
    return reducedBudget < currentBudget ? reducedBudget : null;
}
