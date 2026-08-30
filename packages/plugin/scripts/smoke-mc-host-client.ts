import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { wakePlaneStatus } from "../src/features/magic-context/smart-notes/wake-plane";
import {
    type McHostDiagnosticsEvent,
    processMcHostClient,
} from "../src/shared/mc-host-client";

const OVERALL_DEADLINE_MS = 60_000;
const READY_DEADLINE_MS = 15_000;
const CHILD_EXIT_DEADLINE_MS = 10_000;

function log(line: string): void {
    console.log(`smoke: ${line}`);
}

function findRepoRoot(): string {
    let dir = realpathSync(process.cwd());
    for (;;) {
        if (existsSync(join(dir, "crates", "mc-host", "Cargo.toml"))) return dir;
        const parent = resolve(dir, "..");
        if (parent === dir) {
            throw new Error("could not locate repo root (crates/mc-host/Cargo.toml) above cwd");
        }
        dir = parent;
    }
}

function buildPerfHost(repoRoot: string, binary: string): Promise<void> {
    log("building current perf_host source");
    return new Promise((resolvePromise, rejectPromise) => {
        const build = spawn("cargo", ["build", "-p", "mc-host", "--example", "perf_host"], {
            cwd: repoRoot,
            stdio: ["ignore", "inherit", "inherit"],
        });
        build.on("error", rejectPromise);
        build.on("exit", (code) => {
            if (code !== 0) {
                rejectPromise(new Error(`cargo build exited with code ${code}`));
                return;
            }
            if (!existsSync(binary)) {
                rejectPromise(new Error(`cargo build succeeded but ${binary} is missing`));
                return;
            }
            resolvePromise();
        });
    });
}

function waitForReady(child: ChildProcess, deadlineMs: number): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        let stdout = "";
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            finish(() => rejectPromise(new Error(`perf_host not READY within ${deadlineMs}ms`)));
        }, deadlineMs);
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
            // Require the line terminator: a chunk boundary can split the
            // READY line, and a bare `$` anchor would accept the truncated
            // prefix as the whole connection-file path.
            const match = /^READY ([^\r\n]+)\r?\n/m.exec(stdout);
            if (match?.[1]) {
                const path = match[1];
                finish(() => resolvePromise(path));
            }
        });
        child.on("error", (error) => {
            finish(() => rejectPromise(new Error(`perf_host failed to spawn: ${error.message}`)));
        });
        child.on("exit", (code, signal) => {
            finish(() =>
                rejectPromise(
                    new Error(`perf_host exited before READY (code=${code}, signal=${signal})`),
                ),
            );
        });
    });
}

function waitForExit(child: ChildProcess, deadlineMs: number): Promise<number | null> {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
            rejectPromise(new Error(`perf_host did not exit within ${deadlineMs}ms of SIGINT`));
        }, deadlineMs);
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolvePromise(code);
        });
    });
}

const repoRoot = findRepoRoot();
const binary =
    process.env.PERF_HOST_BIN ?? join(repoRoot, "target", "debug", "examples", "perf_host");
await buildPerfHost(repoRoot, binary);

const dataDir = mkdtempSync(join(tmpdir(), "mc-host-client-smoke-"));
let child: ChildProcess | null = null;
let torndown = false;

function teardown(): void {
    if (torndown) return;
    torndown = true;
    if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
    }
    rmSync(dataDir, { recursive: true, force: true });
}
process.on("exit", teardown);
const onSignal = (signal: NodeJS.Signals): void => {
    teardown();
    process.exit(signal === "SIGINT" ? 130 : 143);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

const watchdog = setTimeout(() => {
    console.error(`smoke: FAIL — overall ${OVERALL_DEADLINE_MS}ms deadline exceeded`);
    teardown();
    process.exit(1);
}, OVERALL_DEADLINE_MS);

try {
    log(`starting perf_host with data dir ${dataDir}`);
    child = spawn(binary, [dataDir], { stdio: ["ignore", "pipe", "inherit"] });
    const connectionFile = await waitForReady(child, READY_DEADLINE_MS);
    log(`perf_host READY, connection file ${connectionFile}`);

    const events: McHostDiagnosticsEvent[] = [];
    const client = await processMcHostClient({
        connectionFile,
        diagnostics: (event) => events.push(event),
    });
    log(`connected (daemonVer=${client.daemonVer})`);
    try {
        const connectedEvent = events.find((event) => event.type === "connected");
        assert.equal(
            connectedEvent?.transport,
            "shm",
            `connection must use shared memory (got ${connectedEvent?.transport})`,
        );
        log("shared-memory ring active");

        const previousXdgDataHome = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = dataDir;
        try {
            const status = await wakePlaneStatus();
            assert.equal(
                status,
                "absent",
                `direct host must probe as wake-plane absent (got ${status})`,
            );
        } finally {
            if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previousXdgDataHome;
        }
        log("production wake-plane probe returned absent");

        const modules = await client.catalogList();
        assert.ok(Array.isArray(modules), "catalog.list must return a module array");
        log(`catalog listed ${modules.length} module(s)`);

        const handle = await client.routeOpen(
            { kind: "tool_provider", module_id: "perf-echo" },
            {
                project_root: realpathSync(dataDir),
                harness: "mc-host-client-smoke",
                session: randomUUID(),
            },
        );
        log(`route opened (channel=${handle.channel}, epoch=${handle.epoch})`);

        const body = { op: "echo", nonce: randomUUID(), payload: [1, 2, 3] };
        const response = await client.request(handle, body);
        assert.deepEqual(response, body, "perf-echo must echo the request body exactly");
        log("echo round trip matched exactly");

        await client.closeRoute(handle);
        log("route closed");
    } finally {
        await client.closeAsync();
    }
    log("client closed");

    child.kill("SIGINT");
    const exitCode = await waitForExit(child, CHILD_EXIT_DEADLINE_MS);
    assert.equal(exitCode, 0, `perf_host must exit cleanly on SIGINT (got ${exitCode})`);
    log("perf_host exited cleanly");
} catch (error) {
    console.error(
        `smoke: FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    teardown();
    process.exit(1);
} finally {
    clearTimeout(watchdog);
    teardown();
}
console.log("smoke: PASS (real-host mc-host-client round trip + wake-plane absent)");
