export declare class MagicContextRpcClient {
    private port;
    private token;
    private instanceId;
    private portDir;
    private legacyPortFilePath;
    private healthChecked;
    constructor(storageDir: string, directory: string);
    /** Call an RPC method. Retries port resolution if the server isn't ready yet. */
    call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
    /** Check if the RPC server is reachable. */
    isAvailable(): Promise<boolean>;
    /** Resolve the live server's port + bearer token (for opening the WS push
     *  channel). Reuses the same health-checked port-file discovery as `call`,
     *  so the WS client and the HTTP client always agree on which server instance
     *  (and token) to use. Returns null when no live server is found. */
    resolveEndpoint(): Promise<{
        port: number;
        token: string | null;
        instanceId: string | null;
    } | null>;
    private resolvePort;
    private readPortFiles;
    private healthCheck;
    private fetchWithTimeout;
    reset(): void;
}
//# sourceMappingURL=rpc-client.d.ts.map