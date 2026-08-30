import { describe, expect, it } from "bun:test";
import {
	getPendingOps,
	insertTag,
	queuePendingOp,
	setChannel2NudgeState,
	setPendingPiCompactionMarkerState,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	getChannel2NudgeState,
	getCompactionModeRecord,
	getOverflowState,
	recordOverflowDetected,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import {
	commitPiCompactionModeRecord,
	reconcilePiCompactionMode,
} from "./compaction-off-pi";
import { handlePiSessionBeforeCompact } from "./index";
import { createTestDb } from "./test-utils";

describe("Pi compaction-off mode", () => {
	it("allows native compaction only when compaction-off is selected", async () => {
		const db = createTestDb();
		try {
			const ctx = { sessionManager: { getSessionId: () => "ses-native" } };
			expect(
				await handlePiSessionBeforeCompact({ db, compactionOff: false, ctx }),
			).toEqual({ cancel: true });
			// Mutation direction: returning cancel here would prevent Pi from owning
			// the window and leave an off-mode session with no compactor.
			expect(
				await handlePiSessionBeforeCompact({ db, compactionOff: true, ctx }),
			).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});

	it("treats no record plus off as a full Pi cleanup transition", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-off-transition";
		try {
			const tag = insertTag(db, sessionId, "message-1", "message", 20, 1);
			queuePendingOp(db, sessionId, tag, "drop");
			setPendingPiCompactionMarkerState(db, sessionId, {
				firstKeptEntryId: "entry-2",
				endMessageId: "entry-1",
				ordinal: 1,
				tokensBefore: 100,
				summary: "stale MC compaction",
				publishedAt: 1,
			});
			recordOverflowDetected(db, sessionId, undefined);
			setChannel2NudgeState(db, sessionId, "pending");
			updateSessionMeta(db, sessionId, {
				cachedM0Bytes: Buffer.from("old on-mode history"),
				cachedM1Bytes: Buffer.from("old on-mode delta"),
				compartmentInProgress: true,
			});

			const transition = reconcilePiCompactionMode({
				db,
				sessionId,
				compactionOff: true,
				historianRunnable: true,
			});
			expect(transition.recordToWrite).toBe("off");
			expect(getCompactionModeRecord(db, sessionId)).toBe("off_notice_pending");
			expect(transition.clearDeferredMarkerState).toBe(true);
			expect(getPendingOps(db, sessionId)).toEqual([]);
			expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(
				false,
			);
			expect(getChannel2NudgeState(db, sessionId)).toBe("");
			expect(
				db
					.prepare(
						"SELECT pending_pi_compaction_marker_state, cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id = ?",
					)
					.get(sessionId),
			).toMatchObject({
				pending_pi_compaction_marker_state: null,
				cached_m0_bytes: null,
				cached_m1_bytes: null,
			});

			commitPiCompactionModeRecord(db, sessionId, "off");
			expect(getCompactionModeRecord(db, sessionId)).toBe("off");
			expect(
				reconcilePiCompactionMode({
					db,
					sessionId,
					compactionOff: true,
					historianRunnable: true,
				}).recordToWrite,
			).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("records no-record plus on without cleanup, then signals one flip-back catch-up", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-on-transition";
		try {
			const initial = reconcilePiCompactionMode({
				db,
				sessionId,
				compactionOff: false,
				historianRunnable: true,
			});
			expect(initial.recordToWrite).toBe("on");
			commitPiCompactionModeRecord(db, sessionId, "on");

			commitPiCompactionModeRecord(db, sessionId, "off");
			const resumed = reconcilePiCompactionMode({
				db,
				sessionId,
				compactionOff: false,
				historianRunnable: true,
			});
			expect(resumed.recordToWrite).toBe("on");
			expect(getCompactionModeRecord(db, sessionId)).toBe("on_notice_pending");
			expect(resumed.historianCatchUpSignaled).toBe(true);
			expect(resumed.notice).toContain("/ctx-wrapup");
		} finally {
			closeQuietly(db);
		}
	});

	it("retries a durable flip-off notice after a fresh reconciliation", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-notice-restart";
		try {
			queuePendingOp(db, sessionId, 9, "drop");
			const first = reconcilePiCompactionMode({
				db,
				sessionId,
				compactionOff: true,
				historianRunnable: true,
			});
			expect(first.notice).toContain("compaction-off mode");
			expect(getCompactionModeRecord(db, sessionId)).toBe("off_notice_pending");

			// Simulate restart after the clears committed but before the caller
			// reached Pi's UI. The pending record, not process memory, requests
			// the same notice again.
			const restarted = reconcilePiCompactionMode({
				db,
				sessionId,
				compactionOff: true,
				historianRunnable: true,
			});
			expect(restarted.notice).toBe(first.notice);
			const recordToWrite = restarted.recordToWrite;
			if (!recordToWrite)
				throw new Error("expected a compaction mode record to persist");
			commitPiCompactionModeRecord(db, sessionId, recordToWrite);
			expect(getCompactionModeRecord(db, sessionId)).toBe("off");
		} finally {
			closeQuietly(db);
		}
	});
});
