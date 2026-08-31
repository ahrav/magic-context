import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { getPendingPiCompactionMarkerState } from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { queueAndApplyPiRecompMarker } from "./pi-recomp-marker";
import { createTestDb } from "./test-utils";

/**
 * The branch must contain the entry at the marker boundary.
 * Background commands must use the deferred staging path.
 */

function branchEntry(id: string, role: "user" | "assistant", text: string) {
	return { type: "message", id, message: { role, content: text } };
}

describe("queueAndApplyPiRecompMarker (eager path coverage precondition)", () => {
	it("applies the marker when the branch covers the recomp boundary", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-recomp-eager-covered";
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "e1",
					endMessageId: "e2",
					title: "Recomp chunk",
					content: "recomp body",
				},
			]);
			const appendCompaction = mock(() => "compact-1");
			const ctx = {
				sessionManager: {
					appendCompaction,
					// The kept tail begins at ordinal 3.
					// The marker boundary is `lastCompactedOrdinal + 1`.
					getBranch: () => [
						branchEntry("e1", "user", "one"),
						branchEntry("e2", "assistant", "two"),
						branchEntry("e3", "user", "three"),
					],
				},
			};

			queueAndApplyPiRecompMarker({ db, sessionId, ctx });

			expect(appendCompaction).toHaveBeenCalledTimes(1);
			const call = appendCompaction.mock.calls[0] as unknown[];
			expect(call[1]).toBe("e3"); // firstKeptEntryId heads the kept tail
			expect(call[4]).toBe(true); // fromHook
			expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("does not apply or stage anything when the branch lacks the covering entry", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-recomp-eager-uncovered";
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "e1",
					endMessageId: "e2",
					title: "Recomp chunk",
					content: "recomp body",
				},
			]);
			const appendCompaction = mock(() => "compact-1");
			const ctx = {
				sessionManager: {
					appendCompaction,
					// Without an entry at ordinal 3, the marker boundary cannot be resolved.
					getBranch: () => [
						branchEntry("e1", "user", "one"),
						branchEntry("e2", "assistant", "two"),
					],
				},
			};

			queueAndApplyPiRecompMarker({ db, sessionId, ctx });

			expect(appendCompaction).not.toHaveBeenCalled();
			expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("no-ops when the session manager exposes no compaction surface", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-recomp-eager-no-surface";
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "e1",
					endMessageId: "e2",
					title: "Recomp chunk",
					content: "recomp body",
				},
			]);

			queueAndApplyPiRecompMarker({
				db,
				sessionId,
				ctx: { sessionManager: {} },
			});

			expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});
});

describe("recomp marker command wiring stays on the deferred path", () => {
	// Background commands must stage markers because they lack same-pass coverage validation.
	for (const name of ["ctx-recomp.ts", "ctx-session-upgrade.ts"]) {
		it(`${name} stages the marker and never calls the eager apply path`, () => {
			const src = readFileSync(join(import.meta.dir, "commands", name), "utf8");
			const codeOnly = src
				.split("\n")
				.filter((line) => !line.trim().startsWith("//"))
				.join("\n");
			expect(codeOnly).toContain("stagePiRecompMarker(");
			expect(codeOnly).not.toContain("queueAndApplyPiRecompMarker(");
		});
	}
});
