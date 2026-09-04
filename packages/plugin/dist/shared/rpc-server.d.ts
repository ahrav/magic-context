type RpcHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
/**
 * Plugin-private localhost RPC server for TUI ↔ server-plugin communication.
 *
 * Runs on Bun (the OpenCode server runner is a Bun Worker), so it uses
 * `Bun.serve` to host BOTH:
 *  - HTTP request/reply routes (`/health`, `/rpc/<method>`) — the TUI's snapshot
 *    and dialog-result calls, which are event-driven, not idle; and
 *  - a WebSocket endpoint (`/ws`) — a single persistent connection per TUI over
 *    which the server PUSHES notifications (dialog/toast actions). This replaces
 *    the old 500ms HTTP poll, whose new-connection-per-tick cost was the source
 *    of idle TUI CPU (#200). Pi never imports this module, so `Bun.serve` is safe.
 */
export declare class MagicContextRpcServer {
    private server;
    private port;
    private handlers;
    private portFilePath;
    private portDir;
    private startedAt;
    private readonly instanceId;
    /** Every authenticated WS socket, so dispose can close them all. */
    private sockets;
    private readonly token;
    constructor(storageDir: string, directory: string);
    /** Register an RPC method handler. */
    handle(method: string, handler: RpcHandler): void;
    /** Start the server on a random port, write port to disk. */
    start(): Promise<number>;
    /** Stop the server: close every socket, stop accepting, remove port file. */
    stop(): void;
    private warnIfOtherLiveInstance;
    /** HTTP route handler (Bun fetch). Returns a Response, or undefined when the
     *  request was upgraded to a WebSocket. */
    private handleFetch;
    /** WS message handler: hello (auth + sink registration + backlog delivery) and
     *  ack (exact removal or legacy cursor pruning). All other messages are ignored. */
    private handleWsMessage;
}
export {};
//# sourceMappingURL=rpc-server.d.ts.map