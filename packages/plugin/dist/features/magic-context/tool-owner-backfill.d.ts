/**
 * Tool-owner backfill (plan v3.3.1, Layer B).
 *
 * Migration v10 added `tool_owner_message_id` to the tags table. The
 * runtime carries every new tool tag with a non-NULL owner, but the
 * 185k+ existing rows in user DBs need their owner column populated to
 * make the v10 fix fully effective. The backfill pass iterates each
 * session that has tool tags with NULL owner, queries the OpenCode DB
 * for the temporally-earliest assistant message that invoked each
 * callID, and writes the owner via a NULL-guarded UPDATE so the
 * runtime can lazily adopt rows the backfill couldn't see (e.g. Pi
 * sessions, deleted OC sessions, transient OC-DB-unavailable cases).
 *
 * Concurrency model:
 *   - Per-session advisory lease via `tool_owner_backfill_state`.
 *   - 5-minute lease, renewed every 60s during chunked execution.
 *   - Sibling instances skip sessions whose lease is held and active.
 *   - Process-death cleanup falls out for free: better-sqlite3 + WAL
 *     drops all locks at process exit, and the `lease_expires_at`
 *     column is the only durable state. A crashed process's session
 *     becomes claimable as soon as the lease wall-clock expires.
 *   - NULL-guarded UPDATE: backfill never clobbers a row already
 *     adopted at runtime.
 *
 * Skip vs fail semantics:
 *   - When OpenCode DB is missing (e.g. Pi-only install), every
 *     session gets marked 'skipped' in the state table. Lazy adoption
 *     handles the orphans at runtime.
 *   - When OpenCode DB exists but a specific session is missing or
 *     yields zero matches, that session is marked 'skipped' too.
 *     Same lazy-adoption fallback covers it.
 *   - A session error during backfill (SQLITE_BUSY, malformed JSON,
 *     anything) is logged and the session is left in 'pending'/
 *     'running' for a retry on next plugin start. Backfill never
 *     fail-closes the plugin — it's defense-in-depth on top of
 *     Layer C lazy adoption.
 *
 * Idempotency:
 *   - The NULL guard makes UPDATE idempotent: re-running against an
 *     already-backfilled row matches zero rows and moves on.
 *   - The state table makes session bookkeeping idempotent: a
 *     completed session is never re-processed; a session with unresolved
 *     NULL-owner rows stays pending for later lazy adoption/retry.
 */
import type { Database } from "../../shared/sqlite";
interface BackfillStateRow {
    session_id: string;
    status: string;
    started_at: number | null;
    lease_expires_at: number | null;
    completed_at: number | null;
    last_error: string | null;
}
interface BackfillResult {
    sessionsProcessed: number;
    sessionsSkippedNoOcDb: number;
    sessionsSkippedNoMatches: number;
    sessionsCompleted: number;
    sessionsBlockedByLease: number;
    sessionsErrored: number;
    rowsUpdated: number;
    rowsLeftNull: number;
    durationMs: number;
}
/**
 * Top-level entry point. Called from `openDatabase()` after
 * `runMigrations()` returns. Synchronous; runs to completion before
 * returning so the first transform pass on a fresh upgrade sees a
 * mostly-backfilled DB.
 *
 * Worst-case runtime on the user's playground DB (3,276 sessions,
 * 185,716 tool tags): ~25 seconds. Well under the 60-second budget.
 */
export declare function runToolOwnerBackfill(db: Database): BackfillResult;
/**
 * Returns true when at least one tool tag exists with NULL owner that
 * isn't already marked completed/skipped in the state table.
 *
 * Treating "no NULL-owner tags" as "no work" lets us short-circuit on
 * fresh DBs (every row is born with a non-NULL owner) and on already-
 * backfilled DBs (re-running is a no-op).
 */
export declare function isToolOwnerBackfillNeeded(db: Database): boolean;
/** Test-only hook for the clear-versus-terminal-transition race. */
export declare function _markSessionSkippedForTests(db: Database, sessionId: string): void;
/**
 * Test-only: read the backfill state for a session. Exposed via the
 * normal export but namespaced by underscore so it doesn't show up in
 * the public surface area outside tests.
 */
export declare function _getBackfillState(db: Database, sessionId: string): BackfillStateRow | null;
export {};
//# sourceMappingURL=tool-owner-backfill.d.ts.map