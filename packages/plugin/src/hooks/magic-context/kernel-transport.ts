/**
 * Adapts `McHostModuleTransport` to `KernelTransport` and creates per-session
 * clients that share a transport and token cache per connection file.
 */

import { existsSync } from "node:fs";
import {
    KernelClient,
    type KernelClientResolver,
    type KernelTransport,
    type KernelTransportCall,
    TokenCache,
} from "../../shared/kernel-client";
import { McHostModuleTransport } from "./module-transport";
import type { KernelMethod } from "./module-wire";

const KERNEL_METHODS: ReadonlySet<string> = new Set<KernelMethod>([
    "kernel.read",
    "kernel.commit",
    "kernel.eligibility.batch",
    "kernel.egress.decide",
    "kernel.artifact.ingest.begin",
    "kernel.artifact.ingest.page",
    "kernel.artifact.ingest.finish",
]);

function isKernelMethod(method: string): method is KernelMethod {
    return KERNEL_METHODS.has(method);
}

/**
 * `connectionFileExists` is a synchronous stat so the client can answer
 * `daemon_absent` before any dial; `ensureRoute` forgets the cached route and
 * lets the next call reopen it.
 */
export function createKernelTransport(transport: McHostModuleTransport): KernelTransport {
    return {
        connectionFileExists: () => existsSync(transport.connectionFilePath),
        call(args: KernelTransportCall): Promise<unknown> {
            if (!isKernelMethod(args.method)) {
                return Promise.reject(
                    new Error(`kernel transport refuses non-kernel method ${args.method}`),
                );
            }
            return transport.call({
                sessionId: args.sessionId,
                projectRoot: args.projectRoot,
                method: args.method,
                body: args.body,
                ...(args.signal ? { signal: args.signal } : {}),
                ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
            });
        },
        async ensureRoute(args): Promise<void> {
            transport.forgetRoute(args.sessionId, args.projectRoot);
        },
    };
}

/** The configuration slice the factory reads; `MagicContextConfig` satisfies it. */
export interface KernelClientConfig {
    memory?: { enabled?: boolean };
    subc?: { connection_file?: string };
}

interface SharedKernelState {
    transport: KernelTransport;
    tokens: TokenCache;
}

const sharedByConnectionFile = new Map<string, SharedKernelState>();

function sharedState(connectionFile: string | undefined): SharedKernelState {
    const key = connectionFile ?? "";
    let shared = sharedByConnectionFile.get(key);
    if (!shared) {
        shared = {
            transport: createKernelTransport(new McHostModuleTransport(connectionFile)),
            tokens: new TokenCache(),
        };
        sharedByConnectionFile.set(key, shared);
    }
    return shared;
}

export interface CreateKernelClientArgs {
    sessionId: string;
    projectRoot: string;
    config: KernelClientConfig;
    /** Replaces the shared module transport; tests pass a fake here. */
    transport?: KernelTransport;
    tokens?: TokenCache;
}

/**
 * Applies `memory.enabled` to every client. Clients for the same connection
 * file share a transport (one dial, one route cache) and a token cache
 * (tokens are keyed by project, not session).
 */
export function createKernelClient(args: CreateKernelClientArgs): KernelClient {
    const shared = args.transport ? null : sharedState(args.config.subc?.connection_file);
    return new KernelClient({
        transport: args.transport ?? (shared as SharedKernelState).transport,
        tokens: args.tokens ?? shared?.tokens ?? new TokenCache(),
        enabled: args.config.memory?.enabled !== false,
        sessionId: args.sessionId,
        projectRoot: args.projectRoot,
    });
}

/** Binds one configuration so consumers resolve clients by session and project root alone. */
export function kernelClientResolver(config: KernelClientConfig): KernelClientResolver {
    return ({ sessionId, projectRoot }) => createKernelClient({ sessionId, projectRoot, config });
}

/** Drops shared transports and token caches between test cases. */
export function resetKernelClientsForTest(): void {
    sharedByConnectionFile.clear();
}
