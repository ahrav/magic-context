import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 *
 *
 * This test inspects source because the contract is the presence of specific signal calls.
 * called).
 */

const PATH = join(import.meta.dir, "ctx-flush.ts");
const SRC = readFileSync(PATH, "utf8");

// `codeOnly` excludes lines beginning with `//` because comments can contain signal names without calls.
const codeOnly = SRC.split("\n")
	.filter((line) => !line.trim().startsWith("//"))
	.join("\n");

describe("/ctx-flush signal contract", () => {
	test("calls signalPiHistoryRefresh", () => {
		expect(codeOnly).toContain("signalPiHistoryRefresh(sessionId)");
	});

	test("calls signalPiPendingMaterialization (forces pending-op materialization)", () => {
		expect(codeOnly).toContain("signalPiPendingMaterialization(sessionId)");
	});

	test("calls signalPiSystemPromptRefresh (re-reads disk-backed adjuncts)", () => {
		expect(codeOnly).toContain("signalPiSystemPromptRefresh(sessionId)");
	});

	test("imports all three signal helpers from context-handler", () => {
		expect(SRC).toMatch(
			/from\s+"\.\.\/context-handler"/, // import block target
		);
		expect(SRC).toContain("signalPiHistoryRefresh");
		expect(SRC).toContain("signalPiPendingMaterialization");
		expect(SRC).toContain("signalPiSystemPromptRefresh");
	});
});
