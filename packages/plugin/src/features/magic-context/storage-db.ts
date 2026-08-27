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

/** Most recent runtime-gate refusal for diagnostics after a null open. */
let lastRuntimeGateRefusal: SqliteRuntimeGateReport | null = null;

export function consumeLastRuntimeGateRefusal(): SqliteRuntimeGateReport | null {
    return lastRuntimeGateRefusal;
}

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
    lastRuntimeGateRefusal = null;
    lastSchemaFenceRejection = null;
    lastFormatRefusal = null;
}

export const LATEST_SUPPORTED_VERSION = DIRECT_FORMAT_FENCE_MIGRATION_VERSION;

// chmod is meaningless on Windows (POSIX modes are not honored), so all
// permission tightening is skipped there. mkdir's `mode` is likewise ignored.
const PERMISSIONS_ENFORCEABLE = process.platform !== "win32";

const defaultStoragePermissionFs = { chmodSync, mkdirSync };
let storagePermissionFs = defaultStoragePermissionFs;

/** Test seam: captures permission-changing calls without changing real fixture modes. */
export function __setStoragePermissionFsForTests(
    overrides: Partial<typeof defaultStoragePermissionFs>,
): void {
    storagePermissionFs = { ...defaultStoragePermissionFs, ...overrides };
}

export function __resetStoragePermissionFsForTests(): void {
    storagePermissionFs = defaultStoragePermissionFs;
}

/**
 * Create `dir` recursively. When private permissions are enabled, also create
 * and tighten it to owner-only 0o700. When an operator manages trusted-group
 * permissions, do not pass a mode or chmod an existing directory.
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

// Exported for the test-isolation guard test. Returns a PATH only — opens no DB —
// so a regression assertion is safe even if the resolution is wrong.
export function resolveDatabasePath(dbPathOverride?: string): { dbDir: string; dbPath: string } {
    if (dbPathOverride) {
        return { dbDir: dirname(dbPathOverride), dbPath: dbPathOverride };
    }
    // Test-isolation guards (MAGIC_CONTEXT_TEST_DATA_DIR + the CWD-independent
    // NODE_ENV backstop) both live in getMagicContextStorageDir(), so this
    // resolver and every direct caller of that helper are covered by one
    // implementation. See its doc comment for the incident history.
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

export function schemaVersionIsSupported(
    db: Database,
    latestSupportedVersion = LATEST_SUPPORTED_VERSION,
): boolean {
    return getPersistedSchemaVersion(db) <= latestSupportedVersion;
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

    // Remove stale evidence even when another record still proves that a server
    // is live. Leaving reused-PID files behind expands the collision surface on
    // every subsequent database-open guard pass.
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

// Per-connection SQLite tuning, settable once at plugin init (before the first
// openDatabase) so the 27 openDatabase call sites don't each need config
// threading. Defaults match the config schema (64 MiB cache, mmap disabled) so
// tests and early-init opens still get sane values.
let sqlitePragmaConfig: { cacheSizeMb: number; mmapSizeMb: number } = {
    cacheSizeMb: 64,
    mmapSizeMb: 0,
};

export function setSqlitePragmaConfig(config: { cacheSizeMb: number; mmapSizeMb: number }): void {
    sqlitePragmaConfig = config;
}

/**
 * Apply the tunable per-connection PRAGMAs (cache_size, mmap_size,
 * analysis_limit) from the current `sqlitePragmaConfig`. Idempotent and safe on
 * an already-open connection — cache_size/mmap_size take effect immediately —
 * so harnesses that open the DB before loading config (Pi) can call this once
 * config is available without reopening.
 */
export function applySqliteTuningPragmas(db: Database): void {
    // cache_size negative value = KiB of page cache (e.g. -65536 = 64 MiB).
    // pi-lens-ignore: sql-injection
    db.exec(`PRAGMA cache_size=-${Math.round(sqlitePragmaConfig.cacheSizeMb * 1024)}`);
    // pi-lens-ignore: sql-injection
    db.exec(`PRAGMA mmap_size=${Math.round(sqlitePragmaConfig.mmapSizeMb * 1024 * 1024)}`);
    // Bound any ANALYZE that a later PRAGMA optimize triggers on this connection.
    db.exec("PRAGMA analysis_limit=400");
}

/**
 * Run SQLite's self-gating planner-stats refresh. `analysis_limit=400` caps the
 * rows sampled per index so even a huge table can't cause a multi-second
 * ANALYZE; `optimize` then re-analyzes only tables whose row counts drifted
 * since the last ANALYZE (a no-op otherwise). Cheap to call periodically.
 */
export function runSqliteOptimize(db: Database): void {
    try {
        db.exec("PRAGMA analysis_limit=400");
        db.exec("PRAGMA optimize");
    } catch {
        // Best-effort maintenance; never fail a caller over stats refresh.
    }
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
    // Recover any Channel-2 ceiling-nudge lease left at `claimed` by a crash
    // mid-delivery (see healWedgedChannel2Claims). Fresh opens and later
    // cached-handle reuses both run this TTL-scoped heal so long-lived
    // processes eventually unwind stuck stale claims without a restart.
    healWedgedChannel2Claims(db);
    // Wire the persistence-backed tool-definition measurement store and
    // rehydrate the in-memory map from any prior writes. Doing this here
    // (after migrations) means migration v9 has already created the
    // `tool_definition_measurements` table, so loadToolDefinitionMeasurements
    // never hits a missing-table failure path.
    setToolDefinitionDatabase(db);
    loadToolDefinitionMeasurements(db);
    // When enabled, tighten the DB + WAL/SHM sidecars now that WAL mode has
    // created them. Externally managed trusted-group storage skips this entirely.
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
 * Boot heal for a wedged Channel-2 ceiling-nudge lease.
 *
 * The delivery path CAS-claims `pending → claimed` before sending the synthetic
 * user message. A crash can strand that claim and consume the cycle, but a
 * sibling process can also be legitimately mid-send against the shared DB. The
 * claimed_at lease timestamp is the liveness boundary: only old/legacy claims are
 * reaped to the empty, re-armable state; fresh claims are left alone so boot
 * recovery never steals an in-flight delivery.
 */
function healWedgedChannel2Claims(db: Database): void {
    try {
        const staleBefore = Date.now() - CHANNEL2_CLAIM_TTL_MS;
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_state = '', channel2_nudge_claimed_at = 0, channel2_nudge_claim_token = '' WHERE channel2_nudge_state = 'claimed' AND (channel2_nudge_claimed_at IS NULL OR channel2_nudge_claimed_at = 0 OR channel2_nudge_claimed_at <= ?)",
        ).run(staleBefore);
    } catch {
        // Columns may be missing on a very fresh DB before ensureColumn/migration
        // adds them; fresh rows seed the state as '' so there is nothing to heal.
    }
}

let cachedExpectedFormat: ReturnType<typeof computeExpectedDirectFormat> | null = null;

function expectedDirectFormat(): ReturnType<typeof computeExpectedDirectFormat> {
    if (!cachedExpectedFormat) cachedExpectedFormat = computeExpectedDirectFormat();
    return cachedExpectedFormat;
}

/**
 * Serialize with any concurrent bootstrapper under BEGIN IMMEDIATE, recheck
 * the family, and create the registered direct format only if the family is
 * still pristine (KTD1, AE1). Every other family is left untouched; the
 * caller decides from the returned post-transaction classification.
 */
function bootstrapUnderWriteLock(
    db: Database,
    dbPath: string,
    expected: ReturnType<typeof computeExpectedDirectFormat>,
): FormatFamilyClassification {
    db.transaction(() => {
        // The lock holder's own rollback journal is not a family artifact:
        // BEGIN IMMEDIATE creates `-journal` on this very connection, and
        // counting it would misread a pristine family as orphaned.
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
 * Refuse a database carrying a persisted fence or marker epoch newer than this
 * binary reads, recording the fence-rejection latch. Returns true when refused.
 *
 * Every family reaches this check, accepted or not: the exact object inventory
 * proves shape, never vintage, so a database whose objects match this build can
 * still carry a fence only a newer binary understands.
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
    // The fence row is a constant pinned to the retired migration lane, so it
    // only moves on a breaking format change. The marker's format epoch is the
    // signal that actually distinguishes a database this build is too old to
    // read from one it must refuse: reset guidance for the former would destroy
    // a family a newer binary legitimately owns.
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
    // A digest-only mismatch at the same epoch cannot be direction-typed from a
    // hash, so this must not assert the family is garbage.
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
 * Direct-format open core (KTD1, R15, R17): prove a WAL-reset-safe SQLite
 * source off-path, classify the family, bootstrap only a truly pristine
 * family under BEGIN IMMEDIATE, refuse everything that is not the exact
 * current registered format, and enable + verify WAL only after the format
 * verdict. There is no migration lane: old databases are refused, never
 * migrated.
 */
// Inspect family artifacts before opening SQLite: open-time recovery can
// consume an orphan WAL for an empty main file. The rules themselves live in
// the format-epoch leaf module so the pre-open and post-open verdicts cannot
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
    // The WAL-reset-safety gate runs before SQLite can recover a database,
    // enable WAL, or write the direct format.
    const runtimeGate = probeSqliteRuntimeGate();
    if (!runtimeGate.ok) {
        lastRuntimeGateRefusal = runtimeGate;
        return null;
    }
    lastRuntimeGateRefusal = null;
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
        // busy_timeout must precede any file-level statement: two processes can
        // cold-open the same family at once, and the loser must wait for the
        // winner's bootstrap commit instead of throwing SQLITE_BUSY.
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
        // The fence is checked on the accepted path too, not only on refusal.
        // Object-name identity cannot see a fence a newer binary moved without
        // renaming anything, so skipping this here would leave the one family
        // that reaches real queries as the only one never proving its vintage.
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
        // Re-run the TTL-scoped lease heal on cache hits too. Long-lived
        // processes keep this handle for hours, and a revert/confirm DB lock can
        // leave a stale `claimed` lease behind until some later openDatabase()
        // call. The heal is one idempotent UPDATE gated by claimed_at age.
        healWedgedChannel2Claims(existing);
        return existing;
    }

    try {
        return openDirectDatabase(dbPath, dbDir, explicitDbPath, latestSupportedVersion);
    } catch (error) {
        const detail = getErrorMessage(error);
        log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
        // No silent in-memory fallback — see comment above. Caller must
        // catch and disable Magic Context for that run.
        throw new Error(
            `[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
        );
    }
}

/**
 * Async boot variant of openDatabase. SQLite calls remain synchronous
 * (bootstrap contention resolves under the connection busy timeout), but
 * concurrent async openers of the same path share one in-flight open.
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
