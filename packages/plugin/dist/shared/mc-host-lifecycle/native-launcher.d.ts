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
 * the exit code must agree with `ok`, and stderr is tainted — drained and
 * discarded, so it never reaches an error or result.
 */
import { type DaemonResultV1 } from "./contract";
/** The fixed collision-free child descriptor for the retained launcher. */
export declare const LAUNCHER_CHILD_FD = 3;
export type NativeLaunchTarget = {
    kind: "retained-fd";
    fd: number;
}
/**
 * Dev/test injection point. `path` MUST be absolute: the child is spawned
 * with `cwd: "/"`, so a relative path is resolved against the filesystem
 * root rather than the caller's directory.
 */
 | {
    kind: "test-binary";
    path: string;
};
export type NativeLifecycleCommand = "start" | "stop" | "restart" | "probe";
export type NativeLaunchFailureCode = "spawn_failed" | "unsupported_platform" | "timeout" | "signal_exit" | "output_cap_exceeded" | "malformed_output" | "exit_disagreement" | "usage_error";
/** Typed launch failure. Never carries stdout/stderr bytes or raw paths. */
export declare class NativeLaunchError extends Error {
    readonly code: NativeLaunchFailureCode;
    constructor(code: NativeLaunchFailureCode, message: string);
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
/**
 * Run one native lifecycle command and return its validated v1 result.
 * Every non-conforming outcome — spawn failure, deadline kill, signal exit,
 * extra stdout bytes, unknown fields, exit/JSON disagreement, usage exit —
 * is a typed {@link NativeLaunchError}; secrets, stderr text, and raw paths
 * never ride on it.
 */
export declare function runNativeLifecycle(target: NativeLaunchTarget, options: NativeLaunchOptions): Promise<DaemonResultV1>;
//# sourceMappingURL=native-launcher.d.ts.map