/**
 * v85 bitemporal claim applicability, Git anchor, and source-trust DDL
 * (U6c: KTD2-KTD7, KTD9).
 *
 * Dependency-light on purpose: runtime imports here must carry explicit `.ts`
 * extensions so the Node SQLite smoke
 * (`packages/plugin/scripts/smoke-node-sqlite.ts`) can import this module
 * directly under Node's type-stripping loader.
 *
 * Every object here is migration-owned (created by migration v85, never by
 * `initializeDatabase()`), following the v80/v82/v84 precedent.
 *
 * Physical model (KTD2): bitemporal state is an append-only assertion ledger,
 * never mutable columns on `claims` or `claim_revisions`. Each assertion
 * belongs to exactly one immutable stream; a gapless sequence plus unique
 * predecessor consumption forms one chain per stream. `recorded_until` and
 * `known_until` are derived read-time by the interval view — no stored end
 * column is ever updated. Missing assertion means `unknown` (R13); a stored
 * baseline assertion also uses `unknown` (KTD3).
 *
 * Version lane: Synapse owns v83 and the memories-to-claims compatibility
 * contract owns v84, so this contract lands at v85. Pre-v85 revisions receive
 * seeded `unknown` baselines here; the still-pending lazy backfill and live
 * claim writers populate real trust and path state for later revisions.
 */
import type { Database } from "../../shared/sqlite";
export declare const CLAIM_APPLICABILITY_TABLES: readonly ["git_anchors", "git_anchor_representations", "claim_revision_applicability_streams", "claim_revision_applicability_assertions", "claim_revision_applicability_paths", "claim_revision_applicability_symbols"];
/** Coarse immutable origin classification on observations (R9, KTD7). */
export declare const SOURCE_TRUST_CLASSES: readonly ["explicit_user", "trusted_local_code", "trusted_tool_result", "untrusted_repo_text", "untrusted_web", "model_inference"];
export type SourceTrustClass = (typeof SOURCE_TRUST_CLASSES)[number];
/** Constrained applicability states (R4). `historical` is the persisted state
 * for an invalidated interval; there is no `invalidated` value by contract. */
export declare const APPLICABILITY_STATES: readonly ["current", "historical", "dirty_tree_uncertain", "dependency_changed", "wrong_branch", "wrong_environment", "unknown"];
export type ApplicabilityState = (typeof APPLICABILITY_STATES)[number];
/** Typed multi-representation anchor evidence forms (R7, KTD5). */
export declare const GIT_ANCHOR_REPRESENTATION_KINDS: readonly ["commit_oid", "tree_oid", "patch_id", "path", "symbol", "version"];
export type GitAnchorRepresentationKind = (typeof GIT_ANCHOR_REPRESENTATION_KINDS)[number];
/**
 * Identity tuple of one anchor representation row. Single source for the DDL
 * UNIQUE constraint, the append-only collision trigger, and the
 * application-side idempotency pre-check in `storage-git-anchors.ts`: a
 * divergent spelling would make the pre-check skip an insert the trigger
 * ABORTs (or vice versa).
 */
export declare const GIT_ANCHOR_REPRESENTATION_IDENTITY_COLUMNS: readonly ["anchor_id", "kind", "object_format", "protocol", "namespace", "value"];
/** Stream owner kinds: source lineage vs evaluation lineage (KTD3, R5). */
export declare const APPLICABILITY_OWNER_KINDS: readonly ["source", "evaluation"];
export type ApplicabilityOwnerKind = (typeof APPLICABILITY_OWNER_KINDS)[number];
/** Path knowledge dispositions on an assertion (R6, KTD4). */
export declare const APPLICABILITY_PATHS_STATES: readonly ["unknown", "known"];
export type ApplicabilityPathsState = (typeof APPLICABILITY_PATHS_STATES)[number];
/** Path selector kinds (R6). */
export declare const APPLICABILITY_PATH_KINDS: readonly ["exact", "glob"];
export type ApplicabilityPathKind = (typeof APPLICABILITY_PATH_KINDS)[number];
/**
 * Add the constrained observation trust column (KTD7). ALTER TABLE ADD COLUMN
 * keeps the append-only v82 rows byte-identical while giving every existing
 * observation the conservative `model_inference` default. Fresh and upgraded
 * databases converge because both run v82's CREATE TABLE then this ALTER.
 */
export declare function addObservationSourceTrustClassColumn(db: Database): void;
export declare function observationSourceTrustClassColumnExists(db: Database): boolean;
/** Full v85 object graph: tables from the dependency roots outward, indexes,
 * the interval view, then guards. */
export declare function createClaimApplicabilitySchema(db: Database): void;
/** Versioned deterministic stream-key protocol for supported writers (KTD3). */
export declare const APPLICABILITY_STREAM_KEY_PROTOCOL = "mc-applicability-stream-key-v1";
/** Stream key for the migration-seeded / writer-default baseline stream. */
export declare const APPLICABILITY_BASELINE_STREAM_KEY = "baseline:v1";
/**
 * Seed one `unknown` baseline assertion for every claim revision that has no
 * applicability stream yet (U1, AE1). Revision bytes are untouched; knowledge
 * time uses the revision's creation time only when it is a plausible retained
 * timestamp (a positive integer).
 */
export declare function seedApplicabilityBaselines(db: Database, nowMs: number): void;
/**
 * Targeted per-new-table foreign-key validation, mirroring
 * `assertClaimsSchemaForeignKeys` so unrelated legacy corruption cannot turn
 * this migration into a whole-database repair gate.
 */
export declare function assertClaimApplicabilitySchemaForeignKeys(db: Database): void;
/**
 * Non-table objects `createClaimApplicabilitySchema` creates, absent from
 * `sqlite_master`. The v85 replay guard uses this so a database whose tables
 * survived but whose view, indexes, or guard triggers did not (for example
 * one created by an earlier draft of the schema) is refused instead of being
 * accepted as complete. migrations-v85.test.ts asserts the name list below
 * stays in sync with the DDL.
 */
export declare function missingClaimApplicabilitySchemaObjects(db: Database): string[];
export declare function dropClaimApplicabilityObjectsForTests(db: Database): void;
//# sourceMappingURL=storage-claim-applicability-schema.d.ts.map