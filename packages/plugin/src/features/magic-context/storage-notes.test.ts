/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    addNote,
    dismissNote,
    getNotes,
    markNoteChecked,
    markNoteReady,
    type Note,
    updateNote,
} from "./storage-notes";

const PROJECT = "/revision/project";
const SCOPE = { sessionId: "session", projectPath: PROJECT };

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function smartNote(db: Database, overrides: { content?: string; condition?: string } = {}): Note {
    return addNote(db, "smart", {
        projectPath: PROJECT,
        sessionId: "session",
        content: overrides.content ?? "note content",
        surfaceCondition: overrides.condition ?? "note condition",
    });
}

function currentNote(db: Database, id: number): Note {
    const note = getNotes(db, { type: "smart" }).find((candidate) => candidate.id === id);
    if (!note) throw new Error(`note #${id} missing`);
    return note;
}

function setCompiled(db: Database, noteId: number): void {
    db.prepare(
        `UPDATE notes SET compiled_check = 'function check() {}', manifest_json = '{}',
            check_hash = 'h', check_cron = '* * * * *', check_version = 1,
            check_status = 'compiled', check_failure_count = 2,
            check_network_failure_count = 1, check_next_due_at = 5,
            check_compiled_at = 6, check_false_since_at = 7 WHERE id = ?`,
    ).run(noteId);
}

describe("smart-note revision matrix: create", () => {
    test("initializes source and state revisions at the same value", () => {
        const db = freshDb();
        try {
            const note = smartNote(db);
            expect(note.sourceRevision).toBe(0);
            expect(note.stateVersion).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("smart-note revision matrix: compiler-input edits", () => {
    test("content edit advances both revisions and resets the check lifecycle", () => {
        const db = freshDb();
        try {
            const note = smartNote(db);
            setCompiled(db, note.id);
            const updated = updateNote(db, note.id, { content: "new content" }, SCOPE);
            expect(updated?.sourceRevision).toBe(note.sourceRevision + 1);
            expect(updated?.stateVersion).toBe(note.stateVersion + 1);
            expect(updated?.compiledCheck).toBeNull();
            expect(updated?.checkStatus).toBe("uncompiled");
            expect(updated?.checkFailureCount).toBe(0);
            expect(updated?.checkNetworkFailureCount).toBe(0);
            expect(updated?.status).toBe("pending");
        } finally {
            closeQuietly(db);
        }
    });

    test("condition edit advances both revisions and clears provider compile metadata", () => {
        const db = freshDb();
        try {
            const note = smartNote(db);
            setCompiled(db, note.id);
            const updated = updateNote(db, note.id, { surfaceCondition: "new condition" }, SCOPE);
            expect(updated?.sourceRevision).toBe(note.sourceRevision + 1);
            expect(updated?.stateVersion).toBe(note.stateVersion + 1);
            expect(updated?.compiledCheck).toBeNull();
            expect(updated?.compileStatus).toBeNull();
            expect(updated?.checkStatus).toBe("uncompiled");
        } finally {
            closeQuietly(db);
        }
    });

    test("project move advances both revisions, resets checks, keeps condition metadata", () => {
        const db = freshDb();
        try {
            const note = smartNote(db);
            setCompiled(db, note.id);
            db.prepare("UPDATE notes SET compile_status = 'plain' WHERE id = ?").run(note.id);
            const updated = updateNote(db, note.id, { projectPath: "/other/project" }, SCOPE);
            expect(updated?.sourceRevision).toBe(note.sourceRevision + 1);
            expect(updated?.stateVersion).toBe(note.stateVersion + 1);
            expect(updated?.compiledCheck).toBeNull();
            expect(updated?.checkStatus).toBe("uncompiled");
            expect(updated?.compileStatus).toBe("plain");
        } finally {
            closeQuietly(db);
        }
    });

    test("same-value writes do not advance source_revision", () => {
        const db = freshDb();
        try {
            const note = smartNote(db, { content: "same", condition: "cond" });
            const updated = updateNote(
                db,
                note.id,
                { content: "same", surfaceCondition: "cond", projectPath: PROJECT },
                SCOPE,
            );
            expect(updated?.sourceRevision).toBe(note.sourceRevision);
            expect(updated?.stateVersion).toBe(note.stateVersion + 1);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("smart-note revision matrix: state-only transitions", () => {
    test("status update advances only state_version and keeps the artifact", () => {
        const db = freshDb();
        try {
            const note = smartNote(db);
            setCompiled(db, note.id);
            const before = currentNote(db, note.id);
            const updated = updateNote(db, note.id, { status: "ready" }, SCOPE);
            expect(updated?.sourceRevision).toBe(before.sourceRevision);
            expect(updated?.stateVersion).toBe(before.stateVersion + 1);
            expect(updated?.compiledCheck).toBe(before.compiledCheck);
            expect(updated?.checkStatus).toBe("compiled");
        } finally {
            closeQuietly(db);
        }
    });

    test("markNoteReady and markNoteChecked advance only state_version", () => {
        const db = freshDb();
        try {
            const note = smartNote(db);
            setCompiled(db, note.id);
            markNoteReady(db, note.id, "reason");
            let current = currentNote(db, note.id);
            expect(current.sourceRevision).toBe(note.sourceRevision);
            expect(current.stateVersion).toBe(note.stateVersion + 1);
            expect(current.compiledCheck).not.toBeNull();

            markNoteChecked(db, note.id);
            current = currentNote(db, note.id);
            expect(current.stateVersion).toBe(note.stateVersion + 2);
            expect(current.sourceRevision).toBe(note.sourceRevision);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("smart-note revision matrix: dismissal", () => {
    test("dismissal advances only state_version and keeps compiler inputs", () => {
        const db = freshDb();
        try {
            const note = smartNote(db);
            setCompiled(db, note.id);
            expect(dismissNote(db, note.id, SCOPE)).toBe(true);
            const current = getNotes(db, { type: "smart", status: "dismissed" })[0];
            expect(current.sourceRevision).toBe(note.sourceRevision);
            expect(current.stateVersion).toBe(note.stateVersion + 1);
            expect(current.content).toBe(note.content);
            expect(current.compiledCheck).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
