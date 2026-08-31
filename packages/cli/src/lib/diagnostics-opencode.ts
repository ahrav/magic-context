// A static `import { Database } from "bun:sqlite"` crashes the Node CLI before `try/catch` can run.
// Node's ESM loader rejects `bun:` specifiers during resolution.
// If the DB cannot be read, the report still includes all other diagnostics.
// information.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import { isCompactionEnabled } from "@magic-context/core/config/agent-disable";
import { parseCompartmentOutput } from "@magic-context/core/hooks/magic-context/compartment-parser";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import {
    getMagicContextStorageDir,
    getProjectMagicContextHistorianDir,
} from "@magic-context/core/shared/data-path";
import { parse as parseJsonc } from "comment-json";
import {
    fileSize,
    formatBytes,
    type HistorianDumpMeta,
    type HistorianDumpSummary,
    listDumpsInDir,
    parseHistorianDumpMeta,
} from "./historian-dumps";
import { detectOpenCodeInstallations } from "./opencode-detect";
import { describeOpenCodeInstallations, type OpenCodeInstallationReport } from "./opencode-helpers";
import {
    getOpenCodePluginCacheRoots,
    getOpenCodePluginPackageJsonPaths,
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME,
} from "./opencode-plugin-cache";
import {
    type ConfigPaths,
    detectConfigPaths,
    getMagicContextHistorianDir,
    getMagicContextLogPath,
} from "./paths";
import { sanitizeConfigValue, sanitizeDiagnosticText, sanitizePathString } from "./redaction";

export type { HistorianDumpMeta, HistorianDumpSummary } from "./historian-dumps";

export interface DiagnosticReport {
    timestamp: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    pluginVersion: string;
    opencodeInstalled: boolean;
    opencodeInstallKind: "cli" | "desktop" | "none";
    opencodeVersion: string | null;
    /** `opencodeInstallations` marks the first detection-ladder rung as active. */
    opencodeInstallations: OpenCodeInstallationReport[];
    configPaths: ConfigPaths;
    opencodeConfigHasPlugin: boolean;
    tuiConfigHasPlugin: boolean;
    magicContextConfig: {
        exists: boolean;
        parseError?: string;
        flags: Record<string, unknown>;
    };
    pluginCache: {
        path: string;
        cached?: string;
        latest?: string;
    };
    storageDir: {
        path: string;
        exists: boolean;
        contextDbSizeBytes: number;
    };
    conflicts: {
        hasConflict: boolean;
        reasons: string[];
        /** `compactionEnabled` stores the resolved MC compaction mode used by the writer and fixer. */
        compactionEnabled: boolean;
        /** `nativeCompaction` stores the resolved native OpenCode `auto` and `prune` states. */
        nativeCompaction: {
            auto: boolean;
            prune: boolean;
        };
    };
    logFile: {
        path: string;
        exists: boolean;
        sizeKb: number;
    };
    /**
     * `recentSessions` contains the five most recently updated active OpenCode sessions.
     * `recentSessions` supplies session choices for the `--issue` picker.
     *
     * `recentSessions` is populated only when Bun provides `bun:sqlite` and OpenCode's database exists.
     * On Node-only runs, `recentSessions` is empty and diagnostics use the legacy tmp-directory historian listing.
     */
    recentSessions: RecentSessionSummary[];
    /**
     * `historianDumps` groups historian dumps by project directory.
     * `legacyDumps` contains dumps from the legacy harness-scoped tmp directory.
     */
    historianDumps: HistorianDumpsReport;
    /** `historianFailures` contains the most recent `session_meta` historian-failure rows across all sessions. */
    historianFailures: HistorianFailureSummary[];
    /**
     * `historianRunHistory` summarizes durable `historian_runs` telemetry by session.
     * `historianRunHistory` preserves fail, success, and noop history that the self-clearing `session_meta` counter omits.
     */
    historianRuns: HistorianRunSummary[];
}

/**
 * Each bucket groups historian dumps for one project directory represented in `recentSessions`.
 *
 * A bucket exists only for a project directory containing at least one dump under `<directory>/.cortexkit/magic-context/historian/`.
 * Sessions that share a project directory use the same bucket.
 * Empty buckets are omitted.
 */
export interface ProjectHistorianBucket {
    /** `directory` identifies the project represented by this bucket. */
    directory: string;
    /** `mostRecentSession` supplies the picker label for this project. */
    primarySessionId: string;
    /** `sessionIds` contains every recent session ID associated with this directory. */
    sessionIds: string[];
    /** `dumpCount` is the total number of dumps in this directory. */
    count: number;
    /** recent contains at most five newest dumps with parsed metadata. */
    recent: HistorianDumpSummary[];
}

export interface HistorianDumpsReport {
    /** byProject orders project buckets by latest activity. */
    byProject: ProjectHistorianBucket[];
    /**
     * `legacyDumps` includes dumps under `${tmpdir}/opencode/magic-context/historian/`.
     */
    legacyDumps: {
        dir: string;
        count: number;
        recent: HistorianDumpSummary[];
    };
}

export interface RecentSessionSummary {
    sessionId: string;
    /** title contains the OpenCode session title and is empty for fresh sessions. */
    title: string;
    /* */
    directory: string;
    /** lastActiveAt contains `session.time_updated` as an ISO timestamp. */
    lastActiveAt: string;
}

export interface HistorianFailureSummary {
    sessionId: string;
    failureCount: number;
    /** lastError contains sanitized, truncated error text and is empty when no error was recorded. */
    lastError: string;
    /** lastFailureAt contains the last failure timestamp as ISO text and is empty when no failure occurred. */
    lastFailureAt: string;
}

/**
 * historian_runs retains a per-session run history.
 * historian_runs retains failures after successful runs, unlike `session_meta.historian_failure_count`.
 */
export interface HistorianRunSummary {
    sessionId: string;
    /** Each count covers the session's most recent returned runs. */
    total: number;
    success: number;
    failed: number;
    noop: number;
    /** lastFailureReason contains the sanitized latest failure reason in the returned window, or is empty when none failed. */
    lastFailureReason: string;
    /** lastRunAt contains the latest returned run timestamp as ISO text. */
    lastRunAt: string;
}


function getSelfVersion(): string {
    // createRequire resolves paths relative to this module.
    // The source module is `src/cli/diagnostics.ts`; the bundled module is `dist/cli.js`.
    const require = createRequire(import.meta.url);
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = require(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) {
                return pkg.version;
            }
        } catch {
        }
    }
    return "unknown";
}

function getPluginCacheInfo(): { path: string; cached?: string; latest?: string } {
    const [path = ""] = getOpenCodePluginCacheRoots();
    let cached: string | undefined;
    for (const installedPkgPath of getOpenCodePluginPackageJsonPaths()) {
        try {
            if (existsSync(installedPkgPath)) {
                const pkg = JSON.parse(readFileSync(installedPkgPath, "utf-8")) as {
                    version?: unknown;
                };
                cached = typeof pkg.version === "string" ? pkg.version : undefined;
                if (cached) break;
            }
        } catch {
            cached = undefined;
        }
    }
    return { path, cached, latest: getSelfVersion() };
}

// ── Sanitization ─────────────────────────────────────────────────────

function sanitizeString(value: string): string {
    return sanitizePathString(value);
}

function sanitizeValue(value: unknown): unknown {
    return sanitizeConfigValue(value);
}


function readConfig(path: string): { value: Record<string, unknown> | null; error?: string } {
    if (!existsSync(path)) return { value: null };
    try {
        const raw = readFileSync(path, "utf-8");
        const value = parseJsonc(raw) as Record<string, unknown>;
        return { value };
    } catch (error) {
        return { value: null, error: error instanceof Error ? error.message : String(error) };
    }
}

function configHasPluginEntry(config: Record<string, unknown> | null): boolean {
    const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
    return plugins.some((entry) => {
        if (typeof entry !== "string") return false;
        if (entry === OPENCODE_PLUGIN_NAME) return true;
        if (entry === OPENCODE_PLUGIN_ENTRY_WITH_VERSION) return true;
        if (entry.startsWith(`${OPENCODE_PLUGIN_NAME}@`)) return true;
        if (entry.includes("opencode-magic-context")) return true;
        return false;
    });
}

/**
 *
 */
function collectHistorianDumps(
    recentSessions: RecentSessionSummary[],
): DiagnosticReport["historianDumps"] {
    // The query processes sessions in descending time order; the first session for a directory becomes that bucket's primarySessionId.
    const buckets = new Map<string, ProjectHistorianBucket>();
    for (const session of recentSessions) {
        const dir = session.directory;
        if (!dir) continue;
        const projectHistorianDir = getProjectMagicContextHistorianDir(dir);
        const listing = listDumpsInDir(projectHistorianDir, 5);
        const existing = buckets.get(dir);
        if (existing) {
            // When multiple sessions use a directory, append the session ID without recomputing that directory's listing.
            if (!existing.sessionIds.includes(session.sessionId)) {
                existing.sessionIds.push(session.sessionId);
            }
            continue;
        }
        if (listing.count === 0) continue;
        buckets.set(dir, {
            directory: dir,
            primarySessionId: session.sessionId,
            sessionIds: [session.sessionId],
            count: listing.count,
            recent: listing.recent,
        });
    }

    const legacyDir = getMagicContextHistorianDir("opencode");
    const legacyListing = listDumpsInDir(legacyDir, 5);

    return {
        byProject: [...buckets.values()],
        legacyDumps: {
            dir: legacyDir,
            count: legacyListing.count,
            recent: legacyListing.recent,
        },
    };
}

/**
 *
 * The list limits historian-dump lookups to existing OpenCode sessions.
 * The session list groups project directories and powers the `--issue` flow's session picker.
 *
 */
async function collectRecentSessions(): Promise<RecentSessionSummary[]> {
    // Runtime `XDG_DATA_HOME` or `HOME` overrides determine the database path.
    // Node's `homedir()` honors runtime `HOME` overrides; Bun's does not.
    const dataHome =
        process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), ".local", "share");
    const opencodeDbPath = join(dataHome, "opencode", "opencode.db");
    if (!existsSync(opencodeDbPath)) return [];

    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
        return [];
    }

    type DatabaseCtor = new (
        path: string,
        opts?: { readonly?: boolean },
    ) => {
        prepare: (sql: string) => { all: () => unknown[] };
        close: () => void;
    };

    let DatabaseClass: DatabaseCtor;
    try {
        const mod = (await new Function("p", "return import(p)")("bun:sqlite")) as {
            Database: DatabaseCtor;
        };
        DatabaseClass = mod.Database;
    } catch {
        return [];
    }

    let db: { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } | null = null;
    try {
        db = new DatabaseClass(opencodeDbPath, { readonly: true });
        const rows = db
            .prepare(
                // `session.time_updated` orders sessions as the recency proxy.
                // child's directory.
                "SELECT id, directory, title, time_updated FROM session " +
                    "WHERE time_archived IS NULL AND parent_id IS NULL " +
                    "ORDER BY time_updated DESC LIMIT 5",
            )
            .all() as Array<{
            id: unknown;
            directory: unknown;
            title: unknown;
            time_updated: unknown;
        }>;
        return rows.flatMap((row) => {
            const sessionId = typeof row.id === "string" ? row.id : null;
            const directory = typeof row.directory === "string" ? row.directory : null;
            if (!sessionId || !directory) return [];
            const title = typeof row.title === "string" ? row.title : "";
            const lastActiveAt =
                typeof row.time_updated === "number"
                    ? new Date(row.time_updated).toISOString()
                    : "";
            return [{ sessionId, title, directory, lastActiveAt }];
        });
    } catch {
        return [];
    } finally {
        try {
            db?.close();
        } catch {
        }
    }
}

/**
 *
 * Node must not resolve a `bun:` specifier during module loading.
 *
 * Under Node:
 *
 * A top-level `bun:` import makes Node throw before a surrounding try/catch can run.
 * Node throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` when it resolves a `bun:` specifier during module loading.
 */
async function collectHistorianFailures(
    storageDirPath: string,
): Promise<HistorianFailureSummary[]> {
    const contextDbPath = join(storageDirPath, "context.db");
    if (!existsSync(contextDbPath)) return [];

    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
        return [];
    }

    type DatabaseCtor = new (
        path: string,
        opts?: { readonly?: boolean },
    ) => {
        prepare: (sql: string) => { all: () => unknown[] };
        close: () => void;
    };

    let DatabaseClass: DatabaseCtor;
    try {
        // Under Bun, the dynamic import resolves `bun:sqlite` as a built-in module.
        const mod = (await new Function("p", "return import(p)")("bun:sqlite")) as {
            Database: DatabaseCtor;
        };
        DatabaseClass = mod.Database;
    } catch {
        return [];
    }

    let db: { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } | null = null;
    try {
        db = new DatabaseClass(contextDbPath, { readonly: true });
        const rows = db
            .prepare(
                "SELECT session_id, historian_failure_count, historian_last_error, historian_last_failure_at FROM session_meta WHERE historian_failure_count > 0 ORDER BY historian_last_failure_at DESC LIMIT 10",
            )
            .all() as Array<{
            session_id: unknown;
            historian_failure_count: unknown;
            historian_last_error: unknown;
            historian_last_failure_at: unknown;
        }>;
        return rows.map((row) => {
            const sessionId = typeof row.session_id === "string" ? row.session_id : "<unknown>";
            const failureCount =
                typeof row.historian_failure_count === "number" ? row.historian_failure_count : 0;
            const rawError =
                typeof row.historian_last_error === "string" ? row.historian_last_error : "";
            const lastAt =
                typeof row.historian_last_failure_at === "number"
                    ? new Date(row.historian_last_failure_at).toISOString()
                    : "";
            const lastError = sanitizeDiagnosticText(
                rawError.replace(/\s+/g, " ").trim().slice(0, 400),
            );
            return { sessionId, failureCount, lastError, lastFailureAt: lastAt };
        });
    } catch {
        return [];
    } finally {
        try {
            db?.close();
        } catch {
        }
    }
}

/**
 * `historian_runs` persists across successful runs, unlike the self-clearing `session_meta` counter read by `collectHistorianFailures`.
 * `historian_runs` preserves evidence of intermittent historian failures after later successes.
 */
async function collectHistorianRuns(storageDirPath: string): Promise<HistorianRunSummary[]> {
    const contextDbPath = join(storageDirPath, "context.db");
    if (!existsSync(contextDbPath)) return [];
    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return [];

    type DatabaseCtor = new (
        path: string,
        opts?: { readonly?: boolean },
    ) => {
        prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
        close: () => void;
    };

    let DatabaseClass: DatabaseCtor;
    try {
        const mod = (await new Function("p", "return import(p)")("bun:sqlite")) as {
            Database: DatabaseCtor;
        };
        DatabaseClass = mod.Database;
    } catch {
        return [];
    }

    let db: {
        prepare: (sql: string) => { all: (...p: unknown[]) => unknown[] };
        close: () => void;
    } | null = null;
    try {
        db = new DatabaseClass(contextDbPath, { readonly: true });
        const aggRows = db
            .prepare(
                `SELECT session_id,
                    COUNT(*) AS total,
                    SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
                    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                    SUM(CASE WHEN status='noop' THEN 1 ELSE 0 END) AS noop,
                    MAX(created_at) AS last_run_at
                 FROM historian_runs
                 GROUP BY session_id
                 ORDER BY last_run_at DESC
                 LIMIT 10`,
            )
            .all() as Array<{
            session_id: unknown;
            total: unknown;
            success: unknown;
            failed: unknown;
            noop: unknown;
            last_run_at: unknown;
        }>;
        if (aggRows.length === 0) return [];

        const reasonRows = db
            .prepare(
                `SELECT session_id, failure_reason, created_at
                 FROM historian_runs
                 WHERE status='failed' AND failure_reason IS NOT NULL
                 ORDER BY created_at DESC
                 LIMIT 200`,
            )
            .all() as Array<{ session_id: unknown; failure_reason: unknown }>;
        const latestReasonBySession = new Map<string, string>();
        for (const row of reasonRows) {
            const sid = typeof row.session_id === "string" ? row.session_id : "";
            if (!sid || latestReasonBySession.has(sid)) continue;
            if (typeof row.failure_reason === "string") {
                latestReasonBySession.set(sid, row.failure_reason);
            }
        }

        const asNum = (v: unknown): number => (typeof v === "number" ? v : 0);
        return aggRows.map((row) => {
            const sessionId = typeof row.session_id === "string" ? row.session_id : "<unknown>";
            const rawReason = latestReasonBySession.get(sessionId) ?? "";
            return {
                sessionId,
                total: asNum(row.total),
                success: asNum(row.success),
                failed: asNum(row.failed),
                noop: asNum(row.noop),
                lastFailureReason: sanitizeDiagnosticText(
                    rawReason.replace(/\s+/g, " ").trim().slice(0, 400),
                ),
                lastRunAt:
                    typeof row.last_run_at === "number"
                        ? new Date(row.last_run_at).toISOString()
                        : "",
            };
        });
    } catch {
        return [];
    } finally {
        try {
            db?.close();
        } catch {
        }
    }
}


export async function collectDiagnostics(): Promise<DiagnosticReport> {
    const pluginVersion = getSelfVersion();
    const configPaths = detectConfigPaths();
    const opencodeConfig = readConfig(configPaths.opencodeConfig);
    const tuiConfig = readConfig(configPaths.tuiConfig);
    const magicContextConfig = readConfig(configPaths.magicContextConfig);
    const storageDirPath = getMagicContextStorageDir();
    const contextDbPath = join(storageDirPath, "context.db");

    const logPath = getMagicContextLogPath("opencode");
    const logFileSize = existsSync(logPath) ? statSync(logPath).size : 0;

    let compactionEnabled = false;
    try {
        compactionEnabled = isCompactionEnabled(loadPluginConfig(process.cwd()));
    } catch (error) {
        console.warn(
            `[magic-context] Could not load Magic Context config to resolve compaction mode; ` +
                `preserving existing native compaction fields. ` +
                `(${error instanceof Error ? error.message : String(error)})`,
        );
    }
    const conflictResult = detectConflicts(process.cwd(), { compactionEnabled });
    const recentSessions = await collectRecentSessions();
    const opencodeInstallations = describeOpenCodeInstallations(detectOpenCodeInstallations());
    const activeInstallation = opencodeInstallations[0];
    let openCodeInstallKind: "cli" | "desktop" | "none" = "none";
    if (activeInstallation) openCodeInstallKind = activeInstallation.kind;

    return {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        pluginVersion,
        opencodeInstalled: openCodeInstallKind !== "none",
        opencodeInstallKind: openCodeInstallKind,
        opencodeVersion:
            activeInstallation?.kind === "cli" && activeInstallation.version !== "unknown"
                ? activeInstallation.version
                : null,
        opencodeInstallations,
        configPaths,
        opencodeConfigHasPlugin: configHasPluginEntry(opencodeConfig.value),
        tuiConfigHasPlugin: configHasPluginEntry(tuiConfig.value),
        magicContextConfig: {
            exists: existsSync(configPaths.magicContextConfig),
            ...(magicContextConfig.error ? { parseError: magicContextConfig.error } : {}),
            flags: (sanitizeValue(magicContextConfig.value ?? {}) as Record<string, unknown>) ?? {},
        },
        pluginCache: getPluginCacheInfo(),
        storageDir: {
            path: storageDirPath,
            exists: existsSync(storageDirPath),
            contextDbSizeBytes: fileSize(contextDbPath),
        },
        conflicts: {
            hasConflict: conflictResult.hasConflict,
            reasons: conflictResult.reasons,
            compactionEnabled,
            nativeCompaction: conflictResult.nativeCompaction,
        },
        logFile: {
            path: logPath,
            exists: existsSync(logPath),
            sizeKb: Math.round(logFileSize / 1024),
        },
        recentSessions,
        historianDumps: collectHistorianDumps(recentSessions),
        historianFailures: await collectHistorianFailures(storageDirPath),
        historianRuns: await collectHistorianRuns(storageDirPath),
    };
}

export function renderDiagnosticsMarkdown(report: DiagnosticReport): string {
    const configPaths = {
        configDir: sanitizeString(report.configPaths.configDir),
        opencodeConfig: sanitizeString(report.configPaths.opencodeConfig),
        opencodeConfigFormat: report.configPaths.opencodeConfigFormat,
        magicContextConfig: sanitizeString(report.configPaths.magicContextConfig),
        tuiConfig: sanitizeString(report.configPaths.tuiConfig),
        tuiConfigFormat: report.configPaths.tuiConfigFormat,
        omoConfig: report.configPaths.omoConfig
            ? sanitizeString(report.configPaths.omoConfig)
            : null,
    };

    const pluginCache = {
        path: sanitizeString(report.pluginCache.path),
        cached: report.pluginCache.cached ?? null,
        latest: report.pluginCache.latest ?? null,
    };

    const storage = {
        path: sanitizeString(report.storageDir.path),
        exists: report.storageDir.exists,
        context_db_size: formatBytes(report.storageDir.contextDbSizeBytes),
    };

    const openCodeInstallations = report.opencodeInstallations ?? [];
    const openCodeInstallationTable =
        openCodeInstallations.length > 1
            ? [
                  "",
                  "### OpenCode installations",
                  "| Marker | Path | Version | Source |",
                  "| --- | --- | --- | --- |",
                  ...openCodeInstallations.map(
                      (installation) =>
                          `| ${installation.active ? "[active]" : ""} | \`${sanitizeString(installation.path)}\` | ${installation.version} | ${installation.source} |`,
                  ),
              ]
            : [];

    const historianDumps = {
        byProject: report.historianDumps.byProject.map((bucket) => ({
            directory: sanitizeString(bucket.directory),
            primarySessionId: bucket.primarySessionId,
            sessionIds: bucket.sessionIds,
            count: bucket.count,
            recent: bucket.recent,
        })),
        legacyDumps: {
            dir: sanitizeString(report.historianDumps.legacyDumps.dir),
            count: report.historianDumps.legacyDumps.count,
            recent: report.historianDumps.legacyDumps.recent,
        },
    };

    const recentSessions = report.recentSessions.map((session) => ({
        sessionId: session.sessionId,
        title: sanitizeDiagnosticText(session.title),
        directory: sanitizeString(session.directory),
        lastActiveAt: session.lastActiveAt,
    }));

    return [
        `- Timestamp: ${report.timestamp}`,
        `- Plugin: v${report.pluginVersion}`,
        `- OS: ${report.platform} ${report.arch}`,
        `- Node: ${report.nodeVersion}`,
        `- OpenCode installed: ${report.opencodeInstalled} [${report.opencodeInstallKind}]${report.opencodeVersion ? ` (${report.opencodeVersion})` : ""}`,
        `- Plugin registered in opencode config: ${report.opencodeConfigHasPlugin}`,
        `- Plugin registered in tui config: ${report.tuiConfigHasPlugin}`,
        `- magic-context.jsonc parse error: ${report.magicContextConfig.parseError ?? "none"}`,
        `- Conflicts detected: ${report.conflicts.hasConflict ? report.conflicts.reasons.join("; ") : "none"}`,
        `- MC compaction mode: ${report.conflicts.compactionEnabled ? "on" : "off"}`,
        `- Native compaction: auto=${report.conflicts.nativeCompaction?.auto ?? "unknown"}, prune=${report.conflicts.nativeCompaction?.prune ?? "unknown"}`,
        ...openCodeInstallationTable,
        "",
        "### Config paths",
        "```json",
        JSON.stringify(configPaths, null, 2),
        "```",
        "",
        "### magic-context.jsonc flags",
        "```jsonc",
        JSON.stringify(sanitizeConfigValue(report.magicContextConfig.flags), null, 2),
        "```",
        "",
        "### Plugin cache",
        "```json",
        JSON.stringify(pluginCache, null, 2),
        "```",
        "",
        "### Storage",
        "```json",
        JSON.stringify(storage, null, 2),
        "```",
        "",
        "### Recent sessions",
        recentSessions.length === 0
            ? "_No recent OpenCode sessions found (or OpenCode DB unavailable on this runtime)._"
            : ["```json", JSON.stringify(recentSessions, null, 2), "```"].join("\n"),
        "",
        "### Historian dumps",
        "(Metadata only — XML content is not included in this report.)",
        "Dumps are stored per-project under `<project>/.cortexkit/magic-context/historian/`.",
        "```json",
        JSON.stringify(historianDumps, null, 2),
        "```",
        "",
        "### Historian failures (session_meta)",
        "_Note: this counter RESETS to 0 on every successful run — see 'Historian runs' below for the durable history._",
        report.historianFailures.length === 0
            ? "_No sessions with historian failures._"
            : [
                  "```json",
                  JSON.stringify(sanitizeConfigValue(report.historianFailures), null, 2),
                  "```",
              ].join("\n"),
        "",
        "### Historian runs (durable telemetry)",
        "Per-session success/failure/no-op counts from `historian_runs` (never reset).",
        report.historianRuns.length === 0
            ? "_No historian runs recorded (or schema predates v24)._"
            : [
                  "```json",
                  JSON.stringify(sanitizeConfigValue(report.historianRuns), null, 2),
                  "```",
              ].join("\n"),
        "",
        "### Log file",
        `- Path: ${sanitizeString(report.logFile.path)}`,
        `- Exists: ${report.logFile.exists}`,
        `- Size: ${report.logFile.sizeKb} KB`,
    ].join("\n");
}
