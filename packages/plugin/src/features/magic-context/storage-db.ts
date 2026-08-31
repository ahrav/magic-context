import {
    chmodSync,
    type Dirent,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getMagicContextStorageDir } from "../../shared/data-path";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import {
    classifyProcessKind,
    isPidAlive,
    isPidIdentityPlausible,
    parseRpcPortFile,
    readProcessCommand,
} from "../../shared/rpc-utils";
import {
    collectSqliteRuntimeGateInput,
    Database,
    evaluateSqliteRuntimeGate,
    type SqliteConnectionContractExpectations,
    type SqliteRuntimeGateInput,
    verifySqliteConnectionContract,
} from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { shouldEnforcePrivateStoragePermissions } from "../../shared/storage-permissions";
import { ensureContextStoreUuid } from "./context-authority";
import type { FailClosedBlockingProcess, FailClosedProcessKind } from "./fail-closed-block";
import { DIRECT_FORMAT_FENCE_MIGRATION_VERSION, FORK_MIGRATION_VERSION_FLOOR } from "./migrations";
import { composeRegisteredSchema, computeExpectedDirectFormat } from "./storage-current-schema";
import {
    buildDirectFormatMarker,
    classifyDatabaseFormatFamily,
    classifyPreOpenFamily,
    createDirectFormatMarkerSchema,
    DIRECT_FORMAT_EPOCH,
    type FormatFamilyClassification,
    inspectDatabaseForClassification,
    listDatabaseFamilyArtifacts,
    readDirectFormatMarker,
    stampDirectFormatMarker,
} from "./storage-format-epoch";
import { ensureColumn } from "./storage-schema-helpers";
import {
    loadToolDefinitionMeasurements,
    setDatabase as setToolDefinitionDatabase,
} from "./tool-definition-tokens";

// Re-exported so existing `from "./storage-db"` importers (and tests) keep
// resolving these; the definitions live in the leaf module to break the
// storage-db <-> migrations import cycle.
export { ensureColumn, FORK_MIGRATION_VERSION_FLOOR };

const databases = new Map<string, Database>();
const pendingAsyncOpens = new Map<string, Promise<Database | null>>();
const persistenceByDatabase = new WeakMap<Database, boolean>();
const persistenceErrorByDatabase = new WeakMap<Database, string>();
const pathByDatabase = new WeakMap<Database, string>();

let lastSchemaFenceRejection: { persistedVersion: number; supportedVersion: number } | null = null;

export interface DatabaseFormatRefusal {
    family: string;
    reasons: readonly string[];
}

let lastFormatRefusal: DatabaseFormatRefusal | null = null;

export function getSchemaFenceRejection(): {
    persistedVersion: number;
    supportedVersion: number;
} | null {
    return lastSchemaFenceRejection;
}

export function getFormatRefusal(): DatabaseFormatRefusal | null {
    return lastFormatRefusal;
}

export function __resetSchemaFenceStateForTests(): void {
    lastSchemaFenceRejection = null;
    lastFormatRefusal = null;
}

export const LATEST_SUPPORTED_VERSION = DIRECT_FORMAT_FENCE_MIGRATION_VERSION;

// chmod is meaningless on Windows (POSIX modes are not honored), so all
// permission tightening is skipped there. mkdir's `mode` is likewise ignored.
const PERMISSIONS_ENFORCEABLE = process.platform !== "win32";

const defaultStoragePermissionFs = { chmodSync, mkdirSync };
let storagePermissionFs = defaultStoragePermissionFs;

/** The overrides replace permission-changing filesystem calls without changing real fixture modes. */
export function __setStoragePermissionFsForTests(
    overrides: Partial<typeof defaultStoragePermissionFs>,
): void {
    storagePermissionFs = { ...defaultStoragePermissionFs, ...overrides };
}

export function __resetStoragePermissionFsForTests(): void {
    storagePermissionFs = defaultStoragePermissionFs;
}

/**
 */
function ensureSecureStorageDir(dir: string): void {
    if (!shouldEnforcePrivateStoragePermissions()) {
        storagePermissionFs.mkdirSync(dir, { recursive: true });
        return;
    }

    storagePermissionFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!PERMISSIONS_ENFORCEABLE) return;
    try {
        storagePermissionFs.chmodSync(dir, 0o700);
    } catch (error) {
        log(
            `[magic-context] could not restrict storage dir permissions on ${dir}: ${getErrorMessage(error)}`,
        );
    }
}

/**
 * Restrict the SQLite DB file and its WAL/SHM sidecars to owner-only (0o600)
 * only when Magic Context owns storage permission management. A trusted-group
 * deployment keeps the operator's modes unchanged, including sidecars.
 */
function restrictDatabaseFilePermissions(dbPath: string): void {
    if (!PERMISSIONS_ENFORCEABLE || !shouldEnforcePrivateStoragePermissions()) return;
    for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${dbPath}${suffix}`;
        if (!existsSync(file)) continue;
        try {
            storagePermissionFs.chmodSync(file, 0o600);
        } catch (error) {
            log(
                `[magic-context] could not restrict DB file permissions on ${file}: ${getErrorMessage(error)}`,
            );
        }
    }
}

export interface OpenDatabaseOptions {
    dbPath?: string;
    latestSupportedVersion?: number;
}

// Returns a path without opening a database.
// Returns a path without opening a database.
export function resolveDatabasePath(dbPathOverride?: string): { dbDir: string; dbPath: string } {
    if (dbPathOverride) {
        return { dbDir: dirname(dbPathOverride), dbPath: dbPathOverride };
    }
    // getMagicContextStorageDir() applies test-isolation guards so every caller uses them.
    // getMagicContextStorageDir() applies test-isolation guards so every caller uses them.
    // getMagicContextStorageDir() applies test-isolation guards so every caller uses them.
    // getMagicContextStorageDir() applies test-isolation guards so every caller uses them.
    const dbDir = getMagicContextStorageDir();
    return { dbDir, dbPath: join(dbDir, "context.db") };
}

export function getDatabasePath(db: Database): string | null {
    return pathByDatabase.get(db) ?? null;
}

export function getPersistedSchemaVersion(db: Database): number {
    const hasMigrationsTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
    if (!hasMigrationsTable) {
        return 0;
    }
    const row = db
        .prepare(
            "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version < ?",
        )
        .get(FORK_MIGRATION_VERSION_FLOOR) as { version: number } | undefined;
    return row?.version ?? 0;
}

/** Log the upstream-lane version so operators can compare it to this build's fence. */
export function formatSchemaFenceBootLog(
    persistedVersion: number,
    supportedVersion: number,
): string {
    return `[magic-context] upstream migration lane at boot: database=v${persistedVersion}, supported_fence=v${supportedVersion}`;
}

function getRuntimeLatestSupportedVersion(options?: OpenDatabaseOptions): number {
    if (options?.latestSupportedVersion !== undefined) {
        return options.latestSupportedVersion;
    }
    const override = process.env.MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION;
    if (override) {
        const parsed = Number.parseInt(override, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return LATEST_SUPPORTED_VERSION;
}

export type RpcDiscoveryUnreadableArm = "parse" | "io";

export interface RpcServerDiscovery {
    state: "absent" | "stale" | "live" | "unreadable" | "inconclusive";
    serverPids: number[];
    /* */
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

function unreadableDiscovery(path: string, arm: RpcDiscoveryUnreadableArm): RpcServerDiscovery {
    return {
        state: "unreadable",
        serverPids: [],
        staleFiles: [],
        unreadableFile: path,
        unreadableArm: arm,
    };
}

const RPC_DISCOVERY_PARSE_GRACE_MS = 10 * 60 * 1000;

export interface RpcDiscoveryFs {
    readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | Dirent[];
    readFileSync(path: string, encoding: "utf8"): string;
    statSync(path: string): { mtimeMs: number };
    unlinkSync(path: string): void;
}

const defaultRpcDiscoveryFs: RpcDiscoveryFs = {
    readdirSync: (path, options) =>
        options?.withFileTypes
            ? (readdirSync(path, { withFileTypes: true }) as Dirent[])
            : (readdirSync(path) as string[]),
    readFileSync: (path, encoding) => String(readFileSync(path, encoding)),
    statSync: (path) => ({ mtimeMs: statSync(path).mtimeMs }),
    unlinkSync: (path) => unlinkSync(path),
};
const rpcDiscoveryFs = defaultRpcDiscoveryFs;

type RpcDiscoveryJunkReason = "parse-invalid" | "invalid-pid";

function invalidDiscoveryReason(raw: string): RpcDiscoveryJunkReason {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed) as { pid?: unknown };
            if ("pid" in parsed) {
                const pid = Number(parsed.pid);
                if (!Number.isInteger(pid) || pid <= 0) return "invalid-pid";
            }
        } catch {
            // The malformed JSON is a parse-invalid record, not an I/O failure.
        }
    }
    // A legacy file containing only a port, with no server PID, is invalid and
    // cannot be accepted while deciding whether migration is safe.
    return "parse-invalid";
}

function classifyDiscoveryRecordKind(record: {
    kind?: string;
    harness?: string;
}): FailClosedProcessKind | null {
    for (const value of [record.kind, record.harness]) {
        const normalized = value?.trim().toLowerCase();
        if (!normalized) continue;
        if (normalized === "process") return "process";
        if (normalized === "opencode server" || normalized === "server") {
            return "OpenCode server";
        }
        if (
            normalized === "opencode instance" ||
            normalized === "opencode instance (tui/cli)" ||
            normalized === "opencode" ||
            normalized === "tui" ||
            normalized === "cli"
        ) {
            return "OpenCode instance (TUI/CLI)";
        }
        if (
            normalized === "pi" ||
            normalized === "pi harness" ||
            normalized === "omp" ||
            normalized === "oh-my-pi"
        ) {
            return "Pi";
        }
    }
    return null;
}

function classifyRpcProcess(record: {
    pid: number;
    kind?: string;
    harness?: string;
}): FailClosedProcessKind {
    return (
        classifyDiscoveryRecordKind(record) ?? classifyProcessKind(readProcessCommand(record.pid))
    );
}

function classifyJunkDiscovery(
    portFile: string,
    raw: string,
    staleFiles: string[],
): RpcServerDiscovery | null {
    let mtimeMs: number;
    try {
        mtimeMs = rpcDiscoveryFs.statSync(portFile).mtimeMs;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        return unreadableDiscovery(portFile, "io");
    }
    const ageMs = Date.now() - mtimeMs;
    if (!Number.isFinite(ageMs) || ageMs < RPC_DISCOVERY_PARSE_GRACE_MS) {
        return unreadableDiscovery(portFile, "parse");
    }

    staleFiles.push(portFile);
    const reason = invalidDiscoveryReason(raw);
    log(
        `[magic-context] removing stale RPC discovery file ${portFile}: ${reason} record older than 10 minutes`,
    );
    return null;
}

/**
 * Inspect the shared RPC discovery tree without treating partial evidence as
 * proof that no server is running. A missing/empty tree is a clean machine;
 * dead-PID and old malformed files are removed; fresh malformed or unreadable
 * evidence is fail-closed because it could be a concurrent write or an I/O
 * permission problem.
 */
export function inspectRpcServerDiscovery(storageDir: string): RpcServerDiscovery {
    const rpcRoot = join(storageDir, "rpc");
    let projectEntries: Dirent[];
    try {
        projectEntries = rpcDiscoveryFs.readdirSync(rpcRoot, { withFileTypes: true }) as Dirent[];
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { state: "absent", serverPids: [], staleFiles: [] };
        }
        return unreadableDiscovery(rpcRoot, "io");
    }

    const portFiles: string[] = [];
    for (const projectEntry of projectEntries) {
        if (!projectEntry.isDirectory()) continue;
        const projectDir = join(rpcRoot, projectEntry.name);
        let entries: string[];
        try {
            entries = rpcDiscoveryFs.readdirSync(projectDir) as string[];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            return unreadableDiscovery(projectDir, "io");
        }
        for (const entry of entries) {
            if (entry === "port" || (entry.startsWith("port-") && entry.endsWith(".json"))) {
                portFiles.push(join(projectDir, entry));
            }
        }
    }
    if (portFiles.length === 0) {
        return { state: "absent", serverPids: [], staleFiles: [] };
    }

    const pids = new Set<number>();
    const processByPid = new Map<number, FailClosedBlockingProcess>();
    const staleFiles: string[] = [];
    const inconclusivePids = new Set<number>();
    for (const portFile of portFiles) {
        let raw: string;
        try {
            raw = rpcDiscoveryFs.readFileSync(portFile, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            return unreadableDiscovery(portFile, "io");
        }
        const filename = basename(portFile);
        const pidFromName = /^port-(\d+)/.exec(filename)?.[1];
        const fallbackPid = pidFromName ? Number(pidFromName) : 0;
        const record = parseRpcPortFile(raw, fallbackPid);
        if (!record || !Number.isInteger(record.pid) || record.pid <= 0) {
            const junk = classifyJunkDiscovery(portFile, raw, staleFiles);
            if (junk) return junk;
            continue;
        }
        const liveness = isPidAlive(record.pid);
        const identity = liveness === "dead" ? "implausible" : isPidIdentityPlausible(record);
        if (liveness === "alive" && identity === "plausible") {
            pids.add(record.pid);
            const detected = {
                kind: classifyRpcProcess(record),
                pid: record.pid,
            } satisfies FailClosedBlockingProcess;
            const previous = processByPid.get(record.pid);
            if (!previous || (previous.kind === "process" && detected.kind !== "process")) {
                processByPid.set(record.pid, detected);
            }
        } else if (liveness === "dead" || identity === "implausible") {
            staleFiles.push(portFile);
        } else {
            inconclusivePids.add(record.pid);
        }
    }

    // Reused-PID files expand the collision surface on later database-open guard passes.
    // Reused-PID files expand the collision surface on later database-open guard passes.
    // Reused-PID files expand the collision surface on later database-open guard passes.
    for (const staleFile of staleFiles) {
        try {
            rpcDiscoveryFs.unlinkSync(staleFile);
        } catch {
            return unreadableDiscovery(staleFile, "io");
        }
    }

    const serverPids = [...pids].sort((a, b) => a - b);
    if (serverPids.length > 0) {
        return {
            state: "live",
            serverPids,
            serverProcesses: serverPids.map(
                (pid) => processByPid.get(pid) ?? { kind: "process" as const, pid },
            ),
            staleFiles,
        };
    }
    const uncertainPids = [...inconclusivePids].sort((a, b) => a - b);
    if (uncertainPids.length > 0) {
        return {
            state: "inconclusive",
            serverPids: [],
            staleFiles,
            inconclusivePids: uncertainPids,
        };
    }
    return { state: "stale", serverPids: [], staleFiles };
}

let sqlitePragmaConfig: { cacheSizeMb: number; mmapSizeMb: number } = {
    cacheSizeMb: 64,
    mmapSizeMb: 0,
};

export function setSqlitePragmaConfig(config: { cacheSizeMb: number; mmapSizeMb: number }): void {
    sqlitePragmaConfig = config;
}

/**
 * cache_size and mmap_size take effect on an open connection.
 */
export function applySqliteTuningPragmas(db: Database): void {
    // A negative `cache_size` value specifies KiB of page cache; `-65536` specifies 64 MiB.
    // pi-lens-ignore: sql-injection
    db.exec(`PRAGMA cache_size=-${Math.round(sqlitePragmaConfig.cacheSizeMb * 1024)}`);
    // pi-lens-ignore: sql-injection
    db.exec(`PRAGMA mmap_size=${Math.round(sqlitePragmaConfig.mmapSizeMb * 1024 * 1024)}`);
    // `analysis_limit=400` bounds ANALYZE work triggered by a later `PRAGMA optimize` on this connection.
    db.exec("PRAGMA analysis_limit=400");
}

/**
 * analysis_limit=400 limits ANALYZE work to approximately 400 rows per index.
 * PRAGMA optimize conditionally refreshes planner statistics.
 */
export function runSqliteOptimize(db: Database): void {
    try {
        db.exec("PRAGMA analysis_limit=400");
        db.exec("PRAGMA optimize");
    } catch {}
}

export interface SqliteRuntimeGateReport {
    readonly input: SqliteRuntimeGateInput;
    readonly ok: boolean;
    readonly reasons: readonly string[];
}

export function probeSqliteRuntimeGate(): SqliteRuntimeGateReport {
    const input = collectSqliteRuntimeGateInput();
    const { ok, reasons } = evaluateSqliteRuntimeGate(input);
    if (!ok) {
        log(
            `[magic-context] storage fatal: this ${input.runtime} ${input.runtimeVersion} runtime's SQLite source (version ${input.sqliteVersion}, source ${input.sqliteSourceId}) failed the WAL-reset-safety gate: ${reasons.join("; ")}. Upgrade the runtime before this process may write context.db.`,
        );
    }
    return { input, ok, reasons };
}

export function assertSqliteConnectionContract(
    db: Database,
    expectations: SqliteConnectionContractExpectations,
): void {
    const violations = verifySqliteConnectionContract(db, expectations);
    if (violations.length === 0) return;
    const message = `[magic-context] storage fatal: connection contract violated before application writes: ${violations.join("; ")}`;
    log(message);
    throw new Error(message);
}

function finishDatabaseOpen(db: Database, dbPath: string, explicitDbPath: boolean): Database {
    // Fresh opens recover claimed Channel-2 ceiling-nudge leases left by crashes.
    // The TTL-scoped heal releases stale claims without a restart.
    healWedgedChannel2Claims(db);
    // Migration v9 creates `tool_definition_measurements` before `loadToolDefinitionMeasurements` runs.
    setToolDefinitionDatabase(db);
    loadToolDefinitionMeasurements(db);
    // `restrictDatabaseFilePermissions` runs after WAL mode creates the database, WAL, and SHM files.
    // Externally managed trusted-group storage skips permission restriction.
    restrictDatabaseFilePermissions(dbPath);
    databases.set(dbPath, db);
    pathByDatabase.set(db, dbPath);
    persistenceByDatabase.set(db, true);
    persistenceErrorByDatabase.delete(db);
    if (!explicitDbPath) {
        log(formatSchemaFenceBootLog(getPersistedSchemaVersion(db), LATEST_SUPPORTED_VERSION));
    }
    return db;
}

const CHANNEL2_CLAIM_TTL_MS = 10 * 60_000;

/**
 * The recovery releases claimed Channel-2 ceiling-nudge leases left by crashes.
 *
 * The delivery path CAS-claims `pending → claimed` before sending the synthetic user message.
 * A crash can strand a claimed delivery and consume its cycle.
 * A `claimed_at` timestamp defines the liveness boundary for claims.
 * Recovery resets reaped claims to the empty, re-armable state.
 * Recovery reaps claimed rows with `claimed_at` NULL, 0, or at least `CHANNEL2_CLAIM_TTL_MS` old.
 */
function healWedgedChannel2Claims(db: Database): void {
    try {
        const staleBefore = Date.now() - CHANNEL2_CLAIM_TTL_MS;
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_state = '', channel2_nudge_claimed_at = 0, channel2_nudge_claim_token = '' WHERE channel2_nudge_state = 'claimed' AND (channel2_nudge_claimed_at IS NULL OR channel2_nudge_claimed_at = 0 OR channel2_nudge_claimed_at <= ?)",
        ).run(staleBefore);
    } catch {
        // `ensureColumn` and migrations add missing columns; fresh rows use `''` and require no healing.
    }
}

let cachedExpectedFormat: ReturnType<typeof computeExpectedDirectFormat> | null = null;

function expectedDirectFormat(): ReturnType<typeof computeExpectedDirectFormat> {
    if (!cachedExpectedFormat) cachedExpectedFormat = computeExpectedDirectFormat();
    return cachedExpectedFormat;
}

/**
 * `BEGIN IMMEDIATE` serializes concurrent bootstrappers before the transaction rechecks the family.
 * The transaction creates the registered direct format only when the family remains pristine.
 * The transaction leaves every family except pristine KTD1 and AE1 families untouched.
 */
function bootstrapUnderWriteLock(
    db: Database,
    dbPath: string,
    expected: ReturnType<typeof computeExpectedDirectFormat>,
): FormatFamilyClassification {
    db.transaction(() => {
        // The lock holder's rollback journal is excluded from family artifacts.
        // Counting the lock holder's `-journal` would misclassify a pristine family as orphaned.
        const inspection = inspectDatabaseForClassification(db, dbPath);
        const recheck = classifyDatabaseFormatFamily(
            {
                ...inspection,
                artifacts: inspection.artifacts.filter((artifact) => artifact !== "journal"),
            },
            expected,
        );
        if (recheck.family !== "pristine") return;
        composeRegisteredSchema(db);
        createDirectFormatMarkerSchema(db);
        stampDirectFormatMarker(
            db,
            buildDirectFormatMarker({
                componentManifestDigest: expected.componentManifestDigest,
                createdAtMs: Date.now(),
            }),
        );
        log(`[magic-context] bootstrapped pristine ${dbPath} to the direct claims format`);
    }).immediate();
    return classifyDatabaseFormatFamily(inspectDatabaseForClassification(db, dbPath), expected);
}

/**
 * The gate refuses a database whose persisted fence or marker epoch exceeds this binary's readable version and records the fence-rejection latch.
 *
 * The opener inventories the exact objects in every family before accepting or rejecting it.
 * Object inventory establishes shape, not format vintage.
 * A database with this build's objects can carry a fence that only a newer binary understands.
 */
function refuseNewerSchemaFence(
    db: Database,
    dbPath: string,
    latestSupportedVersion: number,
): boolean {
    let persistedVersion = 0;
    try {
        persistedVersion = getPersistedSchemaVersion(db);
    } catch {
        // An unreadable version lane stays a plain format refusal.
    }
    const marker = readDirectFormatMarker(db);
    const persistedEpoch = marker.status === "present" ? marker.marker.formatEpoch : 0;
    if (persistedVersion <= latestSupportedVersion && persistedEpoch <= DIRECT_FORMAT_EPOCH) {
        return false;
    }
    lastSchemaFenceRejection = { persistedVersion, supportedVersion: latestSupportedVersion };
    const lane =
        persistedEpoch > DIRECT_FORMAT_EPOCH
            ? `format epoch ${persistedEpoch} (this binary reads epoch ${DIRECT_FORMAT_EPOCH})`
            : `format lane v${persistedVersion} (max v${latestSupportedVersion})`;
    log(
        `[magic-context] storage fatal: refusing to open ${dbPath}; its ${lane} is newer than this binary supports. A pinned or stale plugin is likely sharing this database with a newer instance; update or unpin Magic Context with 'npx @cortexkit/magic-context@latest doctor --force', then restart. Do not reset this database: a newer binary owns it.`,
    );
    return true;
}

function recordFormatRefusal(
    db: Database,
    dbPath: string,
    classification: FormatFamilyClassification,
    latestSupportedVersion: number,
): void {
    if (refuseNewerSchemaFence(db, dbPath, latestSupportedVersion)) return;
    const marker = readDirectFormatMarker(db);
    const persistedEpoch = marker.status === "present" ? marker.marker.formatEpoch : 0;
    lastFormatRefusal = { family: classification.family, reasons: classification.reasons };
    // A digest-only mismatch at the same epoch cannot establish whether the database is older or newer.
    // The classifier does not classify a same-epoch digest-only mismatch as garbage.
    const manifestOnly =
        marker.status === "present" &&
        persistedEpoch === DIRECT_FORMAT_EPOCH &&
        classification.reasons.some((reason) => reason.includes("component manifest digest"));
    const guidance = manifestOnly
        ? "Align every Magic Context binary sharing this database on one revision first; run 'npx @cortexkit/magic-context@latest doctor reset-db' only to abandon the family deliberately."
        : "To abandon this database family and start fresh, run 'npx @cortexkit/magic-context@latest doctor reset-db'.";
    log(
        `[magic-context] storage fatal: refusing to open ${dbPath}; the database is not the supported direct claims format (${classification.family}): ${classification.reasons.join("; ")}. No data was changed. ${guidance}`,
    );
}

/**
 * The opener bootstraps only a truly pristine family under BEGIN IMMEDIATE.
 * The opener bootstraps a truly pristine family and refuses every other unsupported family.
 * The opener enables and verifies WAL only after the format verdict.
 * The opener refuses old databases rather than migrating them.
 * migrated.
 */
// The opener inspects family artifacts before opening SQLite to prevent open-time recovery from modifying them.
// drift.
function refusePreOpenFamily(dbPath: string): DatabaseFormatRefusal | null {
    const verdict = classifyPreOpenFamily(dbPath, {
        artifacts: listDatabaseFamilyArtifacts(dbPath),
        mainFileExists: existsSync(dbPath),
        mainFileSize: existsSync(dbPath) ? statSync(dbPath).size : 0,
    });
    if (verdict.decision === "open") return null;
    return { family: verdict.family, reasons: verdict.reasons };
}

function openDirectDatabase(
    dbPath: string,
    dbDir: string,
    explicitDbPath: boolean,
    latestSupportedVersion: number,
): Database | null {
    // The WAL-reset-safety gate runs before SQLite can recover a database, enable WAL, or write the direct format.
    const runtimeGate = probeSqliteRuntimeGate();
    if (!runtimeGate.ok) {
        return null;
    }
    const preOpenRefusal = refusePreOpenFamily(dbPath);
    if (preOpenRefusal) {
        lastFormatRefusal = preOpenRefusal;
        log(
            `[magic-context] storage fatal: refusing to open ${dbPath}; the database family is not usable (${preOpenRefusal.family}): ${preOpenRefusal.reasons.join("; ")}. No data was changed. To abandon this database family and start fresh, run 'npx @cortexkit/magic-context@latest doctor reset-db'.`,
        );
        return null;
    }
    ensureSecureStorageDir(dbDir);

    const db = new Database(dbPath);
    try {
        // The opener sets busy_timeout before file-level statements so a process that loses a concurrent cold-open waits for the winner's bootstrap commit instead of throwing SQLITE_BUSY.
        db.exec("PRAGMA busy_timeout=5000");
        db.exec("PRAGMA foreign_keys=ON");
        const expected = expectedDirectFormat();
        let classification = classifyDatabaseFormatFamily(
            inspectDatabaseForClassification(db, dbPath),
            expected,
        );
        if (classification.family !== "current") {
            classification = bootstrapUnderWriteLock(db, dbPath, expected);
        }
        if (classification.family !== "current") {
            recordFormatRefusal(db, dbPath, classification, latestSupportedVersion);
            closeQuietly(db);
            return null;
        }
        // A newer binary can move a fence without renaming an object, so object-name identity alone cannot prove the accepted family's vintage.
        if (refuseNewerSchemaFence(db, dbPath, latestSupportedVersion)) {
            closeQuietly(db);
            return null;
        }
        const isInMemory = dbPath === ":memory:";
        if (!isInMemory) db.exec("PRAGMA journal_mode=WAL");
        applySqliteTuningPragmas(db);
        assertSqliteConnectionContract(db, {
            expectWal: !isInMemory,
            minBusyTimeoutMs: 5000,
        });
        ensureContextStoreUuid(db);
        return finishDatabaseOpen(db, dbPath, explicitDbPath);
    } catch (error) {
        closeQuietly(db);
        throw error;
    }
}

/**
 *
 *
 *
 */
export function openDatabase(): Database | null;
export function openDatabase(dbPath: string): Database | null;
export function openDatabase(options: OpenDatabaseOptions): Database | null;
export function openDatabase(dbPathOrOptions?: string | OpenDatabaseOptions): Database | null {
    const options =
        typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : dbPathOrOptions;
    const explicitDbPath = options?.dbPath !== undefined;
    const { dbDir, dbPath } = resolveDatabasePath(options?.dbPath);
    const latestSupportedVersion = getRuntimeLatestSupportedVersion(options);
    lastSchemaFenceRejection = null;
    lastFormatRefusal = null;
    const existing = databases.get(dbPath);
    if (existing) {
        if (!persistenceByDatabase.has(existing)) {
            persistenceByDatabase.set(existing, true);
        }
        healWedgedChannel2Claims(existing);
        return existing;
    }

    try {
        return openDirectDatabase(dbPath, dbDir, explicitDbPath, latestSupportedVersion);
    } catch (error) {
        const detail = getErrorMessage(error);
        log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
        throw new Error(
            `[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
        );
    }
}

/**
 * SQLite calls are synchronous; a losing cold opener waits up to 5 seconds for the bootstrap commit, then SQLite can raise SQLITE_BUSY.
 */
export async function openDatabaseAsync(
    dbPathOrOptions?: string | OpenDatabaseOptions,
): Promise<Database | null> {
    const options =
        typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : dbPathOrOptions;
    const explicitDbPath = options?.dbPath !== undefined;
    const { dbDir, dbPath } = resolveDatabasePath(options?.dbPath);
    const latestSupportedVersion = getRuntimeLatestSupportedVersion(options);
    lastSchemaFenceRejection = null;
    lastFormatRefusal = null;
    const existing = databases.get(dbPath);
    if (existing) {
        if (!persistenceByDatabase.has(existing)) persistenceByDatabase.set(existing, true);
        healWedgedChannel2Claims(existing);
        return existing;
    }

    const pending = pendingAsyncOpens.get(dbPath);
    if (pending) return pending;

    const opening = (async (): Promise<Database | null> => {
        try {
            return openDirectDatabase(dbPath, dbDir, explicitDbPath, latestSupportedVersion);
        } catch (error) {
            const detail = getErrorMessage(error);
            log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
            throw new Error(
                `[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
            );
        }
    })();
    pendingAsyncOpens.set(dbPath, opening);
    try {
        return await opening;
    } finally {
        if (pendingAsyncOpens.get(dbPath) === opening) pendingAsyncOpens.delete(dbPath);
    }
}

export function isDatabasePersisted(db: Database | null): boolean {
    if (!db) return false;
    return persistenceByDatabase.get(db) ?? false;
}

export function getDatabasePersistenceError(db: Database | null): string | null {
    if (!db) return null;
    return persistenceErrorByDatabase.get(db) ?? null;
}

export function closeDatabase(): void {
    pendingAsyncOpens.clear();
    for (const [key, db] of databases) {
        try {
            closeQuietly(db);
        } catch (error) {
            log("[magic-context] storage error:", error);
        } finally {
            databases.delete(key);
        }
    }
}

export type ContextDatabase = Database;
