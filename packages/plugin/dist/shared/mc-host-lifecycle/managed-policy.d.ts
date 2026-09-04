import { type PayloadTrustIndex } from "./owner";
import { type LifecyclePolicyOptions, McHostLifecyclePolicy } from "./policy";
export interface ManagedLifecyclePolicyOptions extends Omit<LifecyclePolicyOptions, "launchTarget" | "payloadDir" | "bootstrapFailure"> {
    mode: "mutating" | "observational";
    declaringModuleUrl: string;
    parentPackageName: string;
    explicitExternalRoot?: string;
    trustIndex?: PayloadTrustIndex;
}
/**
 * Build the shared policy lazily at a real lifecycle demand site. Importing
 * this module performs no filesystem or package lookup.
 */
export declare function createManagedLifecyclePolicy(options: ManagedLifecyclePolicyOptions): McHostLifecyclePolicy;
//# sourceMappingURL=managed-policy.d.ts.map