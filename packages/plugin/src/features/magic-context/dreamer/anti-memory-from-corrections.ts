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
import { validateRetrospectiveLearningText } from "./retrospective-learnings";

const CORRECTION_CONSUMER = "dreamer-correction-harvest-v1";

/**
 * Per-run event budget. Bounds the single write transaction the harvest runs
 * inside (a first deploy can face months of unreceipted backlog); the receipt
 * filter keeps the remainder pending, so the backlog drains across scheduled
 * runs instead of holding the SQLite write lock for one giant drain.
 */
const MAX_CORRECTION_EVENTS_PER_RUN = 50;

/**
 * Minimum normalized word count before an evidence quote can corroborate a
 * user correction. A short common phrase appearing anywhere in the user's
 * messages must not be able to mint `explicit_user` trust for an otherwise
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
            // Joined on harness as well as session id, matching
            // getProjectCompartmentEvents: `session_projects` is keyed
            // `(session_id, harness)`, so session id alone counts another
            // harness's project events as pending for this project. The gate and
            // the reader must agree, or the scheduler reopens work the harvest
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
    // Only `reason_for_change` carries WHY the approach was rejected, so it is
    // the sole source for the durable rejection reason.
    //
    // The two obvious alternatives are both wrong. `evidence` is contractually a
    // quote or paraphrase proving the pivot happened, so falling back to it
    // records statements like "the final implementation now uses X" as the
    // reason a strategy was unsafe — proof of the pivot, not its cause.
    // `correction_signal` is contractually a quote of the trigger, which is
    // frequently the user's own words; persisting those is forbidden outright,
    // and the privacy gate is not a safe filter for telling a quote from a
    // paraphrase.
    //
    // An event carrying no causal reason therefore yields no anti-memory: it is
    // skipped as `missing_warning_core` and receipted, so it is not retried.
    const rejectionReason = event.fields.reason_for_change?.trim();
    if (!trigger || !rejectedStrategy || !rejectionReason) return null;
    const saferAlternative = event.fields.after_strategy?.trim() || null;
    return { trigger, rejectedStrategy, rejectionReason, saferAlternative };
}

/**
 * Run every persisted payload field through the retrospective privacy gate,
 * including the source-overlap ("distill, don't transcribe") check against the
 * event span's own user messages. Deriving the field set from the normalized
 * payload means a future payload field cannot silently bypass the gate.
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
 * Message-ordinal window for host corroboration. The compartment bounds are the
 * host-recorded authority; the historian's optional `ord_span` may only narrow
 * them. An event whose compartment bounds are unknown gets no window (and so no
 * trust upgrade): the model-authored span must never choose its own search
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
    const rows = db
        .prepare(
            `SELECT content FROM message_history_fts
              WHERE session_id = ? AND role = 'user'
                AND CAST(message_ordinal AS INTEGER) BETWEEN ? AND ?`,
        )
        .all(event.sessionId, span[0], span[1]) as Array<{ content: string }>;
    return rows.map((row) => row.content);
}

/**
 * True when the historian's evidence quote is a substantial (≥
 * MIN_CORROBORATION_WORDS words) verbatim run of an in-span user message.
 * Corroboration reads the `evidence` field — the quote proving the correction —
 * not the persisted payload: the persisted reason must be a distillation, and
 * the privacy gate rejects it when it transcribes the user.
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
        const userTexts = payload ? spanUserTexts(args.db, event, span) : [];
        const reason = payload
            ? validationReason(payload, userTexts)
            : expiresAt > nowMs
              ? "missing_warning_core"
              : "expired";
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
                    // alone. Values derived from mutable state (message index rows,
                    // compartment recomputation, project identity) would make a
                    // replay compute a different digest and throw
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
                            // Anchor expiry to the event, not the harvest clock:
                            // backfilling old history must not re-animate stale
                            // corrections as fresh warnings.
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
            // A stored receipt whose digest no longer matches marks the event as
            // already consumed under different derived inputs. Treat it as done
            // rather than aborting the transaction: an uncaught throw here would
            // deterministically fail every future retrospective run.
            if (error instanceof ClaimOperationKeyReuseError) continue;
            throw error;
        }
    }

    return { consumed, skipped, effects };
}
