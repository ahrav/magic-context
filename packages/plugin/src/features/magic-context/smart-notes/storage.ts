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
    // BEGIN IMMEDIATE, not a plain (deferred) transaction: the lease check reads
    // before the write, and a deferred read→write lock upgrade returns
    // SQLITE_BUSY immediately when another writer holds the lock — busy_timeout
    // does not apply to upgrades, so concurrent processes produced spurious
    // "database is locked" failures here. Taking the write lock at BEGIN time
    // waits under busy_timeout like every other writer.
    db.exec("BEGIN IMMEDIATE");
    let leaseLost = false;
    let committed = false;
    try {
        // State transitions surface notes or change future scheduling. The lease
        // check and compare-and-set guard share the write transaction so neither
        // ownership nor the user's source state can change before the update.
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
        } catch {
            // Connection-level failures leave nothing to roll back.
        }
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
 * Pending notes eligible for phase selection. A retina handoff skips notes it
 * already compiled. Mirrors `eligible` in the Rust port
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
