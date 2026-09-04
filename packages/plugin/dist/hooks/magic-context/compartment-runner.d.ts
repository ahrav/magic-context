import { type PartialRecompRange } from "./compartment-runner-partial-recomp";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";
export interface ActiveCompartmentRun {
    promise: Promise<void>;
    published: boolean;
    kind?: "incremental" | "recomp" | "wrapup" | "other";
    /**
     * Set to true once the 95%-emergency user-facing notification has been
     * dispatched for this run. Prevents the notification from re-firing on
     * every subsequent transform pass while the same compartment run is
     * still active — which would otherwise persist a fresh ignored user
     * message every pass and drive OpenCode's runLoop break condition false.
     */
    notificationSent?: boolean;
}
export declare function getActiveCompartmentRun(sessionId: string): ActiveCompartmentRun | undefined;
export declare function markActiveCompartmentRunPublished(sessionId: string): void;
/**
 * Register a compartment-state-mutating promise with the active-runs map.
 *
 * Use this to serialize background compressor runs against historian/recomp
 * runs: both read-modify-write compartment rows, and while SQLite serializes
 * individual statements it does NOT serialize multi-step update cycles. If a
 * historian starts while a background compressor is still running, either
 * side's final write can overwrite the other's work.
 *
 * The registered promise is cleared from activeRuns on settle so later passes
 * can start a new run. If a run is already registered for the session, the
 * caller is expected to have checked getActiveCompartmentRun() first and
 * bailed — this function will overwrite silently if called anyway, which is
 * the desired behavior for the retry path.
 */
export declare function registerActiveCompartmentRun(sessionId: string, promise: Promise<void>, kind?: ActiveCompartmentRun["kind"]): ActiveCompartmentRun;
export declare function startCompartmentAgent(deps: CompartmentRunnerDeps): void;
export interface ExecuteContextRecompOptions {
    /**
     * Optional partial range (inclusive raw message ordinals). When provided,
     * runs partial recomp — snaps to enclosing compartment boundaries and
     * rebuilds only the matching compartments, preserving prior/tail
     * compartments and all session facts.
     *
     * When omitted, runs full recomp from message 1 to the protected tail,
     * replacing all compartments and facts.
     */
    range?: PartialRecompRange;
    /** @internal Exercises the lease/marker race without delaying production callers. */
    onLeaseAcquired?: () => void;
}
export interface ExecuteContextRecompResult {
    message: string;
    published: boolean;
}
export declare function executeContextRecompWithResult(deps: CompartmentRunnerDeps, options?: ExecuteContextRecompOptions): Promise<ExecuteContextRecompResult>;
export declare function executeContextRecomp(deps: CompartmentRunnerDeps, options?: ExecuteContextRecompOptions): Promise<string>;
export { runCompartmentAgent } from "./compartment-runner-incremental";
export type { PartialRecompRange } from "./compartment-runner-partial-recomp";
//# sourceMappingURL=compartment-runner.d.ts.map