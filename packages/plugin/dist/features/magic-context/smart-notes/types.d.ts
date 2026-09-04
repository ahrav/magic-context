import type { Note } from "../storage-notes";
export declare const SMART_NOTE_CHECK_POLICY_VERSION = 1;
export declare const SMART_NOTE_CHECK_FLOOR_MS: number;
export declare const SMART_NOTE_CHECK_CEILING_MS: number;
export declare const SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS: number;
export declare const SMART_NOTE_CHECK_MAX_STALENESS_MS: number;
export declare const SMART_NOTE_CHECK_LIVENESS_RECHECK_MS: number;
export type SmartNoteCapabilityName = "readFile" | "gitHeadSha" | "gitTag" | "gitLog" | "httpGet";
export type SmartNoteCheckStatus = "uncompiled" | "compiled" | "failing" | "fallback";
export interface SmartNoteCheckManifest {
    capabilities: SmartNoteCapabilityName[];
    readFiles?: string[];
    hosts?: string[];
    urls?: string[];
    signals?: string[];
    summary?: string;
}
export interface SmartNoteCheckNote extends Note {
    compiledCheck: string | null;
    manifestJson: string | null;
    checkHash: string | null;
    checkCron: string | null;
    checkVersion: number | null;
    checkStatus: SmartNoteCheckStatus;
    checkFailureCount: number;
    checkNetworkFailureCount: number;
    checkQuarantinedUntil: number | null;
    checkNextDueAt: number | null;
    checkCompiledAt: number | null;
    checkFalseSinceAt: number | null;
    checkLastLivenessAt: number | null;
    policyVersion: number;
}
export interface SmartNoteCheckResult {
    met: boolean;
}
export interface SmartNoteNetworkErrorOptions {
    terminal?: boolean;
}
export declare class SmartNoteNetworkError extends Error {
    readonly isSmartNoteNetworkError = true;
    readonly terminal: boolean;
    constructor(message: string, options?: SmartNoteNetworkErrorOptions);
}
export declare class SmartNoteSecurityError extends Error {
    readonly isSmartNoteSecurityError = true;
    constructor(message: string);
}
export declare function isSmartNoteNetworkError(error: unknown): boolean;
export declare function isTerminalSmartNoteNetworkError(error: unknown): error is SmartNoteNetworkError;
export declare function parseSmartNoteManifest(json: string | null): SmartNoteCheckManifest;
//# sourceMappingURL=types.d.ts.map