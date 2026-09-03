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

const isolatedTokenCaches = new Map<string, TokenCache>();

export function isolatePiSessionKernelTokens(sessionId: string): void {
	isolatedTokenCaches.set(sessionId, new TokenCache());
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
		const tokens = isolatedTokenCaches.get(sessionId);
		return createKernelClient({
			sessionId,
			projectRoot,
			config: resolveConfig(projectRoot),
			...(tokens ? { tokens } : {}),
		});
	};
}

/** Test hook: drops every isolated token cache. */
export function resetPiKernelClientsForTest(): void {
	isolatedTokenCaches.clear();
}
