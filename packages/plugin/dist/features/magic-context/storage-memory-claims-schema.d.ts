/**
 * v84 memories-to-claims compatibility DDL: the legacy-memory crosswalk,
 * append-only revision metadata, audit-only cross-project merge lineage,
 * idempotent operation envelope, local claim-change outbox, monotonic project
 * generations, the bounded backfill repair surface, and the transaction-scoped
 * claims-write capability plus the semantic write guards it stands down
 * (KTD2, KTD3, KTD6-KTD8).
 *
 * Dependency-light on purpose: runtime imports here must carry explicit `.ts`
 * extensions so the Node SQLite smoke
 * (`packages/plugin/scripts/smoke-node-sqlite.ts`) can import this module
 * directly under Node's type-stripping loader, which cannot resolve
 * extensionless runtime imports.
 *
 * Every object here is migration-owned (created by migration v84, never by
 * `initializeDatabase()`), following the v80/v82 precedent.
 *
 * Append-only contract (KTD2, R1, R13): legacy_memory_claims,
 * claim_revision_memory_metadata, claim_merge_lineage, claim_operations, and
 * claim_change_outbox reject every UPDATE, plus any INSERT that collides with
 * a primary or unique key — so `INSERT OR REPLACE` cannot bypass the delete
 * guard when recursive triggers are disabled (the storage-claims-schema.ts
 * v82 precedent). DELETE is likewise rejected everywhere except the
 * change-log retention contract: claim_operations and claim_change_outbox
 * rows whose effects the outbox consumer has durably consumed may be pruned
 * through `pruneClaimChangeLogInCurrentTransaction`, gated by the
 * `claim_change_log_prune_state` capability row and its recorded consumed
 * watermark. `claim_project_generations` stays mutable but strictly
 * monotonic, `claim_backfill_failures` is the mutable repair surface, and
 * `claim_compatibility_write_state` is the transaction-scoped capability row
 * observed by the guards.
 */
import { type Database } from "../../shared/sqlite.ts";
export declare const MEMORY_CLAIMS_COMPAT_TABLES: readonly ["legacy_memory_claims", "claim_revision_memory_metadata", "claim_merge_lineage", "claim_memory_relationship_sources", "claim_operations", "claim_change_outbox", "claim_project_generations", "claim_backfill_failures", "claim_compatibility_write_state", "claim_change_log_prune_state"];
/**
 * Tables whose rows are immutable at the database boundary. UPDATE is
 * rejected absolutely; DELETE is rejected too, except that claim_operations
 * and claim_change_outbox admit watermark-gated pruning under the
 * claim_change_log_prune_state capability (see
 * `pruneClaimChangeLogInCurrentTransaction`).
 */
export declare const APPEND_ONLY_MEMORY_CLAIMS_TABLES: readonly ["legacy_memory_claims", "claim_revision_memory_metadata", "claim_merge_lineage", "claim_memory_relationship_sources", "claim_operations", "claim_change_outbox"];
/**
 * `schema_migrations_meta` keys owned by the v84 claims backfill. U2 creates
 * the contract and records initial state; U5 drives the transitions and only
 * the final reconciliation transaction may flip phase to `complete`.
 */
export declare const CLAIMS_BACKFILL_META_KEYS: {
    /** `empty` | `lazy` | `eager` — how the v84 corpus converts. */
    readonly mode: "claims_backfill_mode";
    /** Calibration digest for the selected backfill mode. */
    readonly calibrationDigest: "claims_backfill_calibration_digest";
    /** High-water `memories.id` at the v84 migration boundary (R1). */
    readonly boundaryMemoryId: "claims_backfill_boundary_memory_id";
    /** Expected crosswalk link count for the boundary corpus (R11). */
    readonly expectedRowCount: "claims_backfill_expected_row_count";
    /** `none` | `pending` — pending v22 identity work adopted by v84 (R19). */
    readonly v22Takeover: "claims_backfill_v22_takeover";
    /** `rows` | `relationships` | `reconciling` | `complete` | `blocked`. */
    readonly phase: "claims_backfill_phase";
    /** Lazy row-phase scan cursor (acceleration only; never completion). */
    readonly rowsCursor: "claims_backfill_rows_cursor";
    /** Lazy relationship-phase scan cursor. */
    readonly relationshipsCursor: "claims_backfill_relationships_cursor";
    /** Set only by the final anti-join reconciliation transaction. */
    readonly reconciliationVersion: "claims_backfill_reconciliation_version";
    /** Max claim_change_outbox id at completion — the U8 handoff watermark. */
    readonly finalOutboxWatermark: "claims_backfill_final_outbox_watermark";
};
/** Full v84 compatibility object graph: tables, indexes, then guards. */
export declare function createMemoryClaimsCompatSchema(db: Database): void;
export interface ClaimChangeLogPruneResult {
    /** claim_change_outbox rows removed (id at or below the watermark). */
    prunedOutboxRows: number;
    /** claim_operations rows removed (every effect at or below the watermark). */
    prunedOperationRows: number;
}
/**
 * Consumption-driven retention for the claim change log (KTD7).
 *
 * `claim_operations` and `claim_change_outbox` rows are immutable, but once
 * the outbox consumer has durably consumed every effect at or below an
 * outbox id, the rows at or below that watermark carry no remaining delivery
 * obligation and may be pruned. The DELETE triggers enforce this contract at
 * the database boundary: a delete commits only while the
 * `claim_change_log_prune_state` capability row is enabled in the current
 * transaction AND the deleted state sits at or below the recorded consumed
 * watermark, so no code path can shed change-log rows the consumer has not
 * acknowledged.
 *
 * Runs inside the CALLER's write transaction (enforced: throws in autocommit,
 * where the enabled=1 capability row would commit and be visible to other
 * connections). Records `consumedWatermark`
 * (monotonic: the stored watermark never regresses), enables the prune
 * capability, deletes `claim_change_outbox` rows with id at or below the
 * watermark first (the outbox references `claim_operations` with ON DELETE
 * RESTRICT), then deletes `claim_operations` rows whose every declared
 * effect has been pruned. An operation keeping any effect above the
 * watermark stays; an operation declaring zero effects also stays — its
 * envelope is the only idempotent-replay record for that operation key. The
 * capability clears before this function returns, so enabled=1 never
 * survives to commit.
 */
export declare function pruneClaimChangeLogInCurrentTransaction(db: Database, consumedWatermark: number): ClaimChangeLogPruneResult;
/**
 * Predicate over a `memories`-shaped row alias: true when the row carries
 * relationship lineage — a supersession pointer or a nonblank merged_from.
 * COALESCE(TRIM(...), '') folds NULL, empty, and whitespace-only merged_from
 * into "no lineage". Single source of truth for the relationship guard
 * triggers here and the backfill lineage scans.
 */
export declare function memoryLineagePresentSql(alias: string): string;
/**
 * Condition matching a `claim_memory_relationship_sources` snapshot row to
 * the aliased `memories` row's current lineage state. IS comparisons keep
 * NULL lineage columns comparable, so a row whose exact
 * (merged_from, superseded_by_memory_id) preimage is snapshotted satisfies
 * the condition. The subquery aliases the sources table as `source`; callers
 * must not bind that alias to the outer row.
 */
export declare function memoryRelationshipSourceMatchSql(alias: string): string;
/**
 * v84 semantic write guards over the legacy compatibility surface (R14).
 *
 * INSERT, DELETE, semantic-column UPDATE on `memories`, and every write to
 * the `memory_verifications` side table are rejected unless the transaction
 * holds the claims-write capability. Telemetry (`memory_stats`), mural-cue
 * columns, `classified_at` stamps, embeddings, and other derived caches stay
 * OUTSIDE the guard. The UPDATE guard is value-sensitive (the v80
 * `memories_telemetry_freeze_guard` precedent) so a held-open full-row UPDATE
 * that binds the old semantic values back keeps working.
 *
 * Boundary protection (KTD9): every row at or below the v84 high-water
 * boundary must acquire its non-cascading crosswalk link before deletion or
 * identity movement — even with the capability held — so lazy backfill never
 * loses a boundary member.
 */
export declare function installMemoryClaimsWriteGuards(db: Database): void;
/**
 * Targeted per-new-table foreign-key validation, mirroring
 * `assertClaimsSchemaForeignKeys` so unrelated legacy corruption cannot turn
 * this migration into a whole-database repair gate.
 */
export declare function assertMemoryClaimsSchemaForeignKeys(db: Database): void;
export declare function dropMemoryClaimsCompatObjectsForTests(db: Database): void;
//# sourceMappingURL=storage-memory-claims-schema.d.ts.map