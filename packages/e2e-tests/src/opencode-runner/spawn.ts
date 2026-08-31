/**
 * The test environment uses separate config and data directories to avoid modifying the user's setup.
 *
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { storageSubtreePath } from "../../../plugin/src/shared/data-path";
import { isSecretKey } from "../../../plugin/src/shared/redaction";
import { createDirectTestDatabase } from "../../../plugin/src/features/magic-context/test-database";
import { initializeIsolatedContextDb as initializeContextDbFromRelease } from "../initialize-context-db";
import { waitForChildExit } from "../process-exit";
import { releaseRootPath, type VerifiedReleaseRoot } from "../prospective-holdout/release-root";
import { isSensitiveEnvKey } from "../secret-env-keys";
import {
    buildDirectHostFixture,
    detectRustModePrereqs,
    HermeticMcHostStack,
} from "../rust-runner/hermetic-mc-host";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
// Use the bundle: loading `src/index.ts` can delay startup enough to exhaust readiness polling on slow CI.
const PLUGIN_DIST_ENTRY = join(REPO_ROOT, "packages/plugin/dist/index.js");
const PLUGIN_SRC_ENTRY = join(REPO_ROOT, "packages/plugin/src/index.ts");
/**
 *
 * Resolve the entrypoint at spawn time so a bundle built after import is selected.
 *
 */
export function pluginEntryPath(): string {
    return existsSync(PLUGIN_DIST_ENTRY) ? PLUGIN_DIST_ENTRY : PLUGIN_SRC_ENTRY;
}

/** Exported for provenance: a caller recording which plugin bytes ran needs the
 *  same bundle path this module loads, not a second copy of the join. */
export const PLUGIN_BUNDLE_ENTRY = PLUGIN_DIST_ENTRY;
export const PLUGIN_REPO_ROOT = REPO_ROOT;

function initializeIsolatedContextDb(
    dataDir: string,
    releaseRoot?: VerifiedReleaseRoot,
): void {
    if (releaseRoot) {
        initializeContextDbFromRelease(dataDir, releaseRoot);
        return;
    }
    const path = join(storageSubtreePath(dataDir), "context.db");
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    createDirectTestDatabase({ path }).db.close();
}

export interface IsolatedEnv {
    configDir: string;
    dataDir: string;
    cacheDir: string;
    workdir: string;
}

/**
 * `ServeHostname` permits only addresses reachable at `http://127.0.0.1:${port}`.
 *
 * Otherwise readiness polling times out because the fixed client URL cannot reach the listener.
 * Adding another address requires deriving the client URL from it, including IPv6 brackets.
 */
export type ServeHostname = "0.0.0.0" | "127.0.0.1";

export interface SpawnedOpencode {
    url: string;
    port: number;
    env: IsolatedEnv;
    kill: () => Promise<void>;
    stdout: () => string;
    stderr: () => string;
    /** Direct host fixture provisioned for MC_E2E_MODE=rust. */
    mcHostStack?: HermeticMcHostStack;
}

export interface SpawnOptions {
    /* */
    mockProviderURL: string;
    /** Port for opencode serve. Default: random available */
    port?: number;
    /* */
    magicContextConfig?: Record<string, unknown>;
    /** Extra opencode.json provider/model config, merged with defaults. */
    openCodeConfigExtra?: Record<string, unknown>;
    /** Override the mock model's context token limit. Default 200000. */
    modelContextLimit?: number;
    /** Reuse an isolated env so direct host starts before OpenCode and survives serve restarts. */
    existingEnv?: IsolatedEnv;
    /** User-tier host connection file used by Rust mode. */
    userMcHostConnectionFile?: string;
    /** `projectMagicContextConfig` is written to `<workdir>/.cortexkit/magic-context.jsonc` when set. */
    projectMagicContextConfig?: Record<string, unknown>;
    /**
     * extraEnv overrides inherited environment variables.
     */
    extraEnv?: Record<string, string>;
    /**
     * hostname defaults to "0.0.0.0".
     * Bind to `0.0.0.0` so readiness polling can reach the server.
     * The serve HTTP API is unauthenticated.
     * Spawns with real child-environment credentials must use "127.0.0.1".
     * Using "127.0.0.1" keeps the unauthenticated API off non-loopback interfaces.
     */
    hostname?: ServeHostname;
    /**
     * allowSecretEnvOffLoopback permits non-loopback serving only for fake fixture credentials.
     */
    allowSecretEnvOffLoopback?: boolean;
    /** Omitting `releaseRoot` initializes `context.db` from the active checkout. */
    releaseRoot?: VerifiedReleaseRoot;
}

/**
 */
async function pickFreePort(): Promise<number> {
    const server = Bun.serve({ port: 0, fetch: () => new Response() });
    const port: number = server.port ?? 0;
    server.stop(true);
    if (!port) throw new Error("could not allocate a free port");
    return port;
}

/**
 *
 * The direct host needs dataDir before OpenCode starts to publish its connection file.
 * Reusing the environment preserves opencode.db and context.db across serve restarts.
 */
export function createIsolatedEnv(): IsolatedEnv {
    const unique = `opencode-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const base = join(tmpdir(), unique);
    const configDir = join(base, "config");
    const dataDir = join(base, "data");
    const cacheDir = join(base, "cache");
    const workdir = join(base, "work");
    for (const d of [configDir, dataDir, cacheDir, workdir]) {
        mkdirSync(d, { recursive: true });
    }
    return { configDir, dataDir, cacheDir, workdir };
}

/**
 *
 * - magic-context.jsonc: starts with small thresholds so tests trigger historian
 */
function writeConfigs(
    env: IsolatedEnv,
    mockProviderURL: string,
    opts: SpawnOptions,
): void {
    const pluginEntry = opts.releaseRoot
        ? releaseRootPath(opts.releaseRoot, "opencodePlugin")
        : pluginEntryPath();
    const pluginSpec = `file://${pluginEntry}`;
    const extra = opts.openCodeConfigExtra ?? {};
    const contributedProviders = extra.provider;
    /** Everything in `openCodeConfigExtra` is written into the config an unauthenticated serve reads, not just the provider map, so an MCP `Authorization` header would sit behind the same remotely reachable API. commentlint: allow(JUDGE) */
    assertConfigHasNoCredentials(extra);
    const extraWithoutProvider = { ...extra };
    delete extraWithoutProvider.provider;

    const opencodeConfig: Record<string, unknown> = {
        $schema: "https://opencode.ai/config.json",
        plugin: [pluginSpec],
        // `autoupdate: false` disables telemetry-style checks that make network requests.
        autoupdate: false,
        // OpenCode enables compaction by default; magic-context disables its conflict detector when compaction is enabled.
        // When compaction is enabled, magic-context disables its conflict detector and the plugin does nothing.
        compaction: { auto: false, prune: false },
        provider: {
            ...(contributedProviders && typeof contributedProviders === "object"
                ? contributedProviders
                : {}),
            "mock-anthropic": {
                api: "@ai-sdk/anthropic",
                name: "Mock Anthropic",
                npm: "@ai-sdk/anthropic",
                env: [],
                options: {
                    apiKey: "test-key-not-real",
                    baseURL: mockProviderURL,
                },
                models: {
                    "mock-sonnet": {
                        id: "mock-sonnet",
                        name: "Mock Sonnet",
                        cost: { input: 0, output: 0 },
                        limit: { context: opts.modelContextLimit ?? 200000, output: 8192 },
                        // The mock advertises image and PDF input so OpenCode preserves inline file parts.
                        // OpenCode replaces inline file parts for unsupported inputs with text error messages.
                        // The mock mirrors Sonnet's image and PDF input capabilities.
                        modalities: {
                            input: ["text", "image", "pdf"],
                            output: ["text"],
                        },
                        options: {},
                    },
                },
            },
        },
        ...extraWithoutProvider,
    };

    const magicContext: Record<string, unknown> = {
        $schema:
            "https://raw.githubusercontent.com/ahrav/magic-context/main/assets/magic-context.schema.json",
        execute_threshold_percentage: 40,
        history_budget_percentage: 0.15,
        dreamer: { disable: true },
        sidekick: { disable: true },
        ...(opts.magicContextConfig ?? {}),
    };
    if (opts.userMcHostConnectionFile) {
        Object.assign(magicContext, {
            subc: { connection_file: opts.userMcHostConnectionFile },
        });
    }

    writeFileSync(join(env.configDir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));

    //
    // The child environment sets XDG_CONFIG_HOME to env.configDir, so user configuration resolves under env.configDir/opencode.
    const userConfigDir = join(env.configDir, "opencode");
    mkdirSync(userConfigDir, { recursive: true });
    writeFileSync(
        join(userConfigDir, "magic-context.jsonc"),
        JSON.stringify(magicContext, null, 2),
    );

    if (opts.projectMagicContextConfig) {
        const projectConfigDir = join(env.workdir, ".cortexkit");
        mkdirSync(projectConfigDir, { recursive: true });
        writeFileSync(
            join(projectConfigDir, "magic-context.jsonc"),
            JSON.stringify(
                {
                    $schema:
                        "https://raw.githubusercontent.com/ahrav/magic-context/main/assets/magic-context.schema.json",
                    ...opts.projectMagicContextConfig,
                },
                null,
                2,
            ),
        );
    }

}

/** `isSecretKey` needs a qualifier segment before its secret word, so header names that carry a credential without one — `Cookie`, `Proxy-Authorization` — are named here instead. commentlint: allow(JUDGE) */
const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set([
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "www-authenticate",
    "proxy-authenticate",
]);

function isCredentialShapedConfigKey(key: string): boolean {
    return isSecretKey(key) || CREDENTIAL_HEADER_NAMES.has(key.trim().toLowerCase());
}

/**
 * `assertConfigHasNoCredentials` matches key names and never values, so
 * `opencode.json` can still contain a credential stored under an innocuous key.
 */
function assertConfigHasNoCredentials(value: unknown): void {
    const seen = new WeakSet<object>();
    const visit = (current: unknown, path: string): void => {
        if (current === null || typeof current !== "object" || seen.has(current)) return;
        seen.add(current);
        for (const [key, child] of Object.entries(current)) {
            const childPath = `${path}.${key}`;
            if (!Array.isArray(current) && isCredentialShapedConfigKey(key)) {
                throw new Error(
                    `config contains credential-shaped key: ${childPath}; ` +
                        "pass credentials through extraEnv",
                );
            }
            visit(child, childPath);
        }
    };
    visit(value, "openCodeConfigExtra");
}

/**
 *
 * Bun limits fetch to about five minutes even when AbortSignal.timeout is longer; bound each attempt so retries can honor the overall deadline.
 * Each fetch attempt uses a timeout so a hung fetch cannot consume the overall retry deadline.
 */
// OpenCode readiness allows up to 300 seconds for first-run initialization in CI.
// GitHub-hosted runners can delay OpenCode readiness while the server initializes plugins and first-run state.
// OpenCode can perform a one-time SQLite migration when CI uses a fresh XDG_DATA_HOME.
async function waitForReady(
    url: string,
    timeoutMs = 300_000,
    cancellation?: AbortSignal,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const FETCH_TIMEOUT_MS = 2_000;
    let lastFetchErr: unknown = null;
    let fetchAttempts = 0;

    while (Date.now() < deadline) {
        if (cancellation?.aborted) throw new Error("opencode readiness cancelled");
        try {
            fetchAttempts++;
            const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
            const res = await fetch(`${url}/doc`, {
                method: "GET",
                signal: cancellation ? AbortSignal.any([timeout, cancellation]) : timeout,
            });
            if (res.ok || res.status === 404 || res.status === 401) {
                // A 2xx, 401, or 404 response confirms that the server is reachable.
                return;
            }
        } catch (err) {
            if (cancellation?.aborted) throw new Error("opencode readiness cancelled");
            lastFetchErr = err;
        }
        await Bun.sleep(200);
    }
    throw new Error(
        `opencode serve did not become ready in ${timeoutMs}ms.\n` +
            `  url=${url}/doc\n` +
            `  fetchAttempts=${fetchAttempts}\n` +
            `  fetchLastErr=${String(lastFetchErr)}`,
    );
}

interface RustSpawnResources {
    env: IsolatedEnv;
    connectionFile: string;
    mcHost: HermeticMcHostStack;
}

/**
 * The readiness wait rejects when the child fails to spawn or exits before readiness.
 * A child can start and then die without emitting `error`; handling `exit` prevents the startup race from waiting for its timeout.
 */
function rejectOnSpawnError(child: ChildProcess, cancellation?: AbortSignal): Promise<never> {
    return new Promise((_, rejectSpawn) => {
        const detach = (): void => {
            child.off("error", onError);
            child.off("exit", onExit);
        };
        const onError = (error: Error): void => {
            detach();
            cancellation?.removeEventListener("abort", onAbort);
            rejectSpawn(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
            detach();
            cancellation?.removeEventListener("abort", onAbort);
            rejectSpawn(
                new Error(
                    `opencode serve exited before readiness (code=${code}, signal=${signal})`,
                ),
            );
        };
        const onAbort = (): void => {
            detach();
        };
        if (cancellation?.aborted) return;
        child.once("error", onError);
        child.once("exit", onExit);
        cancellation?.addEventListener("abort", onAbort, { once: true });
    });
}

async function stopChild(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;

    const exitedAfterTerm = waitForChildExit(child, timeoutMs);
    child.kill("SIGTERM");
    if (await exitedAfterTerm) return;

    const exitedAfterKill = waitForChildExit(child, timeoutMs);
    child.kill("SIGKILL");
    if (!(await exitedAfterKill)) {
        throw new Error("opencode serve did not exit after SIGKILL");
    }
}

/** The direct host is provisioned before OpenCode so OpenCode can publish its connection file. */
async function provisionRustMode(releaseRoot?: VerifiedReleaseRoot): Promise<RustSpawnResources> {
    const prereqs = detectRustModePrereqs(releaseRoot);
    if (!prereqs.ok) {
        throw new Error(
            `MC_E2E_MODE=rust prerequisite failure: ${prereqs.skipReason ?? "unknown prerequisite"}`,
        );
    }
    const fixtureBin = await buildDirectHostFixture(releaseRoot);
    const env = createIsolatedEnv();
    try {
        const mcHost = await HermeticMcHostStack.start({ dataDir: env.dataDir, fixtureBin });
        return { env, connectionFile: mcHost.connectionFile, mcHost };
    } catch (error) {
        // A surviving `dataDir` records failed teardown because it contains the leaked fixture's PID file.
        // The next run uses the leaked fixture's PID file as its only handle on that process.
        // Preserving `dataDir` lets the next run reclaim the leaked process from its PID file.
        if (!existsSync(env.dataDir)) {
            try {
                rmSync(dirname(env.dataDir), { recursive: true, force: true });
            } catch {
                // Preserving a leaked `dataDir` does not mask the startup failure.
            }
        }
        throw new Error(
            `MC_E2E_MODE=rust failed to start direct mc-host fixture: ${String(error)}`,
        );
    }
}

/**
 *
 * The explicit environment list prevents the child from inheriting runner variables.
 * port.
 */
function isInheritableEnvKey(key: string): boolean {
    // Tests run unsecured on a random localhost port; inherited auth would require Basic headers that SDK requests do not set.
    if (key === "OPENCODE_SERVER_PASSWORD" || key === "OPENCODE_SERVER_USERNAME") return false;
    // Exclude `NODE_ENV` because Bun sets it to `test`, which silences the plugin logger.
    // Exclude `NODE_ENV` so the subprocess writes diagnostic logs.
    if (key === "NODE_ENV") return false;
    // The harness clears `SUBC_MODULE_ID` and `SUBC_LAUNCH_NONCE` because an inherited supervisor identity makes the plugin send a nonce the hermetic host rejects.
    // The hermetic host rejects an inherited supervisor identity whose nonce does not match a supervised launch.
    if (key === "SUBC_MODULE_ID" || key === "SUBC_LAUNCH_NONCE") return false;
    // Ambient secrets are never forwarded.
    // Ambient secrets would be exposed through the unauthenticated API to any process that reaches the port.
    // The child uses the mock provider; credentialed spawns pass credentials through `extraEnv`.
    // Dropping ambient secrets leaves `extraEnv` as the only caller-secret channel, so `assertSecretsBoundToLoopback` covers all caller secrets.
    if (isSensitiveEnvKey(key)) return false;
    return true;
}

/**
 * The spawn path rejects caller-supplied secrets on non-loopback interfaces.
 *
 * The spawned environment's default `ANTHROPIC_API_KEY` is a fixture value.
 * Checking the assembled environment would reject every default spawn because it contains the fake `ANTHROPIC_API_KEY`.
 *
 * `assertSecretsBoundToLoopback` does not inspect credentials embedded in `openCodeConfigExtra`.
 * `writeConfigs` applies `assertConfigHasNoCredentials` to that channel instead.
 *
 * `Pick<SpawnOptions>` permits forwarding `extraEnv` without `hostname`.
 * Omitting `hostname` uses the all-interfaces default.
 * `extraEnv` secrets reach the unauthenticated serve API when `hostname` falls back to `0.0.0.0`.
 *
 * `assertSecretsBoundToLoopback` runs before provisioning to avoid creating Rust resources for rejected spawns.
 * `isSensitiveEnvKey` matches names because fake credentials cannot be distinguished from real credentials by value.
 * `allowSecretEnvOffLoopback` permits explicitly waived sensitive environment variables off loopback.
 * `assertSafeExtraEnv` rejects sensitive environment variables with the same predicate.
 */
function assertSecretsBoundToLoopback(
    resolvedOpts: SpawnOptions,
    hostname: ServeHostname,
): void {
    if (hostname === "127.0.0.1" || resolvedOpts.allowSecretEnvOffLoopback) return;
    const secretKeys = Object.keys(resolvedOpts.extraEnv ?? {}).filter(isSensitiveEnvKey);
    if (secretKeys.length === 0) return;
    throw new Error(
        `refusing to bind the unauthenticated serve API to ${hostname} while extraEnv carries ` +
            `${secretKeys.join(", ")}. Pass hostname: "127.0.0.1" to keep the API on loopback, ` +
            `or allowSecretEnvOffLoopback: true if the value is a fake fixture credential.`,
    );
}

async function spawnOpencodeWithProvision(
    opts: SpawnOptions,
    provision: () => Promise<RustSpawnResources>,
): Promise<SpawnedOpencode> {
    const hostname = opts.hostname ?? "0.0.0.0";
    assertSecretsBoundToLoopback(opts, hostname);

    // `MC_E2E_MODE` is evaluated at this shared spawn path so Rust suites share provisioning behavior.
    const rustMode = process.env.MC_E2E_MODE === "rust";
    const resources = rustMode && !opts.userMcHostConnectionFile ? await provision() : null;

    let child: ChildProcess | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
        cleanupPromise ??= (async () => {
            let cleanupError: unknown;
            if (child) {
                try {
                    await stopChild(child);
                } catch (error) {
                    cleanupError = error;
                }
            }
            try {
                await resources?.mcHost.stop();
            } catch (error) {
                cleanupError ??= error;
            }
            if (cleanupError !== undefined) throw cleanupError;
        })();
        return cleanupPromise;
    };

    let stdoutBuf = "";
    let stderrBuf = "";
    try {
        const resolvedOpts: SpawnOptions = resources
            ? {
                  ...opts,
                  existingEnv: resources.env,
                  userMcHostConnectionFile: resources.connectionFile,
                  projectMagicContextConfig: {
                      ...(opts.projectMagicContextConfig ?? {}),
                      transform_mode: "rust",
                  },
              }
            : opts;

        const env = resolvedOpts.existingEnv ?? createIsolatedEnv();
        const port = resolvedOpts.port ?? (await pickFreePort());

        const compaction = resolvedOpts.openCodeConfigExtra?.compaction as
            | { auto?: unknown }
            | undefined;
        if (compaction?.auto !== true) initializeIsolatedContextDb(env.dataDir, resolvedOpts.releaseRoot);
        writeConfigs(env, resolvedOpts.mockProviderURL, resolvedOpts);

        const childEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value === undefined) continue;
            if (!isInheritableEnvKey(key)) continue;
            childEnv[key] = value;
        }
        childEnv.OPENCODE_CONFIG_DIR = env.configDir;
        childEnv.XDG_CONFIG_HOME = env.configDir;
        childEnv.XDG_DATA_HOME = env.dataDir;
        childEnv.XDG_CACHE_HOME = env.cacheDir;
        childEnv.ANTHROPIC_API_KEY = "test-key-not-real";
        for (const [key, value] of Object.entries(resolvedOpts.extraEnv ?? {})) {
            childEnv[key] = value;
        }

        // Sensitive `extraEnv` requires `hostname: "127.0.0.1"` unless `allowSecretEnvOffLoopback` is true.
        child = spawn(
            "opencode",
            [
                "serve",
                "--port",
                String(port),
                "--hostname",
                hostname,
            ],
            {
                cwd: env.workdir,
                env: childEnv,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        child.stdout?.on("data", (chunk: Buffer) => {
            stdoutBuf += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderrBuf += chunk.toString();
        });

        const url = `http://127.0.0.1:${port}`;
        const startup = new AbortController();
        try {
            await Promise.race([
                waitForReady(url, 300_000, startup.signal),
                rejectOnSpawnError(child, startup.signal),
            ]);
        } finally {
            startup.abort();
        }

        return {
            url,
            port,
            env,
            stdout: () => stdoutBuf,
            stderr: () => stderrBuf,
            mcHostStack: resources?.mcHost,
            kill: cleanup,
        };
    } catch (error) {
        let cleanupError: unknown;
        try {
            await cleanup();
        } catch (failure) {
            cleanupError = failure;
        }
        throw new Error(
            `opencode serve failed to start.\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}\n\n${String(error)}` +
                (cleanupError === undefined ? "" : `\ncleanup failed: ${String(cleanupError)}`),
        );
    }
}

export function spawnOpencode(opts: SpawnOptions): Promise<SpawnedOpencode> {
    return spawnOpencodeWithProvision(opts, () => provisionRustMode(opts.releaseRoot));
}

export const __spawnOpencodeTest = {
    assertSecretsBoundToLoopback,
    isInheritableEnvKey,
    initializeIsolatedContextDb,
    rejectOnSpawnError,
    stopChild,
    spawnOpencodeWithProvision,
    writeConfigs,
};
