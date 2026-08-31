import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getChannel2NudgeClaim,
	getChannel2NudgeClaimedAt,
	getChannel2NudgeState,
	setChannel2NudgeState,
} from "@magic-context/core/features/magic-context/storage";
import * as loggerModule from "@magic-context/core/shared/logger";
import {
	clearPiChannel1State,
	getPiChannel1Baseline,
	maybeChannel1ReminderForToolResult,
	maybeDeliverChannel2Pi,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import { createTestDb } from "./test-utils.test";

function channel2BaselineFields(baselineU: number, baselineT: number) {
	return {
		baselineU,
		baselineT,
		turnDeltaU: 0,
		turnDeltaT: 0,
		baselineGeneration: 1,
		computedAt: 1,
		evaluable: true,
		generationInvalidated: false,
		baselineParts: [],
		contentSignature: "fixture",
	};
}

afterEach(() => {
	mock.restore();
});

describe("maybeChannel1ReminderForToolResult", () => {
	const SESSION = "ses-ch1";

	function seedBaseline(tailTokens: number): void {
		setPiChannel1Baseline(SESSION, {
			...channel2BaselineFields(tailTokens, 120_000),
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [{ tagNumber: 9, toolName: "bash" }],
		});
	}

	it("returns null when no baseline exists (subagent / off)", () => {
		const db = createTestDb();
		clearPiChannel1State(SESSION);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(80_000) }],
		});
		expect(block).toBeNull();
	});

	it("fires a system-reminder block when the rendered-tail ratio warrants it", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "some bash output" }],
		});
		expect(block).not.toBeNull();
		expect(block?.type).toBe("text");
		expect(block?.text).toContain("<system-reminder>");
		expect(block?.text).toContain("ctx_reduce");
		clearPiChannel1State(SESSION);
	});

	it("includes oldest reclaimable hints from the baseline", () => {
		const db = createTestDb();
		setPiChannel1Baseline(SESSION, {
			...channel2BaselineFields(90_000, 120_000),
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [{ tagNumber: 123, toolName: "read" }],
		});
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "some bash output" }],
		});
		expect(block?.text).toContain("oldest reclaimable: §123§ read.");
		clearPiChannel1State(SESSION);
	});

	it("suppresses on a ctx_reduce tool result and marks reduced", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "ctx_reduce",
			content: [{ type: "text", text: "dropped 5 tags" }],
		});
		expect(block).toBeNull();
		// After a reduce, a subsequent tool result is also suppressed this turn.
		const next = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "more output" }],
		});
		expect(next).toBeNull();
		clearPiChannel1State(SESSION);
	});

	it("is idempotent — does not double-append to a result already carrying the marker", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "out <system-reminder> already here" }],
		});
		expect(block).toBeNull();
		clearPiChannel1State(SESSION);
	});
});

describe("maybeDeliverChannel2Pi", () => {
	const SESSION = "ses-ch2-pi";

	it("no-ops when no pending intent exists", () => {
		const db = createTestDb();
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
	});

	/** armStrongBaseline creates a baseline whose measurement satisfies the full Channel-2 trigger. */
	function armStrongBaseline(sessionId: string): void {
		setPiChannel1Baseline(sessionId, {
			...channel2BaselineFields(75_000, 100_000),
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [{ tagNumber: 9, toolName: "bash" }],
		});
	}

	it("regression: keeps the model-visible ceiling nudge on sendMessage(display:false, followUp)", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "pending");
		armStrongBaseline(SESSION);
		let capturedContent = "";
		let capturedDeliverAs = "";
		let capturedDisplay: boolean | undefined;
		let capturedCustomType = "";
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: (message, options) => {
					capturedContent = message.content;
					capturedDisplay = message.display;
					capturedCustomType = message.customType;
					capturedDeliverAs = options?.deliverAs ?? "";
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(true);
		expect(capturedDeliverAs).toBe("followUp");
		// display: false hides agent-steer follow-ups from the Pi TUI without hiding them from the model.
		expect(capturedDisplay).toBe(false);
		expect(capturedCustomType).toBe("magic-context:ceiling-nudge");
		expect(capturedContent).toContain("<system-reminder>");
		expect(capturedContent).toContain("ctx_reduce");
		expect(capturedContent).toContain("oldest reclaimable");
		expect(getChannel2NudgeState(db, SESSION)).toBe("delivered");
	});

	it("does NOT deliver and leaves pending when no baseline measurement exists", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-unknown";
		setChannel2NudgeState(db, session, "pending");
		clearPiChannel1State(session);
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			session,
		);
		// An unknown U/T baseline must neither consume the cycle cap nor cancel the intent; a later agent_end with a real measurement decides.
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
		expect(getChannel2NudgeState(db, session)).toBe("pending");
	});

	it("holds pending when the baseline generation was invalidated", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-invalidated";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);
		const baseline = getPiChannel1Baseline(session);
		if (!baseline) throw new Error("missing test baseline");
		baseline.evaluable = false;
		baseline.generationInvalidated = true;
		let sent = 0;

		const delivered = maybeDeliverChannel2Pi(
			{ sendMessage: () => sent++ },
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(sent).toBe(0);
		expect(getChannel2NudgeState(db, session)).toBe("pending");
	});

	it("cancels (re-armable) when typed T growth leaves the fourth band", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-typed-delta";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);
		maybeChannel1ReminderForToolResult({
			db,
			sessionId: session,
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(40_000) }],
		});
		let sent = 0;

		const delivered = maybeDeliverChannel2Pi(
			{ sendMessage: () => sent++ },
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(sent).toBe(0);
		expect(getChannel2NudgeState(db, session)).toBe("");
	});

	it("cancels (re-armable) when the full trigger predicate no longer holds", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-stale";
		setChannel2NudgeState(db, session, "pending");
		setPiChannel1Baseline(session, {
			...channel2BaselineFields(50_000, 100_000),
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [],
		});
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			session,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
		expect(getChannel2NudgeState(db, session)).toBe("");
	});

	it("reverts to pending on send failure (cap not burned)", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "pending");
		armStrongBaseline(SESSION);
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					throw new Error("transient");
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(getChannel2NudgeState(db, SESSION)).toBe("pending");
	});

	it("refuses a foreign revert attempt against a live claim", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-foreign-revert";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);

		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					// A delivery attempt must not return the lease to pending when another delivery attempt has acquired a fresh lease.
					// A delivery attempt must not return the lease to pending when another delivery attempt has acquired a fresh lease.
					db.prepare(
						"UPDATE session_meta SET channel2_nudge_state = 'claimed', channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ?",
					).run(Date.now(), "foreign-claim-token", session);
					throw new Error("transient");
				},
			},
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(getChannel2NudgeClaim(db, session)).toMatchObject({
			state: "claimed",
			claimToken: "foreign-claim-token",
		});
	});

	it("returns false and leaves the claim healable when claimed→pending CAS throws", async () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-revert-throw";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);

		const originalPrepare = db.prepare.bind(db);
		(db as unknown as { prepare: typeof db.prepare }).prepare = (
			sql: string,
		) => {
			const statement = originalPrepare(sql);
			if (
				sql ===
				"UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ? AND channel2_nudge_state = 'claimed' AND channel2_nudge_claim_token = ?"
			) {
				return {
					...statement,
					run: (...args: unknown[]) => {
						if (
							args[0] === "pending" &&
							args[1] === 0 &&
							args[2] === "" &&
							args[3] === session
						) {
							throw new Error("SQLITE_BUSY: database is locked");
						}
						return statement.run(
							...(args as [unknown, unknown, unknown, unknown, unknown]),
						);
					},
				} as typeof statement;
			}
			return statement;
		};

		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					throw new Error("transient");
				},
			},
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(getChannel2NudgeState(db, session)).toBe("claimed");
		expect(getChannel2NudgeClaimedAt(db, session)).toBeGreaterThan(0);
	});

	it("preserves a sibling's delivered lease when token confirmation is lost", async () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-duplicate";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);

		const sessionLog = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);

		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					db.prepare(
						"UPDATE session_meta SET channel2_nudge_state = 'delivered', channel2_nudge_claimed_at = 0 WHERE session_id = ?",
					).run(session);
				},
			},
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(getChannel2NudgeState(db, session)).toBe("delivered");
		expect(
			sessionLog.mock.calls.some(
				(call) =>
					call[0] === session &&
					typeof call[1] === "string" &&
					call[1].includes("claim confirmation was not ours"),
			),
		).toBe(true);
	});

	it("does not re-deliver before a tail-cycle reset", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "delivered");
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
	});
});

describe("Channel 2 delivery wiring (regression)", () => {
	// The agent_end handler must call maybeDeliverChannel2Pi so pending intents can be delivered.
	const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

	it("index.ts imports maybeDeliverChannel2Pi", () => {
		expect(INDEX_SRC).toContain("maybeDeliverChannel2Pi");
	});

	it("the agent_end handler calls maybeDeliverChannel2Pi", () => {
		const handler = INDEX_SRC.match(/pi\.on\("agent_end",[\s\S]*?\n\s*\}\);/);
		expect(handler).not.toBeNull();
		expect(handler?.[0] ?? "").toContain(
			"maybeDeliverChannel2Pi(pi, db, sessionId)",
		);
	});
});
