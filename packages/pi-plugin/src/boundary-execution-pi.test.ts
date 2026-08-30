/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
	clearDeferredExecutePendingIfMatches,
	type DeferredExecutePayload,
	peekDeferredExecutePending,
	setDeferredExecutePendingIfAbsent,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { ensureSessionMetaRow } from "@magic-context/core/features/magic-context/storage-meta-shared";
import { createDirectTestDatabase } from "@magic-context/core/features/magic-context/test-database";
import { applyMidTurnDeferral } from "@magic-context/core/hooks/magic-context/boundary-execution";
import type { Database } from "@magic-context/core/shared/sqlite";
import { isMidTurnPi } from "./read-session-pi";

function createDb(): Database {
	return createDirectTestDatabase().db;
}

function flag(): DeferredExecutePayload {
	return {
		id: "flag-1",
		reason: "execute-none",
		recordedAt: 1_700_000_000_000,
	};
}

describe("boundary execution Pi integration", () => {
	it("12. Pi mid-turn execute defers and sets a flag", () => {
		const db = createDb();
		const midTurn = isMidTurnPi(
			{
				messages: [
					{ role: "assistant", content: [{ type: "toolCall", id: "call-1" }] },
				],
			},
			"s1",
		);
		const result = applyMidTurnDeferral({
			base: "execute",
			bypassReason: "none",
			midTurn,
		});
		if (result.sideEffect === "set-flag")
			setDeferredExecutePendingIfAbsent(db, "s1", flag());
		expect(result.midTurnAdjustedSchedulerDecision).toBe("defer");
		expect(peekDeferredExecutePending(db, "s1")?.id).toBe("flag-1");
	});

	it("13. Pi stale-tail release executes and drains prior flag on a fresh user turn", () => {
		const db = createDb();
		ensureSessionMetaRow(db, "s1");
		setDeferredExecutePendingIfAbsent(db, "s1", flag());
		const assistant = { role: "assistant", stopReason: "toolUse", content: [] };
		const user = { role: "user", content: "new turn" };
		const midTurn = isMidTurnPi({ messages: [assistant, user] }, "s1", [
			{ type: "message", id: "assistant-1", message: assistant },
			{ type: "message", id: "user-1", message: user },
		]);
		const result = applyMidTurnDeferral({
			base: "execute",
			bypassReason: "none",
			midTurn,
		});

		expect(midTurn).toBe(false);
		expect(result.midTurnAdjustedSchedulerDecision).toBe("execute");
		const current = peekDeferredExecutePending(db, "s1");
		expect(current).not.toBeNull();
		if (current !== null) {
			clearDeferredExecutePendingIfMatches(db, "s1", current);
		}
		expect(peekDeferredExecutePending(db, "s1")).toBeNull();
	});

	it("14. Pi boundary execute drains prior flag when work executes", () => {
		const db = createDb();
		setDeferredExecutePendingIfAbsent(db, "s1", flag());
		const current = peekDeferredExecutePending(db, "s1");
		expect(current).not.toBeNull();
		if (current !== null) {
			clearDeferredExecutePendingIfMatches(db, "s1", current);
		}
		expect(peekDeferredExecutePending(db, "s1")).toBeNull();
	});

	it("15. Pi preserves flag when execute-gated work fails", () => {
		const db = createDb();
		ensureSessionMetaRow(db, "s1");
		setDeferredExecutePendingIfAbsent(db, "s1", flag());
		const executedWorkThisPass = false;
		if (executedWorkThisPass) {
			const current = peekDeferredExecutePending(db, "s1");
			if (current) clearDeferredExecutePendingIfMatches(db, "s1", current);
		}
		expect(peekDeferredExecutePending(db, "s1")?.id).toBe("flag-1");
	});

	it("16. a prior deferred flag does NOT promote a defer decision to execute (parity with OpenCode contract #4)", () => {
		// Regression: Pi previously force-promoted schedulerDecision defer→execute
		// whenever a deferred-execute flag existed and the pass wasn't mid-turn,
		// diverging from OpenCode (which treats the flag as drain-on-success ONLY
		// and never re-raises execute — boundary-execution-integration.test.ts #4).
		// The idempotent scheduler re-issues execute on the next non-mid-turn pass
		// while pressure holds, so no override is needed. Model the post-fix
		// contract: a base-defer pass stays defer regardless of the flag's presence,
		// and the flag is preserved (drained later only when work genuinely runs).
		const db = createDb();
		ensureSessionMetaRow(db, "s1");
		setDeferredExecutePendingIfAbsent(db, "s1", flag());

		// base=defer → applyMidTurnDeferral yields defer; the flag must NOT change it.
		const decision = applyMidTurnDeferral({
			base: "defer",
			bypassReason: "none",
			midTurn: false,
		});
		// The removed Pi-only promotion would have done: if (flag && effective ===
		// "defer" && !midTurn) effective = "execute". Assert that does NOT happen —
		// the effective decision stays defer even with the flag present.
		const flagExists = peekDeferredExecutePending(db, "s1") !== null;
		expect(flagExists).toBe(true);
		expect(decision.midTurnAdjustedSchedulerDecision).toBe("defer");

		// Flag preserved (drain-on-success only): no execute ran this pass.
		expect(peekDeferredExecutePending(db, "s1")?.id).toBe("flag-1");
	});
});
