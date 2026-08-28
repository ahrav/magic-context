/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { acquireCompartmentLease } from "./compartment-lease";
import {
    getCompartments,
    getSessionFacts,
    promoteRecompStaging,
    replaceAllCompartmentState,
    replaceAllCompartmentStateAndBumpDepth,
    saveRecompStagingPass,
} from "./compartment-storage";
import {
    getAverageCompressionDepth,
    getIncrementDepthStatement,
} from "./compression-depth-storage";
import { createDirectTestDatabase } from "./test-database";

function makeDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

const compartment = (sequence: number, start: number, end: number, title = `c${sequence}`) => ({
    sequence,
    startMessage: start,
    endMessage: end,
    startMessageId: `m-${start}`,
    endMessageId: `m-${end}`,
    title,
    content: `content ${sequence}`,
});

describe("atomic compartment state publish", () => {
    it("replaces compartments/facts and bumps the selected depth range atomically", () => {
        const db = makeDb();
        const sessionId = "ses-atomic";
        const holderId = "holder";
        expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();

        const ok = replaceAllCompartmentStateAndBumpDepth(
            db,
            holderId,
            sessionId,
            [compartment(0, 1, 2), compartment(1, 3, 4)],
            [{ category: "Fact", content: "fresh" }],
            2,
            3,
        );

        expect(ok).toBe(true);
        expect(getCompartments(db, sessionId).map((c) => c.title)).toEqual(["c0", "c1"]);
        expect(getSessionFacts(db, sessionId).map((f) => f.content)).toEqual(["fresh"]);
        expect(getAverageCompressionDepth(db, sessionId, 1, 1)).toBe(0);
        expect(getAverageCompressionDepth(db, sessionId, 2, 3)).toBe(1);
        expect(getAverageCompressionDepth(db, sessionId, 4, 4)).toBe(0);
        closeQuietly(db);
    });

    it("aborts on holder mismatch before deleting old state", () => {
        const db = makeDb();
        const sessionId = "ses-mismatch";
        replaceAllCompartmentState(
            db,
            sessionId,
            [compartment(0, 1, 2, "old")],
            [{ category: "Fact", content: "old fact" }],
        );
        expect(acquireCompartmentLease(db, sessionId, "holder-a")).not.toBeNull();

        const ok = replaceAllCompartmentStateAndBumpDepth(
            db,
            "holder-b",
            sessionId,
            [compartment(0, 1, 2, "new")],
            [{ category: "Fact", content: "new fact" }],
            1,
            2,
        );

        expect(ok).toBe(false);
        expect(getCompartments(db, sessionId).map((c) => c.title)).toEqual(["old"]);
        expect(getSessionFacts(db, sessionId).map((f) => f.content)).toEqual(["old fact"]);
        expect(getAverageCompressionDepth(db, sessionId, 1, 2)).toBe(0);
        closeQuietly(db);
    });

    it("reuses the cached increment-depth statement and increments exact ordinals", () => {
        const db = makeDb();
        const sessionId = "ses-depth";
        const holderId = "holder";
        expect(getIncrementDepthStatement(db)).toBe(getIncrementDepthStatement(db));
        expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();

        expect(
            replaceAllCompartmentStateAndBumpDepth(
                db,
                holderId,
                sessionId,
                [compartment(0, 1, 5)],
                [],
                2,
                4,
            ),
        ).toBe(true);

        expect(getAverageCompressionDepth(db, sessionId, 1, 1)).toBe(0);
        expect(getAverageCompressionDepth(db, sessionId, 2, 4)).toBe(1);
        expect(getAverageCompressionDepth(db, sessionId, 5, 5)).toBe(0);
        closeQuietly(db);
    });

    it("promoteRecompStaging respects lease holder and preserves old state on stale holder", () => {
        const db = makeDb();
        const sessionId = "ses-promote";
        replaceAllCompartmentState(db, sessionId, [compartment(0, 1, 2, "old")], []);
        saveRecompStagingPass(
            db,
            sessionId,
            1,
            [compartment(0, 1, 2, "new")],
            [{ category: "Fact", content: "new fact" }],
        );
        expect(acquireCompartmentLease(db, sessionId, "holder-a")).not.toBeNull();

        expect(promoteRecompStaging(db, sessionId, "holder-b")).toBeNull();
        expect(getCompartments(db, sessionId).map((c) => c.title)).toEqual(["old"]);

        const promoted = promoteRecompStaging(db, sessionId, "holder-a");
        expect(promoted?.compartments.map((c) => c.title)).toEqual(["new"]);
        expect(getCompartments(db, sessionId).map((c) => c.title)).toEqual(["new"]);
        closeQuietly(db);
    });
});
