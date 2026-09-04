export type RustAuthorityDomain = "memories" | "notes";
export type RustAuthorityState = "TS" | "PREPARING" | "MODULE" | "DRAINING";
export interface RustNoteToolRequest {
    /** Host MCP tool-use id; absent only for legacy THALAMUS callers. */
    commandId?: string;
    sessionId: string;
    projectRoot: string;
    projectPath: string;
    /** MC identity; projectRoot stays transport-only. */
    memoryProject: string;
    action: "write" | "read" | "update" | "dismiss";
    content?: string;
    surfaceCondition?: string;
    compiledProvider?: string | null;
    compiledConfig?: string | null;
    compiledAt?: number | null;
    compileStatus?: "compiled" | "plain" | "refused";
    filter?: "all" | "active" | "pending" | "ready" | "dismissed";
    limit?: number;
    offset?: number;
    noteId?: number;
}
export interface RustMemoryToolRequest {
    commandId: string;
    sessionId: string;
    projectRoot: string;
    projectPath: string;
    producer: string;
    operationKey: string;
    intentRequest: unknown;
    commitContext: () => {
        response: string;
        producer: string;
        operationKey: string;
        requestDigest: string;
        resultJson: string;
    };
}
export declare function toolCallIdFromContext(context: unknown): string | undefined;
export interface RustToolBackends {
    reduce?: (args: {
        sessionId: string;
        projectRoot: string;
        drop: string;
        commandId: string;
    }) => Promise<unknown>;
    authorityState?: (args: {
        projectPath: string;
        projectRoot: string;
        domain: RustAuthorityDomain;
    }) => Promise<RustAuthorityState | null>;
    /** Route ctx_note only after notes authority reports MODULE. */
    note?: (args: RustNoteToolRequest) => Promise<unknown>;
    /** Route ctx_memory only after memories authority reports MODULE. */
    memory?: (args: RustMemoryToolRequest) => Promise<string>;
    /** Smart-note writes fail closed when the host evaluator cannot send note.evaluate for this project. */
    noteEvaluationAvailable?: (projectPath: string) => boolean;
}
export declare function isRustAuthorityDrainingError(error: unknown): boolean;
//# sourceMappingURL=rust-tool-backends.d.ts.map