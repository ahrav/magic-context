import type { Database } from "../../../shared/sqlite";
import { type SmartNoteCheckNote } from "./types";
export interface SmartNoteCommitExpectation {
    noteId: number;
    sourceRevision: number;
    stateVersion: number;
}
export declare function smartNoteCommitExpectation(note: Pick<SmartNoteCheckNote, "id" | "sourceRevision" | "stateVersion">): SmartNoteCommitExpectation;
export declare function commitSmartNoteState(db: Database, args: {
    phase: string;
    expected: SmartNoteCommitExpectation;
    leaseHeld?: () => boolean;
    write: () => void;
}): boolean;
export declare function getDueCompiledSmartNoteChecks(db: Database, projectPath: string, now: number, limit: number, retinaHandoff?: boolean): SmartNoteCheckNote[];
export declare function getSmartNotesNeedingCompilation(db: Database, projectPath: string, now: number, limit: number, retinaHandoff?: boolean): SmartNoteCheckNote[];
export declare function getStaleCompiledSmartNotes(db: Database, projectPath: string, now: number, limit: number, retinaHandoff?: boolean): SmartNoteCheckNote[];
export declare function getFallbackSmartNotes(db: Database, projectPath: string, limit: number, retinaHandoff?: boolean): SmartNoteCheckNote[];
//# sourceMappingURL=storage.d.ts.map