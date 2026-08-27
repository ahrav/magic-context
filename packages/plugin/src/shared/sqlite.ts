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

// Type import only — runtime is loaded dynamically below. @types/better-sqlite3
// has the richest definitions and is a structural superset of the API surface
// we use, so calls typed against BetterSqlite3 work under bun:sqlite and
// node:sqlite at runtime (both expose prepare/run/get/all/exec/close).
import type BetterSqlite3 from "better-sqlite3";

export type SqliteRuntime = "Bun" | "Node.js";

type SqliteModule = {
    Database?: unknown;
    DatabaseSync?: unknown;
};

export function detectSqliteRuntime(): SqliteRuntime {
    // process.versions.bun is the least ambiguous marker, but some launchers
    // proxy or partially sandbox process. Keep globalThis.Bun as a fallback so
    // a Bun process does not accidentally select node:sqlite just because its
    // process compatibility surface was trimmed.
    const hasBunVersion =
        typeof process !== "undefined" && typeof process.versions?.bun === "string";
    const hasBunGlobal =
        typeof globalThis !== "undefined" &&
        typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    return hasBunVersion || hasBunGlobal ? "Bun" : "Node.js";
}

// IMPORTANT: bundler-evading dynamic imports.
//
// We can't write `await import("node:sqlite")` directly because esbuild/bun
// would try to resolve both modules at build time, and one of them won't exist
// in the build runtime (bun:sqlite is missing in Node, node:sqlite is missing
// in Bun). Earlier versions used `new Function("p", "return import(p)")(...)`
// to defeat static analysis, but that breaks Pi's vm-based extension loader: a
// Function constructed at runtime has no module record, so `import()` inside it
// has no referrer module and Node throws "A dynamic import callback was not
// specified".
//
// The /* @vite-ignore */ + variable indirection pattern hides the specifier
// from static analyzers while keeping a real referrer module for the
// dynamic import — Pi's loader, esbuild, and bun build all accept it.
const bunSpec = "bun:" + "sqlite";
const nodeSpec = "node:" + "sqlite";

async function importSqliteModule(specifier: string): Promise<SqliteModule> {
    // The runtime chooses this specifier; Vite must not resolve it as a
    // build-time dependency because the other runtime's backend is absent.
    return (await import(
        /* @vite-ignore -- keep the runtime-selected backend unresolved */ specifier
    )) as SqliteModule;
}

function isModuleNotFoundError(error: unknown, specifier: string): boolean {
    const candidate = error as { code?: unknown; name?: unknown } | null;
    const code = typeof candidate?.code === "string" ? candidate.code : "";
    const name = typeof candidate?.name === "string" ? candidate.name : "";
    const message = error instanceof Error ? error.message : String(error ?? "");
    const details = `${code} ${name} ${message}`.toLowerCase();
    const mentionsSpecifier = details.includes(specifier.toLowerCase());
    if (!mentionsSpecifier) return false;

    return (
        code === "ERR_MODULE_NOT_FOUND" ||
        code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
        code === "MODULE_NOT_FOUND" ||
        name === "ResolveMessage" ||
        details.includes("module not found") ||
        details.includes("cannot find module") ||
        details.includes("cannot find package") ||
        details.includes("no such built-in module")
    );
}

export class SqliteRuntimeUnavailableError extends Error {
    readonly runtime: SqliteRuntime;
    readonly specifier: string;

    constructor(runtime: SqliteRuntime, specifier: string, cause: unknown) {
        const requirement =
            specifier === nodeSpec
                ? "Requires Node.js >= 24, or Bun with bun:sqlite — this Bun build lacks node:sqlite."
                : "Requires Bun with bun:sqlite, or Node.js >= 24 — this Bun build lacks bun:sqlite.";
        super(
            `Magic Context detected ${runtime}, but could not load ${specifier}. ${requirement}`,
            { cause },
        );
        this.name = "SqliteRuntimeUnavailableError";
        this.runtime = runtime;
        this.specifier = specifier;
    }
}

export async function loadSqliteModule(
    runtime: SqliteRuntime = detectSqliteRuntime(),
    importer: (specifier: string) => Promise<SqliteModule> = importSqliteModule,
): Promise<SqliteModule> {
    const specifier = runtime === "Bun" ? bunSpec : nodeSpec;
    try {
        return await importer(specifier);
    } catch (error) {
        if (isModuleNotFoundError(error, specifier)) {
            throw new SqliteRuntimeUnavailableError(runtime, specifier, error);
        }
        throw error;
    }
}

const detectedRuntime = detectSqliteRuntime();
const isBun = detectedRuntime === "Bun";
const sqliteModule = await loadSqliteModule(detectedRuntime);

// Different export shapes between the two backends:
//   - bun:sqlite  → named export `Database` (has its own .transaction, accepts
//     `{ readonly }`) — usable as-is.
//   - node:sqlite → named export `DatabaseSync` (no .transaction, option is
//     `readOnly`) — wrapped below.
const DatabaseImpl: typeof BetterSqlite3 = isBun
    ? (sqliteModule.Database as typeof BetterSqlite3)
    : buildNodeSqliteDatabaseClass(sqliteModule.DatabaseSync);

/**
 * Wrap node:sqlite's `DatabaseSync` so it presents the better-sqlite3/bun
 * surface the rest of the codebase calls:
 *   - translate the `{ readonly }` constructor option → node:sqlite's `readOnly`
 *   - add a `transaction(fn)` helper that matches better-sqlite3 semantics,
 *     using `db.isTransaction` to pick BEGIN (top-level) vs SAVEPOINT (nested),
 *     so it composes correctly with manual `BEGIN IMMEDIATE` blocks too.
 */
// biome-ignore lint/suspicious/noExplicitAny: node:sqlite has no shipped types here; the public export is cast to the better-sqlite3 shape.
function buildNodeSqliteDatabaseClass(DatabaseSync: any): typeof BetterSqlite3 {
    // Single constant savepoint name is correct for arbitrary nesting depth:
    // SQLite savepoints with the same name stack LIFO — RELEASE / ROLLBACK TO
    // always target the most recent. node:sqlite is synchronous + single-process
    // per connection, so there is no concurrent-savepoint hazard.
    const SAVEPOINT = "mc_tx_sp";

    class NodeSqliteDatabase extends DatabaseSync {
        constructor(filename?: string | Buffer, options?: BetterSqlite3.Options) {
            const translated: Record<string, unknown> = { ...options };
            if (options && "readonly" in options) {
                translated.readOnly = (options as { readonly?: boolean }).readonly;
                delete translated.readonly;
            }
            super(typeof filename === "string" ? filename : ":memory:", translated);
        }

        // Normalize a single ARRAY bind arg to spread positional, matching
        // bun:sqlite. bun's `.run([a,b])` binds positionally; node:sqlite instead
        // reads a lone array as NAMED params with keys "0","1" and throws
        // `Unknown named parameter '0'`. That divergence let an array-form bind
        // (e.g. `.run([x, y])`) silently work on OpenCode/Bun yet break Pi and
        // OpenCode Desktop (both node:sqlite) — issue #151 (/ctx-dream). Wrapping
        // every prepared statement here keeps the two backends' bind surface
        // truly identical so this whole class is impossible regardless of how a
        // call site writes its bind. Named-object binds (`.run({k:v})`), no-arg
        // calls, and already-spread positional args are passed through unchanged;
        // the normalization only triggers on the exact 1-array shape. Overhead
        // measured at ~12ns/call against real node:sqlite (negligible).
        // biome-ignore lint/suspicious/noExplicitAny: node:sqlite StatementSync has no shipped types here.
        prepare(sql: string): any {
            const stmt = super.prepare(sql);
            for (const method of ["run", "get", "all"] as const) {
                const original = stmt[method].bind(stmt);
                stmt[method] = (...args: unknown[]): ReturnType<typeof original> =>
                    args.length === 1 && Array.isArray(args[0])
                        ? original(...args[0])
                        : original(...args);
            }
            return stmt;
        }

        // biome-ignore lint/suspicious/noExplicitAny: mirrors better-sqlite3's generic transaction(fn) signature.
        transaction<F extends (...args: any[]) => any>(fn: F): F {
            // biome-ignore lint/suspicious/noExplicitAny: faithful pass-through of this/args to fn.
            const self = this as any;
            const execute = (
                mode: "" | "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE",
                receiver: ThisParameterType<F>,
                args: Parameters<F>,
            ): ReturnType<F> => {
                const nested = self.isTransaction === true;
                self.exec(nested ? `SAVEPOINT ${SAVEPOINT}` : `BEGIN${mode ? ` ${mode}` : ""}`);
                try {
                    // SAFETY: Parameters<F> and ThisParameterType<F> preserve fn's call contract.
                    const result = fn.apply(receiver, args) as ReturnType<F>;
                    self.exec(nested ? `RELEASE ${SAVEPOINT}` : "COMMIT");
                    return result;
                } catch (error) {
                    // RAISE(ROLLBACK) can end the transaction before control
                    // returns here. Cleanup errors must not replace `error`.
                    if (self.isTransaction === true) {
                        if (nested) {
                            try {
                                self.exec("ROLLBACK TO mc_tx_sp");
                                if (self.isTransaction === true) self.exec("RELEASE mc_tx_sp");
                            } catch {
                                // Rollback failures must not replace the callback exception.
                            }
                        } else {
                            try {
                                self.exec("ROLLBACK");
                            } catch {
                                // Rollback failures must not replace the callback exception.
                            }
                        }
                    }
                    throw error;
                }
            };
            const wrapped = function (
                this: ThisParameterType<F>,
                ...args: Parameters<F>
            ): ReturnType<F> {
                return execute("", this, args);
            };
            wrapped.default = function (
                this: ThisParameterType<F>,
                ...args: Parameters<F>
            ): ReturnType<F> {
                return execute("", this, args);
            };
            wrapped.deferred = function (
                this: ThisParameterType<F>,
                ...args: Parameters<F>
            ): ReturnType<F> {
                return execute("DEFERRED", this, args);
            };
            wrapped.immediate = function (
                this: ThisParameterType<F>,
                ...args: Parameters<F>
            ): ReturnType<F> {
                return execute("IMMEDIATE", this, args);
            };
            wrapped.exclusive = function (
                this: ThisParameterType<F>,
                ...args: Parameters<F>
            ): ReturnType<F> {
                return execute("EXCLUSIVE", this, args);
            };
            // SAFETY: attached mode methods match better-sqlite3's transaction wrapper contract.
            return wrapped as unknown as F;
        }
    }

    // SAFETY: NodeSqliteDatabase implements the BetterSqlite3 constructor surface used here.
    return NodeSqliteDatabase as unknown as typeof BetterSqlite3;
}

export const Database: typeof BetterSqlite3 = DatabaseImpl;

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

const privilegeDepth = new WeakMap<Database, number>();

/**
 * True while the connection holds an open transaction. bun:sqlite and
 * better-sqlite3 expose `inTransaction`; node:sqlite exposes `isTransaction`.
 */
export function isInTransaction(db: Database): boolean {
    // SAFETY: this assertion permits probing transaction-state properties absent from Database.
    const candidate = db as unknown as { inTransaction?: unknown; isTransaction?: unknown };
    return candidate.inTransaction === true || candidate.isTransaction === true;
}

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
export function withPrivilegedWriter<T>(db: Database, operation: () => T): T {
    const previousDepth = privilegeDepth.get(db) ?? 0;
    const nested = isInTransaction(db);
    const savepoint = "mc_privilege_scope";
    if (nested) {
        db.exec(`SAVEPOINT ${savepoint}`);
    } else {
        db.exec("BEGIN IMMEDIATE");
    }
    privilegeDepth.set(db, previousDepth + 1);
    try {
        db.prepare(
            "INSERT INTO context_privilege_state(id, enabled) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET enabled = 1",
        ).run();
        const result = operation();
        if (previousDepth === 0) {
            db.prepare("UPDATE context_privilege_state SET enabled = 0 WHERE id = 1").run();
        }
        if (nested) {
            db.exec(`RELEASE ${savepoint}`);
        } else {
            db.exec("COMMIT");
        }
        if (previousDepth > 0) privilegeDepth.set(db, previousDepth);
        else privilegeDepth.delete(db);
        return result;
    } catch (error) {
        try {
            if (nested) {
                db.exec(`ROLLBACK TO ${savepoint}`);
                db.exec(`RELEASE ${savepoint}`);
            } else {
                db.exec("ROLLBACK");
            }
        } finally {
            if (previousDepth > 0) privilegeDepth.set(db, previousDepth);
            else privilegeDepth.delete(db);
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// U1 direct-cutover groundwork (KTD2, R17): off-path SQLite source probe and
// connection-contract verification. Pure helpers plus one off-path opener —
// nothing here is wired into the production open path yet (U8 activates it).
// ---------------------------------------------------------------------------

/**
 * Minimum SQLite release whose WAL machinery carries the wal-reset fix
 * (https://www.sqlite.org/wal.html#walresetbug, fixed in 3.47.1). Writers on
 * an older source may corrupt a shared WAL family and must not open it.
 */
export const SQLITE_WAL_RESET_SAFE_MIN_VERSION = "3.47.1";

/** Node floor whose node:sqlite ships a WAL-reset-safe SQLite (KTD2). */
export const MIN_SUPPORTED_NODE_VERSION = "24.15.0";

/** Bun floor whose bun:sqlite ships a WAL-reset-safe SQLite (KTD2). */
export const MIN_SUPPORTED_BUN_VERSION = "1.3.14";

/** `sqlite_source_id()` shape: `YYYY-MM-DD HH:MM:SS <commit hash>`. */
const SQLITE_SOURCE_ID_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [0-9a-f]{40,64}$/;

export interface SqliteEngineIdentity {
    readonly sqliteVersion: string;
    readonly sqliteSourceId: string;
}

/** Read `sqlite_version()` / `sqlite_source_id()` from an open connection. */
export function readSqliteEngineIdentity(db: Database): SqliteEngineIdentity {
    const row = db
        .prepare("SELECT sqlite_version() AS version, sqlite_source_id() AS source_id")
        .get() as { version: string; source_id: string };
    return { sqliteVersion: String(row.version), sqliteSourceId: String(row.source_id) };
}

/**
 * Probe the runtime's SQLite engine off-path: a throwaway in-memory
 * connection, never the real database file, so an unsafe engine is detected
 * before it can touch a shared WAL family.
 */
export function probeSqliteEngineIdentityOffPath(): SqliteEngineIdentity {
    const probe = new Database(":memory:");
    try {
        return readSqliteEngineIdentity(probe);
    } finally {
        probe.close();
    }
}

/** Parse a dotted version into numeric parts; null when not parseable. */
function parseDottedVersion(version: string): number[] | null {
    const match = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function isVersionAtLeast(candidate: string, floor: string): boolean {
    const left = parseDottedVersion(candidate);
    const right = parseDottedVersion(floor);
    if (!left || !right) return false;
    for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index]) return left[index] > right[index];
    }
    return true;
}

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
export function evaluateSqliteRuntimeGate(input: SqliteRuntimeGateInput): SqliteRuntimeGateResult {
    const reasons: string[] = [];
    const runtimeFloor =
        input.runtime === "Bun" ? MIN_SUPPORTED_BUN_VERSION : MIN_SUPPORTED_NODE_VERSION;
    if (!isVersionAtLeast(input.runtimeVersion, runtimeFloor)) {
        reasons.push(
            `${input.runtime} ${input.runtimeVersion} is below the supported floor ${runtimeFloor}`,
        );
    }
    if (!isVersionAtLeast(input.sqliteVersion, SQLITE_WAL_RESET_SAFE_MIN_VERSION)) {
        reasons.push(
            `SQLite ${input.sqliteVersion} predates the WAL-reset fix in ${SQLITE_WAL_RESET_SAFE_MIN_VERSION}`,
        );
    }
    if (!SQLITE_SOURCE_ID_PATTERN.test(input.sqliteSourceId)) {
        reasons.push(
            `sqlite_source_id() '${input.sqliteSourceId}' is not a recognized SQLite source identity`,
        );
    }
    return { ok: reasons.length === 0, reasons };
}

/** Gather the live gate input for the current runtime (off-path probe). */
export function collectSqliteRuntimeGateInput(): SqliteRuntimeGateInput {
    const runtime = detectSqliteRuntime();
    const runtimeVersion =
        runtime === "Bun" ? (process.versions.bun ?? "0.0.0") : (process.versions.node ?? "0.0.0");
    return { runtime, runtimeVersion, ...probeSqliteEngineIdentityOffPath() };
}

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
export function verifySqliteConnectionContract(
    db: Database,
    expectations: SqliteConnectionContractExpectations,
): string[] {
    const violations: string[] = [];
    const foreignKeys = Number(
        (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
    );
    if (foreignKeys !== 1) violations.push("foreign_keys is disabled");
    const journalMode = String(
        (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toLowerCase();
    if (expectations.expectWal && journalMode !== "wal") {
        violations.push(`journal_mode is '${journalMode}', expected 'wal'`);
    }
    const busyTimeoutMs = Number(
        (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
    );
    const minBusyTimeoutMs = expectations.minBusyTimeoutMs ?? 1;
    if (!Number.isFinite(busyTimeoutMs) || busyTimeoutMs < minBusyTimeoutMs) {
        violations.push(
            `busy_timeout ${busyTimeoutMs}ms is below the required ${minBusyTimeoutMs}ms`,
        );
    }
    const synchronous = Number(
        (db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous,
    );
    // 1=NORMAL, 2=FULL, 3=EXTRA; 0=OFF forfeits WAL durability guarantees.
    const allowedSynchronous = expectations.allowedSynchronous ?? [1, 2, 3];
    if (!allowedSynchronous.includes(synchronous)) {
        violations.push(
            `synchronous mode ${synchronous} is not in the declared set [${allowedSynchronous.join(", ")}]`,
        );
    }
    return violations;
}
