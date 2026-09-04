import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import type { SmartNoteCapabilityFactory } from "./capabilities";
import { type SmartNoteCheckManifest, type SmartNoteCheckResult } from "./types";
interface CompileSmartNoteArgs {
    client: PluginContext["client"];
    db?: Database;
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    projectIdentity: string;
    note: {
        id: number;
        content: string;
        surfaceCondition: string | null;
    };
    capabilityFactory: SmartNoteCapabilityFactory;
    signal: AbortSignal;
    deadline: number;
    model?: string;
    fallbackModels?: readonly string[];
}
export interface CompileSmartNoteSuccess {
    ok: true;
    compiledCheck: string;
    manifest: SmartNoteCheckManifest;
    checkCron: string;
    checkHash: string;
    dryRun: SmartNoteCheckResult;
}
export interface CompileSmartNoteFailure {
    ok: false;
    cancelled: boolean;
    error: string;
}
export type CompileSmartNoteResult = CompileSmartNoteSuccess | CompileSmartNoteFailure;
interface CompilerResponse {
    compiled_check: string;
    manifest: SmartNoteCheckManifest;
    check_cron: string;
}
export declare function compileSmartNoteCheck(args: CompileSmartNoteArgs): Promise<CompileSmartNoteResult>;
export declare function parseCompilerOutput(output: string | null): CompilerResponse;
export declare function normalizeCompiledCheck(source: string): string;
export declare function normalizeManifest(manifest: SmartNoteCheckManifest): SmartNoteCheckManifest;
/**
 * Best-effort manifest drift notes for audit visibility only. Runtime guards in
 * the capability implementations are the security boundary; this check must not
 * accept or reject code.
 */
export declare function manifestAdvisoryWarnings(code: string, manifest: SmartNoteCheckManifest): string[];
export declare function hashCheck(surfaceCondition: string | null, compiledCheck: string, manifest: SmartNoteCheckManifest, checkCron: string): string;
export declare function normalizeCron(cron: string): string;
export {};
//# sourceMappingURL=compiler.d.ts.map