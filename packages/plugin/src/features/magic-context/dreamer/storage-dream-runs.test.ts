/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createDirectTestDatabase } from "../test-database";
import { getDreamRuns, insertDreamRun } from "./storage-dream-runs";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const d = createDirectTestDatabase().db;
    return d;
}

describe("dream_runs memory-change id arrays (#221)", () => {
    it("round-trips exact changed-id arrays through memory_changes_json", () => {
        db = freshDb();
        insertDreamRun(db, {
            projectPath: "dir:proj",
            startedAt: 1000,
            finishedAt: 2000,
            holderId: "h",
            tasks: [{ name: "improve", durationMs: 10, resultChars: 0 }],
            tasksSucceeded: 1,
            tasksFailed: 0,
            smartNotesSurfaced: 0,
            smartNotesPending: 0,
            memoryChanges: {
                written: 2,
                deleted: 0,
                archived: 1,
                merged: 0,
                writtenIds: [10, 11],
                deletedIds: [],
                archivedIds: [42],
                mergedIds: [],
            },
        });

        const [row] = getDreamRuns(db, "dir:proj", 10);
        expect(row).toBeDefined();
        const parsed = JSON.parse(row.memory_changes_json as string);
        // Counts stay === their array lengths (the contract the dashboard relies on).
        expect(parsed.written).toBe(2);
        expect(parsed.writtenIds).toEqual([10, 11]);
        expect(parsed.archived).toBe(1);
        expect(parsed.archivedIds).toEqual([42]);
        expect(parsed.mergedIds).toEqual([]);
    });

    it("stores null memory_changes_json when there were no changes", () => {
        db = freshDb();
        insertDreamRun(db, {
            projectPath: "dir:proj",
            startedAt: 1000,
            finishedAt: 2000,
            holderId: "h",
            tasks: [{ name: "verify", durationMs: 5, resultChars: 0 }],
            tasksSucceeded: 1,
            tasksFailed: 0,
            smartNotesSurfaced: 0,
            smartNotesPending: 0,
            memoryChanges: null,
        });
        const [row] = getDreamRuns(db, "dir:proj", 10);
        expect(row.memory_changes_json).toBeNull();
    });
});
