import {
    antiMemoryExpired,
    parseAntiMemoryContent,
} from "../../features/magic-context/memory/anti-memory-content";
import { ANTI_MEMORY_CATEGORY } from "../../features/magic-context/memory/constants";
import { guidanceFor, type MemoryState } from "./state";
import { isMemoryDecisionRow, type ReadRow } from "./wire";

/** The rows list, search, and status counters serve: memory-domain decisions minus anti-memories past their rendered expiry. An unparseable summary never counts as expired. commentlint: allow(JUDGE) */
export function isServedMemoryDecisionRow(row: ReadRow, nowMs: number): boolean {
    if (!isMemoryDecisionRow(row)) return false;
    if (row.decision?.decision_kind !== ANTI_MEMORY_CATEGORY) return true;
    try {
        return !antiMemoryExpired(parseAntiMemoryContent(row.decision.payload.summary), nowMs);
    } catch {
        return true;
    }
}

/** An `available` read with no rows for the project. */
export const EMPTY_PROJECT_MARKER = "memory: no memories recorded for this project yet";

/** An `available` read whose rows all fell to the injection budget. */
export const BUDGET_OMITTED_MARKER =
    "memory: memories exist for this project but were omitted to fit the injection budget";

/** An `available` read truncated before any memory row survived; absence is not evidence of an empty project. commentlint: allow(JUDGE) */
export const READ_TRUNCATED_MARKER =
    "memory: the memory read was truncated; recorded memories may be missing from this block";

/** An `available` read whose only rows are withheld from automatic rendering by policy (anti-memories, sensitive rows); the project is not empty, and search still serves them. commentlint: allow(JUDGE) */
export const POLICY_WITHHELD_MARKER =
    "memory: this project's recorded memories are withheld from this block by policy; explicit search still serves them";

/**
 * One line for an injected block. An `available` state with rows renders the
 * empty string: the rows are the marker, and a header line would spend budget
 * on every turn. Row rendering and budget trimming belong to the injector.
 * A trim that empties a non-empty snapshot renders `BUDGET_OMITTED_MARKER`
 * so the model does not treat a trimmed block as an empty project; the
 * incomplete-read markers keep a capped snapshot from reading as
 * authoritative emptiness. commentlint: allow(JUDGE)
 */
export function renderMemoryStateMarker(
    state: MemoryState,
    rowCount: number,
    totalRowCount: number = rowCount,
    truncated = false,
    withheldRowCount = 0,
): string {
    if (state.kind === "available") {
        if (rowCount > 0) return "";
        if (totalRowCount > 0) return BUDGET_OMITTED_MARKER;
        if (truncated) return READ_TRUNCATED_MARKER;
        return withheldRowCount > 0 ? POLICY_WITHHELD_MARKER : EMPTY_PROJECT_MARKER;
    }
    if (state.kind === "stale" || state.kind === "abstained") {
        return `${guidanceFor(state).marker} (${state.lag_positions} behind, oldest ${state.oldest_unconsumed_age_ms} ms)`;
    }
    return guidanceFor(state).marker;
}

/** One sentence for a tool result. */
export function renderToolStateText(state: MemoryState): string {
    return guidanceFor(state).tool;
}
