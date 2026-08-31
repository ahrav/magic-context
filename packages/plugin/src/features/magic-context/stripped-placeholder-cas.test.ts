/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../../shared/sqlite";
import {
    applyStrippedPlaceholderDelta,
    getStrippedPlaceholderIds,
    removeStrippedPlaceholderId,
    setStrippedPlaceholderIds,
} from "./storage-meta-persisted";
import { createDirectTestDatabase } from "./test-database";

function createTestDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

describe("applyStrippedPlaceholderDelta (CAS)", () => {
    let db: Database;
    const ses = "ses-cas";

    beforeEach(() => {
        db = createTestDb();
    });

    it("adds ids onto an empty (null) row", () => {
        expect(applyStrippedPlaceholderDelta(db, ses, { add: ["a", "b"] })).toBe(true);
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["a", "b"]));
    });

    it("merges an add-delta onto an existing set without clobbering", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a"]));
        applyStrippedPlaceholderDelta(db, ses, { add: ["b", "c"] });
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["a", "b", "c"]));
    });

    it("removes ids and leaves the rest", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a", "b", "c"]));
        applyStrippedPlaceholderDelta(db, ses, { remove: ["b"] });
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["a", "c"]));
    });

    it("applies add+remove in one call", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a", "b"]));
        applyStrippedPlaceholderDelta(db, ses, { add: ["c"], remove: ["a"] });
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["b", "c"]));
    });

    it("empties the row when all ids removed", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a"]));
        applyStrippedPlaceholderDelta(db, ses, { remove: ["a"] });
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set());
    });

    it("is a no-op for an empty delta", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a"]));
        expect(applyStrippedPlaceholderDelta(db, ses, {})).toBe(true);
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["a"]));
    });

    it("removeStrippedPlaceholderId returns false when id absent, true when present", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a"]));
        expect(removeStrippedPlaceholderId(db, ses, "zzz")).toBe(false);
        expect(removeStrippedPlaceholderId(db, ses, "a")).toBe(true);
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set());
    });

    it("merge semantics: a stale-read add does not undo a concurrent remove", () => {
        // The CAS applies an add delta without restoring IDs removed after the caller read the set.
        setStrippedPlaceholderIds(db, ses, new Set(["a", "b"]));
        applyStrippedPlaceholderDelta(db, ses, { remove: ["a"] });
        applyStrippedPlaceholderDelta(db, ses, { add: ["c"] });
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["b", "c"]));
    });
});
