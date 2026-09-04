import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
export type ProcessKind = "OpenCode server" | "OpenCode instance (TUI/CLI)" | "Pi" | "process";
export interface RpcPortFileRecord {
    port: number;
    pid: number;
    started_at: number;
    /** Optional producer-provided kind; older records omit it. */
    kind?: string;
    /** Compatibility with discovery records that used the harness name. */
    harness?: string;
    /**
     * Per-process bearer token. The server requires it on all non-health RPC
     * calls so a random local process or browser-origin script that merely
     * discovers/guesses the port cannot drive side-effecting endpoints
     * (recomp/upgrade/dismiss). Optional in the type for forward/backward
     * compatibility with port files written by older builds (treated as "no
     * auth required" only when the server itself didn't set one).
     */
    token?: string;
    /** Per-server filename nonce; prevents same-process instances from sharing one file. */
    instance_id?: string;
}
/**
 * Stable hash for a project directory — scopes RPC port files per-project
 * so multiple OpenCode instances don't collide.
 */
export declare function projectHash(directory: string): string;
/** Directory containing per-process RPC discovery files for a project. */
export declare function rpcPortDir(storageDir: string, directory: string): string;
/** Per-process RPC port file path. */
export declare function rpcPortFilePath(storageDir: string, directory: string, pid?: number, instanceId?: string): string;
/** Legacy single-port file used by v0.18.0 and earlier. */
export declare function legacyRpcPortFilePath(storageDir: string, directory: string): string;
export type PidLiveness = "alive" | "dead" | "inconclusive";
/**
 * Check whether the platform confirms a PID is live without treating a denied
 * probe as confirmation. Windows uses tasklist because MSYS2/Cygwin ps does not
 * support the options used by the Unix probe. Sandboxes commonly reject
 * `kill(pid, 0)` with EPERM even when the PID does not exist outside their view.
 */
export declare function isPidAlive(pid: number): PidLiveness;
/** Reuse the platform-gated command probes used by PID identity checks. */
export declare function readProcessCommand(pid: number): string | null;
/** Classify a process command without changing the liveness decision. */
export declare function classifyProcessKind(command: string | null | undefined): ProcessKind;
/**
 * Verify that a live PID still belongs to the process that wrote a port record.
 *
 * A PID can be reused after its original process exits. On Linux, procfs gives
 * us a process start time without spawning a helper; macOS and other Unix-like
 * platforms use `ps`, while Windows uses `tasklist`, only on this cold
 * database-open guard path. Legacy records without a start time use a weaker
 * command-name check. A failed filesystem or process probe is inconclusive,
 * not proof that this port record still belongs to OpenCode.
 */
export type PidIdentityPlausibility = "plausible" | "implausible" | "inconclusive";
export declare function isPidIdentityPlausible(record: RpcPortFileRecord): PidIdentityPlausibility;
export declare function __setRpcIdentityTestHooks(hooks: {
    readFileSync?: typeof readFileSync;
    execFileSync?: typeof execFileSync;
    processKill?: typeof process.kill;
    processListExecFileSync?: typeof execFileSync;
    platform?: NodeJS.Platform;
    nowMs?: () => number;
}): void;
export declare function __resetRpcIdentityTestHooks(): void;
/** Result of checking whether Pi/OMP processes may currently hold the shared database. */
export interface PiProcessDiscovery {
    state: "known" | "unreadable";
    processIds: number[];
    error?: string;
}
/**
 * Inspect Pi/OMP processes without converting a failed process-list probe into
 * false evidence that no harness is running. Callers choose their own policy
 * for the unreadable state: destructive maintenance can fail closed, while a
 * migration guard can proceed after reporting that no live Pi process was confirmed.
 */
export declare function inspectLivePiProcesses(): PiProcessDiscovery;
/** Enumerate live Pi/OMP harness processes before deciding whether migration can proceed. */
export declare function discoverLivePiProcessIds(): number[];
export declare function parseRpcPortFile(content: string, fallbackPid?: number): RpcPortFileRecord | null;
//# sourceMappingURL=rpc-utils.d.ts.map