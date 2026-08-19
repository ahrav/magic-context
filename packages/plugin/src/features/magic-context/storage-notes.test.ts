/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

    test("project move clears a Retina compilation so the note is recompiled", () => {
        const db = freshDb();
        try {
            const note = smartNote(db);
            setCompiled(db, note.id);
            db.prepare(
                `UPDATE notes SET compile_status = 'compiled', compiled_provider = 'local-fs',
                    compiled_config = '{"path":"src/main.rs"}', compiled_at = 8 WHERE id = ?`,
            ).run(note.id);
            const updated = updateNote(db, note.id, { projectPath: "/other/project" }, SCOPE);
            expect(updated?.compileStatus).toBeNull();
            expect(updated?.compiledProvider).toBeNull();
            expect(updated?.compiledConfig).toBeNull();
            expect(updated?.compiledAt).toBeNull();
            expect(updated?.checkStatus).toBe("uncompiled");
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

interface NormativeCase {
    id: string;
    event: string;
    pre: { source_revision?: number; state_version?: number } | null;
    expected: { source_revision: number; state_version: number; artifact_cleared?: boolean };
}

const normative = JSON.parse(
    readFileSync(
        join(
            import.meta.dir,
            "../../../../../crates/mc-module/testdata/smart-note-evaluation-normative.json",
        ),
        "utf8",
    ),
) as { revision_matrix_cases: NormativeCase[] };

describe("smart-note revision matrix: normative fixture replay", () => {
    // Fixture cases use different absolute pre-states; compare revision
    // deltas instead.
    for (const matrixCase of normative.revision_matrix_cases) {
        if (
            matrixCase.event === "migrate" ||
            matrixCase.event === "authority_transfer" ||
            matrixCase.event === "create"
        ) {
            continue;
        }
        test(`replays ${matrixCase.id}`, () => {
            const db = freshDb();
            try {
                const note = smartNote(db);
                setCompiled(db, note.id);
                const before = currentNote(db, note.id);
                if (matrixCase.event === "edit_compiler_input") {
                    updateNote(
                        db,
                        note.id,
                        matrixCase.id === "edit_condition"
                            ? { surfaceCondition: "changed condition" }
                            : { content: "changed content" },
                        SCOPE,
                    );
                } else if (matrixCase.event === "dismiss") {
                    expect(dismissNote(db, note.id, SCOPE)).toBe(true);
                } else {
                    markNoteChecked(db, note.id);
                }
                const after = getNotes(db, { type: "smart" }).find(
                    (candidate) => candidate.id === note.id,
                );
                if (!after) throw new Error("note vanished");
                const pre = matrixCase.pre ?? { source_revision: 0, state_version: 0 };
                expect(after.sourceRevision - before.sourceRevision).toBe(
                    matrixCase.expected.source_revision - (pre.source_revision ?? 0),
                );
                expect(after.stateVersion - before.stateVersion).toBe(
                    matrixCase.expected.state_version - (pre.state_version ?? 0),
                );
                if (matrixCase.expected.artifact_cleared !== undefined) {
                    expect(after.compiledCheck === null).toBe(matrixCase.expected.artifact_cleared);
                }
            } finally {
                closeQuietly(db);
            }
        });
    }
});
