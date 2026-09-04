/**
 * Transaction-local memory/claims kernel (KTD1, KTD3, KTD6-KTD8): every v84
 * semantic or lifecycle memory operation commits claim changes, the legacy
 * `memories` compatibility projection, operation envelope, claim-change
 * outbox rows, and one generation bump per touched project in the CALLER's
 * immediate transaction (R12-R13). Callers own transaction start/commit
 * through the adapters below; the kernel never issues BEGIN/COMMIT.
 *
 * Type-only, `node:`, and explicit-`.ts` sibling imports keep this module
 * loadable by the Node SQLite smoke script, whose loader cannot resolve
 * extensionless runtime imports.
 *
 * A row whose project identity cannot resolve to the numeric registry (a raw
 * pre-v22 path), whose content is empty, or whose schema-legal metadata is
 * claim-invalid (bad scope, importance, shareable, ...) cannot form a claim.
 * Those writes apply the projection under the capability and record a
 * blocking `claim_backfill_failures` row instead of silently inventing claim
 * state; the v22 takeover (U4) and doctor retry (U5) own the repair.
 */
import { type Database } from "../../../shared/sqlite.ts";
import { addVerificationEvent as addVerificationEventRaw, type ClaimState } from "./storage-claims.ts";
import { type MemoryProjectionInsert, type MemoryProjectionRow } from "./storage-memory-projection.ts";
import type { MemoryStatus } from "./types.ts";
export declare const MEMORY_CLAIM_FAILPOINT_IDS: readonly ["memory-claim.010.claim.after", "memory-claim.020.projection.after", "memory-claim.030.outbox.after", "memory-claim.040.generation.after", "memory-claim.050.commit.before", "memory-claim.060.commit.after", "memory-claim.070.ack.after"];
export type MemoryClaimFailpointId = (typeof MEMORY_CLAIM_FAILPOINT_IDS)[number];
export declare function setMemoryClaimFailpoint(id: MemoryClaimFailpointId, hook: (() => void) | null): void;
export declare function clearMemoryClaimFailpoints(): void;
export declare function acknowledgeMemoryClaimResult(): void;
/**
 * Whether this database migrated to v84. Delegates to the shared probe so
 * this module and the privileged-writer path in shared/sqlite.ts share one
 * positive-only cache: a negative probe is never cached, because a sibling
 * process can migrate the shared file after this handle opened.
 */
export declare function hasMemoryClaimsCompatSchema(db: Database): boolean;
/**
 * Outer transaction shares one generation allocation per touched project.
 * Nested scopes restore allocation snapshots after errors so rolled-back
 * savepoints do not retain allocations.
 */
export declare function withMemoryClaimGenerationContextInCurrentTransaction<T>(db: Database, fn: () => T): T;
/**
 * Enable the claims-write capability for `fn` inside the CALLER's write
 * transaction. Only the outermost scope clears the flag, and it clears
 * BEFORE the caller commits, so no second connection can observe enabled=1
 * (Schema Contract: the capability is transaction-scoped).
 */
export declare function withClaimsWriteCapabilityInCurrentTransaction<T>(db: Database, fn: () => T): T;
/**
 * Caller adapter: one immediate transaction (a stacked savepoint when the
 * caller already holds one) with the claims-write capability enabled for its
 * duration and cleared before commit.
 */
export declare function runInMemoryClaimsWriteTransaction<T>(db: Database, fn: () => T): T;
export interface MemoryClaimOperationEnvelope {
    /** Producer namespace, e.g. "storage-memory" or "module-mirror". */
    producer: string;
    /** Durable key, unique within the producer namespace. */
    operationKey: string;
    /** Canonical request digest (SHA-256 hex over the canonical request). */
    requestDigest: string;
    /** Marks a random-key envelope no caller can ever present again. A
     *  zero-effect run of an ephemeral envelope persists nothing: its replay
     *  record would be unreachable, so storing it only grows
     *  claim_operations. */
    ephemeral?: true;
}
export type MemoryClaimEffectType = "upsert" | "lifecycle" | "evidence";
export interface MemoryClaimEffect {
    effectKey: string;
    projectId: number;
    claimId: number;
    effectType: MemoryClaimEffectType;
}
export interface MemoryClaimOperationOutcome<T> {
    result: T;
    /** True when the stored committed result was returned with zero new effects. */
    replayed: boolean;
}
export declare class ClaimOperationKeyReuseError extends Error {
    constructor(producer: string, operationKey: string);
}
/** Canonical request digest helper for callers without a natural digest. */
export declare function computeClaimRequestDigest(request: unknown): string;
export declare function readMemoryClaimOperationResult<T>(db: Database, envelope: MemoryClaimOperationEnvelope): MemoryClaimOperationOutcome<T> | null;
/**
 * Envelope runner: replay of the same producer/key with the same digest
 * returns the stored committed result and performs zero new effects; the
 * same key with a different digest fails before any work runs. A first run
 * persists the envelope, stamps deduplicated outbox rows, and bumps one
 * generation per touched project.
 */
export declare function runMemoryClaimOperationInCurrentTransaction<T>(db: Database, envelope: MemoryClaimOperationEnvelope, work: () => {
    result: T;
    effects: readonly MemoryClaimEffect[];
}): MemoryClaimOperationOutcome<T>;
/** The frozen claim semantic key for a canonical legacy memory id (KTD3). */
export declare function legacyMemoryClaimSubject(canonicalMemoryId: number): string;
export declare const LEGACY_MEMORY_CLAIM_PREDICATE = "states";
export declare const LEGACY_MEMORY_CLAIM_SCOPE = "project-memory";
export type MemoryClaimProvenance = {
    kind: "live";
    producer: string;
    operationKey: string;
    sourceSessionId?: string | null;
} | {
    kind: "migration";
};
export interface MemoryClaimLink {
    memoryId: number;
    canonicalMemoryId: number;
    claimId: number;
    projectId: number;
    rootObservationId: number;
}
export type MemoryClaimLinkFailureReason = "unresolved-project-identity" | "empty-content" | "empty-category" | "empty-normalized-hash" | "invalid-importance" | "invalid-scope" | "invalid-shareable" | "empty-source-session-id" | "empty-source-type" | "shared-claim-content-edit";
export declare class MemoryClaimsStatsIntegrityError extends Error {
    readonly memoryId: number;
    constructor(memoryId: number);
}
/**
 * Prefixes that mark a `memories.project_path` as a canonical claims project
 * identity. Canonicality requires a nonempty suffix after the prefix: a bare
 * `git:`/`dir:` carries no identity payload. Single source of truth for
 * `resolveMemoryClaimProjectInCurrentTransaction` and the SQL twin
 * `canonicalMemoryProjectPathSql`, so the TS resolver and SQL gates cannot
 * drift.
 */
export declare const CANONICAL_MEMORY_PROJECT_PATH_PREFIXES: readonly ["git:", "dir:"];
/**
 * SQL predicate over a `project_path` column expression: true exactly when
 * the resolver's canonical-shape check accepts the path (known prefix plus a
 * nonempty suffix). Derived from `CANONICAL_MEMORY_PROJECT_PATH_PREFIXES` —
 * the same list the TS resolver consumes.
 */
export declare function canonicalMemoryProjectPathSql(column: string): string;
/**
 * Resolve a legacy `project_path` to the numeric claims project. A canonical
 * identity registers on demand; a raw path that never rekeyed stays
 * unresolved (null) and belongs to the v22 repair lane. The canonical-shape
 * check derives from `CANONICAL_MEMORY_PROJECT_PATH_PREFIXES`; SQL callers
 * use `canonicalMemoryProjectPathSql` over the same list.
 */
export declare function resolveMemoryClaimProjectInCurrentTransaction(db: Database, projectPath: string): number | null;
export declare function memoryClaimMetadataFailureReason(row: MemoryProjectionRow): MemoryClaimLinkFailureReason | null;
export declare function memoryClaimAdoptionFailureReason(row: MemoryProjectionRow, projectId: number | null): MemoryClaimLinkFailureReason | null;
/**
 * SQL twin of `memoryClaimAdoptionFailureReason` over a `memories` row
 * aliased as `alias`: true exactly when the TS gate returns null. Project
 * resolvability mirrors `resolveMemoryClaimProjectInCurrentTransaction` — a
 * registered alias or a canonical-shape path that registers on demand. NULL
 * in any non-nullable column fails its comparison (NULL is not true),
 * matching the TS typeof checks; `source_session_id` is the one nullable
 * pass-through, and NULL `importance` passes like the TS null check.
 */
export declare function memoryClaimAdoptableSql(alias: string): string;
export declare function recordMemoryClaimLinkFailure(db: Database, memoryId: number, projectPath: string, reason: MemoryClaimLinkFailureReason): void;
/**
 * Flip a memory's rows-phase blocking/retry failure to resolved once its
 * crosswalk link exists — the live-writer twin of the backfill sweep
 * (`sweepResolvedRowFailures`). Warnings stay visible on the repair surface.
 */
export declare function resolveMemoryClaimLinkFailure(db: Database, memoryId: number): void;
/**
 * Unknown or NULL projection status maps to archived, not active: every
 * legacy reader omits rows outside the three known statuses, so the claim
 * mirror must never publish such a row as live.
 */
export declare function claimStateFromMemoryStatus(status: string | null): ClaimState;
export declare function readMemoryClaimLink(db: Database, memoryId: number): MemoryClaimLink | null;
/**
 * The lifecycle state a canonical claim should hold given one linked
 * projection's imminent status: the max-rank state (archived < active <
 * permanent) across every surviving linked projection, with THIS row's next
 * status substituted for its stored one (the projection write lands after
 * the claim write). A claim whose links all point at archived or deleted
 * rows resolves to archived. Generalizes the sibling-liveness retire gate:
 * one projection's transition can neither downgrade a permanent sibling nor
 * strand a stale permanent state once the last permanent link archives.
 */
export declare function sharedClaimStateFromLiveLinks(db: Database, claimId: number, memoryId: number, nextStatus: string): ClaimState;
export interface EnsureMemoryClaimLinkOptions {
    /**
     * When false, a hash-equal preimage whose content or revision metadata
     * differs from the canonical claim links WITHOUT appending a revision
     * (the source bytes stay retained on the root observation). Merge-delete
     * relocations use this so the canonical claim keeps reflecting the
     * surviving projection row (R6).
     */
    adoptDivergentContent?: boolean;
}
/**
 * Ensure the memory row has its durable claim link, adopting the preimage as
 * revision 1 when unlinked (R10). Exact-hash dedup selects the existing
 * canonical claim for the (project, category, normalized hash) tuple before
 * allocating a new one (KTD3, R6); a hash-equal preimage whose content or
 * revision metadata differs from the canonical claim's current semantic
 * state appends a revision so the claim reflects it.
 */
export declare function ensureMemoryClaimLinkInCurrentTransaction(db: Database, row: MemoryProjectionRow, projectId: number, provenance: MemoryClaimProvenance, options?: EnsureMemoryClaimLinkOptions): MemoryClaimLink;
/** Why a supersession recording did — or deliberately did not — write an edge. */
export type MemoryClaimSupersessionOutcome = "recorded" | "exists" | "same-claim" | "sibling-suppressed";
/**
 * Record one supersession edge between two linked memories' current
 * revisions: same-project pairs use `claim_conflicts` (supersedes), distinct
 * projects use the audit-only `claim_merge_lineage` relation (KTD8). A
 * source claim with another live crosswalk link records nothing
 * ("sibling-suppressed"): the sibling projection still asserts the claim, so
 * an edge would mark the survivor's claim superseded. Both paths are
 * idempotent ("exists"), so page replay or a doctor retry cannot duplicate
 * lineage. The discriminated outcome lets callers separate a new edge from
 * the reasons no edge exists — the disposition oracle must not demand an
 * edge the sibling-liveness rule forbids.
 */
export declare function recordMemoryClaimSupersessionOutcomeInCurrentTransaction(db: Database, source: MemoryClaimLink, target: MemoryClaimLink): MemoryClaimSupersessionOutcome;
/** Boolean view of the outcome recorder: true only when a new edge was recorded. */
export declare function recordMemoryClaimSupersessionInCurrentTransaction(db: Database, source: MemoryClaimLink, target: MemoryClaimLink): boolean;
export interface MemoryClaimLineageToken {
    ordinal: number;
    raw: string;
    kind: "id" | "marker" | "malformed";
    id?: number;
}
export interface MemoryRelationshipSourceRow {
    sourceId: number;
    memoryId: number;
    sourceDigest: string;
    mergedFrom: string | null;
    supersededByMemoryId: number | null;
}
export declare function parseMemoryClaimMergedFrom(raw: string | null): MemoryClaimLineageToken[];
export declare function memoryClaimSupersessionExists(db: Database, source: MemoryClaimLink, target: MemoryClaimLink): boolean;
export declare function listMemoryRelationshipSources(db: Database, boundaryMemoryId: number): MemoryRelationshipSourceRow[];
export declare function translateMemoryClaimRelationshipsInCurrentTransaction(db: Database, row: Pick<MemoryProjectionRow, "id" | "merged_from" | "superseded_by_memory_id">): MemoryClaimEffect[];
/** Claim lifecycle state change (active | permanent | archived). */
export declare function setClaimLifecycleStateInCurrentTransaction(db: Database, claimId: number, state: ClaimState): void;
export declare function retireMemoryClaimInCurrentTransaction(db: Database, claimId: number, verifier: string): void;
/**
 * Recompute the automated maturity ladder and effective projection for one
 * revision from current authoritative rows (R6-R8, R15). No-op until the
 * revision has a frozen policy subject: a missing subject stays readable as
 * conservative unknown (R26). Exported for the startup reconciler: a
 * held-open v85 writer can append verification facts without running this
 * reducer, and the read path only lets NEGATIVE authoritative facts override
 * the projection.
 */
export declare function refreshRevisionMaturityInCurrentTransaction(db: Database, revisionId: number): void;
/** Bump the owning project's memory epoch for a claim so every derived
 * project-memory cache (including the native module mirror) rematerializes.
 * A claim with no memory link feeds no memory surface and no-ops.
 *
 * Sessions key `project_state` by the identity they resolve TODAY, which can
 * differ from the path stored on a linked memory row: a canonical-identity
 * change keeps the old identity only as a `project_aliases` row, and a
 * never-rekeyed legacy path survives on the memory itself. Bumping only the
 * stored path would leave the canonical reader's watermark intact and its
 * caches serving the pre-change visibility set, so every identity attached
 * to the claim's project — canonical, aliases, and linked memory paths — is
 * bumped. */
export declare function bumpEpochForClaimProjectInCurrentTransaction(db: Database, claimId: number): void;
/** Verification writes feed the effective reducer, so every event refreshes
 * the revision's ladder and projection in the same transaction (R27).
 * Exported for the adoption paths (v84 backfill, relocation, identity merge)
 * that carry legacy verification onto a freshly linked revision: writing the
 * raw event alone would leave the revision's projection at CANDIDATE with no
 * epoch bump, and the seeder never revisits a revision whose subject exists. */
export declare function addVerificationEventInCurrentTransaction(db: Database, args: Parameters<typeof addVerificationEventRaw>[1]): ReturnType<typeof addVerificationEventRaw>;
export interface MemoryClaimWriteResult {
    memoryId: number;
    /** Null when the row could not link (unresolved identity / empty content). */
    claimId: number | null;
    revisionId: number | null;
    /** False when the target memory row does not exist (legacy no-op). */
    found: boolean;
}
/**
 * New memory: projection insert (allocating the canonical memory id while
 * the transaction is uncommitted, KTD3), claim revision 1 with live
 * provenance and revision metadata, crosswalk, one upsert effect, one
 * generation bump. Stats and FTS state come from the existing triggers.
 */
export declare function createMemoryWithClaimsInCurrentTransaction(db: Database, envelope: MemoryClaimOperationEnvelope, input: MemoryProjectionInsert): MemoryClaimOperationOutcome<MemoryClaimWriteResult>;
export interface UpdateMemoryContentClaimInput {
    memoryId: number;
    content: string;
    normalizedHash: string;
    sourceSessionId?: string | null;
    /**
     * The caller's verdict invalidated the previous verification: the kernel
     * deletes the `memory_verifications` rows inside this transaction and
     * suppresses the verified-event carry, so the new revision never claims
     * verified for content the verdict rejected.
     */
    clearsVerification?: boolean;
    nowMs?: number;
}
/**
 * Positive-verification truth for one projection row, shared with
 * claims-backfill's `recordAdoptedMemoryVerifiedEventInCurrentTransaction`
 * (claims-backfill imports from this module; the reverse direction would
 * form a runtime import cycle): a row counts as verified when the projection
 * columns say so or the `memory_verifications` side table carries a positive
 * `verified_at` (the only place pre-v84 TypeScript verification writes). An
 * explicit projection revocation outranks stale side-table timestamps:
 * 'stale'/'flagged' only exist as explicit writes, and revocation keeps
 * `verified_at`, so 'unverified' with a positive `verified_at` is the
 * withdrawn shape — the side-table fallback applies only to the untouched
 * projection ('unverified' with no `verified_at`).
 */
export declare function memoryRowHasPositiveVerification(db: Database, row: Pick<MemoryProjectionRow, "id" | "verification_status" | "verified_at">): boolean;
/**
 * Lifecycle half of an adoption: `ensureMemoryClaimLinkInCurrentTransaction`
 * reuses whatever canonical claim already owns the (project, category, hash)
 * tuple — including one archived by a prior delete of an equivalent row — so
 * the claim state is re-derived from the adopting projection row under the
 * shared-claim max-rank rule and an active row never points at an archived
 * claim. An archive transition retires (archive event); any other change
 * sets the state directly. Returns the lifecycle effect only when the state
 * actually changed. Local twin of relocate-memory's
 * `syncAdoptedClaimLifecycleState`: importing it here would form an import
 * cycle (relocate-memory imports this module).
 */
export declare function syncClaimLifecycleAfterAdoption(db: Database, row: MemoryProjectionRow, link: MemoryClaimLink, projectId: number, producer: string): MemoryClaimEffect[];
/**
 * Content rewrite: adopt an unlinked preimage as revision 1, then append the
 * requested content as the next revision in the same transaction (R10),
 * update the projection semantic fields, and invalidate derived rows.
 */
export declare function updateMemoryContentWithClaimsInCurrentTransaction(db: Database, envelope: MemoryClaimOperationEnvelope, input: UpdateMemoryContentClaimInput): MemoryClaimOperationOutcome<MemoryClaimWriteResult>;
export interface UpdateMemoryClassificationClaimInput {
    memoryId: number;
    importance?: number;
    scope?: string;
    shareable?: number;
    nowMs?: number;
}
/**
 * Classification-only semantic change: appends a same-content revision whose
 * metadata carries the new importance/scope/shareability, then updates the
 * projection fields plus the classified_at run-gate stamp.
 */
export declare function updateMemoryClassificationWithClaimsInCurrentTransaction(db: Database, envelope: MemoryClaimOperationEnvelope, input: UpdateMemoryClassificationClaimInput): MemoryClaimOperationOutcome<MemoryClaimWriteResult>;
export interface SetMemoryStatusClaimInput {
    memoryId: number;
    status: MemoryStatus;
    /** Replacement metadata JSON (already merged by the caller), if any. */
    metadataJson?: string | null;
    nowMs?: number;
}
/**
 * Lifecycle transition (archive, restore, permanent): claim state change
 * plus an archive verification event when archiving, and the projection
 * status/metadata update. A pure status change appends no revision — prior
 * revisions stay untouched (R3) — but a metadata_json replacement (e.g. an
 * archive reason) appends a same-content revision so the claim history keeps
 * matching the projection metadata.
 */
export declare function setMemoryStatusWithClaimsInCurrentTransaction(db: Database, envelope: MemoryClaimOperationEnvelope, input: SetMemoryStatusClaimInput): MemoryClaimOperationOutcome<MemoryClaimWriteResult>;
/**
 * Ordinary delete: claim retirement (archived + archive event) with the
 * crosswalk retained, then projection removal. Claim history is retained —
 * this is retention, not privacy erasure.
 */
export declare function deleteMemoryWithClaimsInCurrentTransaction(db: Database, envelope: MemoryClaimOperationEnvelope, input: {
    memoryId: number;
}): MemoryClaimOperationOutcome<MemoryClaimWriteResult>;
export interface SupersedeMemoryClaimResult extends MemoryClaimWriteResult {
    supersededByClaimId: number | null;
}
/**
 * Supersession: the superseding claim's current revision supersedes the
 * source's (same-project `claim_conflicts`) or, across projects, an
 * audit-only `claim_merge_lineage` row (KTD8). The source claim retires and
 * the projection records the pointer.
 */
export declare function supersedeMemoryWithClaimsInCurrentTransaction(db: Database, envelope: MemoryClaimOperationEnvelope, input: {
    memoryId: number;
    supersededByMemoryId: number;
    nowMs?: number;
}): MemoryClaimOperationOutcome<SupersedeMemoryClaimResult>;
export interface MergeMemoryStatsClaimInput {
    memoryId: number;
    seenCount: number;
    retrievalCount: number;
    mergedFrom: string;
    status: string;
    nowMs?: number;
}
/**
 * Merge-canonical stats/state assignment: claim lifecycle follows the new
 * status; counters stay telemetry (memory_stats). A base row without a stats
 * row aborts the transaction (the v80 one-row-per-memory invariant).
 */
export declare function mergeMemoryStatsWithClaimsInCurrentTransaction(db: Database, envelope: MemoryClaimOperationEnvelope, input: MergeMemoryStatsClaimInput): MemoryClaimOperationOutcome<MemoryClaimWriteResult>;
export interface UpdateMemoryVerificationClaimInput {
    memoryId: number;
    verificationStatus: string;
    nowMs?: number;
}
/**
 * Verification status change: one verification event for verified/stale/
 * flagged outcomes plus the projection verification columns. A fresh
 * `unverified` write stays the absence of events (KTD5), but an `unverified`
 * that withdraws a positive verification records 'stale'; a write that
 * transitions nothing emits no event and no evidence effect. A first
 * adoption still emits its upsert (and any lifecycle re-derivation)
 * independent of the event gate.
 */
export declare function updateMemoryVerificationWithClaimsInCurrentTransaction(db: Database, envelope: MemoryClaimOperationEnvelope, input: UpdateMemoryVerificationClaimInput): MemoryClaimOperationOutcome<MemoryClaimWriteResult>;
export interface ReplaceMemoryVerificationFilesClaimInput {
    memoryId: number;
    /** Normalized repo-relative files; empty writes the no-file sentinel. */
    files: readonly string[];
    now: number;
    /** True = content verification (event); false = mapping only (no event, KTD5). */
    verified: boolean;
}
export interface ReplaceMemoryVerificationFilesResult {
    memoryId: number;
    claimId: number | null;
    rowsWritten: number;
}
/**
 * File mapping / positive verification snapshot: replaces the
 * `memory_verifications` rows; a positive verification also appends one
 * current-snapshot verification event. A snapshot whose path state differs
 * from the linked claim's current assertion appends an applicability
 * successor and one upsert effect.
 */
export declare function replaceMemoryVerificationFilesWithClaimsInCurrentTransaction(db: Database, envelope: MemoryClaimOperationEnvelope, input: ReplaceMemoryVerificationFilesClaimInput): MemoryClaimOperationOutcome<ReplaceMemoryVerificationFilesResult>;
export interface ModuleMemoryDeltaResult {
    memoryId: number;
    claimId: number | null;
    /** Newly appended revision id, when the delta changed semantic state. */
    revisionId: number | null;
    /** True when the projection row is gone after the delta (tombstone). */
    removed: boolean;
}
export interface CurrentClaimSemanticState {
    content: string;
    state: ClaimState;
    category: string | null;
    normalizedHash: string | null;
    importance: number | null;
    memoryScope: string | null;
    shareable: number | null;
    sourceType: string | null;
    expiresAt: number | null;
    metadataJson: string | null;
    sourceSessionId: string | null;
}
export declare function readCurrentClaimSemanticState(db: Database, claimId: number): CurrentClaimSemanticState;
/**
 * Apply one module changefeed memory delta with its claim-side effects in the
 * caller's privileged mirror-page transaction (R15). The envelope key is the
 * durable feed identity (module project + row id + feed sequence), so an
 * exact page replay returns the committed result and appends no revision,
 * outbox effect, or generation (AE7). The projection application itself runs
 * on every call — it is idempotent and must re-establish mirror identity on
 * replay-from-zero — while every claim mutation stays inside the envelope.
 *
 * Effective semantic state is compared, not feed ops: a telemetry-only
 * snapshot appends nothing (Mutation Transition Matrix last row), a
 * content/metadata change appends one revision, a status change moves claim
 * lifecycle, and a tombstone that actually removes the projection row retires
 * the claim after the unlinked preimage was adopted (R10).
 */
export declare function applyModuleMemoryDeltaWithClaimsInCurrentTransaction(db: Database, envelope: MemoryClaimOperationEnvelope, input: {
    memoryId: number;
    applyProjection: () => void;
}): MemoryClaimOperationOutcome<ModuleMemoryDeltaResult>;
export interface CurrentMemoryClaim {
    memoryId: number;
    canonicalMemoryId: number;
    claimId: number;
    projectId: number;
    state: ClaimState;
    revisionId: number;
    revision: number;
    content: string;
    contentSha256: string;
    category: string;
    normalizedHash: string;
    importance: number;
    memoryScope: string;
    shareable: number;
    sourceType: string;
    expiresAt: number | null;
    metadataJson: string | null;
}
export declare function getCurrentMemoryClaimByLegacyMemoryId(db: Database, memoryId: number): CurrentMemoryClaim | null;
export declare function listCurrentMemoryClaimsByProject(db: Database, projectId: number): CurrentMemoryClaim[];
/**
 * Supported writers never commit these shapes; only direct SQL can. The v84
 * sibling of `findClaimGraphCorruption`: a memory-linked claim revision
 * without its metadata row, or a crosswalk whose canonical resolution or
 * project ownership is inconsistent.
 */
export interface MemoryClaimsCompatCorruptionReport {
    revisionIdsMissingMemoryMetadata: number[];
    invalidCrosswalkMemoryIds: number[];
}
export declare function findMemoryClaimsCompatCorruption(db: Database): MemoryClaimsCompatCorruptionReport;
//# sourceMappingURL=storage-memory-claims.d.ts.map