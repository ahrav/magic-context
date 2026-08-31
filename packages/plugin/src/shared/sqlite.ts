/**
 *
 * The same shipped plugin artifact must run under two different runtimes:
 * Bun uses the built-in `bun:sqlite` backend.
 *   - Node / Electron (Pi plugin, OpenCode Desktop) → uses `node:sqlite`
 * `DatabaseSync` is built into Node 22.5+ and Electron 41+.
 * `node:sqlite` is flag-free in Node 22.13+ and 23.4+.
 *
 * Bun lacks `node:sqlite`, and Node/Electron lack `bun:sqlite`; static imports would fail in the wrong runtime, so runtime detection gates dynamic imports.
 *
 * `better-sqlite3` requires an Electron ABI-matched native binary; `node:sqlite` is built into the runtime.
 * Built-in `node:sqlite` requires no downloaded or rebuilt native binary.
 * Pi runs Node 24, and OpenCode Desktop runs Electron 41 with Node 24.14.1.
 *
 * `readonly` maps to `node:sqlite`'s `readOnly` option.
 *   - db.prepare(sql).run/get/all
 *   - db.exec(multistatement)
 *   - db.close()
 *
 * `node:sqlite` lacks `db.transaction(fn)`, so the adapter adds a savepoint-aware shim matching better-sqlite3 and Bun semantics.
 *      unchanged.
 * `node:sqlite` treats a lone array bind argument such as `.run([a, b])` as named parameters and rejects it; the `prepare()` override converts it to positional binding to match Bun.
 * Both backends support bare-key named parameters, `ATTACH` under defensive mode, and `run()` results of `{changes,lastInsertRowid}`.
 */

// `@types/better-sqlite3` structurally covers the API used by both runtime backends.
import type BetterSqlite3 from "better-sqlite3";

export type SqliteRuntime = "Bun" | "Node.js";

type SqliteModule = {
    Database?: unknown;
    DatabaseSync?: unknown;
};

export function detectSqliteRuntime(): SqliteRuntime {
    // Some launchers
    // Some launchers proxy or sandbox `process`; `globalThis.Bun` prevents Bun from selecting `node:sqlite` when `process.versions.bun` is unavailable.
    const hasBunVersion =
        typeof process !== "undefined" && typeof process.versions?.bun === "string";
    const hasBunGlobal =
        typeof globalThis !== "undefined" &&
        typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    return hasBunVersion || hasBunGlobal ? "Bun" : "Node.js";
}

//
// Static imports would make esbuild and Bun resolve both backends at build time.
// The build runtime lacks one backend: Node lacks `bun:sqlite`, and Bun lacks `node:sqlite`.
// `new Function("p", "return import(p)")(...)` breaks Pi's vm-based extension loader:
// A runtime-constructed `Function` has no module record, so its `import()` has no referrer module.
// Without a referrer module, Node throws "A dynamic import callback was not specified".
// specified".
//
// Concatenated specifiers hide the backend names from static analyzers while preserving a referrer module for `import()`.
const bunSpec = "bun:" + "sqlite";
const nodeSpec = "node:" + "sqlite";

async function importSqliteModule(specifier: string): Promise<SqliteModule> {
    // Vite must not resolve the runtime-selected specifier as a build-time dependency.
    return (await import(
        /* `@vite-ignore` keeps the runtime-selected backend unresolved. */ specifier
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

// `bun:sqlite` exports `Database`, accepts `{ readonly }`, and provides `transaction`.
// `node:sqlite` exports `DatabaseSync`, which lacks `transaction` and uses `readOnly`.
const DatabaseImpl: typeof BetterSqlite3 = isBun
    ? (sqliteModule.Database as typeof BetterSqlite3)
    : buildNodeSqliteDatabaseClass(sqliteModule.DatabaseSync);

/**
 * The wrapper presents `DatabaseSync` through the better-sqlite3/Bun API.
 * The wrapper adds `transaction(fn)` with better-sqlite3 transaction semantics.
 * The savepoint path composes with manual `BEGIN IMMEDIATE` blocks.
 */
// biome-ignore lint/suspicious/noExplicitAny: node:sqlite has no shipped types here; the public export is cast to the better-sqlite3 shape.
function buildNodeSqliteDatabaseClass(DatabaseSync: any): typeof BetterSqlite3 {
    // SQLite savepoints with the same name are LIFO; RELEASE and ROLLBACK TO target the most recent.
    // node:sqlite runs synchronously per connection, so concurrent savepoint operations cannot occur.
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

        // Bun binds `.run([a, b])` positionally, but node:sqlite treats a lone array as named parameters.
        // node:sqlite treats a lone array as named parameters with keys `"0"`, `"1"`, and so on.
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

        // The `any` parameters match better-sqlite3's generic `transaction(fn)` signature.
        transaction<F extends (...args: any[]) => any>(fn: F): F {
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
                    // `RAISE(ROLLBACK)` can end the transaction before control returns; cleanup errors must not replace `error`.
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

/* */
export type Database = BetterSqlite3.Database;

/**
 *
 * Use `Statement<unknown[], unknown>` instead of `ReturnType<Database["prepare"]>` because the latter's conditional return type rejects valid bind arities.
 * Cached statements accept any number of bind arguments, matching bun:sqlite.
 */
export type Statement = BetterSqlite3.Statement<unknown[], unknown>;

const privilegeDepth = new WeakMap<Database, number>();

/**
 */
export function isInTransaction(db: Database): boolean {
    // SAFETY: this assertion permits probing transaction-state properties absent from Database.
    const candidate = db as unknown as { inTransaction?: unknown; isTransaction?: unknown };
    return candidate.inTransaction === true || candidate.isTransaction === true;
}

/**
 *
 * The write occurs in the caller's transaction or a BEGIN IMMEDIATE transaction.
 * The outermost scope resets `enabled` to 0 before commit, so no other connection can observe `enabled=1`.
 * Only the outermost `privilegeDepth` scope clears the privilege flag.
 * Only the outermost scope clears the privilege flag, so releasing an inner scope preserves its caller's permission.
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
// ---------------------------------------------------------------------------

/**
 * Require SQLite 3.47.1 or later; older versions may corrupt a shared WAL family.
 */
export const SQLITE_WAL_RESET_SAFE_MIN_VERSION = "3.47.1";

/** Require a Node version whose node:sqlite ships a WAL-reset-safe SQLite. */
export const MIN_SUPPORTED_NODE_VERSION = "24.15.0";

/** Require a Bun version whose bun:sqlite ships a WAL-reset-safe SQLite. */
export const MIN_SUPPORTED_BUN_VERSION = "1.3.14";

/* */
const SQLITE_SOURCE_ID_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [0-9a-f]{40,64}$/;

export interface SqliteEngineIdentity {
    readonly sqliteVersion: string;
    readonly sqliteSourceId: string;
}

/* */
export function readSqliteEngineIdentity(db: Database): SqliteEngineIdentity {
    const row = db
        .prepare("SELECT sqlite_version() AS version, sqlite_source_id() AS source_id")
        .get() as { version: string; source_id: string };
    return { sqliteVersion: String(row.version), sqliteSourceId: String(row.source_id) };
}

/**
 * Probe SQLite with a throwaway in-memory connection so an unsafe engine is detected without opening the real database file.
 * The probe detects an unsafe engine before the engine can open a shared WAL database.
 */
export function probeSqliteEngineIdentityOffPath(): SqliteEngineIdentity {
    const probe = new Database(":memory:");
    try {
        return readSqliteEngineIdentity(probe);
    } finally {
        probe.close();
    }
}

/* */
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
    /* */
    readonly runtimeVersion: string;
}

export interface SqliteRuntimeGateResult {
    readonly ok: boolean;
    readonly reasons: readonly string[];
}

/**
 * The source-ID check rejects sources that cannot be proven safe.
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

/* */
export function collectSqliteRuntimeGateInput(): SqliteRuntimeGateInput {
    const runtime = detectSqliteRuntime();
    const runtimeVersion =
        runtime === "Bun" ? (process.versions.bun ?? "0.0.0") : (process.versions.node ?? "0.0.0");
    return { runtime, runtimeVersion, ...probeSqliteEngineIdentityOffPath() };
}

export interface SqliteConnectionContractExpectations {
    /* */
    readonly expectWal: boolean;
    readonly minBusyTimeoutMs?: number;
    /* */
    readonly allowedSynchronous?: readonly number[];
}

/**
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
    const allowedSynchronous = expectations.allowedSynchronous ?? [1, 2, 3];
    if (!allowedSynchronous.includes(synchronous)) {
        violations.push(
            `synchronous mode ${synchronous} is not in the declared set [${allowedSynchronous.join(", ")}]`,
        );
    }
    return violations;
}
