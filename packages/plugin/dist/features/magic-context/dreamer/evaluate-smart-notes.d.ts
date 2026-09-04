import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import { type LeaseAcquisition } from "./lease";
export interface EvaluateSmartNotesArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    holderId: string;
    /** Keyed lease this task holds (Dreamer v2: per-project evaluate-smart-notes domain). */
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    model?: string;
    fallbackModels?: readonly string[];
    /** When true, authoring-compiled provider conditions are owned by retina. */
    retinaHandoff?: boolean;
    onLeaseLost?: (phase: string, error?: unknown) => void;
}
export interface EvaluateSmartNotesResult {
    surfaced: number;
    pending: number;
    /** False when there were no pending notes requiring compile/fallback work. */
    ran: boolean;
}
/**
 * Compile and maintain smart-note checks. The legacy broad-tool agentic
 * evaluator is intentionally retired: this task uses a no-tool compiler agent,
 * runs code only in the QuickJS capability sandbox, and falls back to a no-tool
 * read-only confirmation prompt when compilation repeatedly fails.
 */
export declare function evaluateSmartNotes(args: EvaluateSmartNotesArgs): Promise<EvaluateSmartNotesResult>;
export interface ConfirmSmartNoteReadOnlyArgs {
    client: PluginContext["client"];
    db: Database;
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    projectIdentity: string;
    deadline: number;
    model?: string;
    fallbackModels?: readonly string[];
    noteId: number;
    content: string;
    surfaceCondition: string | null;
    signal: AbortSignal;
}
export declare function confirmSmartNoteReadOnly(args: ConfirmSmartNoteReadOnlyArgs): Promise<boolean | null>;
//# sourceMappingURL=evaluate-smart-notes.d.ts.map