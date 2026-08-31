import type { Database } from "../../shared/sqlite";
import {
    getPersistedSchemaVersion,
    getSchemaFenceRejection,
    LATEST_SUPPORTED_VERSION,
} from "./storage-db";

export const STALE_CHILD_SPAWN_FAILURE = "stale_schema_fence";
export const STALE_CHILD_SPAWN_LATCH_THRESHOLD = 2;

export interface ChildSpawnFenceFailure {
    failureClass: typeof STALE_CHILD_SPAWN_FAILURE;
    reason: "newer_schema" | "read_error";
    persistedVersion: number;
    supportedVersion: number;
    consecutiveFailures: number;
    totalFailures: number;
    latched: boolean;
}

interface ChildSpawnFenceState {
    consecutiveFailures: number;
    totalFailures: number;
    latched: boolean;
    noticeEmitted: boolean;
    failure: ChildSpawnFenceFailure | null;
}

const state: ChildSpawnFenceState = {
    consecutiveFailures: 0,
    totalFailures: 0,
    latched: false,
    noticeEmitted: false,
    failure: null,
};

export type ChildSpawnFenceProbeResult =
    | { allowSpawn: true }
    | { allowSpawn: false; failure: ChildSpawnFenceFailure; shouldSurface: boolean };

function recordStaleFence(
    persistedVersion: number,
    supportedVersion: number,
    reason: ChildSpawnFenceFailure["reason"] = "newer_schema",
): ChildSpawnFenceProbeResult {
    state.consecutiveFailures += 1;
    state.totalFailures += 1;
    const latched = state.consecutiveFailures >= STALE_CHILD_SPAWN_LATCH_THRESHOLD;
    state.latched ||= latched;
    const failure: ChildSpawnFenceFailure = {
        failureClass: STALE_CHILD_SPAWN_FAILURE,
        reason,
        persistedVersion,
        supportedVersion,
        consecutiveFailures: state.consecutiveFailures,
        totalFailures: state.totalFailures,
        latched: state.latched,
    };
    state.failure = failure;
    const shouldSurface = state.latched && !state.noticeEmitted;
    if (shouldSurface) state.noticeEmitted = true;
    return { allowSpawn: false, failure, shouldSurface };
}

/**
 * When no SQLite handle is available, a recorded rejection determines the verdict.
 */
export function probeChildSpawnFence(db: Database | null): ChildSpawnFenceProbeResult {
    if (!db) {
        const knownRejection = getSchemaFenceRejection();
        if (knownRejection) {
            return recordStaleFence(
                knownRejection.persistedVersion,
                knownRejection.supportedVersion,
            );
        }
        return { allowSpawn: true };
    }

    try {
        const persistedVersion = getPersistedSchemaVersion(db);
        if (persistedVersion > LATEST_SUPPORTED_VERSION) {
            return recordStaleFence(persistedVersion, LATEST_SUPPORTED_VERSION);
        }
    } catch {
        // A schema-version read failure prevents verifying compatibility, so reject the child.
        return recordStaleFence(LATEST_SUPPORTED_VERSION, LATEST_SUPPORTED_VERSION, "read_error");
    }

    // A successful live read re-arms the consecutive-failure latch so a later stale-schema rejection can surface.
    state.consecutiveFailures = 0;
    state.latched = false;
    state.noticeEmitted = false;
    return { allowSpawn: true };
}

export function getChildSpawnFenceFailure(): ChildSpawnFenceFailure | null {
    return state.failure;
}

/** Child-spawn fence state is process-local. */
export function __resetChildSpawnFenceProbeForTests(): void {
    state.consecutiveFailures = 0;
    state.totalFailures = 0;
    state.latched = false;
    state.noticeEmitted = false;
    state.failure = null;
}
