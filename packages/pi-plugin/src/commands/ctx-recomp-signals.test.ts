import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 *
 * Pi `/ctx-recomp` runs detached to keep the REPL responsive.
 *
 */

const PATH = join(import.meta.dir, "ctx-recomp.ts");
const SRC = readFileSync(PATH, "utf8");

const codeOnly = SRC.split("\n")
	.filter((line) => !line.trim().startsWith("//"))
	.join("\n");

describe("/ctx-recomp post-completion signal contract", () => {
	test("runs detached via spawnPiRecompRun (non-blocking REPL)", () => {
		expect(codeOnly).toContain("spawnPiRecompRun(");
	});

	test("uses DEFERRED history-refresh signal (background-safe)", () => {
		expect(codeOnly).toContain("signalPiDeferredHistoryRefresh(sessionId)");
	});

	test("uses DEFERRED materialization signal (background-safe)", () => {
		expect(codeOnly).toContain("signalPiDeferredMaterialization(sessionId)");
	});

	test("does NOT use the eager signals (would materialize mid-turn from background)", () => {
		expect(codeOnly).not.toContain("signalPiHistoryRefresh(sessionId)");
		expect(codeOnly).not.toContain("signalPiPendingMaterialization(sessionId)");
	});

	test("signals fire only inside the published branch, not unconditionally", () => {
		const publishedGate = codeOnly.indexOf("if (result.published)");
		const deferredSignal = codeOnly.indexOf(
			"signalPiDeferredMaterialization(sessionId)",
		);
		expect(publishedGate).toBeGreaterThan(-1);
		expect(deferredSignal).toBeGreaterThan(publishedGate);
	});

	test("stages the marker (deferred) instead of applying it eagerly", () => {
		expect(codeOnly).toContain("stagePiRecompMarker(");
		expect(codeOnly).not.toContain("queueAndApplyPiRecompMarker(");
	});

	test("clears needs_emergency_recovery on a published recomp (parity with OpenCode)", () => {
		expect(codeOnly).toContain(
			"clearEmergencyRecovery(currentDeps.db, sessionId)",
		);
		const publishedGate = codeOnly.indexOf("if (result.published)");
		const clearCall = codeOnly.indexOf(
			"clearEmergencyRecovery(currentDeps.db, sessionId)",
		);
		expect(clearCall).toBeGreaterThan(publishedGate);
	});
});
