import { COMPACTION_ENABLED_PATH } from "@magic-context/core/config/agent-disable";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	clearCachedM0M1,
	clearPendingOps,
	getOrCreateSessionMeta,
	getPendingOps,
	getPendingPiCompactionMarkerState,
	setChannel2NudgeState,
	setPendingPiCompactionMarkerState,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	type CompactionModeRecord,
	clearEmergencyRecovery,
	getChannel2NudgeState,
	getCompactionModeRecord,
	getOverflowState,
	resolveCompactionModeRecord,
	setCompactionModeRecord,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { sessionLog } from "@magic-context/core/shared/logger";

/* */
export const COMPACTION_OFF_COMMAND_UNAVAILABLE = `Unavailable: magic-context is in compaction-off mode (${COMPACTION_ENABLED_PATH}=false).`;

/**
 */
export interface PiCompactionModeTransition {
	recordToWrite: CompactionModeRecord | null;
	invalidatedBaseline: boolean;
	clearDeferredMarkerState: boolean;
	historianCatchUpSignaled: boolean;
	notice: string | null;
}

const NO_TRANSITION: PiCompactionModeTransition = {
	recordToWrite: null,
	invalidatedBaseline: false,
	clearDeferredMarkerState: false,
	historianCatchUpSignaled: false,
	notice: null,
};

const PI_COMPACTION_OFF_NOTICE =
	"Magic Context is in compaction-off mode. Native Pi compaction now owns this session's context window; the first turn after disabling may trigger one native compaction cycle on long sessions.";

const PI_COMPACTION_ON_NOTICE =
	"Magic Context context-window management resumed. Run /ctx-wrapup to digest history accumulated while compaction was off.";

export function reconcilePiCompactionMode(args: {
	db: ContextDatabase;
	sessionId: string;
	compactionOff: boolean;
	historianRunnable: boolean;
}): PiCompactionModeTransition {
	const stored = getCompactionModeRecord(args.db, args.sessionId);

	// The function delivers pending notices before later mode changes to preserve at-least-once delivery across restarts.
	if (stored === "on_notice_pending") {
		return {
			...NO_TRANSITION,
			recordToWrite: "on",
			notice: PI_COMPACTION_ON_NOTICE,
		};
	}
	if (stored === "off_notice_pending") {
		return {
			...NO_TRANSITION,
			recordToWrite: "off",
			notice: PI_COMPACTION_OFF_NOTICE,
		};
	}

	if (!args.compactionOff) {
		if (stored === null || resolveCompactionModeRecord(stored) === "on") {
			return stored === null
				? { ...NO_TRANSITION, recordToWrite: "on" }
				: NO_TRANSITION;
		}

		clearCachedM0M1(args.db, args.sessionId);
		if (!args.historianRunnable) {
			return {
				...NO_TRANSITION,
				recordToWrite: "on",
				invalidatedBaseline: true,
			};
		}
		updateSessionMeta(args.db, args.sessionId, {
			compartmentInProgress: true,
		});
		// The function persists notice intent before returning the notice so delivery survives restarts.
		setCompactionModeRecord(args.db, args.sessionId, "on_notice_pending");
		return {
			recordToWrite: "on",
			invalidatedBaseline: true,
			clearDeferredMarkerState: false,
			historianCatchUpSignaled: true,
			notice: PI_COMPACTION_ON_NOTICE,
		};
	}

	if (resolveCompactionModeRecord(stored) === "off") return NO_TRANSITION;

	let clearedSomething = false;
	if (getPendingPiCompactionMarkerState(args.db, args.sessionId) !== null) {
		setPendingPiCompactionMarkerState(args.db, args.sessionId, null);
		clearedSomething = true;
	}
	if (getOverflowState(args.db, args.sessionId).needsEmergencyRecovery) {
		clearEmergencyRecovery(args.db, args.sessionId);
		clearedSomething = true;
	}
	const channel2 = getChannel2NudgeState(args.db, args.sessionId);
	if (channel2 === "pending" || channel2 === "claimed") {
		setChannel2NudgeState(args.db, args.sessionId, "");
		clearedSomething = true;
	}
	if (getPendingOps(args.db, args.sessionId).length > 0) {
		clearPendingOps(args.db, args.sessionId);
		clearedSomething = true;
	}
	const meta = getOrCreateSessionMeta(args.db, args.sessionId);
	if (meta.compartmentInProgress) {
		updateSessionMeta(args.db, args.sessionId, {
			compartmentInProgress: false,
		});
	}
	clearCachedM0M1(args.db, args.sessionId);
	sessionLog(
		args.sessionId,
		`Pi compaction-off transition: clearedPendingMarker=${clearedSomething}`,
	);
	const notice = clearedSomething ? PI_COMPACTION_OFF_NOTICE : null;
	if (notice) {
		// The function persists notice intent before returning the notice so delivery survives restarts.
		setCompactionModeRecord(args.db, args.sessionId, "off_notice_pending");
	}
	return {
		recordToWrite: "off",
		invalidatedBaseline: true,
		clearDeferredMarkerState: true,
		historianCatchUpSignaled: false,
		notice,
	};
}

export function commitPiCompactionModeRecord(
	db: ContextDatabase,
	sessionId: string,
	record: CompactionModeRecord,
): void {
	setCompactionModeRecord(db, sessionId, record);
}
