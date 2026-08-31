import { type Database, isInTransaction } from "../../../shared/sqlite";
import { getProjectCompartmentEvents, type ProjectCompartmentEvent } from "../compartment-events";
import type { ClaimOperationResultEffect } from "../memory/claim-operation-contract";
import { computeClaimOperationRequestDigest } from "../memory/claim-operation-contract";
import {
    ANTI_MEMORY_DEFAULT_TTL_MS,
    type AntiMemoryPayload,
    normalizeAntiMemoryPayload,
    renderAntiMemoryContent,
    stageCreateAntiMemoryInCurrentTransaction,
} from "../memory/storage-anti-memory";
import {
    ClaimOperationKeyReuseError,
    runClaimOperationInCurrentTransaction,
} from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import { isMessageIndexReconciledThrough } from "../message-index";
import { validateRetrospectiveLearningText } from "./retrospective-learnings";

const CORRECTION_CONSUMER = "dreamer-correction-harvest-v1";

/**
 * MAX_CORRECTION_EVENTS_PER_RUN bounds the harvest's single write transaction.
 */
const MAX_CORRECTION_EVENTS_PER_RUN = 50;

/**
 * MIN_CORROBORATION_WORDS requires at least five normalized words before an evidence quote can corroborate a user correction.
 * model-authored record.
 */
const MIN_CORROBORATION_WORDS = 5;

export interface CorrectionHarvestResult {
    consumed: number;
    skipped: number;
    effects: readonly ClaimOperationResultEffect[];
}

export function countPendingCorrectionEvents(db: Database, projectIdentity: string): number {
    const row = db
        .prepare(
            // cannot drain.
            `SELECT COUNT(DISTINCT events.id) AS count
               FROM compartment_events events
               JOIN session_projects projects
                 ON projects.session_id = events.session_id
                AND projects.harness = events.harness
              WHERE projects.project_path = ?
                AND events.kind = 'trajectory_correction'
                AND NOT EXISTS (
                    SELECT 1 FROM claim_operation_receipts receipts
                     WHERE receipts.producer = ?
                       AND receipts.operation_key = 'event:' || events.id
                )`,
        )
        .get(projectIdentity, CORRECTION_CONSUMER) as { count: number } | undefined;
    return row?.count ?? 0;
}

function mappedPayload(event: ProjectCompartmentEvent): AntiMemoryPayload | null {
    const trigger = event.fields.summary?.trim();
    const rejectedStrategy = event.fields.before_strategy?.trim();
    //
    // paraphrase.
    //
    const rejectionReason = event.fields.reason_for_change?.trim();
    if (!trigger || !rejectedStrategy || !rejectionReason) return null;
    const saferAlternative = event.fields.after_strategy?.trim() || null;
    return { trigger, rejectedStrategy, rejectionReason, saferAlternative };
}

/**
 */
function validationReason(
    payload: AntiMemoryPayload,
    spanUserTexts: readonly string[],
): string | null {
    for (const value of Object.values(normalizeAntiMemoryPayload(payload))) {
        if (typeof value !== "string") continue;
        const reason = validateRetrospectiveLearningText(value, spanUserTexts);
        if (reason) return reason;
    }
    return null;
}

function normalizedEvidence(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Host-recorded compartment bounds define the corroboration window.
 * range.
 */
function eventSpan(event: ProjectCompartmentEvent): [number, number] | null {
    const compartmentStart = event.compartmentStartMessage;
    const compartmentEnd = event.compartmentEndMessage;
    if (compartmentStart === null || compartmentEnd === null || compartmentEnd < compartmentStart) {
        return null;
    }
    const raw = event.fields.ord_span?.trim();
    const match = raw?.match(/^(\d+)\s*-\s*(\d+)$/);
    if (match) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start) {
            const clampedStart = Math.max(start, compartmentStart);
            const clampedEnd = Math.min(end, compartmentEnd);
            if (clampedStart <= clampedEnd) return [clampedStart, clampedEnd];
        }
    }
    return [compartmentStart, compartmentEnd];
}

function spanUserTexts(
    db: Database,
    event: ProjectCompartmentEvent,
    span: [number, number] | null,
): string[] {
    if (!span) return [];
    //
    // model-authored record.
    //
    const rows = db
        .prepare(
            `SELECT fts.content AS content
               FROM message_history_fts fts
               JOIN message_history_source src
                 ON src.session_id = fts.session_id
                AND src.message_id = fts.message_id
              WHERE fts.session_id = ? AND fts.role = 'user'
                AND src.harness = ?
                AND CAST(fts.message_ordinal AS INTEGER) BETWEEN ? AND ?`,
        )
        .all(event.sessionId, event.harness, span[0], span[1]) as Array<{ content: string }>;
    return rows.map((row) => row.content);
}

/**
 */
function hostCorroboratesUserCorrection(
    event: ProjectCompartmentEvent,
    userTexts: readonly string[],
): boolean {
    if (event.fields.correction_source?.trim() !== "user") return false;
    const evidence = event.fields.evidence?.trim();
    if (!evidence) return false;
    const needle = normalizedEvidence(evidence);
    if (needle.length < 8 || needle.split(" ").length < MIN_CORROBORATION_WORDS) return false;
    return userTexts.some((text) => normalizedEvidence(text).includes(needle));
}

export function harvestAntiMemoriesFromCorrections(args: {
    db: Database;
    projectIdentity: string;
    actor?: string;
    nowMs?: number;
}): CorrectionHarvestResult {
    if (!isInTransaction(args.db)) {
        throw new Error("harvestAntiMemoriesFromCorrections requires an active transaction");
    }
    const projectId = ensureProject(args.db, args.projectIdentity);
    const nowMs = args.nowMs ?? Date.now();
    const effects: ClaimOperationResultEffect[] = [];
    let consumed = 0;
    let skipped = 0;

    for (const event of getProjectCompartmentEvents(
        args.db,
        args.projectIdentity,
        "trajectory_correction",
        { pendingForProducer: CORRECTION_CONSUMER, limit: MAX_CORRECTION_EVENTS_PER_RUN },
    )) {
        const operationKey = `event:${event.id}`;
        const expiresAt = event.createdAt + ANTI_MEMORY_DEFAULT_TTL_MS;
        const payload = expiresAt > nowMs ? mappedPayload(event) : null;
        const span = payload ? eventSpan(event) : null;
        const spanIsSearchable =
            span !== null && isMessageIndexReconciledThrough(args.db, event.sessionId, span[1]);
        const userTexts = spanIsSearchable ? spanUserTexts(args.db, event, span) : [];
        // The harvester skips payloads without a searchable span because it cannot run the transcription check.
        // The harvester skips payloads without a searchable span because it cannot run the transcription check.
        const reason = !payload
            ? expiresAt > nowMs
                ? "missing_warning_core"
                : "expired"
            : !spanIsSearchable
              ? "unverifiable_span"
              : validationReason(payload, userTexts);
        try {
            if (!payload || reason) {
                const operation = runClaimOperationInCurrentTransaction(
                    args.db,
                    {
                        producer: CORRECTION_CONSUMER,
                        operationKey,
                        requestDigest: computeClaimOperationRequestDigest({
                            eventId: event.id,
                            operation: "skip-trajectory-correction",
                            reason: reason ?? "missing_warning_core",
                        }),
                    },
                    () => ({ kind: "stale", reason: reason ?? "missing_warning_core" }),
                    nowMs,
                );
                if (!operation.replayed) skipped += 1;
                continue;
            }

            const sourceTrustClass = hostCorroboratesUserCorrection(event, userTexts)
                ? "explicit_user"
                : "model_inference";
            const sourceContent = renderAntiMemoryContent(payload);
            const operation = runClaimOperationInCurrentTransaction(
                args.db,
                {
                    producer: CORRECTION_CONSUMER,
                    operationKey,
                    // Digest inputs must be derivable from the immutable event row
                    // Digest inputs must not use mutable message-index rows.
                    // Mutable message-index state and `projectId` must not affect the digest because recomputation would change it on replay.
                    // Mutable digest inputs make replays compute a different digest and throw `ClaimOperationKeyReuseError`.
                    // ClaimOperationKeyReuseError.
                    requestDigest: computeClaimOperationRequestDigest({
                        eventId: event.id,
                        operation: "harvest-trajectory-correction",
                        payload,
                    }),
                },
                () =>
                    stageCreateAntiMemoryInCurrentTransaction(
                        args.db,
                        {
                            projectId,
                            payload,
                            provenance: {
                                sourceLocator: `compartment-event://${event.sessionId}/${event.id}`,
                                sourceContent,
                                sourceSessionId: event.sessionId,
                                extractor: CORRECTION_CONSUMER,
                                extractorVersion: "1",
                                extractorRunId: operationKey,
                                independenceKey: `${CORRECTION_CONSUMER}:${event.id}`,
                                sourceTrustClass,
                            },
                            actor: args.actor ?? CORRECTION_CONSUMER,
                            // `expiresAt` is measured from the event time, not the harvest time.
                            // Backfills must not reanimate stale corrections as fresh warnings.
                            // Backfills must not reanimate stale corrections as fresh warnings.
                            expiresAt,
                            nowMs,
                        },
                        nowMs,
                    ),
                nowMs,
            );
            if (!operation.replayed) {
                effects.push(...operation.result.effects);
                consumed += 1;
            }
        } catch (error) {
            // A stored receipt with a mismatched digest means the event was already consumed with different derived inputs.
            // The harvester treats a stored receipt with a mismatched digest as consumed rather than aborting the transaction.
            // The harvester treats `ClaimOperationKeyReuseError` as consumed because rethrowing it makes every later retrospective run fail on the same event.
            // The harvester treats `ClaimOperationKeyReuseError` as consumed because rethrowing it makes every later retrospective run fail on the same event.
            if (error instanceof ClaimOperationKeyReuseError) continue;
            throw error;
        }
    }

    return { consumed, skipped, effects };
}
