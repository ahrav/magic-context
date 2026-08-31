import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ran" bug.
 *
 *
 *
 *
 */

const HANDLER_PATH = join(import.meta.dir, "context-handler.ts");
const HANDLER_SRC = readFileSync(HANDLER_PATH, "utf8");
const RUNNER_SRC = readFileSync(
	join(import.meta.dir, "pi-historian-runner.ts"),
	"utf8",
);

function extractOnPublishedBodies(src: string): string[] {
	const bodies: string[] = [];
	let cursor = 0;
	while (true) {
		const start = src.indexOf("onPublished: () => {", cursor);
		if (start === -1) break;
		let depth = 0;
		let i = start;
		while (i < src.length) {
			const ch = src[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					bodies.push(src.slice(start, i + 1));
					cursor = i + 1;
					break;
				}
			}
			i++;
		}
		if (i >= src.length) break;
	}
	return bodies;
}

describe("historian onPublished signals", () => {
	const bodies = extractOnPublishedBodies(HANDLER_SRC);

	test("found exactly one onPublished callback (historian)", () => {
		expect(bodies.length).toBe(1);
	});

	test("every onPublished signals deferred history refresh", () => {
		for (const body of bodies) {
			expect(body).toContain("signalPiDeferredHistoryRefresh(sessionId)");
		}
	});

	test("every onPublished signals deferred materialization", () => {
		for (const body of bodies) {
			expect(body).toContain("signalPiDeferredMaterialization(sessionId)");
			expect(body).not.toContain("signalPiHistoryRefresh(sessionId)");
			expect(body).not.toContain("signalPiPendingMaterialization(sessionId)");
		}
	});

	test("every onPublished does NOT signal signalPiSystemPromptRefresh", () => {
		for (const body of bodies) {
			expect(body).not.toContain("signalPiSystemPromptRefresh");
		}
	});
	test("Pi historian publish path does not eagerly clear the injection cache", () => {
		expect(RUNNER_SRC).not.toContain("clearInjectionCache");
	});
});
