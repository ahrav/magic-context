import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { scheduleAfterBootQuiet } from "../../plugin/boot-quiet";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    clearIndexedMessages,
    getLastIndexedOrdinal,
    getMessageIndexReconciliationStartOrdinal,
    getMessageIndexSourceIdentity,
    indexMessagesAfterOrdinal,
    indexSingleMessage,
    isMessageIndexReconciledThrough,
    isMessageIndexSourceCurrent,
} from "./message-index";

/**
 *
 * `scheduleReconciliation` runs.
 */
function isDatabaseLockedError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const e = error as { code?: unknown; message?: unknown };
    if (typeof e.code === "string") {
        if (e.code === "SQLITE_BUSY" || e.code === "SQLITE_LOCKED") return true;
    }
    if (typeof e.message === "string") {
        if (/database is locked/i.test(e.message)) return true;
        if (/sqlite_(busy|locked)/i.test(e.message)) return true;
    }
    return false;
}

/**
 *
 *
 * Searches return no message hits until reconciliation completes.
 *
 *
 */

const INCREMENTAL_DEBOUNCE_MS = 100;
const RECONCILIATION_BATCH_SIZE = 100;

const reconciledSessions = new Set<string>();
const reconciliationScheduledSessions = new Set<string>();
const sessionLocks = new Map<string, Promise<void>>();
const incrementalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingIncrementalKeys = new Set<string>();
const completedIncrementalKeys = new Set<string>();

function clearCompletedIncrementalKeys(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of completedIncrementalKeys) {
        if (key.startsWith(prefix)) completedIncrementalKeys.delete(key);
    }
}

type ReadMessages = ((sessionId: string) => RawMessage[]) & {
    readPage?: (
        sessionId: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
    ) => RawMessage[];
    getCount?: (sessionId: string) => number;
};
type ReadSingleMessage = (sessionId: string, messageId: string) => RawMessage | null;
type IncrementalMessageSource = ReadSingleMessage | RawMessage;

function defer(fn: () => void): void {
    const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
        .setImmediate;
    if (typeof immediate === "function") {
        immediate(fn);
        return;
    }
    setTimeout(fn, 0);
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => defer(resolve));
}

function runWithSessionLock(
    sessionId: string,
    operation: () => Promise<void> | void,
): Promise<void> {
    const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
    const run = previous
        .catch(() => undefined)
        .then(async () => {
            await operation();
        });

    sessionLocks.set(sessionId, run);
    run.finally(() => {
        if (sessionLocks.get(sessionId) === run) {
            sessionLocks.delete(sessionId);
        }
    }).catch(() => undefined);

    return run;
}

function logIndexingError(sessionId: string, action: string, error: unknown): void {
    if (isDatabaseLockedError(error)) {
        // Database-lock failures leave skipped messages for later reconciliation.
        sessionLog(
            sessionId,
            `message FTS async ${action} skipped (database busy; will retry on next reconciliation)`,
        );
        return;
    }
    sessionLog(
        sessionId,
        `message FTS async ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    log(`[message-index-async] ${action} failed for ${sessionId}:`, error);
}

async function reconcileSessionIndex(
    db: Database,
    sessionId: string,
    readMessages: ReadMessages,
): Promise<void> {
    await runWithSessionLock(sessionId, async () => {
        if (reconciledSessions.has(sessionId)) return;

        let fallbackSnapshot: RawMessage[] | null = null;
        const finalWatermark = readMessages.getCount
            ? readMessages.getCount(sessionId)
            : (fallbackSnapshot = readMessages(sessionId)).length;
        let cursor = getMessageIndexReconciliationStartOrdinal(db, sessionId);

        while (cursor < finalWatermark) {
            const pageEnd = Math.min(finalWatermark, cursor + RECONCILIATION_BATCH_SIZE);
            const messages = readMessages.readPage
                ? readMessages.readPage(
                      sessionId,
                      cursor,
                      RECONCILIATION_BATCH_SIZE,
                      finalWatermark,
                  )
                : (fallbackSnapshot ?? []).filter(
                      (message) => message.ordinal > cursor && message.ordinal <= pageEnd,
                  );

            indexMessagesAfterOrdinal(db, sessionId, messages, cursor, pageEnd);
            const nextCursor = getMessageIndexReconciliationStartOrdinal(db, sessionId);
            if (nextCursor <= cursor) break;
            cursor = nextCursor;

            if (cursor < finalWatermark) {
                // Each reconciliation iteration processes at most `RECONCILIATION_BATCH_SIZE` messages before yielding.
                // `yieldToEventLoop()` defers the next source read and writer transaction to a later event-loop turn.
                await yieldToEventLoop();
            }
        }

        if (isMessageIndexReconciledThrough(db, sessionId, finalWatermark)) {
            reconciledSessions.add(sessionId);
        }
    });
}

export function scheduleReconciliation(
    db: Database,
    sessionId: string,
    readMessages: ReadMessages,
): void {
    if (reconciledSessions.has(sessionId) || reconciliationScheduledSessions.has(sessionId)) {
        return;
    }
    reconciliationScheduledSessions.add(sessionId);

    scheduleAfterBootQuiet(() => {
        defer(() => {
            void reconcileSessionIndex(db, sessionId, readMessages)
                .catch((error) => {
                    logIndexingError(sessionId, "reconciliation", error);
                })
                .finally(() => {
                    reconciliationScheduledSessions.delete(sessionId);
                });
        });
    });
}

export function scheduleIncrementalIndex(
    db: Database,
    sessionId: string,
    messageId: string,
    messageSource: IncrementalMessageSource,
): void {
    const schedulingKey = `${sessionId}\u0000${messageId}`;
    if (incrementalTimers.has(schedulingKey) || pendingIncrementalKeys.has(schedulingKey)) {
        return;
    }

    const timer = setTimeout(() => {
        incrementalTimers.delete(schedulingKey);
        pendingIncrementalKeys.add(schedulingKey);
        void runWithSessionLock(sessionId, () => {
            const message =
                typeof messageSource === "function"
                    ? messageSource(sessionId, messageId)
                    : messageSource;
            if (!message) return;

            const revisionKey = `${schedulingKey}\u0000${getMessageIndexSourceIdentity(message)}`;
            if (completedIncrementalKeys.has(revisionKey)) return;

            const currentWatermark = getLastIndexedOrdinal(db, sessionId);
            if (
                message.ordinal <= currentWatermark &&
                isMessageIndexSourceCurrent(db, sessionId, message)
            ) {
                completedIncrementalKeys.add(revisionKey);
                return;
            }

            const wasReconciled = reconciledSessions.delete(sessionId);
            indexSingleMessage(db, sessionId, message);
            const finalWatermark = getLastIndexedOrdinal(db, sessionId);
            if (wasReconciled && isMessageIndexReconciledThrough(db, sessionId, finalWatermark)) {
                reconciledSessions.add(sessionId);
            }
            completedIncrementalKeys.add(revisionKey);
        })
            .catch((error) => {
                reconciledSessions.delete(sessionId);
                logIndexingError(sessionId, `incremental index for ${messageId}`, error);
            })
            .finally(() => {
                pendingIncrementalKeys.delete(schedulingKey);
            });
    }, INCREMENTAL_DEBOUNCE_MS);

    incrementalTimers.set(schedulingKey, timer);
}

export function scheduleClearAndReindex(
    db: Database,
    sessionId: string,
    readMessages: ReadMessages,
): void {
    reconciledSessions.delete(sessionId);
    reconciliationScheduledSessions.delete(sessionId);
    clearCompletedIncrementalKeys(sessionId);

    scheduleAfterBootQuiet(() => {
        defer(() => {
            void runWithSessionLock(sessionId, () => {
                reconciledSessions.delete(sessionId);
                clearCompletedIncrementalKeys(sessionId);
                clearIndexedMessages(db, sessionId);
            })
                .then(() => reconcileSessionIndex(db, sessionId, readMessages))
                .catch((error) => {
                    reconciledSessions.delete(sessionId);
                    logIndexingError(sessionId, "clear and reindex", error);
                });
        });
    });
}

export function isSessionReconciled(sessionId: string): boolean {
    return reconciledSessions.has(sessionId);
}

export function clearSessionTracking(sessionId: string): void {
    reconciledSessions.delete(sessionId);
    reconciliationScheduledSessions.delete(sessionId);
    sessionLocks.delete(sessionId);

    const prefix = `${sessionId}\u0000`;
    for (const [key, timer] of incrementalTimers) {
        if (key.startsWith(prefix)) {
            clearTimeout(timer);
            incrementalTimers.delete(key);
        }
    }

    for (const key of pendingIncrementalKeys) {
        if (key.startsWith(prefix)) {
            pendingIncrementalKeys.delete(key);
        }
    }
    for (const key of completedIncrementalKeys) {
        if (key.startsWith(prefix)) completedIncrementalKeys.delete(key);
    }
}

export function __resetMessageIndexAsyncForTests(): void {
    for (const timer of incrementalTimers.values()) {
        clearTimeout(timer);
    }
    reconciledSessions.clear();
    reconciliationScheduledSessions.clear();
    sessionLocks.clear();
    incrementalTimers.clear();
    pendingIncrementalKeys.clear();
    completedIncrementalKeys.clear();
}
