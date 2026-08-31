import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import { isCompactionEnabled } from "@magic-context/core/config/agent-disable";
import {
    DEFAULT_LOCAL_EMBEDDING_MODEL,
    RETIRED_DEFAULT_LOCAL_EMBEDDING_MODEL,
} from "@magic-context/core/config/schema/magic-context";
import { substituteConfigVariables } from "@magic-context/core/config/variable";
import {
    type EmbeddingProbeOutcome,
    probeEmbeddingEndpoint,
} from "@magic-context/core/features/magic-context/memory/embedding-probe";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import { fixConflicts } from "@magic-context/core/shared/conflict-fixer";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { ensureTuiPluginEntry } from "@magic-context/core/shared/tui-config";
import { parse, stringify } from "comment-json";

import {
    isDevPathPluginEntry,
    isLocalPathPluginEntry,
    matchesPluginEntry,
} from "../adapters/opencode";
import { writeFileAtomic } from "../lib/atomic-write";
import { migrateConfigLocationsForCli } from "../lib/config-location-migration";
import { openExistingContextDatabase, UnsupportedSchemaVersionError } from "../lib/database-access";
import { formatDatabaseRepairGuidance } from "../lib/database-repair-guidance";
import { collectDiagnostics } from "../lib/diagnostics-opencode";
import {
    checkLocalEmbeddingRuntime,
    formatLocalEmbeddingRuntimeDoctorWarning,
    isLocalEmbeddingRuntimeBroken,
} from "../lib/embedding-runtime";
import { bundleIssueReport } from "../lib/logs-opencode";
import { migrateDreamerV2ForDoctor } from "../lib/migrate-dreamer-v2-doctor";
import { migrateExperimentalPinKeyFilesForDoctor } from "../lib/migrate-experimental-doctor";
import { detectOpenCodeInstallations } from "../lib/opencode-detect";
import {
    describeOpenCodeInstallations,
    type OpenCodeInstallationReport,
} from "../lib/opencode-helpers";
import {
    getOpenCodePluginCacheRoots,
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION as PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME as PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import { detectConfigPaths, getMagicContextLogPath } from "../lib/paths";
import { confirm, intro, log, outro, selectOne, spinner, text } from "../lib/prompts";
import {
    sanitizeDiagnosticEndpoint,
    sanitizeDiagnosticText,
    sanitizePathString,
} from "../lib/redaction";
import {
    checkStorageVersionFence,
    formatStorageVersions,
    readStorageVersions,
} from "../lib/storage-versions";
import { reportAuthorityMarkers } from "./doctor-authority";
import { clearPluginCache } from "./doctor-opencode-cache";

const CLI_PACKAGE_NAME = "@cortexkit/magic-context";

/**
 */
function resolveCompactionEnabledForDoctor(): boolean {
    try {
        const config = loadPluginConfig(process.cwd());
        return isCompactionEnabled(config);
    } catch (error) {
        console.warn(
            `[magic-context] Could not load Magic Context config to resolve compaction mode; ` +
                `preserving existing native compaction fields. ` +
                `(${error instanceof Error ? error.message : String(error)})`,
        );
        return false;
    }
}

export interface DoctorMigrationLogSink {
    success(message: string): void;
    warn(message: string): void;
}

export function migrateLegacyAgentEnabledConfigForDoctor(
    mcConfig: Record<string, unknown>,
    logs: DoctorMigrationLogSink,
): { changed: boolean; fixes: number } {
    let changed = false;
    let fixes = 0;

    const migrateLegacyAgentEnabled = (agentName: "dreamer" | "sidekick" | "historian"): void => {
        const agent = mcConfig[agentName] as Record<string, unknown> | undefined;
        if (!agent || typeof agent !== "object" || !("enabled" in agent)) return;

        const enabled = agent.enabled;
        const disable = agent.disable;
        delete agent.enabled;
        changed = true;
        fixes++;

        if (agentName === "historian") {
            logs.success(
                "Removed invalid historian.enabled (historian uses disable=true to turn off).",
            );
            return;
        }

        if (agentName === "dreamer") {
            if (disable !== true && enabled === false) {
                agent.disable = true;
                logs.warn(
                    "Migrated dreamer.enabled=false → dreamer.disable=true. This now also disables manual /ctx-dream. To keep manual dreaming, remove disable=true and set schedule to empty string.",
                );
            } else {
                logs.success(
                    'Removed deprecated dreamer.enabled (use dreamer.disable=true to turn off the Dreamer agent; use schedule="" for manual-only dreaming).',
                );
            }
            return;
        }

        if (disable !== true && enabled === false) {
            agent.disable = true;
            logs.success("Migrated sidekick.enabled=false → sidekick.disable=true.");
        } else {
            logs.success(
                "Removed deprecated sidekick.enabled (use sidekick.disable=true to turn off Sidekick).",
            );
        }
    };

    migrateLegacyAgentEnabled("dreamer");
    migrateLegacyAgentEnabled("sidekick");
    migrateLegacyAgentEnabled("historian");

    return { changed, fixes };
}

/**
 * A non-empty `dreamer.tasks["review-user-memories"].schedule` conflicts with `dreamer.disable=true`; disabled Dreamer prevents new promotions.
 */
export function checkUserMemoriesDreamerCompatibility(
    mcConfig: Record<string, unknown>,
): string | null {
    const dreamerObj = mcConfig?.dreamer as Record<string, unknown> | undefined;
    if (dreamerObj?.disable !== true) return null;
    const tasksObj = dreamerObj.tasks as Record<string, unknown> | undefined;
    const reviewTask = tasksObj?.["review-user-memories"] as Record<string, unknown> | undefined;
    const schedule = reviewTask?.schedule;
    if (typeof schedule !== "string" || schedule.trim() === "") return null;
    return 'dreamer.tasks["review-user-memories"] is scheduled but dreamer.disable=true, so new promotions will not run. Remove dreamer.disable or set dreamer.tasks["review-user-memories"].schedule="" to disable the task.';
}

/**
 */
async function fetchNpmLatest(pkg: string, timeoutMs = 5000): Promise<string | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
                signal: controller.signal,
                headers: { Accept: "application/json" },
            });
            if (!res.ok) return null;
            const body = (await res.json()) as { version?: unknown };
            return typeof body.version === "string" ? body.version : null;
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return null;
    }
}

/* */
function getSelfVersion(): string {
    const req = createRequire(import.meta.url);
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = req(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
        } catch {
            // try next
        }
    }
    return "0.0.0";
}

export function isPinnedOpenCodePluginSpecifier(specifier: string): boolean {
    if (specifier === PLUGIN_NAME || specifier === PLUGIN_ENTRY_WITH_VERSION) return false;
    return specifier.startsWith(`${PLUGIN_NAME}@`);
}

export function getUserNpmrcPath(): string {
    const custom = process.env.NPM_CONFIG_USERCONFIG?.trim();
    if (custom) return custom;
    const home = process.env.HOME?.trim();
    return join(home || homedir(), ".npmrc");
}

export function collectNpmReleaseAgeWarnings(): string[] {
    const ageWarnings: string[] = [];
    const npmrcPath = getUserNpmrcPath();
    if (!existsSync(npmrcPath)) return ageWarnings;
    try {
        const npmrc = readFileSync(npmrcPath, "utf-8");
        for (const line of npmrc.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
            const [key] = trimmed.split("=").map((s) => s.trim());
            if (key === "min-release-age" || key === "before") {
                ageWarnings.push(
                    `${sanitizePathString(npmrcPath)} has '${sanitizeDiagnosticText(trimmed)}'`,
                );
            }
        }
    } catch {
    }
    return ageWarnings;
}

/* */
function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.-]/).map((s) => Number.parseInt(s, 10));
    const pb = b.split(/[.-]/).map((s) => Number.parseInt(s, 10));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (Number.isNaN(x) || Number.isNaN(y)) return 0;
        if (x < y) return -1;
        if (x > y) return 1;
    }
    return 0;
}


function isGhInstalled(): boolean {
    try {
        execSync("gh --version", { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function openBrowser(url: string): void {
    try {
        if (process.platform === "darwin") {
            const child = spawnSync("open", [url], { stdio: "ignore" });
            if (child.status === 0) return;
        } else if (process.platform === "linux") {
            const child = spawnSync("xdg-open", [url], { stdio: "ignore" });
            if (child.status === 0) return;
        } else if (process.platform === "win32") {
            const child = spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
            if (child.status === 0) return;
        }
    } catch {
        // Best-effort only.
    }
}

async function runIssueFlow(): Promise<number> {
    intro("Magic Context Issue Report");

    const title = await text("Issue title", {
        placeholder: "Short summary of the problem",
        validate: (value) => (value.trim() ? undefined : "Title is required"),
    });
    const description = await text("Issue description", {
        placeholder: "Describe what happened, what you expected, and repro steps",
        validate: (value) => (value.trim() ? undefined : "Description is required"),
    });

    const s = spinner();
    s.start("Collecting diagnostics");

    try {
        const report = await collectDiagnostics();
        s.stop("Diagnostics collected");

        let sessionFilter: string | null = null;
        if (report.recentSessions.length > 1) {
            const choice = await selectOne(
                "Which session is this issue about? (filters log lines from other sessions)",
                [
                    ...report.recentSessions.map((session, index) => {
                        const displayTitle = session.title.trim() || "(no title)";
                        const truncatedTitle =
                            displayTitle.length > 50
                                ? `${displayTitle.slice(0, 47)}...`
                                : displayTitle;
                        return {
                            label: `${truncatedTitle} — ${session.sessionId}${index === 0 ? " (most recent)" : ""}`,
                            value: session.sessionId,
                        };
                    }),
                    {
                        label: "All sessions (no filtering)",
                        value: "__all__",
                    },
                ],
            );
            sessionFilter = choice === "__all__" ? null : choice;
        }

        s.start("Bundling issue report");
        const bundled = await bundleIssueReport(report, description, title, sessionFilter);
        s.stop(`Report written to ${bundled.path}`);

        const shouldSubmit = await confirm("Submit this issue on GitHub now?", true);
        if (shouldSubmit && isGhInstalled()) {
            const result = spawnSync(
                "gh",
                [
                    "issue",
                    "create",
                    "-R",
                    "cortexkit/magic-context",
                    "--title",
                    title,
                    "--body-file",
                    bundled.path,
                ],
                { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
            );

            if (result.status === 0) {
                log.success(result.stdout.trim());
                outro("Issue submitted — thanks for the report!");
                return 0;
            }

            log.warn(result.stderr.trim() || "gh issue create failed");
        } else if (shouldSubmit && !isGhInstalled()) {
            log.warn("gh CLI not found — falling back to browser");
        }

        const url = `https://github.com/cortexkit/magic-context/issues/new?title=${encodeURIComponent(title)}&template=bug_report.yml`;
        log.info(
            `Open this URL and paste the contents of ${bundled.path} into the Diagnostics field:`,
        );
        log.info(url);
        openBrowser(url);
        outro("Issue report ready");
        return 0;
    } catch (error) {
        s.stop("Diagnostic collection failed");
        log.error(error instanceof Error ? error.message : String(error));
        outro("Issue report failed");
        return 1;
    }
}


/**
 *
 */
function checkLocalEmbeddingRuntimeForDoctor(activeModel = DEFAULT_LOCAL_EMBEDDING_MODEL): {
    issues: number;
    localRuntimeBroken?: boolean;
    unverified?: boolean;
} {
    const runtime = checkLocalEmbeddingRuntime(getOpenCodePluginCacheRoots());
    if (isLocalEmbeddingRuntimeBroken(runtime)) {
        log.warn(formatLocalEmbeddingRuntimeDoctorWarning(runtime));
        return { issues: 1, localRuntimeBroken: true };
    }
    if (runtime.state === "unknown") {
        log.warn(`Local embedding runtime unverified: ${runtime.reason}`);
        return { issues: 0, unverified: true };
    }
    log.success(`Embedding provider: local (${activeModel})`);
    return { issues: 0 };
}

async function checkEmbeddingConfig(
    magicContextConfigPath: string,
): Promise<{ issues: number; localRuntimeBroken?: boolean; unverified?: boolean }> {
    if (!existsSync(magicContextConfigPath)) {
        return checkLocalEmbeddingRuntimeForDoctor();
    }

    let rawText: string;
    try {
        rawText = readFileSync(magicContextConfigPath, "utf-8");
    } catch {
        log.warn("Could not read magic-context.jsonc for embedding check");
        return { issues: 1 };
    }

    const substituted = substituteConfigVariables({
        text: rawText,
        configPath: magicContextConfigPath,
    });

    let parsedConfig: Record<string, unknown>;
    try {
        parsedConfig = parse(substituted.text) as Record<string, unknown>;
    } catch (error) {
        log.warn(
            `Embedding check skipped — could not parse magic-context.jsonc: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { issues: 1 };
    }

    const embedding = parsedConfig?.embedding as Record<string, unknown> | undefined;
    const provider = embedding?.provider;

    if (provider === "off") {
        log.info("Embedding provider disabled — semantic memory search is off");
        return { issues: 0 };
    }

    if (provider === undefined || provider === "local") {
        const pinnedModel = typeof embedding?.model === "string" ? embedding.model.trim() : "";
        if (pinnedModel === RETIRED_DEFAULT_LOCAL_EMBEDDING_MODEL) {
            log.warn(
                `Config pins the retired default embedding model (${RETIRED_DEFAULT_LOCAL_EMBEDDING_MODEL}). ` +
                    `It keeps working, but the current default (${DEFAULT_LOCAL_EMBEDDING_MODEL}) ranks better on retrieval. ` +
                    `Remove the embedding.model line (or rerun setup) to adopt it; stored content re-embeds automatically.`,
            );
        }
        return checkLocalEmbeddingRuntimeForDoctor(pinnedModel || DEFAULT_LOCAL_EMBEDDING_MODEL);
    }

    if (provider !== "openai-compatible") {
        log.warn(
            `Unknown embedding provider: ${String(provider)} (expected local | openai-compatible | off)`,
        );
        return { issues: 1 };
    }

    const endpoint = typeof embedding?.endpoint === "string" ? embedding.endpoint.trim() : "";
    const model = typeof embedding?.model === "string" ? embedding.model.trim() : "";
    const apiKey = typeof embedding?.api_key === "string" ? embedding.api_key : undefined;
    const inputType =
        typeof embedding?.input_type === "string" ? embedding.input_type.trim() : undefined;
    const truncateMode =
        typeof embedding?.truncate === "string" ? embedding.truncate.trim() : undefined;

    let localIssues = 0;

    if (!endpoint) {
        log.error("Embedding provider is openai-compatible but 'endpoint' is missing");
        return { issues: 1 };
    }
    if (!model) {
        log.error("Embedding provider is openai-compatible but 'model' is missing");
        return { issues: 1 };
    }

    if (apiKey && /\{env:[^}]+\}/.test(apiKey)) {
        log.warn(
            "api_key still contains {env:...} after substitution — the referenced environment variable is not set in this shell",
        );
        log.info(`  Raw value: ${apiKey}`);
        log.info(
            "  Export the variable before launching OpenCode (e.g. in ~/.zshrc, ~/.bashrc, or a shell profile)",
        );
        localIssues++;
    }

    // certainly related.
    if (substituted.warnings.length > 0) {
        for (const w of substituted.warnings.slice(0, 3)) {
            log.info(`  ${w}`);
        }
        if (substituted.warnings.length > 3) {
            log.info(`  ... and ${substituted.warnings.length - 3} more`);
        }
    }

    const probeSpinner = spinner();
    probeSpinner.start(
        `Testing embedding endpoint ${sanitizeDiagnosticEndpoint(endpoint)} (model: ${sanitizeDiagnosticText(model)})`,
    );

    let outcome: EmbeddingProbeOutcome;
    try {
        outcome = await probeEmbeddingEndpoint({
            endpoint,
            model,
            apiKey: apiKey,
            ...(inputType ? { inputType } : {}),
            ...(truncateMode ? { truncate: truncateMode } : {}),
            timeoutMs: 10_000,
        });
    } catch (error) {
        probeSpinner.stop("Embedding probe failed unexpectedly");
        log.error(
            `Probe threw: ${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}`,
        );
        return { issues: localIssues + 1 };
    }

    probeSpinner.stop("Embedding endpoint probed");

    switch (outcome.kind) {
        case "ok":
            log.success(
                `Embedding endpoint OK (${outcome.status}, ${outcome.dimensions ?? "?"}-dim vectors)`,
            );
            return { issues: localIssues };
        case "auth_failed":
            log.error(
                `Embedding endpoint rejected credentials (${outcome.status}) — check api_key / env var`,
            );
            if (outcome.preview) log.info(`  ${sanitizeDiagnosticText(outcome.preview)}`);
            return { issues: localIssues + 1 };
        case "endpoint_unsupported":
            log.error(`Embedding endpoint does not support embeddings (${outcome.status})`);
            if (outcome.preview) log.info(`  ${sanitizeDiagnosticText(outcome.preview)}`);
            log.info(
                "  Common causes: endpoint points at a chat-completion route (should be the provider base, e.g. '.../v1'), or the provider doesn't offer an embeddings API",
            );
            log.info(
                "  Known non-embedding providers: OpenRouter (chat proxy), Anthropic (no embeddings endpoint). Use OpenAI, Voyage, Together, or a local provider instead.",
            );
            return { issues: localIssues + 1 };
        case "http_error":
            log.error(`Embedding endpoint returned ${outcome.status}`);
            if (outcome.preview) log.info(`  ${sanitizeDiagnosticText(outcome.preview)}`);
            return { issues: localIssues + 1 };
        case "timeout":
            log.warn(
                `Embedding endpoint did not respond within ${outcome.timeoutMs}ms — check endpoint URL and network`,
            );
            return { issues: localIssues + 1 };
        case "network_error":
            log.error(
                `Could not reach embedding endpoint: ${sanitizeDiagnosticText(outcome.message)}`,
            );
            return { issues: localIssues + 1 };
        case "invalid_scheme":
            log.error(
                `Embedding endpoint must start with http:// or https://: ${sanitizeDiagnosticEndpoint(outcome.endpoint)}`,
            );
            return { issues: localIssues + 1 };
    }
}


function logOpenCodeInstallationTable(installations: OpenCodeInstallationReport[]): void {
    log.info("OpenCode installations:");
    log.info("  marker   | path | version | source");
    for (const installation of installations) {
        log.info(
            `  ${installation.active ? "[active]" : "        "} | ${installation.path} | ${installation.version} | ${installation.source}`,
        );
    }
}

export async function runDoctor(
    options: { force?: boolean; issue?: boolean } = {},
): Promise<number> {
    migrateConfigLocationsForCli(process.cwd(), log);

    if (options.issue) {
        return runIssueFlow();
    }

    intro("Magic Context Doctor");

    let issues = 0;
    let fixed = 0;
    let passCount = 0;
    let warnCount = 0;
    let failCount = 0;
    const pass = (msg: string) => {
        log.success(msg);
        passCount++;
    };
    const warn = (msg: string) => {
        log.warn(msg);
        warnCount++;
    };
    const fail = (msg: string) => {
        log.error(msg);
        failCount++;
        issues++;
    };

    const authorityDbPath = join(getMagicContextStorageDir(), "context.db");
    let authorityDb: ReturnType<typeof openExistingContextDatabase> = null;
    try {
        authorityDb = openExistingContextDatabase(authorityDbPath, { readonly: true });
        if (authorityDb) {
            await reportAuthorityMarkers({ db: authorityDb, info: log.info, warn });
        } else {
            log.info("Authority: no context database found");
        }
    } catch (error) {
        warn(
            `Authority check unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
        authorityDb?.close();
    }

    const installationReports = describeOpenCodeInstallations(detectOpenCodeInstallations());
    const activeInstallation = installationReports[0];
    if (!activeInstallation) {
        fail("OpenCode is not installed or not in PATH");
        log.info("Doctor checked ~/.opencode/bin/opencode and each entry in $PATH.");
        log.info(
            "If `which opencode` succeeds outside doctor, your wrapper or shim may not be readable by Node — please share that wrapper in the issue.",
        );
        outro("Doctor failed — install OpenCode first");
        return 1;
    }
    if (installationReports.length > 1) {
        logOpenCodeInstallationTable(installationReports);
    }
    if (activeInstallation.kind === "desktop") {
        pass(
            installationReports.length > 1
                ? "OpenCode Desktop selected for plugin checks (CLI not installed)"
                : "OpenCode Desktop detected (CLI not installed)",
        );
    } else if (activeInstallation.version === "unknown") {
        fail(`OpenCode CLI was found at ${activeInstallation.path} but could not be executed`);
    } else {
        pass(
            installationReports.length > 1
                ? `OpenCode ${activeInstallation.version} installed (active install marked above)`
                : `OpenCode ${activeInstallation.version} installed`,
        );
    }

    const selfVersion = getSelfVersion();
    const [npmLatest, pluginNpmLatest] = await Promise.all([
        fetchNpmLatest(CLI_PACKAGE_NAME),
        fetchNpmLatest(PLUGIN_NAME),
    ]);
    if (!npmLatest) {
        log.info(`Magic Context CLI v${selfVersion}; npm latest check unavailable`);
    } else if (compareVersions(selfVersion, npmLatest) < 0) {
        warn(`Magic Context CLI v${selfVersion} is older than npm latest v${npmLatest}`);
    } else {
        pass(`Magic Context CLI v${selfVersion} is current (npm latest v${npmLatest})`);
    }

    const paths = detectConfigPaths();

    if (paths.opencodeConfigFormat === "none") {
        fail(`No opencode.json found at ${paths.opencodeConfig}`);
    } else {
        pass(`OpenCode config: ${paths.opencodeConfig}`);
    }

    if (existsSync(paths.magicContextConfig)) {
        pass(`Magic Context config: ${paths.magicContextConfig}`);
        try {
            const raw = readFileSync(paths.magicContextConfig, "utf-8");
            const substituted = substituteConfigVariables({
                text: raw,
                configPath: paths.magicContextConfig,
            }).text;
            parse(substituted);
            pass("magic-context.jsonc parses as valid JSONC");
        } catch (err) {
            fail(
                `magic-context.jsonc parse failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        try {
            const result = loadPluginConfig(process.cwd());
            const warnings = result.configWarnings ?? [];
            if (warnings.length > 0) {
                warn(
                    `Magic Context config has ${warnings.length} warning(s) — see 'magic-context doctor --issue' for details`,
                );
            } else {
                pass("Magic Context config loads successfully");
            }
        } catch (err) {
            fail(
                `Could not load Magic Context config: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    } else {
        warn(`No magic-context.jsonc found — using defaults`);
        log.info("  Run 'setup' to create one with model recommendations");
    }

    if (existsSync(paths.magicContextConfig)) {
        try {
            const mcRaw = readFileSync(paths.magicContextConfig, "utf-8");
            const mcConfig = parse(mcRaw) as Record<string, unknown>;
            let mcChanged = false;

            //
            // The migration removes `experimental.compaction_markers` and top-level `compaction_markers` because the schema rejects both.
            // The migration removes top-level `compaction_markers` because the schema rejects it.
            //     v0.9.0+)
            //
            // The schema rejects `experimental.compaction_markers` and top-level `compaction_markers`.
            // The migration removes `experimental.compaction_markers` and top-level `compaction_markers` because the schema rejects both.
            //
            // `comment-json` stores property comments on hidden `Symbol` keys of the parent object.
            // Deleting a key removes only its immediately preceding before-property comment.
            // Deleting a key removes only its immediately preceding before-property comment.
            // Deleting a key preserves block comments, other properties' before-property comments, and sibling trailing comments.
            // The migration preserves an empty `experimental` object because its header comment is anchored to that object.
            const experimental = mcConfig.experimental as Record<string, unknown> | undefined;
            if (experimental && "compaction_markers" in experimental) {
                delete experimental.compaction_markers;
                mcChanged = true;
                log.success(
                    "Removed deprecated experimental.compaction_markers (always-on since v0.21.4)",
                );
                fixed++;
            }
            if ("compaction_markers" in mcConfig) {
                delete mcConfig.compaction_markers;
                mcChanged = true;
                log.success("Removed deprecated compaction_markers (always-on since v0.21.4)");
                fixed++;
            }

            // The migration removes `auto_drop_tool_age` and `drop_tool_structure` because the schema rejects both.
            // The migration removes `auto_drop_tool_age` and `drop_tool_structure` because the schema rejects both.
            for (const deadKey of ["auto_drop_tool_age", "drop_tool_structure"]) {
                if (deadKey in mcConfig) {
                    delete mcConfig[deadKey];
                    mcChanged = true;
                    log.success(
                        `Removed deprecated ${deadKey} (replaced by tiered emergency drop)`,
                    );
                    fixed++;
                }
            }

            const agentEnabledMigration = migrateLegacyAgentEnabledConfigForDoctor(mcConfig, log);
            if (agentEnabledMigration.changed) {
                mcChanged = true;
                fixed += agentEnabledMigration.fixes;
            }

            if (experimental && "user_memories" in experimental) {
                const dreamer = (mcConfig.dreamer as Record<string, unknown> | undefined) ?? {};
                const oldUM = experimental.user_memories;
                const existingUM = dreamer.user_memories;
                if (existingUM === undefined) {
                    if (typeof oldUM === "boolean") {
                        dreamer.user_memories = { enabled: oldUM };
                    } else {
                        dreamer.user_memories = oldUM;
                    }
                } else if (
                    typeof oldUM === "object" &&
                    oldUM !== null &&
                    typeof existingUM === "object" &&
                    existingUM !== null
                ) {
                    // The merge preserves legacy fields missing from `dreamer.user_memories`.
                    const merged = {
                        ...(oldUM as Record<string, unknown>),
                        ...(existingUM as Record<string, unknown>),
                    };
                    dreamer.user_memories = merged;
                } else if (typeof oldUM === "object" && oldUM !== null) {
                    // The migration converts primitive `dreamer.user_memories` values to `enabled: Boolean(existingUM)` before merging legacy fields.
                    const coerced: Record<string, unknown> = {
                        ...(oldUM as Record<string, unknown>),
                        enabled: Boolean(existingUM),
                    };
                    dreamer.user_memories = coerced;
                    log.warn(
                        `Coerced malformed dreamer.user_memories (${typeof existingUM}) to object form while merging sub-fields from experimental.user_memories`,
                    );
                }
                mcConfig.dreamer = dreamer;
                delete experimental.user_memories;
                mcChanged = true;
                log.success(
                    "Migrated experimental.user_memories → dreamer.user_memories (now default: enabled)",
                );
                fixed++;
            }

            if (experimental && migrateExperimentalPinKeyFilesForDoctor(mcConfig)) {
                mcChanged = true;
                log.success(
                    "Migrated experimental.pin_key_files → dreamer.pin_key_files (preserved user enabled state)",
                );
                fixed++;
            }

            // When both values exist, `dreamer.user_memories` takes precedence over `experimental.user_memories`.
            const relocateGraduated = (
                key: string,
                dest: Record<string, unknown>,
                destLabel: string,
            ): void => {
                if (!experimental || !(key in experimental)) return;
                const oldValue = experimental[key];
                const existing = dest[key];
                if (existing === undefined) {
                    dest[key] = oldValue;
                } else if (
                    typeof oldValue === "object" &&
                    oldValue !== null &&
                    typeof existing === "object" &&
                    existing !== null
                ) {
                    dest[key] = {
                        ...(oldValue as Record<string, unknown>),
                        ...(existing as Record<string, unknown>),
                    };
                }
                delete experimental[key];
                mcChanged = true;
                log.success(`Migrated experimental.${key} → ${destLabel}${key} (graduated)`);
                fixed++;
            };
            if (experimental) {
                relocateGraduated("temporal_awareness", mcConfig, "");
                relocateGraduated("caveman_text_compression", mcConfig, "");
                relocateGraduated("mural", mcConfig, "");
                const memoryDest = (mcConfig.memory as Record<string, unknown> | undefined) ?? {};
                relocateGraduated("auto_search", memoryDest, "memory.");
                relocateGraduated("git_commit_indexing", memoryDest, "memory.");
                if (Object.keys(memoryDest).length > 0) {
                    mcConfig.memory = memoryDest;
                }
                // The migration preserves an empty `experimental` object because its header comment is anchored to that object.
                // `experimental` deletion also removes its attached comment.
                if (Object.keys(experimental).length === 0 && "experimental" in mcConfig) {
                    delete mcConfig.experimental;
                    mcChanged = true;
                }
            }

            if (migrateDreamerV2ForDoctor(mcConfig)) {
                mcChanged = true;
                log.success(
                    "Migrated legacy dreamer scheduling → per-task dreamer.tasks (window→cron, blocks→tasks)",
                );
                fixed++;
            }

            // `compartment_token_budget` is ignored because model context derives the budget.
            if ("compartment_token_budget" in mcConfig) {
                delete mcConfig.compartment_token_budget;
                mcChanged = true;
                log.success(
                    "Removed deprecated compartment_token_budget (auto-derived from model context now)",
                );
                fixed++;
            }

            if (mcChanged) {
                writeFileAtomic(paths.magicContextConfig, `${stringify(mcConfig, null, 2)}\n`);
            }
        } catch {
            log.warn("Could not migrate deprecated config keys in magic-context.jsonc");
        }
    }

    if (paths.opencodeConfigFormat !== "none") {
        try {
            const raw = readFileSync(paths.opencodeConfig, "utf-8");
            const config = parse(raw) as Record<string, unknown>;
            // The migration preserves string entries, tuple entries with options, and dev URLs unchanged on write.
            const rawPlugins: unknown[] = Array.isArray(config?.plugin) ? config.plugin : [];
            const existingIdx = rawPlugins.findIndex(
                (entry) => matchesPluginEntry(entry, PLUGIN_NAME) || isDevPathPluginEntry(entry),
            );
            if (
                rawPlugins.some(
                    (entry) =>
                        isLocalPathPluginEntry(entry) &&
                        String(entry).includes("magic-context") &&
                        !isDevPathPluginEntry(entry),
                )
            ) {
                warn(
                    "An unverifiable local OpenCode plugin path was ignored because its package name is not Magic Context",
                );
            }
            const configName =
                paths.opencodeConfigFormat === "jsonc" ? "opencode.jsonc" : "opencode.json";

            // `pluginEntryName` extracts a tuple's package-name slot for `@latest` comparison.
            const entryAsString = (entry: unknown): string | null => {
                if (typeof entry === "string") return entry;
                if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
                return null;
            };

            if (
                existingIdx >= 0 &&
                entryAsString(rawPlugins[existingIdx]) === PLUGIN_ENTRY_WITH_VERSION
            ) {
                pass(`Plugin registered in ${configName}`);
            } else if (existingIdx >= 0) {
                const oldEntry = rawPlugins[existingIdx];
                const oldEntryStr = entryAsString(oldEntry) ?? "";

                // The migration detects dev-path entries and leaves them unchanged to avoid disabling local checkouts.
                // under --force.
                if (isDevPathPluginEntry(oldEntry)) {
                    pass(`Plugin registered in ${configName} (dev path: ${oldEntryStr})`);
                } else {
                    const isPinned = isPinnedOpenCodePluginSpecifier(oldEntryStr);

                    if (isPinned && !options.force) {
                        // The migration warns without changing pinned entries.
                        warn(
                            `Plugin pinned to ${oldEntryStr} in ${configName} — use 'doctor --force' to upgrade`,
                        );
                    } else {
                        // The migration upgrades versionless entries to `@latest`; `--force` also upgrades pinned entries.
                        // For tuple entries, the migration updates only the package-name slot and preserves options; for string entries, it replaces the entry.
                        if (Array.isArray(oldEntry) && oldEntry.length >= 1) {
                            const replacement = [...oldEntry];
                            replacement[0] = PLUGIN_ENTRY_WITH_VERSION;
                            rawPlugins[existingIdx] = replacement;
                        } else {
                            rawPlugins[existingIdx] = PLUGIN_ENTRY_WITH_VERSION;
                        }
                        config.plugin = rawPlugins;
                        writeFileAtomic(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
                        pass(
                            `Upgraded plugin entry in ${configName}: ${oldEntryStr} → ${PLUGIN_ENTRY_WITH_VERSION}`,
                        );
                        fixed++;
                    }
                }
            } else {
                // The migration adds the plugin without modifying existing tuple entries or their options.
                rawPlugins.push(PLUGIN_ENTRY_WITH_VERSION);
                config.plugin = rawPlugins;
                writeFileAtomic(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
                pass(`Added plugin to ${configName}`);
                fixed++;
            }
        } catch {
            warn("Could not parse opencode config to verify plugin entry");
        }
    }

    // Doctor resolves compaction mode through the loader and accessor used at plugin boot.
    // On load failure, the helper returns false, preserves native compaction fields, and emits a diagnostic.
    const cwd = process.cwd();
    const compactionEnabled = resolveCompactionEnabledForDoctor();
    const conflictResult = detectConflicts(cwd, { compactionEnabled });

    // Doctor uses the file-based compaction check because it has no OpenCode server handle.
    log.info(
        "Compaction check: file-based; the running server's resolved config may differ — `opencode debug config` is authoritative",
    );

    if (conflictResult.hasConflict) {
        for (const reason of conflictResult.reasons) {
            fail(`Conflict: ${reason}`);
        }
        // When `compactionEnabled` is false, Doctor does not repair native `compaction.auto` or `compaction.prune` fields.
        // DCP and OMO hook fixes run whether `compactionEnabled` is true or false.
        const actions = fixConflicts(cwd, conflictResult.conflicts, { compactionEnabled });
        for (const action of actions) {
            pass(`Fixed: ${action}`);
            fixed++;
        }
        if (actions.length > 0) {
            warn("Restart OpenCode for conflict fixes to take effect");
        }
    } else {
        // When compaction is off, native `compaction.auto=true` activates native compaction and is not a conflict.
        if (!compactionEnabled) {
            if (conflictResult.nativeCompaction.auto || conflictResult.nativeCompaction.prune) {
                pass(
                    "No conflicts detected (compaction, DCP, OMO hooks) — native compaction active (compaction-off mode)",
                );
            } else {
                warn(
                    "No compaction manager is active: Magic Context compaction is off and OpenCode auto-compaction is disabled",
                );
            }
        } else {
            pass("No conflicts detected (compaction, DCP, OMO hooks)");
        }
    }

    const tuiAdded = ensureTuiPluginEntry();
    if (tuiAdded) {
        pass("Added TUI sidebar plugin to tui.json");
        warn("Restart OpenCode to see the sidebar");
        fixed++;
    } else if (existsSync(paths.tuiConfig)) {
        // The upgrader preserves tuple options and dev-path entries when updating the TUI plugin.
        try {
            const tuiRaw = readFileSync(paths.tuiConfig, "utf-8");
            const tuiConfig = parse(tuiRaw) as Record<string, unknown>;
            const tuiRawPlugins: unknown[] = Array.isArray(tuiConfig?.plugin)
                ? tuiConfig.plugin
                : [];
            const tuiIdx = tuiRawPlugins.findIndex(
                (entry) => matchesPluginEntry(entry, PLUGIN_NAME) || isDevPathPluginEntry(entry),
            );
            if (
                tuiRawPlugins.some(
                    (entry) =>
                        isLocalPathPluginEntry(entry) &&
                        String(entry).includes("magic-context") &&
                        !isDevPathPluginEntry(entry),
                )
            ) {
                warn(
                    "An unverifiable local TUI plugin path was ignored because its package name is not Magic Context",
                );
            }
            const tuiEntryAsString = (entry: unknown): string => {
                if (typeof entry === "string") return entry;
                if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
                return "";
            };
            if (tuiIdx >= 0) {
                const tuiEntry = tuiRawPlugins[tuiIdx];
                const tuiEntryStr = tuiEntryAsString(tuiEntry);
                if (isDevPathPluginEntry(tuiEntry)) {
                    pass(`TUI sidebar plugin configured (dev path: ${tuiEntryStr})`);
                } else {
                    const tuiPinned = isPinnedOpenCodePluginSpecifier(tuiEntryStr);
                    if (tuiPinned && !options.force) {
                        warn(
                            `TUI plugin pinned to ${tuiEntryStr} — use 'doctor --force' to upgrade`,
                        );
                    } else if (tuiPinned && options.force) {
                        if (Array.isArray(tuiEntry) && tuiEntry.length >= 1) {
                            const replacement = [...tuiEntry];
                            replacement[0] = PLUGIN_ENTRY_WITH_VERSION;
                            tuiRawPlugins[tuiIdx] = replacement;
                        } else {
                            tuiRawPlugins[tuiIdx] = PLUGIN_ENTRY_WITH_VERSION;
                        }
                        tuiConfig.plugin = tuiRawPlugins;
                        writeFileAtomic(paths.tuiConfig, `${stringify(tuiConfig, null, 2)}\n`);
                        pass(`Upgraded TUI plugin: ${tuiEntryStr} → ${PLUGIN_ENTRY_WITH_VERSION}`);
                        fixed++;
                    } else {
                        pass("TUI sidebar plugin configured");
                    }
                }
            } else {
                fail("TUI sidebar plugin is missing after the repair attempt");
            }
        } catch (error) {
            fail(
                `Could not verify TUI sidebar config: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    } else {
        fail("Could not create or verify the TUI sidebar config");
    }

    // A non-empty `review-user-memories` schedule enables user-memory collection.
    // Dreamer must run before promoting candidates.
    if (existsSync(paths.magicContextConfig)) {
        try {
            const mcRaw = readFileSync(paths.magicContextConfig, "utf-8");
            const mcConfig = parse(mcRaw) as Record<string, unknown>;
            const warning = checkUserMemoriesDreamerCompatibility(mcConfig);
            if (warning) {
                log.warn(warning);
                issues++;
            }
        } catch {
        }
    }

    // Doctor probes the configured endpoint before semantic memory search so configuration errors fail before search.
    const embeddingCheck = await checkEmbeddingConfig(paths.magicContextConfig);
    issues += embeddingCheck.issues;
    if (embeddingCheck.issues > 0) failCount += embeddingCheck.issues;
    else if (embeddingCheck.unverified) warnCount++;
    else passCount++;

    // The DB checks detect corrupted files and misaligned storage paths before use.
    const dbPath = join(getMagicContextStorageDir(), "context.db");
    if (!existsSync(dbPath)) {
        log.info(`Shared context DB not yet created at ${dbPath} (will be created on first run)`);
    } else {
        log.info(`Shared context DB exists at ${dbPath}`);
        try {
            // Run schema compatibility checks before integrity checks so an older CLI cannot report a newer database schema healthy.
            // An older CLI cannot report a database with a newer schema healthy.
            const db = openExistingContextDatabase(dbPath, { readonly: true });
            if (db === null) {
                throw new Error(`Shared context DB no longer exists at ${dbPath}`);
            }
            try {
                pass("Opened the shared DB with a supported schema");
                // The storage-version check compares the live DB schema with this binary's fence.
                const storageVersions = readStorageVersions(db);
                log.info(formatStorageVersions(storageVersions));
                const fenceCheck = checkStorageVersionFence(storageVersions);
                if (fenceCheck.alarm) fail(fenceCheck.message);
                else log.info(fenceCheck.message);
                try {
                    const integrity = db.prepare("PRAGMA integrity_check").get() as
                        | { integrity_check?: string }
                        | undefined;
                    const result = integrity?.integrity_check ?? "unknown";
                    if (result === "ok") pass("SQLite integrity_check: ok");
                    else
                        fail(
                            `SQLite integrity_check reported: ${result}\n${formatDatabaseRepairGuidance(dbPath)}`,
                        );
                } catch (err) {
                    fail(
                        `SQLite integrity_check failed: ${err instanceof Error ? err.message : String(err)}\n${formatDatabaseRepairGuidance(dbPath)}`,
                    );
                }

                // Row counts are informational and do not affect pass/fail status.
                try {
                    const counts: Record<string, number> = {};
                    for (const table of ["tags", "compartments", "notes", "claims", "dream_runs"]) {
                        try {
                            const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as
                                | { c?: number }
                                | undefined;
                            counts[table] = row?.c ?? 0;
                        } catch {
                            // A brand-new DB may lack the queried table before migrations run.
                            counts[table] = 0;
                        }
                    }
                    const summary = Object.entries(counts)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ");
                    log.info(`Shared DB row counts: ${summary}`);
                } catch {
                    // Row-count introspection failures do not fail doctor.
                }
            } finally {
                db.close();
            }
        } catch (err) {
            if (err instanceof UnsupportedSchemaVersionError) {
                fail(
                    checkStorageVersionFence({
                        context_db_schema_version: err.persistedVersion,
                        plugin_supported_version: err.supportedVersion,
                    }).message,
                );
            } else {
                fail(
                    `Could not open shared DB: ${err instanceof Error ? err.message : String(err)}\n${formatDatabaseRepairGuidance(dbPath)}`,
                );
            }
        }
    }

    const cacheResult = await clearPluginCache({
        force: options.force,
        latestVersion: pluginNpmLatest,
    });
    if (cacheResult.action === "cleared") {
        const versionInfo = cacheResult.cached
            ? ` (cached: ${cacheResult.cached}${cacheResult.latest ? `, latest: ${cacheResult.latest}` : ""})`
            : "";
        const reason = cacheResult.latest
            ? "outdated plugin cache"
            : "plugin cache (latest version check unavailable)";
        pass(`Cleared ${reason}${versionInfo} — latest will download on restart`);
        log.info(`  ${cacheResult.path}`);
        fixed++;
    } else if (cacheResult.action === "up_to_date") {
        pass(`Plugin cache up to date (v${cacheResult.cached})`);
    } else if (cacheResult.action === "check_unavailable") {
        warn(
            `Plugin cache version check unavailable; preserving cached plugin${cacheResult.cached ? ` (cached: ${cacheResult.cached})` : ""}. Use doctor --force to reinstall it.`,
        );
    } else if (cacheResult.action === "error") {
        warn(`Could not clear plugin cache: ${cacheResult.error}`);
        if (cacheResult.clearedPaths && cacheResult.clearedPaths.length > 0) {
            log.info(`  Cleared roots: ${cacheResult.clearedPaths.join(", ")}`);
        }
        if (cacheResult.failedPaths && cacheResult.failedPaths.length > 0) {
            log.info(`  Failed roots: ${cacheResult.failedPaths.join(", ")}`);
        } else {
            log.info(`  Manually delete: ${cacheResult.path}`);
        }
        issues++;
    } else {
        pass("Plugin cache clean (no cached version found)");
    }

    // OpenCode installs plugins through npm, so npm's age guards apply.
    // The unified CLI uses npx, and the auto-update checker uses npm install; neither reads bunfig.toml.
    // bunfig.
    {
        const ageWarnings = collectNpmReleaseAgeWarnings();

        if (ageWarnings.length > 0) {
            log.warn(
                "npm min-release-age restriction detected — this can prevent OpenCode from installing the latest plugin version",
            );
            for (const w of ageWarnings) {
                log.info(`  ${w}`);
            }
            log.info(
                "  If the plugin stays on an old version after doctor --force, this is the likely cause.",
            );
            log.info(
                "  Workaround: temporarily remove the restriction, restart OpenCode, then re-enable it.",
            );
            issues++;
        }
    }


    const logPath = getMagicContextLogPath("opencode");
    if (existsSync(logPath)) {
        const logStat = statSync(logPath);
        const sizeKb = (logStat.size / 1024).toFixed(0);
        log.info(`Log file: ${logPath} (${sizeKb} KB)`);
    } else {
        log.info(`Log file: ${logPath} (not yet created)`);
    }

    // We group dumps by project so users can identify each project's dumps.
    const diagnostics = await collectDiagnostics();
    const dumpBuckets = diagnostics.historianDumps.byProject;
    if (dumpBuckets.length > 0) {
        const totalCount = dumpBuckets.reduce((sum, b) => sum + b.count, 0);
        const sessionCount = dumpBuckets.length;
        warn(`Historian debug dumps: ${totalCount} file(s) across ${sessionCount} project(s)`);
        for (const bucket of dumpBuckets) {
            log.info(`  [${bucket.directory}] ${bucket.count} file(s)`);
            for (const dump of bucket.recent.slice(0, 3)) {
                const age = dump.ageMinutes;
                const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
                log.info(`    ${dump.name} (${ageStr})`);
            }
            if (bucket.count > 3) {
                log.info(`    ... and ${bucket.count - 3} more`);
            }
        }
    }
    const legacy = diagnostics.historianDumps.legacyDumps;
    if (legacy.count > 0) {
        log.info(`Legacy historian dumps (pre-v0.18.x): ${legacy.count} file(s) in ${legacy.dir}`);
    }

    if (paths.omoConfig) {
        log.info(`OMO config found: ${paths.omoConfig}`);
    }

    console.log("");
    log.message(`Summary: PASS ${passCount} / WARN ${warnCount} / FAIL ${failCount}`);
    if (issues === 0 && fixed === 0) {
        outro("Everything looks good! ✨");
    } else if (issues > 0 && fixed > 0) {
        outro(`Found ${issues} issue(s), fixed ${fixed}. Restart OpenCode to apply.`);
    } else if (fixed > 0) {
        outro(`Fixed ${fixed} issue(s). Restart OpenCode to apply.`);
    } else {
        outro(`Found ${issues} issue(s) that need manual attention.`);
        return 1;
    }

    return 0;
}
