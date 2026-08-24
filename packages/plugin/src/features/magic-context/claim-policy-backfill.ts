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

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite.ts";
import {
    DEFAULT_BUSY_RETRY_DELAYS_MS,
    runImmediateTransactionWithBusyRetry,
} from "./claims-backfill.ts";
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
    revokeEnforcementArtifactInCurrentTransaction,
} from "./memory/storage-claim-policy.ts";
import {
    bumpEpochForClaimProjectInCurrentTransaction,
    refreshRevisionMaturityInCurrentTransaction,
    runInMemoryClaimsWriteTransaction,
} from "./memory/storage-memory-claims.ts";
import { readSchemaMeta as readMeta, writeSchemaMeta as writeMeta } from "./schema-meta.ts";
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

export interface ClaimPolicySeedStatus {
    applicable: boolean;
    phase: "pending" | "complete" | null;
    boundaryRevisionId: number;
    expectedCount: number;
    cursor: number;
    seededCounts: Record<string, number> | null;
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
    revision: number;
    originObservationId: number | null;
    sourceTrustClass: SourceTrustClass | null;
    extractor: string | null;
    metadataSourceType: string | null;
}

/** Validated non-negative integer meta read (the sibling backfill's shape):
 *  a corrupted value reads as 0 instead of NaN, which would make every
 *  comparison silently false. */
function readIntMeta(db: Database, key: string): number {
    const parsed = Number.parseInt(readMeta(db, key) ?? "0", 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function seedTaint(row: SeedRevisionRow, boundaryRevisionId: number): FineTaint {
    // Retained raw `user` provenance predates the v85 trust column; the v85
    // contract keeps it exactly so a later policy can re-derive channel
    // confidence (R25). Feed it in as the coarse class rather than mapping it
    // here, so `classifyFineTaint` stays the only coarse-to-fine authority —
    // the taint this returns is frozen in an append-only table and cannot be
    // repaired in place if the two ever disagree.
    //
    // The explicit-user elevation holds only for the claim's FIRST revision,
    // mirroring `hasExplicitUserEvidence`: the pre-v86 rewrite path copied
    // the retained `user` source type onto later revisions' metadata and
    // observations even when the bytes were model-authored replacements, and
    // every unseeded revision here predates this build (the seed boundary or
    // a held-open v85 writer). A later revision's user stamp is therefore
    // untrustworthy — taking it would let a model rewrite originate
    // directives with USER_EXPLICIT taint, frozen forever.
    const observedClass: SourceTrustClass = row.sourceTrustClass ?? "model_inference";
    // The metadata elevation is additionally gated to AT OR BELOW the seed
    // boundary, mirroring `hasExplicitUserEvidence`'s metadata branch: a
    // post-boundary straggler comes from a held-open pre-v86 writer, and its
    // retained `user` metadata stamp must not freeze USER_EXPLICIT taint the
    // live evidence reader would refuse for the same revision.
    const sourceTrustClass: SourceTrustClass =
        row.revision === 1
            ? row.metadataSourceType === "user" && row.revisionId <= boundaryRevisionId
                ? "explicit_user"
                : observedClass
            : observedClass === "explicit_user"
              ? "model_inference"
              : observedClass;
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
                claim_revisions.revision AS revision,
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

    const runBatch = (): Promise<SeedBatchStep | "busy"> =>
        runImmediateTransactionWithBusyRetry(
            db,
            () => seedBatchInCurrentTransaction(db, batchSize, nowMs),
            { retryDelaysMs, sleep },
        );

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
    const taint = seedTaint(row, readIntMeta(db, CLAIM_POLICY_SEED_META_KEYS.boundaryRevisionId));
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
 * automatic-hidden until something refreshes it. Each startup re-runs the
 * reducer for current revisions whose latest verification outcome is
 * `verified` but whose projection still reads automatic-ineligible; the
 * refresh is idempotent and a row ineligible for other reasons keeps its
 * value.
 *
 * Two bounds keep the pass cheap on a large corpus. An event-id watermark
 * skips events a previous pass already examined — every in-process
 * eligibility change runs the reducer itself, so only unexamined raw events
 * can create new divergence, and a legitimately ineligible verified row (an
 * untrusted directive that must stay CANDIDATE) stops re-matching on every
 * startup. Events are walked in fixed-size id-ordered pages, each committing
 * in its own transaction, so the pass never materializes the corpus or holds
 * the shared write lock end to end; the watermark advances only after every
 * page commits, and a crash mid-pass re-probes idempotently from the old
 * watermark.
 *
 * Negative events (`stale`/`flagged`) from the same writer need no refresh —
 * the reader's authoritative soft-hide already outranks the projection — but
 * cached automatic lanes (m0 snapshots, the native mirror) key on the
 * project-memory epoch, which a policy-unaware writer also cannot bump. Each
 * unexamined negative event on a current revision therefore bumps its
 * claim's project epochs here so those caches refold.
 */
/** Per-project throttle for the artifact-revalidation probe: rehashing every
 *  enforced artifact on every transform pass would put file I/O on the hot
 *  path for a condition (a deleted or edited artifact) that is rare. */
const artifactRevalidationLastRunMs = new Map<string, number>();
const ARTIFACT_REVALIDATION_INTERVAL_MS = 5 * 60 * 1000;

/** Test seam: clears the per-project throttle. */
export function __resetArtifactRevalidationThrottleForTests(): void {
    artifactRevalidationLastRunMs.clear();
}

/**
 * Re-verify that every currently valid enforcement artifact still exists on
 * disk with the recorded bytes. ENFORCED maturity is earned by a passing
 * evaluation of exact artifact bytes; editing or deleting the recorded
 * `canonical_path` after the fact would otherwise leave the rung standing
 * forever, because validity reads only the stored `pass` result and explicit
 * revocation events. A missing or digest-drifted artifact gets a revocation
 * event plus a policy refresh, so `supportedMaturity` falls back to the
 * revision's next supported rung. A missing PROJECT ROOT is treated as
 * "cannot judge" (checkout absent or moved) and revokes nothing.
 */
export function revalidateEnforcementArtifacts(
    db: Database,
    projectIdentity: string,
    projectRoot: string,
    nowMs = Date.now(),
): void {
    if (!hasClaimPolicySchema(db)) return;
    // The throttle key carries the CHECKOUT root, not just the identity:
    // worktrees and clones share one identity, artifacts are scoped by
    // enforced_from_root, and an identity-only key would let whichever
    // checkout runs first after each interval starve the others' probes.
    const throttleKey = `${projectIdentity}\u0000${projectRoot}`;
    const last = artifactRevalidationLastRunMs.get(throttleKey) ?? 0;
    if (nowMs - last < ARTIFACT_REVALIDATION_INTERVAL_MS) return;
    artifactRevalidationLastRunMs.set(throttleKey, nowMs);
    // The filesystem walk runs OFF the caller's synchronous path AND uses
    // asynchronous reads: the probe is invoked from the transform hot path,
    // and a large artifact must not block the event loop even when the
    // deferred callback runs — each read and hash yields. The throttle
    // above already coalesces concurrent passes.
    void revalidateEnforcementArtifactsNow(db, projectIdentity, projectRoot, nowMs).catch(
        (error) => {
            log(
                `[claim-policy] artifact revalidation failed (retrying on a later probe): ${error instanceof Error ? error.message : String(error)}`,
            );
        },
    );
}

/** Streamed SHA-256: read and hash yield per chunk, so hashing a large
 *  artifact never pins the event loop the way a whole-buffer
 *  createHash().update() would. */
async function sha256FileStreaming(absolutePath: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) {
        hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
}

async function revalidateEnforcementArtifactsNow(
    db: Database,
    projectIdentity: string,
    projectRoot: string,
    nowMs: number,
): Promise<void> {
    if (!existsSync(projectRoot)) return;
    const projectRow = db
        .prepare("SELECT id FROM projects WHERE canonical_identity = ?")
        .get(projectIdentity) as { id: number } | null | undefined;
    if (!projectRow) return;
    const artifacts = db
        .prepare(
            // Scoped to artifacts THIS checkout enforced: clones and
            // worktrees share the project identity, and another checkout
            // legitimately lacks or differs at the same relative path — a
            // NULL owning root (legacy row) is unjudgeable and skipped.
            `SELECT artifact.id AS id, artifact.revision_id AS revisionId,
                    artifact.canonical_path AS canonicalPath,
                    artifact.bytes_digest AS bytesDigest,
                    claim_revisions.claim_id AS claimId
               FROM claim_enforcement_artifacts artifact
               JOIN claim_revisions ON claim_revisions.id = artifact.revision_id
              WHERE artifact.project_id = ?
                AND artifact.evaluator_result = 'pass'
                AND artifact.enforced_from_root = ?
                AND NOT EXISTS (
                    SELECT 1 FROM claim_enforcement_artifact_events event
                    WHERE event.artifact_id = artifact.id AND event.action = 'revoked'
                )`,
        )
        .all(projectRow.id, projectRoot) as Array<{
        id: number;
        revisionId: number;
        canonicalPath: string;
        bytesDigest: string;
        claimId: number;
    }>;
    // Resolve the owning root once: per-artifact containment compares live
    // resolved paths, so a legitimately symlinked root must not itself read
    // as an escape. An unresolvable root leaves nothing to validate.
    let rootReal: string;
    try {
        rootReal = await realpath(projectRoot);
    } catch {
        return;
    }
    for (const artifact of artifacts) {
        // canonical_path is recorded project-relative and traversal-checked
        // at record time; re-guard here so a corrupted row cannot make the
        // probe hash a file outside the owning root.
        const relative = normalize(artifact.canonicalPath);
        if (isAbsolute(relative) || relative === ".." || relative.startsWith(`..${sep}`)) {
            continue;
        }
        const absolute = join(projectRoot, relative);
        let drifted: string | null = null;
        try {
            // The lexical guard above cannot see symlinks: the artifact or a
            // parent directory replaced by a link out of the owning root
            // would pass the join and hash an external file that happens to
            // hold the recorded bytes. Require the LIVE resolved path to
            // stay under the resolved root before trusting any digest.
            const live = await realpath(absolute);
            if (live !== rootReal && !live.startsWith(`${rootReal}${sep}`)) {
                drifted = "artifact escapes the owning root";
            } else {
                // Streamed hash: reading AND hashing yield per chunk, so a
                // large artifact never pins the event loop. ENOENT means the
                // file is gone (a drift); any other read error is
                // indistinguishable from transient I/O.
                const digest = await sha256FileStreaming(live);
                if (digest !== artifact.bytesDigest) drifted = "artifact bytes drifted";
            }
        } catch (error) {
            const code = (error as { code?: string } | null)?.code;
            if (code === "ENOENT") {
                drifted = "artifact file missing";
            } else if (code === "EISDIR" || code === "ENOTDIR") {
                // A path replaced by a directory (or a parent replaced by a
                // file) is a PERMANENT type change, not transient I/O: the
                // recorded regular file no longer exists, and skipping would
                // keep the claim ENFORCED forever on a recurring error.
                drifted = "artifact replaced by a non-file";
            } else {
                continue;
            }
        }
        if (drifted === null) continue;
        try {
            runInMemoryClaimsWriteTransaction(db, () => {
                // Re-read the FILE inside the transaction too: an artifact
                // edited or removed and then restored to its recorded bytes
                // between the check above and this write must not be
                // permanently revoked while valid — the same
                // bytes-at-commit discipline the enforcement command applies
                // before recording.
                try {
                    const live = realpathSync(absolute);
                    if (
                        (live === rootReal || live.startsWith(`${rootReal}${sep}`)) &&
                        statSync(live).isFile() &&
                        createHash("sha256").update(readFileSync(live)).digest("hex") ===
                            artifact.bytesDigest
                    ) {
                        return;
                    }
                } catch (error) {
                    // ENOENT/EISDIR/ENOTDIR at commit time confirm the drift
                    // being committed (missing file or a path replaced by a
                    // non-file) — fall through to revoke, or the permanent
                    // type change would keep the claim ENFORCED on every
                    // recurring probe. Anything else is indistinguishable
                    // from transient I/O; keep the artifact and retry later.
                    const code = (error as { code?: string } | null)?.code;
                    if (code !== "ENOENT" && code !== "EISDIR" && code !== "ENOTDIR") {
                        return;
                    }
                }
                // Re-check inside the transaction: a concurrent revocation
                // must not be doubled. Every drifted artifact is revoked —
                // not only the latest — because an older still-valid pass
                // row becomes the support again the moment a newer one is
                // revoked.
                const stillValid = db
                    .prepare(
                        `SELECT 1 FROM claim_enforcement_artifacts artifact
                          WHERE artifact.id = ?
                            AND NOT EXISTS (
                                SELECT 1 FROM claim_enforcement_artifact_events event
                                WHERE event.artifact_id = artifact.id
                                  AND event.action = 'revoked'
                            )`,
                    )
                    .get(artifact.id);
                if (!stillValid) return;
                revokeEnforcementArtifactInCurrentTransaction(
                    db,
                    artifact.id,
                    `revalidation: ${drifted}`,
                    nowMs,
                );
                refreshEffectivePolicyInCurrentTransaction(db, artifact.revisionId, { nowMs });
                bumpEpochForClaimProjectInCurrentTransaction(db, artifact.claimId);
            });
            log(
                `[claim-policy] revoked enforcement artifact ${artifact.id} for revision ${artifact.revisionId}: ${drifted}`,
            );
        } catch (error) {
            log(
                `[claim-policy] artifact revalidation revoke failed (retrying on a later probe): ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

/** In-flight guard so overlapping transform/sync passes cannot start
 *  concurrent straggler-seed runs against the same database. */
let lateSeedInFlight = false;

/**
 * Seed compatibility revisions appended AFTER the startup seeder finished.
 * A held-open v85 process can append a claim revision at any time; its
 * writer creates no policy subject or projection, so the revision reads as
 * automatic-hidden until seeded. The startup runner's completed-phase
 * anti-join only fires when the runner is invoked, and startup is its only
 * scheduled invocation — this probe gives ongoing lanes a cheap way to
 * notice stragglers (one O(1) MAX(id) read when idle; the anti-join runs
 * only when a new revision appeared since the last clean probe) and kick
 * the bounded async seeder without blocking the calling pass.
 */
/** Highest claim-revision id proven fully seeded per database handle: the
 *  anti-join probe below is NOT cheap when everything is seeded (every row
 *  fails NOT EXISTS, so LIMIT 1 never short-circuits and the whole table is
 *  walked), so hot-path calls first compare MAX(id) — an O(1) primary-key
 *  read — against this watermark and skip the anti-join entirely until a
 *  new revision appears. Seeding never un-seeds, so a clean probe at
 *  MAX(id)=N proves every id <= N stays seeded. */
const lateSeedVerifiedMaxRevisionId = new WeakMap<Database, number>();

export function seedLateCompatibilityRevisions(db: Database): void {
    if (lateSeedInFlight) return;
    if (!hasClaimPolicySchema(db)) return;
    const maxRevisionId = (
        db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM claim_revisions").get() as {
            id: number;
        }
    ).id;
    if (maxRevisionId <= (lateSeedVerifiedMaxRevisionId.get(db) ?? -1)) return;
    if (selectUnseededBatch(db, 0, 1).length === 0) {
        lateSeedVerifiedMaxRevisionId.set(db, maxRevisionId);
        return;
    }
    lateSeedInFlight = true;
    void runClaimPolicySeed(db)
        .catch((error) => {
            log(
                `[claim-policy-seed] late-revision seed failed (retrying on a later pass): ${error instanceof Error ? error.message : String(error)}`,
            );
        })
        .finally(() => {
            lateSeedInFlight = false;
        });
}

export function reconcileCompatibilityVerifications(db: Database): number {
    if (!hasClaimPolicySchema(db)) return 0;
    const watermark = Number(
        readMeta(db, CLAIM_POLICY_SEED_META_KEYS.reconcileEventWatermark) ?? 0,
    );
    const maxEventId = (
        db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM verification_events").get() as {
            id: number;
        }
    ).id;
    if (maxEventId <= watermark) return 0;
    const RECONCILE_PAGE_SIZE = 100;
    let refreshed = 0;
    let cursor = watermark;
    const bumpedClaims = new Set<number>();
    while (cursor < maxEventId) {
        const events = db
            .prepare(
                `SELECT events.id AS id, events.revision_id AS revisionId,
                        events.outcome AS outcome, claims.id AS claimId
                 FROM verification_events events
                 JOIN claims ON claims.current_revision_id = events.revision_id
                 WHERE events.id > ? AND events.id <= ?
                   AND events.outcome IN ('verified', 'stale', 'flagged')
                 ORDER BY events.id LIMIT ?`,
            )
            .all(cursor, maxEventId, RECONCILE_PAGE_SIZE) as Array<{
            id: number;
            revisionId: number;
            outcome: "verified" | "stale" | "flagged";
            claimId: number;
        }>;
        if (events.length === 0) break;
        cursor = events[events.length - 1].id;
        db.transaction(() => {
            for (const event of events) {
                if (event.outcome === "verified") {
                    const divergent = db
                        .prepare(
                            `SELECT 1 FROM claim_effective_policy policy
                             WHERE policy.revision_id = ? AND policy.auto_eligible = 0
                               AND (
                                   SELECT outcome FROM verification_events
                                   WHERE revision_id = policy.revision_id
                                     AND outcome IN ('verified', 'stale', 'flagged')
                                   ORDER BY id DESC LIMIT 1
                               ) = 'verified'`,
                        )
                        .get(event.revisionId);
                    if (divergent) {
                        refreshRevisionMaturityInCurrentTransaction(db, event.revisionId);
                        refreshed += 1;
                    }
                    // A verified event can also HEAL a prior soft hide
                    // (verified -> stale -> verified): the projection never
                    // stopped reading eligible, so the divergence probe sees
                    // nothing, but automatic caches keyed on the project
                    // epoch dropped the row when the stale event bumped it
                    // and need another bump to pick it back up. Compatibility
                    // events are rare and watermarked, so the conservative
                    // bump per claim is cheap.
                    if (!bumpedClaims.has(event.claimId)) {
                        bumpedClaims.add(event.claimId);
                        bumpEpochForClaimProjectInCurrentTransaction(db, event.claimId);
                    }
                } else if (!bumpedClaims.has(event.claimId)) {
                    bumpedClaims.add(event.claimId);
                    bumpEpochForClaimProjectInCurrentTransaction(db, event.claimId);
                }
            }
        }).immediate();
    }
    // Monotonic advance: two hosts can reconcile the shared database
    // concurrently, and the slower one's lower maxEventId must not overwrite
    // a higher stored watermark — re-consuming negative events would bump
    // project epochs again on every pass and thrash the prompt and native
    // caches. Re-read inside the write transaction.
    db.transaction(() => {
        const stored = Number(
            readMeta(db, CLAIM_POLICY_SEED_META_KEYS.reconcileEventWatermark) ?? 0,
        );
        if (maxEventId > stored) {
            writeMeta(db, CLAIM_POLICY_SEED_META_KEYS.reconcileEventWatermark, String(maxEventId));
        }
    }).immediate();
    return refreshed;
}

/** Publish completion only after count and anti-join reconciliation (KTD11).
 * Seeded counts are persisted per committed batch, so this only publishes the
 * phase and completion watermark. */
function publishSeedCompletion(db: Database): void {
    // Validated integer reads: `Number(...)` on a corrupted meta value
    // yields NaN, and NaN comparisons are always false, so the fail-closed
    // completion guard below would silently pass instead of throwing.
    const boundary = readIntMeta(db, CLAIM_POLICY_SEED_META_KEYS.boundaryRevisionId);
    const expected = readIntMeta(db, CLAIM_POLICY_SEED_META_KEYS.expectedCount);
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
