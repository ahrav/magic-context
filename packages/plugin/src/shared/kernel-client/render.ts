import { guidanceFor, type MemoryState } from "./state";

/** An `available` read with no rows for the project. */
export const EMPTY_PROJECT_MARKER = "memory: no memories recorded for this project yet";

/**
 * One line for an injected block. An `available` state with rows renders the
 * empty string: the rows are the marker, and a header line would spend budget
 * on every turn. Row rendering and budget trimming belong to the injector.
 */
export function renderMemoryStateMarker(state: MemoryState, rowCount: number): string {
    if (state.kind === "available") return rowCount === 0 ? EMPTY_PROJECT_MARKER : "";
    if (state.kind === "stale" || state.kind === "abstained") {
        return `${guidanceFor(state).marker} (${state.lag_positions} behind, oldest ${state.oldest_unconsumed_age_ms} ms)`;
    }
    return guidanceFor(state).marker;
}

/** One sentence for a tool result. */
export function renderToolStateText(state: MemoryState): string {
    return guidanceFor(state).tool;
}
