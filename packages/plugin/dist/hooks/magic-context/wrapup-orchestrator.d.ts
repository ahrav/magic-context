import { runCompartmentAgent } from "./compartment-runner-incremental";
import type { ManagedRecompContext } from "./recomp-orchestrator";
export interface ManagedWrapupContext extends ManagedRecompContext {
    contextLimit: number;
    executeThresholdPercentage: number;
    hasPendingNaturalBust?: (sessionId: string) => boolean;
    runCompartmentAgentForWrapup?: typeof runCompartmentAgent;
    wrapupLeaseWaitTimeoutMs?: number;
}
export interface WrapupOptions {
    messagesToKeep: number;
}
export declare function runManagedWrapup(ctx: ManagedWrapupContext, sessionId: string, options: WrapupOptions): Promise<string>;
//# sourceMappingURL=wrapup-orchestrator.d.ts.map