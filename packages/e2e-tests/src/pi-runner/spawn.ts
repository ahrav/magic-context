/* */

import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { releaseRootPath, type VerifiedReleaseRoot } from "../prospective-holdout/release-root";

export const REPO_ROOT = resolve(import.meta.dir, "../../../..");
export const PI_PLUGIN_ROOT = join(REPO_ROOT, "packages/pi-plugin");
const require_ = createRequire(import.meta.url);

function compareSemver(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part));
  const right = b.split(".").map((part) => Number(part));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function resolvePiPackageJson(): string {
  try {
    return require_.resolve("@earendil-works/pi-coding-agent/package.json");
  } catch {
    const bunModules = join(REPO_ROOT, "node_modules/.bun");
    const prefix = "@earendil-works+pi-coding-agent@";
    const candidates = readdirSync(bunModules, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => {
        const version = entry.name.slice(prefix.length).split("+")[0] ?? "0.0.0";
        return { name: entry.name, version };
      })
      .sort((a, b) => compareSemver(b.version, a.version));
    const best = candidates[0];
    if (best === undefined) {
      throw new Error(`Could not locate @earendil-works/pi-coding-agent under ${bunModules}`);
    }
    return join(
      bunModules,
      best.name,
      "node_modules/@earendil-works/pi-coding-agent/package.json",
    );
  }
}

export const PI_PACKAGE_JSON = resolvePiPackageJson();
export const PI_CLI = join(dirname(PI_PACKAGE_JSON), "dist/cli.js");

export interface PiIsolatedEnv {
  baseDir: string;
  configDir: string;
  dataDir: string;
  cacheDir: string;
  workdir: string;
  agentDir: string;
  pluginDir: string;
}

export interface PiRunResult {
  sessionId: string | null;
  events: Array<Record<string, unknown>>;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

export interface PiRunnerOptions {
  mockProviderURL: string;
  env?: PiIsolatedEnv;
  magicContextConfig?: Record<string, unknown>;
  piSettingsExtra?: Record<string, unknown>;
  modelContextLimit?: number;
  /** `continueSession` is ignored because RPC sessions persist without it. */
  continueSession?: boolean;
  /** `releaseRoot` selects a verified immutable release root; omitting it uses the active checkout. */
  releaseRoot?: VerifiedReleaseRoot;
}

export type PiSpawnOptions = PiRunnerOptions;

export function createPiIsolatedEnv(sharedDataDir?: string): PiIsolatedEnv {
  const unique = `pi-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const baseDirRaw = join(tmpdir(), unique);
  mkdirSync(baseDirRaw, { recursive: true });
  const baseDir = realpathSync(baseDirRaw);
  const configDir = join(baseDir, "config");
  const dataDir = sharedDataDir ? realpathSync(sharedDataDir) : join(baseDir, "data");
  const cacheDir = join(baseDir, "cache");
  const workdir = join(baseDir, "work");
  const agentDir = join(baseDir, ".pi", "agent");
  const pluginDir = join(agentDir, "extensions", "pi-magic-context");
  for (const d of [configDir, dataDir, cacheDir, workdir, agentDir, join(agentDir, "extensions")]) {
    mkdirSync(d, { recursive: true });
  }

  // Real paths prevent `/var` and `/private/var` identity drift on macOS.
  return {
    baseDir: realpathSync(baseDir),
    configDir: realpathSync(configDir),
    dataDir: realpathSync(dataDir),
    cacheDir: realpathSync(cacheDir),
    workdir: realpathSync(workdir),
    agentDir: realpathSync(agentDir),
    pluginDir,
  };
}

export function ensurePluginAvailable(env: PiIsolatedEnv, releaseRoot?: VerifiedReleaseRoot): void {
  if (!releaseRoot) {
    if (!existsSync(join(PI_PLUGIN_ROOT, "dist", "index.js"))) {
      throw new Error(
        `${join(PI_PLUGIN_ROOT, "dist", "index.js")} is missing. Run: cd packages/pi-plugin && bun run build`,
      );
    }
    if (!existsSync(env.pluginDir)) symlinkSync(PI_PLUGIN_ROOT, env.pluginDir, "dir");
    return;
  }
  // Pi resolves an extension by reading `pi.extensions` from the `package.json`
  // Pi requires each `settings.packages` entry to be a package directory.
  // The release root declares the built entrypoint rather than its package directory.
  // `env.pluginDir` wraps the release entrypoint in a package directory.
  // Pi loads the release-root artifact; only its package wrapper is local.
  const entrypoint = releaseRootPath(releaseRoot, "piPlugin");
  if (!existsSync(entrypoint)) {
    throw new Error(`Pi plugin artifact is missing: ${entrypoint}`);
  }
  if (existsSync(env.pluginDir)) return;
  mkdirSync(env.pluginDir, { recursive: true });
  symlinkSync(entrypoint, join(env.pluginDir, "index.js"), "file");
  writeFileSync(
    join(env.pluginDir, "package.json"),
    `${JSON.stringify({ name: "pi-magic-context", version: "0.0.0", pi: { extensions: ["./index.js"] } }, null, 2)}\n`,
  );
}

export function writeConfigs(env: PiIsolatedEnv, opts: PiRunnerOptions): void {
  ensurePluginAvailable(env, opts.releaseRoot);

  const settings = {
    packages: [env.pluginDir],
    defaultProvider: "anthropic",
    defaultModel: "claude-haiku-4-5",
    enabledModels: ["anthropic/claude-haiku-4-5"],
    compaction: { enabled: false },
    retry: { enabled: false },
    quietStartup: true,
    enableInstallTelemetry: false,
    ...(opts.piSettingsExtra ?? {}),
  };
  writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify(settings, null, 2));

  const models = {
    providers: {
      anthropic: {
        baseUrl: opts.mockProviderURL,
        apiKey: "test-key-not-real",
        modelOverrides: {
          "claude-haiku-4-5": {
            contextWindow: opts.modelContextLimit ?? 200000,
            maxTokens: 8192,
            reasoning: false,
          },
        },
      },
    },
  };
  writeFileSync(join(env.agentDir, "models.json"), JSON.stringify(models, null, 2));

  const magicContext = {
    $schema:
      "https://raw.githubusercontent.com/ahrav/magic-context/main/assets/magic-context.schema.json",
    enabled: true,
    protected_tags: 1,
    execute_threshold_percentage: 40,
    history_budget_percentage: 0.15,
    memory: {
      enabled: true,
      auto_promote: false,
      auto_search: { enabled: false },
      git_commit_indexing: { enabled: false },
    },
    embedding: { provider: "off" },
    historian: { model: "" },
    dreamer: { disable: true },
    sidekick: { disable: true },
    ...(opts.magicContextConfig ?? {}),
  };
  writeFileSync(join(env.agentDir, "magic-context.jsonc"), JSON.stringify(magicContext, null, 2));
}

export function childEnv(env: PiIsolatedEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "NODE_ENV") continue;
    result[key] = value;
  }
  result.PI_CODING_AGENT_DIR = env.agentDir;
  result.HOME = env.baseDir;
  result.XDG_CONFIG_HOME = env.configDir;
  result.XDG_DATA_HOME = env.dataDir;
  result.XDG_CACHE_HOME = env.cacheDir;
  result.ANTHROPIC_API_KEY = "test-key-not-real";
  result.PI_OFFLINE = "1";
  result.PI_SKIP_VERSION_CHECK = "1";
  return result;
}
