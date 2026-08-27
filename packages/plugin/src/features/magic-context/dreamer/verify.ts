import { DREAMER_MEMORY_MAPPER_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import {
    extractLatestAssistantText,
    hasLengthCappedOutput,
} from "../../../shared/assistant-message-extractor";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { normalizeVerificationFiles } from "../memory";
import { formatRevisionLocator } from "../memory/claim-operation-contract";
import { ANTI_MEMORY_CATEGORY } from "../memory/constants";
import {
    ANTI_MEMORY_DEFAULT_TTL_MS,
    parseAntiMemoryContent,
    readAntiMemory,
    stageExtendAntiMemoryTtlInCurrentTransaction,
    stageReviseAntiMemoryInCurrentTransaction,
} from "../memory/storage-anti-memory";
import {
    type AutonomousManifestIdentity,
    type AutonomousManifestItem,
    combineClaimOperationStageOutcomes,
    runAutonomousManifestInCurrentTransaction,
} from "../memory/storage-claim-autonomous";
import {
    type ClaimOperationStageOutcome,
    computeProjectMemoryMutationToken,
    getProjectMemoryClaimByPublicId,
    stageApplyProjectMemoryMappingInCurrentTransaction,
    stageRecordProjectMemoryVerificationInCurrentTransaction,
    stageReviseProjectMemoryClaimInCurrentTransaction,
    stageSetProjectMemoryClaimLifecycleInCurrentTransaction,
} from "../memory/storage-claim-operations";
import { recordChildInvocation } from "../subagent-token-capture";
import {
    claimManifestBinding,
    dreamerInferenceProvenance,
    dreamerManifestIdentity,
    readDreamerProjectClaims,
    recordDreamerManifestRejection,
    sameClaimManifestBinding,
} from "./claim-manifest";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import type { DreamerModuleRoute } from "./module-apply";
import {
    DreamerProviderOutputFailureError,
    providerOutputFailureFromInvalidManifest,
} from "./provider-output-failure";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import { partitionVerifyScope } from "./verify-gate";
import {
    buildVerifyPrompt,
    type ParsedVerifyManifest,
    VERIFY_SYSTEM_PROMPT,
    type VerifyPromptMemory,
    validateVerifyManifest,
} from "./verify-prompt";

const VERIFY_BATCH_SIZE = 50;
const IDENTICAL_PROVIDER_FAILURE_BATCH_LIMIT = 2;

interface VerifyBatchResult {
    verified: number;
    updated: number;
    archived: number;
    providerFailure?: DreamerProviderOutputFailureError;
}

export interface VerifyArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    forceBroad?: boolean;
    model?: string;
    fallbackModels?: readonly string[];
    language?: string;
    moduleRoute?: DreamerModuleRoute;
    onProgress?: (processed: number) => void;
}

export interface VerifyResult {
    verified: number;
    updated: number;
    archived: number;
    batches: number;
    inScope: number;
    remaining: number;
    complete: boolean;
    mode: string;
    broadCycleStartAt?: number;
}

function closeBroadCycle(args: VerifyArgs, cycleStartAt: number | undefined): void {
    if (!args.forceBroad || cycleStartAt === undefined) return;
    if (!getTaskScheduleState(args.db, args.projectIdentity, "verify-broad")) return;
    runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        const current = getTaskScheduleState(args.db, args.projectIdentity, "verify-broad");
        if (!current || current.lastBroadRunAt !== cycleStartAt) return;
        writeTaskScheduleState(args.db, { ...current, lastBroadRunAt: null });
    });
}

export async function runVerify(args: VerifyArgs): Promise<VerifyResult> {
    const runStartedAt = Date.now();
    const result: VerifyResult = {
        verified: 0,
        updated: 0,
        archived: 0,
        batches: 0,
        inScope: 0,
        remaining: 0,
        complete: true,
        mode: "incremental",
    };
    const gate = await partitionVerifyScope({
        db: args.db,
        projectIdentity: args.projectIdentity,
        projectDirectory: args.sessionDirectory,
        forceBroad: args.forceBroad,
        now: runStartedAt,
        holderId: args.holderId,
        leaseKey: args.leaseKey,
    });
    result.mode = gate.mode;
    result.broadCycleStartAt = gate.broadCycleStartAt;
    result.inScope = gate.inScope.length;
    result.remaining = gate.inScope.length;
    if (gate.inScope.length === 0) {
        closeBroadCycle(args, gate.broadCycleStartAt);
        return result;
    }

    const batches: VerifyPromptMemory[][] = [];
    for (let index = 0; index < gate.inScope.length; index += VERIFY_BATCH_SIZE) {
        batches.push(gate.inScope.slice(index, index + VERIFY_BATCH_SIZE));
    }
    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        args.leaseKey,
        () => abortController.abort(),
        args.leaseAcquisition,
    );
    let consecutiveProviderFailures = 0;
    let priorProviderFailureFingerprint: string | null = null;
    let lastProviderFailure: DreamerProviderOutputFailureError | null = null;
    try {
        for (let index = 0; index < batches.length; index += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) break;
            const counts = await verifyOneBatch(
                args,
                batches[index] ?? [],
                Math.max(1, Math.floor(remainingMs / (batches.length - index))),
                abortController.signal,
            );
            result.verified += counts.verified;
            result.updated += counts.updated;
            result.archived += counts.archived;
            result.remaining -= counts.verified + counts.updated + counts.archived;
            result.batches += 1;
            args.onProgress?.(result.verified + result.updated + result.archived);
            if (counts.providerFailure) {
                lastProviderFailure = counts.providerFailure;
                consecutiveProviderFailures =
                    counts.providerFailure.fingerprint === priorProviderFailureFingerprint
                        ? consecutiveProviderFailures + 1
                        : 1;
                priorProviderFailureFingerprint = counts.providerFailure.fingerprint;
                if (consecutiveProviderFailures >= IDENTICAL_PROVIDER_FAILURE_BATCH_LIMIT) {
                    throw counts.providerFailure;
                }
            } else {
                priorProviderFailureFingerprint = null;
                consecutiveProviderFailures = 0;
            }
        }
        if (lastProviderFailure) throw lastProviderFailure;
        result.complete = result.remaining === 0;
        if (result.complete) closeBroadCycle(args, gate.broadCycleStartAt);
        return result;
    } finally {
        heartbeat.stop();
    }
}

async function verifyOneBatch(
    args: VerifyArgs,
    selectedBatch: VerifyPromptMemory[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<VerifyBatchResult> {
    let agentSessionId: string | null = null;
    let rawManifest = "";
    let identity: AutonomousManifestIdentity = dreamerManifestIdentity({
        ...args,
        task: args.forceBroad ? "verify-broad" : "verify",
        publicClaimIds: selectedBatch.map((memory) => memory.publicClaimId),
    });
    const startedAt = Date.now();
    try {
        const createResponse = await createChildSessionWithFence({
            client: args.client,
            db: args.db,
            parentSessionId: args.parentSessionId,
            title: "magic-context-dream-verify",
            directory: args.sessionDirectory,
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create verify session.");

        const currentById = new Map(
            readDreamerProjectClaims(args.db, args.projectIdentity, "verification").map((claim) => [
                claim.publicClaimId,
                claim,
            ]),
        );
        const batch = selectedBatch.flatMap((memory) => {
            const claim = currentById.get(memory.publicClaimId);
            if (!claim) return [];
            const selectedBinding = {
                publicClaimId: memory.publicClaimId,
                revisionLocator: memory.revisionLocator,
                contentDigest: memory.contentDigest,
                token: memory.mutationToken,
            };
            return sameClaimManifestBinding(selectedBinding, claimManifestBinding(claim))
                ? [
                      {
                          ...memory,
                          revisionLocator: claim.revisionLocator,
                          contentDigest: claim.contentDigest,
                          mutationToken: claim.mutationToken,
                          content: claim.content,
                      },
                  ]
                : [];
        });
        if (batch.length === 0) return { verified: 0, updated: 0, archived: 0 };
        identity = dreamerManifestIdentity({
            ...args,
            task: args.forceBroad ? "verify-broad" : "verify",
            publicClaimIds: batch.map((memory) => memory.publicClaimId),
        });
        const prompt = buildVerifyPrompt(args.projectIdentity, batch);
        const run = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_MEMORY_MAPPER_AGENT,
                    system: withContentLanguageDirective(VERIFY_SYSTEM_PROMPT, args.language),
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: sliceMs,
                signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:verify",
                fetchOutput: async () => {
                    const messagesResponse = await args.client.session.messages({
                        path: { id: agentSessionId as string },
                        query: { directory: args.sessionDirectory, limit: 100 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    if (hasLengthCappedOutput(messages)) {
                        throw new Error("verify returned length-capped output");
                    }
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("verify returned no output");
                    rawManifest = text;
                    try {
                        validateVerifyManifest(
                            text,
                            new Set(batch.map((memory) => memory.publicClaimId)),
                            new Set(
                                batch
                                    .filter((memory) => memory.category === ANTI_MEMORY_CATEGORY)
                                    .map((memory) => memory.publicClaimId),
                            ),
                        );
                    } catch (error) {
                        const providerFailure = providerOutputFailureFromInvalidManifest(
                            messages,
                            text,
                        );
                        if (providerFailure) throw providerFailure;
                        throw error;
                    }
                    return text;
                },
            },
        );
        recordInvocation(args, startedAt, { status: "completed", messages: run.output });
        return await applyVerifyManifest(args, batch, run.validated);
    } catch (error) {
        try {
            recordDreamerManifestRejection({
                ...args,
                identity,
                rawManifest,
                reason: getErrorMessage(error),
            });
        } catch (recordError) {
            log(`[dreamer] verify rejection receipt failed: ${getErrorMessage(recordError)}`);
        }
        const providerFailure =
            error instanceof DreamerProviderOutputFailureError ? error : undefined;
        const desc = describeError(error);
        log(
            `[dreamer] verify batch ${providerFailure ? "provider failure" : "failed"}: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        recordInvocation(args, startedAt, { status: "failed", error });
        if (signal.aborted) throw error;
        return { verified: 0, updated: 0, archived: 0, providerFailure };
    } finally {
        if (agentSessionId && !shouldKeepSubagents()) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((error: unknown) => {
                    log(`[dreamer] verify session cleanup failed: ${getErrorMessage(error)}`);
                });
        }
    }
}

type VerifyWrite =
    | { kind: "verify"; publicClaimId: string; category: string; files: string[] }
    | {
          kind: "update";
          publicClaimId: string;
          category: string;
          files: string[];
          content: string;
      }
    | { kind: "archive"; publicClaimId: string; category: string; reason: string };

function freshTarget(db: Database, publicClaimId: string) {
    const claim = getProjectMemoryClaimByPublicId(db, publicClaimId);
    if (!claim) throw new Error(`claim ${publicClaimId} disappeared during verification apply`);
    return {
        claim,
        token: computeProjectMemoryMutationToken(db, publicClaimId),
        revisionLocator: formatRevisionLocator(claim),
    };
}

function byCategory(batch: readonly VerifyPromptMemory[], publicClaimId: string): string {
    const memory = batch.find((candidate) => candidate.publicClaimId === publicClaimId);
    if (!memory) throw new Error(`verify returned unknown claim ${publicClaimId}`);
    return memory.category;
}

function stageVerificationItem(
    db: Database,
    identity: AutonomousManifestIdentity,
    item: AutonomousManifestItem<VerifyWrite>,
    nowMs: number,
): ClaimOperationStageOutcome {
    const outcomes: ClaimOperationStageOutcome[] = [];
    if (item.value.kind === "verify") {
        if (item.value.category === ANTI_MEMORY_CATEGORY) {
            const record = readAntiMemory(db, item.binding.publicClaimId);
            if (record === null)
                throw new Error(`missing anti-memory ${item.binding.publicClaimId}`);
            const expiresAt = nowMs + ANTI_MEMORY_DEFAULT_TTL_MS;
            if (record.expiresAt !== null && record.expiresAt < expiresAt) {
                outcomes.push(
                    stageExtendAntiMemoryTtlInCurrentTransaction(
                        db,
                        {
                            token: item.binding.token,
                            expiresAt,
                            provenance: dreamerInferenceProvenance({
                                identity,
                                binding: item.binding,
                                sourceContent: record.content,
                            }),
                            actor: `dreamer:${identity.runId}`,
                        },
                        nowMs,
                    ),
                );
            }
            const current = freshTarget(db, item.binding.publicClaimId);
            outcomes.push(
                stageRecordProjectMemoryVerificationInCurrentTransaction(
                    db,
                    {
                        token: current.token,
                        revisionLocator: current.revisionLocator,
                        outcome: "verified",
                        verifier: identity.producer,
                    },
                    nowMs,
                ),
            );
            return combineClaimOperationStageOutcomes(outcomes, {
                kind: item.value.kind,
                publicClaimId: item.binding.publicClaimId,
            });
        }
        outcomes.push(
            stageApplyProjectMemoryMappingInCurrentTransaction(
                db,
                {
                    token: item.binding.token,
                    revisionLocator: item.binding.revisionLocator,
                    paths: { state: "known", exact: item.value.files },
                },
                nowMs,
            ),
        );
        const current = freshTarget(db, item.binding.publicClaimId);
        outcomes.push(
            stageRecordProjectMemoryVerificationInCurrentTransaction(
                db,
                {
                    token: current.token,
                    revisionLocator: current.revisionLocator,
                    outcome: "verified",
                    verifier: identity.producer,
                },
                nowMs,
            ),
        );
    } else if (item.value.kind === "update") {
        outcomes.push(
            stageRecordProjectMemoryVerificationInCurrentTransaction(
                db,
                {
                    token: item.binding.token,
                    revisionLocator: item.binding.revisionLocator,
                    outcome: "update",
                    verifier: identity.producer,
                },
                nowMs,
            ),
        );
        const oldTarget = freshTarget(db, item.binding.publicClaimId);
        const revisionInput = {
            token: oldTarget.token,
            provenance: dreamerInferenceProvenance({
                identity,
                binding: item.binding,
                sourceContent: item.value.content,
            }),
            actor: `dreamer:${identity.runId}`,
        };
        outcomes.push(
            item.value.category === ANTI_MEMORY_CATEGORY
                ? stageReviseAntiMemoryInCurrentTransaction(
                      db,
                      { ...revisionInput, payload: parseAntiMemoryContent(item.value.content) },
                      nowMs,
                  )
                : stageReviseProjectMemoryClaimInCurrentTransaction(
                      db,
                      { ...revisionInput, content: item.value.content },
                      nowMs,
                  ),
        );
        if (item.value.category === ANTI_MEMORY_CATEGORY) {
            return combineClaimOperationStageOutcomes(outcomes, {
                kind: item.value.kind,
                publicClaimId: item.binding.publicClaimId,
            });
        }
        const current = freshTarget(db, item.binding.publicClaimId);
        outcomes.push(
            stageApplyProjectMemoryMappingInCurrentTransaction(
                db,
                {
                    token: current.token,
                    revisionLocator: current.revisionLocator,
                    paths: { state: "known", exact: item.value.files },
                },
                nowMs,
            ),
        );
    } else {
        if (item.value.category === ANTI_MEMORY_CATEGORY) {
            outcomes.push(
                stageRecordProjectMemoryVerificationInCurrentTransaction(
                    db,
                    {
                        token: item.binding.token,
                        revisionLocator: item.binding.revisionLocator,
                        outcome: "stale",
                        verifier: identity.producer,
                    },
                    nowMs,
                ),
            );
            return combineClaimOperationStageOutcomes(outcomes, {
                kind: item.value.kind,
                publicClaimId: item.binding.publicClaimId,
            });
        }
        outcomes.push(
            stageRecordProjectMemoryVerificationInCurrentTransaction(
                db,
                {
                    token: item.binding.token,
                    revisionLocator: item.binding.revisionLocator,
                    outcome: "archive",
                    verifier: identity.producer,
                },
                nowMs,
            ),
        );
        const current = freshTarget(db, item.binding.publicClaimId);
        outcomes.push(
            stageSetProjectMemoryClaimLifecycleInCurrentTransaction(
                db,
                {
                    token: current.token,
                    state: "archived",
                    actor: `dreamer:${identity.runId}`,
                    reason: item.value.reason,
                },
                nowMs,
            ),
        );
    }
    return combineClaimOperationStageOutcomes(outcomes, {
        kind: item.value.kind,
        publicClaimId: item.binding.publicClaimId,
    });
}

export async function applyVerifyManifest(
    args: VerifyArgs,
    batch: VerifyPromptMemory[],
    manifestText: string,
): Promise<{ verified: number; updated: number; archived: number }> {
    const task = args.forceBroad ? "verify-broad" : "verify";
    const identity = dreamerManifestIdentity({
        ...args,
        task,
        publicClaimIds: batch.map((memory) => memory.publicClaimId),
    });
    let parsed: ParsedVerifyManifest;
    try {
        parsed = validateVerifyManifest(
            manifestText,
            new Set(batch.map((memory) => memory.publicClaimId)),
            new Set(
                batch
                    .filter((memory) => memory.category === ANTI_MEMORY_CATEGORY)
                    .map((memory) => memory.publicClaimId),
            ),
        );
    } catch (error) {
        recordDreamerManifestRejection({
            ...args,
            identity,
            rawManifest: manifestText,
            reason: getErrorMessage(error),
        });
        throw error;
    }

    const writes: VerifyWrite[] = [];
    for (const entry of parsed.verified) {
        const category = byCategory(batch, entry.publicClaimId);
        const normalized =
            category === ANTI_MEMORY_CATEGORY
                ? { files: [] }
                : await normalizeVerificationFiles({
                      cwd: args.sessionDirectory,
                      files: entry.files,
                  });
        if (normalized.files.length === 0 && category !== ANTI_MEMORY_CATEGORY) {
            const error = new Error(`verify entry ${entry.publicClaimId} has no valid files`);
            recordDreamerManifestRejection({
                ...args,
                identity,
                rawManifest: manifestText,
                reason: error.message,
            });
            throw error;
        }
        writes.push({
            kind: "verify",
            publicClaimId: entry.publicClaimId,
            category,
            files: normalized.files,
        });
    }
    for (const entry of parsed.updated) {
        const content = entry.content.trim();
        if (!content || content.length > 20_000) {
            const error = new Error(`verify update ${entry.publicClaimId} has invalid content`);
            recordDreamerManifestRejection({
                ...args,
                identity,
                rawManifest: manifestText,
                reason: error.message,
            });
            throw error;
        }
        const category = byCategory(batch, entry.publicClaimId);
        const normalized =
            category === ANTI_MEMORY_CATEGORY
                ? { files: [] }
                : await normalizeVerificationFiles({
                      cwd: args.sessionDirectory,
                      files: entry.files,
                  });
        if (normalized.files.length === 0 && category !== ANTI_MEMORY_CATEGORY) {
            const error = new Error(`verify update ${entry.publicClaimId} has no valid files`);
            recordDreamerManifestRejection({
                ...args,
                identity,
                rawManifest: manifestText,
                reason: error.message,
            });
            throw error;
        }
        writes.push({
            kind: "update",
            publicClaimId: entry.publicClaimId,
            category,
            files: normalized.files,
            content,
        });
    }
    for (const entry of parsed.archived) {
        writes.push({
            kind: "archive",
            publicClaimId: entry.publicClaimId,
            category: byCategory(batch, entry.publicClaimId),
            reason: entry.reason,
        });
    }
    const byId = new Map(batch.map((memory) => [memory.publicClaimId, memory]));
    const counts = {
        verified: writes.filter((write) => write.kind === "verify").length,
        updated: writes.filter((write) => write.kind === "update").length,
        archived: writes.filter((write) => write.kind === "archive").length,
    };
    const applied = runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () =>
        runAutonomousManifestInCurrentTransaction({
            db: args.db,
            identity,
            items: writes.map((write) => {
                const memory = byId.get(write.publicClaimId);
                if (!memory)
                    throw new Error(`verify returned unknown claim ${write.publicClaimId}`);
                return {
                    binding: {
                        publicClaimId: memory.publicClaimId,
                        revisionLocator: memory.revisionLocator,
                        contentDigest: memory.contentDigest,
                        token: memory.mutationToken,
                    },
                    value: write,
                };
            }),
            manifest: writes.map((write) => ({
                content: write.kind === "update" ? write.content : null,
                files: write.kind === "archive" ? [] : write.files,
                kind: write.kind,
                publicClaimId: write.publicClaimId,
                reason: write.kind === "archive" ? write.reason : null,
            })),
            resultSummary: counts,
            stageItem: (db, item, nowMs) => stageVerificationItem(db, identity, item, nowMs),
        }),
    );
    if (applied.operation.outcome !== "applied") {
        return { verified: 0, updated: 0, archived: 0 };
    }
    const summary = applied.summary as {
        verified?: unknown;
        updated?: unknown;
        archived?: unknown;
    } | null;
    return {
        verified: typeof summary?.verified === "number" ? summary.verified : 0,
        updated: typeof summary?.updated === "number" ? summary.updated : 0,
        archived: typeof summary?.archived === "number" ? summary.archived : 0,
    };
}

function recordInvocation(
    args: VerifyArgs,
    startedAt: number,
    params: { status: "completed" | "failed"; messages?: unknown[]; error?: unknown },
): void {
    if (!args.parentSessionId) return;
    recordChildInvocation({
        db: args.db,
        parentSessionId: args.parentSessionId,
        harness: "opencode",
        subagent: "dreamer",
        task: args.forceBroad ? "verify-broad" : "verify",
        startedAt,
        status: params.status,
        messages: params.messages,
        error: params.error,
    });
}
