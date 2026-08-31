import { HISTORIAN_RECOMP_AGENT } from "../../agents/historian";
import { embedAndStoreCompartmentChunks } from "../../features/magic-context/compartment-embedding";
import { isCompartmentLeaseHeld } from "../../features/magic-context/compartment-lease";
import {
    clearRecompStaging,
    getCompartments,
    getRecompStaging,
    saveRecompStagingPass,
} from "../../features/magic-context/compartment-storage";
import { clearCompressionDepth } from "../../features/magic-context/compression-depth-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { appendM0Mutation } from "../../features/magic-context/storage";
import {
    recordHistorianRun,
    summarizeImportance,
    tallyFactsByCategory,
} from "../../features/magic-context/storage-historian-runs";
import { clearCachedM0M1, updateSessionMeta } from "../../features/magic-context/storage-meta";
import { getErrorMessage } from "../../shared/error-message";
import { getHarness } from "../../shared/harness";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { advanceCompactionMarkerAndClearStalePending } from "./compaction-marker-manager";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import { resolveSessionDirectory } from "./compartment-runner-mapping";
import type { CandidateCompartment, CompartmentRunnerDeps } from "./compartment-runner-types";
import {
    getReducedRecompTokenBudget,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation";
import { cleanupHistorianStateFile } from "./historian-state-file";
import { clearInjectionCache } from "./inject-compartments";
import {
    createDefaultBoundarySnapshotForTests,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import { getRawSessionMessageCount, readSessionChunk } from "./read-session-chunk";
import { buildReferenceBlocks } from "./reference-retrieval";
import { sendIgnoredMessage } from "./send-session-notification";

function insertRecompCompartmentRows(
    db: Database,
    sessionId: string,
    compartments: CandidateCompartment[],
    now: number,
): void {
    // The INSERT column order must match compartment-storage.ts insertCompartmentRows.
    const stmt = db.prepare(
        "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of compartments) {
        const hasTiers = typeof c.p1 === "string" && c.p1.length > 0;
        stmt.run(
            sessionId,
            c.sequence,
            c.startMessage,
            c.endMessage,
            c.startMessageId,
            c.endMessageId,
            c.title,
            c.content,
            c.p1 ?? null,
            c.p2 ?? null,
            c.p3 ?? null,
            c.p4 ?? null,
            typeof c.importance === "number" ? c.importance : 50,
            c.episodeType ?? null,
            hasTiers ? 0 : 1,
            now,
            getHarness(),
        );
    }
}

export function promoteRecompStagingWithM0Mutation(
    db: Database,
    sessionId: string,
    holderId: string,
): {
    compartments: CandidateCompartment[];
    facts: Array<{ category: string; content: string }>;
} | null {
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }

        const staging = getRecompStaging(db, sessionId);
        if (!staging || staging.compartments.length === 0) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }

        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        // Recomp does not write session_facts.
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
        insertRecompCompartmentRows(db, sessionId, staging.compartments, now);
        appendM0Mutation(db, {
            sessionId,
            mutationType: "recomp_boundary_change",
            targetId: null,
            queuedAt: now,
        });
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);
        clearCachedM0M1(db, sessionId);

        db.exec("COMMIT");
        finished = true;
        return { compartments: staging.compartments, facts: staging.facts };
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {}
        }
    }
}

export async function executeContextRecompInternal(deps: CompartmentRunnerDeps): Promise<string> {
    const {
        client,
        db,
        sessionId,
        historianChunkTokens,
        directory,
        historianTimeoutMs,
        getNotificationParams,
    } = deps;
    const notifParams = () => getNotificationParams?.() ?? {};
    const holderId = deps.compartmentLeaseHolderId;
    if (!holderId) {
        return "## Magic Recomp — Skipped\n\nCould not acquire the compartment-state lease for this session.";
    }
    const leaseHolderId = holderId;
    let currentStateFilePath: string | undefined;
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        const rawMessageCount = getRawSessionMessageCount(sessionId);
        const boundarySnapshot =
            process.env.NODE_ENV === "test"
                ? createDefaultBoundarySnapshotForTests(sessionId)
                : resolveOpenCodeProtectedTailBoundary({
                      db,
                      sessionId,
                      mode: "manual-full-recomp",
                      contextLimit: 128_000,
                      executeThresholdPercentage: 65,
                      usage: null,
                      usageSource: "provisional-zero",
                  });
        const protectedTailStart = Math.min(
            boundarySnapshot.protectedTailStart,
            rawMessageCount + 1,
        );
        if (rawMessageCount <= 0) {
            return "## Magic Recomp\n\nNo raw history exists, so nothing was rebuilt.";
        }
        const sessionDirectory = await resolveSessionDirectory(client, sessionId, directory);

        const existingStaging = getRecompStaging(db, sessionId);
        let candidateCompartments: CandidateCompartment[] = existingStaging?.compartments ?? [];
        let candidateFacts: Array<{ category: string; content: string }> =
            existingStaging?.facts ?? [];
        let offset = existingStaging ? existingStaging.lastEndMessage + 1 : 1;
        let passCount = existingStaging?.passCount ?? 0;
        let currentTokenBudget = historianChunkTokens;
        let passAttempt = 1;
        const resumed = existingStaging !== null;

        if (resumed) {
            await sendIgnoredMessage(
                client,
                sessionId,
                `## Magic Recomp — Resumed\n\nFound ${existingStaging.compartments.length} staged compartment(s) from ${existingStaging.passCount} previous pass(es), covering messages 1-${existingStaging.lastEndMessage}. Resuming from message ${offset}.`,
                notifParams(),
            );
        }

        const totalMessages = Math.max(0, protectedTailStart - 1);
        const progressStartedAt = Date.now();
        const emitProgress = (note?: string): void => {
            try {
                deps.onRecompProgress?.({
                    sessionId,
                    phase: "recomp",
                    processedMessages: Math.min(offset, totalMessages),
                    totalMessages,
                    passCount,
                    compartmentsCreated: candidateCompartments.length,
                    startedAt: progressStartedAt,
                    updatedAt: Date.now(),
                    note,
                });
            } catch {}
        };
        emitProgress("Preparing…");

        /**
         * */
        async function promoteAndFinalize(reason: string): Promise<string | null> {
            if (passCount === 0 || candidateCompartments.length === 0) return null;

            const mergedError = validateStoredCompartments(candidateCompartments);
            if (mergedError) return null;

            saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, candidateFacts);

            const promoted = promoteRecompStagingWithM0Mutation(db, sessionId, leaseHolderId);
            if (!promoted) return null;

            clearCompressionDepth(db, sessionId);

            if (deps.preserveInjectionCacheUntilConsumed !== true) {
                clearInjectionCache(sessionId);
            }

            void promoted.facts;

            if (deps.memoryEnabled !== false) {
                const projectIdentity = resolveProjectIdentity(sessionDirectory);
                await deps.ensureProjectRegistered?.(sessionDirectory, db);
                const liveCompartments = getCompartments(db, sessionId);
                const chunksToEmbed = liveCompartments.map((c) => ({
                    id: c.id,
                    startMessage: c.startMessage,
                    endMessage: c.endMessage,
                }));
                void embedAndStoreCompartmentChunks(db, sessionId, projectIdentity, chunksToEmbed);
            }

            const lastCompartmentEnd =
                promoted.compartments[promoted.compartments.length - 1]?.endMessage ?? 0;
            if (lastCompartmentEnd > 0) {
                queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);
            }

            deps.onCompartmentStatePublished?.(sessionId);

            if (lastCompartmentEnd > 0) {
                advanceCompactionMarkerAndClearStalePending(
                    db,
                    sessionId,
                    lastCompartmentEnd,
                    deps.directory,
                );
            }

            return [
                `Persisted ${promoted.compartments.length} compartment${promoted.compartments.length === 1 ? "" : "s"} from ${passCount} successful pass${passCount === 1 ? "" : "es"}.`,
                `Covered raw history 1-${lastCompartmentEnd} out of ${rawMessageCount} total messages.`,
                `Remaining messages ${lastCompartmentEnd + 1}-${protectedTailStart - 1} were not rebuilt (${reason}).`,
            ].join("\n");
        }

        while (offset < protectedTailStart) {
            const chunk = readSessionChunk(
                sessionId,
                currentTokenBudget,
                offset,
                protectedTailStart,
            );
            if (!chunk.text || chunk.messageCount === 0 || chunk.endIndex < offset) {
                const promoted = await promoteAndFinalize(
                    `remaining messages ${offset}-${protectedTailStart - 1} were too few or all noise to form a historian chunk`,
                );
                if (promoted) {
                    return `## Magic Recomp — Complete\n\n${promoted}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp stopped because raw history ${offset}-${protectedTailStart - 1} could not be turned into a valid historian chunk. Nothing was written.`;
            }

            const chunkCoverageError = validateChunkCoverage(chunk);
            if (chunkCoverageError) {
                const partial = await promoteAndFinalize(
                    `chunk could not be represented safely: ${chunkCoverageError}`,
                );
                if (partial) {
                    return `## Magic Recomp — Partial\n\n${partial}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp stopped because the raw chunk could not be represented safely: ${chunkCoverageError}\n\nNothing was written.`;
            }

            const references = buildReferenceBlocks({
                sessionId,
                chunkStart: chunk.startIndex,
                sessionCompartments: candidateCompartments,
            });

            const prompt = buildCompartmentAgentPrompt({
                seedExamples: references.seedExamples,
                sessionReferences: references.sessionReferences,
                projectMemory: "",
                inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
                memoryEnabled: false,
                extractionFree: true,
            });

            await sendIgnoredMessage(
                client,
                sessionId,
                `## Magic Recomp\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} started for messages ${chunk.startIndex}-${chunk.endIndex}.`,
                notifParams(),
            );
            emitProgress(`Running historian (pass ${passCount + 1})…`);

            const validatedPass = await runValidatedHistorianPass({
                client,
                db,
                parentSessionId: sessionId,
                sessionDirectory,
                prompt,
                chunk,
                priorCompartments: candidateCompartments,
                sequenceOffset: candidateCompartments.length,
                dumpLabelBase: `recomp-${sessionId}-${chunk.startIndex}-${chunk.endIndex}-pass-${passCount + 1}`,
                timeoutMs: historianTimeoutMs,
                fallbackModelId: deps.fallbackModelId,
                fallbackModels: deps.fallbackModels,
                twoPass: deps.historianTwoPass,
                subagentKind: "recomp",
                agentId: HISTORIAN_RECOMP_AGENT,
                language: deps.language,
                callbacks: {
                    onRepairRetry: async (error) => {
                        emitProgress(`Repair retry (pass ${passCount + 1})…`);
                        await sendIgnoredMessage(
                            client,
                            sessionId,
                            `## Magic Recomp\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} is continuing with a repair retry for messages ${chunk.startIndex}-${chunk.endIndex}.\n\nThe previous output did not validate: ${error}`,
                            notifParams(),
                        );
                    },
                    onModelFallback: (modelId, index, total) => {
                        const short = modelId.includes("/") ? modelId.split("/").pop() : modelId;
                        emitProgress(`Trying fallback ${short} (${index}/${total})…`);
                    },
                },
            });
            if (!validatedPass.ok) {
                const reducedBudget = getReducedRecompTokenBudget(currentTokenBudget);
                if (reducedBudget !== null) {
                    const smallerChunk = readSessionChunk(
                        sessionId,
                        reducedBudget,
                        offset,
                        protectedTailStart,
                    );
                    if (smallerChunk.messageCount > 0 && smallerChunk.endIndex < chunk.endIndex) {
                        await sendIgnoredMessage(
                            client,
                            sessionId,
                            `## Magic Recomp\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} is continuing with a smaller chunk ending at ${smallerChunk.endIndex} because messages ${chunk.startIndex}-${chunk.endIndex} could not be validated.\n\nValidator result: ${validatedPass.error}`,
                            notifParams(),
                        );
                        currentTokenBudget = reducedBudget;
                        passAttempt += 1;
                        continue;
                    }
                }

                recordHistorianRun(db, {
                    sessionId,
                    harness: getHarness(),
                    subagentInvocationId: validatedPass.invocationId ?? null,
                    runKind: "recomp",
                    status: "failed",
                    failureReason: validatedPass.error,
                    chunkStartOrdinal: chunk.startIndex,
                    chunkEndOrdinal: chunk.endIndex,
                    compartmentsProduced: 0,
                });

                const partial = await promoteAndFinalize(
                    `historian failed to validate messages ${chunk.startIndex}-${chunk.endIndex}: ${validatedPass.error}`,
                );
                if (partial) {
                    return `## Magic Recomp — Partial\n\n${partial}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp failed while rebuilding messages ${chunk.startIndex}-${chunk.endIndex}: ${validatedPass.error}\n\nNothing was written.`;
            }

            {
                const passComps = validatedPass.compartments ?? [];
                const passFacts = validatedPass.facts ?? [];
                const imp = summarizeImportance(passComps.map((c) => c.importance ?? 50));
                recordHistorianRun(db, {
                    sessionId,
                    harness: getHarness(),
                    subagentInvocationId: validatedPass.invocationId ?? null,
                    runKind: "recomp",
                    status: "success",
                    chunkStartOrdinal: chunk.startIndex,
                    chunkEndOrdinal: chunk.endIndex,
                    unprocessedFrom: passComps[passComps.length - 1]?.endMessage ?? null,
                    compartmentsProduced: passComps.length,
                    factsEmitted: passFacts.length,
                    factsByCategory: passFacts.length > 0 ? tallyFactsByCategory(passFacts) : null,
                    eventsEmitted: (validatedPass.events ?? []).length,
                    importanceMin: imp.min,
                    importanceMax: imp.max,
                    importanceAvg: imp.avg,
                });
            }

            candidateCompartments = [
                ...candidateCompartments,
                ...(validatedPass.compartments ?? []),
            ];
            candidateFacts = validatedPass.facts ?? [];
            passCount += 1;
            currentTokenBudget = historianChunkTokens;
            passAttempt = 1;

            saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, candidateFacts);

            const nextOffset =
                (validatedPass.compartments?.[validatedPass.compartments.length - 1]?.endMessage ??
                    chunk.endIndex) + 1;
            if (nextOffset <= offset) {
                const partial = await promoteAndFinalize(
                    `historian made no forward progress after messages ${chunk.startIndex}-${chunk.endIndex}`,
                );
                if (partial) {
                    return `## Magic Recomp — Partial\n\n${partial}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp made no forward progress after messages ${chunk.startIndex}-${chunk.endIndex}. Nothing was written.`;
            }
            offset = nextOffset;
            emitProgress();
        }

        const mergedValidationError = validateStoredCompartments(candidateCompartments);
        if (mergedValidationError) {
            clearRecompStaging(db, sessionId);
            return `## Magic Recomp — Failed\n\nRecomp completed ${passCount} pass${passCount === 1 ? "" : "es"} but produced an invalid final compartment set: ${mergedValidationError}\n\nNothing was written.`;
        }

        saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, candidateFacts);
        const promoted = promoteRecompStagingWithM0Mutation(db, sessionId, leaseHolderId);
        if (!promoted) {
            sessionLog(sessionId, "recomp publish skipped: compartment lease no longer held");
            return "## Magic Recomp — Skipped\n\nAnother process acquired the compartment-state lease before recomp could publish. No state was written.";
        }
        clearCompressionDepth(db, sessionId);
        if (deps.preserveInjectionCacheUntilConsumed !== true) {
            clearInjectionCache(sessionId);
        }

        const finalCompartments = promoted?.compartments ?? candidateCompartments;
        const finalFacts = promoted?.facts ?? candidateFacts;

        void finalFacts;

        const lastCompartmentEnd = finalCompartments[finalCompartments.length - 1]?.endMessage ?? 0;
        if (lastCompartmentEnd > 0) {
            queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);
        }

        deps.onCompartmentStatePublished?.(sessionId);

        if (deps.memoryEnabled !== false) {
            const projectIdentity = resolveProjectIdentity(sessionDirectory);
            await deps.ensureProjectRegistered?.(sessionDirectory, db);
            const liveCompartments = getCompartments(db, sessionId);
            const chunksToEmbed = liveCompartments.map((c) => ({
                id: c.id,
                startMessage: c.startMessage,
                endMessage: c.endMessage,
            }));
            void embedAndStoreCompartmentChunks(db, sessionId, projectIdentity, chunksToEmbed);
        }

        if (lastCompartmentEnd > 0) {
            advanceCompactionMarkerAndClearStalePending(
                db,
                sessionId,
                lastCompartmentEnd,
                deps.directory,
            );
        }

        return [
            "## Magic Recomp — Complete",
            "",
            ...(resumed ? ["Resumed from previous interrupted run."] : []),
            `Rebuilt ${finalCompartments.length} compartment${finalCompartments.length === 1 ? "" : "s"} across ${passCount} historian pass${passCount === 1 ? "" : "es"}.`,
            `Covered raw history 1-${lastCompartmentEnd} out of ${rawMessageCount} total messages, stopping before protected tail at ${protectedTailStart}.`,
        ].join("\n");
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        return `## Magic Recomp — Failed\n\nRecomp failed unexpectedly: ${message}\n\nStaging data preserved for resume on next attempt.`;
    } finally {
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        cleanupHistorianStateFile(currentStateFilePath);
    }
}
