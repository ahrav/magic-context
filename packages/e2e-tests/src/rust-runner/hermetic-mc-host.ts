/** Direct mc-host fixture stack for Rust-mode E2E tests. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    McHostClient,
    type BindIdentity,
} from "@magic-context/core/shared/mc-host-client";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const FIXTURE_BINARY = join(
    REPO_ROOT,
    "target/debug/examples/direct_host_fixture",
);
const CONTROL_FILE = "direct-host-control.sock";
const CONNECTION_FILE = "subc-connection.json";
const PID_FILE = "rust-e2e-pids.json";
const MAX_LINE_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const STALE_PID_AGE_MS = 30 * 60 * 1_000;
const EXPECTED_CATALOG = ["magic-context", "synapse", "broca"] as const;

interface RustE2ePidFile {
    createdAtMs: number;
    pids: Array<{ pid: number; role: "mc-host"; executable: string }>;
}

export interface RustModePrereqs {
    ok: boolean;
    skipReason?: string;
}

export interface BackendCounters {
    started: number;
    completed: number;
    blocked: number;
    released: number;
    failed: number;
    cancelled: number;
}

interface ReadyRecord {
    status: "ready";
    wire_version: 2;
    catalog: ["magic-context", "synapse", "broca"];
}

type ControlCommand =
    | "backend-success"
    | "block-next-call"
    | "release-blocked-call"
    | "typed-failure"
    | "counters"
    | "graceful-shutdown";

type PendingControl = {
    command: ControlCommand;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

function processStartTimeMs(pid: number): number | null {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const startedAt = Date.parse(result.stdout.trim());
    return Number.isFinite(startedAt) ? startedAt : null;
}

function processExecutable(pid: number): string | null {
    try {
        return realpathSync(`/proc/${pid}/exe`);
    } catch {
        const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        if (result.status !== 0 || typeof result.stdout !== "string") return null;
        const command = result.stdout.trim().split(/\s+/, 1)[0];
        if (!command) return null;
        try {
            return realpathSync(command);
        } catch {
            return null;
        }
    }
}

function isStaleRustE2ePidRecord(
    createdAtMs: number,
    nowMs = Date.now(),
): boolean {
    return (
        Number.isFinite(createdAtMs) &&
        createdAtMs <= nowMs &&
        nowMs - createdAtMs >= STALE_PID_AGE_MS
    );
}

function reapRecordedRustProcesses(): void {
    let candidates: string[];
    try {
        candidates = readdirSync(tmpdir(), { withFileTypes: true })
            .filter(
                (entry) =>
                    entry.isDirectory() &&
                    entry.name.startsWith("opencode-e2e-"),
            )
            .map((entry) =>
                join(tmpdir(), entry.name, "data", "cortexkit", PID_FILE),
            );
    } catch {
        return;
    }
    for (const pidPath of candidates) {
        if (!existsSync(pidPath)) continue;
        let stale = false;
        try {
            const record = JSON.parse(
                readFileSync(pidPath, "utf8"),
            ) as RustE2ePidFile;
            if (!Array.isArray(record.pids)) continue;
            stale = isStaleRustE2ePidRecord(record.createdAtMs);
            if (!stale) continue;
            const recordedSecond =
                Math.floor(record.createdAtMs / 1_000) * 1_000;
            for (const entry of record.pids) {
                if (
                    !Number.isInteger(entry?.pid) ||
                    entry.pid <= 0 ||
                    entry.role !== "mc-host" ||
                    typeof entry.executable !== "string"
                ) {
                    continue;
                }
                const startedAt = processStartTimeMs(entry.pid);
                const executable = processExecutable(entry.pid);
                if (
                    startedAt === null ||
                    Math.abs(startedAt - recordedSecond) > 5_000 ||
                    executable !== entry.executable
                ) {
                    continue;
                }
                try {
                    process.kill(entry.pid, "SIGKILL");
                } catch {
                    // Process exited after identity check.
                }
            }
        } catch {
            // Partial records prove no process identity.
        } finally {
            if (stale) rmSync(pidPath, { force: true });
        }
    }
}

export function detectRustModePrereqs(): RustModePrereqs {
    if (process.platform === "win32") {
        return {
            ok: false,
            skipReason: "direct mc-host fixture requires Unix sockets",
        };
    }
    if (!existsSync(join(REPO_ROOT, "Cargo.toml"))) {
        return {
            ok: false,
            skipReason: "current repository Cargo workspace is missing",
        };
    }
    const cargo = spawnSync("cargo", ["--version"], { stdio: "ignore" });
    if (cargo.error || cargo.status !== 0) {
        return { ok: false, skipReason: "cargo is not available on PATH" };
    }
    return { ok: true };
}

let fixtureBuild: Promise<string> | null = null;

function runCargo(args: string[]): Promise<{ ok: boolean; stderr: string }> {
    return new Promise((resolveRun) => {
        const child = spawn("cargo", args, {
            cwd: REPO_ROOT,
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
        });
        child.once("error", () =>
            resolveRun({ ok: false, stderr: "cargo spawn failed" }),
        );
        child.once("exit", (code) => resolveRun({ ok: code === 0, stderr }));
    });
}

/** Build U5 fixture once per Bun process. Cargo handles cross-process incremental caching. */
export function buildDirectHostFixture(): Promise<string> {
    if (fixtureBuild) return fixtureBuild;
    fixtureBuild = (async () => {
        const configured = process.env.MC_E2E_DIRECT_HOST_FIXTURE_BIN;
        if (configured && existsSync(configured)) return configured;
        const build = await runCargo([
            "build",
            "-p",
            "mc-module",
            "--example",
            "direct_host_fixture",
            "--features",
            "direct-host-fixture",
        ]);
        if (!build.ok || !existsSync(FIXTURE_BINARY)) {
            throw new Error(
                `direct mc-host fixture build failed\n${build.stderr}`,
            );
        }
        return FIXTURE_BINARY;
    })();
    return fixtureBuild;
}

function exactKeys(
    value: Record<string, unknown>,
    expected: string[],
): boolean {
    const actual = Object.keys(value).sort();
    return (
        actual.length === expected.length &&
        actual.every((key, index) => key === expected[index])
    );
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function parseReadyRecord(line: Buffer): ReadyRecord {
    if (line.byteLength > MAX_LINE_BYTES)
        throw new Error("fixture readiness record exceeded 64 KiB");
    let parsed: unknown;
    try {
        parsed = JSON.parse(line.toString("utf8"));
    } catch {
        throw new Error("fixture readiness record was malformed");
    }
    const object = record(parsed);
    if (!object || !exactKeys(object, ["catalog", "status", "wire_version"])) {
        throw new Error("fixture readiness record had unknown fields");
    }
    if (
        object.status !== "ready" ||
        object.wire_version !== 2 ||
        !Array.isArray(object.catalog)
    ) {
        throw new Error("fixture readiness record was invalid");
    }
    if (
        object.catalog.length !== EXPECTED_CATALOG.length ||
        object.catalog.some((entry, index) => entry !== EXPECTED_CATALOG[index])
    ) {
        throw new Error("fixture readiness catalog was invalid");
    }
    return {
        status: "ready",
        wire_version: 2,
        catalog: ["magic-context", "synapse", "broca"],
    };
}

function verifyPublication(path: string, expectedMode: number): void {
    let publication: ReturnType<typeof lstatSync>;
    try {
        publication = lstatSync(path);
    } catch {
        throw new Error("direct mc-host readiness preceded secure publication");
    }
    const uid = process.getuid?.();
    if (uid === undefined || publication.uid !== uid || (publication.mode & 0o777) !== expectedMode) {
        throw new Error("direct mc-host fixture published unsafe owner or permissions");
    }
}

function appendBounded(current: string, chunk: Buffer): string {
    return `${current}${chunk.toString()}`.slice(-MAX_LOG_BYTES);
}

function safeChildExit(
    child: ChildProcess,
    timeoutMs: number,
): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve(true);
    return new Promise((resolveExit) => {
        const timer = setTimeout(() => {
            child.off("exit", onExit);
            resolveExit(false);
        }, timeoutMs);
        const onExit = (): void => {
            clearTimeout(timer);
            resolveExit(true);
        };
        child.once("exit", onExit);
    });
}

class FixtureControlClient {
    private socket: Socket | null = null;
    private incoming = Buffer.alloc(0);
    private nextId = 1;
    private readonly pending = new Map<number, PendingControl>();
    private readonly responseIds = new Set<number>();
    private closed = false;

    constructor(
        private readonly path: string,
        private readonly timeoutMs = 5_000,
    ) {}

    async connect(): Promise<void> {
        if (this.socket) return;
        if (this.closed) throw new Error("fixture control client is closed");
        const socket = createConnection({ path: this.path });
        this.socket = socket;
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        socket.on("error", () =>
            this.fail(new Error("fixture control connection failed")),
        );
        socket.on("close", () =>
            this.fail(new Error("fixture control connection closed")),
        );
        await new Promise<void>((resolveConnect, rejectConnect) => {
            const timer = setTimeout(() => {
                socket.destroy();
                rejectConnect(
                    new Error("fixture control connection timed out"),
                );
            }, this.timeoutMs);
            socket.once("connect", () => {
                clearTimeout(timer);
                resolveConnect();
            });
            socket.once("error", () => {
                clearTimeout(timer);
                rejectConnect(new Error("fixture control connection failed"));
            });
        });
    }

    backendSuccess(): Promise<void> {
        return this.ack("backend-success");
    }

    blockNextCall(): Promise<void> {
        return this.ack("block-next-call");
    }

    async releaseBlockedCall(): Promise<boolean> {
        return this.parseAck(await this.request("release-blocked-call"));
    }

    typedFailure(): Promise<void> {
        return this.ack("typed-failure");
    }

    async counters(): Promise<BackendCounters> {
        return this.parseCounters(await this.request("counters"));
    }

    gracefulShutdown(): Promise<void> {
        return this.ack("graceful-shutdown");
    }

    close(): void {
        this.closed = true;
        const socket = this.socket;
        this.socket = null;
        socket?.destroy();
        this.fail(new Error("fixture control client is closed"));
    }

    private async ack(command: ControlCommand): Promise<void> {
        const result = await this.request(command);
        if (!this.parseAck(result))
            throw new Error(`fixture control ${command} was not accepted`);
    }

    private request(command: ControlCommand): Promise<unknown> {
        if (!this.socket || this.closed)
            return Promise.reject(new Error("fixture control is unavailable"));
        if (this.nextId > Number.MAX_SAFE_INTEGER) {
            return Promise.reject(
                new Error("fixture control id space exhausted"),
            );
        }
        const id = this.nextId++;
        const line = Buffer.from(
            JSON.stringify({ id, command: { name: command } }) + "\n",
        );
        if (line.byteLength - 1 > MAX_LINE_BYTES) {
            return Promise.reject(
                new Error("fixture control request exceeded 64 KiB"),
            );
        }
        return new Promise((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                rejectRequest(
                    new Error(`fixture control ${command} timed out`),
                );
            }, this.timeoutMs);
            this.pending.set(id, {
                command,
                resolve: resolveRequest,
                reject: rejectRequest,
                timer,
            });
            this.socket?.write(line, (error) => {
                if (!error) return;
                const pending = this.pending.get(id);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.pending.delete(id);
                pending.reject(new Error("fixture control write failed"));
            });
        });
    }

    private onData(chunk: Buffer): void {
        this.incoming = Buffer.concat([this.incoming, chunk]);
        for (;;) {
            const newline = this.incoming.indexOf(0x0a);
            if (newline < 0) {
                if (this.incoming.byteLength > MAX_LINE_BYTES) {
                    this.fail(
                        new Error("fixture control response exceeded 64 KiB"),
                    );
                }
                return;
            }
            if (newline > MAX_LINE_BYTES) {
                this.fail(
                    new Error("fixture control response exceeded 64 KiB"),
                );
                return;
            }
            const line = this.incoming.subarray(0, newline);
            this.incoming = this.incoming.subarray(newline + 1);
            this.onLine(line);
            if (this.closed) return;
        }
    }

    private onLine(line: Buffer): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line.toString("utf8"));
        } catch {
            this.fail(new Error("fixture control response was malformed"));
            return;
        }
        const object = record(parsed);
        if (
            !object ||
            !exactKeys(
                object,
                object.ok === true
                    ? ["id", "ok", "result"]
                    : ["error", "id", "ok"],
            )
        ) {
            this.fail(new Error("fixture control response had unknown fields"));
            return;
        }
        const id = object.id;
        if (!Number.isSafeInteger(id) || (id as number) < 0) {
            this.fail(new Error("fixture control response id was invalid"));
            return;
        }
        const numericId = id as number;
        if (this.responseIds.has(numericId)) {
            this.fail(new Error("fixture control response id was duplicated"));
            return;
        }
        const pending = this.pending.get(numericId);
        if (!pending) {
            this.fail(
                new Error(
                    "fixture control response id did not match a request",
                ),
            );
            return;
        }
        this.responseIds.add(numericId);
        this.pending.delete(numericId);
        clearTimeout(pending.timer);
        if (object.ok !== true) {
            const error = record(object.error);
            const code = error?.code;
            if (
                !error ||
                !exactKeys(error, ["code", "message"]) ||
                typeof code !== "string"
            ) {
                pending.reject(
                    new Error("fixture control failure response was malformed"),
                );
                return;
            }
            pending.reject(
                new Error(
                    `fixture control ${pending.command} rejected: ${code}`,
                ),
            );
            return;
        }
        pending.resolve(object.result);
    }

    private parseAck(value: unknown): boolean {
        const object = record(value);
        if (
            !object ||
            !exactKeys(object, ["accepted"]) ||
            typeof object.accepted !== "boolean"
        ) {
            throw new Error("fixture control acknowledgement was malformed");
        }
        return object.accepted;
    }

    private parseCounters(value: unknown): BackendCounters {
        const object = record(value);
        const keys = [
            "blocked",
            "cancelled",
            "completed",
            "failed",
            "released",
            "started",
        ];
        if (!object || !exactKeys(object, keys)) {
            throw new Error("fixture control counters were malformed");
        }
        for (const key of keys) {
            if (
                !Number.isSafeInteger(object[key]) ||
                (object[key] as number) < 0
            ) {
                throw new Error("fixture control counters were malformed");
            }
        }
        return {
            started: object.started as number,
            completed: object.completed as number,
            blocked: object.blocked as number,
            released: object.released as number,
            failed: object.failed as number,
            cancelled: object.cancelled as number,
        };
    }

    private fail(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        if (!this.closed) {
            this.closed = true;
            this.socket?.destroy();
            this.socket = null;
        }
    }
}

export interface HermeticMcHostOptions {
    /** OpenCode XDG data root. Fixture and module store live beneath this owner-only directory. */
    dataDir: string;
    fixtureBin: string;
    startTimeoutMs?: number;
}

/** Running U5 direct-host fixture. No provider or module subprocess exists. */
export class HermeticMcHostStack {
    readonly connectionFile: string;
    readonly controlPath: string;
    private readonly dataDir: string;
    private readonly fixtureBin: string;
    private readonly startTimeoutMs: number;
    private readonly fixtureConfigDir: string;
    private readonly logPath: string;
    private readonly pidFilePath: string;
    private child: ChildProcess | null = null;
    private control: FixtureControlClient | null = null;
    private statusClient: McHostClient | null = null;
    private stdout = "";
    private stderr = "";
    private pidFileCreatedAtMs = 0;

    private constructor(options: Required<HermeticMcHostOptions>) {
        this.dataDir = options.dataDir;
        this.fixtureBin = options.fixtureBin;
        this.startTimeoutMs = options.startTimeoutMs;
        this.connectionFile = join(
            this.dataDir,
            "cortexkit",
            "run",
            CONNECTION_FILE,
        );
        this.controlPath = join(this.dataDir, CONTROL_FILE);
        this.fixtureConfigDir = join(this.dataDir, "fixture-config");
        this.logPath = join(this.dataDir, "cortexkit", "direct-mc-host.log");
        this.pidFilePath = join(this.dataDir, "cortexkit", PID_FILE);
    }

    static async start(
        options: HermeticMcHostOptions,
    ): Promise<HermeticMcHostStack> {
        reapRecordedRustProcesses();
        const stack = new HermeticMcHostStack({
            ...options,
            startTimeoutMs: options.startTimeoutMs ?? 60_000,
        });
        try {
            await stack.startHost();
            return stack;
        } catch (error) {
            await stack.stop();
            throw error;
        }
    }

    async backendSuccess(): Promise<void> {
        await this.requireControl().backendSuccess();
    }

    async blockNextBackendCall(): Promise<void> {
        await this.requireControl().blockNextCall();
    }

    async releaseBlockedBackendCall(): Promise<boolean> {
        return this.requireControl().releaseBlockedCall();
    }

    async failNextBackendCall(): Promise<void> {
        await this.requireControl().typedFailure();
    }

    async backendCounters(): Promise<BackendCounters> {
        return this.requireControl().counters();
    }

    async backendRequestCount(): Promise<number> {
        return (await this.backendCounters()).started;
    }

    async primaryStatus(
        sessionId: string,
        projectRoot: string,
        method: "status" | "session.status" = "status",
    ): Promise<Record<string, unknown>> {
        const identity: BindIdentity = {
            project_root: resolve(projectRoot),
            harness: "opencode",
            session: sessionId,
        };
        const client =
            this.statusClient ??
            (this.statusClient = await McHostClient.connect({
                connectionFile: this.connectionFile,
                identity,
                targetKind: "tool_provider",
            }));
        let route: Awaited<ReturnType<McHostClient["routeOpen"]>> | null = null;
        try {
            route = await client.routeOpen(
                { kind: "tool_provider", module_id: "magic-context" },
                identity,
            );
            const response = await client.request(route, {
                method,
                v: 1,
                session_id: sessionId,
            });
            return record(response) ?? {};
        } catch (error) {
            if (this.statusClient === client) this.statusClient = null;
            await client.closeAsync().catch(() => undefined);
            throw error;
        } finally {
            if (route) await client.closeRoute(route).catch(() => undefined);
        }
    }

    hostLog(): string {
        let file = "";
        try {
            file = readFileSync(this.logPath, "utf8").slice(-MAX_LOG_BYTES);
        } catch {
            // Log file is optional.
        }
        return `${this.stdout}${this.stderr}${file}`.slice(-MAX_LOG_BYTES);
    }

    async crashHost(): Promise<void> {
        await this.closeClients();
        const child = this.child;
        if (!child) return;
        if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        if (!(await safeChildExit(child, 5_000))) {
            throw new Error(
                "direct mc-host fixture did not exit after SIGKILL",
            );
        }
        if (this.child === child) this.child = null;
        this.persistPidFile();
    }

    async restartHost(): Promise<void> {
        await this.crashHost();
        await this.startHost();
    }

    async terminateHost(): Promise<void> {
        await this.closeClients();
        const child = this.child;
        if (!child) return;
        if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGTERM");
        if (!(await safeChildExit(child, 10_000))) {
            throw new Error(
                "direct mc-host fixture did not exit after SIGTERM",
            );
        }
        if (this.child === child) this.child = null;
        this.persistPidFile();
    }

    pauseHost(): void {
        const child = this.child;
        if (child && child.exitCode === null && child.signalCode === null)
            child.kill("SIGSTOP");
    }

    resumeHost(): void {
        const child = this.child;
        if (child && child.exitCode === null && child.signalCode === null)
            child.kill("SIGCONT");
    }

    /** Graceful JSONL shutdown, then SIGTERM fallback. Always await exit and remove isolated state. */
    async stop(): Promise<void> {
        await this.closeStatusClient();
        const child = this.child;
        let exited =
            child === null ||
            child.exitCode !== null ||
            child.signalCode !== null;
        if (child && !exited) {
            try {
                await this.control?.gracefulShutdown();
            } catch {
                // Fixture may already be unavailable.
            }
            exited = await safeChildExit(child, 5_000);
            if (!exited) {
                child.kill("SIGTERM");
                exited = await safeChildExit(child, 5_000);
            }
            if (!exited) {
                child.kill("SIGKILL");
                exited = await safeChildExit(child, 5_000);
            }
        }
        this.control?.close();
        this.control = null;
        this.child = null;
        rmSync(this.pidFilePath, { force: true });
        rmSync(this.dataDir, { recursive: true, force: true });
        if (!exited)
            throw new Error(
                "direct mc-host fixture did not exit during teardown",
            );
    }

    private async startHost(): Promise<void> {
        await this.closeClients();
        mkdirSync(join(this.dataDir, "cortexkit"), { recursive: true });
        chmodSync(this.dataDir, 0o700);
        const fixtureConfigRoot = join(this.fixtureConfigDir, "cortexkit");
        const fixtureConfigPath = join(fixtureConfigRoot, "magic-context.jsonc");
        mkdirSync(fixtureConfigRoot, { recursive: true });
        chmodSync(this.fixtureConfigDir, 0o700);
        chmodSync(fixtureConfigRoot, 0o700);
        writeFileSync(
            fixtureConfigPath,
            JSON.stringify({ historian: { module_model: "fixture/deterministic" } }),
            { mode: 0o600 },
        );
        chmodSync(fixtureConfigPath, 0o600);
        rmSync(this.logPath, { force: true });
        this.stdout = "";
        this.stderr = "";
        this.pidFileCreatedAtMs = Date.now();
        this.persistPidFile();

        const child = spawn(this.fixtureBin, ["--state-root", this.dataDir], {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                NO_COLOR: "1",
                XDG_CONFIG_HOME: this.fixtureConfigDir,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.child = child;
        this.persistPidFile();
        let readyBuffer = Buffer.alloc(0);
        let readyResolve: ((record: ReadyRecord) => void) | null = null;
        let readyReject: ((error: Error) => void) | null = null;
        const readyPromise = new Promise<ReadyRecord>(
            (resolveReady, rejectReady) => {
                readyResolve = resolveReady;
                readyReject = rejectReady;
            },
        );
        child.stdout?.on("data", (chunk: Buffer) => {
            this.stdout = appendBounded(this.stdout, chunk);
            if (!readyResolve) return;
            readyBuffer = Buffer.concat([readyBuffer, chunk]);
            const newline = readyBuffer.indexOf(0x0a);
            if (newline < 0) {
                if (readyBuffer.byteLength > MAX_LINE_BYTES) {
                    readyReject?.(
                        new Error("fixture readiness record exceeded 64 KiB"),
                    );
                    readyResolve = null;
                }
                return;
            }
            try {
                const parsed = parseReadyRecord(
                    readyBuffer.subarray(0, newline),
                );
                const resolve = readyResolve;
                readyResolve = null;
                resolve(parsed);
            } catch (error) {
                readyResolve = null;
                readyReject?.(
                    error instanceof Error
                        ? error
                        : new Error("fixture readiness failed"),
                );
            }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            this.stderr = appendBounded(this.stderr, chunk);
            try {
                appendFileSync(this.logPath, chunk);
            } catch {
                // Diagnostics never own fixture lifecycle.
            }
        });
        child.once("error", () =>
            readyReject?.(new Error("direct mc-host fixture failed to start")),
        );
        child.once("exit", () => {
            if (this.child === child) this.child = null;
            this.persistPidFile();
            readyReject?.(
                new Error("direct mc-host fixture exited before readiness"),
            );
        });

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<never>((_, rejectTimeout) => {
            timeoutHandle = setTimeout(
                () => rejectTimeout(new Error("direct mc-host fixture readiness timed out")),
                this.startTimeoutMs,
            );
        });
        try {
            await Promise.race([readyPromise, timeout]);
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        }

        verifyPublication(this.dataDir, 0o700);
        verifyPublication(this.controlPath, 0o600);
        verifyPublication(this.connectionFile, 0o600);

        const control = new FixtureControlClient(this.controlPath);
        await control.connect();
        this.control = control;

        const probe = await McHostClient.connect({
            connectionFile: this.connectionFile,
        });
        try {
            const catalog = await probe.catalogList();
            const ids = catalog.map((entry) => entry.module_id);
            if (
                ids.length !== EXPECTED_CATALOG.length ||
                ids.some((entry, index) => entry !== EXPECTED_CATALOG[index])
            ) {
                throw new Error("direct mc-host catalog probe failed");
            }
        } finally {
            await probe.closeAsync();
        }
    }

    private requireControl(): FixtureControlClient {
        if (!this.control)
            throw new Error("direct mc-host fixture control is unavailable");
        return this.control;
    }

    private async closeStatusClient(): Promise<void> {
        const client = this.statusClient;
        this.statusClient = null;
        if (client) await client.closeAsync().catch(() => undefined);
    }

    private async closeClients(): Promise<void> {
        await this.closeStatusClient();
        this.control?.close();
        this.control = null;
    }

    private persistPidFile(): void {
        if (!this.pidFileCreatedAtMs) return;
        const pid = this.child?.pid;
        try {
            mkdirSync(join(this.dataDir, "cortexkit"), { recursive: true });
            writeFileSync(
                this.pidFilePath,
                JSON.stringify({
                    createdAtMs: this.pidFileCreatedAtMs,
                    pids:
                        typeof pid === "number" && pid > 0
                            ? [
                                  {
                                      pid,
                                      role: "mc-host" as const,
                                      executable: realpathSync(this.fixtureBin),
                                  },
                              ]
                            : [],
                } satisfies RustE2ePidFile),
            );
        } catch {
            // PID file is cleanup safety net only.
        }
    }
}

export const __hermeticMcHostTest = {
    FixtureControlClient,
    diagnostics(stack: HermeticMcHostStack): {
        stdout: string;
        stderr: string;
        retainedLog: string;
    } {
        // SAFETY: This module guarantees that stack has stdout, stderr, and logPath diagnostic fields.
        const internal = stack as unknown as {
            stdout: string;
            stderr: string;
            logPath: string;
        };
        let retainedLog = "";
        try {
            retainedLog = readFileSync(internal.logPath, "utf8").slice(-MAX_LOG_BYTES);
        } catch {
            // Retained fixture log is optional.
        }
        return { stdout: internal.stdout, stderr: internal.stderr, retainedLog };
    },
    isStaleRustE2ePidRecord,
    maxLineBytes: MAX_LINE_BYTES,
    parseReadyRecord,
    stalePidAgeMs: STALE_PID_AGE_MS,
};
