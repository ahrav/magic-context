import type { Database } from "../../shared/sqlite";
export declare const STALE_CHILD_SPAWN_FAILURE = "stale_schema_fence";
export declare const STALE_CHILD_SPAWN_LATCH_THRESHOLD = 2;
export interface ChildSpawnFenceFailure {
    failureClass: typeof STALE_CHILD_SPAWN_FAILURE;
    reason: "newer_schema" | "read_error";
    persistedVersion: number;
    supportedVersion: number;
    consecutiveFailures: number;
    totalFailures: number;
    latched: boolean;
}
export type ChildSpawnFenceProbeResult = {
    allowSpawn: true;
} | {
    allowSpawn: false;
    failure: ChildSpawnFenceFailure;
    shouldSurface: boolean;
};
/**
 * Probe the schema fence immediately before a child is created. The hot path uses
 * the process's existing SQLite handle; an already fail-closed main handle has no
 * handle to query, so its recorded rejection is the authoritative verdict.
 */
export declare function probeChildSpawnFence(db: Database | null): ChildSpawnFenceProbeResult;
export declare function getChildSpawnFenceFailure(): ChildSpawnFenceFailure | null;
/** Test seam: child-spawn fence state is process-local by design. */
export declare function __resetChildSpawnFenceProbeForTests(): void;
//# sourceMappingURL=schema-fence-probe.d.ts.map