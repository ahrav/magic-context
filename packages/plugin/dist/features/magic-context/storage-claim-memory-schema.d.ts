/**
 * U2 direct-format claim-memory DDL (direct-claims-cutover plan: KTD3-KTD5,
 * KTD13; R1-R8, R19-R20): public claim identity, the project-memory claim
 * subtype (one-to-one append-only revision attributes plus an append-only
 * lifecycle ledger with one database-enforced head), the rebuildable
 * current-head dedup index, nonsemantic claim telemetry, cross-project
 * derivation lineage, lifetime operation receipts with durable effect
 * summaries, the receipt-grouped effect outbox, per-consumer checkpoints,
 * generation allocation, and outbox prune state.
 *
 * Registered as the `claim-memory` component of the direct schema
 * (`storage-current-schema.ts`); never created by legacy migrations. The one
 * exception is `claim_project_generations`, whose DDL is byte-compatible
 * with the v84 migration's table so the v86 policy writers work against both
 * worlds — it is created through the separate
 * `createClaimProjectGenerationsSchema` so tests may overlay the rest of the
 * fragment onto a legacy database that already owns that table.
 *
 * Dependency-light on purpose: type-only imports so the Node smoke scripts
 * can load this module under Node's type-stripping loader.
 *
 * Append-only contract: public IDs, revision attributes, lifecycle events,
 * derivations, and operation receipts reject every UPDATE and DELETE plus
 * key-colliding inserts. Receipts live for the whole database incarnation
 * (R20) — there is no receipt prune path at all. Outbox effects admit only
 * watermark-gated pruning under the `claim_outbox_prune_state` capability
 * (the v84 change-log pattern). `claim_memory_current_heads`,
 * `claim_usage_stats`, and `claim_outbox_consumer_checkpoints` are mutable
 * by design: rebuildable projection, nonsemantic telemetry, and durable
 * consumer cursors.
 */
import type { Database } from "../../shared/sqlite";
export declare const CLAIM_MEMORY_TABLES: readonly ["claim_public_ids", "claim_memory_revision_attributes", "claim_memory_lifecycle_events", "claim_memory_current_heads", "claim_usage_stats", "claim_mural_cues", "claim_derivations", "claim_operation_receipts", "claim_operation_effects", "claim_outbox_consumer_checkpoints", "claim_outbox_prune_state"];
/** Lifecycle states of a project-memory claim (KTD4). */
export declare const CLAIM_MEMORY_LIFECYCLE_STATES: readonly ["active", "archived", "retired"];
export type ClaimMemoryLifecycleState = (typeof CLAIM_MEMORY_LIFECYCLE_STATES)[number];
/** Sharing dispositions carried on revision attributes (R3). */
export declare const CLAIM_MEMORY_SHARING: readonly ["private", "shareable"];
export type ClaimMemorySharing = (typeof CLAIM_MEMORY_SHARING)[number];
/** Semantic change kinds published on outbox effects (KTD5, KTD13). */
export declare const CLAIM_EFFECT_CHANGE_KINDS: readonly ["upsert", "evidence", "lifecycle", "applicability", "verification", "derivation"];
export type ClaimEffectChangeKind = (typeof CLAIM_EFFECT_CHANGE_KINDS)[number];
/** Stored receipt outcomes (KTD5): applied effects, a stale claim-local
 * token, or a semantic no-op. All three persist for replay (R5-R6, R20). */
export declare const CLAIM_OPERATION_OUTCOMES: readonly ["applied", "stale", "noop"];
export type ClaimOperationOutcome = (typeof CLAIM_OPERATION_OUTCOMES)[number];
/** Cross-project derivation relations (R8, KTD10). */
export declare const CLAIM_DERIVATION_RELATIONS: readonly ["copied_from", "moved_from"];
export type ClaimDerivationRelation = (typeof CLAIM_DERIVATION_RELATIONS)[number];
/**
 * `claim_project_generations` with the exact v84 shape and guards, split out
 * so the registered component can create it on direct databases while a
 * legacy database (which already owns the v84 copy) can overlay only
 * `createClaimMemorySchema`.
 */
export declare function createClaimProjectGenerationsSchema(db: Database): void;
/** All claim-memory objects except `claim_project_generations`. */
export declare function createClaimMemorySchema(db: Database): void;
/** Full claim-memory component creation (registered-component `create`). */
export declare function createClaimMemoryComponentSchema(db: Database): void;
//# sourceMappingURL=storage-claim-memory-schema.d.ts.map