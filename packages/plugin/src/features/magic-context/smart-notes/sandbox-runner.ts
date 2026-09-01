// The SINGLEFILE variant embeds the WASM in the JavaScript module.
// The embedded WASM survives bundling into `dist/index.js`.
// The default variant loads `emscripten-module.wasm` with `new URL(..., import.meta.url)`.
// `new URL(..., import.meta.url)` resolves the sibling WASM path to `dist/emscripten-module.wasm`.
// The build emits no `dist/emscripten-module.wasm`, so the default variant fails with `ENOENT`.
// The capability API requires the ASYNCIFY variant because the sandbox installs asynchronous host functions.
//
// These two modules are imported LAZILY inside getAsyncModule() (below), not at
// the top of this file. The singlefile variant inlines ~2.6MB of base64 WASM into
// the bundle; a top-level import forced the JS engine to parse that blob on every
// plugin load — and on every subagent child spawn — adding hundreds of ms.
// Deferring the import to the first smart-note evaluation splits the variant
// into its own chunk that stays out of the cold-start parse. The type-only import
// below is erased at build time and pulls in no runtime code.
import type {
    QuickJSAsyncContext,
    QuickJSAsyncWASMModule,
    QuickJSHandle,
} from "quickjs-emscripten";

import type { SmartNoteCapabilityApi, SmartNoteCapabilityFactory } from "./capabilities";
import { isSmartNoteNetworkError, type SmartNoteCheckResult } from "./types";

/**
 * The reusable WASM module requires ~1 MB of compilation.
 * Each check creates a disposable context from the shared module.
 * The process-wide module promise creates the WASM module once rather than per check.
 *
 * Dynamic imports load the QuickJS variant and runtime on the first smart-note check.
 * Dynamic imports defer parsing the large QuickJS modules until a smart-note check runs.
 */
let asyncModulePromise: Promise<QuickJSAsyncWASMModule> | null = null;
function getAsyncModule(): Promise<QuickJSAsyncWASMModule> {
    asyncModulePromise ??= (async () => {
        const [{ default: singlefileAsyncifyVariant }, { newQuickJSAsyncWASMModuleFromVariant }] =
            await Promise.all([
                import("@jitl/quickjs-singlefile-cjs-release-asyncify"),
                import("quickjs-emscripten"),
            ]);
        return newQuickJSAsyncWASMModuleFromVariant(singlefileAsyncifyVariant);
    })();
    return asyncModulePromise;
}

/**
 * The process-wide chain serializes sandbox runs.
 *
 * Each asyncify WASM module instance has one suspension stack.
 * Awaiting a host capability unwinds and parks the WASM stack.
 * A second `evalCodeAsync` suspension before the first resumes corrupts the shared asyncify stack.
 * A later continuation can resume against a disposed context.
 * Resuming against a disposed context surfaces as `QuickJSUseAfterFree: Lifetime not alive`.
 *
 * withSandboxLock permits at most one suspended eval at a time.
 * Both `sandboxRunChain` handlers advance the chain, so a rejected run does not block later callers.
 */
let sandboxRunChain: Promise<unknown> = Promise.resolve();
function withSandboxLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = sandboxRunChain.then(fn, fn);
    sandboxRunChain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

export interface RunCompiledSmartNoteCheckOptions {
    compiledCheck: string;
    capabilities?: SmartNoteCapabilityApi;
    capabilityFactory?: SmartNoteCapabilityFactory;
    signal?: AbortSignal;
    timeoutMs?: number;
    heapLimitBytes?: number;
    stackLimitBytes?: number;
}

export interface RunCompiledSmartNoteCheckSuccess {
    ok: true;
    result: SmartNoteCheckResult;
}

export interface RunCompiledSmartNoteCheckFailure {
    ok: false;
    cancelled: false;
    error: string;
    network: boolean;
}

export interface RunCompiledSmartNoteCheckCancelled {
    ok: false;
    cancelled: true;
    error: string;
    network: false;
}

export type RunCompiledSmartNoteCheckResult =
    | RunCompiledSmartNoteCheckSuccess
    | RunCompiledSmartNoteCheckFailure
    | RunCompiledSmartNoteCheckCancelled;

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_HEAP_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_STACK_LIMIT_BYTES = 512 * 1024;
const MAX_COMPILED_CHECK_BYTES = 64 * 1024;
const MAX_SANDBOX_ERROR_CHARS = 2 * 1024;

// Capabilities that outlive VM interruption must observe signal.
// A tarpit request can keep the shared QuickJS module suspended past the sandbox budget.
// A suspended request blocks the next caller on the process-wide lock.
function resolveCapabilitiesForRun(
    options: RunCompiledSmartNoteCheckOptions,
    signal: AbortSignal,
): SmartNoteCapabilityApi {
    if (options.capabilityFactory) {
        return options.capabilityFactory(signal);
    }
    if (options.capabilities) {
        return options.capabilities;
    }
    throw new Error("smart-note check requires capabilities");
}

function throwIfRunAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw signal.reason ?? new Error("smart-note check aborted");
    }
}

export async function runCompiledSmartNoteCheck(
    options: RunCompiledSmartNoteCheckOptions,
): Promise<RunCompiledSmartNoteCheckResult> {
    if (options.signal?.aborted) return cancelledResult(options.signal.reason);
    if (Buffer.byteLength(options.compiledCheck, "utf8") > MAX_COMPILED_CHECK_BYTES) {
        return failureResult("compiled check exceeds 64 KiB", false);
    }
    // The lock initializes each check's timeout and host-capability controller.
    // A queued check's timeout starts after it acquires the lock.
    return withSandboxLock(() => runCompiledSmartNoteCheckLocked(options));
}

async function runCompiledSmartNoteCheckLocked(
    options: RunCompiledSmartNoteCheckOptions,
): Promise<RunCompiledSmartNoteCheckResult> {
    if (options.signal?.aborted) return cancelledResult(options.signal.reason);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let externallyCancelled = false;
    let executionTimedOut = false;
    const externalAbort = () => {
        externallyCancelled = true;
        controller.abort(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", externalAbort, { once: true });
    const timer = setTimeout(() => {
        executionTimedOut = true;
        controller.abort(new Error("smart-note check timed out"));
    }, timeoutMs);
    try {
        throwIfRunAborted(controller.signal);
        const capabilities = resolveCapabilitiesForRun(options, controller.signal);
        const deadline = Date.now() + timeoutMs;
        const quickjs = await getAsyncModule();
        throwIfRunAborted(controller.signal);
        const context = quickjs.newContext();
        try {
            context.runtime.setMemoryLimit(options.heapLimitBytes ?? DEFAULT_HEAP_LIMIT_BYTES);
            context.runtime.setMaxStackSize(options.stackLimitBytes ?? DEFAULT_STACK_LIMIT_BYTES);
            context.runtime.setInterruptHandler(
                () => controller.signal.aborted || Date.now() > deadline,
            );
            installCapabilityObject(context, capabilities);
            disableAmbientDynamicCode(context);
            const result = await evalCheck(context, options.compiledCheck);
            const checkResult = result as { met?: unknown } | null;
            if (!checkResult || typeof checkResult.met !== "boolean") {
                return failureResult("check() must return { met: boolean }", false);
            }
            return { ok: true, result: { met: checkResult.met } };
        } finally {
            context.dispose();
        }
    } catch (error) {
        if (externallyCancelled && !executionTimedOut) return cancelledResult(error);
        return failureResult(formatSandboxError(error), isSmartNoteNetworkError(error));
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", externalAbort);
    }
}

function failureResult(error: string, network: boolean): RunCompiledSmartNoteCheckFailure {
    return { ok: false, cancelled: false, error: truncate(error), network };
}

function cancelledResult(reason: unknown): RunCompiledSmartNoteCheckCancelled {
    return {
        ok: false,
        cancelled: true,
        error: truncate(reason instanceof Error ? reason.message : String(reason ?? "cancelled")),
        network: false,
    };
}

function formatSandboxError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function truncate(value: string): string {
    return value.slice(0, MAX_SANDBOX_ERROR_CHARS);
}

function installCapabilityObject(context: QuickJSAsyncContext, cap: SmartNoteCapabilityApi): void {
    const capObject = context.newObject();
    try {
        installAsyncStringFunction(context, capObject, "__readFile", async (arg) => {
            const value = await cap.readFile(arg);
            return value === null ? null : value;
        });
        installAsyncStringFunction(context, capObject, "__httpGet", async (arg) =>
            JSON.stringify(await cap.httpGet(arg)),
        );
        installAsyncNoArgFunction(context, capObject, "__gitHeadSha", async () => cap.gitHeadSha());
        installAsyncNoArgFunction(context, capObject, "__gitTag", async () => cap.gitTag());
        installAsyncStringFunction(context, capObject, "__gitLog", async (arg) => {
            const opts = arg
                ? (JSON.parse(arg) as { maxCount?: number; path?: string; since?: string })
                : undefined;
            return JSON.stringify(await cap.gitLog(opts));
        });
        context.setProp(context.global, "__mcHostCap", capObject);
    } finally {
        capObject.dispose();
    }
}

function installAsyncStringFunction(
    context: QuickJSAsyncContext,
    target: QuickJSHandle,
    name: string,
    fn: (arg: string) => Promise<string | null>,
): void {
    const handle = context.newAsyncifiedFunction(name, async (argHandle) => {
        const arg = context.getString(argHandle);
        const value = await fn(arg);
        return value === null ? context.null : context.newString(value);
    });
    handle.consume((fnHandle) => context.setProp(target, name, fnHandle));
}

function installAsyncNoArgFunction(
    context: QuickJSAsyncContext,
    target: QuickJSHandle,
    name: string,
    fn: () => Promise<string | null>,
): void {
    const handle = context.newAsyncifiedFunction(name, async () => {
        const value = await fn();
        return value === null ? context.null : context.newString(value);
    });
    handle.consume((fnHandle) => context.setProp(target, name, fnHandle));
}

function disableAmbientDynamicCode(context: QuickJSAsyncContext): void {
    context.setProp(context.global, "eval", context.undefined);
    context.setProp(context.global, "Function", context.undefined);
}

async function evalCheck(context: QuickJSAsyncContext, compiledCheck: string): Promise<unknown> {
    const wrapped = `
"use strict";
const module = { exports: {} };
const exports = module.exports;
const __mcCap = (() => {
  const hostCap = __mcHostCap;
  delete globalThis.__mcHostCap;
  if (Object.prototype.hasOwnProperty.call(globalThis, "__mcHostCap")) {
    globalThis.__mcHostCap = undefined;
  }
  return Object.freeze({
    readFile(path) { return hostCap.__readFile(String(path)); },
    httpGet(url) { return JSON.parse(hostCap.__httpGet(String(url))); },
    gitHeadSha() { return hostCap.__gitHeadSha(); },
    gitTag() { return hostCap.__gitTag(); },
    gitLog(opts) { return JSON.parse(hostCap.__gitLog(JSON.stringify(opts || {}))); },
  });
})();
${compiledCheck}
const __check = typeof check === "function" ? check : module.exports.check;
if (typeof __check !== "function") throw new Error("compiled check must define check(cap)");
const __result = __check(__mcCap);
if (!__result || typeof __result.met !== "boolean") throw new Error("check() must return { met: boolean }");
JSON.stringify({ met: __result.met });`;
    const evalResult = await context.evalCodeAsync(wrapped, "smart-note-check.js", {
        type: "global",
    });
    const resultHandle = context.unwrapResult(evalResult);
    try {
        return JSON.parse(context.getString(resultHandle));
    } finally {
        resultHandle.dispose();
    }
}
