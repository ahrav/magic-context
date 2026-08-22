/**
 * Bounded, fail-closed v86 claim-policy seeding (claim-trust-policy plan:
 * U1; KTD11; R25-R28).
 *
 * Migration v86 records the deterministic boundary and pending phase; this
 * reconciler then seeds one conservative policy subject, maturity stream, and
 * effective-policy projection row per pre-existing revision in bounded
 * immediate-transaction batches. Missing rows read as CANDIDATE / unknown /
 * automatic-hidden until seeded (R26), so interruption is safe at any batch
 * cursor. Completion publishes only after expected-count and anti-join checks
 * pass in one immediate transaction. No legacy row is grandfathered into
 * automatic visibility.
 */

import type { Database } from "../../shared/sqlite.ts";
import { classifyFineTaint, TAINT_CLASSIFIER_METHOD } from "./memory/claim-policy.ts";
import { supportedMaturity } from "./memory/claim-visibility-policy.ts";
import {
    appendMaturityAssertionInCurrentTransaction,
    createPolicySubjectInCurrentTransaction,
    hasClaimPolicySchema,
    readPolicySupport,
    refreshEffectivePolicyInCurrentTransaction,
} from "./memory/storage-claim-policy.ts";
import type { SourceTrustClass } from "./storage-claim-applicability-schema.ts";
import {
    CLAIM_POLICY_SEED_META_KEYS,
    type FineTaint,
    type MaturityLevel,
} from "./storage-claim-policy-schema.ts";

const SEED_ACTOR = "claim-policy-seed:v1";
const DEFAULT_BATCH_SIZE = 200;

export interface ClaimPolicySeedStatus {
    applicable: boolean;
    phase: "pending" | "complete" | null;
    boundaryRevisionId: number;
    expectedCount: number;
    cursor: number;
    seededCounts: Record<string, number> | null;
}

function readMeta(db: Database, key: string): string | null {
    const row = db.prepare("SELECT value FROM schema_migrations_meta WHERE key = ?").get(key) as
        | { value: string }
        | null
        | undefined;
    return row?.value ?? null;
}

function writeMeta(db: Database, key: string, value: string): void {
    db.prepare(
        `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
}

export function getClaimPolicySeedStatus(db: Database): ClaimPolicySeedStatus {
    if (!hasClaimPolicySchema(db)) {
        return {
            applicable: false,
            phase: null,
            boundaryRevisionId: 0,
            expectedCount: 0,
            cursor: 0,
            seededCounts: null,
        };
    }
    const phase = readMeta(db, CLAIM_POLICY_SEED_META_KEYS.phase);
    const countsRaw = readMeta(db, CLAIM_POLICY_SEED_META_KEYS.seededCounts);
    let seededCounts: Record<string, number> | null = null;
    if (countsRaw != null) {
        try {
            seededCounts = JSON.parse(countsRaw) as Record<string, number>;
        } catch {
            seededCounts = null;
        }
    }
    return {
        applicable: true,
        phase: phase === "complete" ? "complete" : phase === "pending" ? "pending" : null,
        boundaryRevisionId: Number(
            readMeta(db, CLAIM_POLICY_SEED_META_KEYS.boundaryRevisionId) ?? 0,
        ),
        expectedCount: Number(readMeta(db, CLAIM_POLICY_SEED_META_KEYS.expectedCount) ?? 0),
        cursor: Number(readMeta(db, CLAIM_POLICY_SEED_META_KEYS.cursor) ?? 0),
        seededCounts,
    };
}

interface SeedRevisionRow {
    revisionId: number;
    projectId: number;
    originObservationId: number | null;
    sourceTrustClass: SourceTrustClass | null;
    extractor: string | null;
    metadataSourceType: string | null;
}

function seedTaint(row: SeedRevisionRow): FineTaint {
    // Retained raw `user` provenance predates the v85 trust column; the v85
    // contract keeps it exactly so a later policy can re-derive channel
    // confidence (R25). Anything else classifies from the coarse class.
    if (row.metadataSourceType === "user" || row.sourceTrustClass === "explicit_user") {
        return "USER_EXPLICIT";
    }
    return classifyFineTaint({
        sourceTrustClass: row.sourceTrustClass ?? "model_inference",
        extractor: row.extractor,
    });
}

function seedMaturity(db: Database, row: SeedRevisionRow): MaturityLevel {
    return supportedMaturity(readPolicySupport(db, row.revisionId));
}

function selectUnseededBatch(
    db: Database,
    afterRevisionId: number,
    limit: number,
): SeedRevisionRow[] {
    return db
        .prepare(
            `SELECT
                claim_revisions.id AS revisionId,
                claims.project_id AS projectId,
                origin_observation.id AS originObservationId,
                origin_observation.source_trust_class AS sourceTrustClass,
                origin_observation.extractor AS extractor,
                metadata.source_type AS metadataSourceType
             FROM claim_revisions
             JOIN claims ON claims.id = claim_revisions.claim_id
             LEFT JOIN observations origin_observation ON origin_observation.id = (
                 SELECT MIN(observation_id) FROM claim_evidence
                 WHERE revision_id = claim_revisions.id AND relation = 'supports'
             )
             LEFT JOIN claim_revision_memory_metadata metadata
                 ON metadata.revision_id = claim_revisions.id
             WHERE claim_revisions.id > ?
               AND NOT EXISTS (
                   SELECT 1 FROM claim_revision_policy_subjects subject
                   WHERE subject.revision_id = claim_revisions.id
               )
             ORDER BY claim_revisions.id
             LIMIT ?`,
        )
        .all(afterRevisionId, limit) as SeedRevisionRow[];
}

export interface ClaimPolicySeedRunSummary {
    status: "complete" | "pending" | "noop";
    batches: number;
    seeded: number;
    seededCounts: Record<string, number>;
    autoHidden: number;
}

export interface RunClaimPolicySeedOptions {
    batchSize?: number;
    /** Bound the batches one call may run; remaining work stays pending. */
    maxBatches?: number;
    nowMs?: number;
}

/**
 * Run bounded seed batches until done (or `maxBatches`). Deterministic and
 * resumable: each batch commits its subjects, streams, assertions, projection
 * rows, and cursor in one immediate transaction; a crash resumes to identical
 * results (AE9). Completion re-checks the whole table with an anti-join so a
 * revision added by a held-open v85 writer during reconciliation is seeded
 * before the completion watermark publishes.
 */
export function runClaimPolicySeed(
    db: Database,
    options: RunClaimPolicySeedOptions = {},
): ClaimPolicySeedRunSummary {
    const status = getClaimPolicySeedStatus(db);
    const emptyCounts: Record<string, number> = { CANDIDATE: 0, CORROBORATED: 0, VERIFIED: 0 };
    if (!status.applicable || status.phase === "complete") {
        return {
            status: "noop",
            batches: 0,
            seeded: 0,
            seededCounts: status.seededCounts ?? emptyCounts,
            autoHidden: 0,
        };
    }
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
    const nowMs = options.nowMs ?? Date.now();

    let batches = 0;
    let seeded = 0;
    let autoHidden = 0;
    const counts: Record<string, number> =
        status.seededCounts != null ? { ...emptyCounts, ...status.seededCounts } : emptyCounts;

    while (batches < maxBatches) {
        let batchDone = false;
        db.exec("BEGIN IMMEDIATE");
        try {
            const cursor = Number(readMeta(db, CLAIM_POLICY_SEED_META_KEYS.cursor) ?? 0);
            const rows = selectUnseededBatch(db, cursor, batchSize);
            if (rows.length === 0) {
                // Final reconciliation: a full anti-join (cursor 0) catches
                // rows a held-open writer added behind the cursor.
                const remaining = selectUnseededBatch(db, 0, 1);
                if (remaining.length > 0) {
                    writeMeta(db, CLAIM_POLICY_SEED_META_KEYS.cursor, "0");
                    db.exec("COMMIT");
                    continue;
                }
                publishSeedCompletion(db, counts);
                db.exec("COMMIT");
                return { status: "complete", batches, seeded, seededCounts: counts, autoHidden };
            }
            for (const row of rows) {
                const outcome = seedRevisionInCurrentTransaction(db, row, nowMs);
                seeded += 1;
                counts[outcome.maturity] = (counts[outcome.maturity] ?? 0) + 1;
                if (!outcome.autoEligible) autoHidden += 1;
            }
            writeMeta(
                db,
                CLAIM_POLICY_SEED_META_KEYS.cursor,
                String(rows[rows.length - 1].revisionId),
            );
            writeMeta(db, CLAIM_POLICY_SEED_META_KEYS.seededCounts, JSON.stringify(counts));
            db.exec("COMMIT");
            batchDone = true;
        } finally {
            if (!batchDone) {
                try {
                    db.exec("ROLLBACK");
                } catch {
                    // Transaction already rolled back by SQLite.
                }
            }
        }
        batches += 1;
    }
    return { status: "pending", batches, seeded, seededCounts: counts, autoHidden };
}

function seedRevisionInCurrentTransaction(
    db: Database,
    row: SeedRevisionRow,
    nowMs: number,
): { maturity: MaturityLevel; autoEligible: boolean } {
    const taint = seedTaint(row);
    createPolicySubjectInCurrentTransaction(db, {
        revisionId: row.revisionId,
        projectId: row.projectId,
        // Legacy prose cannot prove descriptive kind; unknown receives
        // directive-strength restrictions (R2).
        claimKind: "unknown",
        originObservationId: row.originObservationId,
        originTaint: taint,
        classificationMethod: `${TAINT_CLASSIFIER_METHOD}:seed`,
        nowMs,
    });
    const maturity = seedMaturity(db, row);
    appendMaturityAssertionInCurrentTransaction(db, {
        revisionId: row.revisionId,
        projectId: row.projectId,
        maturity,
        actor: SEED_ACTOR,
        evidenceJson: null,
        nowMs,
    });
    const decision = refreshEffectivePolicyInCurrentTransaction(db, row.revisionId, { nowMs });
    return { maturity, autoEligible: decision.surfaces.auto_inject.eligible };
}

/** Publish completion only after count and anti-join reconciliation (KTD11). */
function publishSeedCompletion(db: Database, counts: Record<string, number>): void {
    const boundary = Number(readMeta(db, CLAIM_POLICY_SEED_META_KEYS.boundaryRevisionId) ?? 0);
    const expected = Number(readMeta(db, CLAIM_POLICY_SEED_META_KEYS.expectedCount) ?? 0);
    const subjectsAtBoundary = (
        db
            .prepare(
                "SELECT COUNT(*) AS count FROM claim_revision_policy_subjects WHERE revision_id <= ?",
            )
            .get(boundary) as { count: number }
    ).count;
    if (subjectsAtBoundary < expected) {
        throw new Error(
            `claim policy seed completion check failed: ${subjectsAtBoundary} of ${expected} boundary subjects`,
        );
    }
    const missing = db
        .prepare(
            `SELECT COUNT(*) AS count FROM claim_revisions
             WHERE NOT EXISTS (
                 SELECT 1 FROM claim_revision_policy_subjects subject
                 WHERE subject.revision_id = claim_revisions.id
             )
             OR NOT EXISTS (
                 SELECT 1 FROM claim_maturity_streams stream
                 WHERE stream.revision_id = claim_revisions.id
             )
             OR NOT EXISTS (
                 SELECT 1 FROM claim_effective_policy policy
                 WHERE policy.revision_id = claim_revisions.id
             )`,
        )
        .get() as { count: number };
    if (missing.count > 0) {
        throw new Error(
            `claim policy seed completion check failed: ${missing.count} revision(s) missing policy state`,
        );
    }
    const watermark = (
        db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM claim_change_outbox").get() as {
            id: number;
        }
    ).id;
    writeMeta(db, CLAIM_POLICY_SEED_META_KEYS.phase, "complete");
    writeMeta(db, CLAIM_POLICY_SEED_META_KEYS.completionWatermark, String(watermark));
    writeMeta(db, CLAIM_POLICY_SEED_META_KEYS.seededCounts, JSON.stringify(counts));
}
