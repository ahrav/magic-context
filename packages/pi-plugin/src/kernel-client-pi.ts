/**
 * Pi's kernel clients come from the shared factory, so both harnesses dial the
 * daemon through one transport adapter. A forked session gets its own token
 * cache: its first read fetches from tip and carries none of the parent's
 * tokens or `known_as_of`.
 */

import {
	createKernelClient,
	type KernelClientConfig,
} from "@magic-context/core/hooks/magic-context/kernel-transport";
import {
	type KernelClientResolver,
	TokenCache,
} from "@magic-context/core/shared/kernel-client";

interface IsolatedTokenState {
	tokens: TokenCache;
	/** Orders project roots from least to most recently resolved and bounds the cache's per-project token buckets. */
	rootOrder: Set<string>;
	/** The connection file each root's tokens were minted against: a token's `known_as_of` is a position in one daemon's event sequence, so a root re-resolved under a different connection file drops that root's tokens instead of presenting them to the new daemon. commentlint: allow(JUDGE) */
	connectionFileByRoot: Map<string, string>;
}

const isolatedTokenCaches = new Map<string, IsolatedTokenState>();

/** Cap on project roots whose token buckets one forked session retains; `/cd` past the cap evicts the least-recently-resolved root's tokens, mirroring the shared cache's bound. commentlint: allow(JUDGE) */
export const MAX_ISOLATED_TOKEN_CACHE_PROJECTS = 4;

/** Every kernel operation resolves a client for its project root first; resolution order therefore tracks token-cache access order. commentlint: allow(JUDGE) */
function touchIsolatedRoot(
	state: IsolatedTokenState,
	projectRoot: string,
	connectionFile: string,
): void {
	const previous = state.connectionFileByRoot.get(projectRoot);
	if (previous !== undefined && previous !== connectionFile) {
		state.tokens.dropProject(projectRoot);
	}
	state.connectionFileByRoot.set(projectRoot, connectionFile);
	state.rootOrder.delete(projectRoot);
	state.rootOrder.add(projectRoot);
	while (state.rootOrder.size > MAX_ISOLATED_TOKEN_CACHE_PROJECTS) {
		const oldest: string | undefined = state.rootOrder.values().next().value;
		if (oldest === undefined) break;
		state.rootOrder.delete(oldest);
		state.connectionFileByRoot.delete(oldest);
		state.tokens.dropProject(oldest);
	}
}

export function isolatePiSessionKernelTokens(sessionId: string): void {
	isolatedTokenCaches.set(sessionId, {
		tokens: new TokenCache(),
		rootOrder: new Set(),
		connectionFileByRoot: new Map(),
	});
}

export function forgetPiSessionKernelTokens(sessionId: string): void {
	isolatedTokenCaches.delete(sessionId);
}

/**
 * `resolveConfig` runs per call because `/cd` can move a Pi process between
 * projects with different `memory.enabled` or connection-file settings.
 */
export function createPiKernelClientResolver(
	resolveConfig: (projectRoot: string) => KernelClientConfig,
): KernelClientResolver {
	return ({ sessionId, projectRoot }) => {
		const config = resolveConfig(projectRoot);
		const isolated = isolatedTokenCaches.get(sessionId);
		if (isolated) {
			touchIsolatedRoot(
				isolated,
				projectRoot,
				config.subc?.connection_file ?? "",
			);
		}
		return createKernelClient({
			sessionId,
			projectRoot,
			config,
			...(isolated ? { tokens: isolated.tokens } : {}),
		});
	};
}

/** Test hook: the isolated token cache one session holds, if any. */
export function piSessionTokenCacheForTest(
	sessionId: string,
): TokenCache | undefined {
	return isolatedTokenCaches.get(sessionId)?.tokens;
}

/** Test hook: drops every isolated token cache. */
export function resetPiKernelClientsForTest(): void {
	isolatedTokenCaches.clear();
}
