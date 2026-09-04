/**
 * U8 direct-cutover activation (KTD1): the session-runtime schema component.
 *
 * This is the exact final shape of every non-claim harness table the plugin
 * uses (tags, compartments, session metadata, notes, primers, historian and
 * dreamer state, module authority/mirror bookkeeping, workspaces, identity
 * bookkeeping, and the direct-format migration fence). It was captured from
 * the last legacy bootstrap (initializeDatabase + migration chain head v89)
 * and is now the only way these objects are created: there is no legacy
 * migration chain and no v87+ data migration. Schema changes bump the
 * component manifest digest, which changes the direct-format identity.
 *
 * The retired memory-era objects and compatibility crosswalks are
 * deliberately absent: project memory lives in the registered claim
 * components (R18).
 *
 * Dependency-light on purpose: runtime imports use explicit `.ts` extensions
 * so the Node smoke scripts can load this module under Node's type-stripping
 * loader.
 */
import type { Database } from "../../shared/sqlite";
/**
 * Every table this component owns, including FTS5 shadow tables (they are
 * real tables in `sqlite_schema`, so the composition validator and the
 * format classifier must account for them).
 */
export declare const SESSION_RUNTIME_TABLES: readonly string[];
/**
 * Stamp the post-legacy migration fence (R21). A pre-cutover binary reads
 * `MAX(version) FROM schema_migrations WHERE version < 10000` and refuses to
 * open any database whose lane is newer than its own fence, so this single
 * row makes every legacy build fail closed against a direct-format database
 * without mutating it.
 */
export declare function stampDirectFormatFence(db: Database, nowMs?: number): void;
/** Create every session-runtime object and stamp the legacy-lane fence row. */
export declare function createSessionRuntimeSchema(db: Database): void;
//# sourceMappingURL=storage-session-runtime-schema.d.ts.map