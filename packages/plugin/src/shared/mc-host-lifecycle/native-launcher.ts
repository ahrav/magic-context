/**
 * Bounded native lifecycle subprocess invocation.
 *
 * Production launch maps the retained verified launcher descriptor to one
 * fixed child fd through Node/Bun stdio numeric mapping and spawns the
 * Linux descriptor exec path (`/proc/self/fd/<n>`) with `shell:false`, a
 * minimal environment, and the
 * startup envelope on stdin only. A dev/test injection point spawns an
 * explicit binary path instead (this repo's cargo-built `ck-mc-host`);
 * production callers never take that branch with untrusted input because the
 * target is constructed by policy, not configuration.
 *
 * Output handling is fail-closed: stdout must be exactly one v1 JSON object,
 * the exit code must agree with `ok`, and stderr is tainted — drained and
 * discarded, so it never reaches an error or result.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
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
    /**
     * Dev/test injection point. `path` MUST be absolute: the child is spawned
     * with `cwd: "/"`, so a relative path is resolved against the filesystem
     * root rather than the caller's directory.
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
    /**
     * Dev/test staging source forwarded as `--payload-dir`. MUST be absolute:
     * the child runs with `cwd: "/"` and resolves it there.
     */
    payloadDir?: string;
    /** Parent-trusted canonical manifest digest for a production payload directory. */
    payloadManifestDigest?: string;
    /** JSON-serializable startup envelope written to stdin, or null. */
    envelope?: unknown;
    /** Absolute wall-clock budget; the child is killed at expiry. */
    deadlineMs: number;
    /** Explicit environment for the child; defaults to a minimal set. */
    env?: Record<string, string>;
    /** Host platform override for the retained-descriptor exec path; tests only. */
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

function retainedFdExecPath(platform: NodeJS.Platform): string | null {
    return platform === "linux" ? `/proc/self/fd/${LAUNCHER_CHILD_FD}` : null;
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
        // Stderr is tainted diagnostics: drain it so a child writing more than
        // one pipe buffer cannot block, and discard every byte — it never
        // reaches an error or result. Draining keeps the read end open for the
        // child's whole run; closing it early would make the next child-side
        // write take EPIPE/SIGPIPE and turn a healthy run into a signal exit.
        child.stderr?.resume();
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
                stdout: Buffer.concat(stdoutChunks),
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
    if (options.payloadManifestDigest !== undefined) {
        args.push("--payload-manifest-digest", options.payloadManifestDigest);
    }
    const env = options.env ?? {};
    // Validated before anything is spawned, for the same reason the envelope is:
    // an exhausted or malformed budget must produce a typed error with no child
    // in flight. `setTimeout` coerces a nonpositive or non-finite delay to 1ms,
    // so without this a mutating lifecycle transaction would start and then be
    // SIGKILLed a millisecond later — filesystem and daemon effects from a call
    // that had no execution budget at all.
    if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
        throw new NativeLaunchError(
            "usage_error",
            "native lifecycle deadline is not a positive finite duration",
        );
    }
    // Path inputs are checked here for the same reason, because the child is
    // spawned with `cwd: "/"`: a relative value silently changes meaning rather
    // than failing. `target/debug/ck-mc-host` becomes `/target/debug/...` and
    // fails as a missing payload, and a first segment that collides with a real
    // root entry is worse — `bin/foo` resolves to `/bin/foo` and *executes the
    // wrong binary*, surfacing later as malformed output. `--payload-dir` has
    // the same hazard, staging from a directory the caller never named.
    if (target.kind === "test-binary" && !path.isAbsolute(target.path)) {
        throw new NativeLaunchError("usage_error", "native launch target path is not absolute");
    }
    if (options.payloadDir !== undefined && !path.isAbsolute(options.payloadDir)) {
        throw new NativeLaunchError("usage_error", "native payload directory is not absolute");
    }
    // The envelope is serialized before anything is spawned: a value with no
    // JSON form must fail as a typed error with no child in flight, and the
    // stdin `error` listener below only sees stream errors, never a synchronous
    // throw from this call. `JSON.stringify` also answers `undefined` rather
    // than throwing for values that have no JSON form at all, such as a bare
    // function, so both outcomes are rejected the same way.
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
    // A child that already exited or failed to exec makes this write raise
    // EPIPE/ERR_STREAM_DESTROYED on stdin. Without a listener that stream
    // `error` is an uncaught exception in the host, so an ordinary child-side
    // failure would crash the process instead of surfacing as NativeLaunchError.
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
    // Decoded strictly. `Buffer.toString("utf8")` substitutes U+FFFD for an
    // invalid byte, so a corrupt byte inside an otherwise well-formed JSON
    // string would parse, validate, and be accepted as a conforming result
    // carrying a silently mangled value — a truncated or corrupted stream must
    // fail closed instead.
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
