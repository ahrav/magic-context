import type { PluginContext } from "../../plugin/types";
import type { Database } from "../../shared/sqlite";
import type { ParsedEvent } from "./compartment-parser";
import type {
    BoundarySnapshotValidationResult,
    ProtectedTailBoundarySnapshot,
} from "./protected-tail-boundary";
import type { NotificationParams } from "./send-session-notification";

/**
 * Live progress for a running recomp / session-upgrade, surfaced in the TUI
 * so users can monitor long rebuilds.
 * Stored in `LiveSessionState.recompProgressBySession`.
 * (process-local, in-memory — if the process restarts mid-recomp the recomp
 * itself is interrupted, so losing the progress entry is correct).
 *
 *  - phase "recomp"    → rebuilding compartments; `processedMessages/totalMessages` drives the bar.
 *  - phase "migration" → recomp done, re-organizing project memories (indeterminate).
 *  - phase "done"      → finished successfully; `message` holds the summary. Auto-cleared after a grace period.
 *  - phase "failed"    → stopped without publishing; `message` holds the reason. Retained until next run.
 */
export interface RecompProgress {
    sessionId: string;
    /**
     * `kind` selects the sidebar and status label.
     *  Optional + defaults to "recomp" so runner-emitted per-pass entries (which
     *  don't know the flow) inherit the kind set by setRecompStarting. */
    kind?: "recomp" | "upgrade" | "embed" | "wrapup";
    /** "skipped" is a TRANSIENT non-failure outcome: the incremental historian
     * the compartment state). "skipped" auto-clears, unlike "failed".
     * "skipped" auto-clears, unlike "failed". */
    phase: "recomp" | "migration" | "done" | "failed" | "skipped";
    /** Raw messages processed so far (the recomp loop's `offset`). */
    processedMessages: number;
    /** Total raw messages to reprocess (protected-tail start − 1). */
    totalMessages: number;
    /** Successful historian passes completed. */
    passCount: number;
    /** Compartments rebuilt so far this run. */
    compartmentsCreated: number;
    startedAt: number;
    updatedAt: number;
    /** Terminal summary/reason (done | failed). */
    message?: string;
    /** Transient status line for the active phase — e.g. "Starting…", "Running
     *  historian…", "Primary returned nothing — trying fallback sonnet-4.6…",
     *  "Repair retry…". Surfaced under the progress bar so a long/retrying pass
     *  shows live activity instead of a frozen bar. */
    note?: string;
}

export interface CompartmentRunnerDeps {
    client: PluginContext["client"];
    db: Database;
    sessionId: string;
    /**
     * Historian chunk budget — how much raw history historian processes per
     * call. Bounded by the HISTORIAN model's context window, not main's.
     * Derived via `deriveHistorianChunkTokens(historianContextLimit)`.
     */
    historianChunkTokens: number;
    historianTimeoutMs?: number;
    /** Uses the default-snapshot factory when omitted. */
    boundarySnapshot?: ProtectedTailBoundarySnapshot;
    /** Manual wrapup uses this hook to re-resolve stale snapshots with the keep-watermark override.
     * `refreshBoundarySnapshot` bypasses normal pressure math.
     * */
    refreshBoundarySnapshot?: (
        snapshot: ProtectedTailBoundarySnapshot,
        validation: BoundarySnapshotValidationResult,
    ) => ProtectedTailBoundarySnapshot | null;
    /** Current resolved main-model context limit used to reject stale boundary snapshots after model switches. */
    currentContextLimit?: number;
    /** Resolved fallback chain for historian-family calls (historian + compressor). */
    fallbackModels?: readonly string[];
    language?: string;
    directory: string;
    historyBudgetTokens?: number;
    fallbackModelId?: string;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    getNotificationParams?: () => NotificationParams;
    /** When true, extract user behavior observations from historian output */
    experimentalUserMemories?: boolean;
    /** When true, inject wall-clock dates on compartments in <session-history>. */
    experimentalTemporalAwareness?: boolean;
    /** When true, the runner runs an editor pass after successful historian output to remove low-signal `U:` lines and cross-compartment duplicates.
     * */
    historianTwoPass?: boolean;
    /**
     * Cross-session memory feature gate (`memory.enabled` config). When false,
     * historian/recomp must NOT promote session facts into project memories
     * and must NOT generate or store embeddings.
     */
    memoryEnabled?: boolean;
    /**
     * Automatic-promotion gate (`memory.auto_promote` config). When false (and
     * memory is otherwise enabled), tools and search still work, but historian
     * does not auto-promote session facts to memories. Users can still write
     * memories explicitly via `ctx_memory write`.
     */
    autoPromote?: boolean;
    /**
     * The runner marks the run as published before invoking `onCompartmentStatePublished`.
     */
    onCompartmentStatePublished?: (sessionId: string) => void;
    /** The runner emits `recomp` progress to `onRecompProgress` at start and after each pass.
     * The caller handles migration and terminal (`done`/`failed`) phases.
     * The runner ignores errors from `onRecompProgress`. */
    onRecompProgress?: (progress: RecompProgress) => void;
    /**
     * When true, publication preserves the in-memory injection cache until a materializing pass consumes the deferred refresh.
     */
    preserveInjectionCacheUntilConsumed?: boolean;
    /**
     * The runner calls `onDeferredMarkerPending` after historian/recomp publication writes a pending compaction-marker row in the transaction.
     * Publication writes the pending compaction-marker row transactionally, deferring marker application to a materializing pass.
     * The next consuming postprocess pass drains the pending compaction-marker blob and applies its marker.
     */
    onDeferredMarkerPending?: (sessionId: string) => void;
    /** Holder id for the DB-backed compartment-state lease guarding publish paths. */
    compartmentLeaseHolderId?: string;
    /**
     * The runner invokes the callback after each no-op early return and immediately before the first `await`.
     * `startCompartmentAgent` uses the callback to distinguish a started fire-and-forget run from a synchronous no-op.
     * Without `onHistorianRunStarted`, queued drop operations would be deferred indefinitely.
     */
    onHistorianRunStarted?: () => void;
    /** Manual wrapup bypasses the pressure-window quota but keeps the no-progress breaker. */
    forceDrainQuota?: boolean;
    /** Persist a weak-lookahead final compartment for coverage, but skip durable promotion. */
    forceKeepLastCompartment?: boolean;
}

export interface CandidateCompartment {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    /** v2: P1 tier text (mirror). v1/compressor: flat content. */
    content: string;
    /** v2 paraphrase tiers (model B). Null/undefined for v1/flat compartments.
     * Nullability matches `CompartmentInput` so candidates and staging rows round-trip without type conversion.
     * */
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    /** v2 decay-rate signal (1-100). Null/undefined for v1/flat. */
    importance?: number | null;
    /** v2 comma-separated activity types. Null/undefined for v1/flat. */
    episodeType?: string | null;
}

export interface HistorianRunResult {
    ok: boolean;
    result?: string;
    error?: string;
    dumpPath?: string;
    invocationId?: number;
}

export type ValidatedHistorianPassResult =
    | {
          ok: true;
          compartments: CandidateCompartment[];
          facts: Array<{ category: string; content: string }>;
          userObservations?: string[];
          /** Durable standing-question candidates for Primers v1 (stored side-table only).
           * The index uses the same convention as `<events>` `at_compartment`.
           *  undefined → emission falls back to the chunk span. */
          primerCandidates?: Array<{ question: string; originCompartmentIndex?: number }>;
          /** Historian extraction stores events without rendering them. */
          events?: ParsedEvent[];
          /**
           * `invocationId` identifies the subagent invocation that produced this validated output.
           * The producing attempt may be primary, repair, editor, or fallback.
           * caller uses it as the exact `historian_runs.subagent_invocation_id`
           * The exact FK keeps telemetry joined to the producing invocation's tokens and model.
           * A kind-filtered latest-invocation lookup can select the wrong invocation.
           */
          invocationId?: number | null;
      }
    | { ok: false; error: string; invocationId?: number | null };

export interface StoredCompartmentRange {
    startMessage: number;
    endMessage: number;
}

export interface HistorianProgressCallbacks {
    onRepairRetry?: (error: string) => Promise<void>;
    /** `runFallbackHistorianPass` invokes `onModelFallback` before each fallback model attempt after the primary and repair attempts fail.
     * The callback lets the caller surface fallback progress.
     * */
    onModelFallback?: (modelId: string, index: number, total: number) => void;
}
