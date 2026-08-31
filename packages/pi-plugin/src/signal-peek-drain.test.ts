/**
 *
 * The handler drains each signal only after its rebuild succeeds; failures retain the signal for retry.
 * retry.
 *
 * runtime mocking.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	clearSystemPromptRefresh,
	consumeDeferredHistoryRefresh,
	consumeDeferredMaterialization,
	consumePendingMaterialization,
	hasPendingMaterialization,
	hasSystemPromptRefresh,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
	signalPiSystemPromptRefreshForProject,
	trackSessionForProject,
} from "./context-handler";
import { createTestDb } from "./test-utils";

const CONTEXT_HANDLER_SRC = readFileSync(
	join(import.meta.dir, "context-handler.ts"),
	"utf-8",
);
const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

function stripComments(src: string): string {
	let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
	out = out.replace(/^\s*\/\/.*$/gm, "");
	out = out.replace(/(?<![:\w])\/\/.*$/gm, "");
	return out;
}

describe("signal helpers: peek vs drain semantics", () => {
	test("hasSystemPromptRefresh is non-draining (idempotent reads)", () => {
		const db = createTestDb();
		try {
			signalPiSystemPromptRefresh("ses-peek-1");
			expect(hasSystemPromptRefresh("ses-peek-1")).toBe(true);
			expect(hasSystemPromptRefresh("ses-peek-1")).toBe(true);
			// drain
			expect(clearSystemPromptRefresh("ses-peek-1")).toBe(true);
			expect(hasSystemPromptRefresh("ses-peek-1")).toBe(false);
		} finally {
			db.close();
		}
	});

	test("clearSystemPromptRefresh returns prior wasSet state and drains", () => {
		const db = createTestDb();
		try {
			expect(clearSystemPromptRefresh("ses-clear-empty")).toBe(false);
			signalPiSystemPromptRefresh("ses-clear-set");
			expect(clearSystemPromptRefresh("ses-clear-set")).toBe(true);
			expect(clearSystemPromptRefresh("ses-clear-set")).toBe(false);
		} finally {
			db.close();
		}
	});

	test("hasPendingMaterialization is non-draining", () => {
		const db = createTestDb();
		try {
			signalPiPendingMaterialization("ses-pm-peek");
			expect(hasPendingMaterialization("ses-pm-peek")).toBe(true);
			expect(hasPendingMaterialization("ses-pm-peek")).toBe(true);
			expect(consumePendingMaterialization("ses-pm-peek")).toBe(true);
			expect(hasPendingMaterialization("ses-pm-peek")).toBe(false);
		} finally {
			db.close();
		}
	});

	test("consumePendingMaterialization drains and is idempotent on empty", () => {
		const db = createTestDb();
		try {
			expect(consumePendingMaterialization("ses-cpm-empty")).toBe(false);
			signalPiPendingMaterialization("ses-cpm-set");
			expect(consumePendingMaterialization("ses-cpm-set")).toBe(true);
			expect(consumePendingMaterialization("ses-cpm-set")).toBe(false);
		} finally {
			db.close();
		}
	});

	test("history refresh signal can be set and re-set after drain", () => {
		const db = createTestDb();
		try {
			signalPiHistoryRefresh("ses-history");
			signalPiHistoryRefresh("ses-history");
			signalPiSystemPromptRefresh("ses-history");
			signalPiPendingMaterialization("ses-history");
			// After consuming pendingMaterialization, historyRefresh and systemPromptRefresh remain set.
			expect(consumePendingMaterialization("ses-history")).toBe(true);
			expect(hasSystemPromptRefresh("ses-history")).toBe(true);
		} finally {
			db.close();
		}
	});

	test("deferred signals are independent one-shot drains", () => {
		signalPiDeferredHistoryRefresh("ses-deferred");
		signalPiDeferredMaterialization("ses-deferred");
		expect(consumeDeferredHistoryRefresh("ses-deferred")).toBe(true);
		expect(consumeDeferredHistoryRefresh("ses-deferred")).toBe(false);
		expect(consumeDeferredMaterialization("ses-deferred")).toBe(true);
		expect(consumeDeferredMaterialization("ses-deferred")).toBe(false);
	});

	test("project system-prompt refresh helper signals all tracked sessions", () => {
		trackSessionForProject("/project-a", "ses-a1");
		trackSessionForProject("/project-a", "ses-a2");
		signalPiSystemPromptRefreshForProject("/project-a");
		expect(hasSystemPromptRefresh("ses-a1")).toBe(true);
		expect(hasSystemPromptRefresh("ses-a2")).toBe(true);
		clearSystemPromptRefresh("ses-a1");
		clearSystemPromptRefresh("ses-a2");
	});
});

describe("source contract: peek-then-drain in runPipeline (history)", () => {
	const code = stripComments(CONTEXT_HANDLER_SRC);

	test("runPipeline does NOT eager-delete historyRefreshSessions before work", () => {
		const before = code.split("await runPipeline(")[0];
		expect(before).not.toContain("historyRefreshSessions.delete(sessionId)");
	});

	test("history drain happens AFTER injectM0M1Pi succeeds", () => {
		// The drain occurs only after `injectM0M1Pi` succeeds, so failures retain the signal for retry.
		// The drain runs inside the `try` block so failures do not consume the signal.
		// The drain applies only to the wire-injection `injectM0M1PiForRun` call.
		// `injectM0M1Pi` does not consume the signal.
		const idx = code.lastIndexOf("injectM0M1PiForRun(");
		expect(idx).toBeGreaterThan(0);
		const segment = code.slice(idx, idx + 2400);
		expect(segment).toContain("historyRefreshSessions.delete(args.sessionId)");
		expect(segment).toMatch(/if\s*\(\s*args\.isCacheBusting\s*\)/);
	});

	test("deferred publication drains only on a MID-TURN-AWARE can-consume-late gate", () => {
		// `canConsumeDeferredLate` uses the mid-turn-adjusted `schedulerDecision` and force threshold independently of `shouldRunHeuristics`.
		// `shouldRunHeuristics` must not control deferred-publish consumption because it reads raw deferred-set membership.
		// Deferred publishes remain queued mid-turn.
		// canConsumeDeferredOnThisPass.
		expect(code).not.toMatch(
			/const\s+canConsumeDeferredLate\s*=\s*baseShouldApplyPendingOps\s*\|\|\s*shouldRunHeuristics/,
		);
		expect(code).toMatch(
			/const\s+canConsumeDeferredLate\s*=\s*[\s\S]*?args\.schedulerDecision\s*===\s*"execute"/,
		);
		expect(code).toContain("args.forceMaterialization === true");
		expect(code).toContain(
			"args.contextUsage.percentage >= forceMaterializationPercentage",
		);
		expect(code).toContain("const deferredMaterialize =");
		expect(code).toContain("const deferredHistoryRefresh =");
		expect(code).toContain(
			"deferredMaterializationConsumedThisPass = consumeDeferredMaterialization(",
		);
		expect(code).toContain("consumeDeferredHistoryRefresh(args.sessionId)");
	});

	test("once-per-turn heuristics guard uses latest user turn id", () => {
		expect(code).toContain("lastHeuristicsTurnIdBySession");
		expect(code).toContain("alreadyRanHeuristicsThisTurn");
		expect(code).toContain(
			'args.schedulerDecision === "execute" && !alreadyRanHeuristicsThisTurn',
		);
	});

	test("raw message provider unregister is retained and cleaned", () => {
		expect(code).toContain("rawMessageProviderUnregistersBySession");
		expect(code).toContain(
			"rawMessageProviderUnregistersBySession.set(sessionId, unregisterRaw)",
		);
		expect(code).toContain(
			"rawMessageProviderUnregistersBySession.delete(sessionId)",
		);
	});

	test("inline thinking stripping shares the reasoning watermark", () => {
		expect(code).toContain("stripInlineThinkingPi({");
		expect(code).toContain("const combinedWatermark = Math.max(");
		expect(code).toContain("clearedReasoningThroughTag: combinedWatermark");
	});

	test("model switch reset clears usage, reasoning, failure, limit, and recovery state", () => {
		expect(code).toContain("clearedReasoningThroughTag: 0");
		expect(code).toContain("clearHistorianFailureState(options.db, sessionId)");
		expect(code).toContain(
			"clearPersistedReasoningWatermark(options.db, sessionId)",
		);
		expect(code).toContain("clearDetectedContextLimit(options.db, sessionId)");
		expect(code).toContain("clearEmergencyRecovery(options.db, sessionId)");
		expect(code).toContain(
			"sessionMetaForUsage.clearedReasoningThroughTag = 0",
		);
	});

	test("note nudges are wired after runPipeline", () => {
		const pipelineIdx = code.indexOf("const result = await runPipeline(");
		const noteIdx = code.indexOf("applyNoteNudges(");
		expect(pipelineIdx).toBeGreaterThan(0);
		expect(noteIdx).toBeGreaterThan(pipelineIdx);
		expect(code).toContain("isCacheBusting || result.executedWorkThisPass");
	});
});

describe("source contract: peek-then-drain in runPipeline (pending materialization)", () => {
	const code = stripComments(CONTEXT_HANDLER_SRC);

	test("gate uses hasPendingMaterialization, not consume", () => {
		// The handler drains the signal only after `applyPendingOperations` succeeds.
		// The handler drains the signal only after `applyPendingOperations` succeeds.
		expect(code).toMatch(
			/const\s+hasPendingMaterializeSignal\s*=\s*hasPendingMaterialization\(/,
		);
		// hasPendingMaterialization does not drain the signal.
		expect(code).not.toMatch(
			/const\s+hasPendingMaterializeSignal\s*=\s*consumePendingMaterialization\(/,
		);
	});

	test("drain happens AFTER applyPendingOperations succeeds", () => {
		// consumePendingMaterialization runs only after applyPendingOperations succeeds.
		// A throw from `applyPendingOperations` skips the drain.
		const idx = code.indexOf("applyPendingOperations(");
		expect(idx).toBeGreaterThan(0);
		const segment = code.slice(idx, idx + 800);
		expect(segment).toContain("consumePendingMaterialization(args.sessionId)");
		expect(segment).toMatch(/if\s*\(\s*hasPendingMaterializeSignal\s*\)/);
	});
});

describe("source contract: peek-then-drain in before_agent_start (system prompt)", () => {
	const code = stripComments(INDEX_SRC);

	test("uses hasSystemPromptRefresh peek, not the old draining helper", () => {
		expect(code).toContain("hasSystemPromptRefresh(sessionId)");
		expect(code).not.toContain("consumeSystemPromptRefresh(sessionId)");
	});

	test("clearSystemPromptRefresh fires AFTER processSystemPromptForCache", () => {
		const processIdx = code.indexOf("processSystemPromptForCache(");
		const clearIdx = code.indexOf("clearSystemPromptRefresh(sessionId)");
		expect(processIdx).toBeGreaterThan(0);
		expect(clearIdx).toBeGreaterThan(0);
		expect(clearIdx).toBeGreaterThan(processIdx);
	});

	test("clear is guarded by the captured isCacheBusting boolean", () => {
		// The handler clears the refresh signal only when captured isCacheBusting is true, preserving signals set during non-cache-busting passes.
		const clearIdx = code.indexOf("clearSystemPromptRefresh(sessionId)");
		const window = code.slice(Math.max(0, clearIdx - 200), clearIdx + 100);
		expect(window).toMatch(/if\s*\(\s*isCacheBusting\s*\)/);
	});

	test("system-prompt injection supports global disable, skip signatures, and existing prompt dedup", () => {
		expect(code).toContain(
			"effectiveConfig.system_prompt_injection?.enabled === false",
		);
		expect(code).toContain(
			"effectiveConfig.system_prompt_injection?.skip_signatures",
		);
		expect(code).toContain("existingSystemPrompt: event.systemPrompt");
	});

	test("message_end indexes the ended assistant by deferred id lookup", () => {
		expect(code).toContain("const messageId = endedMsg.id");
		expect(code).toContain("readPiSessionMessages(ctx)");
		expect(code).toContain("message.id === messageId");
	});

	test("runtime project identity resolves from ctx.cwd and tracks prompt path sessions", () => {
		expect(code).toContain("function resolveCurrentProject");
		expect(code).toContain("const projectDir = ctx.cwd");
		expect(code).toContain(
			"trackSessionForProject(currentProject.projectIdentity, sessionId)",
		);
		expect(code).toContain("resolveProject: resolveCurrentProject");
	});

	test("todowrite capture only accepts the built-in tool name", () => {
		expect(code).toContain('b.name !== "todowrite"');
		expect(code).not.toContain("^todo.*write");
	});

	test("project-docs m0 injection uses the flag independent of dreamer.disable", () => {
		expect(code).toContain("injectDocs: cfg.dreamer?.inject_docs !== false");
		expect(code).not.toContain(
			"isDreamerRunnable(config) && (config.dreamer?.inject_docs",
		);
	});

	test("hash-change path remains eager for all three refresh sets", () => {
		const idx = code.indexOf("if (result.hashChanged)");
		expect(idx).toBeGreaterThan(0);
		const segment = code.slice(idx, idx + 500);
		expect(segment).toContain("signalPiHistoryRefresh(sessionId)");
		expect(segment).toContain("signalPiSystemPromptRefresh(sessionId)");
		expect(segment).toContain("signalPiPendingMaterialization(sessionId)");
	});
});
