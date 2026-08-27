import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearV22BackfillFailures,
    deleteV22BackfillFailure,
    getV22BackfillFailure,
    listV22BackfillFailures,
    recordV22BackfillFailure,
} from "./storage-v22-backfill-failures";
import { createDirectTestDatabase } from "./test-database";

let db: Database | null = null;

function makeDb(): Database {
    db = createDirectTestDatabase().db;
    return db;
}

afterEach(() => {
    if (db) {
        closeQuietly(db);
        db = null;
    }
});

describe("storage-v22-backfill-failures", () => {
    test("records and replaces one failure per source row", () => {
        const database = makeDb();

        const first = recordV22BackfillFailure(database, {
            tableName: "memories",
            rowId: 42,
            rawProjectPath: "/repo",
            errorClass: "git_timeout",
            errorMessage: "timed out",
            failedAt: 10,
        });
        const replaced = recordV22BackfillFailure(database, {
            tableName: "memories",
            rowId: 42,
            rawProjectPath: "/repo2",
            errorClass: "permission_denied",
            errorMessage: null,
            failedAt: 20,
        });

        expect(replaced.id).toBe(first.id);
        expect(getV22BackfillFailure(database, "memories", 42)).toEqual({
            id: first.id,
            tableName: "memories",
            rowId: 42,
            rawProjectPath: "/repo2",
            errorClass: "permission_denied",
            errorMessage: null,
            failedAt: 20,
        });
    });

    test("lists, deletes, and clears failures", () => {
        const database = makeDb();
        recordV22BackfillFailure(database, {
            tableName: "memories",
            rowId: 1,
            rawProjectPath: "/one",
            errorClass: "unknown",
            failedAt: 1,
        });
        recordV22BackfillFailure(database, {
            tableName: "compartments",
            rowId: 2,
            rawProjectPath: "/two",
            errorClass: "git_missing",
            failedAt: 2,
        });

        expect(listV22BackfillFailures(database)).toHaveLength(2);
        expect(deleteV22BackfillFailure(database, "memories", 1)).toBe(true);
        expect(clearV22BackfillFailures(database)).toBe(1);
        expect(listV22BackfillFailures(database)).toEqual([]);
    });

    test("records dubious ownership as unknown without violating the check constraint", () => {
        const database = makeDb();

        const row = recordV22BackfillFailure(database, {
            tableName: "memories",
            rowId: 7,
            rawProjectPath: "/dubious",
            errorClass: "dubious_ownership",
            errorMessage: "git detected dubious ownership",
            failedAt: 30,
        });

        expect(row.errorClass).toBe("unknown");
        expect(row.errorMessage).toBe("git detected dubious ownership");
        expect(getV22BackfillFailure(database, "memories", 7)?.errorClass).toBe("unknown");
    });
});
