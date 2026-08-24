import { createHash, randomUUID } from "node:crypto";

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
import {
    archiveMemory,
    clearMemoryVerifications,
    getMemoryById,
    hasMemoryClassifiedAtColumn,
    hasMemoryShareableColumn,
    invalidateMemory,
    type Memory,
    normalizeVerificationFiles,
    recordMemoryVerifications,
} from "../memory";
import { computeNormalizedHash } from "../memory/normalize-hash";
import {
    exactMemoryContentDigests,
    maintenanceEligibleIdSet,
} from "../memory/storage-claim-visibility";
import { sha256Utf8Hex } from "../memory/storage-claims";
import {
    computeClaimRequestDigest,
    hasMemoryClaimsCompatSchema,
    runInMemoryClaimsWriteTransaction,
    updateMemoryContentWithClaimsInCurrentTransaction,
    withMemoryClaimGenerationContextInCurrentTransaction,
} from "../memory/storage-memory-claims";
import { queueMemoryMutation } from "../storage-memory-mutation-log";
import { recordChildInvocation } from "../subagent-token-capture";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import { assertManifestCoversExactly } from "./manifest-parser";
import {
    DreamerModuleFailureError,
    type DreamerModuleRoute,
    getModuleMemoryIdentities,
} from "./module-apply";
import {
    DreamerProviderOutputFailureError,
    providerOutputFailureFromInvalidManifest,
} from "./provider-output-failure";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import { partitionVerifyScope } from "./verify-gate";
import {
    buildVerifyPrompt,
    parseVerifyManifest,
    VERIFY_SYSTEM_PROMPT,
    type VerifyPromptMemory,
    validateVerifyManifest,
} from "./verify-prompt";

/**
 * verify / verify-broad: check file-mapped memories against the CURRENT source
 * and apply the agent's verified/update/archive manifest HOST-side.
 *
 * Per-memory verified_at (no global watermark): a timed-out batch banks what it
 * checked; the next run continues. Cost is unique-file-bounded like map, but
 * verify reads DEEPER (it checks claims, not just locates files), so it batches
 * SMALLER than map (~50 vs 80; harness: 96 memories peaked ~177K). No max-turns;
 * a batch that fails to emit a manifest banks nothing and is retried next run.
 *
 * Apply is cache-NEUTRAL: update/archive route through queueMemoryMutation (the
 * m[1] supersede-delta), never bumping the project memory epoch — the dreamer
 * must never bust the prompt cache.
 */

// Verify reads deeper than map → smaller batch keeps peak context under a 128K
// window with margin (harness: 96 mapped → ~177K on a large-window model).
const VERIFY_BATCH_SIZE = 50;
// One batch already exhausts the configured model fallback chain. A second
// identical provider-shaped completion means continuing this run only hammers
// the same outage, so leave the remaining memories for the scheduler retry.
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
    /** The open broad-cycle watermark, when this run used verify-broad. */
    broadCycleStartAt?: number;
}

function closeBroadCycle(args: VerifyArgs, cycleStartAt: number | undefined): void {
    if (!args.forceBroad || cycleStartAt === undefined) return;
    // Direct runVerify tests and legacy callers may not have a scheduler row. A
    // scheduled run always has one because the scheduler seeds it before execution.
    if (!getTaskScheduleState(args.db, args.projectIdentity, "verify-broad")) return;
    runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        const current = getTaskScheduleState(args.db, args.projectIdentity, "verify-broad");
        // Do not clear a cycle opened by a newer run if state changed while the
        // model was working. The domain lease normally prevents this, but the
        // equality check keeps the close operation safe under recovery tooling.
        if (current?.lastBroadRunAt !== cycleStartAt) return;
        if (!current) return;
        writeTaskScheduleState(args.db, {
            ...current,
            lastBroadRunAt: null,
        });
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
    log(
        `[dreamer] ${args.forceBroad ? "verify-broad" : "verify"} gate: mode=${gate.mode} in_scope=${gate.inScope.length} skipped=${gate.skippedIds.length} reason=${gate.reason}`,
    );
    if (gate.inScope.length === 0) {
        closeBroadCycle(args, gate.broadCycleStartAt);
        return result;
    }

    const batches: VerifyPromptMemory[][] = [];
    for (let i = 0; i < gate.inScope.length; i += VERIFY_BATCH_SIZE) {
        batches.push(gate.inScope.slice(i, i + VERIFY_BATCH_SIZE));
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
        for (let i = 0; i < batches.length; i += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) break;
            const batchesRemaining = batches.length - i;
            const sliceMs = Math.max(1, Math.floor(remainingMs / batchesRemaining));

            const counts = await verifyOneBatch(args, batches[i], sliceMs, abortController.signal);
            result.verified += counts.verified;
            result.updated += counts.updated;
            result.archived += counts.archived;
            result.remaining -= counts.verified + counts.updated + counts.archived;
            result.batches += 1;
            args.onProgress?.(result.verified + result.updated + result.archived);

            if (counts.providerFailure) {
                lastProviderFailure = counts.providerFailure;
                if (counts.providerFailure.fingerprint === priorProviderFailureFingerprint) {
                    consecutiveProviderFailures += 1;
                } else {
                    priorProviderFailureFingerprint = counts.providerFailure.fingerprint;
                    consecutiveProviderFailures = 1;
                }
                if (consecutiveProviderFailures >= IDENTICAL_PROVIDER_FAILURE_BATCH_LIMIT) {
                    log(
                        `[dreamer] verify run aborting after ${consecutiveProviderFailures} identical provider-failure batches`,
                    );
                    throw counts.providerFailure;
                }
            } else {
                priorProviderFailureFingerprint = null;
                consecutiveProviderFailures = 0;
            }
        }
        // A single-batch project cannot reach the circuit-breaker threshold. Still
        // surface its provider failure so the scheduler hot-retries instead of
        // recording a generic incomplete-manifest result.
        if (lastProviderFailure) throw lastProviderFailure;

        result.complete = result.remaining === 0;
        if (result.complete) closeBroadCycle(args, gate.broadCycleStartAt);
        log(
            `[dreamer] ${args.forceBroad ? "verify-broad" : "verify"}: verified=${result.verified} updated=${result.updated} archived=${result.archived} batches=${result.batches} remaining=${result.remaining} complete=${result.complete}`,
        );
        return result;
    } finally {
        heartbeat.stop();
    }
}

async function verifyOneBatch(
    args: VerifyArgs,
    batch: VerifyPromptMemory[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<VerifyBatchResult> {
    let agentSessionId: string | null = null;
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
            {
                preferResponseOnMissingData: true,
            },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create verify session.");

        // The scope was partitioned once at run start; later batches wait
        // behind provider calls, and child-session creation above is itself
        // an await. A memory quarantined, rejected, or superseded in the
        // meantime must not reach the child-model prompt, and a memory
        // REWRITTEN in the meantime must not be prompted with the frozen
        // revision's bytes (the manifest would then verify or overwrite the
        // new revision the model never saw). Re-apply the maintenance policy
        // and bind each member to its loaded bytes immediately before the
        // prompt is built and submitted.
        const stillInScope = maintenanceEligibleIdSet(
            args.db,
            batch.map((memory) => memory.id),
            "verification",
        );
        const digestsBeforePrompt = exactMemoryContentDigests(
            args.db,
            batch.map((memory) => memory.id),
        );
        const eligibleBatch = batch.filter(
            (memory) =>
                stillInScope.has(memory.id) &&
                digestsBeforePrompt.get(memory.id) === sha256Utf8Hex(memory.content),
        );
        if (eligibleBatch.length < batch.length) {
            log(
                `[dreamer] verify batch dropped ${batch.length - eligibleBatch.length} member(s) hidden since scope partition`,
            );
        }
        if (eligibleBatch.length === 0) {
            return { verified: 0, updated: 0, archived: 0 };
        }
        batch = eligibleBatch;

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
                    try {
                        validateVerifyManifest(text, new Set(batch.map((memory) => memory.id)));
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
        const desc = describeError(error);
        const providerFailure =
            error instanceof DreamerProviderOutputFailureError ? error : undefined;
        log(
            `[dreamer] verify batch ${providerFailure ? "provider failure" : "failed"}: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        recordInvocation(args, startedAt, { status: "failed", error });
        if (error instanceof DreamerModuleFailureError || signal.aborted) throw error;
        return { verified: 0, updated: 0, archived: 0, providerFailure };
    } finally {
        // Delete the child regardless of success/failure (a FAILED child still
        // holds the memory-pool snapshot fed into the prompt — leaving it only on
        // the failure path leaked them on disk). Still honor keep_subagents: this
        // child carries curated project memories (already in context.db), not raw
        // user text, so the user's explicit data-collection opt-in wins — unlike
        // the retrospective child, which is purged unconditionally.
        if (agentSessionId && !shouldKeepSubagents()) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((e: unknown) => {
                    log(`[dreamer] verify session cleanup failed: ${getErrorMessage(e)}`);
                });
        }
    }
}

/**
 * Apply the manifest host-side. Only ids that were IN this batch are touched.
 * - verified: re-record the (normalized) backing files with verified_at = now
 *   (banks the per-memory verify progress).
 * - update: rewrite the memory content via the cache-neutral mutation log, then
 *   clear old file mappings and embeddings so the new content is mapped and
 *   verified again next cycle.
 * - archive: archive + queue an archive mutation (m[1] delta). Skipped when the
 *   memory is no longer primary-mutable (already archived/superseded), so a stale
 *   manifest can't fight a concurrent change.
 * All writes happen under ONE lease-guarded transaction.
 */
export async function applyVerifyManifest(
    args: VerifyArgs,
    batch: VerifyPromptMemory[],
    manifestText: string,
): Promise<{ verified: number; updated: number; archived: number }> {
    const batchIds = new Set(batch.map((m) => m.id));
    const parsed = parseVerifyManifest(manifestText);
    assertManifestCoversExactly(
        [...parsed.verified, ...parsed.updated, ...parsed.archived].map((entry) => entry.id),
        batchIds,
        "verify",
    );
    const now = Date.now();
    // The model ran for a while; a memory can enter the uniform-absence class
    // (or leave the maintenance pool) between the prompt and this apply, and
    // a rewrite in the same window means the manifest's verdict describes
    // bytes that no longer exist. An in-flight verification must not verify,
    // rewrite, or archive such a row — drop its manifest entries instead.
    // The digest binds to the bytes the model was PROMPTED with.
    const promptDigestById = new Map(
        batch.map((memory) => [memory.id, sha256Utf8Hex(memory.content)]),
    );
    const stillApplicable = (id: number, eligible: Set<number>, digests: Map<number, string>) =>
        eligible.has(id) && digests.get(id) === promptDigestById.get(id);
    const eligibleAtApply = maintenanceEligibleIdSet(args.db, [...batchIds], "verification");
    const digestsAtApply = exactMemoryContentDigests(args.db, [...batchIds]);
    // Policy again AFTER the digest read (two autocommit snapshots): a hide
    // committed between them leaves the digest unchanged.
    const eligibleAfterApply = maintenanceEligibleIdSet(args.db, [...batchIds], "verification");
    const applicableIds = new Set(
        [...batchIds].filter(
            (id) =>
                stillApplicable(id, eligibleAtApply, digestsAtApply) && eligibleAfterApply.has(id),
        ),
    );
    const droppedIds = [...batchIds].filter((id) => !applicableIds.has(id));
    if (droppedIds.length > 0) {
        log(
            `[dreamer] verify manifest dropped ${droppedIds.length} target(s) hidden or rewritten during evaluation: ${droppedIds.join(", ")}`,
        );
    }
    parsed.verified = parsed.verified.filter((entry) => applicableIds.has(entry.id));
    parsed.updated = parsed.updated.filter((entry) => applicableIds.has(entry.id));
    parsed.archived = parsed.archived.filter((entry) => applicableIds.has(entry.id));

    // Pre-normalize files OUTSIDE the transaction (git/realpath I/O). For each
    // affected id, the COMPLETE backing set the agent reports.
    type VerifyWrite =
        | { kind: "verify"; id: number; files: string[] }
        | { kind: "update"; id: number; files: string[]; content: string; hash: string }
        | { kind: "archive"; id: number; reason: string };
    const writes: VerifyWrite[] = [];
    for (const v of parsed.verified) {
        const files = await normalizeFiles(args, v.files);
        writes.push({ kind: "verify", id: v.id, files });
    }
    for (const u of parsed.updated) {
        const content = u.content.trim();
        // An empty/oversized "update" is unsafe — fall back to a plain re-verify
        // (bank the progress, keep the old content) rather than wipe a memory.
        if (!content || content.length > 20_000) {
            const files = await normalizeFiles(args, u.files);
            writes.push({ kind: "verify", id: u.id, files });
            continue;
        }
        const files = await normalizeFiles(args, u.files);
        writes.push({
            kind: "update",
            id: u.id,
            files,
            content,
            hash: computeNormalizedHash(content),
        });
    }
    for (const a of parsed.archived) {
        writes.push({ kind: "archive", id: a.id, reason: a.reason });
    }
    if (writes.length === 0) return { verified: 0, updated: 0, archived: 0 };

    let verified = 0;
    let updated = 0;
    let archived = 0;
    if (args.moduleRoute) {
        // The apply-time check above precedes the awaited normalizeFiles
        // calls, and the native memory.set_verification handler validates
        // only the normalized hash (which cannot reject a case/whitespace
        // rewrite) and carries no claim-policy check. Repeat the policy and
        // prompt-byte validation immediately before constructing the module
        // rows — the module branch returns before the transaction-time
        // recheck that guards the local route.
        const eligibleForModule = maintenanceEligibleIdSet(
            args.db,
            writes.map((write) => write.id),
            "verification",
        );
        const digestsForModule = exactMemoryContentDigests(
            args.db,
            writes.map((write) => write.id),
        );
        // Policy again AFTER the digest read (two autocommit snapshots).
        const eligibleForModuleAfter = maintenanceEligibleIdSet(
            args.db,
            writes.map((write) => write.id),
            "verification",
        );
        const moduleWrites = writes.filter(
            (write) =>
                stillApplicable(write.id, eligibleForModule, digestsForModule) &&
                eligibleForModuleAfter.has(write.id),
        );
        if (moduleWrites.length < writes.length) {
            log(
                `[dreamer] verify module apply dropped ${writes.length - moduleWrites.length} target(s) hidden or rewritten during normalization`,
            );
        }
        if (moduleWrites.length === 0) return { verified: 0, updated: 0, archived: 0 };
        const identities = getModuleMemoryIdentities(
            args.db,
            args.projectIdentity,
            moduleWrites.map((write) => write.id),
        );
        const rows = moduleWrites.map((write) => {
            const identity = identities.get(write.id);
            if (!identity)
                throw new DreamerModuleFailureError(
                    "memory.set_verification",
                    new Error(`missing mirror identity for ${write.id}`),
                );
            return {
                memory_id: identity.moduleId,
                content_hash_at_prompt: identity.normalizedHash,
                // Exact prompted bytes: `stillApplicable` above proved the
                // claim-revision digest equals the sha256 of the bytes the
                // model saw, and the native handler compares it against the
                // row's exact content inside its transaction — the
                // normalized hash alone cannot reject a case/whitespace-only
                // rewrite landing between this preflight and that
                // transaction.
                ...(digestsForModule.get(write.id) !== undefined
                    ? { content_sha256_at_prompt: digestsForModule.get(write.id) }
                    : {}),
                verification_status: write.kind === "verify" ? "verified" : write.kind,
                ...(write.kind === "update" ? { updated_content: write.content } : {}),
                ...(write.kind === "archive" ? { archive_reason: write.reason } : {}),
            };
        });
        let response: unknown;
        try {
            response = await args.moduleRoute.moduleClient.call({
                sessionId: args.moduleRoute.moduleSessionId,
                projectRoot: args.moduleRoute.moduleProjectRoot,
                method: "memory.set_verification",
                body: {
                    name: "memory.set_verification",
                    arguments: {
                        memory_project: args.projectIdentity,
                        context_store_uuid: args.moduleRoute.moduleContextStoreUuid,
                        authority_generation: args.moduleRoute.moduleAuthorityGeneration,
                        command_id: `${args.moduleRoute.moduleCommandId}:${createHash("sha256")
                            .update(rows.map((row) => row.memory_id).join(","))
                            .digest("hex")
                            .slice(0, 16)}`,
                        rows,
                    },
                },
            });
        } catch (error) {
            throw new DreamerModuleFailureError("memory.set_verification", error);
        }
        const result = ((response as { result?: unknown })?.result ?? response) as {
            accepted?: unknown;
        };
        if (!Array.isArray(result?.accepted))
            throw new DreamerModuleFailureError(
                "memory.set_verification",
                new Error("invalid response"),
            );
        const accepted = new Set(
            result.accepted.filter((id): id is number => typeof id === "number"),
        );
        for (const write of moduleWrites) {
            const identity = identities.get(write.id);
            if (!identity || !accepted.has(identity.moduleId)) continue;
            if (write.kind === "verify") verified += 1;
            else if (write.kind === "update") updated += 1;
            else archived += 1;
        }
        return { verified, updated, archived };
    }
    runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        // The shared generation context spans the per-item claim writes, so
        // one lease-guarded transaction allocates one claim project
        // generation per touched project (KTD7).
        withMemoryClaimGenerationContextInCurrentTransaction(args.db, () => {
            // The apply-time check above precedes several awaited
            // normalizeFiles calls: re-evaluate policy and prompt-byte
            // identity as the first operation while holding the write lock,
            // so a target hidden or rewritten during normalization is
            // skipped instead of verified, rewritten, or archived.
            const eligibleInTx = maintenanceEligibleIdSet(
                args.db,
                writes.map((write) => write.id),
                "verification",
            );
            const digestsInTx = exactMemoryContentDigests(
                args.db,
                writes.map((write) => write.id),
            );
            for (const w of writes) {
                if (!stillApplicable(w.id, eligibleInTx, digestsInTx)) continue;
                const memory = getMemoryById(args.db, w.id);
                if (!isPrimaryMutable(memory)) continue;
                if (w.kind === "verify") {
                    recordMemoryVerifications(args.db, w.id, w.files, now);
                    verified += 1;
                } else if (w.kind === "update") {
                    rewriteMemoryContent(args.db, memory, w.content, w.hash);
                    queueMemoryMutation(args.db, {
                        projectPath: args.projectIdentity,
                        mutationType: "update",
                        targetMemoryId: w.id,
                        category: memory.category,
                        newContent: w.content,
                    });
                    updated += 1;
                } else {
                    archiveMemory(args.db, w.id, w.reason);
                    queueMemoryMutation(args.db, {
                        projectPath: args.projectIdentity,
                        mutationType: "archive",
                        targetMemoryId: w.id,
                    });
                    archived += 1;
                }
            }
        });
    });
    return { verified, updated, archived };
}

async function normalizeFiles(args: VerifyArgs, rawFiles: readonly string[]): Promise<string[]> {
    if (rawFiles.length === 0) return [];
    const normalized = await normalizeVerificationFiles({
        cwd: args.sessionDirectory,
        files: rawFiles,
    });
    return normalized.files;
}

function isPrimaryMutable(memory: Memory | null): memory is Memory {
    return (
        memory !== null &&
        (memory.status === "active" || memory.status === "permanent") &&
        memory.supersededByMemoryId === null
    );
}

/** Cache-neutral content rewrite (mirrors ctx_memory's in-transaction update):
 *  new content + hash, reset shareable + classified_at (re-scored later by
 *  classify), drop stale embeddings/cache, and clear old file mappings. */
function rewriteMemoryContent(db: Database, memory: Memory, content: string, hash: string): void {
    if (hasMemoryClaimsCompatSchema(db)) {
        runInMemoryClaimsWriteTransaction(db, () => {
            // The update verdict declared the previous verification wrong, so
            // the kernel clears the side table and suppresses the verified
            // carry inside the same claims transaction.
            updateMemoryContentWithClaimsInCurrentTransaction(
                db,
                {
                    producer: "dreamer-verify",
                    operationKey: `update:${randomUUID()}`,
                    requestDigest: computeClaimRequestDigest({ id: memory.id, content, hash }),
                },
                {
                    memoryId: memory.id,
                    content,
                    normalizedHash: hash,
                    clearsVerification: true,
                },
            );
        });
        invalidateMemory(memory.projectPath, memory.id);
        return;
    }
    db.prepare(
        "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
    ).run(content, hash, Date.now(), memory.id);
    if (hasMemoryShareableColumn(db)) {
        db.prepare("UPDATE memories SET shareable = 0 WHERE id = ?").run(memory.id);
    }
    if (hasMemoryClassifiedAtColumn(db)) {
        db.prepare("UPDATE memories SET classified_at = NULL WHERE id = ?").run(memory.id);
    }
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
    clearMemoryVerifications(db, memory.id);
    invalidateMemory(memory.projectPath, memory.id);
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
