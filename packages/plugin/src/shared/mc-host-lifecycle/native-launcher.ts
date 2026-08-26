/**
 * Bounded native lifecycle subprocess invocation.
 *
 * Production launch maps the retained verified launcher descriptor to one
 * fixed child fd through Node/Bun stdio numeric mapping and spawns
 * `/proc/self/fd/<n>` with `shell:false`, a minimal environment, and the
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

export function retainedExecutablePath(
    platform: NodeJS.Platform,
    fd: number = LAUNCHER_CHILD_FD,
): string {
    if (platform === "linux") return `/proc/self/fd/${fd}`;
    if (platform === "darwin") return `/dev/fd/${fd}`;
    throw new NativeLaunchError(
        "spawn_failed",
        "retained descriptor execution is unsupported on this platform",
    );
}

export type NativeLaunchTarget =
    | { kind: "retained-fd"; fd: number }
    | { kind: "test-binary"; path: string };

export type NativeLifecycleCommand = "start" | "stop" | "restart" | "probe";

export type NativeLaunchFailureCode =
    | "spawn_failed"
    | "timeout"
    | "signal_exit"
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
    /** Parent-trusted canonical manifest digest for a production payload directory. */
    payloadManifestDigest?: string;
    /** JSON-serializable startup envelope written to stdin, or null. */
    envelope?: unknown;
    /** Absolute wall-clock budget; the child is killed at expiry. */
    deadlineMs: number;
    /** Explicit environment for the child; defaults to a minimal set. */
    env?: Record<string, string>;
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
const MAX_STDERR_BYTES = 64 * 1024;
const STDIO_FLUSH_GRACE_MS = 250;

interface CollectedExit {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    timedOut: boolean;
}

function collectChild(child: ChildProcess, deadlineMs: number): Promise<CollectedExit> {
    return new Promise((resolve, reject) => {
        let stdoutLen = 0;
        let stderrLen = 0;
        const stdoutChunks: Buffer[] = [];
        let timedOut = false;
        let settled = false;
        let stdioGrace: ReturnType<typeof setTimeout> | null = null;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, deadlineMs);
        child.stdout?.on("data", (chunk: Buffer) => {
            stdoutLen += chunk.length;
            if (stdoutLen > MAX_STDOUT_BYTES) {
                timedOut = false;
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
    if (options.payloadManifestDigest !== undefined) {
        args.push("--payload-manifest-digest", options.payloadManifestDigest);
    }
    const env = options.env ?? {};
    let child: ChildProcess;
    const stdio: Array<"pipe" | "ignore" | number> = ["pipe", "pipe", "pipe"];
    let executable: string;
    if (target.kind === "retained-fd") {
        stdio[LAUNCHER_CHILD_FD] = target.fd;
        executable = retainedExecutablePath(process.platform);
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
    if (options.envelope !== undefined && options.envelope !== null) {
        child.stdin?.end(JSON.stringify(options.envelope));
    } else {
        child.stdin?.end();
    }
    const collected = await collectChild(child, options.deadlineMs);
    if (collected.timedOut) {
        throw new NativeLaunchError("timeout", "native lifecycle command exceeded its deadline");
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
