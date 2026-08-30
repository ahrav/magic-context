import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
function projectHash(directory: string): string {
    const normalized = directory.replace(/\/+$/, "");
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Directory containing per-process RPC discovery files for a project. */
export function rpcPortDir(storageDir: string, directory: string): string {
    return join(storageDir, "rpc", projectHash(directory));
}

/** Per-process RPC port file path. */
export function rpcPortFilePath(
    storageDir: string,
    directory: string,
    pid = process.pid,
    instanceId?: string,
): string {
    const suffix = instanceId ? `-${instanceId}` : "";
    return join(rpcPortDir(storageDir, directory), `port-${pid}${suffix}.json`);
}

/** Legacy single-port file used by v0.18.0 and earlier. */
export function legacyRpcPortFilePath(storageDir: string, directory: string): string {
    return join(rpcPortDir(storageDir, directory), "port");
}

export type PidLiveness = "alive" | "dead" | "inconclusive";

/**
 * Check whether the platform confirms a PID is live without treating a denied
 * probe as confirmation. Windows uses tasklist because MSYS2/Cygwin ps does not
 * support the options used by the Unix probe. Sandboxes commonly reject
 * `kill(pid, 0)` with EPERM even when the PID does not exist outside their view.
 */
export function isPidAlive(pid: number): PidLiveness {
    if (!Number.isInteger(pid) || pid <= 0) return "dead";
    if (rpcIdentityPlatform === "win32") return readWindowsProcess(pid).state;
    try {
        rpcIdentityProcessKill(pid, 0);
        return "alive";
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "inconclusive";
    }
}

const RPC_IDENTITY_SKEW_TOLERANCE_MS = 120_000;
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
const PS_PROBE_TIMEOUT_MS = 1_000;
const OPEN_CODE_COMMAND_MARKERS = ["opencode", "node", "bun", "electron"];
const TASKLIST_NO_TASKS_PATTERN =
    /^INFO:\s+No tasks are running which match the specified criteria\.?$/im;

let rpcIdentityReadFileSync: typeof readFileSync = readFileSync;
let rpcIdentityExecFileSync: typeof execFileSync = execFileSync;
let rpcIdentityProcessKill: typeof process.kill = process.kill;
let rpcProcessListExecFileSync: typeof execFileSync = execFileSync;
let rpcProcessListTestOverride = false;
let rpcIdentityPlatform: NodeJS.Platform = process.platform;
let rpcIdentityNowMs: () => number = () => Date.now();

function parseLinuxProcessStartTime(statContent: string, uptimeContent: string): number | null {
    const closingCommandName = statContent.lastIndexOf(")");
    if (closingCommandName < 0) return null;

    // The fields after the command name begin at field 3 (`state`), so field 22
    // (`starttime`) is index 19 in this suffix. The command name can contain ')',
    // hence the last closing parenthesis rather than the first one is significant.
    const statFields = statContent
        .slice(closingCommandName + 1)
        .trim()
        .split(/\s+/);
    const startTimeTicks = Number(statFields[19]);
    const uptimeSeconds = Number(uptimeContent.trim().split(/\s+/)[0]);
    if (
        !Number.isFinite(startTimeTicks) ||
        startTimeTicks < 0 ||
        !Number.isFinite(uptimeSeconds) ||
        uptimeSeconds < 0
    ) {
        return null;
    }

    const processStartTime =
        rpcIdentityNowMs() -
        uptimeSeconds * 1_000 +
        (startTimeTicks / LINUX_CLOCK_TICKS_PER_SECOND) * 1_000;
    return Number.isFinite(processStartTime) ? processStartTime : null;
}

function readLinuxProcessStartTime(pid: number): number | null {
    try {
        const statContent = String(rpcIdentityReadFileSync(`/proc/${pid}/stat`, "utf8"));
        const uptimeContent = String(rpcIdentityReadFileSync("/proc/uptime", "utf8"));
        return parseLinuxProcessStartTime(statContent, uptimeContent);
    } catch {
        return null;
    }
}

function readPsProcessStartTime(pid: number): number | null {
    try {
        const output = rpcIdentityExecFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf8",
            timeout: PS_PROBE_TIMEOUT_MS,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const processStartTime = Date.parse(String(output).trim());
        return Number.isFinite(processStartTime) ? processStartTime : null;
    } catch {
        return null;
    }
}

interface ProcessListEntry {
    pid: number;
    command: string;
}

function parseCsvLine(line: string): string[] | null {
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (quoted && line[index + 1] === '"') {
                field += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (character === "," && !quoted) {
            fields.push(field);
            field = "";
        } else {
            field += character;
        }
    }
    if (quoted) return null;
    fields.push(field);
    return fields;
}

function parseTasklistOutput(output: string): ProcessListEntry[] | null {
    const entries: ProcessListEntry[] = [];
    let sawHeader = false;
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (TASKLIST_NO_TASKS_PATTERN.test(line)) return [];
        const fields = parseCsvLine(line);
        if (!fields) continue;
        if (fields[1]?.trim().toLowerCase() === "pid") {
            sawHeader = true;
            continue;
        }
        const pid = Number(fields[1]);
        if (!Number.isInteger(pid) || pid <= 0 || !fields[0]) continue;
        entries.push({ pid, command: fields[0] });
    }
    return entries.length > 0 || sawHeader ? entries : null;
}

function readWindowsProcess(pid: number): { state: PidLiveness; command?: string } {
    try {
        const output = rpcIdentityExecFileSync("tasklist", ["/FO", "CSV", "/FI", `PID eq ${pid}`], {
            encoding: "utf8",
            timeout: PS_PROBE_TIMEOUT_MS,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const entries = parseTasklistOutput(String(output));
        if (entries === null) return { state: "inconclusive" };
        const process = entries.find((entry) => entry.pid === pid);
        return process ? { state: "alive", command: process.command } : { state: "dead" };
    } catch {
        return { state: "inconclusive" };
    }
}

function readLinuxProcessCommand(pid: number): string | null {
    try {
        return String(rpcIdentityReadFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
        return null;
    }
}

function readPsProcessCommand(pid: number): string | null {
    try {
        const output = rpcIdentityExecFileSync("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            timeout: PS_PROBE_TIMEOUT_MS,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return String(output);
    } catch {
        return null;
    }
}

/** Reuse the platform-gated command probes used by PID identity checks. */
export function readProcessCommand(pid: number): string | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return rpcIdentityPlatform === "linux"
        ? readLinuxProcessCommand(pid)
        : rpcIdentityPlatform === "win32"
          ? (readWindowsProcess(pid).command ?? null)
          : readPsProcessCommand(pid);
}

function executableName(token: string | undefined): string {
    return (
        (token ?? "")
            .replace(/^['"]|['"]$/g, "")
            .split("/")
            .at(-1) ?? ""
    );
}

function commandTokens(command: string): string[] {
    return command
        .toLowerCase()
        .replaceAll("\\", "/")
        .replaceAll("\u0000", " ")
        .split(/\s+/)
        .map((token) => token.replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
}

function commandHasOpenCodeExecutable(tokens: readonly string[]): number {
    return tokens.findIndex((token) => {
        const executable = executableName(token).replace(/\.(?:exe|cmd)$/, "");
        return executable === "opencode" || executable.endsWith("/opencode");
    });
}

function commandHasPiExecutable(tokens: readonly string[]): boolean {
    for (let index = 0; index < tokens.length; index += 1) {
        const executable = executableName(tokens[index]).replace(/\.(?:exe|cmd)$/, "");
        if (["pi", "omp", "oh-my-pi"].includes(executable)) return true;
        if (["node", "bun", "deno"].includes(executable)) {
            const script = executableName(tokens[index + 1]).replace(/\.(?:exe|cmd)$/, "");
            if (
                ["pi", "pi.js", "pi.mjs", "pi.cjs"].includes(script) ||
                tokens[index + 1]?.includes("pi-coding-agent")
            ) {
                return true;
            }
        }
    }
    return false;
}

/** Classify a process command without changing the liveness decision. */
export function classifyProcessKind(command: string | null | undefined): ProcessKind {
    if (!command) return "process";
    const tokens = commandTokens(command);
    const openCodeIndex = commandHasOpenCodeExecutable(tokens);
    if (openCodeIndex >= 0) {
        const args = tokens.slice(openCodeIndex + 1);
        if (
            args.some(
                (token) => token === "serve" || token === "--serve" || token.startsWith("--serve="),
            )
        ) {
            return "OpenCode server";
        }
        return "OpenCode instance (TUI/CLI)";
    }
    return commandHasPiExecutable(tokens) ? "Pi" : "process";
}

function commandLooksLikeOpenCode(command: string): boolean {
    const normalized = command.toLowerCase();
    return OPEN_CODE_COMMAND_MARKERS.some((marker) => normalized.includes(marker));
}

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

export function isPidIdentityPlausible(record: RpcPortFileRecord): PidIdentityPlausibility {
    if (!Number.isInteger(record.pid) || record.pid <= 0) return "implausible";

    if (Number.isFinite(record.started_at) && record.started_at > 0) {
        const processStartTime =
            rpcIdentityPlatform === "linux"
                ? readLinuxProcessStartTime(record.pid)
                : rpcIdentityPlatform === "win32"
                  ? null
                  : readPsProcessStartTime(record.pid);
        if (processStartTime === null) return "inconclusive";
        return processStartTime <= record.started_at + RPC_IDENTITY_SKEW_TOLERANCE_MS
            ? "plausible"
            : "implausible";
    }

    const command =
        rpcIdentityPlatform === "linux"
            ? readLinuxProcessCommand(record.pid)
            : rpcIdentityPlatform === "win32"
              ? (readWindowsProcess(record.pid).command ?? null)
              : readPsProcessCommand(record.pid);
    if (command === null) return "inconclusive";
    return commandLooksLikeOpenCode(command) ? "plausible" : "implausible";
}

export function __setRpcIdentityTestHooks(hooks: {
    readFileSync?: typeof readFileSync;
    execFileSync?: typeof execFileSync;
    processKill?: typeof process.kill;
    processListExecFileSync?: typeof execFileSync;
    platform?: NodeJS.Platform;
    nowMs?: () => number;
}): void {
    rpcIdentityReadFileSync = hooks.readFileSync ?? readFileSync;
    rpcIdentityExecFileSync = hooks.execFileSync ?? execFileSync;
    rpcIdentityProcessKill = hooks.processKill ?? process.kill;
    rpcProcessListExecFileSync = hooks.processListExecFileSync ?? execFileSync;
    rpcProcessListTestOverride = hooks.processListExecFileSync !== undefined;
    rpcIdentityPlatform = hooks.platform ?? process.platform;
    rpcIdentityNowMs = hooks.nowMs ?? (() => Date.now());
}

export function __resetRpcIdentityTestHooks(): void {
    rpcIdentityReadFileSync = readFileSync;
    rpcIdentityExecFileSync = execFileSync;
    rpcIdentityProcessKill = process.kill;
    rpcProcessListExecFileSync = execFileSync;
    rpcProcessListTestOverride = false;
    rpcIdentityPlatform = process.platform;
    rpcIdentityNowMs = () => Date.now();
}

function commandLooksLikePi(command: string): boolean {
    const normalized = command.trim().toLowerCase().replaceAll("\\", "/");
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const executableName = (token: string | undefined): string =>
        (token ?? "").split("/").at(-1) ?? "";
    const first = executableName(tokens[0]).replace(/\.exe$/, "");
    if (["pi", "pi.cmd", "omp", "oh-my-pi"].includes(first)) return true;
    if (["node", "bun", "deno"].includes(first)) {
        const script = executableName(tokens[1]);
        return (
            ["pi", "pi.js", "pi.mjs", "pi.cjs"].includes(script) ||
            normalized.includes("pi-coding-agent")
        );
    }
    return false;
}

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
export function inspectLivePiProcesses(): PiProcessDiscovery {
    if (process.env.NODE_ENV === "test" && !rpcProcessListTestOverride) {
        return { state: "known", processIds: [] };
    }
    try {
        const isWindows = rpcIdentityPlatform === "win32";
        const output = String(
            rpcProcessListExecFileSync(
                isWindows ? "tasklist" : "ps",
                isWindows ? ["/FO", "CSV"] : ["-axo", "pid=,command="],
                {
                    encoding: "utf8",
                    timeout: PS_PROBE_TIMEOUT_MS,
                    stdio: ["ignore", "pipe", "pipe"],
                },
            ),
        );
        const pids = new Set<number>();
        if (isWindows) {
            const entries = parseTasklistOutput(output);
            if (entries === null) {
                return {
                    state: "unreadable",
                    processIds: [],
                    error: "tasklist output unavailable",
                };
            }
            for (const entry of entries) {
                if (entry.pid === process.pid) continue;
                if (commandLooksLikePi(entry.command)) pids.add(entry.pid);
            }
        } else {
            for (const line of output.split(/\r?\n/)) {
                const match = /^\s*(\d+)\s+(.+)$/.exec(line);
                if (!match) continue;
                const pid = Number(match[1]);
                if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
                if (commandLooksLikePi(match[2])) pids.add(pid);
            }
        }
        return { state: "known", processIds: [...pids].sort((left, right) => left - right) };
    } catch (error) {
        return {
            state: "unreadable",
            processIds: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Enumerate live Pi/OMP harness processes before deciding whether migration can proceed. */
export function discoverLivePiProcessIds(): number[] {
    return inspectLivePiProcesses().processIds;
}

export function parseRpcPortFile(content: string, fallbackPid = 0): RpcPortFileRecord | null {
    const trimmed = content.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed) as Partial<RpcPortFileRecord>;
            const port = Number(parsed.port);
            const pid = Number(parsed.pid);
            const startedAt = Number(parsed.started_at);
            if (!isValidPort(port) || !Number.isInteger(pid) || pid <= 0) return null;
            return {
                port,
                pid,
                started_at: Number.isFinite(startedAt) ? startedAt : 0,
                kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
                harness: typeof parsed.harness === "string" ? parsed.harness : undefined,
                token: typeof parsed.token === "string" ? parsed.token : undefined,
                instance_id:
                    typeof parsed.instance_id === "string" ? parsed.instance_id : undefined,
            };
        } catch {
            return null;
        }
    }

    const port = Number.parseInt(trimmed, 10);
    if (!isValidPort(port)) return null;
    return { port, pid: fallbackPid, started_at: 0 };
}

function isValidPort(port: number): boolean {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}
