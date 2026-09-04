/**
 * SQLite chokepoint — runtime-detected backend selection.
 *
 * The same shipped plugin artifact must run under two different runtimes:
 *   - Bun (current OpenCode releases) → uses `bun:sqlite` (built-in, fast)
 *   - Node / Electron (Pi plugin, OpenCode Desktop) → uses `node:sqlite`
 *     (`DatabaseSync`, built into Node 22.5+ / Electron 41+, stable-enough and
 *     flag-free since Node 22.13/23.4).
 *
 * Bun has no `node:sqlite`, and Node/Electron have no `bun:sqlite`. Static
 * imports of either would crash at parse time in the wrong runtime, so we use
 * dynamic imports gated by runtime detection.
 *
 * Why `node:sqlite` instead of `better-sqlite3`: better-sqlite3 is a native
 * module requiring per-ABI prebuilds, and Electron's ABI never matches the npm
 * Node prebuild — which forced a runtime download of an Electron-matched
 * `.node` binary (a supply-chain + maintenance liability). `node:sqlite` is
 * built into the runtime, so there is NOTHING to download or rebuild. Both Pi
 * (plain Node 24) and OpenCode Desktop (Electron 41 → Node 24.14.1) ship it.
 *
 * API surface we use (common across both backends, modulo the shims below):
 *   - new Database(path, { readonly?: boolean })   ← we map readonly→readOnly
 *   - db.prepare(sql).run/get/all
 *   - db.exec(multistatement)
 *   - db.transaction(fn) → wrapped function        ← shimmed for node:sqlite
 *   - db.close()
 *
 * The three backend differences we bridge for node:sqlite:
 *   1. node:sqlite has no `db.transaction(fn)` helper — we add a savepoint-aware
 *      shim (below) that matches better-sqlite3/bun semantics.
 *   2. node:sqlite's constructor option is `readOnly` (camel-case), not
 *      better-sqlite3/bun's `readonly` — we translate it so call sites are
 *      unchanged.
 *   3. node:sqlite reads a lone array bind arg (`.run([a,b])`) as NAMED params
 *      and throws `Unknown named parameter '0'`; bun binds it positionally. We
 *      normalize it in the `prepare()` override (below) so the bind surface is
 *      identical (issue #151 / Pi /ctx-dream).
 * Everything else (named params with bare keys, ATTACH under defensive mode,
 * `run()` → {changes,lastInsertRowid}) is identical and was verified directly.
 */
import type BetterSqlite3 from "better-sqlite3";
export type SqliteRuntime = "Bun" | "Node.js";
type SqliteModule = {
    Database?: unknown;
    DatabaseSync?: unknown;
};
export declare function detectSqliteRuntime(): SqliteRuntime;
export declare class SqliteRuntimeUnavailableError extends Error {
    readonly runtime: SqliteRuntime;
    readonly specifier: string;
    constructor(runtime: SqliteRuntime, specifier: string, cause: unknown);
}
export declare function loadSqliteModule(runtime?: SqliteRuntime, importer?: (specifier: string) => Promise<SqliteModule>): Promise<SqliteModule>;
export declare const Database: typeof BetterSqlite3;
/** Instance type alias used by helpers and storage modules. */
export type Database = BetterSqlite3.Database;
/**
 * Statement instance type used for WeakMap caches throughout the codebase.
 *
 * We deliberately use the variadic Statement<unknown[], unknown> shape rather
 * than `ReturnType<Database["prepare"]>` because the latter resolves through
 * a conditional return type in @types/better-sqlite3 that confuses TypeScript
 * about how many arguments .run/.get/.all accept. With this explicit type,
 * cached statements accept any number of bind args (matching bun:sqlite's
 * historical behavior in this codebase).
 */
export type Statement = BetterSqlite3.Statement<unknown[], unknown>;
/**
 * True while the connection holds an open transaction. bun:sqlite and
 * better-sqlite3 expose `inTransaction`; node:sqlite exposes `isTransaction`.
 */
export declare function isInTransaction(db: Database): boolean;
/**
 * Run a storage operation with the managed-write privilege enabled.
 *
 * The privilege is recorded in the durable `context_privilege_state` table (row
 * id=1, enabled=1) so the guard triggers — which reference that table, never a
 * connection-local UDF — stand down for this connection's writes. The write happens
 * inside a BEGIN IMMEDIATE transaction (single writer), and enabled is cleared back
 * to 0 before commit, so no second connection can ever observe enabled=1. Nesting is
 * tracked by privilegeDepth (outside SQLite): only the outermost scope clears the
 * flag, so an inner scope releasing does not drop permission out from under its caller.
 */
export declare function withPrivilegedWriter<T>(db: Database, operation: () => T): T;
/**
 * Minimum SQLite release whose WAL machinery carries the wal-reset fix
 * (https://www.sqlite.org/wal.html#walresetbug, fixed in 3.47.1). Writers on
 * an older source may corrupt a shared WAL family and must not open it.
 */
export declare const SQLITE_WAL_RESET_SAFE_MIN_VERSION = "3.47.1";
/** Node floor whose node:sqlite ships a WAL-reset-safe SQLite (KTD2). */
export declare const MIN_SUPPORTED_NODE_VERSION = "24.15.0";
/** Bun floor whose bun:sqlite ships a WAL-reset-safe SQLite (KTD2). */
export declare const MIN_SUPPORTED_BUN_VERSION = "1.3.14";
export interface SqliteEngineIdentity {
    readonly sqliteVersion: string;
    readonly sqliteSourceId: string;
}
/** Read `sqlite_version()` / `sqlite_source_id()` from an open connection. */
export declare function readSqliteEngineIdentity(db: Database): SqliteEngineIdentity;
/**
 * Probe the runtime's SQLite engine off-path: a throwaway in-memory
 * connection, never the real database file, so an unsafe engine is detected
 * before it can touch a shared WAL family.
 */
export declare function probeSqliteEngineIdentityOffPath(): SqliteEngineIdentity;
export declare function isVersionAtLeast(candidate: string, floor: string): boolean;
export interface SqliteRuntimeGateInput extends SqliteEngineIdentity {
    readonly runtime: SqliteRuntime;
    /** `process.versions.bun` or `process.versions.node`. */
    readonly runtimeVersion: string;
}
export interface SqliteRuntimeGateResult {
    readonly ok: boolean;
    readonly reasons: readonly string[];
}
/**
 * Pure WAL-reset-safety gate (KTD2). The engine identity is authoritative:
 * a wrapper or runtime version alone never passes, and an unknown
 * `sqlite_source_id()` fails closed because the source cannot be proven safe.
 */
export declare function evaluateSqliteRuntimeGate(input: SqliteRuntimeGateInput): SqliteRuntimeGateResult;
/** Gather the live gate input for the current runtime (off-path probe). */
export declare function collectSqliteRuntimeGateInput(): SqliteRuntimeGateInput;
export interface SqliteConnectionContractExpectations {
    /** Require `journal_mode=wal`; false for in-memory or non-WAL scratch databases. */
    readonly expectWal: boolean;
    readonly minBusyTimeoutMs?: number;
    /** Allowed `PRAGMA synchronous` levels; OFF (0) is never acceptable for writers. */
    readonly allowedSynchronous?: readonly number[];
}
/**
 * Verify the per-connection contract (R17) after PRAGMAs are applied and
 * before application writes: foreign keys enforced, WAL actually activated,
 * a busy timeout installed, and a declared synchronous mode. Returns every
 * violation; callers fail closed on a nonempty list.
 */
export declare function verifySqliteConnectionContract(db: Database, expectations: SqliteConnectionContractExpectations): string[];
export {};
//# sourceMappingURL=sqlite.d.ts.map