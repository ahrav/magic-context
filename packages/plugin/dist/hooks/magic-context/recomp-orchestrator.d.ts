import type { PluginContext } from "../../plugin/types";
import type { Database } from "../../shared/sqlite";
import { type PartialRecompRange } from "./compartment-runner";
import type { LiveSessionState } from "./live-session-state";
import type { NotificationParams } from "./send-session-notification";
/**
 * Single source of truth for recomp + session-upgrade orchestration.
 *
 * Before this module there were THREE diverged implementations — the RPC
 * `recomp` handler, the RPC `upgrade` handler, and the hook-side `executeRecomp`
 * closure (used by `/ctx-recomp` and `/ctx-session-upgrade`). They drifted: the
 * RPC handlers had live progress but no model fallback, while the hook path had
 * fallback but no progress. The dogfood failure on 2026-05-30 was exactly this —
 * the dialog "Run upgrade now" button (RPC, no fallback) failed when the primary
 * historian model returned empty, while `/ctx-session-upgrade` (hook, with
 * fallback) succeeded via the kimi fallback, leaving the sidebar stuck on a
 * stale "failed" because the command path never updated progress.
 *
 * `runManagedRecomp` / `runManagedUpgrade` give EVERY caller the full set:
 * fallback resilience (config chain + live-session-model last resort), live
 * progress (sidebar / status), and consistent terminal-state + messaging.
 */
/** Config-shape-agnostic context. Callers resolve config values and pass them
 *  in, so this module never couples to the loose RPC config record vs the typed
 *  hook config. */
export interface ManagedRecompContext {
    client: PluginContext["client"];
    db: Database;
    liveSessionState: LiveSessionState;
    /** Plugin-startup directory — last-resort fallback for session-dir resolution. */
    directory: string;
    historianChunkTokens: number;
    historianTimeoutMs: number;
    memoryEnabled: boolean;
    autoPromote: boolean;
    /** Resolved historian fallback chain (config `fallback_models` → builtin). */
    fallbackModels: readonly string[];
    language?: string;
    /** Pre-resolved last-resort model key (the live session model). When omitted,
     *  the orchestrator resolves it from `liveModelBySession`. The hook path passes
     *  this explicitly so it can include its OpenCode-DB fallback (the live map can
     *  be empty when `/ctx-recomp` runs before the first transform pass). */
    fallbackModelId?: string;
    userMemoriesEnabled: boolean;
    /** Two-pass historian (editor cleanup) — config `historian.two_pass`. */
    historianTwoPass?: boolean;
    getNotificationParams: (sessionId: string) => NotificationParams;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
}
/** The runner's outcome messages are headed "## Magic Recomp — <Status>" /
 *  "## Session Upgrade — <Status>". Failed/Skipped wrote nothing. */
export declare function isRecompFailure(message: string): boolean;
/** A SKIP (vs a true failure): the run no-op'd because the compartment-state
 *  lease was busy (incremental historian comparting the tail, or another process
 *  mutating state). Transient — retrying in a moment succeeds. Matches the
 *  "— Skipped" heading AND the suffix-less lease/already-running no-op text. */
export declare function isRecompSkip(message: string): boolean;
/** Positive full-success predicate: the recomp rebuilt the ENTIRE requested
 *  range, headed "## Magic Recomp — Complete". This is stricter than
 *  `!isRecompFailure(...)`: a "— Partial" outcome publishes a valid prefix
 *  (`published===true`) but did NOT cover the full range, and a lease-busy
 *  no-op returns a heading with no status suffix at all. Gating the upgrade on
 *  this — not on `!isRecompFailure` — prevents declaring "Complete" + running
 *  the project-wide memory migration when compartments were only partially
 *  rebuilt (tierless legacy rows would remain while memories migrated). A
 *  Partial is reported as Incomplete; re-running the upgrade continues the
 *  rebuild (the upgrade gate still sees the un-rebuilt legacy/tierless rows). */
export declare function isRecompComplete(message: string): boolean;
/** Strip markdown headings + blank lines from a runner outcome message, leaving
 *  the human reason for compact sidebar/status display. Fixes the dogfood
 *  2026-05-30 cosmetic bug where a raw "## Magic Recomp — Failed" heading leaked
 *  into the sidebar line. */
export declare function extractRecompReason(raw: string): string;
/**
 * Rewrite a recomp-flow reason string for the UPGRADE flow surface. The shared
 * recomp runner emits lease/active-run skip text that names `/ctx-recomp` — but
 * a user in the upgrade flow must be told to retry `/ctx-session-upgrade`, not
 * `/ctx-recomp` (they are different commands). The dominant skip cause on an
 * active session is the incremental historian briefly holding the
 * compartment-state lease while it comparts the live tail, which is transient,
 * so reframe the guidance as "retry in a moment" rather than a hard failure.
 */
export declare function contextualizeUpgradeReason(reason: string): string;
/** Emit an IMMEDIATE "recomp" progress entry the instant an upgrade/recomp is
 *  requested — before any async work (session-dir resolution, child-session
 *  creation, the first slow historian attempt + fallback). Without this the
 *  sidebar stays blank until the first per-pass emit, which can be 60-90s into a
 *  fallback-heavy run (dogfood 2026-05-30). `totalMessages: 0` renders an
 *  indeterminate "Starting…" state until the loop knows the real range. */
export declare function setRecompStarting(liveSessionState: LiveSessionState, sessionId: string, note: string, kind?: "recomp" | "upgrade" | "embed" | "wrapup"): void;
/** Update only the transient `note` on the active recomp progress entry (e.g.
 *  "trying fallback sonnet-4.6…") without disturbing the bar's counters. No-op
 *  if there's no active non-terminal entry. */
export declare function setRecompNote(liveSessionState: LiveSessionState, sessionId: string, note: string): void;
/** Record a terminal recomp/upgrade phase ("done"/"failed") so the TUI shows the
 *  OUTCOME (not a missed toast). "done" auto-clears after a grace period; "failed"
 *  persists until the next run so the reason stays visible. */
export declare function setRecompTerminal(liveSessionState: LiveSessionState, sessionId: string, phase: "done" | "failed" | "skipped", message: string): void;
/**
 * Run a recomp (full or partial), with fallback + live progress + terminal state.
 * Returns the runner's outcome message; the CALLER delivers it (so it can choose
 * force-persist vs toast). Used by `/ctx-recomp` and the RPC `recomp` handler.
 */
export declare function runManagedRecomp(ctx: ManagedRecompContext, sessionId: string, options?: {
    range?: PartialRecompRange;
}): Promise<string>;
export declare function runManagedUpgrade(ctx: ManagedRecompContext, sessionId: string): Promise<string>;
//# sourceMappingURL=recomp-orchestrator.d.ts.map