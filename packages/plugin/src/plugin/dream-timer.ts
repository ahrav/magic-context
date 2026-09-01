import { statSync } from "node:fs";

import type { DreamerConfig } from "../config/schema/magic-context";
import {
    findModuleNoteEvaluationBridgeForDrain,
    getAuthorityManagedMarker,
} from "../features/magic-context/context-authority";
import type { ClassifyModuleClient } from "../features/magic-context/dreamer/classify";
import { acquireLease, releaseLease } from "../features/magic-context/dreamer/lease";
import { openOpenCodeDb } from "../features/magic-context/dreamer/open-opencode-db";
import { reembedStalePrimerEmbeddings } from "../features/magic-context/dreamer/promote-primers";
import {
    PRIVACY_SENSITIVE_CHILD_TASKS,
    PRIVACY_SENSITIVE_CHILD_TITLE_MATCHES,
    retrospectiveOrphanStaleMs,
    sweepOrphanedRetrospectiveChildren,
} from "../features/magic-context/dreamer/retrospective-orphan-sweep";
import {
    OpenCodeRetrospectiveRawProvider,
    type RetrospectiveRawProvider,
} from "../features/magic-context/dreamer/retrospective-raw-provider";
import { deleteTaskScheduleRowsForProject } from "../features/magic-context/dreamer/storage-task-schedule";
import {
    buildDreamTaskRuntimeConfigs,
    userMemoryCollectionEnabled,
} from "../features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "../features/magic-context/dreamer/task-executor";
import type {
    DreamTaskName,
    DreamTaskProgress,
} from "../features/magic-context/dreamer/task-registry";
import { leaseKeyFor } from "../features/magic-context/dreamer/task-registry";
import { runDueTasksForProject } from "../features/magic-context/dreamer/task-scheduler";
import {
    acquireGitSweepLease,
    embedUnembeddedCommits,
    GIT_SWEEP_LEASE_RENEWAL_MS,
    indexCommitsForProject,
    markGitSweepSuccessAndRelease,
    parkGitSweepNonIndexable,
    releaseGitSweepLease,
    renewGitSweepLease,
} from "../features/magic-context/git-commits";
import {
    embedUnembeddedCompartmentChunksForProject,
    getProjectEmbeddingSnapshot,
} from "../features/magic-context/memory/embedding";
import { sweepOrphanedOpenCodeMessageIndexes } from "../features/magic-context/message-index";
import {
    drainCommitBacklogForProject,
    sweepStaleEmbeddingIdentitiesForProject,
} from "../features/magic-context/project-embedding-registry";
import { runDueCompiledSmartNoteChecks } from "../features/magic-context/smart-notes/runner";
import {
    openDatabase,
    retryPendingSessionCleanups,
    runSqliteOptimize,
} from "../features/magic-context/storage";
import type { RawMessageProvider } from "../hooks/magic-context/read-session-chunk";
import { getErrorMessage } from "../shared/error-message";
import { log } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import { beginBootQuietPeriod, scheduleAfterBootQuiet } from "./boot-quiet";
import type { PluginContext } from "./types";

/* */
const DREAM_TIMER_INTERVAL_MS = 15 * 60 * 1000;
/** The post-sweep commit backlog drain has a 5-minute wall-clock budget. */
const GIT_COMMIT_BACKLOG_DRAIN_MAX_MS = 5 * 60 * 1000;
/* */
const BOOT_PROJECT_JITTER_SLOT_MS = 1_000;

/**
 */
interface ProjectRegistration {
    directory: string;
    projectIdentity: string;
    client: PluginContext["client"];
    dreamerConfig?: DreamerConfig;
    language?: string;
    gitCommitIndexing?: {
        enabled: boolean;
        since_days: number;
        max_commits: number;
    };
    memoryEnabled?: boolean;
    memoryInjectionBudgetTokens?: number;
    mural?: { enabled: boolean; model?: string };
    retinaHandoff?: boolean;
    embeddingConfig?: { provider?: string };
    ensureRegistered: (directory: string, db: Database) => Promise<void>;
    /**
     */
    retrospectiveRawProvider?: (
        db: Database,
        projectIdentity: string,
    ) => RetrospectiveRawProvider | null;
    /**
     */
    primerRawProviderFactory?: (
        sessionId: string,
    ) => Promise<RawMessageProvider | null> | RawMessageProvider | null;
    transformMode?: "ts" | "rust";
    onDreamerProgress?: (progress: DreamTaskProgress | null, completedTask?: DreamTaskName) => void;
    moduleClient?: ClassifyModuleClient & {
        authorityStatus?: (args: {
            context_store_uuid: string;
            project: string;
            projectRoot?: string;
            domain: "memories" | "notes";
        }) => Promise<{ authority: { state?: string; generation?: number } | null }>;
    };
}

/* */
let activeTimer: ReturnType<typeof setInterval> | null = null;
const startupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const startupJitters = new Map<string, number>();
let nextStartupJitterSlot = 0;

/**
 */
export function resetStartupJitterSlotsForTests(): void {
    startupJitters.clear();
    nextStartupJitterSlot = 0;
}

/**
 * */
function directoryStillExists(directory: string): boolean {
    try {
        return statSync(directory).isDirectory();
    } catch {
        return false;
    }
}

/**
 */
function openTimerDatabaseOrNull(context: string): Database | null {
    let db: Database | null;
    try {
        db = openDatabase();
    } catch (error) {
        log(`[dreamer] storage fatal; skipping ${context}: ${getErrorMessage(error)}`);
        return null;
    }
    if (!db) {
        log(
            `[dreamer] storage unavailable; skipping ${context} (the cache schema is newer than this binary supports — restart/upgrade OpenCode/Pi/Magic Context to recover)`,
        );
        return null;
    }
    return db;
}
/**
 * registeredProjects uses directories as keys, so re-registering a directory replaces its registration. */
const registeredProjects = new Map<string, ProjectRegistration>();

/**
 * The singleton timer runs maintenance for every registered project.
 * The quiet-period startup pass prevents concurrent boot from creating a writer burst.
 *
 * The cleanup removes the project registration and stops the timer after the last project unregisters.
 */
export async function startDreamScheduleTimer(
    args: ProjectRegistration,
): Promise<(() => void) | undefined> {
    beginBootQuietPeriod();
    const db = openTimerDatabaseOrNull("schedule timer registration");
    if (!db) return;
    const dreamingEnabled = Boolean(args.dreamerConfig && args.dreamerConfig.disable !== true);
    const embeddingSweepEnabled = args.memoryEnabled === true;
    const commitIndexingEnabled = args.gitCommitIndexing?.enabled === true;

    // The plugin registers even when project work is disabled because the timer maintains global message-history privacy.

    const previousRegistration = registeredProjects.get(args.directory);
    const isNewRegistration = previousRegistration === undefined;
    if (previousRegistration && previousRegistration !== args) {
        const pendingStartup = startupTimers.get(args.directory);
        if (pendingStartup) {
            clearTimeout(pendingStartup);
            startupTimers.delete(args.directory);
        }
    }
    registeredProjects.set(args.directory, args);

    if (isNewRegistration) {
        log(
            `[dreamer] registered project ${args.projectIdentity} (dreaming=${dreamingEnabled} embeddings=${embeddingSweepEnabled} commits=${commitIndexingEnabled}; total=${registeredProjects.size})`,
        );
    }

    if (!activeTimer) {
        // Startup passes wait for the quiet period and are staggered to avoid a multi-project writer burst.
        log(
            `[dreamer] started independent schedule timer (every ${DREAM_TIMER_INTERVAL_MS / 60_000}m)`,
        );

        scheduleAfterBootQuiet(() => runTick("startup"));

        const timer = setInterval(() => runTick("interval"), DREAM_TIMER_INTERVAL_MS);
        if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
        }
        activeTimer = timer;
    } else if (isNewRegistration || previousRegistration !== args) {
        scheduleInitialProjectRun(args, db);
    }

    return () => {
        registeredProjects.delete(args.directory);
        const startupTimer = startupTimers.get(args.directory);
        if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimers.delete(args.directory);
        }
        log(
            `[dreamer] unregistered project ${args.projectIdentity} (remaining=${registeredProjects.size})`,
        );
        if (registeredProjects.size === 0 && activeTimer) {
            clearInterval(activeTimer);
            activeTimer = null;
            startupJitters.clear();
            nextStartupJitterSlot = 0;
            log("[dreamer] stopped dream schedule timer (no projects left)");
        }
    };
}

/** All registered projects share one chunk-backfill budget per tick.
 * The chunk-backfill budget stays below DREAM_TIMER_INTERVAL_MS so backlog draining cannot exceed its scheduling interval.
 * */
const CHUNK_BACKFILL_TICK_BUDGET_MS = 10 * 60 * 1000;

/** tickInProgress prevents fire-and-forget interval ticks from overlapping backlogged ticks.
 * */
let tickInProgress = false;

/**
 * Each tick runs global message-history maintenance once, then each registered project's per-directory work.
 */
function runTick(origin: "startup" | "interval"): void {
    if (tickInProgress) {
        log(`[dreamer] timer tick (${origin}) skipped — previous tick still running`);
        return;
    }
    // Startup passes run outside their scheduling tick, so an interval tick skips while a startup wave drains.
    // An interval tick skips while a startup wave drains.
    if (origin === "interval" && startupQueueDepth > 0) {
        log(`[dreamer] timer tick (${origin}) skipped — startup wave still draining`);
        return;
    }
    log(`[dreamer] timer tick (${origin}) — projects=${registeredProjects.size}`);
    tickInProgress = true;
    void (async () => {
        try {
            const db = openTimerDatabaseOrNull("maintenance tick");
            if (!db) return;
            runMessageHistoryMaintenance(db);
            const chunkDeadlineAt = Date.now() + CHUNK_BACKFILL_TICK_BUDGET_MS;
            for (const reg of registeredProjects.values()) {
                if (origin === "startup") {
                    scheduleInitialProjectRun(reg, db);
                } else {
                    await runProjectMaintenance(reg, origin, db, chunkDeadlineAt);
                }
            }
            if (origin === "startup") return;
            runSqliteOptimize(db);
        } catch (error) {
            log("[magic-context] timer-triggered maintenance check failed:", error);
        } finally {
            tickInProgress = false;
        }
    })();
}

function runMessageHistoryMaintenance(db: Database): void {
    const cleanup = retryPendingSessionCleanups(db);
    if (cleanup.cleared > 0 || cleanup.failedSessionIds.length > 0) {
        log(
            `[message-index] pending session cleanup: cleared=${cleanup.cleared} failed=${cleanup.failedSessionIds.length}`,
        );
    }

    const sweep = sweepOrphanedOpenCodeMessageIndexes(db, openOpenCodeDb);
    if (sweep.deleted > 0) {
        log(
            `[message-index] orphan sweep: scanned=${sweep.scanned} deleted=${sweep.deleted} cursor=${sweep.cursor || "<complete>"}`,
        );
    }
}

function startupJitterMs(directory: string): number {
    const existing = startupJitters.get(directory);
    if (existing !== undefined) return existing;
    const slot = nextStartupJitterSlot;
    nextStartupJitterSlot += 1;
    const hash = [...directory].reduce(
        (value, character) => (value * 33 + character.charCodeAt(0)) >>> 0,
        5381,
    );
    const jitter = slot * BOOT_PROJECT_JITTER_SLOT_MS + (hash % BOOT_PROJECT_JITTER_SLOT_MS);
    startupJitters.set(directory, jitter);
    return jitter;
}

/** The startup queue serializes jittered passes to prevent concurrent draining of the shared provider and database.
 * All startup passes in a wave share one chunk-backfill budget. */
let startupQueue: Promise<void> = Promise.resolve();
let startupQueueDepth = 0;
let startupChunkDeadlineAt = 0;

/**
 * `reg` becomes stale when its directory unregisters or re-registers with new config; stale registrations retain disposed clients and sinks.
 *
 * The enqueue and dequeue paths recheck registration liveness because queued work can outlive a registration.
 */
function isLiveRegistration(reg: ProjectRegistration): boolean {
    return registeredProjects.get(reg.directory) === reg;
}

function enqueueStartupProjectRun(reg: ProjectRegistration, db: Database): void {
    if (startupQueueDepth === 0) {
        startupChunkDeadlineAt = Date.now() + CHUNK_BACKFILL_TICK_BUDGET_MS;
    }
    startupQueueDepth += 1;
    const chunkDeadlineAt = startupChunkDeadlineAt;
    startupQueue = startupQueue
        .then(() => {
            if (!isLiveRegistration(reg)) {
                log(
                    `[dreamer] startup maintenance skipped for ${reg.projectIdentity} — no longer the registered project`,
                );
                return;
            }
            return runProjectMaintenance(reg, "startup", db, chunkDeadlineAt);
        })
        .catch((error) => {
            log(
                `[dreamer] startup maintenance failed for ${reg.projectIdentity}: ${getErrorMessage(error)}`,
            );
        })
        .finally(() => {
            startupQueueDepth -= 1;
        });
}

function scheduleInitialProjectRun(reg: ProjectRegistration, db: Database): void {
    if (startupTimers.has(reg.directory)) return;
    const timer = scheduleAfterBootQuiet(() => {
        startupTimers.delete(reg.directory);
        if (!isLiveRegistration(reg)) return;
        enqueueStartupProjectRun(reg, db);
    }, startupJitterMs(reg.directory));
    startupTimers.set(reg.directory, timer);
}

async function runProjectMaintenance(
    reg: ProjectRegistration,
    origin: "startup" | "interval",
    db: Database,
    /** `chunkDeadlineAt` is shared by every project in an interval tick or startup wave.
     * */
    chunkDeadlineAt: number,
): Promise<void> {
    const projectMaintenanceEnabled =
        Boolean(reg.dreamerConfig && reg.dreamerConfig.disable !== true) ||
        reg.memoryEnabled === true ||
        reg.gitCommitIndexing?.enabled === true;
    if (!projectMaintenanceEnabled) return;

    await reg.ensureRegistered(reg.directory, db);
    const memorySnapshot = getProjectEmbeddingSnapshot(reg.projectIdentity);
    if (memorySnapshot?.enabled) {
        try {
            const chunkCount = await embedUnembeddedCompartmentChunksForProject(
                db,
                reg.projectIdentity,
                chunkDeadlineAt,
            );
            if (chunkCount > 0) {
                log(
                    `[magic-context] recovered ${chunkCount} missing compartment chunk embedding(s) for project ${reg.projectIdentity}`,
                );
            }
        } catch (error) {
            log(
                `[magic-context] chunk backfill failed for ${reg.projectIdentity}: ${getErrorMessage(error)}`,
            );
        }
    }
    await sweepProject(reg, origin, db);
}

/**
 *
 */
async function sweepProject(
    reg: ProjectRegistration,
    origin: "startup" | "interval",
    db: Database,
    gitCommitEnabled?: boolean,
): Promise<void> {
    // Git indexing and key-file verification would receive ENOENT when reading the removed directory.
    // A `dir:` identity is path-unique, so a missing directory leaves its schedule rows orphaned.
    // A `git:` identity is shared across worktrees and clones, so one dead worktree must not delete the shared project's schedule.
    if (!directoryStillExists(reg.directory)) {
        log(
            `[dreamer] project directory no longer exists (${reg.projectIdentity}); skipping + unregistering`,
        );
        if (reg.projectIdentity.startsWith("dir:")) {
            try {
                const removed = deleteTaskScheduleRowsForProject(db, reg.projectIdentity);
                if (removed > 0) {
                    log(
                        `[dreamer] GC'd ${removed} orphaned schedule row(s) for ${reg.projectIdentity}`,
                    );
                }
            } catch (error) {
                log(`[dreamer] orphan schedule GC failed for ${reg.projectIdentity}:`, error);
            }
        }
        registeredProjects.delete(reg.directory);
        return;
    }

    await reg.ensureRegistered(reg.directory, db);
    const embeddingSnapshot = getProjectEmbeddingSnapshot(reg.projectIdentity);
    const commitIndexingEnabled = gitCommitEnabled ?? embeddingSnapshot?.gitCommitEnabled === true;
    const gc = sweepStaleEmbeddingIdentitiesForProject(db, reg.projectIdentity);
    const gcDeleted = gc.commitRowsDeleted + gc.chunkRowsDeleted;
    if (gcDeleted > 0) {
        log(
            `[magic-context] GC'd ${gcDeleted} stale embedding row(s) for ${reg.projectIdentity} ` +
                `(commit=${gc.commitRowsDeleted} chunk=${gc.chunkRowsDeleted})`,
        );
    }

    // Re-embed primers during this sweep because primer search remains enabled when Dreamer scheduling is disabled.
    // A provider-identity change would otherwise prevent semantic primer retrieval indefinitely.
    try {
        const reembedded = await reembedStalePrimerEmbeddings(db, reg.projectIdentity);
        if (reembedded > 0) {
            log(
                `[magic-context] re-embedded ${reembedded} stale primer row(s) for ${reg.projectIdentity}`,
            );
        }
    } catch (error) {
        log(`[magic-context] stale-primer re-embed failed for ${reg.projectIdentity}: ${error}`);
    }

    const dreamerConfig = reg.dreamerConfig;
    const dreamingEnabled = Boolean(dreamerConfig && dreamerConfig.disable !== true);
    if (commitIndexingEnabled && reg.gitCommitIndexing) {
        await sweepGitCommits({
            directory: reg.directory,
            gitCommitIndexing: reg.gitCommitIndexing,
            projectIdentity: reg.projectIdentity,
            db,
        });
    }

    if (!dreamingEnabled || !dreamerConfig) {
        return;
    }

    try {
        await runCompiledSmartNoteSweep(reg, db);

        // The scheduler runs due tasks grouped by conflict domain under keyed leases.
        // The executor uses this registration's checkout, not another worktree that shares its `git:<sha>` identity.
        const runtimeConfigs = buildDreamTaskRuntimeConfigs(dreamerConfig, reg.language);
        const executor = createDreamTaskExecutor({
            client: reg.client,
            sessionDirectory: reg.directory,
            openOpenCodeDb,
            // Pi registrations supply a JSONL provider factory; the executor uses OpenCode when `reg.retrospectiveRawProvider` is nullish.
            retrospectiveRawProvider:
                reg.retrospectiveRawProvider ??
                ((db) => new OpenCodeRetrospectiveRawProvider({ contextDb: db, openOpenCodeDb })),
            // Pi scheduled `refresh-primers` tasks require the JSONL factory to read prior messages.
            primerRawProviderFactory: reg.primerRawProviderFactory,
            userMemoryCollectionEnabled: userMemoryCollectionEnabled(dreamerConfig),
            ensureProjectRegistered: reg.ensureRegistered,
            language: reg.language,
            dreamerModel: dreamerConfig.model,
            mural: reg.mural,
            memoryInjectionBudgetTokens: reg.memoryInjectionBudgetTokens,
            retinaHandoff: reg.retinaHandoff,
            transformMode: reg.transformMode,
            moduleClient: reg.moduleClient,
            onProgress: (progress, completedTask) =>
                reg.onDreamerProgress?.(progress, completedTask),
        });
        const ran = await runDueTasksForProject({
            db,
            projectIdentity: reg.projectIdentity,
            tasks: runtimeConfigs,
            executor,
        });
        if (ran > 0) {
            log(`[dreamer] timer tick (${origin}) ${reg.projectIdentity} — ran ${ran} task(s)`);
        }

        // The cleanup removes crash-orphaned children carrying raw user or project text only after the longest swept task's timeout elapses.
        // Only OpenCode needs orphan cleanup because Pi subprocess children die with their process.
        const privacySweepTimeouts = runtimeConfigs
            .filter((c) => (PRIVACY_SENSITIVE_CHILD_TASKS as readonly string[]).includes(c.task))
            .map((c) => c.timeoutMinutes);
        const ocDb = openOpenCodeDb();
        if (ocDb) {
            try {
                await sweepOrphanedRetrospectiveChildren({
                    opencodeDb: ocDb,
                    client: reg.client,
                    sessionDirectory: reg.directory,
                    staleMs: retrospectiveOrphanStaleMs(privacySweepTimeouts),
                    titleMatches: PRIVACY_SENSITIVE_CHILD_TITLE_MATCHES,
                });
            } catch (sweepError) {
                log(
                    `[dreamer] retrospective orphan sweep failed for ${reg.projectIdentity}:`,
                    sweepError,
                );
            } finally {
                closeQuietly(ocDb);
            }
        }
    } catch (error) {
        log(`[dreamer] timer-triggered task scheduling failed for ${reg.projectIdentity}:`, error);
    }
}

async function runCompiledSmartNoteSweep(reg: ProjectRegistration, db: Database): Promise<void> {
    const bridge = findModuleNoteEvaluationBridgeForDrain(reg.projectIdentity, reg.directory);
    if (bridge) {
        // Do not gate drain on `bridge.available()`: drain re-registers a dropped evaluator.
        // Gating drain on `bridge.available()` would make failed boot registration or module restart unrecoverable for this process.
        // The bridge suppresses local claims and publishes wake ownership when the wake plane is present.
        //
        // The cron-scheduled `evaluate-smart-notes` task drains compile and fallback claims with full budgets.
        // Zero budgets release replayed or slot-recovered claims that bypass authority selection.
        // executed.
        const result = await bridge.drain({
            deadline: Date.now() + 60_000,
            excludeBillable: true,
            maxCompilePerRun: 0,
            maxFallbackPerRun: 0,
        });
        if (result.claimed > 0) {
            log(
                `[dreamer] module smart-note drain ${reg.projectIdentity}: claimed=${result.claimed} completed=${result.completed} surfaced=${result.surfaced}`,
            );
        }
        return;
    }
    // When a module-managed project has no bridge, return before the legacy sweep writes `context.db`; the authority guard rejects that write and aborts other due Dreamer tasks.
    if (getAuthorityManagedMarker(db, reg.projectIdentity)) return;
    const leaseKey = leaseKeyFor("evaluate-smart-notes", reg.projectIdentity);
    const holderId = crypto.randomUUID();
    if (!acquireLease(db, holderId, leaseKey)) return;
    try {
        const result = await runDueCompiledSmartNoteChecks({
            db,
            projectIdentity: reg.projectIdentity,
            projectRoot: reg.directory,
            retinaHandoff: reg.retinaHandoff,
        });
        if (result.ran > 0) {
            log(
                `[dreamer] compiled smart-note sweep ${reg.projectIdentity}: ran=${result.ran} surfaced=${result.surfaced} logic_failed=${result.failed} network_failed=${result.networkFailed}`,
            );
        }
    } finally {
        releaseLease(db, holderId, leaseKey);
    }
}

/**
 *
 */
function startGitSweepLeaseRenewal(
    db: Database,
    projectIdentity: string,
    holderId: string,
): () => void {
    const timer = setInterval(() => {
        try {
            if (!renewGitSweepLease(db, projectIdentity, holderId)) {
                log(`[git-commits] sweep lease renewal failed for ${projectIdentity}`);
            }
        } catch (error) {
            log(
                `[git-commits] sweep lease renewal errored for ${projectIdentity}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }, GIT_SWEEP_LEASE_RENEWAL_MS);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
}

async function sweepGitCommits(args: {
    directory: string;
    projectIdentity: string;
    db: Database;
    gitCommitIndexing: { enabled: boolean; since_days: number; max_commits: number };
}): Promise<void> {
    const { directory, projectIdentity, db, gitCommitIndexing } = args;
    const holderId = crypto.randomUUID();
    const lease = acquireGitSweepLease(db, projectIdentity, holderId);
    if (!lease.acquired) {
        const reason =
            lease.reason === "cooldown_active"
                ? `cooldown active until ${lease.nextAllowedAt}`
                : `lease held by ${lease.leaseHolder ?? "another holder"} until ${lease.leaseExpiresAt ?? "unknown"}`;
        log(`[git-commits] sweep skipped for ${projectIdentity}: ${reason}`);
        return;
    }

    const startedAt = Date.now();
    const stopRenewal = startGitSweepLeaseRenewal(db, projectIdentity, holderId);
    log(
        `[git-commits] sweep starting for ${projectIdentity} (sinceDays=${gitCommitIndexing.since_days} maxCommits=${gitCommitIndexing.max_commits})`,
    );
    try {
        const result = await indexCommitsForProject(db, projectIdentity, directory, {
            sinceDays: gitCommitIndexing.since_days,
            maxCommits: gitCommitIndexing.max_commits,
        });
        if (result.nonIndexable) {
            // The re-probe cooldown prevents retries and logs on every timer tick.
            if (!parkGitSweepNonIndexable(db, projectIdentity, holderId)) {
                releaseGitSweepLease(db, projectIdentity, holderId);
            }
            return;
        }
        // The indexer caps each run, so the sweep drains the remaining embedding backlog.
        let drainedEmbeddings = 0;
        if (result.embedded > 0) {
            drainedEmbeddings = await embedUnembeddedCommits(db, projectIdentity);
        }
        const cooldownMarked = markGitSweepSuccessAndRelease(db, projectIdentity, holderId);
        if (!cooldownMarked) {
            releaseGitSweepLease(db, projectIdentity, holderId);
            log(
                `[git-commits] sweep finished for ${projectIdentity}, but lease was no longer active; cooldown not advanced`,
            );
        }

        const memorySnapshot = getProjectEmbeddingSnapshot(projectIdentity);
        let backlogDrained = 0;
        if (memorySnapshot?.gitCommitEnabled) {
            try {
                backlogDrained = await drainCommitBacklogForProject(
                    db,
                    projectIdentity,
                    Date.now() + GIT_COMMIT_BACKLOG_DRAIN_MAX_MS,
                );
            } catch (error) {
                log(
                    `[git-commits] commit backlog drain failed for ${projectIdentity}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        const elapsedMs = Date.now() - startedAt;
        log(
            `[git-commits] sweep finished for ${projectIdentity} in ${elapsedMs}ms: scanned=${result.scanned} inserted=${result.inserted} updated=${result.updated} evicted=${result.evicted} embedded=${result.embedded} drained=${drainedEmbeddings} backlogDrained=${backlogDrained}`,
        );
    } catch (error) {
        releaseGitSweepLease(db, projectIdentity, holderId);
        const elapsedMs = Date.now() - startedAt;
        log(
            `[git-commits] sweep failed for ${projectIdentity} after ${elapsedMs}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
        stopRenewal();
    }
}
