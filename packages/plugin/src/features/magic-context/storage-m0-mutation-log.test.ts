import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearM0MutationsForSession,
    deleteM0Mutation,
    getM0MutationsAfterId,
    getM0MutationsBySession,
    getMaxM0MutationId,
    queueM0Mutation,
} from "./storage-m0-mutation-log";
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

describe("storage-m0-mutation-log", () => {
    test("queues and lists session-scoped m0 mutations in id order", () => {
        const database = makeDb();
        const first = queueM0Mutation(database, {
            sessionId: "ses-1",
            mutationType: "compartment_delete",
            targetId: 10,
            queuedAt: 100,
        });
        const second = queueM0Mutation(database, {
            sessionId: "ses-1",
            mutationType: "compartment_merge",
            targetId: null,
            queuedAt: 200,
        });
        queueM0Mutation(database, {
            sessionId: "ses-2",
            mutationType: "compartment_upgrade",
            targetId: 99,
            queuedAt: 300,
        });

        expect(getM0MutationsBySession(database, "ses-1")).toEqual([first, second]);
        expect(getM0MutationsAfterId(database, "ses-1", first.id)).toEqual([second]);
        expect(getMaxM0MutationId(database, "ses-1")).toBe(second.id);
    });

    test("deletes single rows and clears a session", () => {
        const database = makeDb();
        const first = queueM0Mutation(database, {
            sessionId: "ses-1",
            mutationType: "recomp_boundary_change",
            queuedAt: 100,
        });
        queueM0Mutation(database, {
            sessionId: "ses-1",
            mutationType: "compartment_upgrade",
            queuedAt: 200,
        });

        expect(deleteM0Mutation(database, first.id)).toBe(true);
        expect(clearM0MutationsForSession(database, "ses-1")).toBe(1);
        expect(getM0MutationsBySession(database, "ses-1")).toEqual([]);
    });
});
