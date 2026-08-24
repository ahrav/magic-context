import { chmodSync, mkdirSync } from "node:fs";
import { open, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { getMagicContextStorageDir } from "../../../shared/data-path";
import { log } from "../../../shared/logger";
import { shouldEnforcePrivateStoragePermissions } from "../../../shared/storage-permissions";
import {
    getEmbeddingProviderIdentity,
    getLocalEmbeddingRecipe,
    type LocalEmbeddingPooling,
    type LocalEmbeddingRecipe,
} from "./embedding-identity";
import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";

/** The dtype enum values accepted by @huggingface/transformers' feature-extraction
 *  pipeline (keyof typeof DATA_TYPES in transformers/types/utils/dtypes.d.ts).
 *  Kept as a literal union so the config schema, identity fold, and pipeline
 *  call share one source of truth. See issue #259. */
export type LocalEmbeddingDtype =
    | "auto"
    | "fp32"
    | "fp16"
    | "q8"
    | "int8"
    | "uint8"
    | "q4"
    | "bnb4"
    | "q4f16"
    | "q2"
    | "q2f16"
    | "q1"
    | "q1f16";

// The recipe definitions live in embedding-identity.ts because the recipe
// participates in the provider identity; re-exported here so provider users
// keep one import surface for local-embedding concerns.
export {
    getLocalEmbeddingRecipe,
    type LocalEmbeddingPooling,
    type LocalEmbeddingRecipe,
} from "./embedding-identity";

/**
 * Cross-process mutex for embedding-model load. When two OpenCode processes
 * spawn simultaneously (typical Desktop sidecar + TUI + dashboard setup), they
 * can both call onnxruntime-node's `InferenceSession::LoadModel` on the same
 * cached `.onnx` file at the same wall-clock time. Older onnxruntime-node
 * builds (<=1.21.0 / native lib 1.14.0) could double-free an internal
 * `IoBinding` during cleanup when this happened, producing SIGBUS/SIGTRAP
 * crashes inside the worker thread and silently killing the TUI.
 *
 * See https://github.com/cortexkit/magic-context/issues/21.
 *
 * Transformers v4 / onnxruntime-node 1.24.x ships a much newer native library
 * and is expected to handle this, but we add a belt-and-suspenders file lock
 * so two processes never call `createPipeline()` at the exact same instant.
 *
 * Contract:
 *   - Uses `open(path, "wx")` — atomic-create with exclusive flag on POSIX,
 *     and the equivalent on Windows (ERROR_FILE_EXISTS).
 *   - Writes our PID + timestamp to the lock file for diagnostics.
 *   - If the lock is held by another process, polls every 150ms.
 *   - Treats a lock file older than `STALE_LOCK_MS` as stale (crashed holder)
 *     and takes it over.
 *   - If we cannot acquire the lock within `MAX_LOCK_WAIT_MS`, we log a
 *     warning and proceed without the lock rather than blocking embedding
 *     forever. Model load failures in this case are caught by the retry loop.
 */
const LOCK_POLL_MS = 150;
const STALE_LOCK_MS = 3 * 60_000; // 3 minutes — model loads are typically <30s
const MAX_LOCK_WAIT_MS = 5 * 60_000; // 5 minutes

async function acquireModelLoadLock(lockPath: string): Promise<() => Promise<void>> {
    const waitStart = Date.now();
    while (true) {
        try {
            const handle = await open(lockPath, "wx");
            // Best-effort write of PID + timestamp for diagnostics.
            try {
                await handle.writeFile(`pid=${process.pid} started=${Date.now()}\n`);
            } catch {
                /* non-fatal */
            }
            await handle.close();
            return async () => {
                try {
                    await unlink(lockPath);
                } catch {
                    /* already gone / race — ignore */
                }
            };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // On Windows, Node can surface EEXIST as EPERM for this case.
            if (code !== "EEXIST" && code !== "EPERM") {
                throw error;
            }
            // Lock exists — check if it's stale.
            try {
                const info = await stat(lockPath);
                if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
                    log(
                        `[magic-context] embedding-load lock stale (>${STALE_LOCK_MS}ms), taking over`,
                    );
                    try {
                        await unlink(lockPath);
                    } catch {
                        /* another process may have cleaned it up — retry acquire */
                    }
                    continue;
                }
            } catch {
                // Lock disappeared between create-fail and stat — retry acquire.
                continue;
            }
            if (Date.now() - waitStart > MAX_LOCK_WAIT_MS) {
                // Do NOT proceed without the lock. A genuinely stuck holder is
                // already reclaimed by the STALE_LOCK_MS takeover above (the
                // lock's heartbeat stops if its process died), so reaching this
                // branch means a LEGITIMATE slow model load is still running in
                // another process — exactly when an unsynchronized
                // createPipeline() here would reintroduce the onnxruntime
                // double-free native crash (issue #21) the lock exists to
                // prevent. Fail this init attempt instead; the caller catches,
                // sets pipeline=null, and the lazy fallback retries on a later
                // pass once the holder finishes.
                throw new Error(
                    `[magic-context] embedding-load lock wait exceeded ${MAX_LOCK_WAIT_MS}ms; another process is still loading the model. Skipping this init attempt to avoid an unsynchronized native load.`,
                );
            }
            await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        }
    }
}

// Touch the lock file periodically so a long-running model load doesn't get
// misdetected as stale by another waiting process.
function startLockHeartbeat(lockPath: string): () => void {
    const HEARTBEAT_MS = Math.floor(STALE_LOCK_MS / 3);
    const timer = setInterval(() => {
        // writeFile with fresh content updates mtime; any error is non-fatal.
        writeFile(lockPath, `pid=${process.pid} alive=${Date.now()}\n`).catch(() => {});
    }, HEARTBEAT_MS);
    // Don't keep the event loop alive solely for the heartbeat.
    timer.unref?.();
    return () => clearInterval(timer);
}

/**
 * Pre-inject the WASM ONNX runtime so transformers.js skips its native
 * `onnxruntime-node` path entirely.
 *
 * Why this exists:
 *   `@huggingface/transformers@4.x` does a top-level static `import "onnxruntime-node"`.
 *   On Electron Desktop (e.g. OpenCode Desktop's main process), that native
 *   `.node` binary fails to load for several environmental reasons — missing
 *   Visual C++ Redistributables on Windows, ASAR archive layout issues,
 *   onnxruntime's own dependency DLLs not being resolvable. The failure
 *   propagates up the import chain and Node reports it as `ERR_MODULE_NOT_FOUND`
 *   targeting `transformers.node.mjs`, even though that file exists.
 *
 *   transformers.js exposes `Symbol.for("onnxruntime")` as an override hook
 *   (added in 3.4.x via PR #1231). If that global symbol is set before the
 *   first `import("@huggingface/transformers")`, the library uses whatever ORT
 *   we provide instead of attempting its own native-or-web backend selection.
 *
 *   `onnxruntime-web` (WASM backend) is already a direct dependency of
 *   `@huggingface/transformers`, so it's installed alongside `onnxruntime-node`
 *   with no extra package needed. WASM is slower than native CPU on Node/Bun
 *   but on Electron Desktop it's the only path that actually loads.
 *
 * Why only Electron:
 *   Plain Node and Bun runtimes (Pi, terminal OpenCode, dashboard backend)
 *   load `onnxruntime-node` correctly. We don't want to regress those to WASM.
 *   `process.versions.electron` is the canonical check — it's only present
 *   inside Electron processes.
 *
 * Refs:
 *   - https://github.com/cortexkit/magic-context/issues/78
 *   - https://github.com/huggingface/transformers.js/pull/1231 (ORT_SYMBOL)
 *   - https://github.com/huggingface/transformers.js/issues/1240 (Electron picks wrong ORT)
 */
async function injectWasmOrtForElectron(): Promise<boolean> {
    if (typeof process === "undefined" || !process.versions?.electron) {
        return false;
    }

    try {
        // Non-literal specifier — same trick we use for `@huggingface/transformers`
        // to keep Bun's static analyzer from eagerly probing the package at plugin
        // load time. We need lazy resolution because non-Electron runtimes never
        // need onnxruntime-web at all. See issue #4.
        const ortWebSpec = `onnxruntime-${"web"}`;
        const ortWeb = (await import(ortWebSpec)) as {
            env?: { wasm?: { wasmPaths?: string | Record<string, string> } };
            default?: unknown;
        };

        // Resolve the actual on-disk location of onnxruntime-web/dist/ so we can
        // point WASM loading at the local .wasm/.mjs files rather than the
        // jsdelivr CDN. Without this, the first embedding init would require
        // network access — and would fail offline or behind corporate proxies.
        try {
            const { createRequire: createRequireFn } = await import("node:module");
            const requireFn = createRequireFn(import.meta.url);
            // Resolve the package's MAIN export ('.') rather than its
            // package.json: onnxruntime-web ships an `exports` map that does NOT
            // expose './package.json' (resolving it throws ERR_PACKAGE_PATH_NOT_
            // EXPORTED), whereas '.' is always exported and lands inside dist/.
            // Its dirname is the dist/ dir that holds the .wasm/.mjs assets. See
            // issue #195.
            const mainEntry = requireFn.resolve("onnxruntime-web");
            const distDir = dirname(mainEntry);
            const wasmPathsPrefix = `${pathToFileURL(distDir).href}/`;
            if (ortWeb.env?.wasm) {
                ortWeb.env.wasm.wasmPaths = wasmPathsPrefix;
            }
        } catch (pathError) {
            // Non-fatal — onnxruntime-web will fall back to its default CDN.
            // First embedding init may need network, but subsequent ones use
            // the WASM cache. We log and continue rather than blocking embeddings.
            log(
                "[magic-context] could not resolve local onnxruntime-web/dist, falling back to default WASM paths:",
                pathError instanceof Error ? pathError.message : String(pathError),
            );
        }

        // transformers.js does `if (ORT_SYMBOL in globalThis) { ONNX = globalThis[ORT_SYMBOL] }`
        // at module-evaluation time. Setting this BEFORE the first
        // `await import("@huggingface/transformers")` (immediately after this
        // function returns) ensures the library picks up our WASM runtime
        // instead of its own native selection logic.
        (globalThis as Record<symbol, unknown>)[Symbol.for("onnxruntime")] = ortWeb;
        log(
            "[magic-context] Electron detected — using onnxruntime-web (WASM) for embeddings (bypasses onnxruntime-node native load)",
        );
        return true;
    } catch (error) {
        // If onnxruntime-web import itself fails (e.g. it's not installed for
        // some reason), we fall through and let transformers do its normal
        // native load. That will likely fail too, but the error will be the
        // user's actual problem rather than something masked by our shim.
        log(
            "[magic-context] failed to inject onnxruntime-web for Electron — letting transformers fall back to native:",
            error instanceof Error ? error.message : String(error),
        );
        return false;
    }
}

type EmbeddingPipelineResult = {
    data: ArrayLike<number> | ArrayLike<number>[];
    dims?: number[];
};

type EmbeddingPipeline = {
    (
        input: string | string[],
        options: { pooling: LocalEmbeddingPooling; normalize: true },
    ): Promise<EmbeddingPipelineResult>;
    dispose?: () => Promise<void> | void;
};

type CreateEmbeddingPipeline = (
    task: "feature-extraction",
    model: string,
    options: { dtype: string; device?: string },
) => Promise<EmbeddingPipeline>;

/** The dtype the local provider passes to the transformers.js pipeline when the
 *  user does not configure one. This MUST stay "fp32" to preserve today's
 *  behavior exactly — existing installs see zero change on upgrade, and the
 *  default identity string stays byte-identical (local_dtype is only folded
 *  into identity when the user actually sets it). See issue #259. */
const DEFAULT_LOCAL_DTYPE: LocalEmbeddingDtype = "fp32";

/**
 * Temporarily redirects console.warn and console.error to the file logger
 * so that @huggingface/transformers and ONNX runtime never leak to the TUI.
 */
async function withQuietConsole<T>(fn: () => Promise<T>): Promise<T> {
    const origWarn = console.warn;
    const origError = console.error;
    const redirect = (...args: unknown[]) => {
        const message = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
        log(`[transformers] ${message}`);
    };
    console.warn = redirect;
    console.error = redirect;
    try {
        return await fn();
    } finally {
        console.warn = origWarn;
        console.error = origError;
    }
}

/**
 * Recognizes transient ONNX/transformers load failures that should be retried
 * rather than surfaced to the user. Seen in live logs when multiple plugin
 * processes (Desktop sidecar + TUI + dashboard) initialize the embedding
 * pipeline within the same window. The on-disk model file is intact; the
 * failure mode is ephemeral and resolves on retry.
 */
/**
 * Recognizes the PERMANENT "native runtime not installed" failure: the plugin's
 * `@huggingface/transformers` Node entry does a static `import "onnxruntime-node"`,
 * so when that package is missing/broken in the install tree (seen on Windows
 * when its platform binary fails to install, issue #128), the import throws
 * `Cannot find package 'onnxruntime-node'` / `ERR_MODULE_NOT_FOUND` before
 * transformers' own WASM-fallback hook is even reachable. This is environmental,
 * not transient — retrying just re-spams the cryptic resolver error every time an
 * embedding is needed. We latch it and degrade cleanly with one actionable line.
 */
// Process-global latch: once the native ONNX runtime is confirmed missing, every
// LocalEmbeddingProvider in this process short-circuits initialize() instead of
// re-importing transformers and re-failing. Process-global (not per-instance)
// because the missing package affects the whole install, not one model.
let nativeRuntimeMissing = false;

export function isNativeRuntimeMissingError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const lower = message.toLowerCase();
    const code = (error as { code?: unknown } | null)?.code;
    const name = (error as { name?: unknown } | null)?.name;

    // onnxruntime-node IS installed but its native binary fails to LOAD — e.g.
    // Windows missing the VC++ runtime throws ERR_DLOPEN_FAILED on the
    // `onnxruntime_binding.node` file (whose path contains "onnxruntime", not
    // necessarily the literal "onnxruntime-node"). A failed postinstall can also
    // surface as MODULE_NOT_FOUND for `onnxruntime_binding.node`. Both are
    // environmental and permanent, same as the missing-package case: latch and
    // degrade once instead of re-spamming the load error on every embedding.
    if (code === "ERR_DLOPEN_FAILED" && lower.includes("onnxruntime")) {
        return true;
    }

    const mentionsNativeRuntime =
        lower.includes("onnxruntime-node") || lower.includes("onnxruntime_binding");
    if (!mentionsNativeRuntime) return false;
    return (
        code === "ERR_MODULE_NOT_FOUND" ||
        name === "ResolveMessage" ||
        lower.includes("cannot find package") ||
        lower.includes("cannot find module") ||
        lower.includes("err_module_not_found")
    );
}

function isTransientLoadError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (!message) return false;
    const lower = message.toLowerCase();
    return (
        lower.includes("protobuf parsing failed") ||
        lower.includes("unable to get model file path or buffer") ||
        lower.includes("ebusy") ||
        lower.includes("resource busy") ||
        lower.includes("resource temporarily unavailable")
    );
}

function isArrayLikeNumber(value: unknown): value is ArrayLike<number> {
    if (typeof value !== "object" || value === null || !("length" in value)) {
        return false;
    }
    const arr = value as { length: unknown; [key: number]: unknown };
    if (typeof arr.length !== "number") {
        return false;
    }
    // Verify a sample element is numeric (or array is empty)
    return arr.length === 0 || typeof arr[0] === "number";
}

function toFloat32Array(values: ArrayLike<number>): Float32Array {
    // Intentional: defensive copy for Float32Array inputs prevents mutation of pipeline output.
    // The one-time copy cost is negligible compared to inference cost.
    return values instanceof Float32Array
        ? new Float32Array(values)
        : Float32Array.from(Array.from(values));
}

function extractBatchEmbeddings(
    result: EmbeddingPipelineResult,
    expectedCount: number,
): (Float32Array | null)[] {
    const { data } = result;

    if (
        Array.isArray(data) &&
        data.length === expectedCount &&
        data.every((entry) => typeof entry !== "number" && isArrayLikeNumber(entry))
    ) {
        return data.map((entry) => toFloat32Array(entry));
    }

    if (!isArrayLikeNumber(data)) {
        log("[magic-context] embedding batch returned unexpected data shape");
        return Array.from({ length: expectedCount }, () => null);
    }

    const flatData = toFloat32Array(data);
    const dimension = result.dims?.at(-1) ?? flatData.length / expectedCount;

    if (
        !Number.isInteger(dimension) ||
        dimension <= 0 ||
        flatData.length !== expectedCount * dimension
    ) {
        log("[magic-context] embedding batch returned invalid dimensions");
        return Array.from({ length: expectedCount }, () => null);
    }

    const embeddings: Float32Array[] = [];
    for (let index = 0; index < expectedCount; index++) {
        embeddings.push(flatData.slice(index * dimension, (index + 1) * dimension));
    }

    return embeddings;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;
    readonly maxInputTokens: number;

    private readonly model: string;
    private readonly dtype: LocalEmbeddingDtype;
    private readonly recipe: LocalEmbeddingRecipe;
    private pipeline: EmbeddingPipeline | null = null;
    private initPromise: Promise<void> | null = null;
    private inFlight = 0;
    private disposing = false;
    private disposePromise: Promise<void> | null = null;
    private readonly inFlightWaiters: Array<() => void> = [];

    constructor(
        model = DEFAULT_LOCAL_EMBEDDING_MODEL,
        maxInputTokens = 512,
        dtype: LocalEmbeddingDtype = DEFAULT_LOCAL_DTYPE,
    ) {
        // Normalize ONCE and use the same string for the recipe, the identity,
        // and the pipeline load. The identity function trims independently, so
        // an untrimmed direct-construction model would otherwise resolve the
        // symmetric recipe here while the identity hash folds the bound recipe:
        // vectors and identity would disagree about the space.
        const normalizedModel = model.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL;
        this.model = normalizedModel;
        this.maxInputTokens = maxInputTokens;
        this.dtype = dtype || DEFAULT_LOCAL_DTYPE;
        this.recipe = getLocalEmbeddingRecipe(normalizedModel);
        this.modelId = getEmbeddingProviderIdentity({
            provider: "local",
            model: normalizedModel,
            // Only fold non-default dtype into identity so the default config
            // produces the byte-identical identity string as before this field
            // existed (no forced re-embed on upgrade). See issue #259.
            ...(dtype && dtype !== DEFAULT_LOCAL_DTYPE ? { local_dtype: dtype } : {}),
        });
    }

    async initialize(): Promise<boolean> {
        if (this.disposing) {
            return false;
        }

        if (this.pipeline) {
            return true;
        }

        // Native runtime confirmed missing earlier this process — don't re-import
        // transformers just to re-fail and re-spam the resolver error (issue #128).
        if (nativeRuntimeMissing) {
            return false;
        }

        if (this.initPromise) {
            await this.initPromise;
            return this.pipeline !== null;
        }

        this.initPromise = (async () => {
            try {
                if (this.disposing) {
                    return;
                }

                // Pre-inject WASM ORT runtime for Electron Desktop. This MUST run
                // before the first `await import("@huggingface/transformers")` below
                // — transformers.js reads `Symbol.for("onnxruntime")` at module
                // evaluation time and uses whatever we provide instead of doing its
                // own native-vs-web backend selection. No-op on plain Node/Bun.
                // See: https://github.com/cortexkit/magic-context/issues/78
                const injectedWasmOrt = await injectWasmOrtForElectron();

                // Non-literal import specifier prevents Bun from eagerly resolving
                // @huggingface/transformers at plugin load time. Desktop sidecar spawns
                // hit ENOENT on JSDoc-referenced files inside transformers' webpack dist
                // when the literal string triggers Bun's static module analysis.
                // See: https://github.com/cortexkit/magic-context/issues/4
                const transformersSpec = `@huggingface/${"transformers"}`;
                const transformersModule = (await import(transformersSpec)) as Record<
                    string,
                    unknown
                >;
                const env = transformersModule.env as {
                    logLevel?: unknown;
                    cacheDir?: string;
                };
                const LogLevel = transformersModule.LogLevel as Record<string, unknown> | undefined;
                if (LogLevel && "ERROR" in LogLevel) {
                    env.logLevel = LogLevel.ERROR;
                }

                // Set a stable model cache directory outside of node_modules.
                // On Windows, the default .cache inside the npm cached install
                // (e.g. ~\.cache\opencode\packages\...\node_modules\@huggingface\transformers\.cache)
                // can be inaccessible or non-writable, causing "Unable to get model file path
                // or buffer" failures. Using our own storage dir survives plugin updates too.
                const modelCacheDir = join(getMagicContextStorageDir(), "models");
                try {
                    // Keep the cache owner-only by default because it shares the
                    // storage tree with memories/history. Trusted-group deployments
                    // manage this directory externally, so skip both mode creation
                    // and chmod rather than attempting a different permission change.
                    if (shouldEnforcePrivateStoragePermissions()) {
                        mkdirSync(modelCacheDir, { recursive: true, mode: 0o700 });
                        if (process.platform !== "win32") {
                            try {
                                chmodSync(modelCacheDir, 0o700);
                            } catch {
                                // Non-fatal — leave default perms if chmod is rejected.
                            }
                        }
                    } else {
                        mkdirSync(modelCacheDir, { recursive: true });
                    }
                    env.cacheDir = modelCacheDir;
                } catch {
                    // Non-fatal — fall back to library default if we can't create the dir
                    log("[magic-context] could not create model cache dir, using library default");
                }
                const createPipeline = transformersModule.pipeline as CreateEmbeddingPipeline;

                // Cross-process lock — serializes InferenceSession::LoadModel
                // across concurrently-starting OpenCode processes. See the
                // doc block on `acquireModelLoadLock` and issue #21.
                const lockPath = join(modelCacheDir, ".load.lock");
                const releaseLock = await acquireModelLoadLock(lockPath);
                const stopHeartbeat = startLockHeartbeat(lockPath);
                try {
                    // Retry loop absorbs transient failures seen when multiple plugin
                    // processes initialize the ONNX session around the same time:
                    //   - "Protobuf parsing failed" (onnxruntime-node race on mmap/page cache)
                    //   - "Unable to get model file path or buffer" (download still in progress)
                    //   - EBUSY / file lock contention
                    // Recovery happens within a few hundred ms. The file on disk is fine;
                    // we verified this on live logs with matching SHA256 vs HuggingFace.
                    const MAX_ATTEMPTS = 3;
                    let lastError: unknown;
                    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                        try {
                            // NOTE: transformers v4 deprecated the `quantized: boolean`
                            // flag in favor of `dtype` as the canonical precision option.
                            // `this.dtype` defaults to "fp32" to preserve the prior
                            // behavior exactly; a user-configured `embedding.local_dtype`
                            // (e.g. "q8" for a quantized multilingual model) flows through
                            // here. See issue #259.
                            //
                            // device: "auto" is REQUIRED when we injected our own ORT
                            // via Symbol.for("onnxruntime") (the Electron WASM path):
                            // transformers then skips its device-registration branch, so
                            // supportedDevices stays []. Any concrete device (incl. the
                            // "cpu" it defaults to under IS_NODE_ENV) fails the
                            // supportedDevices.includes(device) check and throws
                            // `Unsupported device: "cpu"`. "auto" returns supportedDevices
                            // verbatim ([]) without that check, so onnxruntime-web uses its
                            // own default (wasm) execution provider. Native Node/Bun keeps
                            // the default selection (no device option). See issue #195.
                            const pipeline = await withQuietConsole(() =>
                                createPipeline("feature-extraction", this.model, {
                                    dtype: this.dtype,
                                    ...(injectedWasmOrt ? { device: "auto" } : {}),
                                }),
                            );
                            if (this.disposing) {
                                await pipeline.dispose?.();
                                this.pipeline = null;
                            } else {
                                this.pipeline = pipeline;
                            }
                            lastError = undefined;
                            break;
                        } catch (error) {
                            lastError = error;
                            if (!isTransientLoadError(error) || attempt === MAX_ATTEMPTS) {
                                break;
                            }
                            // Jittered backoff: 300ms + random 0-200ms, grows by attempt.
                            const delayMs = 300 * attempt + Math.floor(Math.random() * 200);
                            log(
                                `[magic-context] embedding model load attempt ${attempt}/${MAX_ATTEMPTS} failed transiently, retrying in ${delayMs}ms`,
                            );
                            await new Promise((resolve) => setTimeout(resolve, delayMs));
                        }
                    }

                    if (this.pipeline) {
                        log(`[magic-context] embedding model loaded: ${this.model}`);
                    } else if (this.disposing) {
                        return;
                    } else {
                        throw lastError ?? new Error("unknown embedding load failure");
                    }
                } finally {
                    stopHeartbeat();
                    await releaseLock();
                }
            } catch (error) {
                if (isNativeRuntimeMissingError(error)) {
                    // Permanent, environmental: latch so we degrade once and stop
                    // re-importing (which would re-spam the cryptic resolver error
                    // on every embedding). One actionable line; local embeddings
                    // are disabled for this process until the install is repaired.
                    nativeRuntimeMissing = true;
                    log(
                        "[magic-context] local embeddings are disabled because the " +
                            "onnxruntime-node native binding is missing or failed to load. " +
                            "Run `npx @cortexkit/magic-context@latest doctor` for repair " +
                            "guidance (use `doctor --force` to reinstall cached plugin packages), " +
                            "or configure an `openai-compatible` embedding HTTP endpoint. " +
                            "Existing memories are unaffected.",
                    );
                } else {
                    log("[magic-context] embedding model failed to load:", error);
                }
                this.pipeline = null;
            } finally {
                this.initPromise = null;
            }
        })();

        await this.initPromise;
        return this.pipeline !== null;
    }

    private waitForInFlightToDrain(): Promise<void> {
        if (this.inFlight === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.inFlightWaiters.push(resolve);
        });
    }

    private finishInFlight(): void {
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.inFlight !== 0) return;
        const waiters = this.inFlightWaiters.splice(0);
        for (const waiter of waiters) {
            waiter();
        }
    }

    async embed(
        text: string,
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<Float32Array | null> {
        // Local inference is fast (typically <100ms) and can't be cancelled
        // mid-compute with transformers.js, so we honor `signal` only as a
        // pre-flight check — callers whose timeout already fired get null
        // without starting fresh inference work.
        if (signal?.aborted) return null;
        if (this.disposing) return null;

        this.inFlight += 1;

        try {
            if (!(await this.initialize())) {
                return null;
            }

            const pipeline = this.pipeline;
            if (!pipeline) {
                return null;
            }

            const input =
                purpose === "query" && this.recipe.queryPrefix
                    ? `${this.recipe.queryPrefix}${text}`
                    : text;
            const result = await withQuietConsole(() =>
                pipeline(input, {
                    pooling: this.recipe.pooling,
                    normalize: true,
                }),
            );

            return extractBatchEmbeddings(result, 1)[0] ?? null;
        } catch (error) {
            log("[magic-context] embedding failed:", error);
            return null;
        } finally {
            this.finishInFlight();
        }
    }

    async embedBatch(
        texts: string[],
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<(Float32Array | null)[]> {
        if (texts.length === 0) {
            return [];
        }

        if (signal?.aborted) {
            return Array.from({ length: texts.length }, () => null);
        }

        if (this.disposing) {
            return Array.from({ length: texts.length }, () => null);
        }

        this.inFlight += 1;

        try {
            if (!(await this.initialize())) {
                return Array.from({ length: texts.length }, () => null);
            }

            const pipeline = this.pipeline;
            if (!pipeline) {
                return Array.from({ length: texts.length }, () => null);
            }

            const inputs =
                purpose === "query" && this.recipe.queryPrefix
                    ? texts.map((text) => `${this.recipe.queryPrefix}${text}`)
                    : texts;
            const result = await withQuietConsole(() =>
                pipeline(inputs, {
                    pooling: this.recipe.pooling,
                    normalize: true,
                }),
            );

            return extractBatchEmbeddings(result, texts.length);
        } catch (error) {
            log("[magic-context] embedding batch failed:", error);
            return Array.from({ length: texts.length }, () => null);
        } finally {
            this.finishInFlight();
        }
    }

    async dispose(): Promise<void> {
        if (this.disposePromise) {
            return this.disposePromise;
        }

        this.disposing = true;
        this.disposePromise = (async () => {
            if (this.initPromise) {
                await this.initPromise;
            }

            await this.waitForInFlightToDrain();

            const pipelineToDispose = this.pipeline;
            this.pipeline = null;
            this.initPromise = null;
            if (!pipelineToDispose) {
                return;
            }

            try {
                await pipelineToDispose.dispose?.();
            } catch (error) {
                log("[magic-context] embedding model dispose failed:", error);
            }
        })();

        return this.disposePromise;
    }

    isLoaded(): boolean {
        return this.pipeline !== null;
    }
}
