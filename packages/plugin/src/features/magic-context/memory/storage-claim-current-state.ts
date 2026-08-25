/**
 * Batched project-memory current-state provider (KTD6; R9-R12).
 *
 * One provider owns all project-memory reads: claims resolve by public
 * locator or authorized project set; revision attributes, evidence
 * summaries, applicability heads, lifecycle, policy, and telemetry hydrate
 * under one snapshot; policy visibility applies before any candidate limit;
 * the hydration snapshot closes; and the SnapshotVector is revalidated from
 * a fresh snapshot before the result may be published.
 *
 * Fail-closed contract: a null current-revision pointer, missing attributes
 * row, missing evidence, stale current pointer, malformed stored public ID,
 * or broken lifecycle head throws ClaimGraphCorruptionError instead of
 * serving unauditable claims.
 */

import type { Database } from "../../../shared/sqlite";
import type {
    ClaimMemoryLifecycleState,
    ClaimMemorySharing,
} from "../storage-claim-memory-schema.ts";
import { readDirectFormatMarker } from "../storage-format-epoch.ts";
import {
    type ClaimMutationToken,
    formatRevisionLocator,
    isValidPublicClaimId,
    type SnapshotVector,
} from "./claim-operation-contract.ts";
import {
    type ActiveDispositions,
    explicitSearchLabelFromFields,
} from "./claim-visibility-policy.ts";
import {
    type ApplicabilityAssertionRecord,
    readCurrentApplicabilityAssertions,
} from "./storage-claim-applicability.ts";
import {
    ClaimOperationInputError,
    computeProjectMemoryMutationToken,
} from "./storage-claim-operations.ts";
import { readActiveDispositions } from "./storage-claim-policy.ts";
import { ClaimGraphCorruptionError, resolveProjectId } from "./storage-claims.ts";
import type { MemoryScope } from "./types.ts";

export type ProjectMemorySurface =
    | "auto_inject"
    | "explicit_search"
    | "maintenance_hygiene"
    | "maintenance_verification";

export interface ProjectMemoryWorkspaceAuthorization {
    /** Projects owned by the active workspace member. */
    ownProjectIds: readonly number[];
    /** Foreign workspace categories explicitly shared with this member. */
    sharedCategories: readonly string[];
}

export interface ProjectMemoryCurrentStateRequest {
    /** Exact public locator lookup; combined with projectIds when both set. */
    publicClaimIds?: readonly string[];
    /** Authorized project set: only claims in these projects hydrate. */
    projectIds?: readonly number[];
    /** Optional workspace sharing filter, applied before the candidate limit. */
    workspaceAuthorization?: ProjectMemoryWorkspaceAuthorization;
    /** Policy surface applied before any candidate limit. */
    surface?: ProjectMemorySurface;
    /** Lifecycle states to include; defaults to live claims only. */
    lifecycleStates?: readonly ClaimMemoryLifecycleState[];
    /** Candidate cap applied after visibility filtering. */
    limit?: number;
    /** Opaque workspace-epoch signature bound into the SnapshotVector. */
    workspaceEpoch?: string;
    /** Expiry evaluation instant; defaults to Date.now(). */
    nowMs?: number;
}

export interface ProjectMemoryPolicyView {
    effectiveMaturity: string;
    originTaint: string;
    autoEligible: boolean;
    explicitEligible: boolean;
    hardHidden: boolean;
    policyVersion: number;
    generation: number;
}

export interface ProjectMemoryClaimSnapshot {
    publicClaimId: string;
    revisionLocator: string;
    revision: number;
    content: string;
    contentDigest: string;
    category: string;
    normalizedHash: string;
    importance: number;
    memoryScope: MemoryScope;
    sharing: ClaimMemorySharing;
    expiresAt: number | null;
    lifecycleState: ClaimMemoryLifecycleState;
    evidence: { observationCount: number; independenceKeys: string[] };
    applicability: ApplicabilityAssertionRecord[];
    policy: ProjectMemoryPolicyView;
    /** Authoritative disposition facts read from conflict/disposition/
     * verification rows, not the projection, so uniform absence holds even
     * when the projection lags a policy-unaware writer. */
    dispositions: ActiveDispositions;
    /** Sanitized evidence label for labeled explicit-search rendering; null
     * for clean rows. Never set on the auto_inject surface. */
    explicitLabel: string | null;
    telemetry: { seenCount: number; retrievalCount: number };
    verification: {
        latestOutcome: "verified" | "update" | "archive" | "stale" | "flagged" | null;
        verifiedAt: number;
    };
    mutationToken: ClaimMutationToken;
    projectId: number;
}

export type ProjectMemoryCurrentStateResult =
    | { status: "ok"; items: ProjectMemoryClaimSnapshot[]; snapshotVector: SnapshotVector }
    | { status: "stale"; reasons: string[] };

interface CandidateRow {
    claimId: number;
    projectId: number;
    publicId: string;
    currentRevisionId: number | null;
}

function resolveCandidates(
    db: Database,
    request: ProjectMemoryCurrentStateRequest,
): CandidateRow[] {
    const clauses: string[] = [];
    const bindings: Array<string | number> = [];
    if (request.publicClaimIds !== undefined) {
        for (const publicClaimId of request.publicClaimIds) {
            if (!isValidPublicClaimId(publicClaimId)) {
                throw new ClaimOperationInputError(`malformed public claim ID: ${publicClaimId}`);
            }
        }
        if (request.publicClaimIds.length === 0) return [];
        clauses.push(
            `claim_public_ids.public_id IN (${request.publicClaimIds.map(() => "?").join(", ")})`,
        );
        bindings.push(...request.publicClaimIds);
    }
    if (request.projectIds !== undefined) {
        if (request.projectIds.length === 0) return [];
        clauses.push(`claims.project_id IN (${request.projectIds.map(() => "?").join(", ")})`);
        bindings.push(...request.projectIds);
    }
    if (clauses.length === 0) {
        throw new ClaimOperationInputError(
            "current-state reads require public locators or an authorized project set",
        );
    }
    return db
        .prepare(
            // Interpolation is a compile-time placeholder list, not caller input.
            // pi-lens-ignore: sql-injection
            `SELECT claims.id AS claimId, claims.project_id AS projectId,
                    claim_public_ids.public_id AS publicId,
                    claims.current_revision_id AS currentRevisionId
               FROM claim_public_ids
               JOIN claims ON claims.id = claim_public_ids.claim_id
              WHERE ${clauses.join(" AND ")}
              ORDER BY claims.id`,
        )
        .all(...bindings) as CandidateRow[];
}

function hydrateClaim(db: Database, candidate: CandidateRow): ProjectMemoryClaimSnapshot {
    if (!isValidPublicClaimId(candidate.publicId)) {
        throw new ClaimGraphCorruptionError(
            `claim ${candidate.claimId} stores a malformed public ID; direct-SQL corruption`,
        );
    }
    if (candidate.currentRevisionId === null) {
        throw new ClaimGraphCorruptionError(
            `claim ${candidate.claimId} has a null current-revision pointer; direct-SQL corruption`,
        );
    }
    const revision = db
        .prepare(
            `SELECT revision, content, content_sha256 AS contentDigest,
                    (SELECT MAX(revision) FROM claim_revisions history
                      WHERE history.claim_id = claim_revisions.claim_id) AS maxRevision
               FROM claim_revisions WHERE id = ? AND claim_id = ?`,
        )
        .get(candidate.currentRevisionId, candidate.claimId) as
        | { revision: number; content: string; contentDigest: string; maxRevision: number }
        | undefined;
    if (!revision) {
        throw new ClaimGraphCorruptionError(
            `claim ${candidate.claimId} points at missing revision ${candidate.currentRevisionId}`,
        );
    }
    if (revision.revision !== revision.maxRevision) {
        throw new ClaimGraphCorruptionError(
            `claim ${candidate.claimId} pointer targets revision ${revision.revision} but history reaches ${revision.maxRevision}; direct-SQL corruption`,
        );
    }
    const attributes = db
        .prepare(
            `SELECT category, normalized_hash AS normalizedHash, importance,
                    memory_scope AS memoryScope, sharing, expires_at AS expiresAt
               FROM claim_memory_revision_attributes WHERE revision_id = ?`,
        )
        .get(candidate.currentRevisionId) as
        | {
              category: string;
              normalizedHash: string;
              importance: number;
              memoryScope: MemoryScope;
              sharing: ClaimMemorySharing;
              expiresAt: number | null;
          }
        | undefined;
    if (!attributes) {
        throw new ClaimGraphCorruptionError(
            `claim revision ${candidate.currentRevisionId} has no attributes row; direct-SQL corruption`,
        );
    }
    const lifecycle = db
        .prepare("SELECT state FROM claim_memory_lifecycle_heads WHERE claim_id = ?")
        .get(candidate.claimId) as { state: ClaimMemoryLifecycleState } | undefined;
    if (!lifecycle) {
        throw new ClaimGraphCorruptionError(
            `project-memory claim ${candidate.claimId} has no lifecycle head; direct-SQL corruption`,
        );
    }
    const evidenceRows = db
        .prepare(
            `SELECT observations.independence_key AS independenceKey
               FROM claim_evidence
               JOIN observations ON observations.id = claim_evidence.observation_id
              WHERE claim_evidence.revision_id = ?
              ORDER BY observations.independence_key`,
        )
        .all(candidate.currentRevisionId) as Array<{ independenceKey: string }>;
    if (evidenceRows.length === 0) {
        throw new ClaimGraphCorruptionError(
            `claim revision ${candidate.currentRevisionId} has no evidence rows; direct-SQL corruption`,
        );
    }
    const policy = db
        .prepare(
            `SELECT effective_maturity AS effectiveMaturity, origin_taint AS originTaint,
                    auto_eligible AS autoEligible, explicit_eligible AS explicitEligible,
                    hard_hidden AS hardHidden, policy_version AS policyVersion, generation
               FROM claim_effective_policy WHERE revision_id = ?`,
        )
        .get(candidate.currentRevisionId) as
        | {
              effectiveMaturity: string;
              originTaint: string;
              autoEligible: number;
              explicitEligible: number;
              hardHidden: number;
              policyVersion: number;
              generation: number;
          }
        | undefined;
    const telemetry = db
        .prepare(
            `SELECT seen_count AS seenCount, retrieval_count AS retrievalCount
               FROM claim_usage_stats WHERE claim_id = ?`,
        )
        .get(candidate.claimId) as { seenCount: number; retrievalCount: number } | undefined;
    const verification = db
        .prepare(
            `SELECT
                 (SELECT outcome FROM verification_events
                   WHERE revision_id = ? ORDER BY id DESC LIMIT 1) AS latestOutcome,
                 COALESCE(MAX(CASE WHEN outcome = 'verified' THEN created_at END), 0) AS verifiedAt
               FROM verification_events WHERE revision_id = ?`,
        )
        .get(candidate.currentRevisionId, candidate.currentRevisionId) as {
        latestOutcome: ProjectMemoryClaimSnapshot["verification"]["latestOutcome"];
        verifiedAt: number;
    };
    const locator = {
        publicClaimId: candidate.publicId,
        revision: revision.revision,
        contentDigest: revision.contentDigest,
    };
    const dispositions = readActiveDispositions(db, candidate.currentRevisionId);
    return {
        publicClaimId: candidate.publicId,
        revisionLocator: formatRevisionLocator(locator),
        revision: revision.revision,
        content: revision.content,
        contentDigest: revision.contentDigest,
        category: attributes.category,
        normalizedHash: attributes.normalizedHash,
        importance: attributes.importance,
        memoryScope: attributes.memoryScope,
        sharing: attributes.sharing,
        expiresAt: attributes.expiresAt,
        lifecycleState: lifecycle.state,
        evidence: {
            observationCount: evidenceRows.length,
            independenceKeys: [...new Set(evidenceRows.map((row) => row.independenceKey))],
        },
        applicability: readCurrentApplicabilityAssertions(db, candidate.currentRevisionId),
        policy: {
            // An absent projection reads as fail-closed defaults: hidden
            // from both surfaces at CANDIDATE.
            effectiveMaturity: policy?.effectiveMaturity ?? "CANDIDATE",
            originTaint: policy?.originTaint ?? "ASSISTANT_INFERENCE",
            autoEligible: policy?.autoEligible === 1,
            explicitEligible: policy?.explicitEligible === 1,
            hardHidden: policy ? policy.hardHidden === 1 : true,
            policyVersion: policy?.policyVersion ?? 0,
            generation: policy?.generation ?? 0,
        },
        dispositions,
        explicitLabel: null,
        telemetry: {
            seenCount: telemetry?.seenCount ?? 0,
            retrievalCount: telemetry?.retrievalCount ?? 0,
        },
        verification,
        mutationToken: computeProjectMemoryMutationToken(db, candidate.publicId),
        projectId: candidate.projectId,
    };
}

/**
 * The shared surface matrix (R10; U3 scenario 4). Expired claims and the
 * uniform-absence class (hard-hidden / contradicted / quarantined /
 * rejected) are ineligible everywhere. Authoritative soft-hide facts
 * (stale / disputed / superseded) outrank projected eligibility on the
 * automatic surface; explicit search keeps them as labeled rows.
 */
function workspaceAuthorized(
    item: ProjectMemoryClaimSnapshot,
    authorization: ProjectMemoryWorkspaceAuthorization | undefined,
): boolean {
    if (authorization === undefined) return true;
    if (authorization.ownProjectIds.includes(item.projectId)) return true;
    return (
        item.sharing === "shareable" &&
        ["project", "ecosystem", "universe"].includes(item.memoryScope) &&
        authorization.sharedCategories.includes(item.category)
    );
}

function surfaceDecision(
    item: ProjectMemoryClaimSnapshot,
    surface: ProjectMemorySurface,
    nowMs: number,
): { eligible: boolean; label: string | null } {
    if (item.expiresAt !== null && item.expiresAt <= nowMs) {
        return { eligible: false, label: null };
    }
    const facts = item.dispositions;
    if (item.policy.hardHidden || facts.contradicted || facts.quarantined || facts.rejected) {
        return { eligible: false, label: null };
    }
    const softHidden = facts.stale || facts.disputed || facts.superseded;
    if (surface === "maintenance_hygiene" || surface === "maintenance_verification") {
        if (facts.superseded) return { eligible: false, label: null };
        return {
            eligible: surface === "maintenance_verification" || (!facts.stale && !facts.disputed),
            label: null,
        };
    }
    if (surface === "auto_inject") {
        return { eligible: item.policy.autoEligible && !softHidden, label: null };
    }
    if (!item.policy.explicitEligible) return { eligible: false, label: null };
    const dispositions: string[] = [];
    if (facts.stale) dispositions.push("stale");
    if (facts.disputed) dispositions.push("disputed");
    if (facts.superseded) dispositions.push("superseded");
    return {
        eligible: true,
        label: explicitSearchLabelFromFields({
            effectiveMaturity: item.policy.effectiveMaturity,
            originTaint: item.policy.originTaint,
            dispositions,
            policyMissing: false,
            autoEligible: item.policy.autoEligible && !softHidden,
        }),
    };
}

function readGenerations(db: Database, projectIds: readonly number[]): Record<string, number> {
    const generations: Record<string, number> = {};
    for (const projectId of projectIds) {
        const row = db
            .prepare("SELECT generation FROM claim_project_generations WHERE project_id = ?")
            .get(projectId) as { generation: number } | undefined;
        generations[String(projectId)] = row?.generation ?? 0;
    }
    return generations;
}

function readSnapshotVector(
    db: Database,
    projectIds: readonly number[],
    workspaceEpoch: string,
): SnapshotVector {
    const marker = readDirectFormatMarker(db);
    const generations = readGenerations(db, projectIds);
    return {
        vectorVersion: 1,
        databaseIncarnationId:
            marker.status === "present" ? marker.marker.databaseIncarnationId : "",
        workspaceEpoch,
        projectGenerations: generations,
        // The current model allocates one generation stream per project for
        // claims AND policy; the vector keeps the two fields separate so
        // they may diverge without a contract change.
        policyGenerations: { ...generations },
    };
}

function snapshotVectorMismatches(before: SnapshotVector, after: SnapshotVector): string[] {
    const reasons: string[] = [];
    if (before.databaseIncarnationId !== after.databaseIncarnationId) {
        reasons.push("database incarnation changed");
    }
    if (before.workspaceEpoch !== after.workspaceEpoch) {
        reasons.push("workspace epoch changed");
    }
    for (const [projectId, generation] of Object.entries(before.projectGenerations)) {
        if (after.projectGenerations[projectId] !== generation) {
            reasons.push(`project ${projectId} generation moved`);
        }
    }
    for (const [projectId, generation] of Object.entries(before.policyGenerations)) {
        if (after.policyGenerations[projectId] !== generation) {
            reasons.push(`project ${projectId} policy generation moved`);
        }
    }
    return reasons;
}

const DEFAULT_LIFECYCLE_STATES: readonly ClaimMemoryLifecycleState[] = ["active"];

const claimMemoryFragmentPresent = new WeakMap<Database, true>();

export function hasClaimMemoryFragment(db: Database): boolean {
    if (claimMemoryFragmentPresent.has(db)) return true;
    const present =
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claim_public_ids'",
            )
            .get() != null;
    if (present) claimMemoryFragmentPresent.set(db, true);
    return present;
}

export function readProjectMemorySnapshotVector(
    db: Database,
    projectIds: readonly number[],
    workspaceEpoch: string,
): SnapshotVector {
    return readSnapshotVector(db, projectIds, workspaceEpoch);
}

export function snapshotVectorChanges(before: SnapshotVector, after: SnapshotVector): string[] {
    return snapshotVectorMismatches(before, after);
}

/**
 * Hydrate the requested current claim set under one snapshot, close it, then
 * revalidate the SnapshotVector from a fresh snapshot. Returns `stale`
 * instead of publishing when the vector moved between the two.
 */
export function readProjectMemoryCurrentState(
    db: Database,
    request: ProjectMemoryCurrentStateRequest,
): ProjectMemoryCurrentStateResult {
    const surface = request.surface ?? "explicit_search";
    const lifecycleStates = request.lifecycleStates ?? DEFAULT_LIFECYCLE_STATES;
    const workspaceEpoch = request.workspaceEpoch ?? "";
    const nowMs = request.nowMs ?? Date.now();
    let items: ProjectMemoryClaimSnapshot[] = [];
    let vector: SnapshotVector | undefined;
    // One deferred transaction = one hydration snapshot.
    db.transaction(() => {
        const candidates = resolveCandidates(db, request);
        const hydrated = candidates.map((candidate) => hydrateClaim(db, candidate));
        // Visibility before limits: lifecycle and policy filters run over
        // the full candidate set so a hidden claim cannot consume a slot.
        const visible: ProjectMemoryClaimSnapshot[] = [];
        for (const item of hydrated) {
            if (!lifecycleStates.includes(item.lifecycleState)) continue;
            if (!workspaceAuthorized(item, request.workspaceAuthorization)) continue;
            const decision = surfaceDecision(item, surface, nowMs);
            if (!decision.eligible) continue;
            visible.push(
                decision.label === null ? item : { ...item, explicitLabel: decision.label },
            );
        }
        items = request.limit === undefined ? visible : visible.slice(0, request.limit);
        const vectorProjects = [
            ...new Set(request.projectIds ?? candidates.map((row) => row.projectId)),
        ].sort((left, right) => left - right);
        vector = readSnapshotVector(db, vectorProjects, workspaceEpoch);
    })();
    if (vector === undefined) throw new Error("hydration produced no snapshot vector");
    const fresh = readSnapshotVector(
        db,
        Object.keys(vector.projectGenerations).map((key) => Number(key)),
        workspaceEpoch,
    );
    const mismatches = snapshotVectorMismatches(vector, fresh);
    if (mismatches.length > 0) return { status: "stale", reasons: mismatches };
    return { status: "ok", items, snapshotVector: vector };
}

/**
 * Resolve canonical project identities to numeric project IDs, skipping
 * identities with no registered project. Readers hold identity strings; the
 * provider keys on numeric project IDs.
 */
export function resolveProjectIdsForIdentities(
    db: Database,
    identities: readonly string[],
): number[] {
    const ids: number[] = [];
    for (const identity of identities) {
        if (identity.length === 0) continue;
        const id = resolveProjectId(db, identity);
        if (id !== null) ids.push(id);
    }
    return [...new Set(ids)].sort((left, right) => left - right);
}

/**
 * Cheap lifecycle-state count of project-memory claims for status and gate
 * surfaces. Counts the claim set the provider would hydrate (public-ID rows
 * with a matching lifecycle head), without hydration or policy filtering —
 * counts gate scheduling and status displays, not content publication.
 */
export function countProjectMemoryClaims(
    db: Database,
    request: {
        projectIds: readonly number[];
        lifecycleStates?: readonly ClaimMemoryLifecycleState[];
    },
): number {
    if (request.projectIds.length === 0) return 0;
    if (!hasClaimMemoryFragment(db)) return 0;
    const lifecycleStates = request.lifecycleStates ?? DEFAULT_LIFECYCLE_STATES;
    if (lifecycleStates.length === 0) return 0;
    const row = db
        .prepare(
            // Interpolation is a compile-time placeholder list, not caller input.
            // pi-lens-ignore: sql-injection
            `SELECT COUNT(*) AS cnt
               FROM claim_public_ids
               JOIN claims ON claims.id = claim_public_ids.claim_id
               JOIN claim_memory_lifecycle_heads heads ON heads.claim_id = claims.id
              WHERE claims.project_id IN (${request.projectIds.map(() => "?").join(", ")})
                AND heads.state IN (${lifecycleStates.map(() => "?").join(", ")})`,
        )
        .get(...request.projectIds, ...lifecycleStates) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
}
