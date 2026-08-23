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
import { isRetryableSqliteBusyError } from "./claims-backfill.ts";
import {
    automaticMaturityTarget,
    classifyFineTaint,
    TAINT_CLASSIFIER_METHOD,
} from "./memory/claim-policy.ts";
import type { PolicySupport } from "./memory/claim-visibility-policy.ts";
import {
    appendMaturityAssertionInCurrentTransaction,
    createPolicySubjectInCurrentTransaction,
    hasClaimPolicySchema,
    readPolicySupport,
    refreshEffectivePolicyInCurrentTransaction,
} from "./memory/storage-claim-policy.ts";
import {
    bumpEpochForClaimProjectInCurrentTransaction,
    refreshRevisionMaturityInCurrentTransaction,
} from "./memory/storage-memory-claims.ts";
import type { SourceTrustClass } from "./storage-claim-applicability-schema.ts";
import {
    CLAIM_POLICY_SEED_META_KEYS,
    type FineTaint,
    type MaturityLevel,
} from "./storage-claim-policy-schema.ts";

const SEED_ACTOR = "claim-policy-seed:v1";
/**
 * Seeding a revision issues roughly thirty statements (subject insert, support
 * aggregation, assertion append, projection refresh), so batches stay well
 * under the v84 write-lock budget of 2500ms — 2x margin below the 5s sibling
 * `busy_timeout` (see CLAIMS_BACKFILL_BATCH_SIZE and
 * docs/evidence/claims-backfill/v84-threshold.json).
 */
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_BUSY_RETRY_DELAYS_MS = [50, 100, 250, 500] as const;

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
    claimId: number;
    projectId: number;
    originObservationId: number | null;
    sourceTrustClass: SourceTrustClass | null;
    extractor: string | null;
    metadataSourceType: string | null;
}

function seedTaint(row: SeedRevisionRow): FineTaint {
    // Retained raw `user` provenance predates the v85 trust column; the v85
    // contract keeps it exactly so a later policy can re-derive channel
    // confidence (R25). Feed it in as the coarse class rather than mapping it
    // here, so `classifyFineTaint` stays the only coarse-to-fine authority —
    // the taint this returns is frozen in an append-only table and cannot be
    // repaired in place if the two ever disagree.
    const sourceTrustClass: SourceTrustClass =
        row.metadataSourceType === "user"
            ? "explicit_user"
            : (row.sourceTrustClass ?? "model_inference");
    return classifyFineTaint({ sourceTrustClass, extractor: row.extractor });
}

/**
 * The rung the seed may assert for a legacy revision. Shares the live
 * reducer's ceiling (`automaticMaturityTarget`) rather than the ungated
 * `supportedMaturity`: the frozen subject records `claimKind: "unknown"`,
 * which carries directive-strength restrictions, so a legacy revision whose
 * origin cannot originate a directive must stay CANDIDATE exactly like a new
 * one. Using the ungated reducer here would grandfather untrusted-origin
 * legacy rows straight into automatic visibility, and the ladder only moves
 * upward so the over-promotion would never be reconciled back down.
 */
function seedMaturity(support: PolicySupport, taint: FineTaint): MaturityLevel {
    return automaticMaturityTarget({
        kind: "unknown",
        originTaint: taint,
        independentGroups: support.independentGroups,
        verified: support.verified,
        explicitUserEvidence: support.explicitUserEvidence,
    });
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
                claims.id AS claimId,
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
    /** Bounded backoff before a contended batch reports `pending`. */
    retryDelaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
    yieldToEventLoop?: () => Promise<void>;
}

/** One committed batch's effect, applied to the run totals only after the
 * batch commits — a busy retry re-runs the body, so accumulating inside it
 * would double-count. */
type SeedBatchStep =
    | { kind: "seeded"; outcomes: Array<{ maturity: MaturityLevel; autoEligible: boolean }> }
    | { kind: "reconcile-reset" }
    | { kind: "complete" };

/**
 * Run bounded seed batches until done (or `maxBatches`). Deterministic and
 * resumable: each batch commits its subjects, streams, assertions, projection
 * rows, and cursor in one immediate transaction; a crash resumes to identical
 * results (AE9). Completion re-checks the whole table with an anti-join so a
 * revision added by a held-open v85 writer during reconciliation is seeded
 * before the completion watermark publishes.
 *
 * Async and cooperative on purpose (the v84 runner's shape): batches yield to
 * the event loop so a large corpus cannot stall the host, and a contended
 * batch backs off and reports `pending` instead of aborting the whole run.
 */
export async function runClaimPolicySeed(
    db: Database,
    options: RunClaimPolicySeedOptions = {},
): Promise<ClaimPolicySeedRunSummary> {
    const status = getClaimPolicySeedStatus(db);
    const emptyCounts: Record<string, number> = { CANDIDATE: 0, CORROBORATED: 0, VERIFIED: 0 };
    if (!status.applicable) {
        return {
            status: "noop",
            batches: 0,
            seeded: 0,
            seededCounts: status.seededCounts ?? emptyCounts,
            autoHidden: 0,
        };
    }
    if (status.phase === "complete") {
        // A v85 process that stayed open across the migration can append a
        // revision AFTER completion published; its writer creates no policy
        // subject, and nothing else ever would. One indexed anti-join probe
        // decides whether completion still holds; when it does not, seeding
        // resumes and completion republishes after the usual reconciliation.
        const straggler = selectUnseededBatch(db, 0, 1);
        if (straggler.length === 0) {
            return {
                status: "noop",
                batches: 0,
                seeded: 0,
                seededCounts: status.seededCounts ?? emptyCounts,
                autoHidden: 0,
            };
        }
    }
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
    const nowMs = options.nowMs ?? Date.now();
    const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_BUSY_RETRY_DELAYS_MS;
    const sleep =
        options.sleep ??
        ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    const yieldToEventLoop =
        options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));

    let batches = 0;
    let seeded = 0;
    let autoHidden = 0;
    const counts: Record<string, number> =
        status.seededCounts != null ? { ...emptyCounts, ...status.seededCounts } : emptyCounts;

    const runBatch = async (): Promise<SeedBatchStep | "busy"> => {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return db
                    .transaction(() => seedBatchInCurrentTransaction(db, batchSize, nowMs))
                    .immediate() as SeedBatchStep;
            } catch (error) {
                if (!isRetryableSqliteBusyError(error)) throw error;
                const delayMs = retryDelaysMs[attempt];
                if (delayMs === undefined) return "busy";
                await sleep(delayMs);
            }
        }
    };

    while (batches < maxBatches) {
        const step = await runBatch();
        if (step === "busy") break;
        if (step.kind === "complete") {
            return { status: "complete", batches, seeded, seededCounts: counts, autoHidden };
        }
        if (step.kind === "seeded") {
            for (const outcome of step.outcomes) {
                seeded += 1;
                counts[outcome.maturity] = (counts[outcome.maturity] ?? 0) + 1;
                if (!outcome.autoEligible) autoHidden += 1;
            }
        }
        batches += 1;
        await yieldToEventLoop();
    }
    return { status: "pending", batches, seeded, seededCounts: counts, autoHidden };
}

/** One batch inside an already-open immediate transaction. */
function seedBatchInCurrentTransaction(
    db: Database,
    batchSize: number,
    nowMs: number,
): SeedBatchStep {
    const cursor = Number(readMeta(db, CLAIM_POLICY_SEED_META_KEYS.cursor) ?? 0);
    const rows = selectUnseededBatch(db, cursor, batchSize);
    if (rows.length === 0) {
        // Final reconciliation: a full anti-join (cursor 0) catches rows a
        // held-open writer added behind the cursor.
        const remaining = selectUnseededBatch(db, 0, 1);
        if (remaining.length > 0) {
            writeMeta(db, CLAIM_POLICY_SEED_META_KEYS.cursor, "0");
            return { kind: "reconcile-reset" };
        }
        publishSeedCompletion(db);
        return { kind: "complete" };
    }
    // Seeding can flip a legacy revision into automatic visibility after the
    // migration's one-time epoch bump was already acknowledged; without a
    // fresh bump per affected project, cached m0/module snapshots keep
    // omitting the memory until an unrelated mutation lands. The bump
    // resolves the project through the memory crosswalk, so it runs per
    // eligible claim: unlinked claims no-op, and repeat bumps for one
    // project are harmless — consumers compare epochs, they do not count
    // them.
    const outcomes: Array<{ maturity: MaturityLevel; autoEligible: boolean }> = [];
    for (const row of rows) {
        const outcome = seedRevisionInCurrentTransaction(db, row, nowMs);
        outcomes.push(outcome);
        if (outcome.autoEligible) {
            bumpEpochForClaimProjectInCurrentTransaction(db, row.claimId);
        }
    }
    // Counts commit atomically with the subjects and cursor they describe: a
    // separate post-commit write could be lost to a crash, after which the
    // seeded revisions are no longer selected as unseeded and completion
    // would publish permanently underreported counts.
    const persistedCountsRaw = readMeta(db, CLAIM_POLICY_SEED_META_KEYS.seededCounts);
    let persistedCounts: Record<string, number> = {};
    if (persistedCountsRaw != null) {
        try {
            persistedCounts = JSON.parse(persistedCountsRaw) as Record<string, number>;
        } catch {
            persistedCounts = {};
        }
    }
    for (const outcome of outcomes) {
        persistedCounts[outcome.maturity] = (persistedCounts[outcome.maturity] ?? 0) + 1;
    }
    writeMeta(db, CLAIM_POLICY_SEED_META_KEYS.seededCounts, JSON.stringify(persistedCounts));
    writeMeta(db, CLAIM_POLICY_SEED_META_KEYS.cursor, String(rows[rows.length - 1].revisionId));
    return { kind: "seeded", outcomes };
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
    const maturity = seedMaturity(readPolicySupport(db, row.revisionId), taint);
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

/**
 * Refresh projections a policy-unaware writer left behind. A held-open v85
 * process can append a positive `verified` event without running the ladder
 * reducer; the read path deliberately lets only NEGATIVE authoritative facts
 * override the projection (a positive override would need a second evaluator
 * — the KTD10 trust bypass), so the newly verified revision stays
 * automatic-hidden until something refreshes it. One bounded startup pass
 * re-runs the reducer for current revisions whose latest verification
 * outcome is `verified` but whose projection still reads
 * automatic-ineligible; the refresh is idempotent and a row ineligible for
 * other reasons keeps its value.
 */
export function reconcileCompatibilityVerificationsAtStartup(db: Database): number {
    if (!hasClaimPolicySchema(db)) return 0;
    const divergent = db
        .prepare(
            `SELECT policy.revision_id AS revisionId
             FROM claim_effective_policy policy
             JOIN claims ON claims.current_revision_id = policy.revision_id
             WHERE policy.auto_eligible = 0
               AND (
                   SELECT outcome FROM verification_events
                   WHERE revision_id = policy.revision_id
                     AND outcome IN ('verified', 'stale', 'flagged')
                   ORDER BY id DESC LIMIT 1
               ) = 'verified'`,
        )
        .all() as Array<{ revisionId: number }>;
    if (divergent.length === 0) return 0;
    db.transaction(() => {
        for (const row of divergent) {
            refreshRevisionMaturityInCurrentTransaction(db, row.revisionId);
        }
    }).immediate();
    return divergent.length;
}

/** Publish completion only after count and anti-join reconciliation (KTD11).
 * Seeded counts are persisted per committed batch, so this only publishes the
 * phase and completion watermark. */
function publishSeedCompletion(db: Database): void {
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
}
