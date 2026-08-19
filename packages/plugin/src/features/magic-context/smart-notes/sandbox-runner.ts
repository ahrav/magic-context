// The SINGLEFILE variant embeds the WASM as binary INSIDE the JS module, so it
// survives bundling into dist/index.js. The default wasmfile variant loads a
// sibling `emscripten-module.wasm` via `new URL(..., import.meta.url)`, which
// resolves to `dist/emscripten-module.wasm` in the bundle — a file the build
// never emits, so every sandbox run fails with ENOENT. (Documented fix:
// emscriptenInclusion=singlefile is "for missing .wasm files when bundling".)
// We use the ASYNCIFY variant because the capability API (readFile/httpGet/git)
// is async and the sandbox installs async host functions.
//
// These two modules are imported LAZILY inside getAsyncModule() (below), not at
// the top of this file. The singlefile variant inlines ~2.6MB of base64 WASM into
// the bundle; a top-level import forced the JS engine to parse that blob on every
// plugin load — and on every subagent child spawn — adding hundreds of ms (issue
// #242). Deferring the import to the first smart-note evaluation splits the variant
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
 * The WASM module is expensive to instantiate (~1MB compile) but reusable across
 * checks — each check gets its own disposable CONTEXT off the shared module. Cache
 * the module promise process-wide so we compile once, not per check.
 *
 * The QuickJS variant + runtime are loaded here on first use via dynamic import so
 * their (large) modules are parsed only when a smart-note check actually runs,
 * never at plugin import time. See the file-header note for the cold-start reason.
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
 * Process-wide serialization for sandbox runs.
 *
 * The asyncify variant has ONE suspension stack per WASM module instance, and we
 * share a single cached module across every check (above). When a check awaits a
 * host capability (httpGet/git/readFile) the WASM stack is unwound and parked;
 * if a SECOND check's `evalCodeAsync` suspends on the same module before the
 * first resumes, the two share/clobber that single asyncify stack and a
 * continuation later resumes against a context that has since been disposed,
 * surfacing as `QuickJSUseAfterFree: Lifetime not alive`. This is reachable in
 * normal operation: the dream timer fires per-project smart-note sweeps
 * un-awaited during multi-project startup, so two projects' sweeps overlap.
 *
 * Serializing every run through one promise chain makes "one suspended eval at a
 * time" an invariant. These are background sweeps with no user-facing latency, so
 * the serialization cost is irrelevant. A failed/rejected run must not break the
 * chain for the next caller, so we continue the chain on both settle paths.
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

// Host calls can outlive the VM interrupt path, so any capability that touches
// the outside world must listen to this run's controller. Otherwise one tarpit
// request can keep the shared QuickJS module suspended past the sandbox budget
// and block the next caller on the process-wide lock.
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
    // Serialize the actual sandbox work (see withSandboxLock): only one
    // asyncify-suspended eval may exist at a time on the shared module. The
    // per-check timeout and host-capability controller start INSIDE the lock so
    // a check queued behind another doesn't burn its own budget waiting.
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
        // Queue deadlines and lease loss are control flow, not evidence that a
        // healthy compiled check is failing. Only this run's own timeout counts.
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
