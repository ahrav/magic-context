/**
 *
 *
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import {
    ContractViolation,
    type DaemonResultV1,
    exitAgreesWithResult,
    parseDaemonResult,
} from "./contract";

/* */
export const LAUNCHER_CHILD_FD = 3;

export type NativeLaunchTarget =
    | { kind: "retained-fd"; fd: number }
    /**
     * `path` MUST be absolute because the child resolves it from `cwd: "/"`.
     */
    | { kind: "test-binary"; path: string };

export type NativeLifecycleCommand = "start" | "stop" | "restart" | "probe";

export type NativeLaunchFailureCode =
    | "spawn_failed"
    | "unsupported_platform"
    | "timeout"
    | "signal_exit"
    | "output_cap_exceeded"
    | "malformed_output"
    | "exit_disagreement"
    | "usage_error";

/* */
export class NativeLaunchError extends Error {
    constructor(
        readonly code: NativeLaunchFailureCode,
        message: string,
    ) {
        super(message);
        this.name = "NativeLaunchError";
    }
}

export interface NativeLaunchOptions {
    command: NativeLifecycleCommand;
    /**
     * `payloadDir` MUST be absolute because the child resolves it from `cwd: "/"`.
     */
    payloadDir?: string;
    /** The parent trusts `payloadManifestDigest` as the canonical manifest digest for a production payload directory. */
    payloadManifestDigest?: string;
    /** `envelope` supplies a JSON-serializable startup envelope on stdin, or `null`. */
    envelope?: unknown;
    /** `deadlineMs` sets an absolute wall-clock budget; expiry kills the child. */
    deadlineMs: number;
    /** `env` sets the child environment; omitting it uses a minimal set. */
    env?: Record<string, string>;
    /** `platform` overrides the host platform for the retained-descriptor exec path; only tests set it. */
    platform?: NodeJS.Platform;
}

export interface NativeHarnessCandidate {
    manifest_sha256: string;
    source_roots: Record<string, string>;
}

export interface NativeStartupEnvelope {
    schema: 1;
    opencode?: NativeHarnessCandidate;
    pi?: NativeHarnessCandidate;
    credentials?: Record<string, string>;
}

const MAX_STDOUT_BYTES = 256 * 1024;
const STDIO_FLUSH_GRACE_MS = 250;

interface CollectedExit {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    /** Raw bytes: decoding is a validation step, not a convenience. */
    stdout: Buffer;
    timedOut: boolean;
    outputCapExceeded: boolean;
}

/**
 *
 * Unsupported platforms return `null` so callers can report an unsupported-platform error before spawning.
 */
function retainedFdExecPath(platform: NodeJS.Platform): string | null {
    if (platform === "linux") return `/proc/self/fd/${LAUNCHER_CHILD_FD}`;
    if (platform === "darwin") return `/dev/fd/${LAUNCHER_CHILD_FD}`;
    return null;
}

function collectChild(child: ChildProcess, deadlineMs: number): Promise<CollectedExit> {
    return new Promise((resolve, reject) => {
        let stdoutLen = 0;
        const stdoutChunks: Buffer[] = [];
        let timedOut = false;
        let outputCapExceeded = false;
        let settled = false;
        let stdioGrace: ReturnType<typeof setTimeout> | null = null;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, deadlineMs);
        child.stdout?.on("data", (chunk: Buffer) => {
            stdoutLen += chunk.length;
            if (stdoutLen > MAX_STDOUT_BYTES) {
                outputCapExceeded = true;
                child.kill("SIGKILL");
                return;
            }
            stdoutChunks.push(chunk);
        });
        // The parent drains stderr so a child writing beyond a pipe buffer cannot block.
        // Keep the stderr read end open for the child's whole run; closing it early makes the next child-side write fail with EPIPE or SIGPIPE.
        child.stderr?.resume();
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (stdioGrace !== null) clearTimeout(stdioGrace);
            reject(new NativeLaunchError("spawn_failed", `native spawn failed: ${error.name}`));
        });
        // The parent destroys the pipes after `STDIO_FLUSH_GRACE_MS` because inherited descriptors can otherwise delay `close` indefinitely.
        child.on("exit", () => {
            stdioGrace = setTimeout(() => {
                child.stdout?.destroy();
                child.stderr?.destroy();
            }, STDIO_FLUSH_GRACE_MS);
        });
        child.on("close", (exitCode, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (stdioGrace !== null) clearTimeout(stdioGrace);
            resolve({
                exitCode,
                signal,
                stdout: Buffer.concat(stdoutChunks),
                timedOut,
                outputCapExceeded,
            });
        });
    });
}

/**
 */
export async function runNativeLifecycle(
    target: NativeLaunchTarget,
    options: NativeLaunchOptions,
): Promise<DaemonResultV1> {
    const args: string[] = [options.command];
    if (options.payloadDir !== undefined) {
        args.push("--payload-dir", options.payloadDir);
    }
    if (options.payloadManifestDigest !== undefined) {
        args.push("--payload-manifest-digest", options.payloadManifestDigest);
    }
    const env = options.env ?? {};
    // The launcher rejects nonpositive or non-finite `deadlineMs` before spawning because `setTimeout` coerces either to 1 ms.
    if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
        throw new NativeLaunchError(
            "usage_error",
            "native lifecycle deadline is not a positive finite duration",
        );
    }
    // The launcher requires absolute path inputs because `cwd: "/"` resolves relative values against `/`.
    // Relative executable paths can resolve to unintended binaries under `/`.
    // A relative `--payload-dir` stages from a directory the caller did not name.
    if (target.kind === "test-binary" && !path.isAbsolute(target.path)) {
        throw new NativeLaunchError("usage_error", "native launch target path is not absolute");
    }
    if (options.payloadDir !== undefined && !path.isAbsolute(options.payloadDir)) {
        throw new NativeLaunchError("usage_error", "native payload directory is not absolute");
    }
    // The launcher serializes `envelope` before spawning so values without a JSON form fail without starting a child.
    // `JSON.stringify` returns `undefined` rather than throwing for a bare function.
    // `JSON.stringify` exceptions and `undefined` results cause `NativeLaunchError` with code `usage_error`.
    let serializedEnvelope: string | undefined;
    if (options.envelope !== undefined && options.envelope !== null) {
        try {
            serializedEnvelope = JSON.stringify(options.envelope);
        } catch {
            throw new NativeLaunchError(
                "usage_error",
                "native startup envelope is not JSON-serializable",
            );
        }
        if (serializedEnvelope === undefined) {
            throw new NativeLaunchError(
                "usage_error",
                "native startup envelope is not JSON-serializable",
            );
        }
    }
    let child: ChildProcess;
    const stdio: Array<"pipe" | "ignore" | number> = ["pipe", "pipe", "pipe"];
    let executable: string;
    if (target.kind === "retained-fd") {
        stdio[LAUNCHER_CHILD_FD] = target.fd;
        const execPath = retainedFdExecPath(options.platform ?? process.platform);
        if (execPath === null) {
            throw new NativeLaunchError(
                "unsupported_platform",
                "no retained-descriptor exec path on this platform",
            );
        }
        executable = execPath;
    } else {
        executable = target.path;
    }
    try {
        child = spawn(executable, args, {
            shell: false,
            env,
            cwd: "/",
            stdio,
        });
    } catch {
        throw new NativeLaunchError("spawn_failed", "native spawn threw synchronously");
    }
    // Calling `child.stdin?.end()` after the child exits or fails to exec can raise `EPIPE` or `ERR_STREAM_DESTROYED`.
    // Without a `child.stdin` `error` listener, emitted stream errors are uncaught host exceptions.
    // Without a `child.stdin` `error` listener, child-side stdin failures crash the host instead of surfacing as `NativeLaunchError`.
    child.stdin?.on("error", () => {});
    if (serializedEnvelope === undefined) {
        child.stdin?.end();
    } else {
        child.stdin?.end(serializedEnvelope);
    }
    const collected = await collectChild(child, options.deadlineMs);
    if (collected.timedOut) {
        throw new NativeLaunchError("timeout", "native lifecycle command exceeded its deadline");
    }
    if (collected.outputCapExceeded) {
        throw new NativeLaunchError(
            "output_cap_exceeded",
            "native lifecycle command exceeded its stdout cap",
        );
    }
    if (collected.signal !== null) {
        throw new NativeLaunchError(
            "signal_exit",
            `native lifecycle command died on ${collected.signal}`,
        );
    }
    if (collected.exitCode === 2) {
        throw new NativeLaunchError(
            "usage_error",
            "native lifecycle command rejected its invocation",
        );
    }
    // `TextDecoder` rejects invalid UTF-8; `Buffer.toString("utf8")` replaces invalid bytes with U+FFFD.
    // A JSON string containing U+FFFD can parse and pass result validation after replacement.
    // Replacing invalid bytes can silently mangle a result value.
    // The launcher rejects truncated or corrupted stdout rather than accepting a mangled result.
    let stdoutText: string;
    try {
        stdoutText = new TextDecoder("utf-8", { fatal: true }).decode(collected.stdout);
    } catch {
        throw new NativeLaunchError("malformed_output", "native output is not valid UTF-8");
    }
    let result: DaemonResultV1;
    try {
        result = parseDaemonResult(stdoutText);
    } catch (error) {
        if (error instanceof ContractViolation) {
            throw new NativeLaunchError("malformed_output", error.message);
        }
        throw new NativeLaunchError("malformed_output", "native output failed validation");
    }
    if (collected.exitCode === null || !exitAgreesWithResult(collected.exitCode, result)) {
        throw new NativeLaunchError(
            "exit_disagreement",
            "native exit code disagrees with the result object",
        );
    }
    return result;
}
