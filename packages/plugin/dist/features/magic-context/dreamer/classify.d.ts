import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import type { ProjectMemoryClaimSnapshot } from "../memory/storage-claim-current-state";
import { type LeaseAcquisition } from "./lease";
/**
 * Mirrors `MAX_CLASSIFY_PROMPT_BYTES` in `crates/mc-module/src/classify.rs`:
 * `dreamer.run_task` refuses a longer `prompt_body` with `payload_too_large`
 * before any producer run. A rejected prompt is rebuilt identically on every
 * scheduled pass, so chunks must be bounded by rendered bytes as well as entry
 * count — a 100-entry bound alone lets content-heavy claims exceed the cap and
 * never classify on any run.
 */
export declare const MAX_CLASSIFY_PROMPT_BYTES: number;
export interface ClassifyModuleCallArgs {
    sessionId: string;
    projectRoot: string;
    method: string;
    body: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface ClassifyModuleClient {
    call(args: ClassifyModuleCallArgs): Promise<unknown>;
}
export interface ClassifyArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    model?: string;
    fallbackModels?: readonly string[];
    /** Ordered classify model chain (task override → dreamer default → fallbacks)
     *  the module route sends verbatim; the TypeScript provider path keeps using
     *  model/fallbackModels instead. The dreamer-level default reaches classify
     *  only through this chain, so dropping it silently removes that rung. */
    modelChain?: readonly string[];
    moduleClient?: ClassifyModuleClient;
    moduleSessionId?: string;
    moduleProjectRoot?: string;
    moduleContextStoreUuid?: string;
    moduleAuthorityGeneration?: number;
    moduleCommandId?: string;
    onProgress?: (processed: number) => void;
}
export interface ClassifyResult {
    classified: number;
    changed: number;
    chunks: number;
    stage: 1 | 2 | 3;
    remaining: number;
    complete: boolean;
}
export declare function runClassify(args: ClassifyArgs): Promise<ClassifyResult>;
export declare function applyClassifications(args: ClassifyArgs, chunk: ProjectMemoryClaimSnapshot[], manifestText: string): {
    classified: number;
    changed: number;
};
//# sourceMappingURL=classify.d.ts.map