/**
 * v82 authoritative claims-and-evidence DDL (KTD31, KTD33-KTD36).
 *
 * Dependency-light on purpose: this module may only use type-only imports so
 * the Node SQLite smoke (`packages/plugin/scripts/smoke-node-sqlite.ts`) can
 * import it directly under Node's type-stripping loader, which cannot resolve
 * extensionless runtime imports.
 *
 * Every object here is migration-owned (created by migration v82, never by
 * `initializeDatabase()`), following the v80 `memory_stats` precedent.
 *
 * Append-only contract (KTD34): episodes, source_spans, observations,
 * claim_revisions, claim_evidence, claim_conflicts, and verification_events
 * reject every UPDATE and DELETE, plus any INSERT that collides with a primary
 * or unique key — so `INSERT OR REPLACE` cannot bypass the delete guard when
 * recursive triggers are disabled. `claims` stays mutable for lifecycle state
 * and the current-revision pointer, but its semantic key columns are frozen and
 * a published pointer can never return to NULL.
 */
import type { Database } from "../../shared/sqlite";
export declare const CLAIMS_AND_EVIDENCE_TABLES: readonly ["projects", "project_aliases", "episodes", "source_spans", "observations", "claims", "claim_revisions", "claim_evidence", "claim_conflicts", "verification_events"];
/** Tables whose rows are immutable at the database boundary (KTD34). */
export declare const APPEND_ONLY_CLAIMS_TABLES: readonly ["episodes", "source_spans", "observations", "claim_revisions", "claim_evidence", "claim_conflicts", "verification_events"];
/** Full v82 object graph: tables from the dependency roots outward, then indexes and guards. */
export declare function createClaimsAndEvidenceSchema(db: Database): void;
/**
 * Targeted per-new-table foreign-key validation. Full `PRAGMA integrity_check`
 * is reserved for tests so unrelated legacy corruption cannot turn this
 * migration into a whole-database repair gate (U1 approach step 6).
 */
export declare function assertClaimsSchemaForeignKeys(db: Database): void;
//# sourceMappingURL=storage-claims-schema.d.ts.map