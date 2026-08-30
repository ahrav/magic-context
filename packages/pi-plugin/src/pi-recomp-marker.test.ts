import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { getPendingPiCompactionMarkerState } from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { queueAndApplyPiRecompMarker } from "./pi-recomp-marker";
import { createTestDb } from "./test-utils";

/**
 * queueAndApplyPiRecompMarker is the EAGER marker path: it writes AND applies
 * the native compaction marker immediately, bypassing the rendered-coverage
 * gate the pipeline's deferred drain enforces. Its safety depends on the
 * caller having just republished the compartments (a recomp/upgrade is a HARD
 * bust, so the same pass's m[0] re-materialization covers the marker). These
 * tests pin both halves of that contract: application happens ONLY when the
 * branch already contains the entries covering the marker boundary (i.e. the
 * recomp materialization rendered them), and the live background commands
 * stay on the deferred staging path instead of this eager bypass.
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
					// The recomp materialization rendered the compartment; the
					// branch still carries the kept tail starting at ordinal 3
					// (lastCompactedOrdinal 2 + 1), so the boundary resolves to
					// a real, replay-safe entry id.
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
			// Applied AND CAS-cleared in the same call — no pending marker left.
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
					// No entry at ordinal 3: the rendered content covering the
					// marker boundary does not exist (no recomp materialization
					// in this context), so nothing may be trimmed.
					getBranch: () => [
						branchEntry("e1", "user", "one"),
						branchEntry("e2", "assistant", "two"),
					],
				},
			};

			queueAndApplyPiRecompMarker({ db, sessionId, ctx });

			expect(appendCompaction).not.toHaveBeenCalled();
			// The guard runs BEFORE staging, so no unmatchable marker persists.
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
	// The eager bypass is only safe inside a same-pass rendered-coverage
	// context that the background commands cannot guarantee (they run
	// DETACHED, mid-turn). They must stage + defer so the pipeline's
	// coverage-gated drain applies the marker on the next busting pass.
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
