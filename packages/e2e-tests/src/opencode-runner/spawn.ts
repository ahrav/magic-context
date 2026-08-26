/**
 * Spawn an isolated `opencode serve` process with:
 * - its own config/data directories (no pollution of the user's real setup)
 * - a custom mock-anthropic provider pointed at our mock server
 * - the magic-context plugin loaded from local source via `file://` spec
 *
 * Returns the server URL and a handle with `kill()` for test cleanup.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initializeIsolatedContextDb } from "../initialize-context-db";
import { waitForChildExit } from "../process-exit";
import { releaseRootPath, type VerifiedReleaseRoot } from "../prospective-holdout/release-root";
import {
    buildDirectHostFixture,
    detectRustModePrereqs,
    HermeticMcHostStack,
} from "../rust-runner/hermetic-mc-host";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
// Prefer the built bundle over raw `src/index.ts`. The bundle is one file with
// all imports inlined and loads fast even on a cold runner, while the TS-source
// path triggers Bun's runtime transpile and dynamic resolution across hundreds
// of submodule imports — enough on a slow CI runner to make `opencode serve`
// look hung when it is only blocked in plugin load. Production never loads from
// src/, so the source path also tests a slowness users never see.
const PLUGIN_DIST_ENTRY = join(REPO_ROOT, "packages/plugin/dist/index.js");
const PLUGIN_SRC_ENTRY = join(REPO_ROOT, "packages/plugin/src/index.ts");
const PLUGIN_ENTRY = existsSync(PLUGIN_DIST_ENTRY)
    ? PLUGIN_DIST_ENTRY
    : PLUGIN_SRC_ENTRY;

export interface IsolatedEnv {
    configDir: string;
    dataDir: string;
    cacheDir: string;
    workdir: string;
}

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
    /** URL of the mock Anthropic server, e.g. "http://127.0.0.1:12345" */
    mockProviderURL: string;
    /** Port for opencode serve. Default: random available */
    port?: number;
    /** magic-context.jsonc overrides. Defaults keep most features on. */
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
     * Extra environment variables for the opencode child (e.g.
     * MAGIC_CONTEXT_LOG_PATH to redirect the plugin diagnostic log to a
     * per-suite file). Merged last, overriding inherited values.
     */
    extraEnv?: Record<string, string>;
    /** Verified immutable release root. Omitted keeps active-checkout behavior. */
    releaseRoot?: VerifiedReleaseRoot;
}

/**
 * Pick a random free port by asking the OS for one. Uses Bun.serve + immediate stop.
 */
async function pickFreePort(): Promise<number> {
    const server = Bun.serve({ port: 0, fetch: () => new Response() });
    const port: number = server.port ?? 0;
    server.stop(true);
    if (!port) throw new Error("could not allocate a free port");
    return port;
}

/**
 * Create isolated config/data/cache dirs under a unique temp subdir.
 *
 * Exported so the Rust-mode harness can allocate the env up front: it needs the
 * concrete `dataDir` before OpenCode boots so direct host can publish its
 * connection file, and it reuses the same env across a
 * serve restart so opencode.db + context.db survive the restart.
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
 * Write opencode.json + magic-context.jsonc + tui.json into config/workdir.
 *
 * - opencode.json: registers our plugin via file:// spec, defines a mock-anthropic
 *   provider and a mock model, sets provider.mock-anthropic.options.baseURL to the
 *   mock server's URL.
 * - magic-context.jsonc: starts with small thresholds so tests trigger historian
 *   deterministically with modest scripted token counts.
 */
function writeConfigs(
    env: IsolatedEnv,
    mockProviderURL: string,
    opts: SpawnOptions,
): void {
    const pluginEntry = opts.releaseRoot
        ? releaseRootPath(opts.releaseRoot, "opencodePlugin")
        : PLUGIN_ENTRY;
    const pluginSpec = `file://${pluginEntry}`;

    const opencodeConfig: Record<string, unknown> = {
        $schema: "https://opencode.ai/config.json",
        plugin: [pluginSpec],
        // Disable telemetry-style checks that could reach out.
        autoupdate: false,
        // Match what `setup`/`doctor` writes for real users. OpenCode compaction
        // defaults to enabled; if we leave it on, magic-context's conflict
        // detector disables itself and the plugin becomes a no-op.
        compaction: { auto: false, prune: false },
        provider: {
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
                        // Advertise image + pdf input support so OpenCode does
                        // not substitute inline file parts with "this model
                        // does not support X input" text messages. Matches the
                        // real Sonnet capabilities this mock is standing in for.
                        modalities: {
                            input: ["text", "image", "pdf"],
                            output: ["text"],
                        },
                        options: {},
                    },
                },
            },
        },
        ...(opts.openCodeConfigExtra ?? {}),
    };

    // User-tier thresholds stay below project-security raise-only clamps.
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

    // The plugin's loadPluginConfig() looks for magic-context.jsonc under
    // ${XDG_CONFIG_HOME}/opencode/magic-context.jsonc (user config) or
    // <workdir>/magic-context.jsonc (project root).
    //
    // We set XDG_CONFIG_HOME=env.configDir in the child env, so the user
    // config path resolves to env.configDir/opencode/magic-context.jsonc.
    // Put the file there; a sibling one in env.configDir is never read.
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

    // tui.json: not needed for headless serve, but harmless to emit nothing for now.
}

/**
 * Wait until the opencode server responds to GET /doc (an endpoint that exists in
 * OpenCode's server). Polls for up to `timeoutMs`.
 *
 * Implementation note — Bun fetch timeout flake:
 *   Bun's default `fetch()` has a hardcoded ~5 minute timeout that ignores
 *   AbortSignal.timeout values longer than the limit
 *   (https://github.com/oven-sh/bun/issues/16682). If we don't bound each
 *   fetch attempt explicitly, a single hung request can hold the loop for
 *   the entire ~5 minute window, blowing past our overall deadline before
 *   we get any chance to retry. Pass a short AbortSignal.timeout on every
 *   attempt so one bad fetch can't starve the deadline.
 */
// Default bumped from 30s → 300s. GitHub-hosted runners can take much longer
// than 30s for `opencode serve` to bind its port + finish plugin init + complete
// opencode's own one-time SQLite migration (which opencode itself warns "may
// take a few minutes" on first boot per fresh CI XDG_DATA_HOME). Local hardware
// finishes in <2s. The bump to 300s covers CI cold-start without papering over
// genuine readiness failures — 5 minutes is still far above any realistic boot.
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
                // Server is responding — any HTTP response means it booted.
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
 * Reject when the child fails to spawn or exits before readiness. A child that
 * starts and then dies (bad flag, unusable config, taken port) emits no
 * `error`, so without the `exit` arm the startup race only ends when
 * `waitForReady` burns its whole timeout. Every settle path detaches both child
 * listeners, so a child that outlives the race retains neither.
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

/** Provision direct host before OpenCode so it can publish its connection file. */
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
        // This env has no other owner yet: `cleanup()` only runs for a stack
        // that started, and the process reaper only kills recorded PIDs. A
        // surviving dataDir is the stack's record that its own teardown could
        // not reclaim it — the leaked fixture's PID file lives there and is the
        // next run's only handle on that process — so the tree stays put then.
        if (!existsSync(env.dataDir)) {
            try {
                rmSync(dirname(env.dataDir), { recursive: true, force: true });
            } catch {
                // Temp litter never masks the startup failure.
            }
        }
        throw new Error(
            `MC_E2E_MODE=rust failed to start direct mc-host fixture: ${String(error)}`,
        );
    }
}

async function spawnOpencodeWithProvision(
    opts: SpawnOptions,
    provision: () => Promise<RustSpawnResources>,
): Promise<SpawnedOpencode> {
    // MC_E2E_MODE is intentionally read only at this shared spawn seam. Rust
    // suites that already supplied a host connection keep their existing
    // stack; ordinary suites get one provisioned here for the rust invocation.
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

        // Reuse a caller-provided env for the Rust-mode harness (connection file
        // pre-placed, data dir shared across a serve restart); otherwise allocate.
        const env = resolvedOpts.existingEnv ?? createIsolatedEnv();
        const port = resolvedOpts.port ?? (await pickFreePort());

        const compaction = resolvedOpts.openCodeConfigExtra?.compaction as
            | { auto?: unknown }
            | undefined;
        if (compaction?.auto !== true) initializeIsolatedContextDb(env.dataDir, resolvedOpts.releaseRoot);
        writeConfigs(env, resolvedOpts.mockProviderURL, resolvedOpts);

        // Explicitly strip any inherited OPENCODE_SERVER_PASSWORD from the parent shell —
        // our tests run unsecured on a random localhost port, and inherited auth would
        // force every SDK request to carry Basic auth headers we don't set.
        // Also strip NODE_ENV=test: Bun's test runner sets it automatically and the
        // plugin's logger (src/shared/logger.ts) silences all output when NODE_ENV=test.
        // We want the subprocess to behave like a real install, so the log file gets
        // populated normally for diagnostics.
        const childEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value === undefined) continue;
            if (key === "OPENCODE_SERVER_PASSWORD") continue;
            if (key === "OPENCODE_SERVER_USERNAME") continue;
            if (key === "NODE_ENV") continue;
            // Strip any inherited supervised-launch identity. These are still the
            // live variable names (`mc_host::wire::SUBC_MODULE_ID_ENV` /
            // `SUBC_LAUNCH_NONCE_ENV`), and `historian_producer` reads them into
            // `consumer_module_id`/`consumer_launch_nonce` on every route identity.
            // When the test process is itself launched under a supervisor that sets
            // them, the plugin would present THAT identity to our hermetic host,
            // which rejects it as not matching a supervised launch nonce. A real
            // install is never launched under a supervised identity, so clearing
            // them matches production. Harmless for TS-mode suites, which never
            // reach the Rust client.
            if (key === "SUBC_MODULE_ID") continue;
            if (key === "SUBC_LAUNCH_NONCE") continue;
            childEnv[key] = value;
        }
        childEnv.OPENCODE_CONFIG_DIR = env.configDir;
        childEnv.XDG_CONFIG_HOME = env.configDir;
        childEnv.XDG_DATA_HOME = env.dataDir;
        childEnv.XDG_CACHE_HOME = env.cacheDir;
        // Ensure anthropic doesn't bail for missing env vars — we use a fake key.
        childEnv.ANTHROPIC_API_KEY = "test-key-not-real";
        // Caller overrides (e.g. MAGIC_CONTEXT_LOG_PATH pointing the plugin log at a
        // per-suite file so Rust-mode scenarios can assert on transform decisions).
        // Merged last so an explicit override wins over the inherited value.
        for (const [key, value] of Object.entries(resolvedOpts.extraEnv ?? {})) {
            childEnv[key] = value;
        }

        // Bind to 0.0.0.0 (all interfaces) instead of 127.0.0.1 — empirically on
        // GitHub-hosted runners, opencode binding to 127.0.0.1 sometimes results
        // in Bun's `fetch()` timing out even though `curl` succeeds. Binding all
        // interfaces removes any loopback-specific stack-resolution edge case
        // (IPv4-only AF_INET vs IPv4-mapped IPv6, AF_UNSPEC name resolution, etc.).
        // Clients still connect to `127.0.0.1:${port}` — only the listen socket
        // changes. Safe locally too: process is short-lived, port is random.
        child = spawn(
            "opencode",
            ["serve", "--port", String(port), "--hostname", "0.0.0.0"],
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
    initializeIsolatedContextDb,
    rejectOnSpawnError,
    stopChild,
    spawnOpencodeWithProvision,
    writeConfigs,
};
