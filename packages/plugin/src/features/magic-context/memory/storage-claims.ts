/**
 * Typed transactional writers and fail-closed readers for the authoritative
 * claims-and-evidence domain (migration v82): projects, episodes, source
 * spans, observations, claims, immutable claim revisions, evidence links,
 * revision-scoped conflicts, and verification events.
 *
 * Write protocol: every multi-row writer runs under BEGIN IMMEDIATE, claims
 * the caller's expected current-revision pointer before inserting anything,
 * and finishes with a compare-and-swap whose change count must be exactly one.
 * A stale writer therefore rolls back its revision and evidence rows and gets
 * a recoverable `stale` outcome instead of leaving partial authoritative rows.
 *
 * Dependency-light on purpose: only type-only and `node:` imports, so the Node
 * SQLite smoke script can load this module under Node's type-stripping loader
 * (which cannot resolve extensionless runtime imports). That is also why the
 * small project-registry lookup is not imported from
 * `storage-project-identities.ts`.
 *
 * Callers must not hold an open transaction: writers own BEGIN IMMEDIATE.
 */

import { createHash } from "node:crypto";
import type { Database } from "../../../shared/sqlite";

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

/** Exact bytes-of-record hash: UTF-8 SHA-256, never the normalized memory MD5. */
export function sha256Utf8Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function withImmediateTransaction<T>(db: Database, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Connection-level failures leave nothing to roll back.
        }
        throw error;
    }
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

/**
 * Resolve or register the numeric project for a canonical `git:`/`dir:`
 * identity. Idempotent across racing connections: a unique-key loser re-reads
 * the inserted project row. The prefix predicate mirrors
 * `isCanonicalProjectIdentity` in storage-project-identities.ts; keep the two
 * in sync.
 */
export function ensureProject(db: Database, canonicalIdentity: string): number {
    if (
        !(canonicalIdentity.startsWith("git:") || canonicalIdentity.startsWith("dir:")) ||
        canonicalIdentity.length <= "git:".length
    ) {
        throw new Error(`not a canonical git:/dir: project identity: ${canonicalIdentity}`);
    }
    const existing = resolveProjectId(db, canonicalIdentity);
    if (existing !== null) return existing;
    const now = Date.now();
    try {
        return withImmediateTransaction(db, () => {
            const raced = resolveProjectId(db, canonicalIdentity);
            if (raced !== null) return raced;
            const projectId = toRowId(
                db
                    .prepare("INSERT INTO projects (canonical_identity, created_at) VALUES (?, ?)")
                    .run(canonicalIdentity, now),
            );
            db.prepare(
                "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, ?)",
            ).run(canonicalIdentity, projectId, now);
            return projectId;
        });
    } catch (error) {
        const raced = resolveProjectId(db, canonicalIdentity);
        if (raced !== null) return raced;
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Evidence chain: episodes → source spans → observations
// ---------------------------------------------------------------------------

export interface EpisodeInput {
    projectId: number;
    /** Provenance only; never joined to session lifecycle cleanup. */
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
    /** Raw span text; only its SHA-256 is stored. */
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
}

export function createObservation(db: Database, input: ObservationInput): number {
    return toRowId(
        db
            .prepare(
                `INSERT INTO observations
                    (source_span_id, extracted_text, content_sha256, extractor, extractor_version, extractor_run_id, independence_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                input.sourceSpanId,
                input.extractedText,
                sha256Utf8Hex(input.extractedText),
                input.extractor,
                input.extractorVersion,
                input.extractorRunId,
                input.independenceKey,
                Date.now(),
            ),
    );
}

// ---------------------------------------------------------------------------
// Claims and immutable revisions
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
    const projectOf = db.prepare(
        `SELECT episodes.project_id AS projectId
           FROM observations
           JOIN source_spans ON source_spans.id = observations.source_span_id
           JOIN episodes ON episodes.id = source_spans.episode_id
          WHERE observations.id = ?`,
    );
    const normalized: NormalizedEvidence[] = [];
    for (const [observationId, relation] of byObservation) {
        const row = projectOf.get(observationId) as { projectId?: unknown } | undefined;
        if (typeof row?.projectId !== "number") {
            return { ok: false, reason: `observation ${observationId} does not exist` };
        }
        if (row.projectId !== projectId) {
            return {
                ok: false,
                reason: `observation ${observationId} belongs to project ${row.projectId}, not ${projectId}`,
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
): number {
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
                sha256Utf8Hex(args.content),
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
    return revisionId;
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
}

/** Create a claim, its revision 1, and its evidence links atomically. */
export function createClaim(db: Database, input: CreateClaimInput): ClaimWriteOutcome {
    const now = Date.now();
    return withImmediateTransaction(db, (): ClaimWriteOutcome => {
        const validated = normalizeEvidence(db, input.projectId, input.evidence);
        if (!validated.ok) return { status: "invalid", reason: validated.reason };

        const scope = input.scope ?? "";
        const duplicate = db
            .prepare(
                "SELECT id FROM claims WHERE project_id = ? AND subject = ? AND predicate = ? AND scope = ?",
            )
            .get(input.projectId, input.subject, input.predicate, scope) as
            | { id: number }
            | undefined;
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
        const revisionId = insertRevisionWithEvidence(db, {
            claimId,
            revision: 1,
            content: input.content,
            sourceSessionId: input.sourceSessionId ?? null,
            evidence: validated.evidence,
            now,
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
    });
}

export interface AppendClaimRevisionInput {
    claimId: number;
    /** The current revision id the caller last read; the CAS expectation. */
    expectedCurrentRevisionId: number;
    content: string;
    evidence: readonly ClaimEvidenceInput[];
    sourceSessionId?: string | null;
}

/**
 * Append an immutable revision. The transaction validates the caller's
 * expected pointer before inserting a revision, then advances the pointer
 * with a final CAS. BEGIN IMMEDIATE provides the cross-process serialization;
 * the pointer probe is the staleness check, not a row lock.
 */
export function appendClaimRevision(
    db: Database,
    input: AppendClaimRevisionInput,
): ClaimWriteOutcome {
    const now = Date.now();
    return withImmediateTransaction(db, (): ClaimWriteOutcome => {
        const claimed = changeCount(
            db
                .prepare(
                    "UPDATE claims SET current_revision_id = current_revision_id WHERE id = ? AND current_revision_id = ?",
                )
                .run(input.claimId, input.expectedCurrentRevisionId),
        );
        if (claimed !== 1) {
            const exists = db.prepare("SELECT 1 FROM claims WHERE id = ?").get(input.claimId);
            return exists ? { status: "stale" } : { status: "not_found" };
        }

        const claimRow = db
            .prepare("SELECT project_id AS projectId FROM claims WHERE id = ?")
            .get(input.claimId) as { projectId: number };
        const validated = normalizeEvidence(db, claimRow.projectId, input.evidence);
        if (!validated.ok) return { status: "invalid", reason: validated.reason };

        const expected = db
            .prepare("SELECT revision FROM claim_revisions WHERE id = ? AND claim_id = ?")
            .get(input.expectedCurrentRevisionId, input.claimId) as
            | { revision: number }
            | undefined;
        if (!expected) {
            throw new ClaimGraphCorruptionError(
                `claim ${input.claimId} current pointer ${input.expectedCurrentRevisionId} has no revision row`,
            );
        }

        const revision = expected.revision + 1;
        const revisionId = insertRevisionWithEvidence(db, {
            claimId: input.claimId,
            revision,
            content: input.content,
            sourceSessionId: input.sourceSessionId ?? null,
            evidence: validated.evidence,
            now,
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
    });
}

// ---------------------------------------------------------------------------
// Conflicts and verification events
// ---------------------------------------------------------------------------

export interface ClaimConflictInput {
    relation: ConflictRelation;
    leftRevisionId: number;
    rightRevisionId: number;
}

/**
 * Record a revision-scoped conflict. Contradiction is symmetric, so its
 * endpoints are canonically ordered and a reverse duplicate returns the
 * existing row. Supersession keeps the caller's direction. Distinct-claim and
 * same-project rules are enforced by the database guards.
 */
export function addClaimConflict(db: Database, input: ClaimConflictInput): number {
    let { leftRevisionId, rightRevisionId } = input;
    if (input.relation === "contradicts" && leftRevisionId > rightRevisionId) {
        [leftRevisionId, rightRevisionId] = [rightRevisionId, leftRevisionId];
    }
    return withImmediateTransaction(db, () => {
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
    });
}

export interface VerificationEventInput {
    revisionId: number;
    observationId?: number | null;
    outcome: VerificationOutcome;
    verifier: string;
}

/** Append one verification event; `unverified` is the absence of events. */
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
 * Supported writers never commit these shapes; only direct SQL can. Readers
 * treat both as corruption rather than serving unauditable claims.
 */
export interface ClaimGraphCorruptionReport {
    nullPointerClaimIds: number[];
    evidencelessRevisionIds: number[];
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
    return {
        nullPointerClaimIds: nullPointer.map((row) => row.id),
        evidencelessRevisionIds: evidenceless.map((row) => row.id),
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
    const hasEvidence = db.prepare("SELECT 1 FROM claim_evidence WHERE revision_id = ? LIMIT 1");
    for (const revision of revisions) {
        if (!hasEvidence.get(revision.id)) {
            throw new ClaimGraphCorruptionError(
                `claim revision ${revision.id} has no evidence rows; direct-SQL corruption`,
            );
        }
    }
}

export function listClaimRevisions(db: Database, claimId: number): ClaimRevisionRecord[] {
    const revisions = db
        .prepare(
            `SELECT id, claim_id AS claimId, revision, content, content_sha256 AS contentSha256,
                    source_session_id AS sourceSessionId, created_at AS createdAt
               FROM claim_revisions WHERE claim_id = ? ORDER BY revision`,
        )
        .all(claimId) as ClaimRevisionRecord[];
    assertRevisionsHaveEvidence(db, revisions);
    return revisions;
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
    assertRevisionsHaveEvidence(db, [revision]);
    return revision;
}

export function getRevisionEvidence(db: Database, revisionId: number): ClaimEvidenceRecord[] {
    return db
        .prepare(
            `SELECT revision_id AS revisionId, observation_id AS observationId, relation,
                    created_at AS createdAt
               FROM claim_evidence WHERE revision_id = ? ORDER BY observation_id`,
        )
        .all(revisionId) as ClaimEvidenceRecord[];
}
