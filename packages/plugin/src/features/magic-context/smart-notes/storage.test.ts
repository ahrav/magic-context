/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { evaluateSmartNotes } from "../dreamer/evaluate-smart-notes";
import { acquireLease } from "../dreamer/lease";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { addNote, dismissNote, getNotes, getPendingSmartNotes, updateNote } from "../storage-notes";
import {
    applySmartNoteReduction,
    lifecycleStateFromNote,
    reduceSmartNoteEvaluation,
} from "./evaluation-state";
import { runDueCompiledSmartNoteChecks } from "./runner";
import {
    commitSmartNoteState,
    getFallbackSmartNotes,
    getSmartNotesNeedingCompilation,
    smartNoteCommitExpectation,
} from "./storage";
import { SMART_NOTE_CHECK_POLICY_VERSION } from "./types";

const PROJECT = "git:test";
const tempDirs: string[] = [];

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function tempProject(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-smart-note-storage-"));
    tempDirs.push(dir);
    return dir;
}

function setCheckColumns(db: Database, noteId: number, columns: Record<string, unknown>): void {
    const entries = Object.entries(columns);
    db.prepare(
        `UPDATE notes SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`,
    ).run(...entries.map(([, value]) => value), noteId);
}

function compileArtifactReduction(db: Database, noteId: number, met: boolean) {
    const note = getPendingSmartNotes(db, PROJECT).find((candidate) => candidate.id === noteId);
    if (!note) throw new Error(`note #${noteId} is not pending`);
    return reduceSmartNoteEvaluation(
        lifecycleStateFromNote({ ...note, checkStatus: note.checkStatus ?? "uncompiled" }),
        {
            phase: "compile",
            kind: met ? "compiled_met" : "compiled_false",
            artifact: {
                compiledCheck: "function check() { return { met: false }; }",
                manifestJson: JSON.stringify({ capabilities: [] }),
                checkHash: "hash",
                checkCron: "* * * * *",
            },
        },
        { noteId, now: Date.now() },
    );
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

describe("smart-note compilation selection", () => {
    test("honors check_next_due_at backoff before recompiling notes", () => {
        const db = freshDb();
        try {
            const now = 10_000;
            const due = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "due",
                surfaceCondition: "compile now",
            });
            const backedOff = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "backoff",
                surfaceCondition: "compile later",
            });
            setCheckColumns(db, due.id, { check_next_due_at: now - 1 });
            setCheckColumns(db, backedOff.id, { check_next_due_at: now + 60_000 });

            expect(getSmartNotesNeedingCompilation(db, PROJECT, now, 10).map((n) => n.id)).toEqual([
                due.id,
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("fallback selection returns only pending fallback notes", () => {
        const db = freshDb();
        try {
            const fallback = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "fallback",
                surfaceCondition: "condition",
            });
            const plain = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "plain",
                surfaceCondition: "condition",
            });
            setCheckColumns(db, fallback.id, {
                check_status: "fallback",
                check_failure_count: 3,
            });
            expect(getFallbackSmartNotes(db, PROJECT, 3).map((n) => n.id)).toEqual([fallback.id]);
            expect(plain.id).not.toBe(fallback.id);
        } finally {
            closeQuietly(db);
        }
    });

    test("fallback selection orders unchecked, then oldest last_checked_at, then id", () => {
        const db = freshDb();
        try {
            const seed = (content: string) =>
                addNote(db, "smart", {
                    projectPath: PROJECT,
                    content,
                    surfaceCondition: "condition",
                });
            const recentlyChecked = seed("recently checked");
            const unchecked = seed("unchecked");
            const oldestChecked = seed("oldest checked");
            const tiedWithOldest = seed("tied with oldest");
            const stage = (id: number, lastCheckedAt: number | null) =>
                setCheckColumns(db, id, {
                    check_status: "fallback",
                    check_failure_count: 3,
                    last_checked_at: lastCheckedAt,
                });
            stage(recentlyChecked.id, 9_000);
            stage(unchecked.id, null);
            stage(oldestChecked.id, 5_000);
            stage(tiedWithOldest.id, 5_000);

            expect(getFallbackSmartNotes(db, PROJECT, 10).map((n) => n.id)).toEqual([
                unchecked.id,
                oldestChecked.id,
                tiedWithOldest.id,
                recentlyChecked.id,
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("evaluateSmartNotes lease guard", () => {
    test("skips authoring-compiled notes only when retina handoff is enabled", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "retina owns this condition",
                surfaceCondition: "when path /tmp/result exists",
                compiledProvider: "local-fs",
                compiledConfig: JSON.stringify({ kind: "path_exists", path: "/tmp/result" }),
                compiledAt: Date.now(),
                compileStatus: "compiled",
            });

            expect(getSmartNotesNeedingCompilation(db, PROJECT, Date.now(), 10)).toHaveLength(1);
            expect(getSmartNotesNeedingCompilation(db, PROJECT, Date.now(), 10, true)).toHaveLength(
                0,
            );
            await expect(
                evaluateSmartNotes({
                    db,
                    client: {} as never,
                    projectIdentity: PROJECT,
                    parentSessionId: undefined,
                    sessionDirectory: tempProject(),
                    holderId: "no-lease-needed",
                    leaseKey: "smart-note-retina-handoff",
                    deadline: Date.now() + 60_000,
                    retinaHandoff: true,
                }),
            ).resolves.toEqual({ surfaced: 0, pending: 0, ran: false });
            expect(getNotes(db, { projectPath: PROJECT, type: "smart" })[0]?.id).toBe(note.id);
        } finally {
            closeQuietly(db);
        }
    });

    test("does not commit due-check results after the lease is lost", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "ready when check passes",
                surfaceCondition: "test condition",
            });
            setCheckColumns(db, note.id, {
                compiled_check: "function check() { return { met: true }; }",
                manifest_json: JSON.stringify({ capabilities: [], summary: "test" }),
                check_hash: "hash",
                check_cron: "* * * * *",
                check_version: 1,
                check_status: "compiled",
                check_next_due_at: 0,
                policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
            });
            expect(acquireLease(db, "other-holder", "smart-note-lease")).toBe(true);

            await expect(
                evaluateSmartNotes({
                    db,
                    client: {} as never,
                    projectIdentity: PROJECT,
                    parentSessionId: undefined,
                    sessionDirectory: tempProject(),
                    holderId: "missing-holder",
                    leaseKey: "smart-note-lease",
                    deadline: Date.now() + 60_000,
                }),
            ).rejects.toThrow("Dream lease lost");

            expect(getPendingSmartNotes(db, PROJECT).map((n) => [n.id, n.status])).toEqual([
                [note.id, "pending"],
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("smart-note state compare-and-set", () => {
    test("a dismissal during compilation cannot resurrect the note", () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                sessionId: "session",
                content: "compile me",
                surfaceCondition: "when ready",
            });
            const expected = smartNoteCommitExpectation(note);
            const reduction = compileArtifactReduction(db, note.id, true);
            expect(dismissNote(db, note.id, { sessionId: "session", projectPath: PROJECT })).toBe(
                true,
            );

            const committed = commitSmartNoteState(db, {
                phase: "compile",
                expected,
                write: () => applySmartNoteReduction(db, note.id, reduction),
            });

            expect(committed).toBe(false);
            const current = getNotes(db, { type: "smart", status: "dismissed" })[0];
            expect(current.status).toBe("dismissed");
            expect(current.compiledCheck).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("a condition edit discards a stale compiled-check result", () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                sessionId: "session",
                content: "watch condition",
                surfaceCondition: "old condition",
            });
            setCheckColumns(db, note.id, {
                compiled_check: "function check() { return { met: false }; }",
                check_hash: "old-hash",
                check_compiled_at: 123,
                check_status: "compiled",
                policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
            });
            const selected = getPendingSmartNotes(db, PROJECT)[0];
            expect(
                updateNote(
                    db,
                    note.id,
                    { surfaceCondition: "new condition" },
                    { sessionId: "session", projectPath: PROJECT },
                ),
            ).not.toBeNull();

            const committed = commitSmartNoteState(db, {
                phase: "due check",
                expected: smartNoteCommitExpectation(selected),
                write: () => {
                    throw new Error("stale write must not run");
                },
            });

            expect(committed).toBe(false);
            const current = getPendingSmartNotes(db, PROJECT)[0];
            expect(current.surfaceCondition).toBe("new condition");
            expect(current.lastCheckedAt).toBeNull();
            expect(current.checkStatus).toBe("uncompiled");
        } finally {
            closeQuietly(db);
        }
    });

    test("commits when the claimed revisions are unchanged", () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "normal",
                surfaceCondition: "normal condition",
            });
            const reduction = compileArtifactReduction(db, note.id, false);
            const committed = commitSmartNoteState(db, {
                phase: "compile",
                expected: smartNoteCommitExpectation(note),
                write: () => applySmartNoteReduction(db, note.id, reduction),
            });

            expect(committed).toBe(true);
            const current = getPendingSmartNotes(db, PROJECT)[0];
            expect(current.checkStatus).toBe("compiled");
            expect(current.stateVersion).toBe(note.stateVersion + 1);
            expect(current.sourceRevision).toBe(note.sourceRevision);
        } finally {
            closeQuietly(db);
        }
    });

    test("an interleaved lifecycle transition discards the second commit", () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "raced",
                surfaceCondition: "condition",
            });
            const expected = smartNoteCommitExpectation(note);
            const first = compileArtifactReduction(db, note.id, false);
            expect(
                commitSmartNoteState(db, {
                    phase: "compile",
                    expected,
                    write: () => applySmartNoteReduction(db, note.id, first),
                }),
            ).toBe(true);

            expect(
                commitSmartNoteState(db, {
                    phase: "compile replay",
                    expected,
                    write: () => {
                        throw new Error("stale write must not run");
                    },
                }),
            ).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("smart-note cancellation health policy", () => {
    test("pre-aborted due checks leave note health unchanged", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "cancelled",
                surfaceCondition: "later",
            });
            setCheckColumns(db, note.id, {
                compiled_check: "function check() { return { met: true }; }",
                check_hash: "hash",
                check_cron: "* * * * *",
                check_status: "compiled",
                check_next_due_at: 0,
                policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
            });
            const controller = new AbortController();
            controller.abort(new Error("lease expired"));

            const result = await runDueCompiledSmartNoteChecks({
                db,
                projectIdentity: PROJECT,
                projectRoot: tempProject(),
                signal: controller.signal,
            });

            expect(result).toEqual({ ran: 1, surfaced: 0, failed: 0, networkFailed: 0 });
            const current = getPendingSmartNotes(db, PROJECT)[0];
            expect(current.checkFailureCount).toBe(0);
            expect(current.checkNetworkFailureCount).toBe(0);
            expect(current.status).toBe("pending");
        } finally {
            closeQuietly(db);
        }
    });

    test("a sandbox execution timeout still increments logic health", async () => {
        const db = freshDb();
        try {
            const note = addNote(db, "smart", {
                projectPath: PROJECT,
                content: "timeout",
                surfaceCondition: "later",
            });
            setCheckColumns(db, note.id, {
                compiled_check: "function check() { while (true) {} }",
                check_hash: "hash",
                check_cron: "* * * * *",
                check_status: "compiled",
                check_next_due_at: 0,
                policy_version: SMART_NOTE_CHECK_POLICY_VERSION,
            });

            const result = await runDueCompiledSmartNoteChecks({
                db,
                projectIdentity: PROJECT,
                projectRoot: tempProject(),
                sweepBudgetMs: 5_000,
            });

            expect(result.failed).toBe(1);
            expect(getPendingSmartNotes(db, PROJECT)[0].checkFailureCount).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});
