import { escalationBands } from "../../shared/escalation-bands";

export interface DeferredConsumptionArgs {
    schedulerDecision: "execute" | "defer";
    contextPercentage: number;
    /** True when this pass awaited a run that actually published new compartment state. */
    justAwaitedPublication: boolean;
    /** True when an active run blocks materialization unless `justAwaitedPublication` is true. */
    activeRunBlocksMaterialization: boolean;
    forceMaterializationPercentage?: number;
}

export function canConsumeDeferredOnThisPass(args: DeferredConsumptionArgs): boolean {
    if (args.justAwaitedPublication) return true;
    if (args.activeRunBlocksMaterialization) return false;

    return (
        args.schedulerDecision === "execute" ||
        args.contextPercentage >=
            (args.forceMaterializationPercentage ??
                escalationBands(65).forceMaterializationPercentage)
    );
}

export interface MaterializationPassSignals {
    /** True when this transform pass successfully wrote fresh cached m[0] bytes. */
    m0RematerializedThisPass: boolean;
    /** True when retry exhaustion forced fallback to a previous cached m[0]. */
    materializationContentionRetryExhausted: boolean;
    /** True when postprocess observed newer m0_mutation_log ids than cached m[0]. */
    m0MutationDriftDetected: boolean;
}
