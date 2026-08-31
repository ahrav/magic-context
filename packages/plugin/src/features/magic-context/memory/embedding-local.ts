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

/**
 * */
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

// The recipe participates in the provider identity, so its definitions remain in `embedding-identity.ts` and are re-exported here.
// The re-export preserves a single import surface for local-embedding consumers.
export {
    getLocalEmbeddingRecipe,
    type LocalEmbeddingPooling,
    type LocalEmbeddingRecipe,
} from "./embedding-identity";

/**
 * `acquireModelLoadLock` serializes embedding-model loading across processes.
 * When two OpenCode processes spawn simultaneously, they can load the same cached model concurrently.
 * Two OpenCode processes can call `InferenceSession::LoadModel` on the same cached `.onnx` file simultaneously.
 *
 * See https://github.com/cortexkit/magic-context/issues/21.
 *
 *
 * Contract:
 * `acquireModelLoadLock` uses `open(path, "wx")` for atomic exclusive creation on POSIX.
 * On Windows, `"wx"` reports an existing lock through the equivalent exclusive-create failure.
 * The lock acquisition writes the process PID and start timestamp for diagnostics.
 */
const LOCK_POLL_MS = 150;
const STALE_LOCK_MS = 3 * 60_000; // 3 minutes — model loads are typically <30s
const MAX_LOCK_WAIT_MS = 5 * 60_000; // 5 minutes

async function acquireModelLoadLock(lockPath: string): Promise<() => Promise<void>> {
    const waitStart = Date.now();
    while (true) {
        try {
            const handle = await open(lockPath, "wx");
            // A failed diagnostic write does not release the acquired lock.
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
                    /* The release ignores unlink failures because another process may have removed the lock file. */
                }
            };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // On Windows, Node can surface EEXIST as EPERM for this case.
            if (code !== "EEXIST" && code !== "EPERM") {
                throw error;
            }
            try {
                const info = await stat(lockPath);
                if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
                    log(
                        `[magic-context] embedding-load lock stale (>${STALE_LOCK_MS}ms), taking over`,
                    );
                    try {
                        await unlink(lockPath);
                    } catch {
                        /* The lock file can disappear after exclusive creation fails; retry acquisition. */
                    }
                    continue;
                }
            } catch {
                continue;
            }
            if (Date.now() - waitStart > MAX_LOCK_WAIT_MS) {
                // Locks older than `STALE_LOCK_MS` trigger an unlink attempt before `MAX_LOCK_WAIT_MS` can fail acquisition.
                // prevent.
                throw new Error(
                    `[magic-context] embedding-load lock wait exceeded ${MAX_LOCK_WAIT_MS}ms; another process is still loading the model. Skipping this init attempt to avoid an unsynchronized native load.`,
                );
            }
            await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        }
    }
}

// The heartbeat updates the lock file during model loading so waiters do not treat it as stale.
function startLockHeartbeat(lockPath: string): () => void {
    const HEARTBEAT_MS = Math.floor(STALE_LOCK_MS / 3);
    const timer = setInterval(() => {
        // The heartbeat timer does not keep the event loop alive.
        writeFile(lockPath, `pid=${process.pid} alive=${Date.now()}\n`).catch(() => {});
    }, HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

/**
 * Electron injects the WASM ONNX runtime before importing transformers.js to bypass onnxruntime-node.
 *
 *   `@huggingface/transformers@4.x` does a top-level static `import "onnxruntime-node"`.
 *
 *   transformers.js exposes `Symbol.for("onnxruntime")` as an override hook
 *
 *
 * Node and Bun load onnxruntime-node instead of WASM.
 * Only Electron processes define `process.versions.electron`.
 *
 * Refs:
 *   - https://github.com/cortexkit/magic-context/issues/78
 */
async function injectWasmOrtForElectron(): Promise<boolean> {
    if (typeof process === "undefined" || !process.versions?.electron) {
        return false;
    }

    try {
        // Runtime specifier construction prevents Bun from probing onnxruntime-web during plugin load.
        const ortWebSpec = `onnxruntime-${"web"}`;
        const ortWeb = (await import(ortWebSpec)) as {
            env?: { wasm?: { wasmPaths?: string | Record<string, string> } };
            default?: unknown;
        };

        // Local WASM assets avoid jsDelivr and permit offline embedding initialization.
        // CDN loading requires network access.
        try {
            const { createRequire: createRequireFn } = await import("node:module");
            const requireFn = createRequireFn(import.meta.url);
            // Resolve `.` rather than `./package.json`: the exports map excludes package.json, while `.` resolves inside dist/ with the WASM assets.
            // issue #195.
            const mainEntry = requireFn.resolve("onnxruntime-web");
            const distDir = dirname(mainEntry);
            const wasmPathsPrefix = `${pathToFileURL(distDir).href}/`;
            if (ortWeb.env?.wasm) {
                ortWeb.env.wasm.wasmPaths = wasmPathsPrefix;
            }
        } catch (pathError) {
            // On failure, onnxruntime-web uses its default CDN paths.
            // Fallback CDN paths require network access for the first embedding initialization.
            log(
                "[magic-context] could not resolve local onnxruntime-web/dist, falling back to default WASM paths:",
                pathError instanceof Error ? pathError.message : String(pathError),
            );
        }

        // transformers.js does `if (ORT_SYMBOL in globalThis) { ONNX = globalThis[ORT_SYMBOL] }`
        // transformers.js must see the override before its first import evaluates.
        (globalThis as Record<symbol, unknown>)[Symbol.for("onnxruntime")] = ortWeb;
        log(
            "[magic-context] Electron detected — using onnxruntime-web (WASM) for embeddings (bypasses onnxruntime-node native load)",
        );
        return true;
    } catch (error) {
        // Returning false lets Transformers use its normal backend selection.
        // Returning false preserves Transformers.js's native-load error.
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

/**
 * */
const DEFAULT_LOCAL_DTYPE: LocalEmbeddingDtype = "fp32";

/**
 * The redirect prevents Transformers and ONNX Runtime warnings from reaching the TUI.
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
 */
/**
 * Retrying cannot repair a missing native runtime.
 */
// `nativeRuntimeMissing` is process-global because a missing package affects the entire installation.
// A process-global latch prevents every provider from re-importing Transformers after a missing-runtime failure.
let nativeRuntimeMissing = false;

export function isNativeRuntimeMissingError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const lower = message.toLowerCase();
    const code = (error as { code?: unknown } | null)?.code;
    const name = (error as { name?: unknown } | null)?.name;

    // Native ONNX binary load failures permanently disable the native runtime.
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
    return arr.length === 0 || typeof arr[0] === "number";
}

function toFloat32Array(values: ArrayLike<number>): Float32Array {
    // The provider copies Float32Array pipeline output to prevent callers from mutating it.
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
        // The provider uses normalizedModel for recipe selection and modelId so both identify the same embedding space.
        const normalizedModel = model.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL;
        this.model = normalizedModel;
        this.maxInputTokens = maxInputTokens;
        this.dtype = dtype || DEFAULT_LOCAL_DTYPE;
        this.recipe = getLocalEmbeddingRecipe(normalizedModel);
        this.modelId = getEmbeddingProviderIdentity({
            provider: "local",
            model: normalizedModel,
            // The provider omits the default dtype so default configurations retain their existing modelId.
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

                // Electron must inject the WASM ONNX runtime before importing Transformers.js.
                // Transformers.js reads `Symbol.for("onnxruntime")` during module evaluation.
                // Transformers.js uses the injected runtime instead of selecting a backend.
                // The injection is a no-op on plain Node and Bun.
                // See: https://github.com/cortexkit/magic-context/issues/78
                const injectedWasmOrt = await injectWasmOrtForElectron();

                // The provider uses a non-literal import specifier so Bun does not eagerly resolve the native runtime.
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

                // The provider uses a cache directory outside the npm install because Windows may not allow writes to the default cache.
                // (e.g. ~\.cache\opencode\packages\...\node_modules\@huggingface\transformers\.cache)
                // The provider uses a plugin-owned storage directory so cached data survives plugin updates.
                const modelCacheDir = join(getMagicContextStorageDir(), "models");
                try {
                    // The provider keeps the cache owner-only because it shares a storage tree with memories and history.
                    // Trusted-group deployments manage the storage directory externally.
                    // Externally managed storage directories receive neither a creation mode nor chmod.
                    if (shouldEnforcePrivateStoragePermissions()) {
                        mkdirSync(modelCacheDir, { recursive: true, mode: 0o700 });
                        if (process.platform !== "win32") {
                            try {
                                chmodSync(modelCacheDir, 0o700);
                            } catch {
                                // The cache keeps its default permissions when chmod fails.
                            }
                        }
                    } else {
                        mkdirSync(modelCacheDir, { recursive: true });
                    }
                    env.cacheDir = modelCacheDir;
                } catch {
                    // The library uses its default cache when directory creation fails.
                    log("[magic-context] could not create model cache dir, using library default");
                }
                const createPipeline = transformersModule.pipeline as CreateEmbeddingPipeline;

                // The cross-process lock serializes InferenceSession::LoadModel.
                const lockPath = join(modelCacheDir, ".load.lock");
                const releaseLock = await acquireModelLoadLock(lockPath);
                const stopHeartbeat = startLockHeartbeat(lockPath);
                try {
                    // Concurrent plugin processes can cause transient ONNX-session initialization failures.
                    // `EBUSY` can indicate file-lock contention.
                    const MAX_ATTEMPTS = 3;
                    let lastError: unknown;
                    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                        try {
                            // Transformers v4 deprecates `quantized` in favor of `dtype`.
                            //
                            // Injected WASM ORT requires `device: "auto"`; concrete devices fail transformers' empty `supportedDevices` check.
                            // With injected WASM ORT, transformers skips device registration.
                            // `supportedDevices` remains empty when Transformers skips device registration.
                            // Under `IS_NODE_ENV`, transformers defaults to `"cpu"`.
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
                    // The resolver latches failures to avoid retrying imports.
                    // The resolver latches failures to avoid logging the resolver error for every embedding.
                    // Local embeddings remain disabled for the process after a resolver failure.
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
