import { embedAndStoreCompartmentChunks } from "../../features/magic-context/compartment-embedding";
import { insertCompartmentEvents } from "../../features/magic-context/compartment-events";
import { isCompartmentLeaseHeld } from "../../features/magic-context/compartment-lease";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { promoteSessionFactsDurable } from "../../features/magic-context/memory";
import {
    readAuthorizedClaimMemorySnapshot,
    renderClaimMemoryBlock,
} from "../../features/magic-context/memory/claim-memory-render";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import {
    clearEmergencyDrainLatch,
    clearEmergencyRecovery,
    clearHistorianDrainFailure,
    clearHistorianFailureState,
    getOverflowState,
    incrementHistorianFailure,
    isWrapupInProgress,
    recordHistorianDrainFailure,
    recordProtectedTailPublicationFloor,
    reserveProtectedTailDrainTokens,
    rollbackProtectedTailDrainReservation,
    setPendingCompactionMarkerState,
} from "../../features/magic-context/storage";
import {
    type HistorianRunInput,
    recordHistorianRun,
    summarizeImportance,
    tallyFactsByCategory,
} from "../../features/magic-context/storage-historian-runs";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { insertPrimerCandidates } from "../../features/magic-context/storage-primers";
import { getLatestHistorianInvocationId } from "../../features/magic-context/storage-subagent-invocations";
import { insertUserMemoryCandidates } from "../../features/magic-context/user-memory/storage-user-memory";
import { describeError } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { updateCompactionMarkerAfterPublication } from "./compaction-marker-manager";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import { resolveSessionDirectory } from "./compartment-runner-mapping";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";
import {
    buildHistorianFailureNotice,
    HISTORIAN_BOUNDARY_HEALING_SLACK,
    shouldDiscardLastHistorianCompartment,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation";
import { cleanupHistorianStateFile } from "./historian-state-file";
import { clearInjectionCache } from "./inject-compartments";
import { onNoteTrigger } from "./note-nudger";
import {
    createDefaultBoundarySnapshotForTests,
    hasRunnableCompartmentWindow,
    recordHighPressureNoEligibleHead,
    resolveOpenCodeProtectedTailBoundary,
    selectPerRunCap,
    validateBoundarySnapshot,
} from "./protected-tail-boundary";
import { readSessionChunk } from "./read-session-chunk";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import { buildReferenceBlocks } from "./reference-retrieval";
import { sendIgnoredMessage } from "./send-session-notification";

/* */
const HISTORIAN_ALERT_COOLDOWN_MS = 60 * 1000;
const lastHistorianAlertBySession = new Map<string, number>();

function shouldSuppressHistorianAlert(sessionId: string): boolean {
    const lastAlert = lastHistorianAlertBySession.get(sessionId);
    if (lastAlert && Date.now() - lastAlert < HISTORIAN_ALERT_COOLDOWN_MS) {
        return true;
    }
    lastHistorianAlertBySession.set(sessionId, Date.now());
    return false;
}

export async function runCompartmentAgent(deps: CompartmentRunnerDeps): Promise<void> {
    const {
        client,
        db,
        sessionId,
        historianChunkTokens,
        directory,
        historianTimeoutMs,
        getNotificationParams,
    } = deps;
    let completedSuccessfully = false;
    let retainDrainReservationForRetryThrottle = false;
    let issueNotified = false;
    let stateFilePath: string | undefined;
    let drainReservation: ReturnType<typeof reserveProtectedTailDrainTokens>["reservation"] = null;

    // The runner records telemetry in `finally` for no-op, failure, and success exits.
    const runStartedAt = Date.now();
    const invocationBaseline = getLatestHistorianInvocationId(db, sessionId);
    const telemetry: Partial<HistorianRunInput> = {
        runKind: "incremental",
        status: "failed", // pessimistic default; overwritten on no-op/success
    };
    const recordTelemetry = (): void => {
        // `recordTelemetry` links the FK only when this run recorded a new historian invocation; per-session serialization makes the newest post-baseline invocation belong to this run.
        const latest = getLatestHistorianInvocationId(db, sessionId);
        const invocationId =
            latest != null && (invocationBaseline == null || latest > invocationBaseline)
                ? latest
                : null;
        recordHistorianRun(db, {
            sessionId,
            harness: "opencode",
            subagentInvocationId: invocationId,
            runKind: telemetry.runKind ?? "incremental",
            status: telemetry.status ?? "failed",
            failureReason: telemetry.failureReason ?? null,
            chunkStartOrdinal: telemetry.chunkStartOrdinal ?? null,
            chunkEndOrdinal: telemetry.chunkEndOrdinal ?? null,
            unprocessedFrom: telemetry.unprocessedFrom ?? null,
            compartmentsProduced: telemetry.compartmentsProduced ?? 0,
            compartmentIdMin: telemetry.compartmentIdMin ?? null,
            compartmentIdMax: telemetry.compartmentIdMax ?? null,
            factsEmitted: telemetry.factsEmitted ?? 0,
            factsByCategory: telemetry.factsByCategory ?? null,
            eventsEmitted: telemetry.eventsEmitted ?? 0,
            importanceMin: telemetry.importanceMin ?? null,
            importanceMax: telemetry.importanceMax ?? null,
            importanceAvg: telemetry.importanceAvg ?? null,
            discardedLast: telemetry.discardedLast ?? false,
            legacy: telemetry.legacy ?? false,
        });
        void runStartedAt; // (kept for future duration column; timing lives on the FK row)
    };

    const notifyHistorianIssue = async (message: string): Promise<void> => {
        issueNotified = true;
        if (shouldSuppressHistorianAlert(sessionId)) {
            sessionLog(sessionId, "historian alert suppressed (cooldown):", message.slice(0, 100));
            return;
        }
        await sendIgnoredMessage(client, sessionId, message, getNotificationParams?.() ?? {});
    };

    const truncateHistorianInputIfNeeded = (text: string, budget: number): string => {
        if (estimateTokens(text) <= budget) return text;
        let lo = 0;
        let hi = text.length;
        let best = 0;
        const marker = "\n[… tokens truncated by Magic Context to fit the historian window …]";
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (estimateTokens(text.slice(0, mid) + marker) <= budget) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return text.slice(0, best) + marker;
    };

    const rollbackDrainReservation = (): void => {
        if (drainReservation) {
            rollbackProtectedTailDrainReservation(db, drainReservation);
            drainReservation = null;
        }
    };

    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        const priorCompartments = getCompartments(db, sessionId);
        // The prompt deduplicates facts against `<project-memory>`.

        const existingValidationError = validateStoredCompartments(priorCompartments);
        if (existingValidationError) {
            sessionLog(
                sessionId,
                `historian failure: source=existing-validation reason="${existingValidationError}"`,
            );
            // The runner records corrupt stored compartments so `doctor --issue` and the `>=95%` abort path can detect the failure.
            const failCount = incrementHistorianFailure(db, sessionId, existingValidationError);
            telemetry.failureReason = `existing-validation: ${existingValidationError}`;
            await notifyHistorianIssue(
                buildHistorianFailureNotice(failCount, existingValidationError),
            );
            return;
        }

        const offset =
            priorCompartments.length > 0
                ? priorCompartments[priorCompartments.length - 1].endMessage + 1
                : 1;

        let boundarySnapshot =
            deps.boundarySnapshot ??
            (process.env.NODE_ENV === "test"
                ? createDefaultBoundarySnapshotForTests(sessionId)
                : null);
        if (!boundarySnapshot) {
            telemetry.failureReason = "missing protected-tail boundary snapshot";
            sessionLog(
                sessionId,
                "historian no-op: missing protected-tail boundary snapshot from trigger decision",
            );
            rollbackDrainReservation();
            return;
        }
        let validation =
            boundarySnapshot.rawRangeFingerprint.length > 0
                ? validateBoundarySnapshot({
                      db,
                      snapshot: boundarySnapshot,
                      currentContextLimit:
                          deps.currentContextLimit ?? boundarySnapshot.contextLimit,
                  })
                : { ok: true };
        // The runner refreshes a stale boundary snapshot only when the current boundary still exposes a runnable head.
        if (!validation.ok && validation.reason === "stale_snapshot") {
            const refreshed = deps.refreshBoundarySnapshot
                ? deps.refreshBoundarySnapshot(boundarySnapshot, validation)
                : resolveOpenCodeProtectedTailBoundary({
                      db,
                      sessionId,
                      mode: "incremental-runner",
                      contextLimit: deps.currentContextLimit ?? boundarySnapshot.contextLimit,
                      executeThresholdPercentage: boundarySnapshot.executeThresholdPercentage,
                      usage: {
                          percentage: boundarySnapshot.usagePercentage,
                          inputTokens: boundarySnapshot.usageInputTokens,
                      },
                      usageSource: boundarySnapshot.usageSource,
                      emergencyTailScale: boundarySnapshot.emergencyTailScale,
                  });
            if (refreshed && hasRunnableCompartmentWindow(refreshed)) {
                sessionLog(
                    sessionId,
                    `historian: refreshed stale protected-tail snapshot at run time (was: ${validation.detail ?? "stale"}) — eligible head ${refreshed.offset}-${refreshed.eligibleEndOrdinal - 1}`,
                );
                boundarySnapshot = refreshed;
                validation = { ok: true };
            }
        }
        if (!validation.ok) {
            sessionLog(
                sessionId,
                `historian no-op: stale protected-tail snapshot (${validation.detail ?? validation.reason ?? "unknown"})`,
            );
            telemetry.status = "noop";
            telemetry.failureReason = "stale_snapshot";
            rollbackDrainReservation();
            return;
        }

        const protectedTailStart = Math.min(
            boundarySnapshot.protectedTailStart,
            boundarySnapshot.rawMessageCountAtTrigger + 1,
        );
        const eligibleEndOrdinal = Math.min(
            boundarySnapshot.eligibleEndOrdinal,
            protectedTailStart,
        );
        if (protectedTailStart <= offset || eligibleEndOrdinal <= offset) {
            sessionLog(
                sessionId,
                `historian no-op: protectedTailStart=${protectedTailStart} eligibleEnd=${eligibleEndOrdinal} <= offset=${offset} — nothing to compact`,
            );
            if (boundarySnapshot.usagePercentage < 80 && !boundarySnapshot.emergencyTailScale) {
                if (!isWrapupInProgress(db, sessionId)) clearEmergencyRecovery(db, sessionId);
            } else {
                const count = recordHighPressureNoEligibleHead(db, boundarySnapshot);
                sessionLog(
                    sessionId,
                    `historian high-pressure no-op: recovery remains armed (noEligibleHeadCount=${count})`,
                );
            }
            // The runner clears the emergency catch-up latch because an exhausted tail has nothing left to drain.
            // The runner clears the emergency catch-up latch because an exhausted tail has nothing left to drain.
            clearEmergencyDrainLatch(db, sessionId);
            telemetry.status = "noop";
            telemetry.failureReason = "nothing to compact before protected tail";
            rollbackDrainReservation();
            return;
        }

        const perRunCap = selectPerRunCap(boundarySnapshot);
        const usable = Math.max(
            1,
            Math.round(
                (boundarySnapshot.contextLimit * boundarySnapshot.executeThresholdPercentage) / 100,
            ),
        );
        const reserve = deps.forceDrainQuota
            ? { ok: true as const, reservation: null }
            : reserveProtectedTailDrainTokens({
                  db,
                  sessionId,
                  runId: crypto.randomUUID(),
                  trueRawTokens: boundarySnapshot.trueRawEligibleTokens,
                  usagePercentage: boundarySnapshot.usagePercentage,
                  usable,
                  perRunCap,
                  executeThresholdPercentage: boundarySnapshot.executeThresholdPercentage,
              });
        if (!reserve.ok) {
            sessionLog(
                sessionId,
                `historian rate-limit skip: ${reserve.skippedReason ?? "quota exhausted"}`,
            );
            telemetry.status = "noop";
            telemetry.failureReason = "protected-tail drain quota exhausted";
            return;
        }
        drainReservation = reserve.reservation;

        const chunk = readSessionChunk(sessionId, historianChunkTokens, offset, eligibleEndOrdinal);
        const forceKeepLastCompartmentForChunk =
            deps.forceKeepLastCompartment === true && !chunk.hasMore;
        telemetry.chunkStartOrdinal = chunk.startIndex;
        telemetry.chunkEndOrdinal = chunk.endIndex;
        if (!chunk.text || chunk.messageCount === 0) {
            sessionLog(
                sessionId,
                `historian no-op: chunk empty after filtering (messageCount=${chunk.messageCount}, textLen=${chunk.text?.length ?? 0}) range=${offset}-${eligibleEndOrdinal - 1}`,
            );
            if (boundarySnapshot.usagePercentage < 80 && !boundarySnapshot.emergencyTailScale) {
                if (!isWrapupInProgress(db, sessionId)) clearEmergencyRecovery(db, sessionId);
            } else {
                recordHighPressureNoEligibleHead(db, boundarySnapshot);
            }
            // The runner treats an eligible head that produces no compactable chunk as tail-exhausted and clears the catch-up latch.
            // The runner treats an eligible head that produces no compactable chunk as tail-exhausted and clears the catch-up latch.
            clearEmergencyDrainLatch(db, sessionId);
            telemetry.status = "noop";
            telemetry.failureReason = "chunk empty after filtering";
            rollbackDrainReservation();
            return;
        }
        const chunkText = truncateHistorianInputIfNeeded(chunk.text, historianChunkTokens);
        if (chunkText !== chunk.text) {
            sessionLog(
                sessionId,
                `historian pre-flight: truncated formatted input for ${chunk.startIndex}-${chunk.endIndex} to fit ${historianChunkTokens} tokens`,
            );
        }

        const chunkCoverageError = validateChunkCoverage(chunk);
        if (chunkCoverageError) {
            telemetry.failureReason = `chunk-coverage: ${chunkCoverageError}`;
            sessionLog(
                sessionId,
                `historian failure: source=chunk-coverage reason="${chunkCoverageError}" chunkRange=${chunk.startIndex}-${chunk.endIndex}`,
            );
            // The runner records the failure so `doctor --issue` and the `>=95%` abort can react.
            // diagnostics.
            const failCount = incrementHistorianFailure(db, sessionId, chunkCoverageError);
            await notifyHistorianIssue(buildHistorianFailureNotice(failCount, chunkCoverageError));
            rollbackDrainReservation();
            return;
        }

        // `runCompartmentAgent` calls `onHistorianRunStarted` before its first `await` so synchronous no-ops do not retain the active-run registration.
        deps.onHistorianRunStarted?.();

        // `buildReferenceBlocks` bounds references to four rotating cross-project seeds and six recent session compartments.
        // `buildReferenceBlocks` uses four rotating cross-project seeds and six recent session compartments without historian-time embeddings.
        // The runner builds session-derived references without historian-time embeddings.
        //     compartments.
        // `<project-memory>` deduplicates facts.
        // serialization limits.
        const projectPath = resolveProjectIdentity(directory ?? process.cwd());

        const references = buildReferenceBlocks({
            sessionId,
            chunkStart: chunk.startIndex,
            sessionCompartments: priorCompartments,
        });

        const sessionDirectory = await resolveSessionDirectory(client, sessionId, directory);

        const memorySnapshot = readAuthorizedClaimMemorySnapshot(db, {
            authorizedIdentities: [projectPath],
            ownIdentities: [projectPath],
            sharedCategories: [],
            workspaceEpoch: `historian:${sessionId}:${chunk.startIndex}-${chunk.endIndex}`,
        });
        if (!memorySnapshot) {
            sessionLog(sessionId, "historian claim snapshot remained stale; omitting memories");
        }
        const projectMemory = renderClaimMemoryBlock(memorySnapshot?.items ?? []) ?? "";

        const prompt = buildCompartmentAgentPrompt({
            seedExamples: references.seedExamples,
            sessionReferences: references.sessionReferences,
            projectMemory,
            inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunkText}`,
            memoryEnabled: deps.memoryEnabled !== false,
        });

        // `MAX(sequence) + 1` avoids unique-key collisions when persisted sequences contain gaps or do not start at zero.
        const maxExistingSequence = priorCompartments.reduce(
            (max, c) => (c.sequence > max ? c.sequence : max),
            -1,
        );
        const sequenceOffset = priorCompartments.length === 0 ? 0 : maxExistingSequence + 1;

        retainDrainReservationForRetryThrottle = true;
        const validatedPass = await runValidatedHistorianPass({
            client,
            db,
            parentSessionId: sessionId,
            sessionDirectory,
            prompt,
            chunk,
            priorCompartments,
            sequenceOffset,
            dumpLabelBase: `incremental-${sessionId}-${chunk.startIndex}-${chunk.endIndex}`,
            timeoutMs: historianTimeoutMs,
            fallbackModelId: deps.fallbackModelId,
            fallbackModels: deps.fallbackModels,
            twoPass: deps.historianTwoPass,
            language: deps.language,
        });
        if (!validatedPass.ok) {
            // The runner tracks historian failures regardless of usage percentage.
            // The runner records failures at every pressure level because the 95% emergency abort checks `failureCount > 0`.
            sessionLog(
                sessionId,
                `historian failure: source=validation reason="${validatedPass.error}" chunkRange=${chunk.startIndex}-${chunk.endIndex} fallbackModel=${deps.fallbackModelId ?? "<none>"} twoPass=${deps.historianTwoPass ? "true" : "false"}`,
            );
            const failCount = incrementHistorianFailure(db, sessionId, validatedPass.error);
            telemetry.failureReason = `validation: ${validatedPass.error}`;
            await notifyHistorianIssue(buildHistorianFailureNotice(failCount, validatedPass.error));
            return;
        }
        retainDrainReservationForRetryThrottle = false;

        const emittedCompartments = validatedPass.compartments;

        // Consumption that leaves at most `BOUNDARY_HEALING_SLACK` messages after the final compartment causes the runner to discard it because it lacked lookahead; the next run rederives it with following context.
        // After discarding the last compartment, the next run re-reads its range.
        // At least two emitted compartments leave one retained compartment, allowing publication to advance.
        //   - the retained boundary cannot split a completed invocation/result pair.
        // Emergency recovery keeps all compartments to maximize relief.
        // If a discard is wrong, the next run re-derives the compartment with following context.
        const inEmergency = getOverflowState(db, sessionId).needsEmergencyRecovery;
        let persistedCompartments = emittedCompartments;
        if (
            !inEmergency &&
            !forceKeepLastCompartmentForChunk &&
            shouldDiscardLastHistorianCompartment(emittedCompartments, chunk)
        ) {
            const lastEmitted = emittedCompartments[emittedCompartments.length - 1];
            const lookaheadMargin = chunk.endIndex - lastEmitted.endMessage;
            persistedCompartments = emittedCompartments.slice(0, -1);
            telemetry.discardedLast = true;
            sessionLog(
                sessionId,
                `historian discard-last: dropped provisional compartment ${lastEmitted.startMessage}-${lastEmitted.endMessage} (lookaheadMargin=${lookaheadMargin} <= ${HISTORIAN_BOUNDARY_HEALING_SLACK}); will re-derive from raw next run`,
            );
        }

        const newCompartments = persistedCompartments;

        const lastNewEnd = newCompartments[newCompartments.length - 1]?.endMessage ?? 0;
        if (lastNewEnd + 1 <= offset) {
            telemetry.failureReason = `no forward progress beyond raw message ${offset - 1}`;
            sessionLog(
                sessionId,
                `historian failure: source=no-progress reason="historian returned compartments that did not advance past raw message ${offset - 1}" newCompartmentCount=${newCompartments.length} lastNewEnd=${lastNewEnd} priorEnd=${offset - 1}`,
            );
            const failCount = incrementHistorianFailure(
                db,
                sessionId,
                `no forward progress beyond raw message ${offset - 1}`,
            );
            await notifyHistorianIssue(
                buildHistorianFailureNotice(
                    failCount,
                    `historian made no forward progress beyond raw message ${offset - 1}`,
                ),
            );
            return;
        }

        retainDrainReservationForRetryThrottle = false;

        // The runner defers marker movement to preserve the injection cache.
        // Publication persists the pending blob so a crash cannot lose the deferred marker update.
        // `transform-postprocess-phase` drains the blob with `applyDeferredCompactionMarker`.
        // `applyDeferredCompactionMarker`.
        //
        // Non-deferring callers apply the compaction marker directly.
        // Recomp, partial recomp, and explicit flushes clear the injection cache eagerly.
        // Non-deferring callers clear the injection cache eagerly.
        const deferMarkerApplication = deps.preserveInjectionCacheUntilConsumed === true;

        const lastCompartmentEnd = lastNewEnd;
        const lastNewEndMessageId = newCompartments[newCompartments.length - 1]?.endMessageId;

        // The session can have a valid resolved directory when `deps.directory` is empty.
        // `sessionDirectory` can keep promotion and embedding active when `deps.directory` is empty.
        const promotionDirectory = sessionDirectory || deps.directory;

        // After discard-last, skip unanchored promotion because persisted-range facts cannot be distinguished from discarded-tail facts.
        // A wrapup persists its final weak-lookahead tail for coverage.
        // A token-capped chunk must use normal discard-last healing because raw history remains after it.
        // promotion.
        const discardedLast = persistedCompartments.length < emittedCompartments.length;
        const weakLookaheadFinalCompartment = forceKeepLastCompartmentForChunk;
        const skipUnanchoredPromotion = discardedLast || weakLookaheadFinalCompartment;

        // Project-memory promotion requires both `memory.enabled` and `memory.auto_promote`.
        // Embedding and project registration require `promotionDirectory` and `memory.enabled`, but not `memory.auto_promote`.
        const embeddingActive = !!promotionDirectory && deps.memoryEnabled !== false;
        const promotionActive = embeddingActive && deps.autoPromote !== false;
        const promotionProjectIdentity = promotionDirectory
            ? resolveProjectIdentity(promotionDirectory)
            : "";

        const publishableEvents = (validatedPass.events ?? []).filter((e) => {
            if (typeof e.atCompartment !== "number") return !weakLookaheadFinalCompartment;
            if (e.atCompartment > persistedCompartments.length) return false;
            if (weakLookaheadFinalCompartment && e.atCompartment >= emittedCompartments.length) {
                return false;
            }
            return true;
        });
        let persistedIds: number[] = [];

        // The transaction atomically appends compartments and publishes synchronous durable side effects.
        // `BEGIN IMMEDIATE` makes the lease check and subsequent writes share a fresh write-locked snapshot across sibling processes.
        const holderId = deps.compartmentLeaseHolderId;
        if (!holderId) {
            sessionLog(sessionId, "historian publish skipped: missing compartment lease holder");
            rollbackDrainReservation();
            return;
        }
        let published = false;
        db.exec("BEGIN IMMEDIATE");
        try {
            if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
                db.exec("ROLLBACK");
                rollbackDrainReservation();
                sessionLog(
                    sessionId,
                    "historian publish skipped: compartment lease no longer held",
                );
                return;
            }
            appendCompartments(db, sessionId, persistedCompartments);
            // The appended compartments occupy the last `persistedCompartments.length` rows by sequence.
            // Event anchoring uses the appended compartments' durable IDs.
            persistedIds = getCompartments(db, sessionId)
                .slice(-persistedCompartments.length)
                .map((c) => c.id);
            // In-transaction promotion writes extracted facts to project memory.
            // Promotion and boundary-floor updates share one transaction so a crash cannot advance the boundary past unpersisted facts.
            // project memories.
            if (promotionActive && !skipUnanchoredPromotion) {
                promoteSessionFactsDurable(
                    db,
                    sessionId,
                    promotionProjectIdentity,
                    validatedPass.facts ?? [],
                    {
                        producer: "opencode-historian",
                        runId: `${sessionId}:${chunk.startIndex}:${chunk.endIndex}`,
                        leaseKey: `compartment:${sessionId}`,
                        leaseGeneration: holderId,
                        batchId: `${chunk.startIndex}-${lastCompartmentEnd}`,
                    },
                );
            }

            // Event persistence does not depend on memory flags.
            // Event storage failures log without aborting fact or boundary publication.
            if (publishableEvents.length > 0) {
                try {
                    insertCompartmentEvents(db, sessionId, publishableEvents, persistedIds);
                    sessionLog(
                        sessionId,
                        `stored ${publishableEvents.length} compartment event(s)`,
                    );
                } catch (error) {
                    sessionLog(sessionId, "failed to store compartment events:", error);
                }
            }

            queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);

            clearHistorianFailureState(db, sessionId);
            clearHistorianDrainFailure(db, sessionId);
            // Emergency recovery remains armed while `isWrapupInProgress(db, sessionId)` is true.
            recordProtectedTailPublicationFloor(db, sessionId, lastCompartmentEnd + 1);
            if (!isWrapupInProgress(db, sessionId)) clearEmergencyRecovery(db, sessionId);
            drainReservation = null;
            if (deferMarkerApplication && lastNewEndMessageId) {
                setPendingCompactionMarkerState(db, sessionId, {
                    ordinal: lastCompartmentEnd,
                    endMessageId: lastNewEndMessageId,
                    publishedAt: Date.now(),
                });
            }
            db.exec("COMMIT");
            published = true;
        } finally {
            if (!published) {
                try {
                    db.exec("ROLLBACK");
                } catch {
                    // Transaction may already be closed by an early rollback.
                }
            }
        }
        // preserveInjectionCacheUntilConsumed=true delays injection-cache invalidation until queued drops are consumed.
        // A materializing pass rebuilds history and applies queued drops before invalidating the injection cache.
        // preserveInjectionCacheUntilConsumed=false invalidates the injection cache immediately.
        // immediately.
        if (deps.preserveInjectionCacheUntilConsumed !== true) {
            clearInjectionCache(sessionId);
        }

        // onCompartmentStatePublished runs after COMMIT and before post-commit provider work.
        // The transaction persists compartments, the boundary floor, promoted facts, event attempts, and the drop queue before publication is signaled.
        // Post-commit provider failures do not change the published state.
        deps.onCompartmentStatePublished?.(sessionId);

        // updateCompactionMarkerAfterPublication writes the compaction marker to OpenCode's DB.
        // When deferMarkerApplication is true, the transaction writes the pending marker before onDeferredMarkerPending signals the drain set.
        if (deferMarkerApplication) {
            deps.onDeferredMarkerPending?.(sessionId);
        } else {
            updateCompactionMarkerAfterPublication(
                db,
                sessionId,
                lastCompartmentEnd,
                sessionDirectory,
            );
        }

        // decay-render.ts demotes older compartment tiers during rendering without an LLM call.
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        completedSuccessfully = true;

        // Historian records one `historian_runs` row for every exit path.
        {
            const facts = validatedPass.facts ?? [];
            const validIds = persistedIds.filter((id): id is number => typeof id === "number");
            const imp = summarizeImportance(persistedCompartments.map((c) => c.importance ?? 50));
            telemetry.status = "success";
            telemetry.failureReason = null;
            telemetry.unprocessedFrom = lastCompartmentEnd + 1;
            telemetry.compartmentsProduced = persistedCompartments.length;
            telemetry.compartmentIdMin = validIds.length > 0 ? Math.min(...validIds) : null;
            telemetry.compartmentIdMax = validIds.length > 0 ? Math.max(...validIds) : null;
            telemetry.factsEmitted = facts.length;
            telemetry.factsByCategory = facts.length > 0 ? tallyFactsByCategory(facts) : null;
            telemetry.eventsEmitted = publishableEvents.length;
            telemetry.importanceMin = imp.min;
            telemetry.importanceMax = imp.max;
            telemetry.importanceAvg = imp.avg;
            // legacy stays false — incremental publish always produces v2 rows.
        }

        onNoteTrigger(db, sessionId, "historian_complete");

        // Memory-enabled sessions store raw chunk embeddings best-effort; memory-off sessions never call the embedding endpoint.
        if (embeddingActive) {
            const chunksToEmbed = persistedCompartments
                .map((c, i) => ({
                    id: persistedIds[i],
                    startMessage: c.startMessage,
                    endMessage: c.endMessage,
                    sourceChunkText: chunk.text,
                }))
                .filter((c) => typeof c.id === "number");
            void (async () => {
                try {
                    await deps.ensureProjectRegistered?.(promotionDirectory, db);
                } catch (error) {
                    sessionLog(sessionId, "project registration after publish failed:", error);
                }
                try {
                    await embedAndStoreCompartmentChunks(
                        db,
                        sessionId,
                        promotionProjectIdentity,
                        chunksToEmbed,
                    );
                } catch (error) {
                    sessionLog(sessionId, "compartment embedding dispatch failed:", error);
                }
            })();
        }

        // The user-memory feature gate permits behavioral candidates only when user memory is enabled.
        if (
            deps.experimentalUserMemories === true &&
            !skipUnanchoredPromotion &&
            validatedPass.userObservations &&
            validatedPass.userObservations.length > 0
        ) {
            try {
                const lastNew = newCompartments[newCompartments.length - 1];
                insertUserMemoryCandidates(
                    db,
                    validatedPass.userObservations.map((obs) => ({
                        content: obs,
                        sessionId,
                        sourceCompartmentStart: newCompartments[0]?.startMessage,
                        sourceCompartmentEnd: lastNew?.endMessage,
                    })),
                );
                sessionLog(
                    sessionId,
                    `stored ${validatedPass.userObservations.length} user memory candidate(s)`,
                );
            } catch (error) {
                sessionLog(sessionId, "failed to store user memory candidates:", error);
            }
        }

        if (
            !skipUnanchoredPromotion &&
            promotionProjectIdentity &&
            validatedPass.primerCandidates &&
            validatedPass.primerCandidates.length > 0
        ) {
            try {
                const firstNew = newCompartments[0];
                const lastNew = newCompartments[newCompartments.length - 1];
                const [candidate] = validatedPass.primerCandidates;
                // The origin tag narrows the source to the specific compartment that produced the question.
                // originCompartmentIndex is 1-based into newCompartments.
                // The fallback uses the chunk span when originCompartmentIndex does not select a compartment.
                const idx = candidate.originCompartmentIndex;
                const origin =
                    typeof idx === "number" && idx >= 1 && idx <= newCompartments.length
                        ? newCompartments[idx - 1]
                        : undefined;
                const startC = origin ?? firstNew;
                const endC = origin ?? lastNew;
                const sourceStartMessageId =
                    startC?.startMessageId || `ordinal:${startC?.startMessage ?? chunk.startIndex}`;
                const sourceEndMessageId =
                    endC?.endMessageId || `ordinal:${endC?.endMessage ?? lastCompartmentEnd}`;
                const times = getMessageTimesFromOpenCodeDb(sessionId, [sourceStartMessageId]);
                const sourceMessageTime = times.get(sourceStartMessageId) ?? Date.now();
                const stored = insertPrimerCandidates(db, [
                    {
                        projectPath: promotionProjectIdentity,
                        harness: "opencode",
                        sessionId,
                        question: candidate.question,
                        sourceCompartmentStart: startC?.startMessage,
                        sourceCompartmentEnd: endC?.endMessage,
                        sourceStartMessageId,
                        sourceEndMessageId,
                        sourceMessageTime,
                    },
                ]);
                sessionLog(
                    sessionId,
                    `stored ${stored.length} primer candidate occurrence(s)${origin ? " (origin-tagged)" : " (chunk-span fallback)"}`,
                );
            } catch (error) {
                sessionLog(sessionId, "failed to store primer candidates:", error);
            }
        }
    } catch (error: unknown) {
        const desc = describeError(error);
        telemetry.failureReason = `exception: ${desc.brief}`;
        sessionLog(
            sessionId,
            `historian failure: source=exception ${desc.brief}${desc.stackHead ? ` stackHead="${desc.stackHead}"` : ""}`,
        );
        if (!issueNotified) {
            const failCount = incrementHistorianFailure(db, sessionId, desc.brief);
            await notifyHistorianIssue(buildHistorianFailureNotice(failCount, desc.brief));
        }
    } finally {
        if (!completedSuccessfully) {
            if (!retainDrainReservationForRetryThrottle) {
                rollbackDrainReservation();
            } else {
                recordHistorianDrainFailure(db, sessionId);
            }
            updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        }
        recordTelemetry();
        cleanupHistorianStateFile(stateFilePath);
    }
}
