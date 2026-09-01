/**
 * This module provides transactional writers and fail-closed readers for the authoritative claims-and-evidence domain.
 *
 * Every multi-row writer runs in either an immediate transaction or a caller-held transaction.
 * Each multi-row writer claims the caller's expected current-revision pointer before inserting rows.
 * Each multi-row writer finishes with a compare-and-swap whose change count is exactly one.
 * A stale writer rolls back its revision and evidence rows.
 * A stale writer returns recoverable `stale` rather than leaving partial authoritative rows.
 *
 * Node's type-stripping loader cannot resolve extensionless runtime imports, so runtime specifiers use `.ts`.
 * This module keeps the project-registry lookup local to avoid a runtime dependency on `storage-project-identities.ts`.
 * `storage-project-identities.ts`.
 *
 * Each `...InCurrentTransaction` primitive requires the caller to hold a write transaction.
 * `...InCurrentTransaction` primitives never issue BEGIN or COMMIT.
 * At the top level, `.immediate()` issues BEGIN IMMEDIATE; inside a transaction, it creates a stacked savepoint.
 */

import { createHash } from "node:crypto";
import type { Database } from "../../../shared/sqlite";
import {
    APPLICABILITY_BASELINE_STREAM_KEY,
    APPLICABILITY_STREAM_KEY_PROTOCOL,
    type SourceTrustClass,
} from "../storage-claim-applicability-schema.ts";
import {
    hasClaimApplicabilitySchema,
    type RevisionApplicabilityInput,
    writeRevisionApplicabilityInCurrentTransaction,
} from "./storage-claim-applicability.ts";

export type ClaimState = "active" | "permanent" | "archived";
export type EvidenceRelation = "supports" | "merged_from";
export type ConflictRelation = "contradicts" | "supersedes";
export type VerificationOutcome = "verified" | "update" | "archive" | "stale" | "flagged";

export class ClaimGraphCorruptionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ClaimGraphCorruptionError";
    }
}

/* */
export function sha256Utf8Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function toRowId(result: unknown): number {
    const rowid = (result as { lastInsertRowid?: number | bigint }).lastInsertRowid;
    const value = Number(rowid);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`insert did not produce a safe row id: ${String(rowid)}`);
    }
    return value;
}

function changeCount(result: unknown): number {
    return Number((result as { changes?: number | bigint }).changes ?? 0);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function resolveProjectId(db: Database, identity: string): number | null {
    const row = db
        .prepare("SELECT project_id FROM project_aliases WHERE alias_identity = ?")
        .get(identity) as { project_id?: unknown } | undefined;
    return typeof row?.project_id === "number" ? row.project_id : null;
}

// `assertCanonicalProjectIdentity` must match `isCanonicalProjectIdentity` in `storage-project-identities.ts`.
function assertCanonicalProjectIdentity(canonicalIdentity: string): void {
    if (
        !(canonicalIdentity.startsWith("git:") || canonicalIdentity.startsWith("dir:")) ||
        canonicalIdentity.length <= "git:".length
    ) {
        throw new Error(`not a canonical git:/dir: project identity: ${canonicalIdentity}`);
    }
}

/**
 * `ensureProjectInCurrentTransaction` requires the caller to hold a write transaction.
 * transaction.
 */
export function ensureProjectInCurrentTransaction(db: Database, canonicalIdentity: string): number {
    assertCanonicalProjectIdentity(canonicalIdentity);
    const existing = resolveProjectId(db, canonicalIdentity);
    if (existing !== null) return existing;
    const now = Date.now();
    const projectId = toRowId(
        db
            .prepare("INSERT INTO projects (canonical_identity, created_at) VALUES (?, ?)")
            .run(canonicalIdentity, now),
    );
    db.prepare(
        "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, ?)",
    ).run(canonicalIdentity, projectId, now);
    return projectId;
}

/**
 * After losing a unique-key race, `ensureProject` re-reads the inserted project row.
 */
export function ensureProject(db: Database, canonicalIdentity: string): number {
    assertCanonicalProjectIdentity(canonicalIdentity);
    const existing = resolveProjectId(db, canonicalIdentity);
    if (existing !== null) return existing;
    try {
        return db
            .transaction(() => ensureProjectInCurrentTransaction(db, canonicalIdentity))
            .immediate();
    } catch (error) {
        const raced = resolveProjectId(db, canonicalIdentity);
        if (raced !== null) return raced;
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Evidence flows from episodes to source spans to observations.
// ---------------------------------------------------------------------------

export interface EpisodeInput {
    projectId: number;
    /** Evidence-chain rows exist only for provenance and are excluded from session lifecycle cleanup joins. */
    sourceSessionId?: string | null;
}

export function createEpisode(db: Database, input: EpisodeInput): number {
    return toRowId(
        db
            .prepare(
                "INSERT INTO episodes (project_id, source_session_id, created_at) VALUES (?, ?, ?)",
            )
            .run(input.projectId, input.sourceSessionId ?? null, Date.now()),
    );
}

export interface SourceSpanInput {
    episodeId: number;
    sourceLocator: string;
    /** The database stores only each raw span text's SHA-256. */
    content: string;
    startOffset: number;
    endOffset: number;
    rawArtifactRef?: string | null;
}

export function createSourceSpan(db: Database, input: SourceSpanInput): number {
    return toRowId(
        db
            .prepare(
                `INSERT INTO source_spans
                    (episode_id, source_locator, content_sha256, start_offset, end_offset, raw_artifact_ref, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                input.episodeId,
                input.sourceLocator,
                sha256Utf8Hex(input.content),
                input.startOffset,
                input.endOffset,
                input.rawArtifactRef ?? null,
                Date.now(),
            ),
    );
}

export interface ObservationInput {
    sourceSpanId: number;
    extractedText: string;
    extractor: string;
    extractorVersion: string;
    extractorRunId: string;
    independenceKey: string;
    /** An omitted source trust class uses the schema's conservative `model_inference` default. */
    sourceTrustClass?: SourceTrustClass;
}

export function createObservation(db: Database, input: ObservationInput): number {
    const columns = [
        "source_span_id",
        "extracted_text",
        "content_sha256",
        "extractor",
        "extractor_version",
        "extractor_run_id",
        "independence_key",
    ];
    const values: Array<string | number> = [
        input.sourceSpanId,
        input.extractedText,
        sha256Utf8Hex(input.extractedText),
        input.extractor,
        input.extractorVersion,
        input.extractorRunId,
        input.independenceKey,
    ];
    if (input.sourceTrustClass !== undefined) {
        columns.push("source_trust_class");
        values.push(input.sourceTrustClass);
    }
    columns.push("created_at");
    values.push(Date.now());
    const placeholders = columns.map(() => "?").join(", ");
    return toRowId(
        db
            // Column names come from the fixed list above, never caller input.
            // pi-lens-ignore: sql-injection
            .prepare(`INSERT INTO observations (${columns.join(", ")}) VALUES (${placeholders})`)
            .run(...values),
    );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface ClaimEvidenceInput {
    observationId: number;
    relation?: EvidenceRelation;
}

export type ClaimWriteOutcome =
    | { status: "applied"; claimId: number; revisionId: number; revision: number }
    | { status: "stale" }
    | { status: "not_found" }
    | { status: "invalid"; reason: string };

interface NormalizedEvidence {
    observationId: number;
    relation: EvidenceRelation;
}

type EvidenceValidation =
    | { ok: true; evidence: NormalizedEvidence[] }
    | { ok: false; reason: string };

function normalizeEvidence(
    db: Database,
    projectId: number,
    evidence: readonly ClaimEvidenceInput[],
): EvidenceValidation {
    if (evidence.length === 0) {
        return { ok: false, reason: "a claim revision requires nonempty evidence" };
    }
    const byObservation = new Map<number, EvidenceRelation>();
    for (const item of evidence) {
        const relation = item.relation ?? "supports";
        const existing = byObservation.get(item.observationId);
        if (existing !== undefined && existing !== relation) {
            return {
                ok: false,
                reason: `observation ${item.observationId} listed with conflicting relations`,
            };
        }
        byObservation.set(item.observationId, relation);
    }
    const observationIds = [...byObservation.keys()];
    const placeholders = observationIds.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT observations.id AS observationId, episodes.project_id AS projectId
               FROM observations
               JOIN source_spans ON source_spans.id = observations.source_span_id
               JOIN episodes ON episodes.id = source_spans.episode_id
              WHERE observations.id IN (${placeholders})`,
        )
        .all(...observationIds) as Array<{ observationId?: unknown; projectId?: unknown }>;
    const projectByObservation = new Map<number, number>();
    for (const row of rows) {
        if (typeof row.observationId === "number" && typeof row.projectId === "number") {
            projectByObservation.set(row.observationId, row.projectId);
        }
    }
    const normalized: NormalizedEvidence[] = [];
    for (const [observationId, relation] of byObservation) {
        const owner = projectByObservation.get(observationId);
        if (owner === undefined) {
            return { ok: false, reason: `observation ${observationId} does not exist` };
        }
        if (owner !== projectId) {
            return {
                ok: false,
                reason: `observation ${observationId} belongs to project ${owner}, not ${projectId}`,
            };
        }
        normalized.push({ observationId, relation });
    }
    return { ok: true, evidence: normalized };
}

function insertRevisionWithEvidence(
    db: Database,
    args: {
        claimId: number;
        revision: number;
        content: string;
        sourceSessionId: string | null;
        evidence: readonly NormalizedEvidence[];
        now: number;
    },
): { revisionId: number; contentSha256: string } {
    const contentSha256 = sha256Utf8Hex(args.content);
    const revisionId = toRowId(
        db
            .prepare(
                `INSERT INTO claim_revisions
                    (claim_id, revision, content, content_sha256, source_session_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
                args.claimId,
                args.revision,
                args.content,
                contentSha256,
                args.sourceSessionId,
                args.now,
            ),
    );
    const insertEvidence = db.prepare(
        "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const item of args.evidence) {
        insertEvidence.run(revisionId, item.observationId, item.relation, args.now);
    }
    return { revisionId, contentSha256 };
}

/**
 * Applicability rolls back with the revision transaction.
 * The transaction writes caller-supplied lineage when present; otherwise it writes the `unknown` baseline.
 * stream.
 */
function writeNewRevisionApplicability(
    db: Database,
    args: {
        revisionId: number;
        projectId: number;
        contentSha256: string;
        now: number;
        applicability?: RevisionApplicabilityInput;
    },
): void {
    if (!hasClaimApplicabilitySchema(db)) return;
    const applicability: RevisionApplicabilityInput = args.applicability ?? {
        ownerKind: "source",
        streamKey: APPLICABILITY_BASELINE_STREAM_KEY,
        keyProtocol: APPLICABILITY_STREAM_KEY_PROTOCOL,
        sourceDigest: args.contentSha256,
        assertion: {
            state: "unknown",
            paths: { state: "unknown" },
            knownFrom: args.now,
            recordedAt: args.now,
        },
    };
    writeRevisionApplicabilityInCurrentTransaction(db, {
        revisionId: args.revisionId,
        projectId: args.projectId,
        applicability,
    });
}

export interface CreateClaimInput {
    projectId: number;
    subject: string;
    predicate: string;
    scope?: string;
    state?: ClaimState;
    content: string;
    evidence: readonly ClaimEvidenceInput[];
    sourceSessionId?: string | null;
    /* */
    applicability?: RevisionApplicabilityInput;
}

/** `createClaimInCurrentTransaction` requires the caller to hold a write transaction. */
export function createClaimInCurrentTransaction(
    db: Database,
    input: CreateClaimInput,
): ClaimWriteOutcome {
    const now = Date.now();
    const validated = normalizeEvidence(db, input.projectId, input.evidence);
    if (!validated.ok) return { status: "invalid", reason: validated.reason };

    const scope = input.scope ?? "";
    const duplicate = db
        .prepare(
            "SELECT id FROM claims WHERE project_id = ? AND subject = ? AND predicate = ? AND scope = ?",
        )
        .get(input.projectId, input.subject, input.predicate, scope) as { id: number } | undefined;
    if (duplicate) {
        return {
            status: "invalid",
            reason: `claim ${duplicate.id} already owns this semantic key; append a revision instead`,
        };
    }

    const claimId = toRowId(
        db
            .prepare(
                `INSERT INTO claims
                    (project_id, subject, predicate, scope, state, current_revision_id, created_at)
                 VALUES (?, ?, ?, ?, ?, NULL, ?)`,
            )
            .run(
                input.projectId,
                input.subject,
                input.predicate,
                scope,
                input.state ?? "active",
                now,
            ),
    );
    const { revisionId, contentSha256 } = insertRevisionWithEvidence(db, {
        claimId,
        revision: 1,
        content: input.content,
        sourceSessionId: input.sourceSessionId ?? null,
        evidence: validated.evidence,
        now,
    });
    writeNewRevisionApplicability(db, {
        revisionId,
        projectId: input.projectId,
        contentSha256,
        now,
        applicability: input.applicability,
    });
    const published = changeCount(
        db
            .prepare(
                "UPDATE claims SET current_revision_id = ? WHERE id = ? AND current_revision_id IS NULL",
            )
            .run(revisionId, claimId),
    );
    if (published !== 1) {
        throw new Error(
            `claim ${claimId} bootstrap pointer publish changed ${published} rows; expected exactly 1`,
        );
    }
    return { status: "applied", claimId, revisionId, revision: 1 };
}

/** `createClaimInCurrentTransaction` atomically creates the claim, revision 1, and evidence links. */
export function createClaim(db: Database, input: CreateClaimInput): ClaimWriteOutcome {
    return db.transaction(() => createClaimInCurrentTransaction(db, input)).immediate();
}

export interface AppendClaimRevisionInput {
    claimId: number;
    /** `expectedCurrentRevisionId` must be the revision ID the caller last read. */
    expectedCurrentRevisionId: number;
    content: string;
    evidence: readonly ClaimEvidenceInput[];
    sourceSessionId?: string | null;
    /* */
    applicability?: RevisionApplicabilityInput;
}

/**
 * appendClaimRevisionInCurrentTransaction requires a caller-held write transaction and validates expectedCurrentRevisionId before insertion.
 * The final CAS advances the pointer after inserting the revision.
 * The immediate transaction serializes writers across processes.
 * The pointer read checks staleness; it does not lock the row.
 */
export function appendClaimRevisionInCurrentTransaction(
    db: Database,
    input: AppendClaimRevisionInput,
): ClaimWriteOutcome {
    const now = Date.now();
    // The immediate transaction serializes writers; the final CAS reasserts expectedCurrentRevisionId.
    // The claim_id predicate enforces the composite pointer foreign key when foreign keys are disabled.
    const current = db
        .prepare(
            `SELECT claims.project_id AS projectId, pointed.revision AS revision
               FROM claims
               JOIN claim_revisions AS pointed
                 ON pointed.id = claims.current_revision_id
                AND pointed.claim_id = claims.id
              WHERE claims.id = ? AND claims.current_revision_id = ?`,
        )
        .get(input.claimId, input.expectedCurrentRevisionId) as
        | { projectId: number; revision: number }
        | undefined;
    if (!current) {
        const claim = db
            .prepare("SELECT current_revision_id AS pointer FROM claims WHERE id = ?")
            .get(input.claimId) as { pointer: number | null } | undefined;
        if (!claim) return { status: "not_found" };
        if (claim.pointer === input.expectedCurrentRevisionId) {
            throw new ClaimGraphCorruptionError(
                `claim ${input.claimId} current pointer ${input.expectedCurrentRevisionId} has no revision row`,
            );
        }
        return { status: "stale" };
    }

    const validated = normalizeEvidence(db, current.projectId, input.evidence);
    if (!validated.ok) return { status: "invalid", reason: validated.reason };

    // A backward-repointed pointer makes current.revision + 1 collide with existing history.
    // A caller that reads a backward-repointed pointer can satisfy the CAS.
    // The explicit check throws ClaimGraphCorruptionError before the append-only trigger rejects the insert.
    const maxRevision = db
        .prepare("SELECT MAX(revision) AS max FROM claim_revisions WHERE claim_id = ?")
        .get(input.claimId) as { max: number | null };
    if (maxRevision.max !== current.revision) {
        throw new ClaimGraphCorruptionError(
            `claim ${input.claimId} pointer targets revision ${current.revision} but history reaches ${String(maxRevision.max)}; direct-SQL corruption`,
        );
    }

    const revision = current.revision + 1;
    const { revisionId, contentSha256 } = insertRevisionWithEvidence(db, {
        claimId: input.claimId,
        revision,
        content: input.content,
        sourceSessionId: input.sourceSessionId ?? null,
        evidence: validated.evidence,
        now,
    });
    writeNewRevisionApplicability(db, {
        revisionId,
        projectId: current.projectId,
        contentSha256,
        now,
        applicability: input.applicability,
    });
    const advanced = changeCount(
        db
            .prepare(
                "UPDATE claims SET current_revision_id = ? WHERE id = ? AND current_revision_id = ?",
            )
            .run(revisionId, input.claimId, input.expectedCurrentRevisionId),
    );
    if (advanced !== 1) {
        throw new Error(
            `claim ${input.claimId} pointer CAS changed ${advanced} rows; expected exactly 1`,
        );
    }
    return { status: "applied", claimId: input.claimId, revisionId, revision };
}

export function appendClaimRevision(
    db: Database,
    input: AppendClaimRevisionInput,
): ClaimWriteOutcome {
    return db.transaction(() => appendClaimRevisionInCurrentTransaction(db, input)).immediate();
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface ClaimConflictInput {
    relation: ConflictRelation;
    leftRevisionId: number;
    rightRevisionId: number;
}

/**
 * addClaimConflict requires a caller-held write transaction.
 * Contradiction endpoints are canonically ordered because contradiction is symmetric.
 * A reverse duplicate contradiction returns the existing row.
 * Supersession preserves the caller's direction; database guards require distinct claims in the same project and prohibit reverse supersession.
 */
export function addClaimConflictInCurrentTransaction(
    db: Database,
    input: ClaimConflictInput,
): number {
    let { leftRevisionId, rightRevisionId } = input;
    if (input.relation === "contradicts" && leftRevisionId > rightRevisionId) {
        [leftRevisionId, rightRevisionId] = [rightRevisionId, leftRevisionId];
    }
    const existing = db
        .prepare(
            "SELECT id FROM claim_conflicts WHERE relation = ? AND left_revision_id = ? AND right_revision_id = ?",
        )
        .get(input.relation, leftRevisionId, rightRevisionId) as { id: number } | undefined;
    if (existing) return existing.id;
    return toRowId(
        db
            .prepare(
                `INSERT INTO claim_conflicts (relation, left_revision_id, right_revision_id, created_at)
                 VALUES (?, ?, ?, ?)`,
            )
            .run(input.relation, leftRevisionId, rightRevisionId, Date.now()),
    );
}

export function addClaimConflict(db: Database, input: ClaimConflictInput): number {
    return db.transaction(() => addClaimConflictInCurrentTransaction(db, input)).immediate();
}

export interface VerificationEventInput {
    revisionId: number;
    observationId?: number | null;
    outcome: VerificationOutcome;
    verifier: string;
}

/** An unverified claim has no verification events. */
export function addVerificationEvent(db: Database, input: VerificationEventInput): number {
    return toRowId(
        db
            .prepare(
                `INSERT INTO verification_events (revision_id, observation_id, outcome, verifier, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
                input.revisionId,
                input.observationId ?? null,
                input.outcome,
                input.verifier,
                Date.now(),
            ),
    );
}

// ---------------------------------------------------------------------------
// Fail-closed readers
// ---------------------------------------------------------------------------

export interface ClaimRecord {
    id: number;
    projectId: number;
    subject: string;
    predicate: string;
    scope: string;
    state: ClaimState;
    currentRevisionId: number;
    createdAt: number;
}

export interface ClaimRevisionRecord {
    id: number;
    claimId: number;
    revision: number;
    content: string;
    contentSha256: string;
    sourceSessionId: string | null;
    createdAt: number;
}

export interface ClaimEvidenceRecord {
    revisionId: number;
    observationId: number;
    relation: EvidenceRelation;
    createdAt: number;
}

/**
 */
export interface ClaimGraphCorruptionReport {
    nullPointerClaimIds: number[];
    evidencelessRevisionIds: number[];
    /** A pointer below the maximum revision indicates a direct-SQL rollback that the clear guard cannot detect.
     * */
    stalePointerClaimIds: number[];
}

export function findClaimGraphCorruption(db: Database): ClaimGraphCorruptionReport {
    const nullPointer = db
        .prepare("SELECT id FROM claims WHERE current_revision_id IS NULL ORDER BY id")
        .all() as Array<{ id: number }>;
    const evidenceless = db
        .prepare(
            `SELECT claim_revisions.id AS id FROM claim_revisions
              WHERE NOT EXISTS (
                  SELECT 1 FROM claim_evidence WHERE claim_evidence.revision_id = claim_revisions.id
              )
              ORDER BY claim_revisions.id`,
        )
        .all() as Array<{ id: number }>;
    const stalePointer = db
        .prepare(
            `SELECT claims.id AS id FROM claims
               JOIN claim_revisions AS current ON current.id = claims.current_revision_id
              WHERE current.revision <> (
                  SELECT MAX(revision) FROM claim_revisions WHERE claim_id = claims.id
              )
              ORDER BY claims.id`,
        )
        .all() as Array<{ id: number }>;
    return {
        nullPointerClaimIds: nullPointer.map((row) => row.id),
        evidencelessRevisionIds: evidenceless.map((row) => row.id),
        stalePointerClaimIds: stalePointer.map((row) => row.id),
    };
}

export function getClaimById(db: Database, claimId: number): ClaimRecord | null {
    const row = db
        .prepare(
            `SELECT id, project_id AS projectId, subject, predicate, scope, state,
                    current_revision_id AS currentRevisionId, created_at AS createdAt
               FROM claims WHERE id = ?`,
        )
        .get(claimId) as
        | (Omit<ClaimRecord, "currentRevisionId"> & {
              currentRevisionId: number | null;
          })
        | null;
    if (!row) return null;
    if (row.currentRevisionId === null) {
        throw new ClaimGraphCorruptionError(
            `claim ${claimId} has a null current-revision pointer; direct-SQL corruption`,
        );
    }
    return row as ClaimRecord;
}

function assertRevisionsHaveEvidence(
    db: Database,
    revisions: readonly ClaimRevisionRecord[],
): void {
    if (revisions.length === 0) return;
    const ids = revisions.map((revision) => revision.id);
    const placeholders = ids.map(() => "?").join(", ");
    const missing = db
        .prepare(
            `SELECT id FROM claim_revisions
              WHERE id IN (${placeholders})
                AND NOT EXISTS (
                    SELECT 1 FROM claim_evidence WHERE claim_evidence.revision_id = claim_revisions.id
                )
              LIMIT 1`,
        )
        .get(...ids) as { id: number } | undefined;
    if (missing) {
        throw new ClaimGraphCorruptionError(
            `claim revision ${missing.id} has no evidence rows; direct-SQL corruption`,
        );
    }
}

export function listClaimRevisions(db: Database, claimId: number): ClaimRevisionRecord[] {
    // getClaimById rejects claims with a null current_revision_id.
    const claim = getClaimById(db, claimId);
    if (!claim) return [];
    const revisions = db
        .prepare(
            `SELECT id, claim_id AS claimId, revision, content, content_sha256 AS contentSha256,
                    source_session_id AS sourceSessionId, created_at AS createdAt
               FROM claim_revisions WHERE claim_id = ? ORDER BY revision`,
        )
        .all(claimId) as ClaimRevisionRecord[];
    assertCurrentPointerIsMaxRevision(claim, revisions);
    assertRevisionsHaveEvidence(db, revisions);
    return revisions;
}

/**
 * A pointer below the maximum revision indicates a direct-SQL rollback.
 * current.
 */
function assertCurrentPointerIsMaxRevision(
    claim: ClaimRecord,
    revisions: readonly ClaimRevisionRecord[],
): void {
    const pointed = revisions.find((revision) => revision.id === claim.currentRevisionId);
    const maxRevision = revisions.at(-1)?.revision;
    if (!pointed || pointed.revision !== maxRevision) {
        throw new ClaimGraphCorruptionError(
            `claim ${claim.id} pointer targets revision ${pointed?.revision ?? "none"} but history reaches ${String(maxRevision)}; direct-SQL corruption`,
        );
    }
}

export function getCurrentClaimRevision(db: Database, claimId: number): ClaimRevisionRecord | null {
    const claim = getClaimById(db, claimId);
    if (!claim) return null;
    const revision = db
        .prepare(
            `SELECT id, claim_id AS claimId, revision, content, content_sha256 AS contentSha256,
                    source_session_id AS sourceSessionId, created_at AS createdAt
               FROM claim_revisions WHERE id = ?`,
        )
        .get(claim.currentRevisionId) as ClaimRevisionRecord | null;
    if (!revision) {
        throw new ClaimGraphCorruptionError(
            `claim ${claimId} points at missing revision ${claim.currentRevisionId}`,
        );
    }
    const maxRevision = db
        .prepare("SELECT MAX(revision) AS max FROM claim_revisions WHERE claim_id = ?")
        .get(claimId) as { max: number | null };
    if (revision.revision !== maxRevision.max) {
        throw new ClaimGraphCorruptionError(
            `claim ${claimId} pointer targets revision ${revision.revision} but history reaches ${String(maxRevision.max)}; direct-SQL corruption`,
        );
    }
    assertRevisionsHaveEvidence(db, [revision]);
    return revision;
}

export function getRevisionEvidence(db: Database, revisionId: number): ClaimEvidenceRecord[] {
    const rows = db
        .prepare(
            `SELECT revision_id AS revisionId, observation_id AS observationId, relation,
                    created_at AS createdAt
               FROM claim_evidence WHERE revision_id = ? ORDER BY observation_id`,
        )
        .all(revisionId) as ClaimEvidenceRecord[];
    if (rows.length === 0) {
        // The module treats an existing revision with zero evidence as corruption; only a nonexistent revision reads as empty.
        // The module treats an existing revision with zero evidence as corruption; only a nonexistent revision reads as empty.
        const revisionExists = db
            .prepare("SELECT 1 FROM claim_revisions WHERE id = ? LIMIT 1")
            .get(revisionId);
        if (revisionExists) {
            throw new ClaimGraphCorruptionError(
                `claim revision ${revisionId} has no evidence rows; direct-SQL corruption`,
            );
        }
    }
    return rows;
}
