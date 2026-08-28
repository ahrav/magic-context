/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createDirectTestDatabase } from "../test-database";
import {
    getMostRecentTaskRunAt,
    getTaskScheduleState,
    getTaskScheduleStatesForProject,
    seedTaskScheduleState,
    writeTaskScheduleState,
} from "./storage-task-schedule";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const d = createDirectTestDatabase().db;
    return d;
}

describe("task_schedule_state storage", () => {
    it("returns null for an absent row", () => {
        db = freshDb();
        expect(getTaskScheduleState(db, "git:abc", "consolidate")).toBeNull();
    });

    it("seeds a row idempotently (second seed is a no-op)", () => {
        db = freshDb();
        seedTaskScheduleState(db, "git:abc", "consolidate", 1000, null, "0 3 * * *");
        // Second seed with different values must NOT overwrite (first-writer wins).
        seedTaskScheduleState(db, "git:abc", "consolidate", 9999, 5555, "0 * * * *");
        const row = getTaskScheduleState(db, "git:abc", "consolidate");
        expect(row?.nextDueAt).toBe(1000);
        expect(row?.lastRunAt).toBeNull();
        expect(row?.retryCount).toBe(0);
        expect(row?.schedule).toBe("0 3 * * *");
    });

    it("seeds last_run_at (migration seed-from-last_dream_at path)", () => {
        db = freshDb();
        seedTaskScheduleState(db, "git:abc", "verify", 2000, 1234, "0 3 * * *");
        expect(getTaskScheduleState(db, "git:abc", "verify")?.lastRunAt).toBe(1234);
    });

    it("upserts schedule fields on completion", () => {
        db = freshDb();
        seedTaskScheduleState(db, "git:abc", "consolidate", 1000, null, "0 3 * * *");
        writeTaskScheduleState(db, {
            projectPath: "git:abc",
            task: "consolidate",
            lastRunAt: 5000,
            nextDueAt: 90000,
            schedule: "0 3 * * *",
            lastStatus: "completed",
            lastError: null,
            retryCount: 0,
        });
        const row = getTaskScheduleState(db, "git:abc", "consolidate");
        expect(row?.lastRunAt).toBe(5000);
        expect(row?.nextDueAt).toBe(90000);
        expect(row?.lastStatus).toBe("completed");
        expect(row?.schedule).toBe("0 3 * * *");
    });

    it("persists a disabled task as next_due_at = NULL", () => {
        db = freshDb();
        seedTaskScheduleState(db, "git:abc", "maintain-docs", null, null, "");
        const row = getTaskScheduleState(db, "git:abc", "maintain-docs");
        expect(row).not.toBeNull();
        expect(row?.nextDueAt).toBeNull();
    });

    it("records failure status + error + retry count", () => {
        db = freshDb();
        writeTaskScheduleState(db, {
            projectPath: "git:abc",
            task: "improve",
            lastRunAt: 5000,
            nextDueAt: 1000,
            schedule: "0 3 * * *",
            lastStatus: "failed",
            lastError: "model not found",
            retryCount: 2,
        });
        const row = getTaskScheduleState(db, "git:abc", "improve");
        expect(row?.lastStatus).toBe("failed");
        expect(row?.lastError).toBe("model not found");
        expect(row?.retryCount).toBe(2);
    });

    it("lists rows for a project, scoped by project", () => {
        db = freshDb();
        seedTaskScheduleState(db, "git:abc", "consolidate", 1, null);
        seedTaskScheduleState(db, "git:abc", "verify", 2, null);
        seedTaskScheduleState(db, "git:other", "consolidate", 3, null);
        const rows = getTaskScheduleStatesForProject(db, "git:abc");
        expect(rows.map((r) => r.task).sort()).toEqual(["consolidate", "verify"]);
    });

    describe("getMostRecentTaskRunAt (issue #194 sidebar/status source)", () => {
        it("returns null when no task has run yet", () => {
            db = freshDb();
            seedTaskScheduleState(db, "git:abc", "verify", 1000, null);
            expect(getMostRecentTaskRunAt(db, "git:abc")).toBeNull();
        });

        it("returns the MAX last_run_at across the project's tasks", () => {
            db = freshDb();
            seedTaskScheduleState(db, "git:abc", "verify", 0, 5000);
            seedTaskScheduleState(db, "git:abc", "curate", 0, 8000);
            seedTaskScheduleState(db, "git:abc", "classify-memories", 0, 3000);
            expect(getMostRecentTaskRunAt(db, "git:abc")).toBe(8000);
        });

        it("is scoped to the project", () => {
            db = freshDb();
            seedTaskScheduleState(db, "git:abc", "verify", 0, 5000);
            seedTaskScheduleState(db, "git:other", "verify", 0, 9000);
            expect(getMostRecentTaskRunAt(db, "git:abc")).toBe(5000);
        });

        it("returns null for an unknown project", () => {
            db = freshDb();
            expect(getMostRecentTaskRunAt(db, "git:nope")).toBeNull();
        });
    });
});
