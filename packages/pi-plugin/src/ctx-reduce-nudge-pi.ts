//
//
//

import { randomUUID } from "node:crypto";
import {
	casChannel2NudgeClaim,
	casChannel2NudgeState,
	claimChannel2NudgeState,
	getChannel2NudgeClaim,
	getChannel2NudgeState,
	getLastNudgeLevel,
	getLastNudgeUndropped,
	resetLastNudgeCycle,
	setLastNudgeLevel,
	setLastNudgeUndropped,
} from "@magic-context/core/features/magic-context/storage";
import {
	buildChannel1Reminder,
	buildChannel2Reminder,
	CHANNEL1_SENTINEL,
	decideChannel1,
	evaluateChannel2,
	type Channel1State as SharedChannel1State,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import { measurePiToolResultDelta } from "./tail-hygiene-walk-pi";

export type Channel1State = SharedChannel1State;

// Sessions without a baseline receive no Channel 1 reminder.
const channel1StateBySession = new Map<string, Channel1State>();

export function setPiChannel1Baseline(
	sessionId: string,
	state: Channel1State,
): void {
	channel1StateBySession.set(sessionId, state);
}

export function getPiChannel1Baseline(
	sessionId: string,
): Channel1State | undefined {
	return channel1StateBySession.get(sessionId);
}

export function clearPiChannel1State(sessionId: string): void {
	channel1StateBySession.delete(sessionId);
}

/** A `ctx_reduce` since the last baseline refresh suppresses self-nag. */
export function markPiChannel1Reduced(sessionId: string, db?: Database): void {
	const state = channel1StateBySession.get(sessionId);
	if (state) {
		state.reducedSinceRefresh = true;
		state.evaluable = false;
		state.generationInvalidated = true;
	}
	if (db) resetLastNudgeCycle(db, sessionId);
}

interface PiTextContent {
	type: "text";
	text: string;
}

function isPiTextContent(c: unknown): c is PiTextContent {
	return (
		c !== null &&
		typeof c === "object" &&
		(c as { type?: unknown }).type === "text" &&
		typeof (c as { text?: unknown }).text === "string"
	);
}

/* */
function toolResultText(content: readonly unknown[]): string {
	let text = "";
	for (const c of content) {
		if (isPiTextContent(c)) text += c.text;
	}
	return text;
}

/**
 */
export function maybeChannel1ReminderForToolResult(args: {
	db: Database;
	sessionId: string;
	toolName: string;
	content: readonly unknown[];
}): PiTextContent | null {
	const { db, sessionId, toolName } = args;
	const state = channel1StateBySession.get(sessionId);
	if (!state) return null; // primary-only: no baseline ⇒ subagent ⇒ off

	if (toolName === "ctx_reduce") {
		state.reducedSinceRefresh = true;
		state.evaluable = false;
		state.generationInvalidated = true;
		resetLastNudgeCycle(db, sessionId);
		return null;
	}

	const text = toolResultText(args.content);
	// A bare `<system-reminder>` opener marks already-processed content.
	if (text.includes(CHANNEL1_SENTINEL)) return null;

	// The recency reserve excludes the newest tool result from reclamation until the next context pass.
	// The recency reserve increases total tail tokens (T) without increasing reclaimable tokens (U).
	const deltaTokens = measurePiToolResultDelta(args.content);
	if (deltaTokens === 0) return null;
	state.turnDeltaT += deltaTokens;

	const decision = decideChannel1({
		...state,
		lastNudgeUndropped: getLastNudgeUndropped(db, sessionId),
		lastNudgeLevel: getLastNudgeLevel(db, sessionId),
		hasRecentReduce: state.reducedSinceRefresh,
	});

	setLastNudgeUndropped(db, sessionId, decision.nextLastNudge);
	setLastNudgeLevel(db, sessionId, decision.nextLastNudgeLevel);
	if (!decision.fire) return null;

	return {
		type: "text",
		text: buildChannel1Reminder(
			decision.level,
			decision.undroppedTokens,
			state.oldestReclaimableToolTags,
		),
	};
}

/**
 * Pi's `sendMessage` supports hidden custom messages; `sendUserMessage` does not.
 * With `display: false`, Pi hides custom messages in the TUI while sending them to the model.
 * The nudge must reach the model without appearing as a user-authored turn.
 */
interface PiSendMessage {
	sendMessage: (
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		},
		options?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean },
	) => void;
}

const CHANNEL2_NUDGE_CUSTOM_TYPE = "magic-context:ceiling-nudge";

/**
 *
 * At `tool_result`, use `deliverAs: "steer"`; Pi delivers the message at the next agent-step boundary.
 * A `steer` message lets the agent act during the current turn.
 * `agent_end` delivery uses `deliverAs: "followUp"` when no tool boundary delivered the intent.
 * `deliverAs: "followUp"` starts a fresh turn.
 *
 * The nudge state transitions from `pending` to `claimed(token)` to `delivered`.
 * The delivery path re-checks its claim token before sending and before confirming or reverting.
 * The claim token prevents another process from confirming or reverting a newer claim.
 * `maybeDeliverChannel2Pi` returns `true` only when delivery is confirmed.
 */
export function maybeDeliverChannel2Pi(
	pi: PiSendMessage,
	db: Database,
	sessionId: string,
	deliverAs: "steer" | "followUp" = "followUp",
): boolean {
	let state: string;
	try {
		state = getChannel2NudgeState(db, sessionId);
	} catch {
		return false;
	}
	if (state !== "pending") return false;

	// `maybeDeliverChannel2Pi` re-evaluates the pending intent against the cached Channel 1 baseline.
	// `maybeDeliverChannel2Pi` leaves the intent pending when `evaluateChannel2` cannot evaluate the baseline.
	// `maybeDeliverChannel2Pi` clears the pending intent when the evaluation is known and `shouldTrigger` is false.
	const baseline = channel1StateBySession.get(sessionId);
	if (!baseline) return false;
	const evaluation = evaluateChannel2(baseline);
	if (!evaluation.evaluable) return false;
	if (!evaluation.shouldTrigger) {
		try {
			casChannel2NudgeState(db, sessionId, "pending", "");
		} catch {
			// `maybeDeliverChannel2Pi` leaves the intent pending when resetting its state fails.
		}
		return false;
	}
	const undropped = evaluation.reclaimableTokens;

	const claimToken = randomUUID();
	if (!claimChannel2NudgeState(db, sessionId, claimToken)) return false;

	try {
		const message = {
			customType: CHANNEL2_NUDGE_CUSTOM_TYPE,
			content: buildChannel2Reminder(
				undropped,
				baseline.oldestReclaimableToolTags,
			),
			display: false,
			details: { kind: "channel-2-ceiling-nudge" },
		};
		const claim = getChannel2NudgeClaim(db, sessionId);
		if (claim.state !== "claimed" || claim.claimToken !== claimToken) {
			sessionLog(
				sessionId,
				`channel2 ceiling nudge delivery skipped: claim no longer owned before send (state=${claim.state || "empty"})`,
			);
			return false;
		}
		pi.sendMessage(message, { deliverAs });
	} catch (error) {
		try {
			const restored = casChannel2NudgeClaim(
				db,
				sessionId,
				"pending",
				claimToken,
			);
			if (restored) {
				sessionLog(
					sessionId,
					"channel2 ceiling nudge delivery failed (will retry):",
					error,
				);
			} else {
				sessionLog(
					sessionId,
					"channel2 ceiling nudge delivery failed after its claim was no longer owned; lease state left unchanged:",
					error,
				);
			}
		} catch (revertError) {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge delivery failed; token-bound pending restore was busy so the stale claim will heal later:",
				{ deliveryError: error, revertError },
			);
		}
		return false;
	}

	try {
		const confirmed = casChannel2NudgeClaim(
			db,
			sessionId,
			"delivered",
			claimToken,
		);
		if (confirmed) {
			sessionLog(sessionId, "channel2 ceiling nudge delivered");
			return true;
		}
		const claim = getChannel2NudgeClaim(db, sessionId);
		sessionLog(
			sessionId,
			`channel2 ceiling nudge sent but claim confirmation was not ours (state=${claim.state || "empty"}); leaving existing lease state unchanged`,
		);
		return false;
	} catch (error) {
		// `maybeDeliverChannel2Pi` never re-arms the intent after Pi accepts the message.
		// `maybeDeliverChannel2Pi` never re-arms a sent nudge because a transient DB error could duplicate delivery.
		sessionLog(
			sessionId,
			"channel2 ceiling nudge sent but token-confirm failed; lease state left unchanged:",
			error,
		);
		return false;
	}
}
