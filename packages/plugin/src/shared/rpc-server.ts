import { randomBytes, timingSafeEqual } from "node:crypto";
import {
    chmodSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { log } from "./logger";
import {
    acknowledgeNotifications,
    drainNotifications,
    type NotificationSink,
    registerNotificationSink,
} from "./rpc-notifications";
import { isPidAlive, parseRpcPortFile, rpcPortDir, rpcPortFilePath } from "./rpc-utils";
import { shouldEnforcePrivateStoragePermissions } from "./storage-permissions";

type RpcHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/* */
const MAX_BODY_BYTES = 1_048_576;
/** The server closes a WS client that does not authenticate within 5,000 ms. */
const WS_AUTH_TIMEOUT_MS = 5_000;
/** The server closes WebSocket authentication failures with code 4401.
 * */
const WS_CLOSE_UNAUTHORIZED = 4401;

/** `WsData` stores per-socket state in `ServerWebSocket.data`. */
interface WsData {
    authed: boolean;
    sessionId?: string;
    /** `unregister` removes this socket's sink from the notification registry. */
    unregister?: () => void;
    /** The auth timer fires if the client never sends a valid hello. */
    authTimer?: ReturnType<typeof setTimeout>;
}

/**
 * `tokensMatch` checks buffer lengths before calling `timingSafeEqual`, which throws for unequal-length buffers.
 * Token length is not secret, but token bytes are.
 * The comparison avoids leaking token bytes through loopback-auth response timing.
 */
function tokensMatch(presented: string, expected: string): boolean {
    const a = Buffer.from(presented, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

function bearerToken(req: Request): string {
    const auth = req.headers.get("authorization");
    return typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "";
}

function websocketToken(req: Request): string {
    const headerToken = bearerToken(req);
    if (headerToken) return headerToken;
    return new URL(req.url).searchParams.get("token") ?? "";
}

/**
 * `MagicContextRpcServer` provides localhost RPC communication between the TUI and server plugin.
 *
 * The TUI uses `/health` and `/rpc/<method>` for event-driven snapshot and dialog-result requests.
 * The TUI makes snapshot and dialog-result calls through HTTP routes rather than an idle connection.
 * The TUI uses `/ws` for a persistent WebSocket connection.
 * The server pushes dialog and toast actions over `/ws`.
 */
export class MagicContextRpcServer {
    private server: Server<WsData> | null = null;
    private port = 0;
    private handlers = new Map<string, RpcHandler>();
    private portFilePath: string;
    private portDir: string;
    private startedAt = Date.now();
    private readonly instanceId = randomBytes(8).toString("hex");
    /** `sockets` tracks authenticated WebSocket sockets so `dispose` can close them. */
    private sockets = new Set<ServerWebSocket<WsData>>();
    // Each server instance publishes its bearer token in the user-private port file.
    // The server requires the token on every non-health RPC call and in the WebSocket hello.
    // The token protects recompilation, upgrade, dismissal, and push-channel endpoints.
    // The token blocks local processes and browser scripts that discover or guess the port from accessing protected endpoints.
    private readonly token = randomBytes(32).toString("hex");

    constructor(storageDir: string, directory: string) {
        this.portFilePath = rpcPortFilePath(storageDir, directory, process.pid, this.instanceId);
        this.portDir = rpcPortDir(storageDir, directory);
    }

    /* */
    handle(method: string, handler: RpcHandler): void {
        this.handlers.set(method, handler);
    }

    /* */
    async start(): Promise<number> {
        if (typeof Bun === "undefined") {
            // The terminal-TUI sidebar is unavailable on Node/Electron.
            // On Node/Electron, no RPC consumer exists, so start returns without calling Bun.serve.
            log("rpc server skipped: Bun runtime not available (no TUI consumer)");
            return 0;
        }
        this.startedAt = Date.now();
        const self = this;
        const server = Bun.serve<WsData>({
            port: 0,
            hostname: "127.0.0.1",
            fetch(req, srv) {
                return self.handleFetch(req, srv);
            },
            websocket: {
                open(ws) {
                    // The server closes unauthenticated sockets after `WS_AUTH_TIMEOUT_MS`.
                    ws.data.authTimer = setTimeout(() => {
                        if (!ws.data.authed) ws.close(WS_CLOSE_UNAUTHORIZED, "auth timeout");
                    }, WS_AUTH_TIMEOUT_MS);
                },
                message(ws, raw) {
                    self.handleWsMessage(ws, raw);
                },
                close(ws) {
                    if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
                    ws.data.unregister?.();
                    self.sockets.delete(ws);
                },
            },
        });

        this.server = server;
        this.port = server.port ?? 0;

        // The port-file writer writes each instance's port file atomically so readers never observe a partial file.
        try {
            this.warnIfOtherLiveInstance();
            const dir = dirname(this.portFilePath);
            // When private permissions are enforced, the port file has owner-only permissions.
            // Trusted-group deployments delegate storage-permission policy to the operator.
            // When trusted-group policy is enabled, the port-file creation path must not call `chmod` or set a restrictive creation mode.
            const enforcePrivatePermissions = shouldEnforcePrivateStoragePermissions();
            if (enforcePrivatePermissions) {
                mkdirSync(dir, { recursive: true, mode: 0o700 });
                try {
                    chmodSync(dir, 0o700);
                } catch {}
            } else {
                mkdirSync(dir, { recursive: true });
            }
            const tmpPath = `${this.portFilePath}.tmp`;
            // The port-file writer must not reuse a stale temporary file with loose permissions after a crashed write.
            // `writeFileSync` applies `mode` only when creating a file, so remove the stale temporary file first.
            try {
                rmSync(tmpPath, { force: true });
            } catch {
                // best-effort
            }
            // The private mode keeps the bearer token out of other local accounts;
            // When enforcePrivatePermissions is false, writeFileSync leaves the mode to the umask.
            writeFileSync(
                tmpPath,
                JSON.stringify({
                    port: this.port,
                    pid: process.pid,
                    started_at: this.startedAt,
                    kind: "OpenCode server",
                    token: this.token,
                    instance_id: this.instanceId,
                }),
                enforcePrivatePermissions
                    ? { encoding: "utf-8", mode: 0o600 }
                    : { encoding: "utf-8" },
            );
            renameSync(tmpPath, this.portFilePath);
            if (enforcePrivatePermissions) {
                try {
                    chmodSync(this.portFilePath, 0o600);
                } catch {}
            }
            log(`[rpc] server listening on 127.0.0.1:${this.port}`);
        } catch (err) {
            log(`[rpc] failed to write port file: ${err}`);
        }

        return this.port;
    }

    /* */
    stop(): void {
        for (const ws of this.sockets) {
            try {
                if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
                ws.data.unregister?.();
                ws.close();
            } catch {
                // best-effort
            }
        }
        this.sockets.clear();
        if (this.server) {
            // `stop(true)` closes active connections too, not just the listener.
            this.server.stop(true);
            this.server = null;
        }
        try {
            unlinkSync(this.portFilePath);
        } catch {
            // The port file may already be gone.
        }
    }

    private warnIfOtherLiveInstance(): void {
        try {
            for (const entry of readdirSync(this.portDir)) {
                if (!entry.startsWith("port-") || !entry.endsWith(".json")) continue;
                const record = parseRpcPortFile(readFileSync(`${this.portDir}/${entry}`, "utf-8"));
                if (!record || record.pid === process.pid || !isPidAlive(record.pid)) continue;
                log(
                    `[rpc] another Magic Context RPC server is active for this project (pid ${record.pid}, port ${record.port}); starting separate instance on a new port`,
                );
                return;
            }
        } catch {}
    }

    /** Bun fetch returns undefined after upgrading a request to a WebSocket.
     * */
    private async handleFetch(req: Request, srv: Server<WsData>): Promise<Response | undefined> {
        const url = new URL(req.url);

        // The handler authenticates the WebSocket request before srv.upgrade so unauthorized requests never become live sockets.
        if (url.pathname === "/ws") {
            if (!tokensMatch(websocketToken(req), this.token)) {
                return new Response("Unauthorized", { status: 401 });
            }
            const ok = srv.upgrade(req, { data: { authed: false } });
            if (ok) return undefined;
            return new Response("upgrade failed", { status: 400 });
        }

        if (req.method === "GET" && url.pathname === "/health") {
            return json({ ok: true, pid: process.pid, instance_id: this.instanceId });
        }

        if (req.method !== "POST" || !url.pathname.startsWith("/rpc/")) {
            return new Response("Not Found", { status: 404 });
        }

        // Every side-effecting call requires the per-process bearer token.
        if (!tokensMatch(bearerToken(req), this.token)) {
            return json({ error: "Unauthorized" }, 401);
        }

        const method = url.pathname.slice(5); // strip "/rpc/"
        const handler = this.handlers.get(method);
        if (!handler) {
            return json({ error: `Unknown method: ${method}` }, 404);
        }

        const bodyText = await req.text();
        if (bodyText.length > MAX_BODY_BYTES) {
            return new Response("Request too large", { status: 413 });
        }
        let params: Record<string, unknown> = {};
        if (bodyText.length > 0) {
            try {
                params = JSON.parse(bodyText);
            } catch {
                return json({ error: "Invalid JSON" }, 400);
            }
        }

        try {
            const result = await handler(params);
            return json(result);
        } catch (err) {
            log(`[rpc] handler error: ${method} => ${err}`);
            return json({ error: String(err) }, 500);
        }
    }

    /**
     * */
    private handleWsMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
        let msg: {
            type?: string;
            token?: string;
            sessionId?: string;
            lastReceivedId?: number;
            globalLastReceivedId?: number;
            ackScope?: string;
            protocol?: number;
            instanceId?: string;
            ids?: unknown;
            cursor?: number;
        };
        try {
            msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
        } catch {
            return;
        }

        if (msg.type !== "hello" && !ws.data.authed) return;

        if (msg.type === "hello") {
            if (!tokensMatch(typeof msg.token === "string" ? msg.token : "", this.token)) {
                ws.send(JSON.stringify({ type: "error", error: "unauthorized" }));
                ws.close(WS_CLOSE_UNAUTHORIZED, "bad token");
                return;
            }
            if (ws.data.authTimer) {
                clearTimeout(ws.data.authTimer);
                ws.data.authTimer = undefined;
            }
            ws.data.authed = true;
            ws.data.sessionId =
                typeof msg.sessionId === "string" && msg.sessionId.length > 0
                    ? msg.sessionId
                    : undefined;

            // Before sending another hello, `handleWsMessage` removes the old sink so each socket has exactly one live sink.
            // `handleWsMessage` registers the replacement sink before sending hello so each socket has exactly one live sink.
            ws.data.unregister?.();
            ws.data.unregister = undefined;

            // `handleWsMessage` registers a live sink so future pushes reach this socket immediately.
            const sink: NotificationSink = {
                sessionId: ws.data.sessionId,
                protocol: msg.protocol,
                send: (notification) => {
                    ws.send(JSON.stringify({ type: "notification", notification }));
                },
            };
            ws.data.unregister = registerNotificationSink(sink);
            this.sockets.add(ws);

            const usesExactAcknowledgements = msg.protocol === 2;
            // The server sends the epoch before backlog frames so the client discards cursors and deduplication entries from a replaced server first.
            ws.send(
                JSON.stringify({
                    type: "hello-ack",
                    protocol: 2,
                    instanceId: this.instanceId,
                }),
            );

            let backlog: ReturnType<typeof drainNotifications>;
            if (usesExactAcknowledgements) {
                // Protocol 2 never treats a high handled ID as proof that lower IDs were consumed.
                // Only exact acknowledgements remove entries, so declined or interrupted dialogs survive reconnects.
                backlog =
                    ws.data.sessionId === undefined
                        ? drainNotifications(0, undefined, { globalOnly: true })
                        : drainNotifications(0, ws.data.sessionId, {
                              globalLastReceivedId: 0,
                          });
            } else {
                // Legacy clients use independent session and global watermarks.
                const lastReceivedId = Number(msg.lastReceivedId ?? 0);
                const sessionCursor = Number.isFinite(lastReceivedId) ? lastReceivedId : 0;
                const hasGlobalCursor = typeof msg.globalLastReceivedId === "number";
                const globalLastReceivedId = hasGlobalCursor
                    ? Number.isFinite(msg.globalLastReceivedId)
                        ? msg.globalLastReceivedId
                        : 0
                    : 0;
                backlog =
                    ws.data.sessionId === undefined && hasGlobalCursor
                        ? drainNotifications(globalLastReceivedId, undefined, { globalOnly: true })
                        : drainNotifications(
                              sessionCursor,
                              ws.data.sessionId,
                              hasGlobalCursor
                                  ? { globalLastReceivedId: globalLastReceivedId }
                                  : undefined,
                          );
            }
            for (const notification of backlog) {
                ws.send(JSON.stringify({ type: "notification", notification }));
            }
            return;
        }

        if (msg.type === "ack") {
            if (Array.isArray(msg.ids)) {
                acknowledgeNotifications(
                    msg.ids.filter((id): id is number => typeof id === "number"),
                );
                return;
            }

            // Legacy clients require watermark acknowledgements.
            // Legacy acknowledgements apply only to the current socket scope.
            const lastReceivedId = Number(msg.cursor ?? msg.lastReceivedId ?? 0);
            if (Number.isFinite(lastReceivedId) && lastReceivedId > 0) {
                if (msg.ackScope === "global") {
                    drainNotifications(lastReceivedId, undefined, { globalOnly: true });
                } else if (typeof msg.sessionId === "string" && msg.sessionId.length > 0) {
                    drainNotifications(lastReceivedId, msg.sessionId, { sessionOnly: true });
                } else {
                    // Older clients use one cursor for their current socket scope.
                    drainNotifications(lastReceivedId, ws.data.sessionId);
                }
            }
        }
    }
}

/* */
function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
