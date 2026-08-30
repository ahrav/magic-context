/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../../shared/sqlite";
import {
    clearDeferredExecutePendingIfMatches,
    type DeferredExecutePayload,
    peekDeferredExecutePending,
    setDeferredExecutePendingIfAbsent,
} from "./storage-meta-persisted";
import { ensureSessionMetaRow } from "./storage-meta-shared";
import { createDirectTestDatabase } from "./test-database";

function createTestDb(): Database {
    return createDirectTestDatabase().db;
}

const payload: DeferredExecutePayload = {
    id: "flag-1",
    reason: "execute-none",
    recordedAt: 1_700_000_000_000,
};

describe("deferred execute state", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    it("peeks null when no deferred execute state is present", () => {
        ensureSessionMetaRow(db, "session-1");

        expect(peekDeferredExecutePending(db, "session-1")).toBeNull();
    });

    it("peeks non-null deferred execute state", () => {
        ensureSessionMetaRow(db, "session-1");
        db.prepare("UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?").run(
            JSON.stringify(payload),
            "session-1",
        );

        expect(peekDeferredExecutePending(db, "session-1")).toEqual(payload);
    });

    it("set-then-set fails when a deferred execute state already exists", () => {
        expect(setDeferredExecutePendingIfAbsent(db, "session-1", payload)).toBe(true);

        const second: DeferredExecutePayload = { ...payload, id: "flag-2" };
        expect(setDeferredExecutePendingIfAbsent(db, "session-1", second)).toBe(false);
    });

    it("set-then-peek returns the recorded deferred execute payload", () => {
        setDeferredExecutePendingIfAbsent(db, "session-1", payload);

        expect(peekDeferredExecutePending(db, "session-1")).toEqual(payload);
    });

    it("clear-matches removes the deferred execute payload", () => {
        setDeferredExecutePendingIfAbsent(db, "session-1", payload);

        expect(clearDeferredExecutePendingIfMatches(db, "session-1", payload)).toBe(true);
        expect(peekDeferredExecutePending(db, "session-1")).toBeNull();
    });

    it("clear-stale-fails leaves the deferred execute payload intact", () => {
        setDeferredExecutePendingIfAbsent(db, "session-1", payload);

        const stale: DeferredExecutePayload = { ...payload, id: "stale" };
        expect(clearDeferredExecutePendingIfMatches(db, "session-1", stale)).toBe(false);
        expect(peekDeferredExecutePending(db, "session-1")).toEqual(payload);
    });
});
