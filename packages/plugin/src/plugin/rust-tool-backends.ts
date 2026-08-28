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

export function toolCallIdFromContext(context: unknown): string | undefined {
    if (context === null || typeof context !== "object") return undefined;
    const record = context as Record<string, unknown>;
    for (const field of [
        "callID",
        "callId",
        "toolUseId",
        "toolCallId",
        "tool_use_id",
        "tool_call_id",
    ]) {
        const value = record[field];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
}

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

export function isRustAuthorityDrainingError(error: unknown): boolean {
    let current = error;
    for (let depth = 0; depth < 3; depth += 1) {
        if (!current || typeof current !== "object") break;
        const record = current as {
            code?: unknown;
            cause?: unknown;
            error?: unknown;
            result?: unknown;
        };
        if (record.code === "authority_draining") return true;
        current = record.cause ?? record.error ?? record.result;
    }
    return error instanceof Error && error.message.includes("authority_draining");
}
