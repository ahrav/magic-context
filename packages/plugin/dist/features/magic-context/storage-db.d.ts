import { chmodSync, type Dirent, mkdirSync } from "node:fs";
import { Database, type SqliteConnectionContractExpectations, type SqliteRuntimeGateInput } from "../../shared/sqlite";
import type { FailClosedBlockingProcess } from "./fail-closed-block";
import { FORK_MIGRATION_VERSION_FLOOR } from "./migrations";
import { ensureColumn } from "./storage-schema-helpers";
export { ensureColumn, FORK_MIGRATION_VERSION_FLOOR };
export declare function consumeLastRuntimeGateRefusal(): SqliteRuntimeGateReport | null;
export interface DatabaseFormatRefusal {
    family: string;
    reasons: readonly string[];
}
export declare function getSchemaFenceRejection(): {
    persistedVersion: number;
    supportedVersion: number;
} | null;
export declare function getFormatRefusal(): DatabaseFormatRefusal | null;
export declare function __resetSchemaFenceStateForTests(): void;
export declare const LATEST_SUPPORTED_VERSION: number;
declare const defaultStoragePermissionFs: {
    chmodSync: typeof chmodSync;
    mkdirSync: typeof mkdirSync;
};
/** Test seam: captures permission-changing calls without changing real fixture modes. */
export declare function __setStoragePermissionFsForTests(overrides: Partial<typeof defaultStoragePermissionFs>): void;
export declare function __resetStoragePermissionFsForTests(): void;
export interface OpenDatabaseOptions {
    dbPath?: string;
    latestSupportedVersion?: number;
}
export declare function resolveDatabasePath(dbPathOverride?: string): {
    dbDir: string;
    dbPath: string;
};
export declare function getDatabasePath(db: Database): string | null;
export declare function getPersistedSchemaVersion(db: Database): number;
export declare function schemaVersionIsSupported(db: Database, latestSupportedVersion?: number): boolean;
/** Log the upstream-lane version so operators can compare it to this build's fence. */
export declare function formatSchemaFenceBootLog(persistedVersion: number, supportedVersion: number): string;
export type RpcDiscoveryUnreadableArm = "parse" | "io";
export interface RpcServerDiscovery {
    state: "absent" | "stale" | "live" | "unreadable" | "inconclusive";
    serverPids: number[];
    /** Per-PID labels captured while the discovery record was validated. */
    serverProcesses?: FailClosedBlockingProcess[];
    staleFiles: string[];
    /**
     * PIDs for which the process-existence or process-identity check could not
     * run. That failure does not prove that the process is actively using RPC.
     */
    inconclusivePids?: number[];
    unreadableFile?: string;
    unreadableArm?: RpcDiscoveryUnreadableArm;
}
export interface RpcDiscoveryFs {
    readdirSync(path: string, options?: {
        withFileTypes?: boolean;
    }): string[] | Dirent[];
    readFileSync(path: string, encoding: "utf8"): string;
    statSync(path: string): {
        mtimeMs: number;
    };
    unlinkSync(path: string): void;
}
/**
 * Inspect the shared RPC discovery tree without treating partial evidence as
 * proof that no server is running. A missing/empty tree is a clean machine;
 * dead-PID and old malformed files are removed; fresh malformed or unreadable
 * evidence is fail-closed because it could be a concurrent write or an I/O
 * permission problem.
 */
export declare function inspectRpcServerDiscovery(storageDir: string): RpcServerDiscovery;
export declare function setSqlitePragmaConfig(config: {
    cacheSizeMb: number;
    mmapSizeMb: number;
}): void;
/**
 * Apply the tunable per-connection PRAGMAs (cache_size, mmap_size,
 * analysis_limit) from the current `sqlitePragmaConfig`. Idempotent and safe on
 * an already-open connection — cache_size/mmap_size take effect immediately —
 * so harnesses that open the DB before loading config (Pi) can call this once
 * config is available without reopening.
 */
export declare function applySqliteTuningPragmas(db: Database): void;
/**
 * Run SQLite's self-gating planner-stats refresh. `analysis_limit=400` caps the
 * rows sampled per index so even a huge table can't cause a multi-second
 * ANALYZE; `optimize` then re-analyzes only tables whose row counts drifted
 * since the last ANALYZE (a no-op otherwise). Cheap to call periodically.
 */
export declare function runSqliteOptimize(db: Database): void;
export interface SqliteRuntimeGateReport {
    readonly input: SqliteRuntimeGateInput;
    readonly ok: boolean;
    readonly reasons: readonly string[];
}
export declare function probeSqliteRuntimeGate(): SqliteRuntimeGateReport;
export declare function assertSqliteConnectionContract(db: Database, expectations: SqliteConnectionContractExpectations): void;
/**
 * Open the persistent Magic Context SQLite database.
 *
 * Fails closed: if the database cannot be opened, it returns a recorded
 * refusal or throws a fatal open error.
 * Magic Context CANNOT silently fall back to an in-memory database, because:
 *   1. An in-memory DB has no project memories, no historian state, no
 *      tag persistence — features that depend on durable storage become
 *      silently broken instead of explicitly disabled.
 *   2. More importantly, an in-memory DB across process restarts effectively
 *      means "no Magic Context", but the plugin still tags messages and
 *      tries to drive transforms. On Pi/OpenCode this can let the full
 *      raw history reach the model and overflow the context window — the
 *      exact failure mode that broke a real test session.
 *
 * Three failure modes, all fail-closed:
 *   - **Runtime refusal** (the SQLite source cannot safely reset WAL): returns
 *     `null` before constructing a connection and records the gate report.
 *   - **Format refusal** (the on-disk family is neither the exact current
 *     direct format nor truly pristine, or it carries a newer format fence
 *     than this binary supports): returns `null` with the detail recorded in
 *     the refusal latches. Recovery is an explicit operator reset
 *     (`doctor reset-db`) or a binary update — never an in-place migration.
 *   - **Fatal open error** (ABI mismatch, unwritable path, corrupt file):
 *     throws. The thrown message carries the failure detail for surfacing.
 *
 * The return type is therefore `Database | null`, and callers MUST both
 * null-check the result AND be prepared for a throw (typically a try/catch that
 * also treats a null result as "storage unavailable"). On either outcome the
 * caller disables Magic Context for that run (server plugin: registers a
 * startup warning + skips the runtime; Pi plugin: logs warning + skips the
 * extension). There is NEVER a silent in-memory fallback.
 */
export declare function openDatabase(): Database | null;
export declare function openDatabase(dbPath: string): Database | null;
export declare function openDatabase(options: OpenDatabaseOptions): Database | null;
/**
 * Async boot variant of openDatabase. SQLite calls remain synchronous
 * (bootstrap contention resolves under the connection busy timeout), but
 * concurrent async openers of the same path share one in-flight open.
 */
export declare function openDatabaseAsync(dbPathOrOptions?: string | OpenDatabaseOptions): Promise<Database | null>;
export declare function isDatabasePersisted(db: Database | null): boolean;
export declare function getDatabasePersistenceError(db: Database | null): string | null;
export declare function closeDatabase(): void;
export type ContextDatabase = Database;
//# sourceMappingURL=storage-db.d.ts.map