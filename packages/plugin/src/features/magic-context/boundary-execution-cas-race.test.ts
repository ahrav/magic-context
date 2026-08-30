/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type DeferredExecutePayload,
    peekDeferredExecutePending,
    setDeferredExecutePendingIfAbsent,
} from "./storage-meta-persisted";
import { createDirectTestDatabase } from "./test-database";

/** First handle composes the full runtime schema on disk (WAL included);
 *  the second must open plain because composeRegisteredSchema refuses a
 *  non-empty database — giving two connections racing over one file, like
 *  two production processes sharing one database. */
function createRaceDb(path: string): Database {
    if (!existsSync(path)) return createDirectTestDatabase({ path }).db;
    const db = new Database(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    return db;
}

function payload(id: string): DeferredExecutePayload {
    return { id, reason: "execute-none", recordedAt: 1_700_000_000_000 };
}

describe("deferred execute CAS race", () => {
    it("15. one WAL handle wins set-if-absent and the other no-ops", () => {
        const dir = mkdtempSync(join(tmpdir(), "boundary-exec-race-"));
        const path = join(dir, "context.db");
        const a = createRaceDb(path);
        const b = createRaceDb(path);
        try {
            const first = setDeferredExecutePendingIfAbsent(a, "s1", payload("a"));
            const second = setDeferredExecutePendingIfAbsent(b, "s1", payload("b"));
            expect([first, second].filter(Boolean)).toHaveLength(1);
            expect(peekDeferredExecutePending(a, "s1")?.id).toBe(first ? "a" : "b");
        } finally {
            closeQuietly(a);
            closeQuietly(b);
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                // Ignore EBUSY on Windows
            }
        }
    });
});
