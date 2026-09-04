import type { SubagentKind } from "../../features/magic-context/storage-subagent-invocations";
import type { PluginContext } from "../../plugin/types";
import type { Database } from "../../shared/sqlite";
import type { HistorianProgressCallbacks, StoredCompartmentRange, ValidatedHistorianPassResult } from "./compartment-runner-types";
import { type HistorianValidationChunk } from "./compartment-runner-validation";
/**
 * Read reasoning only for the historian after the normal text extractor found no text.
 * Historian output still passes the compartment parser and validator before publication;
 * shared extractors remain text-only so fail-closed dreamer manifest parsers never accept
 * a model's private reasoning as normal task output.
 *
 * Exported so the historian eval lane's replay runner captures the same
 * artifact production validated (a reasoning-only payload must yield the same
 * text) instead of maintaining a second extractor.
 */
export declare function extractLatestHistorianReasoning(messages: unknown): string | null;
export declare function runValidatedHistorianPass(args: {
    client: PluginContext["client"];
    db: Database;
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    chunk: HistorianValidationChunk;
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    dumpLabelBase: string;
    timeoutMs?: number;
    fallbackModelId?: string;
    /**
     * Resolved historian fallback chain ("provider/modelID" entries). When the
     * primary historian model fails (auth, model-not-found, transient network),
     * each fallback is tried in order. Independent of `fallbackModelId` (which
     * is a last-ditch single-model retry against the active session model).
     */
    fallbackModels?: readonly string[];
    callbacks?: HistorianProgressCallbacks;
    responseDumpObserver?: (dumpPath: string) => void;
    /** When true, run a second editor pass after successful historian output
     *  to clean low-signal U: lines and cross-compartment duplicates. If editor
     *  validation fails, falls back to the draft (first-pass) result. */
    twoPass?: boolean;
    subagentKind?: SubagentKind;
    agentId?: string;
    language?: string;
}): Promise<ValidatedHistorianPassResult>;
//# sourceMappingURL=compartment-runner-historian.d.ts.map