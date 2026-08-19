/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { addNote, getNotes } from "../storage-notes";
import { evaluateSmartNotes } from "./evaluate-smart-notes";
import { acquireLease } from "./lease";

const PROJECT = "git:evaluate-smart-notes-test";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function heldLeaseArgs(db: Database) {
    const holderId = "test-holder";
    const leaseKey = "evaluate-smart-notes-test-lease";
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return { holderId, leaseKey };
}

describe("evaluateSmartNotes file-authority phases", () => {
    test("a failed compilation commits a compile failure under the revision fence", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "compile me",
                surfaceCondition: "when the build passes",
            });
            const { holderId, leaseKey } = heldLeaseArgs(db);

            // A client whose session creation throws makes the no-tool
            // compiler fail without cancellation.
            const result = await evaluateSmartNotes({
                db,
                client: {} as never,
                projectIdentity: PROJECT,
                parentSessionId: undefined,
                sessionDirectory: undefined,
                holderId,
                leaseKey,
                deadline: Date.now() + 30_000,
            });

            expect(result.ran).toBe(true);
            expect(result.surfaced).toBe(0);
            const current = getNotes(db, { type: "smart" })[0];
            expect(current.checkFailureCount).toBe(1);
            expect(current.checkStatus).toBe("uncompiled");
            expect(current.checkNextDueAt).toBeGreaterThan(Date.now());
            expect(current.stateVersion).toBe(note.stateVersion + 1);
            expect(current.sourceRevision).toBe(note.sourceRevision);
        } finally {
            closeQuietly(db);
        }
    });

    test("a failed fallback confirmation keeps the note in fallback", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "fallback note",
                surfaceCondition: "when the moon is full",
            });
            db.prepare(
                `UPDATE notes SET check_status = 'fallback', check_failure_count = 3,
                    check_next_due_at = ? WHERE id = ?`,
            ).run(Date.now() + 3_600_000, note.id);
            const { holderId, leaseKey } = heldLeaseArgs(db);

            const result = await evaluateSmartNotes({
                db,
                client: {} as never,
                projectIdentity: PROJECT,
                parentSessionId: undefined,
                sessionDirectory: undefined,
                holderId,
                leaseKey,
                deadline: Date.now() + 30_000,
            });

            expect(result.surfaced).toBe(0);
            const current = getNotes(db, { type: "smart" })[0];
            expect(current.status).toBe("pending");
            expect(current.checkStatus).toBe("fallback");
            expect(current.lastCheckedAt).not.toBeNull();
            expect(current.checkFailureCount).toBe(3);
        } finally {
            closeQuietly(db);
        }
    });

    test("third compilation failure enters fallback and runs fallback in the same pass", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "fails thrice",
                surfaceCondition: "when it compiles",
            });
            db.prepare("UPDATE notes SET check_failure_count = 2 WHERE id = ?").run(note.id);
            const { holderId, leaseKey } = heldLeaseArgs(db);

            const result = await evaluateSmartNotes({
                db,
                client: {} as never,
                projectIdentity: PROJECT,
                parentSessionId: undefined,
                sessionDirectory: undefined,
                holderId,
                leaseKey,
                deadline: Date.now() + 30_000,
            });

            expect(result.ran).toBe(true);
            const current = getNotes(db, { type: "smart" })[0];
            expect(current.checkStatus).toBe("fallback");
            expect(current.checkFailureCount).toBe(3);
            // The fallback confirmation also ran (and failed closed), so the
            // note was checked in the same pass.
            expect(current.lastCheckedAt).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
