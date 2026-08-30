// The consumed lifecycle surface. Leaf modules stay directly importable;
// this barrel re-exports only the symbols production importers actually take
// from it, so unused surface shows up as a compile error instead of hiding
// behind a re-export line.
export { type DaemonReason, type DaemonResultV1 } from "./contract";
export { releaseContract } from "./generated-contract";
export { createManagedLifecyclePolicy } from "./managed-policy";
export type { NativeStartupEnvelope } from "./native-launcher";
export { type ConnectionOrigin, resolveConnectionOrigin } from "./ownership";
export {
    connectionFilePath,
    defaultConnectionFilePath,
    resolveLifecycleDataRoot,
    sensitiveRootsFor,
} from "./paths";
export {
    type LifecycleCommand,
    McHostLifecyclePolicy,
    OUTER_AGGREGATE_MS,
    STORAGE_HARD_BUDGET_MS,
    type StorageReadiness,
    WaiterDetachedError,
} from "./policy";
