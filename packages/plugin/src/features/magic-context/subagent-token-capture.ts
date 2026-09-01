import { describeError } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    recordSubagentInvocation,
    type SubagentInvocationStatus,
    type SubagentKind,
} from "./storage-subagent-invocations";

export interface TokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface LastAssistantModel {
    providerId: string | null;
    modelId: string | null;
}

export interface ChildInvocationRecordInput {
    db: Database | null;
    parentSessionId: string;
    harness: "opencode" | "pi";
    subagent: SubagentKind;
    startedAt: number;
    endedAt?: number;
    status: SubagentInvocationStatus;
    task?: string | null;
    messages?: unknown[];
    tokens?: TokenTotals;
    providerId?: string | null;
    modelId?: string | null;
    error?: unknown;
    parentInvocationId?: number | null;
}

function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokenObjectFromMessage(message: Record<string, unknown>): Record<string, unknown> | null {
    const info = message.info;
    if (info && typeof info === "object") {
        const tokens = (info as Record<string, unknown>).tokens;
        if (tokens && typeof tokens === "object") return tokens as Record<string, unknown>;
    }
    const tokens = message.tokens;
    if (tokens && typeof tokens === "object") return tokens as Record<string, unknown>;
    return null;
}

function isAssistantMessage(message: unknown): message is Record<string, unknown> {
    if (!message || typeof message !== "object") return false;
    const record = message as Record<string, unknown>;
    const info = record.info;
    if (info && typeof info === "object") {
        return (info as Record<string, unknown>).role === "assistant";
    }
    return record.role === "assistant";
}

function modelFromMessage(message: Record<string, unknown>): LastAssistantModel {
    const info = message.info;
    const source = info && typeof info === "object" ? (info as Record<string, unknown>) : message;
    return {
        providerId:
            typeof source.providerID === "string"
                ? source.providerID
                : typeof source.providerId === "string"
                  ? source.providerId
                  : null,
        modelId:
            typeof source.modelID === "string"
                ? source.modelID
                : typeof source.modelId === "string"
                  ? source.modelId
                  : null,
    };
}

export function emptyTokenTotals(): TokenTotals {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function sumTokensFromChildMessages(messages: unknown[]): TokenTotals {
    const totals = emptyTokenTotals();
    for (const message of messages) {
        if (!isAssistantMessage(message)) continue;
        const tokens = tokenObjectFromMessage(message);
        if (!tokens) continue;
        const cache =
            tokens.cache && typeof tokens.cache === "object"
                ? (tokens.cache as Record<string, unknown>)
                : {};
        totals.input += asNumber(tokens.input);
        totals.output += asNumber(tokens.output);
        totals.cacheRead += asNumber(cache.read ?? tokens.cacheRead ?? tokens.cache_read);
        totals.cacheWrite += asNumber(cache.write ?? tokens.cacheWrite ?? tokens.cache_write);
    }
    return totals;
}

export function findLastAssistantModel(messages: unknown[]): LastAssistantModel {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (isAssistantMessage(message)) return modelFromMessage(message);
    }
    return { providerId: null, modelId: null };
}

export function recordChildInvocation(input: ChildInvocationRecordInput): number | null {
    if (!input.db) return null;
    const tokens = input.tokens ?? sumTokensFromChildMessages(input.messages ?? []);
    const model =
        input.providerId !== undefined || input.modelId !== undefined
            ? { providerId: input.providerId ?? null, modelId: input.modelId ?? null }
            : findLastAssistantModel(input.messages ?? []);
    try {
        return recordSubagentInvocation(input.db, {
            sessionId: input.parentSessionId,
            harness: input.harness,
            subagent: input.subagent,
            task: input.task ?? null,
            providerId: model.providerId,
            modelId: model.modelId,
            startedAt: input.startedAt,
            endedAt: input.endedAt ?? Date.now(),
            status: input.status,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheReadTokens: tokens.cacheRead,
            cacheWriteTokens: tokens.cacheWrite,
            error: input.error ? describeError(input.error).brief : null,
            parentInvocationId: input.parentInvocationId ?? null,
        });
    } catch (error) {
        sessionLog(
            input.parentSessionId,
            "subagent token accounting failed:",
            describeError(error).brief,
        );
        return null;
    }
}
