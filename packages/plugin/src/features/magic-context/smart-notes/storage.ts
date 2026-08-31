import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { getPendingSmartNotes, type Note } from "../storage-notes";
import {
    SMART_NOTE_CHECK_LIVENESS_RECHECK_MS,
    SMART_NOTE_CHECK_MAX_STALENESS_MS,
    SMART_NOTE_CHECK_POLICY_VERSION,
    type SmartNoteCheckNote,
} from "./types";

function toSmartNote(note: Note): SmartNoteCheckNote {
    return {
        ...note,
        checkStatus: note.checkStatus ?? "uncompiled",
        checkFailureCount: note.checkFailureCount ?? 0,
        checkNetworkFailureCount: note.checkNetworkFailureCount ?? 0,
        policyVersion: note.policyVersion ?? 0,
    };
}

export interface SmartNoteCommitExpectation {
    noteId: number;
    sourceRevision: number;
    stateVersion: number;
}

export function smartNoteCommitExpectation(
    note: Pick<SmartNoteCheckNote, "id" | "sourceRevision" | "stateVersion">,
): SmartNoteCommitExpectation {
    return {
        noteId: note.id,
        sourceRevision: note.sourceRevision,
        stateVersion: note.stateVersion,
    };
}

export function commitSmartNoteState(
    db: Database,
    args: {
        phase: string;
        expected: SmartNoteCommitExpectation;
        leaseHeld?: () => boolean;
        write: () => void;
    },
): boolean {
    // BEGIN IMMEDIATE acquires the write lock before the lease check, so busy_timeout applies when another writer holds it.
    // A deferred transaction upgrades from a read lock only when it writes; another writer can cause that upgrade to return SQLITE_BUSY without waiting under busy_timeout.
    db.exec("BEGIN IMMEDIATE");
    let leaseLost = false;
    let committed = false;
    try {
        // The transaction makes `claimExpectedState` and `args.write` atomic with respect to the matching note state.
        if (args.leaseHeld && !args.leaseHeld()) {
            leaseLost = true;
        } else if (claimExpectedState(db, args.expected)) {
            args.write();
            committed = true;
        }
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {}
        throw error;
    }
    if (leaseLost) {
        throw new Error(`Dream lease lost during smart-note ${args.phase} commit`);
    }
    if (!committed) {
        log(`[debug] smart note #${args.expected.noteId}: discarded stale ${args.phase} result`);
    }
    return committed;
}

function claimExpectedState(db: Database, expected: SmartNoteCommitExpectation): boolean {
    return (
        db
            .prepare(
                `UPDATE notes SET id = id
                 WHERE id = ? AND type = 'smart' AND status = 'pending'
                   AND source_revision = ? AND state_version = ?`,
            )
            .run(expected.noteId, expected.sourceRevision, expected.stateVersion).changes > 0
    );
}

/**
 * (crates/mc-module/src/smart_note_evaluation.rs).
 */
function eligibleSmartNotes(
    db: Database,
    projectPath: string,
    retinaHandoff: boolean,
): SmartNoteCheckNote[] {
    return getPendingSmartNotes(db, projectPath)
        .filter((note) => !retinaHandoff || note.compileStatus !== "compiled")
        .map(toSmartNote);
}

export function getDueCompiledSmartNoteChecks(
    db: Database,
    projectPath: string,
    now: number,
    limit: number,
    retinaHandoff = false,
): SmartNoteCheckNote[] {
    return eligibleSmartNotes(db, projectPath, retinaHandoff)
        .filter(
            (note) =>
                note.checkStatus === "compiled" &&
                note.compiledCheck !== null &&
                note.policyVersion === SMART_NOTE_CHECK_POLICY_VERSION &&
                (note.checkQuarantinedUntil === null || note.checkQuarantinedUntil <= now) &&
                (note.checkNextDueAt === null || note.checkNextDueAt <= now),
        )
        .sort((a, b) => (a.checkNextDueAt ?? 0) - (b.checkNextDueAt ?? 0) || a.id - b.id)
        .slice(0, Math.max(1, limit));
}

export function getSmartNotesNeedingCompilation(
    db: Database,
    projectPath: string,
    now: number,
    limit: number,
    retinaHandoff = false,
): SmartNoteCheckNote[] {
    return eligibleSmartNotes(db, projectPath, retinaHandoff)
        .filter(
            (note) =>
                (note.checkNextDueAt === null || note.checkNextDueAt <= now) &&
                (note.checkStatus === "uncompiled" ||
                    note.checkStatus === "failing" ||
                    note.compiledCheck === null ||
                    note.policyVersion !== SMART_NOTE_CHECK_POLICY_VERSION),
        )
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
        .slice(0, Math.max(1, limit));
}

export function getStaleCompiledSmartNotes(
    db: Database,
    projectPath: string,
    now: number,
    limit: number,
    retinaHandoff = false,
): SmartNoteCheckNote[] {
    const staleBefore = now - SMART_NOTE_CHECK_MAX_STALENESS_MS;
    const livenessBefore = now - SMART_NOTE_CHECK_LIVENESS_RECHECK_MS;
    return eligibleSmartNotes(db, projectPath, retinaHandoff)
        .filter(
            (note) =>
                note.checkStatus === "compiled" &&
                note.compiledCheck !== null &&
                note.policyVersion === SMART_NOTE_CHECK_POLICY_VERSION &&
                note.checkFalseSinceAt !== null &&
                note.checkFalseSinceAt <= staleBefore &&
                (note.checkLastLivenessAt === null || note.checkLastLivenessAt <= livenessBefore),
        )
        .sort((a, b) => (a.checkFalseSinceAt ?? 0) - (b.checkFalseSinceAt ?? 0) || a.id - b.id)
        .slice(0, Math.max(1, limit));
}

export function getFallbackSmartNotes(
    db: Database,
    projectPath: string,
    limit: number,
    retinaHandoff = false,
): SmartNoteCheckNote[] {
    return eligibleSmartNotes(db, projectPath, retinaHandoff)
        .filter((note) => note.checkStatus === "fallback")
        .sort(
            (a, b) =>
                Number(a.lastCheckedAt !== null) - Number(b.lastCheckedAt !== null) ||
                (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0) ||
                a.id - b.id,
        )
        .slice(0, Math.max(1, limit));
}
