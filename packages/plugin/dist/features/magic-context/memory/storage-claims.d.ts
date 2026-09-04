/**
 * Typed transactional writers and fail-closed readers for the authoritative
 * claims-and-evidence domain (migration v82): projects, episodes, source
 * spans, observations, claims, immutable claim revisions, evidence links,
 * revision-scoped conflicts, and verification events.
 *
 * Write protocol: every multi-row writer runs inside an immediate
 * transaction or a caller-held one, claims
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
 * Transaction ownership is split in two layers: `...InCurrentTransaction`
 * primitives assume the caller already holds a write transaction and never
 * issue BEGIN/COMMIT themselves, while the standalone public writers wrap
 * them in `db.transaction(fn).immediate()` — BEGIN IMMEDIATE at the top
 * level, a stacked savepoint when the caller already holds a transaction —
 * so a nested call composes instead of failing on a nested BEGIN.
 */
import type { Database } from "../../../shared/sqlite";
import { type SourceTrustClass } from "../storage-claim-applicability-schema.ts";
import { type RevisionApplicabilityInput } from "./storage-claim-applicability.ts";
export type ClaimState = "active" | "permanent" | "archived";
export type EvidenceRelation = "supports" | "merged_from";
export type ConflictRelation = "contradicts" | "supersedes";
export type VerificationOutcome = "verified" | "update" | "archive" | "stale" | "flagged";
export declare class ClaimGraphCorruptionError extends Error {
    constructor(message: string);
}
/** Exact bytes-of-record hash: UTF-8 SHA-256, never the normalized memory MD5. */
export declare function sha256Utf8Hex(text: string): string;
export declare function resolveProjectId(db: Database, identity: string): number | null;
/**
 * Transaction-local `ensureProject`: requires the caller to hold a write
 * transaction.
 */
export declare function ensureProjectInCurrentTransaction(db: Database, canonicalIdentity: string): number;
/**
 * Idempotent across racing connections: a unique-key loser re-reads the
 * inserted project row.
 */
export declare function ensureProject(db: Database, canonicalIdentity: string): number;
export interface EpisodeInput {
    projectId: number;
    /** Provenance only; never joined to session lifecycle cleanup. */
    sourceSessionId?: string | null;
}
export declare function createEpisode(db: Database, input: EpisodeInput): number;
export interface SourceSpanInput {
    episodeId: number;
    sourceLocator: string;
    /** Raw span text; only its SHA-256 is stored. */
    content: string;
    startOffset: number;
    endOffset: number;
    rawArtifactRef?: string | null;
}
export declare function createSourceSpan(db: Database, input: SourceSpanInput): number;
export interface ObservationInput {
    sourceSpanId: number;
    extractedText: string;
    extractor: string;
    extractorVersion: string;
    extractorRunId: string;
    independenceKey: string;
    /** Omitted means the schema's conservative `model_inference` default. */
    sourceTrustClass?: SourceTrustClass;
}
export declare function createObservation(db: Database, input: ObservationInput): number;
export interface ClaimEvidenceInput {
    observationId: number;
    relation?: EvidenceRelation;
}
export type ClaimWriteOutcome = {
    status: "applied";
    claimId: number;
    revisionId: number;
    revision: number;
} | {
    status: "stale";
} | {
    status: "not_found";
} | {
    status: "invalid";
    reason: string;
};
export interface CreateClaimInput {
    projectId: number;
    subject: string;
    predicate: string;
    scope?: string;
    state?: ClaimState;
    content: string;
    evidence: readonly ClaimEvidenceInput[];
    sourceSessionId?: string | null;
    /** Lineage-specific applicability; omitted means the `unknown` baseline. */
    applicability?: RevisionApplicabilityInput;
}
/** Transaction-local `createClaim`: requires a caller-held write transaction. */
export declare function createClaimInCurrentTransaction(db: Database, input: CreateClaimInput): ClaimWriteOutcome;
/** Create a claim, its revision 1, and its evidence links atomically. */
export declare function createClaim(db: Database, input: CreateClaimInput): ClaimWriteOutcome;
export interface AppendClaimRevisionInput {
    claimId: number;
    /** The current revision id the caller last read; the CAS expectation. */
    expectedCurrentRevisionId: number;
    content: string;
    evidence: readonly ClaimEvidenceInput[];
    sourceSessionId?: string | null;
    /** Lineage-specific applicability; omitted means the `unknown` baseline. */
    applicability?: RevisionApplicabilityInput;
}
/**
 * Transaction-local `appendClaimRevision`: requires a caller-held write
 * transaction. The caller's expected pointer is validated before inserting a
 * revision, then advanced with a final CAS. The surrounding immediate
 * transaction provides the cross-process serialization; the pointer read is
 * the staleness check, not a row lock.
 */
export declare function appendClaimRevisionInCurrentTransaction(db: Database, input: AppendClaimRevisionInput): ClaimWriteOutcome;
export declare function appendClaimRevision(db: Database, input: AppendClaimRevisionInput): ClaimWriteOutcome;
export interface ClaimConflictInput {
    relation: ConflictRelation;
    leftRevisionId: number;
    rightRevisionId: number;
}
/**
 * Transaction-local `addClaimConflict`: requires a caller-held write
 * transaction. Contradiction is symmetric, so its endpoints are canonically
 * ordered and a reverse duplicate returns the existing row. Supersession
 * keeps the caller's direction. Distinct-claim, same-project, and
 * reverse-supersession rules are enforced by the database guards.
 */
export declare function addClaimConflictInCurrentTransaction(db: Database, input: ClaimConflictInput): number;
export declare function addClaimConflict(db: Database, input: ClaimConflictInput): number;
export interface VerificationEventInput {
    revisionId: number;
    observationId?: number | null;
    outcome: VerificationOutcome;
    verifier: string;
}
/** Append one verification event; `unverified` is the absence of events. */
export declare function addVerificationEvent(db: Database, input: VerificationEventInput): number;
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
 * treat all of them as corruption rather than serving unauditable claims.
 */
export interface ClaimGraphCorruptionReport {
    nullPointerClaimIds: number[];
    evidencelessRevisionIds: number[];
    /** Claims whose pointer targets a revision below the claim's max: a
     * direct-SQL rollback of published history the clear-guard cannot see. */
    stalePointerClaimIds: number[];
}
export declare function findClaimGraphCorruption(db: Database): ClaimGraphCorruptionReport;
export declare function getClaimById(db: Database, claimId: number): ClaimRecord | null;
export declare function listClaimRevisions(db: Database, claimId: number): ClaimRevisionRecord[];
export declare function getCurrentClaimRevision(db: Database, claimId: number): ClaimRevisionRecord | null;
export declare function getRevisionEvidence(db: Database, revisionId: number): ClaimEvidenceRecord[];
//# sourceMappingURL=storage-claims.d.ts.map