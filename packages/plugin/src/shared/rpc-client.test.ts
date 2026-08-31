import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MagicContextRpcClient } from "./rpc-client";
import {
    __resetNotificationStateForTests,
    drainNotifications,
    isTuiConnected,
    pushNotification,
} from "./rpc-notifications";
import { MagicContextRpcServer } from "./rpc-server";
import { parseRpcPortFile, type RpcPortFileRecord, rpcPortDir, rpcPortFilePath } from "./rpc-utils";

interface TestServer {
    port: number;
    close: () => Promise<void>;
}

const tempDirs: string[] = [];
let servers: TestServer[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.close();
    }
    __resetNotificationStateForTests();
    for (const dir of tempDirs.splice(0)) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* */
        }
    }
});

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-rpc-client-"));
    tempDirs.push(dir);
    return dir;
}

function writePortFile(storageDir: string, directory: string, port: number): void {
    const portFile = rpcPortFilePath(storageDir, directory);
    mkdirSync(dirname(portFile), { recursive: true });
    writeFileSync(
        portFile,
        JSON.stringify({ port, pid: process.pid, started_at: Date.now() }),
        "utf-8",
    );
}

function writePortFileForPid(
    storageDir: string,
    directory: string,
    port: number,
    pid: number,
    startedAt: number,
    instanceId?: string,
    token?: string,
): string {
    const portFile = rpcPortFilePath(storageDir, directory, pid, instanceId);
    mkdirSync(dirname(portFile), { recursive: true });
    writeFileSync(
        portFile,
        JSON.stringify({
            port,
            pid,
            started_at: startedAt,
            instance_id: instanceId,
            token,
        }),
        "utf-8",
    );
    return portFile;
}

function readNewestPortRecord(storageDir: string, directory: string): RpcPortFileRecord | null {
    const records: RpcPortFileRecord[] = [];
    for (const entry of readdirSync(rpcPortDir(storageDir, directory))) {
        if (!entry.startsWith("port-") || !entry.endsWith(".json")) continue;
        const record = parseRpcPortFile(
            readFileSync(join(rpcPortDir(storageDir, directory), entry), "utf-8"),
        );
        if (record) records.push(record);
    }
    records.sort((a, b) => b.started_at - a.started_at);
    return records[0] ?? null;
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function openSocket(
    port: number,
    token: string,
    legacyQueryAuth = false,
): Promise<WebSocket> {
    const ws = legacyQueryAuth
        ? new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`)
        : new WebSocket(`ws://127.0.0.1:${port}/ws`, {
              headers: { Authorization: `Bearer ${token}` },
          });
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("socket open timed out")), 2_000);
        ws.addEventListener(
            "open",
            () => {
                clearTimeout(timeout);
                resolve();
            },
            { once: true },
        );
        ws.addEventListener(
            "error",
            () => {
                clearTimeout(timeout);
                reject(new Error("socket open failed"));
            },
            { once: true },
        );
    });
    return ws;
}

function waitForJsonMessage<T extends { type?: string }>(
    ws: WebSocket,
    predicate: (message: T) => boolean,
    timeoutMs = 2_000,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ws.removeEventListener("message", onMessage);
            reject(new Error("socket message timed out"));
        }, timeoutMs);
        const onMessage = (event: MessageEvent) => {
            let message: T;
            try {
                message = JSON.parse(String(event.data)) as T;
            } catch {
                return;
            }
            if (!predicate(message)) return;
            clearTimeout(timeout);
            ws.removeEventListener("message", onMessage);
            resolve(message);
        };
        ws.addEventListener("message", onMessage);
    });
}

async function startRpcServer(
    handler: (method: string) => Response | object,
    health: { pid: number; instanceId?: string } = { pid: process.pid },
): Promise<TestServer> {
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, pid: health.pid, instance_id: health.instanceId }));
            return;
        }

        if (req.method === "POST" && req.url?.startsWith("/rpc/")) {
            const method = req.url.slice("/rpc/".length);
            const result = handler(method);
            if (result instanceof Response) {
                res.writeHead(result.status, { "Content-Type": "application/json" });
                res.end(await result.text());
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
            return;
        }

        res.writeHead(404);
        res.end("Not Found");
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("failed to bind test server");

    const testServer = {
        port: addr.port,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
    servers.push(testServer);
    return testServer;
}

async function closeServer(server: TestServer): Promise<void> {
    servers = servers.filter((s) => s !== server);
    await server.close();
}

describe("MagicContextRpcClient", () => {
    test("re-reads the port file after the cached server restarts on a new port", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo";
        const client = new MagicContextRpcClient(storageDir, directory);

        const first = await startRpcServer(() => ({ value: "first" }));
        writePortFile(storageDir, directory, first.port);
        expect(await client.call<{ value: string }>("value")).toEqual({ value: "first" });

        await closeServer(first);
        const second = await startRpcServer(() => ({ value: "second" }));
        writePortFile(storageDir, directory, second.port);

        expect(await client.call<{ value: string }>("value")).toEqual({ value: "second" });
    });

    test("authenticates against a real server with the published token", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo-auth";
        const server = new MagicContextRpcServer(storageDir, directory);
        server.handle("ping", async () => ({ pong: true }));
        await server.start();
        try {
            const client = new MagicContextRpcClient(storageDir, directory);
            // The server returns 401 when a request lacks Bearer authentication.
            expect(await client.call<{ pong: boolean }>("ping")).toEqual({ pong: true });
        } finally {
            server.stop();
        }
    });

    test("a request without the token is rejected 401 by the server", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo-noauth";
        const server = new MagicContextRpcServer(storageDir, directory);
        server.handle("ping", async () => ({ pong: true }));
        const port = await server.start();
        try {
            const record = readNewestPortRecord(storageDir, directory);
            expect(typeof record?.token).toBe("string");
            expect((record?.token ?? "").length).toBeGreaterThan(0);

            const res = await fetch(`http://127.0.0.1:${port}/rpc/ping`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            expect(res.status).toBe(401);

            // The /health endpoint requires no token.
            const health = await fetch(`http://127.0.0.1:${port}/health`);
            expect(health.status).toBe(200);
        } finally {
            server.stop();
        }
    });

    test("accepts a frozen v0.32 websocket upgrade with query-token auth", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo-ws-v032";
        const server = new MagicContextRpcServer(storageDir, directory);
        const port = await server.start();
        const record = readNewestPortRecord(storageDir, directory);
        expect(typeof record?.token).toBe("string");

        const ws = await openSocket(port, record?.token ?? "", true);
        try {
            const helloAck = waitForJsonMessage(ws, (message) => message.type === "hello-ack");
            ws.send(
                JSON.stringify({
                    type: "hello",
                    token: record?.token,
                    sessionId: "ses_v032",
                }),
            );
            expect((await helloAck).type).toBe("hello-ack");
        } finally {
            ws.close();
            server.stop();
        }
    });

    test("websocket upgrade rejects missing bearer token before a socket is created", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo-ws-auth";
        const server = new MagicContextRpcServer(storageDir, directory);
        const port = await server.start();
        try {
            const res = await fetch(`http://127.0.0.1:${port}/ws`);
            expect(res.status).toBe(401);
            expect(isTuiConnected()).toBe(false);
        } finally {
            server.stop();
        }
    });

    test("re-hello replaces the previous websocket notification sink", async () => {
        drainNotifications(Number.MAX_SAFE_INTEGER);
        const storageDir = makeTempDir();
        const directory = "/repo-ws-rehello";
        const server = new MagicContextRpcServer(storageDir, directory);
        const port = await server.start();
        const record = readNewestPortRecord(storageDir, directory);
        expect(typeof record?.token).toBe("string");

        const ws = await openSocket(port, record?.token ?? "");
        const notifications: unknown[] = [];
        ws.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as {
                type?: string;
                notification?: unknown;
            };
            if (message.type === "notification") notifications.push(message.notification);
        });

        try {
            ws.send(JSON.stringify({ type: "hello", token: record?.token, sessionId: "ses_A" }));
            await waitForJsonMessage(ws, (message) => message.type === "hello-ack");
            expect(isTuiConnected("ses_A")).toBe(true);

            ws.send(JSON.stringify({ type: "hello", token: record?.token, sessionId: "ses_B" }));
            await waitForJsonMessage(ws, (message) => message.type === "hello-ack");
            expect(isTuiConnected("ses_A")).toBe(false);
            expect(isTuiConnected("ses_B")).toBe(true);

            ws.send(JSON.stringify({ type: "hello", token: record?.token, sessionId: "ses_B" }));
            await waitForJsonMessage(ws, (message) => message.type === "hello-ack");
            pushNotification("live", { ok: true }, "ses_B");
            await waitFor(() => notifications.length >= 1, "one live notification");
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(notifications).toHaveLength(1);

            ws.close();
            await waitFor(() => !isTuiConnected(), "socket sink cleanup");
        } finally {
            try {
                ws.close();
            } catch {
                // best-effort
            }
            server.stop();
        }
    });

    test("accepts legacy cursor acknowledgements during protocol skew", async () => {
        __resetNotificationStateForTests();
        const storageDir = makeTempDir();
        const directory = "/repo-legacy-ack";
        const server = new MagicContextRpcServer(storageDir, directory);
        const port = await server.start();
        const record = readNewestPortRecord(storageDir, directory);
        expect(typeof record?.token).toBe("string");

        pushNotification("legacy-one", { ok: true }, "ses_legacy");
        pushNotification("legacy-two", { ok: true }, "ses_legacy");
        const queued = drainNotifications(0, "ses_legacy", { sessionOnly: true });
        expect(queued).toHaveLength(2);

        const ws = await openSocket(port, record?.token ?? "");
        try {
            const helloAck = waitForJsonMessage<{
                type?: string;
                instanceId?: string;
            }>(ws, (message) => message.type === "hello-ack");
            ws.send(
                JSON.stringify({
                    type: "hello",
                    token: record?.token,
                    sessionId: "ses_legacy",
                }),
            );
            expect((await helloAck).instanceId).toBe(record?.instance_id);

            ws.send(
                JSON.stringify({
                    type: "ack",
                    cursor: queued[0].id,
                    sessionId: "ses_legacy",
                }),
            );
            await waitFor(() => {
                const pending = drainNotifications(0, "ses_legacy", { sessionOnly: true });
                return pending.length === 1 && pending[0].id === queued[1].id;
            }, "legacy cursor acknowledgement pruning");
        } finally {
            ws.close();
            server.stop();
        }
    });

    test("same-process servers keep distinct port files during overlap", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo-port-collision";
        const first = new MagicContextRpcServer(storageDir, directory);
        const second = new MagicContextRpcServer(storageDir, directory);
        await first.start();
        const secondPort = await second.start();

        try {
            const files = readdirSync(rpcPortDir(storageDir, directory)).filter(
                (entry) => entry.startsWith("port-") && entry.endsWith(".json"),
            );
            expect(files.length).toBeGreaterThanOrEqual(2);

            first.stop();
            const remaining = readNewestPortRecord(storageDir, directory);
            expect(remaining?.port).toBe(secondPort);

            const client = new MagicContextRpcClient(storageDir, directory);
            const endpoint = await client.resolveEndpoint();
            expect(endpoint?.port).toBe(secondPort);
            expect(endpoint?.instanceId).toBe(remaining?.instance_id);
        } finally {
            first.stop();
            second.stop();
        }
    });

    test("gives up when the port file points at a dead server", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo";
        const dead = await startRpcServer(() => ({ ok: true }));
        const port = dead.port;
        await closeServer(dead);
        writePortFile(storageDir, directory, port);

        const client = new MagicContextRpcClient(storageDir, directory);
        await expect(client.call("value")).rejects.toThrow(
            "Magic Context RPC server not available",
        );
    }, 20_000);

    test("re-resolves and retries transient 5xx responses", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo";
        let calls = 0;
        const server = await startRpcServer(() => {
            calls++;
            if (calls === 1) {
                return new Response(JSON.stringify({ error: "warming up" }), { status: 503 });
            }
            return { value: "ok" };
        });
        writePortFile(storageDir, directory, server.port);

        const client = new MagicContextRpcClient(storageDir, directory);
        expect(await client.call<{ value: string }>("value")).toEqual({ value: "ok" });
        expect(calls).toBe(2);
    });

    test("ignores newer stale pid files and discovers the latest live instance", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo";
        const live = await startRpcServer(() => ({ value: "live" }));
        writePortFileForPid(storageDir, directory, 65535, 999_999_999, Date.now() + 10_000);
        writePortFileForPid(storageDir, directory, live.port, process.pid, Date.now());

        const client = new MagicContextRpcClient(storageDir, directory);
        expect(await client.call<{ value: string }>("value")).toEqual({ value: "live" });
    });

    test("discovers a frozen v0.32 health response without an instance id", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo-v032-health";
        const legacy = await startRpcServer(() => ({ value: "legacy" }), {
            pid: process.pid,
        });
        writePortFileForPid(
            storageDir,
            directory,
            legacy.port,
            process.pid,
            Date.now(),
            "new-client-record",
        );

        const client = new MagicContextRpcClient(storageDir, directory);
        expect(await client.call<{ value: string }>("value")).toEqual({ value: "legacy" });
    });

    test("prefers this process and validates every discovery candidate identity", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo-affinity";
        const foreign = await startRpcServer(() => ({ value: "foreign" }), {
            pid: process.ppid,
            instanceId: "foreign",
        });
        const unrelated = await startRpcServer(() => ({ value: "unrelated" }), {
            pid: process.pid,
            instanceId: "different-service",
        });
        const local = await startRpcServer(() => ({ value: "local" }), {
            pid: process.pid,
            instanceId: "local-healthy",
        });

        writePortFileForPid(
            storageDir,
            directory,
            foreign.port,
            process.ppid,
            Date.now() + 20_000,
            "foreign",
        );
        writePortFileForPid(
            storageDir,
            directory,
            unrelated.port,
            process.pid,
            Date.now() + 10_000,
            "local-stale",
        );
        writePortFileForPid(
            storageDir,
            directory,
            local.port,
            process.pid,
            Date.now(),
            "local-healthy",
        );

        const client = new MagicContextRpcClient(storageDir, directory);
        expect(await client.call<{ value: string }>("value")).toEqual({ value: "local" });
    });

    test("resets discovery after a 401 response", async () => {
        const storageDir = makeTempDir();
        const directory = "/repo-reauth";
        let unauthorizedRecord = "";
        const unauthorized = await startRpcServer(
            () => {
                rmSync(unauthorizedRecord, { force: true });
                return new Response("stale token", { status: 401 });
            },
            { pid: process.pid, instanceId: "unauthorized" },
        );
        const healthy = await startRpcServer(() => ({ value: "healthy" }), {
            pid: process.pid,
            instanceId: "healthy",
        });
        unauthorizedRecord = writePortFileForPid(
            storageDir,
            directory,
            unauthorized.port,
            process.pid,
            Date.now() + 10_000,
            "unauthorized",
            "stale",
        );
        writePortFileForPid(
            storageDir,
            directory,
            healthy.port,
            process.pid,
            Date.now(),
            "healthy",
        );

        const client = new MagicContextRpcClient(storageDir, directory);
        expect(await client.call<{ value: string }>("value")).toEqual({ value: "healthy" });
    });
});
