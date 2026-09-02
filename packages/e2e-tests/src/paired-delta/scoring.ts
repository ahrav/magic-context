import type { RolloutRecord } from "./runner";

/**
 * Score one cell on the preregistered `paired-valid-success-delta` endpoint.
 *
 * A valid success is every applicable critical check passing, which is a binary outcome. Averaging
 * the whole check vector estimates a different quantity: in every authored scenario `check-file` is
 * noncritical, so an arm that wrote the answer file with the wrong contents would score 0.5 with
 * zero valid successes.
 *
 * Shared by the live delta path and the calibration collector, which have to agree: a change to the
 * rule applied to one of them would make the floor describe a different quantity than the deltas it
 * gates, and nothing in the types would catch it.
 */
export function validSuccess(record: RolloutRecord): number {
    if (record.cell.criticalTotal === 0) {
        throw new Error(`paired-delta: empty-critical-vector-${record.scenarioId}`);
    }
    return record.cell.criticalPassed === record.cell.criticalTotal ? 1 : 0;
}
