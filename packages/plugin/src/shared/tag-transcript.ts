/**
 * This module tags `Transcript` parts without a harness-specific message type.
 *
 *
 * Source-content persistence supports cross-pass detagging and restoration.
 * OpenCode indexes tool calls across separate `tool` and `tool_result` parts.
 * OpenCode tracks reasoning bytes for historian projection.
 * OpenCode resolves existing tags by content ID when no direct match exists.
 *
 * `pi.on("context", ...)` receives one complete transcript per LLM call.
 * A complete transcript per context event removes the need for cross-pass tagging state.
 *
 * Only `text`, `tool_use`, and `tool_result` parts are tag-eligible.
 * Each eligible visible text receives a `§N§ ` prefix unless tagging skips it.
 * A `TagTarget` lets `applyPendingOperations` replace the part with a sentinel when a queued drop fires.
 *
 * Tool drops aggregate by call_id across both invocation and result
 * A queued tool-tag drop replaces both the assistant `toolCall`/`tool_use` part and the user `toolResult`/`tool_result` part.
 * Aggregating both occurrences keeps the dropped tool state consistent.
 *
 * `byte_size` records only invocation args when `assignTag` assigns the invocation first and reuses its tag for the result.
 * `assignTag` leaves the invocation part in its original form.
 *
 *
 * Tagger stores assignments and allocates tags in the DB.
 */

import { createHash } from "node:crypto";
import type { ContextDatabase } from "../features/magic-context/storage";
import { saveSourceContent } from "../features/magic-context/storage-source";
import {
    updateTagByteSize,
    updateTagInputByteSize,
    updateTagInputTokenCount,
    updateTagTokenCount,
} from "../features/magic-context/storage-tags";
import { makeToolCompositeKey, type Tagger } from "../features/magic-context/tagger";
import { applyEditMarkerToInput } from "../hooks/magic-context/edit-marker";
import { estimateImageTokensFromDataUrl } from "../hooks/magic-context/image-token-estimate";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import {
    byteSize,
    prependTag,
    stripTagPrefix,
} from "../hooks/magic-context/tag-content-primitives";
import type { TagTarget } from "../hooks/magic-context/tag-messages";
import type { Transcript, TranscriptPart } from "./transcript";

export const TEXT_TAG_IDENTITY_MARKER = ":mc-text-v1:";

export interface TagTranscriptOptions {
    /**
     * `skipPrefixInjection` still assigns tags in the DB so historian and drops can reference them.
     * Sessions whose tool surface lacks `ctx_reduce` must set `skipPrefixInjection`, so the agent cannot act on markers.
     * `skipPrefixInjection` is fixed for each session.
     */
    skipPrefixInjection?: boolean;
    /**
     * Only Pi supplies raw-message fingerprints keyed by message ID.
     * A new text tag persists its message fingerprint on the tag row.
     * A later pass adopts a fallback-ID tag onto the real `SessionEntry` ID.
     * OpenCode omits fingerprints, so its tags store NULL and adoption never fires.
     * `entryFingerprintByMessageId` uses bare `messageId` keys, not `:pN` `contentId` keys.
     * `entryFingerprintByMessageId` uses bare `messageId` keys because all parts of a message share one fingerprint.
     */
    entryFingerprintByMessageId?: ReadonlyMap<string, string>;
    /**
     * `reuseMessageIds` contains stable Pi message IDs observed on a prior pass.
     * Immutable parts reuse tag assignments while the tagger reapplies visible prefixes.
     * The tagger rebuilds the complete set of messages affected by each tag.
     */
    reuseMessageIds?: ReadonlySet<string>;
    /**
     * `textIdentityDriftMessageIds` contains Pi message IDs whose persisted text-part vectors differ from the current vectors.
     * Parts of messages in `textIdentityDriftMessageIds` use content-derived identities instead of positional `:pN` keys.
     * Content-derived identities prevent sibling insertion or deletion from rebinding durable tags.
     */
    textIdentityDriftMessageIds?: ReadonlySet<string>;
    /** Pi's batched identity preflight shares `textIdentitySourceCache`. */
    textIdentitySourceCache?: Map<number, string>;
    /** Pi retains exact text/count pairs for safe lazy-token backfill reuse. */
    textTokenCache?: Map<string, { text: string; tokenCount: number }>;
    /** `toolTokenCache` retains exact tool-result text/count pairs under composite tag identities. */
    toolTokenCache?: Map<string, { text: string; tokenCount: number }>;
    /* */
    onTiming?: (
        phase: "identity" | "prefix" | "targets" | "tokenCounting",
        elapsedMs: number,
    ) => void;
}

export interface TagTranscriptResult {
    targets: Map<number, TagTarget>;
}

/**
 *
 * Eligible parts contribute to LLM input.
 * Eligible parts can be replaced when dropped.
 *
 * The tagger assigns user and assistant text parts type `message`.
 * The tagger injects the prefix into visible text; each text `TagTarget` supports `setContent`.
 * Thinking parts use provider-specific signed content.
 * Replacing signed thinking content mid-conversation breaks signature verification.
 * The historian's clear-reasoning pass handles thinking parts separately.
 * The tagger assigns assistant tool_use parts type "tool".
 * The TagTarget supports dropping or truncating tool content.
 *     primitives.
 * The Pi adapter folds tool_result parts into user messages.
 * The tagger assigns each tool_result part type "tool".
 * The tagger pairs each tool_result with its invocation so a full-pair drop affects both.
 *
 * The tagger uses a stable part ID as contentId when available.
 * The tagger uses a synthetic locator when no stable part ID exists.
 * The Pi adapter maps each tool_use part ID to ToolCall.id.
 * The Pi adapter maps each tool_result part ID to ToolResultMessage.toolCallId.
 * The tagger derives text-part IDs from the message ID and ordered text content.
 */
/**
 * The tagger assigns one tag per call ID.
 * The tagger records tool-result output in byteSize and tool-use arguments in inputByteSize.
 * Reclaim accounting sums byteSize, inputByteSize, and reasoning.
 * Including arguments in byteSize would double-count them during reclaim accounting.
 * The tagger builds one aggregate TagTarget for each invocation/result pair.
 * The aggregate TagTarget updates both invocation and result occurrences atomically.
 * A queued drop replaces both occurrences with sentinels.
 */
interface ToolOccurrence {
    message: { info: { id?: string; role: string } };
    part: TranscriptPart;
    kind: "tool_use" | "tool_result";
}

interface TagTranscriptTiming {
    identity: number;
    prefix: number;
    targets: number;
    tokenCounting: number;
}

interface ToolAggregate {
    callId: string;
    /** Every occurrence seen so far belongs to a previously tagged stable message. */
    identityReusable: boolean;
    occurrences: ToolOccurrence[];
    /** The aggregate uses the largest occurrence byteSize as its tag size. */
    maxByteSize: number;
    /** The aggregate stores the token count from the occurrence that supplied maxByteSize. */
    maxTokenCount: number;
    /** The aggregate stores the first non-null tool name observed. */
    toolName: string | null;
    /** The aggregate stores the invocation's input byte size for storage projection. */
    inputByteSize: number;
    /** The aggregate stores the persisted input-token count, or null when no invocation was observed. */
    inputTokenCount: number | null;
}

function textIdentityDigest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function buildContentDerivedTextIds(messageId: string, parts: readonly TranscriptPart[]): string[] {
    const sources = parts
        .filter((part) => part.kind === "text")
        .map((part) => stripTagPrefix(part.getText() ?? ""));
    const vectorFingerprint = textIdentityDigest(JSON.stringify(sources));
    const occurrences = new Map<string, number>();

    return sources.map((source) => {
        const contentFingerprint = textIdentityDigest(source);
        const occurrence = occurrences.get(contentFingerprint) ?? 0;
        occurrences.set(contentFingerprint, occurrence + 1);
        return `${messageId}${TEXT_TAG_IDENTITY_MARKER}${vectorFingerprint}:${contentFingerprint}:o${occurrence}`;
    });
}

export function tagTranscript(
    sessionId: string,
    transcript: Transcript,
    tagger: Tagger,
    db: ContextDatabase,
    options: TagTranscriptOptions = {},
): TagTranscriptResult {
    const skipPrefixInjection = options.skipPrefixInjection === true;
    const targets = new Map<number, TagTarget>();
    const timing: TagTranscriptTiming | undefined = options.onTiming
        ? { identity: 0, prefix: 0, targets: 0, tokenCounting: 0 }
        : undefined;

    // OpenCode/Pi callId counters can repeat across turns.
    // A bare callId key can merge distinct invocations.
    // Such merges can replay drops and status changes against the wrong tool pair.
    const toolAggregates = new Map<string, ToolAggregate & { tagId: number }>();
    const openToolAggregateKeysByCallId = new Map<string, string[]>();
    let activeToolResultRun: { callId: string; aggregateKey: string } | undefined;

    // Per-tag SAVEPOINTs isolate a UNIQUE collision to its tag insert, preserving earlier inserts and `savedSource`.
    for (let msgIndex = 0; msgIndex < transcript.messages.length; msgIndex += 1) {
        const message = transcript.messages[msgIndex];
        if (message === undefined) continue;
        activeToolResultRun = undefined;
        const messageId = message.info.id;
        const reuseIdentity =
            messageId !== undefined && options.reuseMessageIds?.has(messageId) === true;

        let textOrdinal = 0;
        let toolResultOrdinal = 0;
        const parts = message.parts;
        const contentDerivedTextIds =
            messageId !== undefined && options.textIdentityDriftMessageIds?.has(messageId) === true
                ? buildContentDerivedTextIds(messageId, parts)
                : undefined;

        for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
            const part = parts[partIndex];
            if (part === undefined) continue;
            const resultBlockOrdinal =
                part.kind === "tool_result" ? toolResultOrdinal++ : undefined;

            if (part.kind !== "tool_result") {
                activeToolResultRun = undefined;
            }

            if (part.kind === "text") {
                // tagTranscript passes through Pi tail synthetic user messages without IDs because tags require a stable cross-pass handle.
                if (messageId === undefined) {
                    textOrdinal += 1;
                    continue;
                }
                tagTextPart({
                    sessionId,
                    message,
                    messageId,
                    contentId:
                        contentDerivedTextIds?.[textOrdinal] ?? `${messageId}:p${textOrdinal}`,
                    msgIndex,
                    textOrdinal,
                    part,
                    tagger,
                    db,
                    targets,
                    skipPrefixInjection,
                    entryFingerprint: options.entryFingerprintByMessageId?.get(messageId) ?? null,
                    reuseIdentity: reuseIdentity || contentDerivedTextIds !== undefined,
                    timing,
                    textIdentitySourceCache: options.textIdentitySourceCache,
                    textTokenCache: options.textTokenCache,
                });
                textOrdinal += 1;
                continue;
            }

            if (part.kind === "tool_use" || part.kind === "tool_result") {
                if (messageId === undefined) {
                    activeToolResultRun = undefined;
                    continue;
                }

                const identityStart = timing ? performance.now() : 0;
                const callId = part.id;
                if (typeof callId !== "string" || callId.length === 0) {
                    activeToolResultRun = undefined;
                    // Parts without a stable callId receive independent tags.
                    tagToolPart({
                        sessionId,
                        message,
                        messageId,
                        msgIndex,
                        partIndex,
                        part,
                        tagger,
                        db,
                        targets,
                        skipPrefixInjection,
                        reuseIdentity,
                        timing,
                    });
                    continue;
                }

                const pendingKeys = openToolAggregateKeysByCallId.get(callId) ?? [];
                let existingKey: string | undefined;
                if (part.kind === "tool_result") {
                    if (
                        activeToolResultRun !== undefined &&
                        activeToolResultRun.callId === callId
                    ) {
                        existingKey = activeToolResultRun.aggregateKey;
                    } else {
                        existingKey = findLastUnresolvedToolAggregateKey(
                            pendingKeys,
                            toolAggregates,
                        );
                    }
                }
                const aggregateKey: string = existingKey ?? makeToolCompositeKey(messageId, callId);
                // Block memoization remains separate from aggregate tag identity.
                // The result-part ordinal follows the message's stable result-part order rather than cache-write order.
                const tokenCacheKey =
                    resultBlockOrdinal === undefined
                        ? aggregateKey
                        : `${aggregateKey}\0result-part:${messageId}:${resultBlockOrdinal}`;
                const existing = toolAggregates.get(aggregateKey);
                if (existing) {
                    existing.occurrences.push({ message, part, kind: part.kind });
                    const canReuseIdentity = reuseIdentity && existing.identityReusable;
                    let text = "";
                    if (canReuseIdentity) {
                        // Prefix replay requires result text, so the code defers BPE and DB writes until persisted size increases; byte length guards durable growth.
                        if (part.kind === "tool_result") {
                            text = part.getText() ?? "";
                            applyGrownToolResultAccounting({
                                db,
                                sessionId,
                                tagger,
                                aggregate: existing,
                                byteSize: getToolPartByteSize(part, text),
                                part,
                                text,
                                timing,
                                tokenCache: options.toolTokenCache,
                                tokenCacheKey,
                            });
                        }
                        if (timing) timing.identity += performance.now() - identityStart;
                    } else {
                        const accounting = readAggregateToolAccounting(
                            part,
                            timing,
                            options.toolTokenCache,
                            tokenCacheKey,
                        );
                        text = accounting.text;
                        if (part.kind === "tool_result") {
                            applyGrownToolResultAccounting({
                                db,
                                sessionId,
                                tagger,
                                aggregate: existing,
                                byteSize: accounting.byteSize,
                                part,
                                text,
                                timing,
                                knownTokenCount: accounting.tokenCount,
                            });
                        }
                        if (existing.toolName === null && accounting.toolName) {
                            existing.toolName = accounting.toolName;
                        }
                        if (
                            existing.inputByteSize === 0 &&
                            part.kind === "tool_use" &&
                            accounting.inputByteSize > 0
                        ) {
                            existing.inputByteSize = accounting.inputByteSize;
                            updateTagInputByteSize(
                                db,
                                sessionId,
                                existing.tagId,
                                accounting.inputByteSize,
                            );
                        }
                        if (
                            existing.inputTokenCount === null &&
                            part.kind === "tool_use" &&
                            accounting.inputTokenCount > 0
                        ) {
                            existing.inputTokenCount = accounting.inputTokenCount;
                            updateTagInputTokenCount(
                                db,
                                sessionId,
                                existing.tagId,
                                accounting.inputTokenCount,
                            );
                        }
                        syncToolAggregateAccounting(tagger, sessionId, existing);
                        if (timing) timing.identity += performance.now() - identityStart;
                    }
                    existing.identityReusable &&= reuseIdentity;
                    applyToolPrefixAndTarget({
                        skipPrefixInjection,
                        part,
                        text,
                        tagId: existing.tagId,
                        aggregate: existing,
                        targets,
                        timing,
                    });
                    if (part.kind === "tool_result") {
                        markToolAggregateResolved(
                            callId,
                            aggregateKey,
                            openToolAggregateKeysByCallId,
                        );
                        activeToolResultRun = { callId, aggregateKey };
                    }
                    continue;
                }

                const reusableTagId = reuseIdentity
                    ? tagger.getToolTag(sessionId, callId, messageId)
                    : undefined;
                const reusableAccounting = reuseIdentity
                    ? tagger.getToolTagAccounting(sessionId, callId, messageId)
                    : undefined;
                let aggregate: ToolAggregate & { tagId: number };
                let text = "";
                if (reusableTagId !== undefined && reusableAccounting !== undefined) {
                    aggregate = {
                        callId,
                        tagId: reusableTagId,
                        identityReusable: true,
                        occurrences: [{ message, part, kind: part.kind }],
                        // Stable identity does not guarantee stable payload size; the code seeds from the persisted row.
                        maxByteSize: reusableAccounting.byteSize,
                        maxTokenCount: reusableAccounting.tokenCount ?? 0,
                        toolName: null,
                        inputByteSize: reusableAccounting.inputByteSize,
                        inputTokenCount: reusableAccounting.inputTokenCount,
                    };
                    if (part.kind === "tool_result") {
                        text = part.getText() ?? "";
                        applyGrownToolResultAccounting({
                            db,
                            sessionId,
                            tagger,
                            aggregate,
                            byteSize: getToolPartByteSize(part, text),
                            part,
                            text,
                            timing,
                            tokenCache: options.toolTokenCache,
                            tokenCacheKey,
                        });
                    }
                    if (timing) timing.identity += performance.now() - identityStart;
                } else {
                    const accounting = readAggregateToolAccounting(
                        part,
                        timing,
                        options.toolTokenCache,
                        tokenCacheKey,
                    );
                    text = accounting.text;
                    const outputByteSize = part.kind === "tool_result" ? accounting.byteSize : 0;
                    const outputTokenCount =
                        part.kind === "tool_result" ? accounting.tokenCount : 0;
                    const firstInputTokenCount =
                        part.kind === "tool_use" ? accounting.inputTokenCount : 0;
                    const tagId = tagger.assignToolTag(
                        sessionId,
                        callId,
                        messageId,
                        outputByteSize,
                        db,
                        0,
                        accounting.toolName,
                        accounting.inputByteSize,
                        () => ({
                            tokenCount: outputTokenCount,
                            inputTokenCount: firstInputTokenCount,
                            reasoningTokenCount: null,
                        }),
                    );
                    const persistedAccounting = tagger.getToolTagAccounting(
                        sessionId,
                        callId,
                        messageId,
                    );
                    aggregate = {
                        callId,
                        tagId,
                        identityReusable: false,
                        occurrences: [{ message, part, kind: part.kind }],
                        maxByteSize: persistedAccounting?.byteSize ?? outputByteSize,
                        maxTokenCount: persistedAccounting?.tokenCount ?? outputTokenCount,
                        toolName: accounting.toolName,
                        inputByteSize:
                            persistedAccounting?.inputByteSize ??
                            (part.kind === "tool_use" ? accounting.inputByteSize : 0),
                        inputTokenCount:
                            persistedAccounting?.inputTokenCount ??
                            (part.kind === "tool_use" ? firstInputTokenCount : null),
                    };
                    if (part.kind === "tool_result") {
                        applyGrownToolResultAccounting({
                            db,
                            sessionId,
                            tagger,
                            aggregate,
                            byteSize: accounting.byteSize,
                            part,
                            text,
                            timing,
                            knownTokenCount: accounting.tokenCount,
                        });
                    }
                    syncToolAggregateAccounting(tagger, sessionId, aggregate);
                    if (timing) timing.identity += performance.now() - identityStart;
                }

                toolAggregates.set(aggregateKey, aggregate);
                if (part.kind === "tool_use") {
                    openToolAggregateKeysByCallId.set(callId, [...pendingKeys, aggregateKey]);
                }
                applyToolPrefixAndTarget({
                    skipPrefixInjection,
                    part,
                    text,
                    tagId: aggregate.tagId,
                    aggregate,
                    targets,
                    timing,
                });
                if (part.kind === "tool_result") {
                    markToolAggregateResolved(callId, aggregateKey, openToolAggregateKeysByCallId);
                    activeToolResultRun = { callId, aggregateKey };
                }
            }
        }
    }

    if (timing && options.onTiming) {
        options.onTiming("identity", timing.identity);
        options.onTiming("prefix", timing.prefix);
        options.onTiming("targets", timing.targets);
        options.onTiming("tokenCounting", timing.tokenCounting);
    }
    return { targets };
}

interface AggregateToolAccounting {
    text: string;
    byteSize: number;
    tokenCount: number;
    toolName: string | null;
    inputByteSize: number;
    inputTokenCount: number;
}

interface GrownToolResultAccountingArgs {
    db: ContextDatabase;
    sessionId: string;
    tagger: Tagger;
    aggregate: ToolAggregate & { tagId: number };
    byteSize: number;
    part: TranscriptPart;
    text: string;
    timing: TagTranscriptTiming | undefined;
    tokenCache?: Map<string, { text: string; tokenCount: number }>;
    tokenCacheKey?: string;
    knownTokenCount?: number;
}

function syncToolAggregateAccounting(
    tagger: Tagger,
    sessionId: string,
    aggregate: ToolAggregate & { tagId: number },
): void {
    tagger.setToolTagAccounting(sessionId, aggregate.tagId, {
        byteSize: aggregate.maxByteSize,
        tokenCount: aggregate.maxTokenCount,
        inputByteSize: aggregate.inputByteSize,
        inputTokenCount: aggregate.inputTokenCount,
    });
}

function applyGrownToolResultAccounting(args: GrownToolResultAccountingArgs): void {
    if (args.byteSize <= args.aggregate.maxByteSize) return;

    let tokenCount = args.knownTokenCount;
    if (tokenCount !== undefined && args.tokenCacheKey) {
        args.tokenCache?.set(args.tokenCacheKey, { text: args.text, tokenCount });
    }
    if (tokenCount === undefined) {
        const tokenStart = args.timing ? performance.now() : 0;
        tokenCount = getCachedToolPartTokenCount(
            args.part,
            args.text,
            args.tokenCache,
            args.tokenCacheKey,
        );
        if (args.timing) args.timing.tokenCounting += performance.now() - tokenStart;
    }
    args.aggregate.maxByteSize = args.byteSize;
    args.aggregate.maxTokenCount = tokenCount;
    updateTagByteSize(args.db, args.sessionId, args.aggregate.tagId, args.byteSize);
    updateTagTokenCount(args.db, args.sessionId, args.aggregate.tagId, tokenCount);
    syncToolAggregateAccounting(args.tagger, args.sessionId, args.aggregate);
}

function readAggregateToolAccounting(
    part: TranscriptPart,
    timing: TagTranscriptTiming | undefined,
    tokenCache?: Map<string, { text: string; tokenCount: number }>,
    tokenCacheKey?: string,
): AggregateToolAccounting {
    const text = part.getText() ?? "";
    const byteSize = getToolPartByteSize(part, text);
    const metadata = part.getToolMetadata();
    let tokenCount = 0;
    if (part.kind === "tool_result") {
        const tokenStart = timing ? performance.now() : 0;
        tokenCount = getCachedToolPartTokenCount(part, text, tokenCache, tokenCacheKey);
        if (timing) timing.tokenCounting += performance.now() - tokenStart;
    }
    return {
        text,
        byteSize,
        tokenCount,
        toolName: metadata.toolName ?? null,
        inputByteSize: metadata.inputByteSize,
        inputTokenCount: metadata.inputTokenCount,
    };
}

interface ApplyToolPrefixAndTargetArgs {
    skipPrefixInjection: boolean;
    part: TranscriptPart;
    text: string;
    tagId: number;
    aggregate: ToolAggregate;
    targets: Map<number, TagTarget>;
    timing: TagTranscriptTiming | undefined;
}

function applyToolPrefixAndTarget(args: ApplyToolPrefixAndTargetArgs): void {
    if (!args.skipPrefixInjection && args.part.kind === "tool_result") {
        const prefixStart = args.timing ? performance.now() : 0;
        args.part.setText(prependTag(args.tagId, args.text));
        if (args.timing) args.timing.prefix += performance.now() - prefixStart;
    }
    const targetStart = args.timing ? performance.now() : 0;
    args.targets.set(args.tagId, buildAggregateTarget(args.tagId, args.aggregate.occurrences));
    if (args.timing) args.timing.targets += performance.now() - targetStart;
}

function findLastUnresolvedToolAggregateKey(
    pendingKeys: string[],
    toolAggregates: Map<string, ToolAggregate & { tagId: number }>,
): string | undefined {
    for (let i = pendingKeys.length - 1; i >= 0; i -= 1) {
        const key = pendingKeys[i];
        if (key === undefined) continue;
        const aggregate = toolAggregates.get(key);
        if (aggregate === undefined) continue;
        if (!aggregate.occurrences.some((occ) => occ.kind === "tool_result")) {
            return key;
        }
    }
    return undefined;
}

function markToolAggregateResolved(
    callId: string,
    aggregateKey: string,
    openToolAggregateKeysByCallId: Map<string, string[]>,
): void {
    const pendingKeys = openToolAggregateKeysByCallId.get(callId);
    if (pendingKeys === undefined) return;
    const nextPendingKeys = pendingKeys.filter((key) => key !== aggregateKey);
    if (nextPendingKeys.length === 0) {
        openToolAggregateKeysByCallId.delete(callId);
        return;
    }
    openToolAggregateKeysByCallId.set(callId, nextPendingKeys);
}

/** Tagged text uses the real tokenizer because images bill by visual tokens. */
function estimateTagTextTokens(text: string): number {
    if (!text) return 0;
    if (text.startsWith("data:image/")) return estimateImageTokensFromDataUrl(text);
    return estimateTokens(text);
}

function getToolPartByteSize(part: TranscriptPart, text: string): number {
    const textByteSize = byteSize(text);
    if (textByteSize > 0 || part.kind !== "tool_result") return textByteSize;
    return getNonTextToolResultByteSize(part);
}

/**
 * Tool tags use the same tokenizer count as `getToolPartByteSize`.
 * Empty `tool_result` text with positive `rawByteSize()` uses serialized raw-payload tokens.
 */
function getToolPartTokenCount(part: TranscriptPart, text: string): number {
    if (text.length > 0 || part.kind !== "tool_result") return estimateTokens(text);
    const raw = part.rawByteSize?.();
    if (typeof raw === "number" && raw > 0) {
        const record = isRecord(part) ? part : undefined;
        const content =
            record?.content ??
            record?.rawContent ??
            record?.rawPart ??
            record?.part ??
            record?.data ??
            record?.image ??
            record?.source;
        const serialized = safeJsonStringify(content ?? part);
        return serialized === undefined ? 0 : estimateTokens(serialized);
    }
    return 0;
}

function getCachedToolPartTokenCount(
    part: TranscriptPart,
    text: string,
    cache?: Map<string, { text: string; tokenCount: number }>,
    cacheKey?: string,
): number {
    const cached = cacheKey ? cache?.get(cacheKey) : undefined;
    if (cached?.text === text) return cached.tokenCount;
    const tokenCount = getToolPartTokenCount(part, text);
    if (cacheKey) cache?.set(cacheKey, { text, tokenCount });
    return tokenCount;
}

function getNonTextToolResultByteSize(part: TranscriptPart): number {
    const raw = part.rawByteSize?.();
    if (typeof raw === "number" && raw > 0) return raw;
    const record = isRecord(part) ? part : undefined;
    const content =
        record?.content ??
        record?.rawContent ??
        record?.rawPart ??
        record?.part ??
        record?.data ??
        record?.image ??
        record?.source;
    const serialized = safeJsonStringify(content ?? part);
    return serialized === undefined ? 0 : byteSize(serialized);
}

function safeJsonStringify(value: unknown): string | undefined {
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

interface TagTextPartArgs {
    sessionId: string;
    message: { info: { id?: string; role: string } };
    messageId: string;
    contentId: string;
    msgIndex: number;
    textOrdinal: number;
    part: TranscriptPart;
    tagger: Tagger;
    db: ContextDatabase;
    targets: Map<number, TagTarget>;
    skipPrefixInjection: boolean;
    entryFingerprint: string | null;
    reuseIdentity: boolean;
    timing?: TagTranscriptTiming;
    textIdentitySourceCache?: Map<number, string>;
    textTokenCache?: Map<string, { text: string; tokenCount: number }>;
}

function tagTextPart(args: TagTextPartArgs): void {
    const identityStart = args.timing ? performance.now() : 0;
    const text = args.part.getText() ?? "";
    const contentId = args.contentId;
    const reusableTagId = args.reuseIdentity
        ? args.tagger.getTag(args.sessionId, contentId, "message")
        : undefined;
    if (reusableTagId !== undefined) {
        if (args.timing) args.timing.identity += performance.now() - identityStart;
        applyTextPrefixAndTarget(args, reusableTagId, text);
        return;
    }
    const tagId = args.tagger.assignTag(
        args.sessionId,
        contentId,
        "message",
        byteSize(text),
        args.db,
        0,
        null,
        0,
        args.entryFingerprint,
        () => {
            const tokenStart = args.timing ? performance.now() : 0;
            const cached = args.textTokenCache?.get(contentId);
            const tokenCount =
                cached?.text === text
                    ? cached.tokenCount
                    : estimateTagTextTokens(stripTagPrefix(text));
            if (cached?.text !== text) {
                args.textTokenCache?.set(contentId, { text, tokenCount });
            }
            const counts = {
                tokenCount,
                inputTokenCount: null,
                reasoningTokenCount: null,
            };
            if (args.timing) args.timing.tokenCounting += performance.now() - tokenStart;
            return counts;
        },
    );

    // saveSourceContent preserves pre-tagged source text for compression-from-original heuristics.
    //
    // stripTagPrefix prevents existing §N§ prefixes from being saved as source content.
    const sourceContent = stripTagPrefix(text);
    if (sourceContent.trim().length > 0) {
        saveSourceContent(args.db, args.sessionId, tagId, sourceContent);
        args.textIdentitySourceCache?.set(tagId, sourceContent);
    }
    if (args.timing) args.timing.identity += performance.now() - identityStart;
    applyTextPrefixAndTarget(args, tagId, text);
}

function applyTextPrefixAndTarget(args: TagTextPartArgs, tagId: number, text: string): void {
    if (!args.skipPrefixInjection) {
        const prefixStart = args.timing ? performance.now() : 0;
        args.part.setText(prependTag(tagId, text));
        if (args.timing) args.timing.prefix += performance.now() - prefixStart;
    }

    const targetStart = args.timing ? performance.now() : 0;
    args.targets.set(tagId, buildTextTarget(args.part, args.message));
    if (args.timing) args.timing.targets += performance.now() - targetStart;
}

interface TagToolPartArgs {
    sessionId: string;
    message: { info: { id?: string; role: string } };
    messageId: string;
    msgIndex: number;
    partIndex: number;
    part: TranscriptPart;
    tagger: Tagger;
    db: ContextDatabase;
    targets: Map<number, TagTarget>;
    skipPrefixInjection: boolean;
    reuseIdentity: boolean;
    timing?: TagTranscriptTiming;
}

function tagToolPart(args: TagToolPartArgs): void {
    const identityStart = args.timing ? performance.now() : 0;
    // Sharing a part.id makes a tool call and its result use the same tag.
    // A shared tag lets drops target the call-result pair together.
    const stableId = args.part.id;
    const contentId = stableId ?? `${args.messageId}:t${args.partIndex}`;
    const reusableTagId = args.reuseIdentity
        ? args.tagger.getToolTag(args.sessionId, contentId, contentId)
        : undefined;
    if (reusableTagId !== undefined) {
        const text = args.part.kind === "tool_result" ? (args.part.getText() ?? "") : "";
        if (args.timing) args.timing.identity += performance.now() - identityStart;
        applySingleToolPrefixAndTarget(args, reusableTagId, text);
        return;
    }
    const text = args.part.getText() ?? "";
    const toolByteSize = getToolPartByteSize(args.part, text);
    const meta = args.part.getToolMetadata();
    const tokenStart = args.timing ? performance.now() : 0;
    const toolTokenCount = getToolPartTokenCount(args.part, text);
    if (args.timing) args.timing.tokenCounting += performance.now() - tokenStart;
    // Parts without `callId` receive distinct synthetic identifiers.
    const tagId = args.tagger.assignToolTag(
        args.sessionId,
        contentId,
        contentId,
        toolByteSize,
        args.db,
        0,
        meta.toolName ?? null,
        meta.inputByteSize,
        () => {
            const tokenStart = args.timing ? performance.now() : 0;
            const counts = {
                tokenCount: toolTokenCount,
                inputTokenCount: meta.inputTokenCount,
                reasoningTokenCount: null,
            };
            if (args.timing) args.timing.tokenCounting += performance.now() - tokenStart;
            return counts;
        },
    );
    if (args.timing) args.timing.identity += performance.now() - identityStart;
    applySingleToolPrefixAndTarget(args, tagId, text);
}

function applySingleToolPrefixAndTarget(args: TagToolPartArgs, tagId: number, text: string): void {
    // Tool-result text accepts tag prefixes for in-text references.
    if (!args.skipPrefixInjection && args.part.kind === "tool_result") {
        const prefixStart = args.timing ? performance.now() : 0;
        args.part.setText(prependTag(tagId, text));
        if (args.timing) args.timing.prefix += performance.now() - prefixStart;
    }

    const targetStart = args.timing ? performance.now() : 0;
    args.targets.set(tagId, buildToolTarget(args.part, args.message, tagId));
    if (args.timing) args.timing.targets += performance.now() - targetStart;
}

function setToolContentOrText(part: TranscriptPart, content: string): boolean {
    try {
        if (part.setToolOutput(content)) return true;
    } catch {
        // Pi assistant tool_use parts reject writes without an output slot.
        // Truncated-mode drops must still shrink the invocation.
        // Truncated-mode drops replace text when no output slot exists.
    }
    return part.setText(content);
}

/**
 * The TagTarget mutates every invocation and result for the tool call.
 *
 *
 */
function buildAggregateTarget(tagId: number, occurrences: ToolOccurrence[]): TagTarget {
    const role = occurrences[0]?.message.info.role ?? "user";
    const messageId = occurrences[0]?.message.info.id;

    return {
        setContent(content: string): boolean {
            let changed = false;
            for (const occ of occurrences) {
                if (setToolContentOrText(occ.part, content)) {
                    changed = true;
                }
            }
            return changed;
        },
        getContent(): string | null {
            for (const occ of occurrences) {
                if (occ.kind === "tool_result") {
                    return occ.part.getText() ?? null;
                }
            }
            return occurrences[0]?.part.getText() ?? null;
        },
        drop(): "removed" | "absent" {
            const sentinel = `[dropped \u00a7${tagId}\u00a7]`;
            let any = false;
            for (const occ of occurrences) {
                if (occ.part.replaceWithSentinel(sentinel)) any = true;
            }
            return any ? "removed" : "absent";
        },
        truncate(): "truncated" | "absent" {
            // `truncate()` preserves the tool invocation and replaces each occurrence's content with `[dropped §N§]`.
            const sentinel = `[dropped \u00a7${tagId}\u00a7]`;
            let any = false;
            for (const occ of occurrences) {
                if (setToolContentOrText(occ.part, sentinel)) {
                    any = true;
                }
            }
            return any ? "truncated" : "absent";
        },
        editMarker(): "truncated" | "absent" {
            const sentinel = `[dropped \u00a7${tagId}\u00a7]`;
            let any = false;
            for (const occ of occurrences) {
                if (occ.kind === "tool_use") {
                    const input = occ.part.getToolInput?.();
                    if (input) {
                        const next = { ...input };
                        applyEditMarkerToInput(next);
                        if (occ.part.setToolInput?.(next)) any = true;
                    }
                } else if (setToolContentOrText(occ.part, sentinel)) {
                    any = true;
                }
            }
            return any ? "truncated" : "absent";
        },
        canDrop(): boolean {
            return occurrences.length > 0;
        },
        readInput(): Record<string, unknown> | null {
            for (const occ of occurrences) {
                const input = occ.part.getToolInput?.();
                if (input) return input;
            }
            return null;
        },
        message: {
            info: { id: messageId, role },
            parts: [],
        },
    };
}

/**
 *
 */
function buildTextTarget(
    part: TranscriptPart,
    message: { info: { id?: string; role: string } },
): TagTarget {
    return {
        setContent(content: string): boolean {
            return part.setText(content);
        },
        getContent(): string | null {
            return part.getText() ?? null;
        },
        // sufficient.
        message: {
            info: { id: message.info.id, role: message.info.role },
            parts: [],
        },
    };
}

/**
 */
function buildToolTarget(
    part: TranscriptPart,
    message: { info: { id?: string; role: string } },
    tagId: number,
): TagTarget {
    return {
        setContent(content: string): boolean {
            return setToolContentOrText(part, content);
        },
        getContent(): string | null {
            return part.getText() ?? null;
        },
        drop(): "removed" | "absent" {
            const replaced = part.replaceWithSentinel(`[dropped \u00a7${tagId}\u00a7]`);
            return replaced ? "removed" : "absent";
        },
        truncate(): "truncated" | "absent" {
            const ok = setToolContentOrText(part, `[dropped \u00a7${tagId}\u00a7]`);
            return ok ? "truncated" : "absent";
        },
        message: {
            info: { id: message.info.id, role: message.info.role },
            parts: [],
        },
    };
}
