/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    acquireWrapupInProgress,
    getWrapupInProgressState,
    isWrapupInProgress,
    releaseWrapupInProgress,
    updateWrapupInProgress,
    WRAPUP_IN_PROGRESS_TTL_MS,
} from "./storage-meta-persisted";
import { createDirectTestDatabase } from "./test-database";

function withDb(run: (db: Database) => void): void {
    const db = createDirectTestDatabase().db;
    try {
        run(db);
    } finally {
        closeQuietly(db);
    }
}

function marker(holderId: string) {
    return {
        holderId,
        messagesToKeep: 20,
        anchorRawMessageCount: 100,
        targetEligibleEndOrdinal: 80,
        lastCompartmentEnd: 10,
        chunkIndex: 0,
        expectedChunks: 3,
    };
}

describe("wrapup_in_progress marker", () => {
    test("rejects a second holder and releases only by the owner", () => {
        withDb((db) => {
            const first = acquireWrapupInProgress(db, "ses", marker("holder-a"), 1_000);
            expect(first.ok).toBe(true);

            const second = acquireWrapupInProgress(db, "ses", marker("holder-b"), 1_100);
            expect(second.ok).toBe(false);
            expect(second.state?.holderId).toBe("holder-a");
            expect(isWrapupInProgress(db, "ses", 1_100)).toBe(true);

            releaseWrapupInProgress(db, "ses", "holder-b");
            expect(isWrapupInProgress(db, "ses", 1_100)).toBe(true);

            releaseWrapupInProgress(db, "ses", "holder-a");
            expect(isWrapupInProgress(db, "ses", 1_100)).toBe(false);
        });
    });

    test("renews progress and reclaims stale markers", () => {
        withDb((db) => {
            expect(acquireWrapupInProgress(db, "ses", marker("holder-a"), 1_000).ok).toBe(true);
            const renewed = updateWrapupInProgress(
                db,
                "ses",
                "holder-a",
                { chunkIndex: 2, lastCompartmentEnd: 40 },
                2_000,
            );
            expect(renewed?.chunkIndex).toBe(2);
            expect(getWrapupInProgressState(db, "ses", 2_000)?.lastCompartmentEnd).toBe(40);

            const staleAt = 2_000 + WRAPUP_IN_PROGRESS_TTL_MS + 1;
            expect(getWrapupInProgressState(db, "ses", staleAt)).toBeNull();
            const next = acquireWrapupInProgress(db, "ses", marker("holder-b"), staleAt + 1);
            expect(next.ok).toBe(true);
            expect(next.state.holderId).toBe("holder-b");
        });
    });
});
