import { type Database, isInTransaction } from "../../../shared/sqlite";
import { getProjectCompartmentEvents, type ProjectCompartmentEvent } from "../compartment-events";
import type { ClaimOperationResultEffect } from "../memory/claim-operation-contract";
import { computeClaimOperationRequestDigest } from "../memory/claim-operation-contract";
import {
    type AntiMemoryPayload,
    renderAntiMemoryContent,
    stageCreateAntiMemoryInCurrentTransaction,
} from "../memory/storage-anti-memory";
import { runClaimOperationInCurrentTransaction } from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import { validateRetrospectiveLearningText } from "./retrospective-learnings";

const CORRECTION_CONSUMER = "dreamer-correction-harvest-v1";
const CORRECTION_HARVEST_BATCH_SIZE = 100;

export interface CorrectionHarvestResult {
    consumed: number;
    skipped: number;
    effects: readonly ClaimOperationResultEffect[];
}

export function countPendingCorrectionEvents(db: Database, projectIdentity: string): number {
    const row = db
        .prepare(
            `SELECT COUNT(DISTINCT events.id) AS count
               FROM compartment_events events
               JOIN session_projects projects ON projects.session_id = events.session_id
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
    const rejectionReason = event.fields.evidence?.trim();
    if (!trigger || !rejectedStrategy || !rejectionReason) return null;
    const saferAlternative = event.fields.after_strategy?.trim() || null;
    return { trigger, rejectedStrategy, rejectionReason, saferAlternative };
}

function validationReason(payload: AntiMemoryPayload): string | null {
    for (const value of [
        payload.trigger,
        payload.rejectedStrategy,
        payload.rejectionReason,
        payload.saferAlternative,
    ]) {
        if (!value) continue;
        const reason = validateRetrospectiveLearningText(value);
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

function eventSpan(event: ProjectCompartmentEvent): [number, number] | null {
    const raw = event.fields.ord_span?.trim();
    const match = raw?.match(/^(\d+)\s*-\s*(\d+)$/);
    if (match) {
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start) {
            return [start, end];
        }
    }
    if (
        event.compartmentStartMessage !== null &&
        event.compartmentEndMessage !== null &&
        event.compartmentEndMessage >= event.compartmentStartMessage
    ) {
        return [event.compartmentStartMessage, event.compartmentEndMessage];
    }
    return null;
}

function hostCorroboratesUserCorrection(
    db: Database,
    event: ProjectCompartmentEvent,
    evidence: string,
): boolean {
    if (event.fields.correction_source?.trim() !== "user") return false;
    const span = eventSpan(event);
    const needle = normalizedEvidence(evidence);
    if (!span || needle.length < 8) return false;
    const rows = db
        .prepare(
            `SELECT content FROM message_history_fts
              WHERE session_id = ? AND role = 'user'
                AND CAST(message_ordinal AS INTEGER) BETWEEN ? AND ?`,
        )
        .all(event.sessionId, span[0], span[1]) as Array<{ content: string }>;
    return rows.some((row) => normalizedEvidence(row.content).includes(needle));
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
        { unconsumedBy: CORRECTION_CONSUMER, limit: CORRECTION_HARVEST_BATCH_SIZE },
    )) {
        const payload = mappedPayload(event);
        const reason = payload ? validationReason(payload) : "missing_warning_core";
        const operationKey = `event:${event.id}`;
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

        const sourceTrustClass = hostCorroboratesUserCorrection(
            args.db,
            event,
            payload.rejectionReason,
        )
            ? "explicit_user"
            : "model_inference";
        const sourceContent = renderAntiMemoryContent(payload);
        const operation = runClaimOperationInCurrentTransaction(
            args.db,
            {
                producer: CORRECTION_CONSUMER,
                operationKey,
                requestDigest: computeClaimOperationRequestDigest({
                    eventId: event.id,
                    operation: "harvest-trajectory-correction",
                    payload,
                    projectId,
                    sourceTrustClass,
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
    }

    return { consumed, skipped, effects };
}
