import {
    acquireCompartmentLease,
    COMPARTMENT_LEASE_RENEWAL_MS,
    releaseCompartmentLease,
    renewCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import { isWrapupInProgress, updateSessionMeta } from "../../features/magic-context/storage-meta";
import { sessionLog } from "../../shared/logger";
import { runCompartmentAgent } from "./compartment-runner-incremental";
import {
    executePartialRecompInternal,
    type PartialRecompRange,
} from "./compartment-runner-partial-recomp";
import { executeContextRecompInternal } from "./compartment-runner-recomp";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";

export interface ActiveCompartmentRun {
    promise: Promise<void>;
    published: boolean;
    kind?: "incremental" | "recomp" | "wrapup" | "other";
    /**
     * notificationSent is true after the 95%-emergency user-facing notification is dispatched.
     * notificationSent prevents repeat notifications during later transform passes for the same active run.
     * Each repeat notification persists a fresh ignored user message.
     * Repeated ignored user messages keep OpenCode's runLoop break condition false.
     */
    notificationSent?: boolean;
}

const activeRuns = new Map<string, ActiveCompartmentRun>();

export function getActiveCompartmentRun(sessionId: string): ActiveCompartmentRun | undefined {
    return activeRuns.get(sessionId);
}

export function markActiveCompartmentRunPublished(sessionId: string): void {
    const activeRun = activeRuns.get(sessionId);
    if (activeRun) activeRun.published = true;
}

/**
 *
 * Background compressor and historian/recomp runs must not overlap.
 * SQLite serializes individual statements, not multi-step update cycles.
 * If historian and background compressor runs overlap, either final write can overwrite the other's work.
 *
 * The settled run must not delete a replacement registration.
 * Callers must check getActiveCompartmentRun() before registering to avoid replacing an active run.
 */
export function registerActiveCompartmentRun(
    sessionId: string,
    promise: Promise<void>,
    kind: ActiveCompartmentRun["kind"] = "other",
): ActiveCompartmentRun {
    const activeRun: ActiveCompartmentRun = {
        promise: Promise.resolve(),
        published: false,
        kind,
    };
    const wrapped = promise.finally(() => {
        // The settled run must not delete a replacement registration.
        if (activeRuns.get(sessionId)?.promise === wrapped) {
            activeRuns.delete(sessionId);
        }
    });
    activeRun.promise = wrapped;
    activeRuns.set(sessionId, activeRun);
    return activeRun;
}

function withPublishedCallback(deps: CompartmentRunnerDeps): CompartmentRunnerDeps {
    return {
        ...deps,
        onCompartmentStatePublished: (sid) => {
            markActiveCompartmentRunPublished(sid);
            deps.onCompartmentStatePublished?.(sid);
        },
    };
}

function startLeaseRenewal(
    deps: CompartmentRunnerDeps,
    holderId: string,
): ReturnType<typeof setInterval> {
    return setInterval(() => {
        try {
            if (!renewCompartmentLease(deps.db, deps.sessionId, holderId)) {
                sessionLog(
                    deps.sessionId,
                    "compartment lease renewal failed; publish will be skipped if holder is stale",
                );
            }
        } catch (err) {
            // A missed renewal leaves the lease valid until its five-minute TTL expires.
            sessionLog(
                deps.sessionId,
                `compartment lease renewal threw; publish will be skipped if holder is stale (${err instanceof Error ? err.message : String(err)})`,
            );
        }
    }, COMPARTMENT_LEASE_RENEWAL_MS);
}

export function startCompartmentAgent(deps: CompartmentRunnerDeps): void {
    // Bun's single-threaded event loop prevents this synchronous check-then-set sequence from interleaving.
    const existing = activeRuns.get(deps.sessionId);
    if (existing) {
        return;
    }

    if (isWrapupInProgress(deps.db, deps.sessionId)) {
        // /ctx-wrapup owns compartment-state publication while this marker is live.
        // Wrapup renews the marker's five-minute TTL, so a crashed wrapup expires without permanently suppressing trigger-fired historian runs.
        sessionLog(deps.sessionId, "compartment agent skipped: /ctx-wrapup is active");
        updateSessionMeta(deps.db, deps.sessionId, { compartmentInProgress: false });
        return;
    }

    const holderId = crypto.randomUUID();
    const lease = acquireCompartmentLease(deps.db, deps.sessionId, holderId);
    if (!lease) {
        sessionLog(
            deps.sessionId,
            "compartment agent skipped: compartment lease held by another process",
        );
        // The DB lease is the cross-process authority; a process that set the start-intent flag but did not acquire the lease must clear the flag so later passes can retry.
        updateSessionMeta(deps.db, deps.sessionId, { compartmentInProgress: false });
        return;
    }
    if (isWrapupInProgress(deps.db, deps.sessionId)) {
        // Acquiring the lease closes the race in which /ctx-wrapup publishes its marker after the first check but before this process acquires the lease.
        // Acquiring the lease closes the race in which /ctx-wrapup publishes its marker after the first check but before this process acquires the lease.
        sessionLog(deps.sessionId, "compartment agent skipped: /ctx-wrapup became active");
        releaseCompartmentLease(deps.db, deps.sessionId, holderId);
        updateSessionMeta(deps.db, deps.sessionId, { compartmentInProgress: false });
        return;
    }

    const renewal = startLeaseRenewal(deps, holderId);

    // activeRuns stores a promise that settles with the historian run, so the entry remains registered until the run settles.
    // The entry remains until the historian run completes, preventing duplicate runs when an external await times out.
    let realRunStarted = false;
    const runnerDeps = withPublishedCallback({
        ...deps,
        compartmentLeaseHolderId: holderId,
        onHistorianRunStarted: () => {
            realRunStarted = true;
        },
    });
    const promise = runCompartmentAgent(runnerDeps)
        .catch((err) => {
            sessionLog(deps.sessionId, "compartment agent: unhandled rejection:", err);
            try {
                updateSessionMeta(deps.db, deps.sessionId, { compartmentInProgress: false });
            } catch {
                // best effort
            }
        })
        .finally(() => {
            clearInterval(renewal);
            releaseCompartmentLease(deps.db, deps.sessionId, holderId);
            if (activeRuns.get(deps.sessionId)?.promise === promise) {
                activeRuns.delete(deps.sessionId);
            }
        });
    activeRuns.set(deps.sessionId, { promise, published: false, kind: "incremental" });
    // A synchronous no-op for a stale or empty snapshot, no work to compact, or drain quota returns before invoking onHistorianRunStarted or awaiting.
    // A synchronous no-op for a stale or empty snapshot, no work to compact, or drain quota returns before invoking onHistorianRunStarted or awaiting.
    // The runner clears compartmentInProgress in its finally, but activeRuns requires separate cleanup.
    // Synchronous deletion lets queued drop operations materialize in the same transform pass.
    // `promise.finally` still performs interval and lease cleanup.
    // `promise.finally`'s `=== promise` guard makes the later deletion a no-op.
    // `promise.finally`'s `=== promise` guard makes its later deletion a no-op.
    if (!realRunStarted && activeRuns.get(deps.sessionId)?.promise === promise) {
        activeRuns.delete(deps.sessionId);
    }
}

export interface ExecuteContextRecompOptions {
    /**
     * `range` contains inclusive raw-message ordinals for partial recompilation.
     * Partial recompilation snaps the range to enclosing compartment boundaries.
     * Partial recompilation preserves compartments before and after the selected range.
     * Partial recompilation preserves all session facts.
     *
     * Without `range`, recompilation runs from message 1 through the protected tail.
     * Full recompilation replaces all compartments and session facts.
     */
    range?: PartialRecompRange;
    /** @internal */
    onLeaseAcquired?: () => void;
}

export interface ExecuteContextRecompResult {
    message: string;
    published: boolean;
}

export async function executeContextRecompWithResult(
    deps: CompartmentRunnerDeps,
    options: ExecuteContextRecompOptions = {},
): Promise<ExecuteContextRecompResult> {
    const { sessionId } = deps;
    if (isWrapupInProgress(deps.db, sessionId)) {
        return {
            message:
                "## Magic Recomp — Skipped\n\n/ctx-wrapup is already compacting this session. Wait for it to finish, then try `/ctx-recomp` again.",
            published: false,
        };
    }
    if (activeRuns.has(sessionId)) {
        return {
            // `published: false` reports that this invocation did not publish a recompilation.
            message:
                "## Magic Recomp — Skipped\n\nHistorian is already running for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            published: false,
        };
    }

    const holderId = crypto.randomUUID();
    const lease = acquireCompartmentLease(deps.db, sessionId, holderId);
    if (!lease) {
        sessionLog(sessionId, "recomp skipped: compartment lease held by another process");
        return {
            message:
                "## Magic Recomp — Skipped\n\nAnother process is already mutating compartment state for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            published: false,
        };
    }
    options.onLeaseAcquired?.();
    if (isWrapupInProgress(deps.db, sessionId)) {
        // Recheck after acquiring the lease because wrapup can start between the first check and lease acquisition.
        sessionLog(sessionId, "recomp skipped: /ctx-wrapup became active");
        releaseCompartmentLease(deps.db, sessionId, holderId);
        return {
            message:
                "## Magic Recomp — Skipped\n\n/ctx-wrapup is already compacting this session. Wait for it to finish, then try `/ctx-recomp` again.",
            published: false,
        };
    }
    const renewal = startLeaseRenewal(deps, holderId);
    const runnerDeps = withPublishedCallback({ ...deps, compartmentLeaseHolderId: holderId });
    const promise = options.range
        ? executePartialRecompInternal(runnerDeps, options.range)
        : executeContextRecompInternal(runnerDeps);
    const wrappedPromise = promise
        .then(() => undefined)
        .catch((err) => {
            sessionLog(sessionId, "compartment agent: recomp unhandled rejection:", err);
        });
    activeRuns.set(sessionId, { promise: wrappedPromise, published: false, kind: "recomp" });
    try {
        const message = await promise;
        const published = activeRuns.get(sessionId)?.published === true;
        const outcomeSummary = message.replace(/\s+/g, " ").trim().slice(0, 240);
        sessionLog(sessionId, `recomp finished (published=${published}): ${outcomeSummary}`);
        return {
            message,
            published,
        };
    } finally {
        clearInterval(renewal);
        releaseCompartmentLease(deps.db, sessionId, holderId);
        if (activeRuns.get(sessionId)?.promise === wrappedPromise) {
            activeRuns.delete(sessionId);
        }
    }
}

export async function executeContextRecomp(
    deps: CompartmentRunnerDeps,
    options: ExecuteContextRecompOptions = {},
): Promise<string> {
    return (await executeContextRecompWithResult(deps, options)).message;
}

export { runCompartmentAgent } from "./compartment-runner-incremental";
export type { PartialRecompRange } from "./compartment-runner-partial-recomp";
