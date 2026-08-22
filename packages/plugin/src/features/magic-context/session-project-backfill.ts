import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { getHarness } from "../../shared/harness";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { resolveProjectIdentity } from "./memory/project-identity";
import { recordSessionProjectIdentity } from "./session-project-storage";

const LEASE_TTL_MS = 10 * 60 * 1000;
const SESSION_PAGE_SIZE = 100;
const SESSION_QUERY_CHUNK_SIZE = 250;
const YIELD_EVERY_PROCESSED_SESSIONS = 25;
const YIELD_EVERY_IDENTITY_RESOLUTIONS = 2;

export interface SessionProjectBackfillSession {
    sessionId: string;
    directory: string;
}

export type SessionProjectBackfillSource =
    | readonly SessionProjectBackfillSession[]
    | ((
          afterSessionId: string | null,
          limit: number,
      ) =>
          | readonly SessionProjectBackfillSession[]
          | Promise<readonly SessionProjectBackfillSession[]>);

export interface BackfillResult {
    status: "completed" | "already_completed" | "blocked_by_lease" | "lost_lease" | "retry_pending";
    totalSessions: number;
    alreadyMappedSessions: number;
    unmappedSessions: number;
    backfilledSessions: number;
    skippedDeadDirectories: number;
    skippedEmptyDirectories: number;
    durationMs: number;
}

export interface SessionProjectBackfillStateRow {
    harness: string;
    status: "running" | "completed";
    holder_id: string | null;
    started_at: number | null;
    lease_expires_at: number | null;
    completed_at: number | null;
}

interface RunSessionProjectBackfillOptions {
    resolveIdentity?: (directory: string) => string | Promise<string>;
    now?: () => number;
    yieldFn?: () => Promise<void>;
    holderId?: string;
}

function ensureBackfillStateTable(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS session_project_backfill_state (
            harness TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
            holder_id TEXT,
            started_at INTEGER,
            lease_expires_at INTEGER,
            completed_at INTEGER
        );
    `);
    const columns = db.prepare("PRAGMA table_info(session_project_backfill_state)").all() as Array<{
        name?: string;
    }>;
    if (!columns.some((column) => column.name === "holder_id")) {
        try {
            db.exec("ALTER TABLE session_project_backfill_state ADD COLUMN holder_id TEXT");
        } catch (error) {
            if (!/duplicate column name/i.test(String(error))) throw error;
        }
    }
}

function defaultYieldFn(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function acquireBackfillLease(
    db: Database,
    harness: string,
    holderId: string,
    now: number,
): "acquired" | "already_completed" | "blocked_by_lease" {
    ensureBackfillStateTable(db);
    return db
        .transaction((): "acquired" | "already_completed" | "blocked_by_lease" => {
            const current = db
                .prepare(
                    `SELECT harness, status, holder_id, started_at, lease_expires_at, completed_at
                 FROM session_project_backfill_state
                 WHERE harness = ?`,
                )
                .get(harness) as SessionProjectBackfillStateRow | null | undefined;

            if (current?.status === "completed") return "already_completed";
            if (
                current?.status === "running" &&
                current.lease_expires_at !== null &&
                current.lease_expires_at > now
            ) {
                return "blocked_by_lease";
            }

            db.prepare(
                `INSERT INTO session_project_backfill_state(
                harness,
                status,
                holder_id,
                started_at,
                lease_expires_at,
                completed_at
            )
             VALUES (?, 'running', ?, ?, ?, NULL)
             ON CONFLICT(harness) DO UPDATE SET
                status = 'running',
                holder_id = excluded.holder_id,
                started_at = excluded.started_at,
                lease_expires_at = excluded.lease_expires_at,
                completed_at = NULL`,
            ).run(harness, holderId, now, now + LEASE_TTL_MS);

            return "acquired";
        })
        .immediate();
}

function renewBackfillLease(db: Database, harness: string, holderId: string, now: number): boolean {
    ensureBackfillStateTable(db);
    return (
        db
            .prepare(
                `UPDATE session_project_backfill_state
                 SET lease_expires_at = ?
                 WHERE harness = ? AND status = 'running' AND holder_id = ?`,
            )
            .run(now + LEASE_TTL_MS, harness, holderId).changes === 1
    );
}

function markBackfillCompleted(
    db: Database,
    harness: string,
    holderId: string,
    now: number,
): boolean {
    ensureBackfillStateTable(db);
    return (
        db
            .prepare(
                `UPDATE session_project_backfill_state
                 SET status = 'completed', lease_expires_at = NULL, completed_at = ?
                 WHERE harness = ? AND status = 'running' AND holder_id = ?`,
            )
            .run(now, harness, holderId).changes === 1
    );
}

function markBackfillRetryPending(
    db: Database,
    harness: string,
    holderId: string,
    now: number,
): boolean {
    ensureBackfillStateTable(db);
    return (
        db
            .prepare(
                `UPDATE session_project_backfill_state
                 SET lease_expires_at = ?
                 WHERE harness = ? AND status = 'running' AND holder_id = ?`,
            )
            .run(now, harness, holderId).changes === 1
    );
}

function dedupeSessions(
    sessions: readonly SessionProjectBackfillSession[],
): SessionProjectBackfillSession[] {
    const sessionsById = new Map<string, SessionProjectBackfillSession>();
    for (const session of sessions) {
        if (!session.sessionId) continue;
        const existing = sessionsById.get(session.sessionId);
        if (!existing || (!existing.directory && session.directory)) {
            sessionsById.set(session.sessionId, {
                sessionId: session.sessionId,
                directory: session.directory,
            });
        }
    }
    return [...sessionsById.values()];
}

function getMappedSessionIds(
    db: Database,
    harness: string,
    sessions: readonly SessionProjectBackfillSession[],
): Set<string> {
    const mapped = new Set<string>();
    for (let index = 0; index < sessions.length; index += SESSION_QUERY_CHUNK_SIZE) {
        const chunk = sessions.slice(index, index + SESSION_QUERY_CHUNK_SIZE);
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = db
            .prepare(
                `SELECT session_id
                 FROM session_projects
                 WHERE harness = ?
                   AND session_id IN (${placeholders})`,
            )
            .all(harness, ...chunk.map((session) => session.sessionId)) as Array<{
            session_id: string;
        }>;
        for (const row of rows) mapped.add(row.session_id);
    }
    return mapped;
}

function createPageReader(
    source: SessionProjectBackfillSource,
): (
    afterSessionId: string | null,
    limit: number,
) => Promise<readonly SessionProjectBackfillSession[]> {
    if (typeof source === "function") {
        return async (afterSessionId, limit) => source(afterSessionId, limit);
    }

    const sessions = dedupeSessions(source);
    let offset = 0;
    return async (_afterSessionId, limit) => {
        const page = sessions.slice(offset, offset + limit);
        offset += page.length;
        return page;
    };
}

export async function runSessionProjectBackfill(
    db: Database,
    source: SessionProjectBackfillSource,
    options: RunSessionProjectBackfillOptions = {},
): Promise<BackfillResult> {
    const startedAt = performance.now();
    const harness = getHarness();
    const now = options.now ?? Date.now;
    const resolveIdentity = options.resolveIdentity ?? resolveProjectIdentity;
    const yieldFn = options.yieldFn ?? defaultYieldFn;
    const holderId = options.holderId ?? randomUUID();
    const readPage = createPageReader(source);

    const result: BackfillResult = {
        status: "completed",
        totalSessions: 0,
        alreadyMappedSessions: 0,
        unmappedSessions: 0,
        backfilledSessions: 0,
        skippedDeadDirectories: 0,
        skippedEmptyDirectories: 0,
        durationMs: 0,
    };

    const leaseStatus = acquireBackfillLease(db, harness, holderId, now());
    if (leaseStatus !== "acquired") {
        result.status = leaseStatus;
        result.durationMs = performance.now() - startedAt;
        return result;
    }

    const finishWithLostLease = (): BackfillResult => {
        result.status = "lost_lease";
        result.durationMs = performance.now() - startedAt;
        return result;
    };
    const yieldAndRenew = async (): Promise<boolean> => {
        if (!renewBackfillLease(db, harness, holderId, now())) return false;
        await yieldFn();
        return renewBackfillLease(db, harness, holderId, now());
    };

    const existenceCache = new Map<string, boolean>();
    const identityCache = new Map<string, string>();
    const seenSessionIds = new Set<string>();
    let processedSinceYield = 0;
    let identityResolutionsSinceYield = 0;
    let afterSessionId: string | null = null;

    for (;;) {
        const sourcePage = await readPage(afterSessionId, SESSION_PAGE_SIZE);
        if (sourcePage.length === 0) break;
        afterSessionId = sourcePage.at(-1)?.sessionId ?? afterSessionId;
        const page = dedupeSessions(sourcePage).filter((session) => {
            if (seenSessionIds.has(session.sessionId)) return false;
            seenSessionIds.add(session.sessionId);
            return true;
        });
        const mappedSessionIds = getMappedSessionIds(db, harness, page);

        for (const session of page) {
            result.totalSessions += 1;
            processedSinceYield += 1;

            if (mappedSessionIds.has(session.sessionId)) {
                result.alreadyMappedSessions += 1;
            } else {
                result.unmappedSessions += 1;
                if (!session.directory) {
                    result.skippedEmptyDirectories += 1;
                } else {
                    const stillExists =
                        existenceCache.get(session.directory) ?? existsSync(session.directory);
                    existenceCache.set(session.directory, stillExists);
                    if (!stillExists) {
                        result.skippedDeadDirectories += 1;
                    } else {
                        let identity = identityCache.get(session.directory);
                        if (!identity) {
                            if (identityResolutionsSinceYield >= YIELD_EVERY_IDENTITY_RESOLUTIONS) {
                                if (!(await yieldAndRenew())) return finishWithLostLease();
                                processedSinceYield = 0;
                                identityResolutionsSinceYield = 0;
                            }
                            identity = await resolveIdentity(session.directory);
                            identityResolutionsSinceYield += 1;
                            // A synchronous resolver can block past the lease deadline.
                            // Revalidate ownership before persisting its result.
                            if (!renewBackfillLease(db, harness, holderId, now())) {
                                return finishWithLostLease();
                            }
                            identityCache.set(session.directory, identity);
                        }
                        recordSessionProjectIdentity(db, session.sessionId, identity);
                        result.backfilledSessions += 1;
                    }
                }
            }

            if (processedSinceYield >= YIELD_EVERY_PROCESSED_SESSIONS) {
                if (!(await yieldAndRenew())) return finishWithLostLease();
                processedSinceYield = 0;
                identityResolutionsSinceYield = 0;
            }
        }

        if (sourcePage.length < SESSION_PAGE_SIZE) break;
    }

    const hasSkippedSessions =
        result.skippedDeadDirectories > 0 || result.skippedEmptyDirectories > 0;
    if (hasSkippedSessions) {
        if (!markBackfillRetryPending(db, harness, holderId, now())) {
            return finishWithLostLease();
        }
        result.status = "retry_pending";
    } else if (!markBackfillCompleted(db, harness, holderId, now())) {
        return finishWithLostLease();
    }

    result.durationMs = performance.now() - startedAt;
    log(
        `[session-projects] backfilled ${result.backfilledSessions} of ${result.unmappedSessions} unmapped sessions (skipped ${result.skippedDeadDirectories} dead dirs) in ${Math.round(result.durationMs)}ms`,
    );
    return result;
}

export function _getSessionProjectBackfillState(
    db: Database,
    harness = getHarness(),
): SessionProjectBackfillStateRow | null {
    ensureBackfillStateTable(db);
    const row = db
        .prepare("SELECT * FROM session_project_backfill_state WHERE harness = ?")
        .get(harness);
    if (row === null || row === undefined) return null;
    return row as SessionProjectBackfillStateRow;
}
