/**
 * Bounded native lifecycle subprocess invocation.
 *
 * Production launch maps the retained verified launcher descriptor to one
 * fixed child fd through Node/Bun stdio numeric mapping and spawns the
 * platform's descriptor exec path (`/proc/self/fd/<n>` on linux,
 * `/dev/fd/<n>` on darwin) with `shell:false`, a minimal environment, and the
 * startup envelope on stdin only. A dev/test injection point spawns an
 * explicit binary path instead (this repo's cargo-built `ck-mc-host`);
 * production callers never take that branch with untrusted input because the
 * target is constructed by policy, not configuration.
 *
 * Output handling is fail-closed: stdout must be exactly one v1 JSON object,
 * the exit code must agree with `ok`, and stderr is tainted — captured only
 * to a bounded buffer and never propagated into errors or results.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
    ContractViolation,
    type DaemonResultV1,
    exitAgreesWithResult,
    parseDaemonResult,
} from "./contract";

/** The fixed collision-free child descriptor for the retained launcher. */
export const LAUNCHER_CHILD_FD = 3;

export type NativeLaunchTarget =
    | { kind: "retained-fd"; fd: number }
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

/** Typed launch failure. Never carries stdout/stderr bytes or raw paths. */
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
    /** Dev/test staging source forwarded as `--payload-dir`. */
    payloadDir?: string;
    /** JSON-serializable startup envelope written to stdin, or null. */
    envelope?: unknown;
    /** Absolute wall-clock budget; the child is killed at expiry. */
    deadlineMs: number;
    /** Explicit environment for the child; defaults to a minimal set. */
    env?: Record<string, string>;
    /** Host platform override for the retained-descriptor exec path; tests only. */
    platform?: NodeJS.Platform;
}

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const STDIO_FLUSH_GRACE_MS = 250;

interface CollectedExit {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    timedOut: boolean;
    outputCapExceeded: boolean;
}

/**
 * Resolve the exec path that re-opens the retained launcher descriptor.
 *
 * Linux reaches it through procfs and darwin through `/dev/fd`; the release
 * contract records exactly this split as the `procfs_self_fd_exec` and
 * `dev_fd_exec` platform capabilities. Any other platform has neither, so it
 * gets no path and the caller fails with a real platform reason rather than a
 * spawn error against a path that cannot exist.
 */
function retainedFdExecPath(platform: NodeJS.Platform): string | null {
    if (platform === "linux") return `/proc/self/fd/${LAUNCHER_CHILD_FD}`;
    if (platform === "darwin") return `/dev/fd/${LAUNCHER_CHILD_FD}`;
    return null;
}

function collectChild(child: ChildProcess, deadlineMs: number): Promise<CollectedExit> {
    return new Promise((resolve, reject) => {
        let stdoutLen = 0;
        let stderrLen = 0;
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
                // Its own flag, never `timedOut = false`: buffered stdout can
                // still arrive after the deadline timer's SIGKILL, and clearing
                // `timedOut` there would report a real deadline expiry as a
                // bare signal exit.
                outputCapExceeded = true;
                child.kill("SIGKILL");
                return;
            }
            stdoutChunks.push(chunk);
        });
        // Stderr is tainted diagnostics: drain it so the child cannot block,
        // bound it, and drop it — it never reaches an error or result.
        child.stderr?.on("data", (chunk: Buffer) => {
            stderrLen += chunk.length;
            if (stderrLen > MAX_STDERR_BYTES) child.stderr?.destroy();
        });
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (stdioGrace !== null) clearTimeout(stdioGrace);
            reject(new NativeLaunchError("spawn_failed", `native spawn failed: ${error.name}`));
        });
        // The `exit` handler waits STDIO_FLUSH_GRACE_MS before destroying the
        // pipes so inherited descriptors cannot delay `close` indefinitely.
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
                stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                timedOut,
                outputCapExceeded,
            });
        });
    });
}

/**
 * Run one native lifecycle command and return its validated v1 result.
 * Every non-conforming outcome — spawn failure, deadline kill, signal exit,
 * extra stdout bytes, unknown fields, exit/JSON disagreement, usage exit —
 * is a typed {@link NativeLaunchError}; secrets, stderr text, and raw paths
 * never ride on it.
 */
export async function runNativeLifecycle(
    target: NativeLaunchTarget,
    options: NativeLaunchOptions,
): Promise<DaemonResultV1> {
    const args: string[] = [options.command];
    if (options.payloadDir !== undefined) {
        args.push("--payload-dir", options.payloadDir);
    }
    const env = options.env ?? {};
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
    // A child that already exited or failed to exec makes this write raise
    // EPIPE/ERR_STREAM_DESTROYED on stdin. Without a listener that stream
    // `error` is an uncaught exception in the host, so an ordinary child-side
    // failure would crash the process instead of surfacing as NativeLaunchError.
    child.stdin?.on("error", () => {});
    if (options.envelope !== undefined && options.envelope !== null) {
        child.stdin?.end(JSON.stringify(options.envelope));
    } else {
        child.stdin?.end();
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
    let result: DaemonResultV1;
    try {
        result = parseDaemonResult(collected.stdout);
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
