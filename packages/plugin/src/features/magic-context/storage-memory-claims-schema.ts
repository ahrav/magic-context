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

import { type Database, isInTransaction } from "../../shared/sqlite.ts";

export const MEMORY_CLAIMS_COMPAT_TABLES = [
    "legacy_memory_claims",
    "claim_revision_memory_metadata",
    "claim_merge_lineage",
    "claim_memory_relationship_sources",
    "claim_operations",
    "claim_change_outbox",
    "claim_project_generations",
    "claim_backfill_failures",
    "claim_compatibility_write_state",
    "claim_change_log_prune_state",
] as const;

/**
 * Tables whose rows are immutable at the database boundary. UPDATE is
 * rejected absolutely; DELETE is rejected too, except that claim_operations
 * and claim_change_outbox admit watermark-gated pruning under the
 * claim_change_log_prune_state capability (see
 * `pruneClaimChangeLogInCurrentTransaction`).
 */
export const APPEND_ONLY_MEMORY_CLAIMS_TABLES = [
    "legacy_memory_claims",
    "claim_revision_memory_metadata",
    "claim_merge_lineage",
    "claim_memory_relationship_sources",
    "claim_operations",
    "claim_change_outbox",
] as const;

/**
 * `schema_migrations_meta` keys owned by the v84 claims backfill. U2 creates
 * the contract and records initial state; U5 drives the transitions and only
 * the final reconciliation transaction may flip phase to `complete`.
 */
export const CLAIMS_BACKFILL_META_KEYS = {
    /** `empty` | `lazy` | `eager` — how the v84 corpus converts. */
    mode: "claims_backfill_mode",
    /** Calibration digest for the selected backfill mode. */
    calibrationDigest: "claims_backfill_calibration_digest",
    /** High-water `memories.id` at the v84 migration boundary (R1). */
    boundaryMemoryId: "claims_backfill_boundary_memory_id",
    /** Expected crosswalk link count for the boundary corpus (R11). */
    expectedRowCount: "claims_backfill_expected_row_count",
    /** `none` | `pending` — pending v22 identity work adopted by v84 (R19). */
    v22Takeover: "claims_backfill_v22_takeover",
    /** `rows` | `relationships` | `reconciling` | `complete` | `blocked`. */
    phase: "claims_backfill_phase",
    /** Lazy row-phase scan cursor (acceleration only; never completion). */
    rowsCursor: "claims_backfill_rows_cursor",
    /** Lazy relationship-phase scan cursor. */
    relationshipsCursor: "claims_backfill_relationships_cursor",
    /** Set only by the final anti-join reconciliation transaction. */
    reconciliationVersion: "claims_backfill_reconciliation_version",
    /** Max claim_change_outbox id at completion — the U8 handoff watermark. */
    finalOutboxWatermark: "claims_backfill_final_outbox_watermark",
} as const;

/** Full v84 compatibility object graph: tables, indexes, then guards. */
export function createMemoryClaimsCompatSchema(db: Database): void {
    db.exec(`
    CREATE TABLE legacy_memory_claims (
        -- The legacy memories.id. Deliberately NO foreign key to memories:
        -- the link is durable and non-cascading (R1) and must survive a later
        -- projection-row delete.
        memory_id INTEGER PRIMARY KEY CHECK (typeof(memory_id) = 'integer' AND memory_id >= 1),
        canonical_memory_id INTEGER NOT NULL CHECK (
            typeof(canonical_memory_id) = 'integer' AND canonical_memory_id >= 1
        ),
        claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        root_observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL
    );
    -- One canonical row per claim (KTD2): only the self-canonical link may
    -- own a claim; duplicate links attach to it.
    CREATE UNIQUE INDEX idx_legacy_memory_claims_canonical_claim
        ON legacy_memory_claims(claim_id) WHERE memory_id = canonical_memory_id;
    CREATE INDEX idx_legacy_memory_claims_claim ON legacy_memory_claims(claim_id);
    CREATE INDEX idx_legacy_memory_claims_project ON legacy_memory_claims(project_id);
    CREATE INDEX idx_legacy_memory_claims_canonical ON legacy_memory_claims(canonical_memory_id);

    -- One row per immutable revision carrying the legacy memory semantics
    -- (KTD2). The normalized hash here need not equal claim identity: claim
    -- identity is the canonical legacy memory id (KTD3).
    CREATE TABLE claim_revision_memory_metadata (
        revision_id INTEGER PRIMARY KEY REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        category TEXT NOT NULL CHECK (length(category) > 0),
        normalized_hash TEXT NOT NULL CHECK (length(normalized_hash) > 0),
        importance INTEGER NOT NULL CHECK (typeof(importance) = 'integer' AND importance BETWEEN 1 AND 100),
        memory_scope TEXT NOT NULL CHECK (memory_scope IN ('project', 'ecosystem', 'universe')),
        shareable INTEGER NOT NULL CHECK (shareable IN (0, 1)),
        source_type TEXT NOT NULL CHECK (length(source_type) > 0),
        expires_at INTEGER,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
    );
    -- Exact-hash dedup resolves (project, category, normalized hash) on every
    -- memory write; the hash-first probe makes that a point lookup instead of
    -- a metadata scan.
    CREATE INDEX idx_claim_revision_memory_metadata_hash
        ON claim_revision_memory_metadata(normalized_hash, category);

    -- Audit-only relation for merge edges that cannot use same-project
    -- claim_conflicts (KTD8). Never an authorization or retrieval edge.
    CREATE TABLE claim_merge_lineage (
        id INTEGER PRIMARY KEY,
        source_revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        source_project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        target_revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        target_project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        CHECK (source_revision_id <> target_revision_id),
        CHECK (source_project_id <> target_project_id),
        UNIQUE (source_revision_id, target_revision_id)
    );

    -- Raw relationship preimages survive projection deletion and identity
    -- movement, so reconciliation can prove every lineage token was handled.
    CREATE TABLE claim_memory_relationship_sources (
        id INTEGER PRIMARY KEY,
        memory_id INTEGER NOT NULL CHECK (typeof(memory_id) = 'integer' AND memory_id >= 1),
        source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
        merged_from TEXT,
        superseded_by_memory_id INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (memory_id, source_digest)
    );

    -- Idempotency and replay envelope (KTD7, R13).
    CREATE TABLE claim_operations (
        id INTEGER PRIMARY KEY,
        producer TEXT NOT NULL CHECK (length(producer) > 0),
        operation_key TEXT NOT NULL CHECK (length(operation_key) > 0),
        request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
        expected_effect_count INTEGER NOT NULL CHECK (
            typeof(expected_effect_count) = 'integer' AND expected_effect_count >= 0
        ),
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (producer, operation_key)
    );

    -- Durable local semantic/lifecycle effects for U8 (KTD7). U7 never
    -- acknowledges delivery; there is no ack state here by contract.
    -- AUTOINCREMENT: the consumer's high-watermark cursor and the prune
    -- triggers compare against ids, so an id must never be reused — a plain
    -- rowid restarts at 1 after a full prune empties the table, landing new
    -- effects at or below the durable consumed watermark.
    CREATE TABLE claim_change_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id INTEGER NOT NULL REFERENCES claim_operations(id) ON DELETE RESTRICT,
        effect_key TEXT NOT NULL CHECK (length(effect_key) > 0),
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        effect_type TEXT NOT NULL CHECK (effect_type IN ('upsert', 'lifecycle', 'evidence')),
        generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 1),
        created_at INTEGER NOT NULL,
        UNIQUE (operation_id, effect_key)
    );
    CREATE INDEX idx_claim_change_outbox_project ON claim_change_outbox(project_id, generation);
    CREATE INDEX idx_claim_change_outbox_claim ON claim_change_outbox(claim_id);

    -- Monotonic claim-domain change token: one increment per touched project
    -- per outer semantic transaction (KTD7).
    CREATE TABLE claim_project_generations (
        project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
        generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 1),
        updated_at INTEGER NOT NULL
    );

    -- Bounded repair surface for U5/doctor. Mutable by design: dispositions
    -- move between blocking, retry, warning, and resolved.
    CREATE TABLE claim_backfill_failures (
        id INTEGER PRIMARY KEY,
        phase TEXT NOT NULL CHECK (phase IN ('rows', 'relationships', 'reconcile')),
        item_kind TEXT NOT NULL CHECK (length(item_kind) > 0),
        item_key TEXT NOT NULL CHECK (length(item_key) > 0),
        reason_code TEXT NOT NULL CHECK (length(reason_code) > 0),
        detail TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 2000),
        disposition TEXT NOT NULL DEFAULT 'blocking' CHECK (
            disposition IN ('blocking', 'retry', 'warning', 'resolved')
        ),
        rationale TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (phase, item_kind, item_key)
    );

    -- Transaction-scoped capability (KTD6): enabled only inside the owning
    -- write transaction and cleared before commit, so no second connection
    -- can ever observe enabled=1 (the context_privilege_state pattern, in a
    -- deliberately separate table).
    CREATE TABLE claim_compatibility_write_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
    );

    -- Change-log retention state (the claim_compatibility_write_state
    -- pattern, in a deliberately separate table so claims writers never gain
    -- prune authority). enabled is transaction-scoped: set inside the owning
    -- prune transaction and cleared before commit. consumed_watermark is
    -- durable and monotonic: the highest claim_change_outbox id the outbox
    -- consumer has durably consumed. The claim_operations and
    -- claim_change_outbox DELETE triggers permit a delete only while
    -- enabled = 1 AND the deleted change-log state sits at or below this
    -- watermark.
    CREATE TABLE claim_change_log_prune_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        consumed_watermark INTEGER NOT NULL DEFAULT 0 CHECK (
            typeof(consumed_watermark) = 'integer' AND consumed_watermark >= 0
        )
    );
    `);

    db.exec(`
    CREATE TRIGGER legacy_memory_claims_append_only_update BEFORE UPDATE ON legacy_memory_claims
    BEGIN SELECT RAISE(ABORT, 'legacy_memory_claims is append-only: updates are not allowed'); END;
    CREATE TRIGGER legacy_memory_claims_append_only_delete BEFORE DELETE ON legacy_memory_claims
    BEGIN SELECT RAISE(ABORT, 'legacy_memory_claims is append-only: deletes are not allowed'); END;
    CREATE TRIGGER legacy_memory_claims_append_only_insert_collision BEFORE INSERT ON legacy_memory_claims
    WHEN EXISTS (SELECT 1 FROM legacy_memory_claims WHERE memory_id = NEW.memory_id)
      OR (
          NEW.memory_id = NEW.canonical_memory_id
          AND EXISTS (
              SELECT 1 FROM legacy_memory_claims
               WHERE memory_id = canonical_memory_id AND claim_id = NEW.claim_id
          )
      )
    BEGIN SELECT RAISE(ABORT, 'legacy_memory_claims is append-only: key collisions cannot replace rows'); END;

    -- The stored claim/project must be the claim's own project. IS NOT is
    -- deliberate: a missing claim makes the subselect NULL and the guard
    -- fails closed before the FK error would.
    CREATE TRIGGER legacy_memory_claims_project_guard BEFORE INSERT ON legacy_memory_claims
    WHEN (SELECT project_id FROM claims WHERE id = NEW.claim_id) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'legacy_memory_claims project must match the linked claim project'); END;

    -- Duplicate links must resolve to the canonical row's claim and project
    -- (KTD2, R6). The canonical self-link must already exist.
    CREATE TRIGGER legacy_memory_claims_duplicate_link_guard BEFORE INSERT ON legacy_memory_claims
    WHEN NEW.memory_id <> NEW.canonical_memory_id AND NOT EXISTS (
        SELECT 1 FROM legacy_memory_claims
        WHERE memory_id = NEW.canonical_memory_id
          AND memory_id = canonical_memory_id
          AND claim_id = NEW.claim_id
          AND project_id = NEW.project_id
    )
    BEGIN SELECT RAISE(ABORT, 'legacy_memory_claims duplicate link must resolve to its canonical claim and project'); END;

    CREATE TRIGGER claim_revision_memory_metadata_append_only_update BEFORE UPDATE ON claim_revision_memory_metadata
    BEGIN SELECT RAISE(ABORT, 'claim_revision_memory_metadata is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_revision_memory_metadata_append_only_delete BEFORE DELETE ON claim_revision_memory_metadata
    BEGIN SELECT RAISE(ABORT, 'claim_revision_memory_metadata is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_revision_memory_metadata_append_only_insert_collision BEFORE INSERT ON claim_revision_memory_metadata
    WHEN EXISTS (SELECT 1 FROM claim_revision_memory_metadata WHERE revision_id = NEW.revision_id)
    BEGIN SELECT RAISE(ABORT, 'claim_revision_memory_metadata is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_merge_lineage_append_only_update BEFORE UPDATE ON claim_merge_lineage
    BEGIN SELECT RAISE(ABORT, 'claim_merge_lineage is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_merge_lineage_append_only_delete BEFORE DELETE ON claim_merge_lineage
    BEGIN SELECT RAISE(ABORT, 'claim_merge_lineage is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_merge_lineage_append_only_insert_collision BEFORE INSERT ON claim_merge_lineage
    WHEN EXISTS (
        SELECT 1 FROM claim_merge_lineage
        WHERE id = NEW.id OR (
            source_revision_id = NEW.source_revision_id
            AND target_revision_id = NEW.target_revision_id
        )
    )
    BEGIN SELECT RAISE(ABORT, 'claim_merge_lineage is append-only: key collisions cannot replace rows'); END;

    -- Stored endpoint projects must match the revisions' actual projects
    -- (Schema Contract). Fail-closed IS NOT: a missing revision yields NULL.
    CREATE TRIGGER claim_merge_lineage_source_project_guard BEFORE INSERT ON claim_merge_lineage
    WHEN (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.source_revision_id
    ) IS NOT NEW.source_project_id
    BEGIN SELECT RAISE(ABORT, 'claim_merge_lineage source project must match the source revision project'); END;
    CREATE TRIGGER claim_merge_lineage_target_project_guard BEFORE INSERT ON claim_merge_lineage
    WHEN (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.target_revision_id
    ) IS NOT NEW.target_project_id
    BEGIN SELECT RAISE(ABORT, 'claim_merge_lineage target project must match the target revision project'); END;

    CREATE TRIGGER claim_memory_relationship_sources_append_only_update
    BEFORE UPDATE ON claim_memory_relationship_sources
    BEGIN SELECT RAISE(ABORT, 'claim_memory_relationship_sources is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_memory_relationship_sources_append_only_delete
    BEFORE DELETE ON claim_memory_relationship_sources
    BEGIN SELECT RAISE(ABORT, 'claim_memory_relationship_sources is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_memory_relationship_sources_append_only_insert_collision
    BEFORE INSERT ON claim_memory_relationship_sources
    WHEN EXISTS (
        SELECT 1 FROM claim_memory_relationship_sources
         WHERE id = NEW.id
            OR (memory_id = NEW.memory_id AND source_digest = NEW.source_digest)
    )
    BEGIN SELECT RAISE(ABORT, 'claim_memory_relationship_sources is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_operations_append_only_update BEFORE UPDATE ON claim_operations
    BEGIN SELECT RAISE(ABORT, 'claim_operations is append-only: the committed result is immutable'); END;
    -- Retention contract: an operation row leaves only through consumption-
    -- driven pruning — the prune capability must be enabled in the current
    -- transaction and every outbox effect of the operation must sit at or
    -- below the recorded consumed watermark. FK RESTRICT from
    -- claim_change_outbox additionally forces children to be pruned first.
    -- A zero-effect envelope never leaves: it is the only idempotent-replay
    -- record for its operation key.
    CREATE TRIGGER claim_operations_append_only_delete BEFORE DELETE ON claim_operations
    WHEN COALESCE((SELECT enabled FROM claim_change_log_prune_state WHERE id = 1), 0) = 0
      OR OLD.expected_effect_count = 0
      OR EXISTS (
          SELECT 1 FROM claim_change_outbox
           WHERE operation_id = OLD.id
             AND id > COALESCE(
                 (SELECT consumed_watermark FROM claim_change_log_prune_state WHERE id = 1), 0)
      )
    BEGIN SELECT RAISE(ABORT, 'claim_operations is append-only: deletes require the prune capability and effects at or below the consumed watermark'); END;
    CREATE TRIGGER claim_operations_append_only_insert_collision BEFORE INSERT ON claim_operations
    WHEN EXISTS (
        SELECT 1 FROM claim_operations
        WHERE id = NEW.id OR (producer = NEW.producer AND operation_key = NEW.operation_key)
    )
    BEGIN SELECT RAISE(ABORT, 'claim_operations is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_change_outbox_append_only_update BEFORE UPDATE ON claim_change_outbox
    BEGIN SELECT RAISE(ABORT, 'claim_change_outbox is append-only: updates are not allowed'); END;
    -- Retention contract: an outbox effect leaves only through consumption-
    -- driven pruning — the prune capability must be enabled in the current
    -- transaction and the effect's id must sit at or below the recorded
    -- consumed watermark.
    CREATE TRIGGER claim_change_outbox_append_only_delete BEFORE DELETE ON claim_change_outbox
    WHEN COALESCE((SELECT enabled FROM claim_change_log_prune_state WHERE id = 1), 0) = 0
      OR OLD.id > COALESCE(
          (SELECT consumed_watermark FROM claim_change_log_prune_state WHERE id = 1), 0)
    BEGIN SELECT RAISE(ABORT, 'claim_change_outbox is append-only: deletes require the prune capability and an id at or below the consumed watermark'); END;
    CREATE TRIGGER claim_change_outbox_append_only_insert_collision BEFORE INSERT ON claim_change_outbox
    WHEN EXISTS (
        SELECT 1 FROM claim_change_outbox
        WHERE id = NEW.id OR (operation_id = NEW.operation_id AND effect_key = NEW.effect_key)
    )
    BEGIN SELECT RAISE(ABORT, 'claim_change_outbox is append-only: key collisions cannot replace rows'); END;

    -- Every effect belongs to the claim's project. IS NOT makes missing claims
    -- fail closed here instead of relying only on connection-local FK state.
    CREATE TRIGGER claim_change_outbox_project_guard BEFORE INSERT ON claim_change_outbox
    WHEN (SELECT project_id FROM claims WHERE id = NEW.claim_id) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'claim_change_outbox project must match the linked claim project'); END;

    -- Generations only move forward; a project's token can never regress or
    -- disappear.
    CREATE TRIGGER claim_project_generations_monotonic_guard BEFORE UPDATE ON claim_project_generations
    WHEN NEW.generation <= OLD.generation OR NEW.project_id IS NOT OLD.project_id
    BEGIN SELECT RAISE(ABORT, 'claim_project_generations must increase monotonically per project'); END;
    CREATE TRIGGER claim_project_generations_delete_guard BEFORE DELETE ON claim_project_generations
    BEGIN SELECT RAISE(ABORT, 'claim_project_generations rows cannot be deleted'); END;
    CREATE TRIGGER claim_project_generations_insert_collision BEFORE INSERT ON claim_project_generations
    WHEN EXISTS (SELECT 1 FROM claim_project_generations WHERE project_id = NEW.project_id)
    BEGIN SELECT RAISE(ABORT, 'claim_project_generations key collisions cannot replace rows'); END;
    `);
}

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
export function pruneClaimChangeLogInCurrentTransaction(
    db: Database,
    consumedWatermark: number,
): ClaimChangeLogPruneResult {
    if (!isInTransaction(db)) {
        throw new Error(
            "pruneClaimChangeLogInCurrentTransaction requires the caller's open write transaction: in autocommit the enabled=1 capability row would commit and be visible to other connections",
        );
    }
    if (!Number.isSafeInteger(consumedWatermark) || consumedWatermark < 0) {
        throw new Error(
            `claim change-log consumed watermark must be a non-negative integer: ${String(consumedWatermark)}`,
        );
    }
    db.prepare(
        `INSERT INTO claim_change_log_prune_state (id, enabled, consumed_watermark)
         VALUES (1, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
             enabled = 1,
             consumed_watermark = MAX(consumed_watermark, excluded.consumed_watermark)`,
    ).run(consumedWatermark);
    try {
        // Row counts come from pre-delete SELECTs: the sqlite adapters do not
        // all report per-statement change counts reliably.
        const prunedOutboxRows = (
            db
                .prepare("SELECT COUNT(*) AS count FROM claim_change_outbox WHERE id <= ?")
                .get(consumedWatermark) as { count: number }
        ).count;
        db.prepare("DELETE FROM claim_change_outbox WHERE id <= ?").run(consumedWatermark);
        const fullyConsumedOperations = `
            SELECT id FROM claim_operations
             WHERE expected_effect_count > 0
               AND NOT EXISTS (
                   SELECT 1 FROM claim_change_outbox
                    WHERE claim_change_outbox.operation_id = claim_operations.id
               )`;
        const prunedOperationRows = (
            db.prepare(`SELECT COUNT(*) AS count FROM (${fullyConsumedOperations})`).get() as {
                count: number;
            }
        ).count;
        db.prepare(`DELETE FROM claim_operations WHERE id IN (${fullyConsumedOperations})`).run();
        return { prunedOutboxRows, prunedOperationRows };
    } finally {
        db.prepare("UPDATE claim_change_log_prune_state SET enabled = 0 WHERE id = 1").run();
    }
}

/**
 * Predicate over a `memories`-shaped row alias: true when the row carries
 * relationship lineage — a supersession pointer or a nonblank merged_from.
 * COALESCE(TRIM(...), '') folds NULL, empty, and whitespace-only merged_from
 * into "no lineage". Single source of truth for the relationship guard
 * triggers here and the backfill lineage scans.
 */
export function memoryLineagePresentSql(alias: string): string {
    return `(${alias}.superseded_by_memory_id IS NOT NULL OR COALESCE(TRIM(${alias}.merged_from), '') <> '')`;
}

/**
 * Condition matching a `claim_memory_relationship_sources` snapshot row to
 * the aliased `memories` row's current lineage state. IS comparisons keep
 * NULL lineage columns comparable, so a row whose exact
 * (merged_from, superseded_by_memory_id) preimage is snapshotted satisfies
 * the condition. The subquery aliases the sources table as `source`; callers
 * must not bind that alias to the outer row.
 */
export function memoryRelationshipSourceMatchSql(alias: string): string {
    return `EXISTS (
        SELECT 1 FROM claim_memory_relationship_sources source
         WHERE source.memory_id = ${alias}.id
           AND source.merged_from IS ${alias}.merged_from
           AND source.superseded_by_memory_id IS ${alias}.superseded_by_memory_id
    )`;
}

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
export function installMemoryClaimsWriteGuards(db: Database): void {
    const capabilityCheck =
        "COALESCE((SELECT enabled FROM claim_compatibility_write_state WHERE id = 1), 0) = 0";
    const boundary = `COALESCE((SELECT CAST(value AS INTEGER) FROM schema_migrations_meta WHERE key = '${CLAIMS_BACKFILL_META_KEYS.boundaryMemoryId}'), 0)`;
    // pi-lens-ignore: sql-injection
    db.exec(`
    CREATE TRIGGER memories_claims_write_guard_insert
    BEFORE INSERT ON memories
    WHEN ${capabilityCheck}
    BEGIN SELECT RAISE(ABORT, 'memories semantic writes require the v84 claims-write kernel'); END;

    CREATE TRIGGER memories_claims_write_guard_delete
    BEFORE DELETE ON memories
    WHEN ${capabilityCheck}
    BEGIN SELECT RAISE(ABORT, 'memories semantic writes require the v84 claims-write kernel'); END;

    CREATE TRIGGER memories_claims_write_guard_update
    BEFORE UPDATE OF project_path, content, category, normalized_hash, importance, scope, shareable,
        source_session_id, source_type, expires_at, status, verification_status, verified_at,
        superseded_by_memory_id, merged_from, metadata_json ON memories
    WHEN (
        NEW.project_path IS NOT OLD.project_path
        OR NEW.content IS NOT OLD.content
        OR NEW.category IS NOT OLD.category
        OR NEW.normalized_hash IS NOT OLD.normalized_hash
        OR NEW.importance IS NOT OLD.importance
        OR NEW.scope IS NOT OLD.scope
        OR NEW.shareable IS NOT OLD.shareable
        OR NEW.source_session_id IS NOT OLD.source_session_id
        OR NEW.source_type IS NOT OLD.source_type
        OR NEW.expires_at IS NOT OLD.expires_at
        OR NEW.status IS NOT OLD.status
        OR NEW.verification_status IS NOT OLD.verification_status
        OR NEW.verified_at IS NOT OLD.verified_at
        OR NEW.superseded_by_memory_id IS NOT OLD.superseded_by_memory_id
        OR NEW.merged_from IS NOT OLD.merged_from
        OR NEW.metadata_json IS NOT OLD.metadata_json
    ) AND ${capabilityCheck}
    BEGIN SELECT RAISE(ABORT, 'memories semantic writes require the v84 claims-write kernel'); END;

    -- Boundary rows must be linked before they can leave the corpus (R1).
    CREATE TRIGGER memories_claims_boundary_delete_guard
    BEFORE DELETE ON memories
    WHEN OLD.id <= ${boundary}
      AND NOT EXISTS (SELECT 1 FROM legacy_memory_claims WHERE memory_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'v84 boundary memories require a claim crosswalk link before delete'); END;

    CREATE TRIGGER memories_claims_relationship_delete_guard
    BEFORE DELETE ON memories
    WHEN ${memoryLineagePresentSql("OLD")}
      AND NOT ${memoryRelationshipSourceMatchSql("OLD")}
    BEGIN SELECT RAISE(ABORT, 'memory relationships require translation before delete'); END;

    CREATE TRIGGER memories_claims_relationship_update_guard
    BEFORE UPDATE OF project_path, superseded_by_memory_id, merged_from ON memories
    WHEN (
        NEW.project_path IS NOT OLD.project_path
        OR NEW.superseded_by_memory_id IS NOT OLD.superseded_by_memory_id
        OR NEW.merged_from IS NOT OLD.merged_from
    )
      AND ${memoryLineagePresentSql("OLD")}
      AND NOT ${memoryRelationshipSourceMatchSql("OLD")}
    BEGIN SELECT RAISE(ABORT, 'memory relationships require translation before mutation'); END;

    CREATE TRIGGER memories_claims_boundary_identity_guard
    BEFORE UPDATE OF project_path ON memories
    WHEN NEW.project_path IS NOT OLD.project_path
      AND OLD.id <= ${boundary}
      AND NOT EXISTS (SELECT 1 FROM legacy_memory_claims WHERE memory_id = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'v84 boundary memories require a claim crosswalk link before identity moves'); END;
    `);
    if (
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_verifications'",
            )
            .get()
    ) {
        // pi-lens-ignore: sql-injection
        db.exec(`
        CREATE TRIGGER memory_verifications_claims_write_guard_insert
        BEFORE INSERT ON memory_verifications
        WHEN ${capabilityCheck}
        BEGIN SELECT RAISE(ABORT, 'memory_verifications writes require the v84 claims-write kernel'); END;
        CREATE TRIGGER memory_verifications_claims_write_guard_update
        BEFORE UPDATE ON memory_verifications
        WHEN ${capabilityCheck}
        BEGIN SELECT RAISE(ABORT, 'memory_verifications writes require the v84 claims-write kernel'); END;
        CREATE TRIGGER memory_verifications_claims_write_guard_delete
        BEFORE DELETE ON memory_verifications
        WHEN ${capabilityCheck}
        BEGIN SELECT RAISE(ABORT, 'memory_verifications writes require the v84 claims-write kernel'); END;
        `);
    }
}

/**
 * Targeted per-new-table foreign-key validation, mirroring
 * `assertClaimsSchemaForeignKeys` so unrelated legacy corruption cannot turn
 * this migration into a whole-database repair gate.
 */
export function assertMemoryClaimsSchemaForeignKeys(db: Database): void {
    const violations: string[] = [];
    for (const table of MEMORY_CLAIMS_COMPAT_TABLES) {
        const rows = db.prepare(`PRAGMA foreign_key_check(${table})`).all() as unknown[];
        if (rows.length > 0) violations.push(`${table}: ${rows.length} violation(s)`);
    }
    if (violations.length > 0) {
        throw new Error(`v84 foreign_key_check failed: ${violations.join("; ")}`);
    }
}

export function dropMemoryClaimsCompatObjectsForTests(db: Database): void {
    db.exec(`
        DROP TRIGGER IF EXISTS memories_claims_write_guard_insert;
        DROP TRIGGER IF EXISTS memories_claims_write_guard_update;
        DROP TRIGGER IF EXISTS memories_claims_write_guard_delete;
        DROP TRIGGER IF EXISTS memories_claims_boundary_delete_guard;
        DROP TRIGGER IF EXISTS memories_claims_boundary_identity_guard;
        DROP TRIGGER IF EXISTS memories_claims_relationship_delete_guard;
        DROP TRIGGER IF EXISTS memories_claims_relationship_update_guard;
        DROP TRIGGER IF EXISTS memory_verifications_claims_write_guard_insert;
        DROP TRIGGER IF EXISTS memory_verifications_claims_write_guard_update;
        DROP TRIGGER IF EXISTS memory_verifications_claims_write_guard_delete;
        DROP TABLE IF EXISTS claim_change_outbox;
        DROP TABLE IF EXISTS claim_operations;
        DROP TABLE IF EXISTS claim_project_generations;
        DROP TABLE IF EXISTS claim_backfill_failures;
        DROP TABLE IF EXISTS claim_memory_relationship_sources;
        DROP TABLE IF EXISTS claim_merge_lineage;
        DROP TABLE IF EXISTS claim_revision_memory_metadata;
        DROP TABLE IF EXISTS legacy_memory_claims;
        DROP TABLE IF EXISTS claim_compatibility_write_state;
        DROP TABLE IF EXISTS claim_change_log_prune_state;
    `);
    db.prepare("DELETE FROM schema_migrations WHERE version >= 84").run();
    try {
        db.prepare("DELETE FROM schema_migrations_meta WHERE key LIKE 'claims_backfill_%'").run();
    } catch {
        // Sparse fixtures may lack schema_migrations_meta entirely.
    }
}
