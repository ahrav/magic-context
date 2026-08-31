/**
 * Each project-memory claim has one append-only revision-attributes row.
 * The lifecycle ledger enforces exactly one database head per claim.
 * The current-head index is rebuildable, and claim telemetry is nonsemantic.
 * The outbox groups effects by receipt and stores checkpoints per consumer.
 *
 * The separate schema creator lets callers omit `claim_project_generations` when the database already owns that table.
 *
 *
 * Public IDs, revision attributes, lifecycle events, derivations, and operation receipts are append-only.
 * Those tables reject UPDATE, DELETE, and inserts that collide on a key.
 * Operation receipts persist for the database lifetime.
 * No operation-receipt prune path exists.
 * Outbox effects may be pruned only when `claim_outbox_prune_state` permits the watermark.
 * `claim_memory_current_heads`, `claim_usage_stats`, and `claim_outbox_consumer_checkpoints` are mutable.
 * Current heads are rebuildable projections, usage stats are nonsemantic telemetry, and consumer checkpoints are durable cursors.
 * consumer cursors.
 */

import type { Database } from "../../shared/sqlite";

export const CLAIM_MEMORY_TABLES = [
    "claim_public_ids",
    "claim_memory_revision_attributes",
    "claim_memory_lifecycle_events",
    "claim_memory_current_heads",
    "claim_usage_stats",
    "claim_mural_cues",
    "claim_derivations",
    "claim_operation_receipts",
    "claim_operation_effects",
    "claim_outbox_consumer_checkpoints",
    "claim_outbox_prune_state",
] as const;

/* */
export const CLAIM_MEMORY_LIFECYCLE_STATES = ["active", "archived", "retired"] as const;
export type ClaimMemoryLifecycleState = (typeof CLAIM_MEMORY_LIFECYCLE_STATES)[number];

/* */
export const CLAIM_MEMORY_SHARING = ["private", "shareable"] as const;
export type ClaimMemorySharing = (typeof CLAIM_MEMORY_SHARING)[number];

/* */
export const CLAIM_EFFECT_CHANGE_KINDS = [
    "upsert",
    "evidence",
    "lifecycle",
    "applicability",
    "verification",
    "derivation",
] as const;
export type ClaimEffectChangeKind = (typeof CLAIM_EFFECT_CHANGE_KINDS)[number];

/** Receipt outcomes record applied effects, a stale claim-local token, or a semantic no-op.
 * All receipt outcomes persist for replay. */
export const CLAIM_OPERATION_OUTCOMES = ["applied", "stale", "noop"] as const;
export type ClaimOperationOutcome = (typeof CLAIM_OPERATION_OUTCOMES)[number];

/* */
export const CLAIM_DERIVATION_RELATIONS = ["copied_from", "moved_from"] as const;
export type ClaimDerivationRelation = (typeof CLAIM_DERIVATION_RELATIONS)[number];

const sqlList = (values: readonly string[]): string =>
    values.map((value) => `'${value}'`).join(", ");

/**
 * The separate schema creator lets callers omit `claim_project_generations` when the database already owns that table.
 * `createClaimMemorySchema`.
 */
export function createClaimProjectGenerationsSchema(db: Database): void {
    db.exec(`
    CREATE TABLE claim_project_generations (
        project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
        generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 1),
        updated_at INTEGER NOT NULL
    );
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

/* */
export function createClaimMemorySchema(db: Database): void {
    // pi-lens-ignore: sql-injection
    db.exec(`
    -- Immutable opaque public identity for every project-memory claim (R2,
    -- KTD3). The public ID is the semantic boundary; numeric row IDs stay
    -- internal.
    CREATE TABLE claim_public_ids (
        claim_id INTEGER PRIMARY KEY REFERENCES claims(id) ON DELETE RESTRICT,
        public_id TEXT NOT NULL UNIQUE CHECK (
            length(public_id) = 36 AND public_id GLOB 'mcm_*'
        ),
        created_at INTEGER NOT NULL
    );

    -- One-to-one append-only attribute row per project-memory revision
    -- (R1, R3, KTD4): category, normalized hash, importance, scope, sharing,
    -- and expiry are revision-bound; changing any of them appends a revision.
    CREATE TABLE claim_memory_revision_attributes (
        revision_id INTEGER PRIMARY KEY REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        category TEXT NOT NULL CHECK (length(category) > 0),
        normalized_hash TEXT NOT NULL CHECK (length(normalized_hash) > 0),
        importance INTEGER NOT NULL CHECK (
            typeof(importance) = 'integer' AND importance BETWEEN 1 AND 100
        ),
        memory_scope TEXT NOT NULL CHECK (memory_scope IN ('project', 'ecosystem', 'universe')),
        sharing TEXT NOT NULL CHECK (sharing IN (${sqlList(CLAIM_MEMORY_SHARING)})),
        expires_at INTEGER,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_claim_memory_revision_attributes_claim
        ON claim_memory_revision_attributes(claim_id);
    CREATE INDEX idx_claim_memory_revision_attributes_hash
        ON claim_memory_revision_attributes(project_id, category, normalized_hash);

    -- Append-only lifecycle ledger with one database-enforced current head
    -- per claim (KTD4): a gapless per-claim chain whose head is the maximum
    -- sequence; the chain guards make a fork or gap impossible.
    CREATE TABLE claim_memory_lifecycle_events (
        id INTEGER PRIMARY KEY,
        claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 1),
        predecessor_id INTEGER REFERENCES claim_memory_lifecycle_events(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN (${sqlList(CLAIM_MEMORY_LIFECYCLE_STATES)})),
        actor TEXT NOT NULL CHECK (length(actor) > 0),
        reason TEXT CHECK (reason IS NULL OR length(reason) > 0),
        recorded_at INTEGER NOT NULL,
        UNIQUE (claim_id, seq),
        CHECK ((seq = 1) = (predecessor_id IS NULL))
    );
    CREATE UNIQUE INDEX idx_claim_memory_lifecycle_events_predecessor
        ON claim_memory_lifecycle_events(predecessor_id)
        WHERE predecessor_id IS NOT NULL;

    -- Current lifecycle head per claim (derived; one row per claim by the
    -- gapless-chain construction).
    CREATE VIEW claim_memory_lifecycle_heads AS
    SELECT
        event.id AS event_id,
        event.claim_id AS claim_id,
        event.seq AS seq,
        event.state AS state,
        event.actor AS actor,
        event.recorded_at AS recorded_at
    FROM claim_memory_lifecycle_events AS event
    WHERE event.seq = (
        SELECT MAX(inner.seq) FROM claim_memory_lifecycle_events AS inner
        WHERE inner.claim_id = event.claim_id
    );

    -- Rebuildable current-head dedup index (KTD4, R7): one LIVE claim per
    -- (project, category, normalized hash), enforced by the partial unique
    -- index so concurrent duplicate writes converge instead of forking.
    -- Mutable by design; rebuildClaimMemoryCurrentHeads() reproduces it from
    -- authoritative rows.
    CREATE TABLE claim_memory_current_heads (
        claim_id INTEGER PRIMARY KEY REFERENCES claims(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        category TEXT NOT NULL CHECK (length(category) > 0),
        normalized_hash TEXT NOT NULL CHECK (length(normalized_hash) > 0),
        revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        lifecycle_state TEXT NOT NULL CHECK (
            lifecycle_state IN (${sqlList(CLAIM_MEMORY_LIFECYCLE_STATES)})
        ),
        updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_claim_memory_current_heads_dedup
        ON claim_memory_current_heads(project_id, category, normalized_hash)
        WHERE lifecycle_state = 'active';

    -- Nonsemantic mutable usage telemetry (R3): counters never gate policy,
    -- trust, or replay.
    CREATE TABLE claim_usage_stats (
        claim_id INTEGER PRIMARY KEY REFERENCES claims(id) ON DELETE RESTRICT,
        seen_count INTEGER NOT NULL DEFAULT 0 CHECK (
            typeof(seen_count) = 'integer' AND seen_count >= 0
        ),
        retrieval_count INTEGER NOT NULL DEFAULT 0 CHECK (
            typeof(retrieval_count) = 'integer' AND retrieval_count >= 0
        ),
        last_seen_at INTEGER,
        last_retrieved_at INTEGER,
        updated_at INTEGER NOT NULL
    );

    -- Derived mural cue cache (KTD4): one row per claim, keyed to the exact
    -- revision locator and renderer epoch the cue was compressed for. A
    -- locator or epoch mismatch reads as "no cue" and regenerates; a NULL cue
    -- with a nonzero rejection count is the validation-rejection latch.
    CREATE TABLE claim_mural_cues (
        claim_id INTEGER PRIMARY KEY REFERENCES claims(id) ON DELETE RESTRICT,
        revision_locator TEXT NOT NULL CHECK (length(revision_locator) > 0),
        renderer_epoch INTEGER NOT NULL CHECK (
            typeof(renderer_epoch) = 'integer' AND renderer_epoch >= 1
        ),
        cue TEXT CHECK (cue IS NULL OR length(cue) > 0),
        rejection_count INTEGER NOT NULL DEFAULT 0 CHECK (
            typeof(rejection_count) = 'integer' AND rejection_count >= 0
        ),
        updated_at INTEGER NOT NULL
    );

    -- Explicit cross-project derivation lineage (R8, KTD4): copy/move create
    -- target claims that point back at their sources through this relation,
    -- never through evidence.
    CREATE TABLE claim_derivations (
        id INTEGER PRIMARY KEY,
        source_claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        target_claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL CHECK (relation IN (${sqlList(CLAIM_DERIVATION_RELATIONS)})),
        created_at INTEGER NOT NULL,
        CHECK (source_claim_id <> target_claim_id),
        UNIQUE (source_claim_id, target_claim_id, relation)
    );

    -- Lifetime operation receipts (KTD5, R20): versioned request/result
    -- encodings, a durable effect summary, and the committed generation
    -- vector. Receipts leave only through whole-database reset.
    CREATE TABLE claim_operation_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producer TEXT NOT NULL CHECK (length(producer) > 0),
        operation_key TEXT NOT NULL CHECK (length(operation_key) > 0),
        request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
        request_encoding_version INTEGER NOT NULL CHECK (
            typeof(request_encoding_version) = 'integer' AND request_encoding_version >= 1
        ),
        result_encoding_version INTEGER NOT NULL CHECK (
            typeof(result_encoding_version) = 'integer' AND result_encoding_version >= 1
        ),
        outcome TEXT NOT NULL CHECK (outcome IN (${sqlList(CLAIM_OPERATION_OUTCOMES)})),
        expected_effect_count INTEGER NOT NULL CHECK (
            typeof(expected_effect_count) = 'integer' AND expected_effect_count >= 0
        ),
        effect_summary_json TEXT NOT NULL CHECK (json_valid(effect_summary_json)),
        generation_vector_json TEXT NOT NULL CHECK (json_valid(generation_vector_json)),
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (producer, operation_key)
    );

    -- Receipt-grouped effect outbox (KTD13). AUTOINCREMENT: consumer cursors
    -- and prune watermarks compare ids, so an id must never be reused after
    -- a full prune empties the table.
    CREATE TABLE claim_operation_effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_id INTEGER NOT NULL REFERENCES claim_operation_receipts(id) ON DELETE RESTRICT,
        effect_key TEXT NOT NULL CHECK (length(effect_key) > 0),
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        revision_id INTEGER REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        change_kind TEXT NOT NULL CHECK (change_kind IN (${sqlList(CLAIM_EFFECT_CHANGE_KINDS)})),
        generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 1),
        created_at INTEGER NOT NULL,
        UNIQUE (receipt_id, effect_key)
    );
    CREATE INDEX idx_claim_operation_effects_project
        ON claim_operation_effects(project_id, generation);
    CREATE INDEX idx_claim_operation_effects_receipt ON claim_operation_effects(receipt_id);

    -- Durable per-consumer/project cursors (KTD13). Mutable; monotonicity is
    -- enforced by advanceOutboxConsumerCheckpointInCurrentTransaction (the
    -- claim_policy_projector_watermarks pattern).
    CREATE TABLE claim_outbox_consumer_checkpoints (
        consumer TEXT NOT NULL CHECK (length(consumer) > 0),
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        acked_effect_id INTEGER NOT NULL CHECK (
            typeof(acked_effect_id) = 'integer' AND acked_effect_id >= 0
        ),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (consumer, project_id)
    ) WITHOUT ROWID;

    -- Outbox prune capability + watermark (the v84 change-log pattern):
    -- enabled only inside the owning prune transaction and cleared before
    -- commit; the effects DELETE trigger observes both fields.
    CREATE TABLE claim_outbox_prune_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        consumed_watermark INTEGER NOT NULL DEFAULT 0 CHECK (
            typeof(consumed_watermark) = 'integer' AND consumed_watermark >= 0
        )
    );
    `);

    // pi-lens-ignore: sql-injection
    db.exec(`
    CREATE TRIGGER claim_public_ids_append_only_update BEFORE UPDATE ON claim_public_ids
    BEGIN SELECT RAISE(ABORT, 'claim_public_ids is append-only: a public identity is immutable'); END;
    CREATE TRIGGER claim_public_ids_append_only_delete BEFORE DELETE ON claim_public_ids
    BEGIN SELECT RAISE(ABORT, 'claim_public_ids is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_public_ids_append_only_insert_collision BEFORE INSERT ON claim_public_ids
    WHEN EXISTS (
        SELECT 1 FROM claim_public_ids
        WHERE claim_id = NEW.claim_id OR public_id = NEW.public_id
    )
    BEGIN SELECT RAISE(ABORT, 'claim_public_ids is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_memory_revision_attributes_append_only_update
    BEFORE UPDATE ON claim_memory_revision_attributes
    BEGIN SELECT RAISE(ABORT, 'claim_memory_revision_attributes is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_memory_revision_attributes_append_only_delete
    BEFORE DELETE ON claim_memory_revision_attributes
    BEGIN SELECT RAISE(ABORT, 'claim_memory_revision_attributes is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_memory_revision_attributes_append_only_insert_collision
    BEFORE INSERT ON claim_memory_revision_attributes
    WHEN EXISTS (
        SELECT 1 FROM claim_memory_revision_attributes WHERE revision_id = NEW.revision_id
    )
    BEGIN SELECT RAISE(ABORT, 'claim_memory_revision_attributes is append-only: key collisions cannot replace rows'); END;

    -- The attributed revision must belong to the stated claim, and the claim
    -- to the stated project. IS NOT is deliberate: a missing row makes the
    -- subselect NULL and the guard fails closed before the FK error would.
    CREATE TRIGGER claim_memory_revision_attributes_revision_guard
    BEFORE INSERT ON claim_memory_revision_attributes
    WHEN (SELECT claim_id FROM claim_revisions WHERE id = NEW.revision_id) IS NOT NEW.claim_id
      OR (SELECT project_id FROM claims WHERE id = NEW.claim_id) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'claim_memory_revision_attributes must bind a revision of its own claim and project'); END;

    -- The project-memory subtype requires the public identity first.
    CREATE TRIGGER claim_memory_revision_attributes_public_id_guard
    BEFORE INSERT ON claim_memory_revision_attributes
    WHEN NOT EXISTS (SELECT 1 FROM claim_public_ids WHERE claim_id = NEW.claim_id)
    BEGIN SELECT RAISE(ABORT, 'claim_memory_revision_attributes requires the claim public identity'); END;

    CREATE TRIGGER claim_memory_lifecycle_events_append_only_update
    BEFORE UPDATE ON claim_memory_lifecycle_events
    BEGIN SELECT RAISE(ABORT, 'claim_memory_lifecycle_events is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_memory_lifecycle_events_append_only_delete
    BEFORE DELETE ON claim_memory_lifecycle_events
    BEGIN SELECT RAISE(ABORT, 'claim_memory_lifecycle_events is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_memory_lifecycle_events_append_only_insert_collision
    BEFORE INSERT ON claim_memory_lifecycle_events
    WHEN EXISTS (
        SELECT 1 FROM claim_memory_lifecycle_events
        WHERE id = NEW.id OR (claim_id = NEW.claim_id AND seq = NEW.seq)
    )
    BEGIN SELECT RAISE(ABORT, 'claim_memory_lifecycle_events is append-only: key collisions cannot replace rows'); END;

    -- Gapless chain: a successor consumes exactly the current head of its
    -- own claim.
    CREATE TRIGGER claim_memory_lifecycle_events_chain_guard
    BEFORE INSERT ON claim_memory_lifecycle_events
    WHEN NEW.seq > 1 AND (
        SELECT id FROM claim_memory_lifecycle_events
        WHERE claim_id = NEW.claim_id AND seq = NEW.seq - 1
    ) IS NOT NEW.predecessor_id
    BEGIN SELECT RAISE(ABORT, 'claim_memory_lifecycle_events successor must consume the current head'); END;
    CREATE TRIGGER claim_memory_lifecycle_events_first_seq_guard
    BEFORE INSERT ON claim_memory_lifecycle_events
    WHEN NEW.seq = 1 AND EXISTS (
        SELECT 1 FROM claim_memory_lifecycle_events WHERE claim_id = NEW.claim_id
    )
    BEGIN SELECT RAISE(ABORT, 'claim_memory_lifecycle_events already has an opening event for this claim'); END;

    -- Lifecycle is part of the project-memory subtype contract.
    CREATE TRIGGER claim_memory_lifecycle_events_public_id_guard
    BEFORE INSERT ON claim_memory_lifecycle_events
    WHEN NOT EXISTS (SELECT 1 FROM claim_public_ids WHERE claim_id = NEW.claim_id)
    BEGIN SELECT RAISE(ABORT, 'claim_memory_lifecycle_events requires the claim public identity'); END;

    CREATE TRIGGER claim_derivations_append_only_update BEFORE UPDATE ON claim_derivations
    BEGIN SELECT RAISE(ABORT, 'claim_derivations is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_derivations_append_only_delete BEFORE DELETE ON claim_derivations
    BEGIN SELECT RAISE(ABORT, 'claim_derivations is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_derivations_append_only_insert_collision BEFORE INSERT ON claim_derivations
    WHEN EXISTS (
        SELECT 1 FROM claim_derivations
        WHERE id = NEW.id OR (
            source_claim_id = NEW.source_claim_id
            AND target_claim_id = NEW.target_claim_id
            AND relation = NEW.relation
        )
    )
    BEGIN SELECT RAISE(ABORT, 'claim_derivations is append-only: key collisions cannot replace rows'); END;

    -- Derivation lineage is the CROSS-project relation (R8): same-project
    -- merge uses claim_conflicts instead. IS NOT fails closed on a missing
    -- endpoint.
    CREATE TRIGGER claim_derivations_cross_project_guard BEFORE INSERT ON claim_derivations
    WHEN (SELECT project_id FROM claims WHERE id = NEW.source_claim_id) IS NULL
      OR (SELECT project_id FROM claims WHERE id = NEW.source_claim_id)
         IS (SELECT project_id FROM claims WHERE id = NEW.target_claim_id)
    BEGIN SELECT RAISE(ABORT, 'claim_derivations endpoints must belong to different projects'); END;

    CREATE TRIGGER claim_operation_receipts_append_only_update
    BEFORE UPDATE ON claim_operation_receipts
    BEGIN SELECT RAISE(ABORT, 'claim_operation_receipts is append-only: the committed result is immutable'); END;
    -- Receipts live for the whole database incarnation (R20): no prune path.
    CREATE TRIGGER claim_operation_receipts_append_only_delete
    BEFORE DELETE ON claim_operation_receipts
    BEGIN SELECT RAISE(ABORT, 'claim_operation_receipts live until whole-database reset'); END;
    CREATE TRIGGER claim_operation_receipts_append_only_insert_collision
    BEFORE INSERT ON claim_operation_receipts
    WHEN EXISTS (
        SELECT 1 FROM claim_operation_receipts
        WHERE id = NEW.id OR (producer = NEW.producer AND operation_key = NEW.operation_key)
    )
    BEGIN SELECT RAISE(ABORT, 'claim_operation_receipts is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_operation_effects_append_only_update
    BEFORE UPDATE ON claim_operation_effects
    BEGIN SELECT RAISE(ABORT, 'claim_operation_effects is append-only: updates are not allowed'); END;
    -- Retention contract: an effect leaves only through consumption-driven
    -- pruning — the capability must be enabled in the current transaction
    -- and the effect id must sit at or below the recorded watermark.
    CREATE TRIGGER claim_operation_effects_append_only_delete
    BEFORE DELETE ON claim_operation_effects
    WHEN COALESCE((SELECT enabled FROM claim_outbox_prune_state WHERE id = 1), 0) = 0
      OR OLD.id > COALESCE(
          (SELECT consumed_watermark FROM claim_outbox_prune_state WHERE id = 1), 0)
    BEGIN SELECT RAISE(ABORT, 'claim_operation_effects deletes require the prune capability and an id at or below the consumed watermark'); END;
    CREATE TRIGGER claim_operation_effects_append_only_insert_collision
    BEFORE INSERT ON claim_operation_effects
    WHEN EXISTS (
        SELECT 1 FROM claim_operation_effects
        WHERE id = NEW.id OR (receipt_id = NEW.receipt_id AND effect_key = NEW.effect_key)
    )
    BEGIN SELECT RAISE(ABORT, 'claim_operation_effects is append-only: key collisions cannot replace rows'); END;

    -- Every effect belongs to its claim's project, and a named revision must
    -- belong to the effect's claim. IS NOT fails closed on missing rows.
    CREATE TRIGGER claim_operation_effects_project_guard
    BEFORE INSERT ON claim_operation_effects
    WHEN (SELECT project_id FROM claims WHERE id = NEW.claim_id) IS NOT NEW.project_id
      OR (
          NEW.revision_id IS NOT NULL
          AND (SELECT claim_id FROM claim_revisions WHERE id = NEW.revision_id) IS NOT NEW.claim_id
      )
    BEGIN SELECT RAISE(ABORT, 'claim_operation_effects must bind a claim of the stated project and a revision of that claim'); END;
    `);
}

/* */
export function createClaimMemoryComponentSchema(db: Database): void {
    createClaimProjectGenerationsSchema(db);
    createClaimMemorySchema(db);
}
