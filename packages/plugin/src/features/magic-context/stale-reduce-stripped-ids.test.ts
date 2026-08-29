/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../../shared/sqlite";
import { addStaleReduceStrippedIds, getStaleReduceStrippedIds } from "./storage-meta-persisted";
import { createDirectTestDatabase } from "./test-database";

function createTestDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

describe("stale_reduce_stripped_ids (frozen replay watermark)", () => {
    let db: Database;
    const ses = "ses-stale-reduce";

    beforeEach(() => {
        db = createTestDb();
    });

    it("returns an empty set for a session with no frozen ids", () => {
        expect(getStaleReduceStrippedIds(db, ses)).toEqual(new Set());
    });

    it("adds ids onto an empty (null) row", () => {
        expect(addStaleReduceStrippedIds(db, ses, ["reduce-1", "reduce-2"])).toBe(true);
        expect(getStaleReduceStrippedIds(db, ses)).toEqual(new Set(["reduce-1", "reduce-2"]));
    });

    it("merges new ids onto an existing set without clobbering (monotonic growth)", () => {
        addStaleReduceStrippedIds(db, ses, ["reduce-1"]);
        addStaleReduceStrippedIds(db, ses, ["reduce-2", "reduce-3"]);
        expect(getStaleReduceStrippedIds(db, ses)).toEqual(
            new Set(["reduce-1", "reduce-2", "reduce-3"]),
        );
    });

    it("is a no-op (returns true) when all ids are already present", () => {
        addStaleReduceStrippedIds(db, ses, ["reduce-1"]);
        expect(addStaleReduceStrippedIds(db, ses, ["reduce-1"])).toBe(true);
        expect(getStaleReduceStrippedIds(db, ses)).toEqual(new Set(["reduce-1"]));
    });

    it("is a no-op (returns true) for an empty add", () => {
        expect(addStaleReduceStrippedIds(db, ses, [])).toBe(true);
        expect(getStaleReduceStrippedIds(db, ses)).toEqual(new Set());
    });

    it("keeps sessions isolated", () => {
        addStaleReduceStrippedIds(db, "ses-a", ["a-1"]);
        addStaleReduceStrippedIds(db, "ses-b", ["b-1"]);
        expect(getStaleReduceStrippedIds(db, "ses-a")).toEqual(new Set(["a-1"]));
        expect(getStaleReduceStrippedIds(db, "ses-b")).toEqual(new Set(["b-1"]));
    });
});
