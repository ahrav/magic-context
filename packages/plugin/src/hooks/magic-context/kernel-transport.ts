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

/** A demand-start-capable transport is reachable with no connection file because `call` starts its daemon; every other origin keeps the synchronous stat that answers `daemon_absent` before any dial. `ensureRoute` forgets the cached route and lets the next call reopen it. commentlint: allow(JUDGE) */
export function createKernelTransport(transport: McHostModuleTransport): KernelTransport {
    return {
        connectionFileExists: () =>
            transport.canDemandStart() || existsSync(transport.connectionFilePath),
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
    module: McHostModuleTransport;
    transport: KernelTransport;
    tokens: TokenCache;
    /** The set orders project roots from least to most recently resolved and bounds per-project token buckets. */
    tokenProjectOrder: Set<string>;
}

/** Cap on project roots whose token buckets the shared cache retains per connection file; resolving a client past the cap evicts the least-recently-resolved root's tokens. commentlint: allow(JUDGE) */
export const MAX_TOKEN_CACHE_PROJECTS = 32;

/** Cap on connection files whose shared transports the process retains: a long-lived host that `/cd`s across projects with distinct `connection_file` values would otherwise accumulate one live transport — socket, token cache, route cache — per daemon configuration forever. Eviction disconnects the transport; a client resolved before the eviction fails its next call and re-resolves against a fresh shared state. commentlint: allow(JUDGE) */
export const MAX_CONNECTION_FILE_STATES = 8;

/** Every kernel operation resolves a client for its project root first; client resolution order therefore tracks token-cache access order. commentlint: allow(JUDGE) */
function touchTokenProject(shared: SharedKernelState, projectRoot: string): void {
    shared.tokenProjectOrder.delete(projectRoot);
    shared.tokenProjectOrder.add(projectRoot);
    while (shared.tokenProjectOrder.size > MAX_TOKEN_CACHE_PROJECTS) {
        const oldest: string | undefined = shared.tokenProjectOrder.values().next().value;
        if (oldest === undefined) break;
        shared.tokenProjectOrder.delete(oldest);
        shared.tokens.dropProject(oldest);
    }
}

const sharedByConnectionFile = new Map<string, SharedKernelState>();

function sharedState(connectionFile: string | undefined): SharedKernelState {
    const key = connectionFile ?? "";
    let shared = sharedByConnectionFile.get(key);
    if (shared) {
        // Map insertion order doubles as recency order, so a hit re-inserts its entry.
        sharedByConnectionFile.delete(key);
        sharedByConnectionFile.set(key, shared);
        return shared;
    }
    const module = new McHostModuleTransport(connectionFile);
    shared = {
        module,
        transport: createKernelTransport(module),
        tokens: new TokenCache(),
        tokenProjectOrder: new Set(),
    };
    sharedByConnectionFile.set(key, shared);
    while (sharedByConnectionFile.size > MAX_CONNECTION_FILE_STATES) {
        const oldestKey: string | undefined = sharedByConnectionFile.keys().next().value;
        if (oldestKey === undefined) break;
        const evicted = sharedByConnectionFile.get(oldestKey);
        sharedByConnectionFile.delete(oldestKey);
        evicted?.module.disconnect();
    }
    return shared;
}

export interface CreateKernelClientArgs {
    sessionId: string;
    projectRoot: string;
    config: KernelClientConfig;
    /** Replaces the shared module transport and opts out of the shared token cache: a token's `known_as_of` is a position in one daemon's event sequence, and tokens minted against one transport's daemon are not valid against another's. Without an explicit `tokens`, each call gets a fresh cache; pass `tokens` to keep mutation-token continuity across clients on the same transport. commentlint: allow(JUDGE) */
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
    if (shared && args.tokens === undefined) {
        touchTokenProject(shared, args.projectRoot);
    }
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
