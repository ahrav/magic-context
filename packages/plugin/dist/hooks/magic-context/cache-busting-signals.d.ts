export interface DeferredConsumptionArgs {
    schedulerDecision: "execute" | "defer";
    contextPercentage: number;
    /** True when this pass awaited a run that actually published new compartment state. */
    justAwaitedPublication: boolean;
    /** True when an active run would block materialization below the emergency bypass. */
    activeRunBlocksMaterialization: boolean;
    forceMaterializationPercentage?: number;
}
export declare function canConsumeDeferredOnThisPass(args: DeferredConsumptionArgs): boolean;
export interface MaterializationPassSignals {
    /** True when this transform pass successfully wrote fresh cached m[0] bytes. */
    m0RematerializedThisPass: boolean;
    /** True when retry exhaustion forced fallback to a previous cached m[0]. */
    materializationContentionRetryExhausted: boolean;
    /** True when postprocess observed newer m0_mutation_log ids than cached m[0]. */
    m0MutationDriftDetected: boolean;
}
//# sourceMappingURL=cache-busting-signals.d.ts.map