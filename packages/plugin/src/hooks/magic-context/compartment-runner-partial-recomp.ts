import { HISTORIAN_RECOMP_AGENT } from "../../agents/historian";
import { embedAndStoreCompartmentChunks } from "../../features/magic-context/compartment-embedding";
import type {
    Compartment,
    CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import {
    clearRecompStaging,
    getCompartments,
    getRecompPartialRange,
    getRecompStaging,
    saveRecompStagingPass,
    setRecompPartialRange,
} from "../../features/magic-context/compartment-storage";
import { clearCompressionDepthRange } from "../../features/magic-context/compression-depth-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { advanceCompactionMarkerAndClearStalePending } from "./compaction-marker-manager";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import { resolveSessionDirectory } from "./compartment-runner-mapping";
import { promoteRecompStagingWithM0Mutation } from "./compartment-runner-recomp";
import type { CandidateCompartment, CompartmentRunnerDeps } from "./compartment-runner-types";
import {
    getReducedRecompTokenBudget,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation";
import { clearInjectionCache } from "./inject-compartments";
import { readSessionChunk } from "./read-session-chunk";
import { buildReferenceBlocks } from "./reference-retrieval";
import { sendIgnoredMessage } from "./send-session-notification";

export interface PartialRecompRange {
    /** Inclusive raw message ordinal to start rebuilding from. */
    start: number;
    /** Inclusive raw message ordinal to stop rebuilding at. */
    end: number;
}

export interface SnappedPartialRange {
    /** Snapped start = first enclosing compartment's startMessage. */
    snapStart: number;
    /** Snapped end = last enclosing compartment's endMessage. */
    snapEnd: number;
    priorCompartments: Compartment[];
    rangeCompartments: Compartment[];
    tailCompartments: Compartment[];
}

/**
 * This function only previews the snapped range.
 *
 * Returns an error when the range is invalid or overlaps no compartment.
 */
export function snapRangeToCompartments(
    compartments: Compartment[],
    range: PartialRecompRange,
): SnappedPartialRange | { error: string } {
    if (compartments.length === 0) {
        return {
            error: "No compartments exist yet for this session. Run `/ctx-recomp` (full) first, then use partial recomp to refine specific ranges.",
        };
    }

    // Sequence order must match startMessage order for contiguous compartments.
    const sorted = compartments.slice().sort((a, b) => a.sequence - b.sequence);

    const { start, end } = range;
    if (start < 1) return { error: `Start must be >= 1 (got ${start}).` };
    if (end < start) return { error: `End must be >= start (got ${start}-${end}).` };

    const firstEnclosingIdx = sorted.findIndex((c) => c.endMessage >= start);
    if (firstEnclosingIdx === -1) {
        const last = sorted[sorted.length - 1];
        return {
            error: `Range ${start}-${end} starts after the last compartment (which ends at message ${last.endMessage}). Nothing to rebuild.`,
        };
    }

    let lastEnclosingIdx = -1;
    for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i].startMessage <= end) {
            lastEnclosingIdx = i;
            break;
        }
    }
    if (lastEnclosingIdx === -1 || lastEnclosingIdx < firstEnclosingIdx) {
        return {
            error: `Range ${start}-${end} does not overlap any compartment.`,
        };
    }

    return {
        snapStart: sorted[firstEnclosingIdx].startMessage,
        snapEnd: sorted[lastEnclosingIdx].endMessage,
        priorCompartments: sorted.slice(0, firstEnclosingIdx),
        rangeCompartments: sorted.slice(firstEnclosingIdx, lastEnclosingIdx + 1),
        tailCompartments: sorted.slice(lastEnclosingIdx + 1),
    };
}

function compartmentToInput(c: Compartment, newSequence: number): CompartmentInput {
    return {
        sequence: newSequence,
        startMessage: c.startMessage,
        endMessage: c.endMessage,
        startMessageId: c.startMessageId,
        endMessageId: c.endMessageId,
        title: c.title,
        content: c.content,
        // Preserve tiers and scoring: dropping them writes NULL-tier legacy=0 rows and breaks decay rendering.
        p1: c.p1,
        p2: c.p2,
        p3: c.p3,
        p4: c.p4,
        importance: c.importance,
        episodeType: c.episodeType,
    };
}

export async function executePartialRecompInternal(
    deps: CompartmentRunnerDeps,
    range: PartialRecompRange,
): Promise<string> {
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
        return "## Magic Recomp — Failed\n\nCould not acquire the compartment-state lease for this session.";
    }
    const leaseHolderId = holderId;
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        const existingCompartments = getCompartments(db, sessionId);
        const snapResult = snapRangeToCompartments(existingCompartments, range);
        if ("error" in snapResult) {
            return `## Magic Recomp — Failed\n\n${snapResult.error}`;
        }
        const { snapStart, snapEnd, priorCompartments, tailCompartments } = snapResult;

        const storedRange = getRecompPartialRange(db, sessionId);
        const existingStaging = getRecompStaging(db, sessionId);

        if (
            existingStaging &&
            storedRange &&
            (storedRange.start !== snapStart || storedRange.end !== snapEnd)
        ) {
            return [
                "## Magic Recomp — Failed",
                "",
                `An unfinished partial recomp is already staged for range ${storedRange.start}-${storedRange.end}, which does not match the requested range ${snapStart}-${snapEnd}.`,
                "",
                "Resume that range by running `/ctx-recomp` with the same original arguments,",
                "or cancel it by running `/ctx-flush` before starting a new partial recomp.",
            ].join("\n");
        }
        if (existingStaging && !storedRange) {
            return [
                "## Magic Recomp — Failed",
                "",
                "An unfinished full recomp is already staged for this session.",
                "Resume it by running `/ctx-recomp` without arguments,",
                "or cancel it before starting a partial recomp.",
            ].join("\n");
        }

        // Partial recomp passes an empty fact list because session facts are not a render source.
        const stagedFacts: { category: string; content: string }[] = [];

        // ── Resolve project memories for historian fact dedup context ─────
        const sessionDirectory = await resolveSessionDirectory(client, sessionId, directory);

        //
        // Staging layout for partial recomp: [priorCompartments, ...newBuiltSoFar]
        //   - priorCompartments always carried through unchanged
        //   - newBuiltSoFar is what historian has produced for the range so far
        //   - tailCompartments are NOT in staging — they are appended at promote time
        //
        let candidateCompartments: CandidateCompartment[];
        let passCount: number;
        let offset: number;
        const resumed = existingStaging !== null && storedRange !== null;

        if (resumed && existingStaging) {
            candidateCompartments = existingStaging.compartments;
            passCount = existingStaging.passCount;
            const lastInStaging = existingStaging.lastEndMessage;
            offset = lastInStaging >= snapStart ? lastInStaging + 1 : snapStart;
        } else {
            // Sequences are 0-indexed to match the invariant MAX(sequence) = count - 1.
            // A gap or off-by-one causes incremental historian sequenceOffset collisions and UNIQUE constraint failures on the next run.
            candidateCompartments = priorCompartments.map((c, idx) => compartmentToInput(c, idx));
            passCount = 0;
            offset = snapStart;
            // Save prior-only staging with pass_number 0 so crashes leave discoverable staging for the snapped range.
            saveRecompStagingPass(db, sessionId, 0, candidateCompartments, stagedFacts);
            setRecompPartialRange(db, sessionId, { start: snapStart, end: snapEnd });
        }

        let currentTokenBudget = historianChunkTokens;
        let passAttempt = 1;

        await sendIgnoredMessage(
            client,
            sessionId,
            resumed
                ? `## Magic Recomp — Resumed (Partial)\n\nFound ${candidateCompartments.length - priorCompartments.length} newly built compartment(s) from ${passCount} previous pass(es), covering messages ${snapStart}-${offset - 1}. Resuming from message ${offset} toward ${snapEnd}.`
                : `## Magic Recomp — Partial\n\nSnapped to compartment boundaries: rebuilding messages ${snapStart}-${snapEnd} (${tailCompartments.length} tail compartment(s) preserved).`,
            notifParams(),
        );

        /** Promotion atomically swaps prior, rebuilt, and tail compartments into the real tables.
         * Promotion resets compression depth to 0 for rebuilt compartments.
         * */
        function promoteFinal(): { compartmentCount: number; lastEndMessage: number } | null {
            const newBuilt = candidateCompartments.slice(priorCompartments.length);
            if (newBuilt.length === 0) return null;

            // contiguously.
            const newBuiltError = (() => {
                let expected = snapStart;
                for (const c of newBuilt) {
                    if (c.startMessage !== expected) {
                        return c.startMessage < expected
                            ? `overlap in rebuilt range near ${expected}`
                            : `gap in rebuilt range before ${c.startMessage} (expected ${expected})`;
                    }
                    if (c.endMessage < c.startMessage) {
                        return `invalid range ${c.startMessage}-${c.endMessage}`;
                    }
                    expected = c.endMessage + 1;
                }
                if (expected - 1 !== snapEnd) {
                    return `rebuilt range ends at ${expected - 1} but snapped end is ${snapEnd}`;
                }
                return null;
            })();
            if (newBuiltError) {
                log(`[magic-context] partial recomp validation failed: ${newBuiltError}`);
                return null;
            }

            // `validateStoredCompartments` requires the merged compartments to be contiguous from message 1.
            // Sequences are 0-indexed (continuing from candidateCompartments.length).
            // Starting exactly at candidateCompartments.length keeps the set
            // gapless, preserving the invariant MAX(sequence) = count - 1 that
            // incremental historian's sequenceOffset relies on; a gap would
            // collide sequences and produce UNIQUE constraint failures.
            const merged: CompartmentInput[] = [
                ...candidateCompartments,
                ...tailCompartments.map((c, idx) =>
                    compartmentToInput(c, candidateCompartments.length + idx),
                ),
            ];

            const mergedError = validateStoredCompartments(merged);
            if (mergedError) {
                log(`[magic-context] partial recomp merged validation failed: ${mergedError}`);
                return null;
            }

            // Promotion atomically replaces the real tables with the final staging set.
            saveRecompStagingPass(db, sessionId, passCount + 1, merged, stagedFacts);
            const promoted = promoteRecompStagingWithM0Mutation(db, sessionId, leaseHolderId);
            if (!promoted) {
                log("[magic-context] partial recomp promote returned null");
                return null;
            }

            setRecompPartialRange(db, sessionId, null);
            // `clearCompressionDepthRange` resets rebuilt compartments to depth 0 without changing prior or tail depths.
            clearCompressionDepthRange(db, sessionId, snapStart, snapEnd);
            if (deps.preserveInjectionCacheUntilConsumed !== true) {
                clearInjectionCache(sessionId);
            }
            deps.onCompartmentStatePublished?.(sessionId);

            // Partial recomp bypasses fact promotion, so rebuilt compartments require regenerated chunk embeddings.
            if (deps.memoryEnabled !== false) {
                const projectIdentity = resolveProjectIdentity(sessionDirectory);
                const liveCompartments = getCompartments(db, sessionId);
                const chunksToEmbed = liveCompartments.map((c) => ({
                    id: c.id,
                    startMessage: c.startMessage,
                    endMessage: c.endMessage,
                }));
                // `embedAndStoreCompartmentChunks` requires project registration before embedding.
                void Promise.resolve(deps.ensureProjectRegistered?.(sessionDirectory, db)).then(
                    () =>
                        embedAndStoreCompartmentChunks(
                            db,
                            sessionId,
                            projectIdentity,
                            chunksToEmbed,
                        ),
                );
            }

            const lastEnd = merged[merged.length - 1]?.endMessage ?? snapEnd;
            // Partial recomp CAS-clears a stale pending blob because it owns the boundary through `lastEnd`.
            if (lastEnd > 0) {
                advanceCompactionMarkerAndClearStalePending(db, sessionId, lastEnd, deps.directory);
            }
            return { compartmentCount: merged.length, lastEndMessage: lastEnd };
        }

        while (offset <= snapEnd) {
            const chunk = readSessionChunk(
                sessionId,
                currentTokenBudget,
                offset,
                snapEnd + 1, // exclusive upper bound — readSessionChunk stops before this ordinal
            );
            if (!chunk.text || chunk.messageCount === 0 || chunk.endIndex < offset) {
                return `## Magic Recomp — Failed\n\nRecomp stopped because raw history ${offset}-${snapEnd} could not be turned into a valid historian chunk. Partial recomp preserved original state (staging kept for retry).`;
            }

            const chunkCoverageError = validateChunkCoverage(chunk);
            if (chunkCoverageError) {
                return `## Magic Recomp — Failed\n\nPartial recomp stopped because the raw chunk could not be represented safely: ${chunkCoverageError}\n\nOriginal state preserved (staging kept for retry).`;
            }

            // Use four rotating seeds and the six most recent compartments because rebuilt compartments provide continuity.
            // Structural rebuilds omit the `<project-memory>` dedup block.
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
                // Partial recomp never promotes facts into the curated memory store.
                memoryEnabled: false,
                extractionFree: true,
            });

            await sendIgnoredMessage(
                client,
                sessionId,
                `## Magic Recomp — Partial\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} started for messages ${chunk.startIndex}-${chunk.endIndex}.`,
                notifParams(),
            );

            const validatedPass = await runValidatedHistorianPass({
                client,
                db,
                parentSessionId: sessionId,
                sessionDirectory,
                prompt,
                chunk,
                priorCompartments: candidateCompartments,
                sequenceOffset: candidateCompartments.length,
                dumpLabelBase: `partial-recomp-${sessionId}-${chunk.startIndex}-${chunk.endIndex}-pass-${passCount + 1}`,
                timeoutMs: historianTimeoutMs,
                fallbackModelId: deps.fallbackModelId,
                fallbackModels: deps.fallbackModels,
                twoPass: deps.historianTwoPass,
                subagentKind: "recomp",
                agentId: HISTORIAN_RECOMP_AGENT,
                language: deps.language,
                callbacks: {
                    onRepairRetry: async (error) => {
                        await sendIgnoredMessage(
                            client,
                            sessionId,
                            `## Magic Recomp — Partial\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} is continuing with a repair retry for messages ${chunk.startIndex}-${chunk.endIndex}.\n\nThe previous output did not validate: ${error}`,
                            notifParams(),
                        );
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
                        snapEnd + 1,
                    );
                    if (smallerChunk.messageCount > 0 && smallerChunk.endIndex < chunk.endIndex) {
                        await sendIgnoredMessage(
                            client,
                            sessionId,
                            `## Magic Recomp — Partial\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} is continuing with a smaller chunk ending at ${smallerChunk.endIndex} because messages ${chunk.startIndex}-${chunk.endIndex} could not be validated.\n\nValidator result: ${validatedPass.error}`,
                            notifParams(),
                        );
                        currentTokenBudget = reducedBudget;
                        passAttempt += 1;
                        continue;
                    }
                }
                return `## Magic Recomp — Failed\n\nPartial recomp failed while rebuilding messages ${chunk.startIndex}-${chunk.endIndex}: ${validatedPass.error}\n\nOriginal state preserved (staging kept for retry).`;
            }

            candidateCompartments = [
                ...candidateCompartments,
                ...(validatedPass.compartments ?? []),
            ];
            // Partial recomp ignores the historian's fact output.

            passCount += 1;
            currentTokenBudget = historianChunkTokens;
            passAttempt = 1;

            saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, stagedFacts);

            const nextOffset =
                (validatedPass.compartments?.[validatedPass.compartments.length - 1]?.endMessage ??
                    chunk.endIndex) + 1;
            if (nextOffset <= offset) {
                return `## Magic Recomp — Failed\n\nPartial recomp made no forward progress after messages ${chunk.startIndex}-${chunk.endIndex}. Staging kept for retry.`;
            }
            offset = nextOffset;
        }

        const finalResult = promoteFinal();
        if (!finalResult) {
            return `## Magic Recomp — Failed\n\nPartial recomp completed historian passes but the final compartment set failed validation. Original state preserved (staging kept for inspection).`;
        }

        return [
            "## Magic Recomp — Partial Complete",
            "",
            ...(resumed ? ["Resumed from previous interrupted partial run."] : []),
            `Rebuilt compartments covering messages ${snapStart}-${snapEnd} using ${passCount} historian pass${passCount === 1 ? "" : "es"}.`,
            `Preserved ${priorCompartments.length} prior compartment(s) and ${tailCompartments.length} tail compartment(s) unchanged.`,
            `Total compartments: ${finalResult.compartmentCount}.`,
        ].join("\n");
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        return `## Magic Recomp — Failed\n\nPartial recomp failed unexpectedly: ${message}\n\nStaging preserved for resume on next attempt.`;
    } finally {
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        const leftoverStaging = getRecompStaging(db, sessionId);
        const leftoverRange = getRecompPartialRange(db, sessionId);
        if (leftoverStaging && leftoverRange) {
            // Failure paths retain staging for retry.
        } else if (leftoverStaging && !leftoverRange) {
            log(
                `[magic-context] partial recomp cleanup: clearing orphaned staging without range marker for session ${sessionId}`,
            );
            clearRecompStaging(db, sessionId);
        }
    }
}
