import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import {
    captureSlot,
    dropSlot,
    getSlot,
    type LkgEntryNote,
    type LkgSlot,
    lkgContentDigest,
    noteEntry,
} from "./lkg-slot";
import { assertOpenAiCompatAdjacency } from "./openai-compat-adjacency";
import type { MessageLike } from "./transform-operations";

export interface LkgModelKeys {
    modelKey: string | null;
    providerKey: string | null;
}

function canonicalLkgModelKeys(modelKey: string | null, providerKey: string | null): LkgModelKeys {
    const canonicalModelKey = modelKey ? piModelRefToCanonical(modelKey) : null;
    const slash = canonicalModelKey?.indexOf("/") ?? -1;
    return {
        modelKey: canonicalModelKey,
        providerKey:
            slash > 0 && canonicalModelKey ? canonicalModelKey.slice(0, slash) : providerKey,
    };
}

export function resolveLkgModelKeys(messages: MessageLike[]): LkgModelKeys {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info as Record<string, unknown> | undefined;
        const nested = info?.model;
        if (nested && typeof nested === "object") {
            const provider = (nested as Record<string, unknown>).providerID;
            const model = (nested as Record<string, unknown>).modelID;
            if (typeof provider === "string" && typeof model === "string") {
                return canonicalLkgModelKeys(`${provider}/${model}`, provider);
            }
        }
        const provider = info?.providerID;
        const model = info?.modelID;
        if (
            info?.role === "assistant" &&
            typeof provider === "string" &&
            typeof model === "string"
        ) {
            return canonicalLkgModelKeys(`${provider}/${model}`, provider);
        }
    }
    return { modelKey: null, providerKey: null };
}

export interface LkgEntryProjection {
    id: string | null;
    role: string | undefined;
    synthetic: boolean;
    timeCreated: number | null;
    finish: unknown;
    hasIncompleteTool: boolean;
    /* */
    contentDigest?: () => string | null;
}

export function projectLkgEntry(messages: MessageLike[]): LkgEntryProjection[] {
    return messages.map((message) => {
        const info = messageInfo(message);
        const time = info.time;
        const timeRecord =
            time && typeof time === "object" ? (time as Record<string, unknown>) : null;
        const timeCandidates = [
            timeRecord?.created,
            info.timeCreated,
            info.time_created,
            info.createdAt,
            info.created_at,
        ];
        let timeCreated: number | null = null;
        for (const value of timeCandidates) {
            if (typeof value === "number" && Number.isFinite(value)) {
                timeCreated = value;
                break;
            }
        }
        let hasIncompleteTool = false;
        for (const rawPart of messageParts(message)) {
            if (!rawPart || typeof rawPart !== "object") continue;
            const part = rawPart as Record<string, unknown>;
            if (part.type !== "tool" || part.providerExecuted === true) continue;
            const state = part.state;
            const status =
                state && typeof state === "object"
                    ? (state as Record<string, unknown>).status
                    : undefined;
            if (status !== "completed") {
                hasIncompleteTool = true;
                break;
            }
        }
        const id = info.id;
        const projection: LkgEntryProjection = {
            id: typeof id === "string" && id.length > 0 ? id : null,
            role: typeof info.role === "string" ? info.role : undefined,
            synthetic: info.synthetic === true,
            timeCreated,
            finish: info.finish,
            hasIncompleteTool,
        };
        Object.defineProperty(projection, "contentDigest", {
            value: () => lkgContentDigest(message),
            enumerable: false,
        });
        return projection;
    });
}

export interface LkgCaptureInput {
    sessionId: string;
    input: LkgEntryProjection[] | MessageLike[];
    output: MessageLike[];
    modelKey: string | null;
    providerKey: string | null;
    capturedAt?: number;
}

export type LkgValidationFailure =
    | "lkg_model_mismatch"
    | "lkg_invalidated_reshape"
    | "lkg_content_mismatch"
    | "lkg_unsafe_seam"
    | "lkg_seam_invalid"
    | "lkg_anthropic_reasoning_run_invalid";

function recordValue(info: unknown, key: string): unknown {
    return info && typeof info === "object" ? (info as Record<string, unknown>)[key] : undefined;
}

function messageInfo(message: MessageLike): Record<string, unknown> {
    if (message.info && typeof message.info === "object")
        return message.info as Record<string, unknown>;
    return message as unknown as Record<string, unknown>;
}

function messageParts(message: MessageLike): unknown[] {
    return Array.isArray(message.parts) ? message.parts : [];
}

function isSynthetic(message: MessageLike): boolean {
    return recordValue(messageInfo(message), "synthetic") === true;
}

function hasSyntheticParts(message: MessageLike): boolean {
    const parts = messageParts(message);
    return (
        parts.length > 0 &&
        parts.every((part) => {
            return Boolean(
                part &&
                    typeof part === "object" &&
                    (part as Record<string, unknown>).synthetic === true,
            );
        })
    );
}

function isSyntheticOutput(message: MessageLike): boolean {
    return isSynthetic(message) || hasSyntheticParts(message);
}

function messageRole(message: MessageLike): string | undefined {
    const infoRole = recordValue(messageInfo(message), "role");
    if (typeof infoRole === "string") return infoRole;
    const role = recordValue(message, "role");
    return typeof role === "string" ? role : undefined;
}

function messageId(message: MessageLike): string | null {
    const id = recordValue(messageInfo(message), "id") ?? recordValue(message, "id");
    return typeof id === "string" && id.length > 0 ? id : null;
}

function latestAssistant(messages: LkgEntryProjection[]): LkgEntryProjection | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "assistant") return messages[index];
    }
    return null;
}

function isRealUser(message: LkgEntryProjection): boolean {
    return message.role === "user" && !message.synthetic && message.id !== null;
}

function assistantIsActive(message: LkgEntryProjection): boolean {
    return message.finish === "tool-calls" || message.hasIncompleteTool;
}

function findLkgAnchor(messages: LkgEntryProjection[]): number | null {
    const assistant = latestAssistant(messages);
    const assistantTime = assistant?.timeCreated ?? null;
    if (assistant && assistantTime === null) return null;
    let anchor = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRealUser(message)) continue;
        if (assistant && assistantIsActive(assistant)) {
            if (
                assistantTime === null ||
                message.timeCreated === null ||
                message.timeCreated <= assistantTime
            ) {
                continue;
            }
        }
        anchor = index;
        break;
    }
    return anchor >= 0 ? anchor : null;
}

function asEntryProjection(input: LkgEntryProjection[] | MessageLike[]): LkgEntryProjection[] {
    if (input.length === 0 || "hasIncompleteTool" in (input[0] as object)) {
        return input as LkgEntryProjection[];
    }
    return projectLkgEntry(input as MessageLike[]);
}

function outputMessageIsPostAnchor(
    message: MessageLike,
    inputIndexById: Map<string, number>,
    anchorIndex: number,
): boolean | null {
    const id = messageId(message);
    if (id !== null) {
        const inputIndex = inputIndexById.get(id);
        if (inputIndex !== undefined) return inputIndex > anchorIndex;
        if (!isSyntheticOutput(message)) return null;
        const linked = ["sourceMessageId", "ownerMessageId", "anchorMessageId", "messageId"]
            .map((key) => recordValue(messageInfo(message), key))
            .find((value) => typeof value === "string");
        if (typeof linked === "string") {
            const linkedIndex = inputIndexById.get(linked);
            if (linkedIndex === undefined) return null;
            return linkedIndex > anchorIndex;
        }
        return false;
    }
    if (!isSyntheticOutput(message)) return null;
    const linked = ["sourceMessageId", "ownerMessageId", "anchorMessageId"]
        .map((key) => recordValue(message.info, key))
        .find((value) => typeof value === "string");
    if (typeof linked !== "string") return false;
    const linkedIndex = inputIndexById.get(linked);
    return linkedIndex === undefined ? null : linkedIndex > anchorIndex;
}

/**
 */
export function buildLkgPrefix(
    input: LkgEntryProjection[] | MessageLike[],
    output: MessageLike[],
): {
    anchorIndex: number;
    anchorMessageId: string;
    inputIdSeq: string[];
    inputContentDigests: string[];
    jsonPrefix: string;
} | null {
    const projected = asEntryProjection(input);
    const anchorIndex = findLkgAnchor(projected);
    if (anchorIndex === null) return null;
    const ids = projected.map((message) => message.id);
    if (ids.some((id) => id === null)) return null;
    const validIds = ids as string[];
    if (new Set(validIds).size !== validIds.length) return null;
    const anchorMessageId = validIds[anchorIndex];
    const inputContentDigests = projected
        .slice(0, anchorIndex + 1)
        .map((message) => message.contentDigest?.() ?? null);
    if (inputContentDigests.some((digest) => digest === null)) return null;
    const inputIndexById = new Map(validIds.map((id, index) => [id, index]));
    const prefix: MessageLike[] = [];
    for (const message of output) {
        const postAnchor = outputMessageIsPostAnchor(message, inputIndexById, anchorIndex);
        if (postAnchor === null) return null;
        if (!postAnchor) prefix.push(message);
    }
    let jsonPrefix: string;
    try {
        jsonPrefix = JSON.stringify(prefix);
        if (typeof jsonPrefix !== "string") return null;
    } catch {
        return null;
    }
    return {
        anchorIndex,
        anchorMessageId,
        inputIdSeq: validIds.slice(0, anchorIndex + 1),
        inputContentDigests: inputContentDigests as string[],
        jsonPrefix,
    };
}

export function captureLkgSlot(args: LkgCaptureInput): boolean {
    const built = buildLkgPrefix(args.input, args.output);
    if (!built) return false;
    const modelKeys = canonicalLkgModelKeys(args.modelKey, args.providerKey);
    return captureSlot(args.sessionId, {
        jsonPrefix: built.jsonPrefix,
        inputIdSeq: built.inputIdSeq,
        inputContentDigests: built.inputContentDigests,
        lastInputMessageId: built.anchorMessageId,
        modelKey: modelKeys.modelKey,
        providerKey: modelKeys.providerKey,
        capturedAt: args.capturedAt ?? Date.now(),
    });
}

function entryIdsAreValid(slot: LkgSlot, entryIds: string[]): boolean {
    if (slot.inputIdSeq.length === 0 || entryIds.length < slot.inputIdSeq.length) return false;
    if (slot.inputIdSeq[slot.inputIdSeq.length - 1] !== slot.lastInputMessageId) return false;
    const seen = new Set<string>();
    for (const id of entryIds) {
        if (!id || seen.has(id)) return false;
        seen.add(id);
    }
    if (entryIds.indexOf(slot.lastInputMessageId) !== slot.inputIdSeq.length - 1) return false;
    for (let index = 0; index < slot.inputIdSeq.length; index += 1) {
        if (entryIds[index] !== slot.inputIdSeq[index]) return false;
    }
    return true;
}

function entryContentIsValid(slot: LkgSlot, entryDigests: string[]): boolean {
    return (
        entryDigests.length >= slot.inputContentDigests.length &&
        slot.inputContentDigests.every((digest, index) => entryDigests[index] === digest)
    );
}

function partCallIds(message: MessageLike): string[] {
    const ids: string[] = [];
    for (const rawPart of messageParts(message)) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as Record<string, unknown>;
        if (part.type !== "tool" && part.type !== "tool_use") continue;
        const callId = part.callID ?? part.callId ?? part.id;
        if (typeof callId === "string" && callId.length > 0) ids.push(callId);
    }
    return ids;
}

function partResultIds(message: MessageLike): string[] {
    const ids: string[] = [];
    for (const rawPart of messageParts(message)) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as Record<string, unknown>;
        if (part.type !== "tool_result" && part.type !== "tool-result") continue;
        const callId = part.tool_call_id ?? part.tool_use_id ?? part.callID ?? part.callId;
        if (typeof callId === "string" && callId.length > 0) ids.push(callId);
    }
    return ids;
}

function partIsReasoning(part: unknown): boolean {
    return Boolean(
        part && typeof part === "object" && (part as Record<string, unknown>).type === "reasoning",
    );
}

function partIsAnthropicThinking(part: unknown): boolean {
    if (!part || typeof part !== "object") return false;
    const type = (part as Record<string, unknown>).type;
    return type === "thinking" || type === "reasoning" || type === "redacted_thinking";
}

function partEndsAnthropicAssistantRun(part: unknown): boolean {
    if (!part || typeof part !== "object") return false;
    const value = part as Record<string, unknown>;
    if (
        value.type !== "tool" ||
        value.providerExecuted === true ||
        !value.state ||
        typeof value.state !== "object"
    ) {
        return false;
    }
    const status = (value.state as Record<string, unknown>).status;
    return status === "completed" || status === "error";
}

function partIsOpenCodeStepMetadata(part: unknown): boolean {
    if (!part || typeof part !== "object") return false;
    const type = (part as Record<string, unknown>).type;
    return type === "step-start" || type === "step-finish";
}

/**
 */
export function validateAnthropicReasoningRuns(messages: MessageLike[]): boolean {
    let index = 0;
    while (index < messages.length) {
        if (messageRole(messages[index]) !== "assistant") {
            index += 1;
            continue;
        }
        let thinkingBlocks = 0;
        let sawOtherContent = false;
        while (index < messages.length && messageRole(messages[index]) === "assistant") {
            for (const part of messageParts(messages[index])) {
                if (partIsAnthropicThinking(part)) {
                    thinkingBlocks += 1;
                    if (thinkingBlocks > 1 || sawOtherContent) return false;
                } else if (partEndsAnthropicAssistantRun(part)) {
                    thinkingBlocks = 0;
                    sawOtherContent = false;
                } else if (!partIsOpenCodeStepMetadata(part)) {
                    sawOtherContent = true;
                }
            }
            index += 1;
        }
    }
    return true;
}

function validateLkgSeamBoundary(prefix: MessageLike[], tail: MessageLike[]): boolean {
    const last = prefix[prefix.length - 1];
    const first = tail[0];
    if (!last || !first) return true;
    const lastCalls = partCallIds(last);
    if (lastCalls.length === 0) return true;
    const firstCalls = new Set([...partCallIds(first), ...partResultIds(first)]);
    if (messageRole(first) === "tool" || lastCalls.some((callId) => firstCalls.has(callId)))
        return false;
    return !messageParts(last).some((part) => {
        if (!part || typeof part !== "object") return false;
        const value = part as Record<string, unknown>;
        if (value.type !== "tool") return false;
        const state = value.state;
        return (
            !state ||
            typeof state !== "object" ||
            (state as Record<string, unknown>).status !== "completed"
        );
    });
}

export function validateLkgSeam(
    prefix: MessageLike[],
    tail: MessageLike[],
    providerKey: string | null,
): boolean {
    const all = [...prefix, ...tail];
    const ids = new Set<string>();
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const message of all) {
        const id = messageId(message);
        if (id !== null) {
            if (ids.has(id)) return false;
            ids.add(id);
        }
        for (const callId of partCallIds(message)) {
            if (calls.has(callId)) return false;
            calls.add(callId);
        }
        for (const callId of partResultIds(message)) {
            if (results.has(callId)) return false;
            results.add(callId);
        }
        if (messageRole(message) !== "assistant" && messageParts(message).some(partIsReasoning))
            return false;
        if (
            providerKey !== "anthropic" &&
            messageParts(message).some((part) => {
                if (!part || typeof part !== "object") return false;
                const value = part as Record<string, unknown>;
                return (value.type === "text" || value.type === "reasoning") && value.text === "";
            })
        )
            return false;
    }
    if (!validateLkgSeamBoundary(prefix, tail)) return false;
    const wireCandidates = all.map((message) => message as unknown as { role: string });
    if (wireCandidates.every((message) => typeof message.role === "string")) {
        const adjacency = assertOpenAiCompatAdjacency(wireCandidates);
        if (!adjacency.ok) return false;
        const wireCallIds = new Set<string>();
        for (const wireMessage of wireCandidates) {
            for (const call of (wireMessage as { tool_calls?: Array<{ id: string }> }).tool_calls ??
                []) {
                if (wireCallIds.has(call.id)) return false;
                wireCallIds.add(call.id);
            }
        }
    }
    return true;
}

export function replayLkg(args: {
    sessionId: string;
    messages: MessageLike[];
    modelKey: string | null;
    providerKey: string | null;
    entry?: LkgEntryNote | null;
    skipSeamValidation?: boolean;
}): { ok: true; messages: MessageLike[] } | { ok: false; reason: LkgValidationFailure } {
    const slot = getSlot(args.sessionId);
    if (!slot) return { ok: false, reason: "lkg_invalidated_reshape" };
    const requestedModelKeys = canonicalLkgModelKeys(args.modelKey, args.providerKey);
    const capturedModelKeys = canonicalLkgModelKeys(slot.modelKey, slot.providerKey);
    if (
        capturedModelKeys.modelKey !== requestedModelKeys.modelKey ||
        capturedModelKeys.providerKey !== requestedModelKeys.providerKey
    ) {
        dropSlot(args.sessionId, "lkg_model_mismatch");
        return { ok: false, reason: "lkg_model_mismatch" };
    }
    const entry = args.entry ?? noteEntry(args.sessionId, args.messages);
    if (
        !entry ||
        entry.anchorIndex !== slot.inputIdSeq.length - 1 ||
        !entryIdsAreValid(slot, entry.entryInputIds)
    ) {
        dropSlot(args.sessionId, "lkg_invalidated_reshape");
        return { ok: false, reason: "lkg_invalidated_reshape" };
    }
    if (!entryContentIsValid(slot, entry.entryContentDigests)) {
        dropSlot(args.sessionId, "lkg_content_mismatch");
        return { ok: false, reason: "lkg_content_mismatch" };
    }
    let prefix: MessageLike[];
    try {
        const parsed = JSON.parse(slot.jsonPrefix) as unknown;
        if (!Array.isArray(parsed)) throw new Error("prefix is not an array");
        prefix = parsed as MessageLike[];
    } catch {
        dropSlot(args.sessionId, "lkg_seam_invalid");
        return { ok: false, reason: "lkg_seam_invalid" };
    }
    if (!args.skipSeamValidation) {
        if (!validateLkgSeamBoundary(prefix, entry.pristineTail)) {
            dropSlot(args.sessionId, "lkg_unsafe_seam");
            return { ok: false, reason: "lkg_unsafe_seam" };
        }
        if (!validateLkgSeam(prefix, entry.pristineTail, requestedModelKeys.providerKey)) {
            dropSlot(args.sessionId, "lkg_seam_invalid");
            return { ok: false, reason: "lkg_seam_invalid" };
        }
    }
    const replayed = [...prefix, ...entry.pristineTail];
    if (
        requestedModelKeys.providerKey === "anthropic" &&
        !validateAnthropicReasoningRuns(replayed)
    ) {
        dropSlot(args.sessionId, "lkg_anthropic_reasoning_run_invalid");
        return { ok: false, reason: "lkg_anthropic_reasoning_run_invalid" };
    }
    return { ok: true, messages: replayed };
}

export function validateLkgEntry(slot: LkgSlot, entryIds: string[]): boolean {
    return entryIdsAreValid(slot, entryIds);
}
