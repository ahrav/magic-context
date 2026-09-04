import type { SmartNoteCapabilityApi, SmartNoteCapabilityFactory } from "./capabilities";
import { type SmartNoteCheckResult } from "./types";
export interface RunCompiledSmartNoteCheckOptions {
    compiledCheck: string;
    capabilities?: SmartNoteCapabilityApi;
    capabilityFactory?: SmartNoteCapabilityFactory;
    signal?: AbortSignal;
    timeoutMs?: number;
    heapLimitBytes?: number;
    stackLimitBytes?: number;
}
export interface RunCompiledSmartNoteCheckSuccess {
    ok: true;
    result: SmartNoteCheckResult;
}
export interface RunCompiledSmartNoteCheckFailure {
    ok: false;
    cancelled: false;
    error: string;
    network: boolean;
}
export interface RunCompiledSmartNoteCheckCancelled {
    ok: false;
    cancelled: true;
    error: string;
    network: false;
}
export type RunCompiledSmartNoteCheckResult = RunCompiledSmartNoteCheckSuccess | RunCompiledSmartNoteCheckFailure | RunCompiledSmartNoteCheckCancelled;
export declare function runCompiledSmartNoteCheck(options: RunCompiledSmartNoteCheckOptions): Promise<RunCompiledSmartNoteCheckResult>;
//# sourceMappingURL=sandbox-runner.d.ts.map