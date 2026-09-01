/**
 *
 *
 */

import type { Database } from "../../../shared/sqlite";
import type {
    ClaimMemoryLifecycleState,
    ClaimMemorySharing,
} from "../storage-claim-memory-schema.ts";
import { readDirectFormatMarker } from "../storage-format-epoch.ts";
import { computeWorkspaceEpochFingerprint } from "../workspaces.ts";
import {
    type ClaimMutationToken,
    formatRevisionLocator,
    isValidPublicClaimId,
    type SnapshotVector,
} from "./claim-operation-contract.ts";
import {
    type ActiveDispositions,
    CLAIM_POLICY_VERSION,
    explicitSearchLabelFromFields,
} from "./claim-visibility-policy.ts";
import { ANTI_MEMORY_CATEGORY } from "./constants.ts";
import {
    type ApplicabilityAssertionRecord,
    readCurrentApplicabilityAssertions,
} from "./storage-claim-applicability.ts";
import {
    ClaimOperationInputError,
    computeProjectMemoryMutationToken,
} from "./storage-claim-operations.ts";
import { readActiveDispositions } from "./storage-claim-policy.ts";
import { antiMemoryClaimSql, uniformlyAbsentClaimSql } from "./storage-claim-visibility.ts";
import { ClaimGraphCorruptionError, resolveProjectId } from "./storage-claims.ts";
import type { MemoryScope } from "./types.ts";

export type ProjectMemorySurface =
    | "auto_inject"
    | "explicit_search"
    | "maintenance_hygiene"
    | "maintenance_verification";

/**
 * Rejected approaches may reach only these surfaces.
 *
 * Anti-memory rows store approaches the user rejected.
 *
 * `explicit_search` shows warnings the user requested.
 * `auto_inject` and `maintenance_hygiene` cannot read anti-memory rows because rewriting can drop the negation and create positive guidance.
 *
 * Every anti-memory write uses the typed API in `storage-anti-memory.ts`.
 * The typed API preserves anti-memory category, TTL, and outcome vocabulary.
 * Generic revision-access paths refuse `ANTI_MEMORY_CATEGORY` through `refuseGenericAntiMemoryRevisionAccess`.
 *
 * No lane may expose anti-memory if it can recreate content under another category.
 */
const ANTI_MEMORY_VISIBLE_SURFACES: ReadonlySet<ProjectMemorySurface> = new Set([
    "explicit_search",
    "maintenance_verification",
]);

export interface ProjectMemoryWorkspaceAuthorization {
    /* */
    ownProjectIds: readonly number[];
    /** Members may access only explicitly shared foreign workspace categories. */
    sharedCategories: readonly string[];
}

export interface ProjectMemoryCurrentStateRequest {
    /** The provider treats each publicClaimId as an exact public locator and combines it with projectIds when both are set. */
    publicClaimIds?: readonly string[];
    /** The provider hydrates claims only from authorized projectIds. */
    projectIds?: readonly number[];
    /** The provider applies workspaceAuthorization before the candidate limit. */
    workspaceAuthorization?: ProjectMemoryWorkspaceAuthorization;
    /** The provider applies surface before the candidate limit. */
    surface?: ProjectMemorySurface;
    /** The provider defaults lifecycleStates to live claims only. */
    lifecycleStates?: readonly ClaimMemoryLifecycleState[];
    /** The provider applies limit after visibility filtering. */
    limit?: number;
    /** The provider binds workspaceEpoch into the SnapshotVector. */
    workspaceEpoch?: string;
    /**
     * `workspaceIdentities` identifies the workspaces used to derive `workspaceEpoch` and `workspaceAuthorization`.
     * Supplying `workspaceIdentities` lets the provider recompute the fingerprint at publication time.
     * The provider recomputes the fingerprint from current state instead of echoing the caller's value.
     * Recomputing from current state is required to detect membership or shared-category revocation during a read.
     */
    workspaceIdentities?: readonly string[];
    /** The provider defaults nowMs to Date.now(). */
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
    /** The provider reads authoritative disposition facts from conflict/disposition/verification rows rather than the projection.
     * Reading conflict/disposition/verification rows preserves uniform absence when projections lag policy-unaware writers.
     * */
    dispositions: ActiveDispositions;
    /** The provider sets the sanitized evidence label only for labeled explicit-search rows; clean rows use `null`, and `auto_inject` never sets it.
     * */
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
    // Candidate-query filtering prevents automatic surfaces from hydrating anti-memory rows that `surfaceDecision` would later reject.
    // The provider retains `surfaceDecision` as an authoritative defense-in-depth check after candidate filtering.
    if (!ANTI_MEMORY_VISIBLE_SURFACES.has(request.surface ?? "explicit_search")) {
        clauses.push(`NOT ${antiMemoryClaimSql("claims.current_revision_id")}`);
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
            // An absent projection is hidden by default.
            // An absent projection hides the claim from both surfaces at CANDIDATE.
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
 * Expired claims and hard-hidden, contradicted, quarantined, or rejected claims are ineligible on every surface.
 * Stale, disputed, and superseded facts outrank projected eligibility on the automatic surface.
 * Explicit search returns stale, disputed, and superseded claims as labeled rows.
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
    // Rejected approaches are visible only on surfaces in `ANTI_MEMORY_VISIBLE_SURFACES`.
    if (item.category === ANTI_MEMORY_CATEGORY && !ANTI_MEMORY_VISIBLE_SURFACES.has(surface)) {
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
    // The evaluator must not use `autoEligible` or `explicitEligible` when `policyVersion` exceeds `CLAIM_POLICY_VERSION`.
    // Claims evaluated under unsupported policy semantics must not be auto-injected.
    const versionUnsupported = item.policy.policyVersion > CLAIM_POLICY_VERSION;
    if (surface === "auto_inject") {
        return {
            eligible: !versionUnsupported && item.policy.autoEligible && !softHidden,
            label: null,
        };
    }
    if (!versionUnsupported && !item.policy.explicitEligible) {
        return { eligible: false, label: null };
    }
    const dispositions: string[] = [];
    if (facts.stale) dispositions.push("stale");
    if (facts.disputed) dispositions.push("disputed");
    if (facts.superseded) dispositions.push("superseded");
    return {
        eligible: true,
        label: explicitSearchLabelFromFields({
            // Unsupported revisions use `policy:unknown` instead of raw future-version maturity and taint values.
            effectiveMaturity: versionUnsupported ? "CANDIDATE" : item.policy.effectiveMaturity,
            originTaint: versionUnsupported ? "unknown" : item.policy.originTaint,
            dispositions,
            policyMissing: versionUnsupported,
            autoEligible: !versionUnsupported && item.policy.autoEligible && !softHidden,
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
        // The fields remain separate because their generations may diverge.
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
 * The operation hydrates under one snapshot, then revalidates `SnapshotVector` from a fresh snapshot before publishing.
 * The reader returns `stale` when `SnapshotVector` changes before publication.
 */
export function readProjectMemoryCurrentState(
    db: Database,
    request: ProjectMemoryCurrentStateRequest,
): ProjectMemoryCurrentStateResult {
    const surface = request.surface ?? "explicit_search";
    const lifecycleStates = request.lifecycleStates ?? DEFAULT_LIFECYCLE_STATES;
    const suppliedWorkspaceEpoch = request.workspaceEpoch ?? "";
    // Each read recomputes caller-supplied identity epochs from current state.
    const readWorkspaceEpoch = (): string =>
        request.workspaceIdentities === undefined
            ? suppliedWorkspaceEpoch
            : computeWorkspaceEpochFingerprint(db, request.workspaceIdentities);
    const workspaceEpoch = readWorkspaceEpoch();
    // If the workspace moved after authorization, `workspaceAuthorization` is stale; only the caller can rebuild it.
    if (
        request.workspaceIdentities !== undefined &&
        suppliedWorkspaceEpoch !== "" &&
        suppliedWorkspaceEpoch !== workspaceEpoch
    ) {
        return { status: "stale", reasons: ["workspaceEpoch"] };
    }
    const nowMs = request.nowMs ?? Date.now();
    let items: ProjectMemoryClaimSnapshot[] = [];
    let vector: SnapshotVector | undefined;
    // Each deferred transaction uses one hydration snapshot.
    db.transaction(() => {
        const candidates = resolveCandidates(db, request);
        const hydrated = candidates.map((candidate) => hydrateClaim(db, candidate));
        // The query applies lifecycle and policy filters before limits so hidden claims cannot consume slots.
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
        readWorkspaceEpoch(),
    );
    const mismatches = snapshotVectorMismatches(vector, fresh);
    if (mismatches.length > 0) return { status: "stale", reasons: mismatches };
    return { status: "ok", items, snapshotVector: vector };
}

/**
 * The reader ignores identities without registered projects because it uses identity strings while the provider keys projects by numeric ID.
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

export interface ProjectClaimLifecycleCensus {
    total: number;
    active: number;
    archived: number;
    retired: number;
    ids: number[];
    archivedIds: number[];
    retiredIds: number[];
}

export function censusProjectMemoryClaims(
    db: Database,
    projectIdentity: string,
): ProjectClaimLifecycleCensus {
    const census: ProjectClaimLifecycleCensus = {
        total: 0,
        active: 0,
        archived: 0,
        retired: 0,
        ids: [],
        archivedIds: [],
        retiredIds: [],
    };
    if (!hasClaimMemoryFragment(db)) return census;
    const projectId = resolveProjectId(db, projectIdentity);
    if (projectId === null) return census;
    const rows = db
        .prepare(
            `SELECT claims.id AS id, heads.state AS state
               FROM claim_public_ids
               JOIN claims ON claims.id = claim_public_ids.claim_id
               JOIN claim_memory_lifecycle_heads heads ON heads.claim_id = claims.id
              WHERE claims.project_id = ?
              ORDER BY claims.id`,
        )
        .all(projectId) as Array<{ id: number; state: string }>;
    for (const row of rows) {
        census.total += 1;
        census.ids.push(row.id);
        if (row.state === "archived") {
            census.archived += 1;
            census.archivedIds.push(row.id);
        } else if (row.state === "retired") {
            census.retired += 1;
            census.retiredIds.push(row.id);
        } else {
            census.active += 1;
        }
    }
    return census;
}

/**
 * The count includes public-ID rows with a matching lifecycle head and excludes hydration and policy filtering.
 * The count supports gate scheduling and status displays, not content publication.
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
                AND heads.state IN (${lifecycleStates.map(() => "?").join(", ")})
                AND NOT ${antiMemoryClaimSql("claims.current_revision_id")}
                AND NOT ${uniformlyAbsentClaimSql("claims.current_revision_id", "unixepoch('subsec') * 1000")}`,
        )
        .get(...request.projectIds, ...lifecycleStates) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
}
