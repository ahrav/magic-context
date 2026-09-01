import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * execution.
 *
 *
 */

const PATH = join(import.meta.dir, "ctx-session-upgrade.ts");
const SRC = readFileSync(PATH, "utf8");
const codeOnly = SRC.split("\n")
	.filter((line) => !line.trim().startsWith("//"))
	.join("\n");

describe("/ctx-session-upgrade detached execution contract", () => {
	test("runs detached via spawnPiRecompRun (non-blocking REPL)", () => {
		expect(codeOnly).toContain("spawnPiRecompRun(");
	});

	test("uses DEFERRED signals (background-safe), not eager", () => {
		expect(codeOnly).toContain("signalPiDeferredHistoryRefresh(sessionId)");
		expect(codeOnly).toContain("signalPiDeferredMaterialization(sessionId)");
		expect(codeOnly).not.toContain("signalPiHistoryRefresh(sessionId)");
		expect(codeOnly).not.toContain("signalPiPendingMaterialization(sessionId)");
	});

	test("stages the marker (deferred) instead of applying it eagerly", () => {
		expect(codeOnly).toContain("stagePiRecompMarker(");
		expect(codeOnly).not.toContain("queueAndApplyPiRecompMarker(");
	});

	test("guards against double-spawn while a recomp/upgrade is in flight", () => {
		expect(codeOnly).toContain("isPiRecompInFlight(sessionId)");
	});

	test("still gates migration + Complete on a published full recomp", () => {
		// Migration and `Complete` require a published full recomp.
		expect(codeOnly).toContain("isRecompComplete(recompResult.message)");
		expect(codeOnly).toContain("!recompResult.published");
	});
});
