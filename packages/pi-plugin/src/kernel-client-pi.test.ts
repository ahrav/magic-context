import { afterEach, describe, expect, it } from "bun:test";
import { resetKernelClientsForTest } from "@magic-context/core/hooks/magic-context/kernel-transport";
import {
	createPiKernelClientResolver,
	isolatePiSessionKernelTokens,
	MAX_ISOLATED_TOKEN_CACHE_PROJECTS,
	piSessionTokenCacheForTest,
	resetPiKernelClientsForTest,
} from "./kernel-client-pi";

const OBJECT_ID = `mem_${"a".repeat(32)}`;

function root(index: number): string {
	return `/proj/root-${index}`;
}

afterEach(() => {
	resetPiKernelClientsForTest();
	resetKernelClientsForTest();
});

describe("isolated Pi session token caches", () => {
	it("evicts the least-recently-resolved root's tokens past the project cap", () => {
		const sessionId = "ses-fork-evict";
		isolatePiSessionKernelTokens(sessionId);
		const resolver = createPiKernelClientResolver(() => ({}));
		const tokens = piSessionTokenCacheForTest(sessionId);
		if (tokens === undefined) throw new Error("isolated cache missing");

		for (let i = 0; i <= MAX_ISOLATED_TOKEN_CACHE_PROJECTS; i += 1) {
			resolver({ sessionId, projectRoot: root(i) });
			tokens.rememberTokens(
				root(i),
				[{ object_id: OBJECT_ID, known_as_of: i + 1 }],
				i + 1,
			);
		}

		expect(tokens.get(root(0), OBJECT_ID)).toBeUndefined();
		expect(tokens.knownAsOfFor(root(0))).toBeUndefined();
		for (let i = 1; i <= MAX_ISOLATED_TOKEN_CACHE_PROJECTS; i += 1) {
			expect(tokens.get(root(i), OBJECT_ID)).toEqual({
				object_id: OBJECT_ID,
				known_as_of: i + 1,
			});
		}
	});

	it("re-resolving a root refreshes its recency so the next eviction takes the stale root", () => {
		const sessionId = "ses-fork-touch";
		isolatePiSessionKernelTokens(sessionId);
		const resolver = createPiKernelClientResolver(() => ({}));
		const tokens = piSessionTokenCacheForTest(sessionId);
		if (tokens === undefined) throw new Error("isolated cache missing");

		for (let i = 0; i < MAX_ISOLATED_TOKEN_CACHE_PROJECTS; i += 1) {
			resolver({ sessionId, projectRoot: root(i) });
			tokens.rememberTokens(
				root(i),
				[{ object_id: OBJECT_ID, known_as_of: i + 1 }],
				i + 1,
			);
		}
		resolver({ sessionId, projectRoot: root(0) });
		resolver({
			sessionId,
			projectRoot: root(MAX_ISOLATED_TOKEN_CACHE_PROJECTS),
		});

		expect(tokens.knownAsOfFor(root(1))).toBeUndefined();
		expect(tokens.get(root(0), OBJECT_ID)).toEqual({
			object_id: OBJECT_ID,
			known_as_of: 1,
		});
	});

	it("a session without an isolated cache keeps no per-session token state", () => {
		const resolver = createPiKernelClientResolver(() => ({}));
		resolver({ sessionId: "ses-unforked", projectRoot: root(0) });
		expect(piSessionTokenCacheForTest("ses-unforked")).toBeUndefined();
	});
});
