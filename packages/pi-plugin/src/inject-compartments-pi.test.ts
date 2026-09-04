import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getCompartments,
	getOrCreateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	getActiveUserMemories,
	insertUserMemory,
} from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { COMPARTMENT_RENDER_EPOCH } from "@magic-context/core/hooks/magic-context/compartment-render-epoch";
import { memorySnapshotKey } from "@magic-context/core/hooks/magic-context/kernel-memory-render";
import {
	EMPTY_PROJECT_MARKER,
	type KernelMemorySnapshot,
	unavailable,
} from "@magic-context/core/shared/kernel-client";
import { FakeKernel } from "@magic-context/core/shared/kernel-client-testing/fake-kernel";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	injectM0M1Pi,
	materializeM0Pi,
	materializeM0PiWithRetry,
	mustMaterializePi,
	type PiM0M1State,
	renderM0Pi,
	renderM1Pi,
} from "./inject-compartments-pi";
import { createTestDb, textOf, userMessage } from "./test-utils";

type TestDb = ReturnType<typeof createTestDb>;

/** The m[0] of a project with no compartments and an `available` kernel read that returns no rows. */
const EMPTY_PROJECT_M0 = `<session-history></session-history>\n\n<project-memory>\n${EMPTY_PROJECT_MARKER}\n</project-memory>`;

/**
 * One fake kernel per database and project stands in for the daemon's
 * project-scoped read; `memoryFor` is the snapshot the pass would have read.
 */
const kernels = new WeakMap<TestDb, Map<string, FakeKernel>>();
let testMemoryId = 0;

function kernelFor(db: TestDb, projectPath: string): FakeKernel {
	let byProject = kernels.get(db);
	if (!byProject) {
		byProject = new Map();
		kernels.set(db, byProject);
	}
	let kernel = byProject.get(projectPath);
	if (!kernel) {
		kernel = new FakeKernel();
		byProject.set(projectPath, kernel);
	}
	return kernel;
}

function memoryFor(db: TestDb, projectPath: string): KernelMemorySnapshot {
	return kernelFor(db, projectPath).snapshot();
}

function memoryObjectId(id: number): string {
	return `mem_${id.toString(16).padStart(32, "0")}`;
}

interface SeededMemory {
	id: string;
	projectPath: string;
}

function insertMemory(
	db: TestDb,
	input: {
		projectPath: string;
		category: string;
		content: string;
	},
): SeededMemory {
	testMemoryId += 1;
	const id = memoryObjectId(testMemoryId);
	kernelFor(db, input.projectPath).seedDecision({
		object_id: id,
		decision_kind: input.category,
		summary: input.content,
	});
	return { id, projectPath: input.projectPath };
}

function archiveSeededMemory(db: TestDb, memory: SeededMemory): void {
	const kernel = kernelFor(db, memory.projectPath);
	const object = kernel.objects.get(memory.id);
	if (!object) throw new Error(`missing seeded memory ${memory.id}`);
	kernel.touch(memory.id);
	object.invalidated_commit_seq = kernel.tip;
}

/**
 * A state whose `memory` re-reads the fake kernel on each access, so a test
 * can seed memories after building the state the way a later pass would read
 * a newer snapshot.
 */
function piState(
	db: TestDb,
	sessionId: string,
	cwd: string,
	overrides: Partial<PiM0M1State> = {},
): PiM0M1State {
	const projectIdentity = resolveProjectIdentity(cwd);
	return {
		sessionId,
		projectIdentity,
		projectDirectory: cwd,
		injectionBudgetTokens: 10_000,
		get memory() {
			return memoryFor(db, projectIdentity);
		},
		...overrides,
	};
}

function user(text: string, timestamp = 1) {
	return { role: "user" as const, content: text, timestamp };
}

function assistant(callIds: string[], text = "") {
	return {
		role: "assistant" as const,
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...callIds.map((id) => ({
				type: "toolCall" as const,
				id,
				name: "read",
				arguments: {},
			})),
		],
		timestamp: 1,
	};
}

function result(toolCallId: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text: `out-${toolCallId}` }],
		isError: false,
		timestamp: 1,
	};
}

describe("trimPiMessagesToBoundary", () => {
	it("sweeps non-contiguous toolResults whose assistant toolCall was trimmed", () => {
		const messages = [
			assistant(["call-a"]),
			user("interleaved"),
			result("call-a"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "u1", "r", "u2"],
			"a",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect((messages[0] as { content: string }).content).toBe("interleaved");
	});

	it("sweeps split multi-toolCall results after an intervening user", () => {
		const messages = [
			assistant(["call-a", "call-b"]),
			user("gap"),
			result("call-a"),
			result("call-b"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "gap", "ra", "rb", "keep"],
			"a",
		);

		expect(removed).toBe(3);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("sweeps kept assistant toolCalls when their toolResult was trimmed", () => {
		const messages = [
			user("old"),
			result("call-a"),
			assistant(["call-a"]),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["u", "r", "a", "keep"],
			"r",
		);

		expect(removed).toBe(3);
		expect(messages).toEqual([user("keep")]);
	});

	it("resolves a synth-user-* cutoff to the underlying real toolResult entry id", () => {
		// A folded-`toolResult` compartment stores `synth-user-<realToolResultEntryId>` in `endMessageId`.
		// The live array contains the real `toolResult` entry ID, not its synthetic `endMessageId`.
		// A `synth-user-` cutoff matches the corresponding real `toolResult` entry ID.
		// After removing a `toolResult`, the orphan sweep removes its paired assistant.
		const messages = [
			assistant(["call-a"]),
			result("call-a"),
			assistant([], "next turn"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "tr-real", "a2", "keep"],
			"synth-user-tr-real",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["assistant", "user"]);
		expect((messages[1] as { content: string }).content).toBe("keep");
	});

	it("returns 0 (no spurious trim) when a synth-user-* cutoff has no matching real entry", () => {
		const messages = [assistant(["call-a"]), user("keep")];
		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "keep"],
			"synth-user-nonexistent",
		);
		expect(removed).toBe(0);
		expect(messages.length).toBe(2);
	});

	it("does not over-remove a later kept tool pair that reuses a trimmed callId", () => {
		const messages = [
			assistant(["reused"]),
			result("reused"),
			user("between turns"),
			assistant(["reused"]),
			result("reused"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a1", "r1", "u1", "a2", "r2", "u2"],
			"a1",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		expect((messages[3] as { content: string }).content).toBe("keep");
	});

	it("renders frozen compartment and user-profile snapshots without m[0]/m[1] duplication", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-frozen-cp-profile-"));
		try {
			const state = piState(db, "ses-pi-frozen-cp-profile", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Frozen",
					content: "U: old turn\nold compartment body",
				},
			]);
			insertUserMemory(db, "old profile memory", []);
			const frozenCompartments = getCompartments(db, state.sessionId);
			const frozenUserProfile = getActiveUserMemories(db);

			appendCompartments(db, state.sessionId, [
				{
					sequence: 2,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-2",
					endMessageId: "entry-2",
					title: "Concurrent",
					content: "U: new turn\nnew compartment body",
				},
			]);
			insertUserMemory(db, "new profile memory", []);

			const m0 = renderM0Pi(
				state,
				db,
				"",
				1,
				[],
				frozenCompartments,
				frozenUserProfile,
			);
			const m1 = renderM1Pi(state, db, {
				claimFormatEpoch: 1,
				memorySnapshotKey: memorySnapshotKey(state.memory),
				renderedRevisionLocators: [],
				maxCompartmentSeq: 1,
				maxMutationId: 0,
				projectUserProfileVersion: 0,
				projectDocsHash: "",
				sessionFactsVersion: 0,
				materializedAt: 0,
				upgradeState: "",
				lastBaselineEndMessageId: "entry-1",
			});

			expect(m0).toContain("old compartment body");
			expect(m0).toContain("old profile memory");
			expect(m0).not.toContain("new compartment body");
			expect(m0).not.toContain("new profile memory");
			expect(m1).toContain("new compartment body");
			expect(m1).not.toContain("old compartment body");
			expect(m1).not.toContain("old profile memory");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("injectM0M1Pi memory feature gate", () => {
	it("does NOT render project memories into m[0]/m[1] when memoryEnabled=false", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-memgate-"));
		try {
			const base = piState(db, "ses-pi-memgate", cwd);
			appendCompartments(db, base.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "history",
					content: "U: a turn\ncompartment body present",
				},
			]);
			insertMemory(db, {
				projectPath: base.projectIdentity,
				category: "ARCHITECTURE",
				content: "SECRET project memory must not leak when disabled",
			});

			const disabledState = { ...base, memoryEnabled: false };
			const off = [userMessage("hello", 10)];
			injectM0M1Pi(disabledState, db, off as never, undefined, true);
			const offM0 = textOf(off[0] as never);
			expect(offM0).not.toContain("SECRET project memory");
			expect(offM0).not.toContain("<project-memory");
			expect(offM0).toContain("compartment body present");

			const onState = piState(db, "ses-pi-memgate-on", cwd);
			appendCompartments(db, onState.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "history",
					content: "U: a turn\ncompartment body present",
				},
			]);
			const on = [userMessage("hello", 10)];
			injectM0M1Pi(onState, db, on as never, undefined, true);
			expect(textOf(on[0] as never)).toContain("SECRET project memory");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("injectM0M1Pi", () => {
	it("keeps project memory but removes compartment rendering and trim in compaction-off mode", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-compaction-off-"));
		try {
			const offState = piState(db, "ses-pi-compaction-off", cwd, {
				compactionOff: true,
			});
			appendCompartments(db, offState.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old-entry",
					endMessageId: "old-entry",
					title: "old history",
					content: "compartment-only history must stay off the wire",
				},
			]);
			insertMemory(db, {
				projectPath: offState.projectIdentity,
				category: "ARCHITECTURE",
				content: "compaction-off memory survives",
			});
			const messages = [
				userMessage("raw history stays visible", 10),
				userMessage("live tail", 11),
			];
			const result = injectM0M1Pi(offState, db, messages as never, [
				"old-entry",
				"live-entry",
			]);

			expect(textOf(messages[0] as never)).toContain(
				"compaction-off memory survives",
			);
			expect(textOf(messages[0] as never)).not.toContain("<session-history>");
			expect(textOf(messages[0] as never)).not.toContain(
				"compartment-only history must stay off the wire",
			);
			expect(result.skippedVisibleMessages).toBe(0);
			expect(textOf(messages.at(-1) as never)).toBe("live tail");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("renders first-pass m[0] with no inner content and m[1] placeholder", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-empty-"));
		try {
			const messages = [userMessage("hello", 10)];
			injectM0M1Pi(piState(db, "ses-pi-empty", cwd), db, messages as never);

			expect(textOf(messages[0] as never)).toBe(EMPTY_PROJECT_M0);
			expect(textOf(messages[1] as never)).toBe(
				"<session-history-since>(no new content since last materialization)</session-history-since>",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("gates project docs block and hash with injectDocs=false", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-docs-gate-"));
		try {
			writeFileSync(
				join(cwd, "ARCHITECTURE.md"),
				"# PI_FLAG_OFF_ARCH_DOCS\nArchitecture bytes must stay out.\n",
			);
			writeFileSync(
				join(cwd, "STRUCTURE.md"),
				"# PI_FLAG_OFF_STRUCTURE_DOCS\nStructure bytes must stay out.\n",
			);
			const state = piState(db, "ses-pi-docs-off", cwd, { injectDocs: false });

			const first = [userMessage("hello", 10)];
			const firstResult = injectM0M1Pi(state, db, first as never);
			const firstM0 = textOf(first[0] as never);
			const firstM1 = textOf(first[1] as never);

			expect(firstResult.m0Materialized).toBe(true);
			expect(firstM0).not.toContain("<project-docs>");
			expect(firstM0).not.toContain("PI_FLAG_OFF_ARCH_DOCS");
			expect(firstM0).not.toContain("PI_FLAG_OFF_STRUCTURE_DOCS");
			expect(
				getOrCreateSessionMeta(db, state.sessionId).cachedM0ProjectDocsHash,
			).toBe("");
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});

			const second = [userMessage("hello again", 11)];
			const secondResult = injectM0M1Pi(
				state,
				db,
				second as never,
				undefined,
				false,
			);

			expect(secondResult.m0Materialized).toBe(false);
			expect(textOf(second[0] as never)).toBe(firstM0);
			expect(textOf(second[1] as never)).toBe(firstM1);

			const enabledState = piState(db, "ses-pi-docs-on", cwd);
			const enabled = [userMessage("hello docs", 12)];
			injectM0M1Pi(enabledState, db, enabled as never);
			expect(textOf(enabled[0] as never)).toContain("<project-docs>");
			expect(textOf(enabled[0] as never)).toContain("PI_FLAG_OFF_ARCH_DOCS");
			expect(textOf(enabled[0] as never)).toContain(
				"PI_FLAG_OFF_STRUCTURE_DOCS",
			);
			expect(
				mustMaterializePi({ ...enabledState, injectDocs: false }, db),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("replays byte-stable cached m[0]/m[1] for identical state", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-stable-"));
		try {
			const state = piState(db, "ses-pi-stable", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			const firstM0 = textOf(first[0] as never);
			const firstM1 = textOf(first[1] as never);

			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never);

			expect(textOf(second[0] as never)).toBe(firstM0);
			expect(textOf(second[1] as never)).toBe(firstM1);
		} finally {
			closeQuietly(db);
		}
	});

	it("folds a legacy render epoch once, then replays m[0]/m[1] byte-identically", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-render-epoch-"));
		try {
			const state = piState(db, "ses-pi-render-epoch", cwd);
			injectM0M1Pi(state, db, [userMessage("first", 10)] as never);
			db.prepare(
				"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_upgrade_state = ? WHERE session_id = ?",
			).run(
				Buffer.from("<session-history>legacy renderer bytes</session-history>"),
				"pi-m0m1-v2:ready",
				state.sessionId,
			);

			expect(mustMaterializePi(state, db)).toMatchObject({
				value: true,
				reason: "compartment_render_epoch",
			});
			const foldedMessages = [userMessage("same", 11)];
			const folded = injectM0M1Pi(state, db, foldedMessages as never);
			const foldedM0 = textOf(foldedMessages[0] as never);
			const foldedM1 = textOf(foldedMessages[1] as never);
			const replay1 = [userMessage("same", 11)];
			const replay2 = [userMessage("same", 11)];
			const replayResult1 = injectM0M1Pi(state, db, replay1 as never);
			const replayResult2 = injectM0M1Pi(state, db, replay2 as never);

			expect(folded.m0Materialized).toBe(true);
			expect(folded.m0Reason).toBe("compartment_render_epoch");
			expect(replayResult1.m0Materialized).toBe(false);
			expect(replayResult2.m0Materialized).toBe(false);
			expect(textOf(replay1[0] as never)).toBe(foldedM0);
			expect(textOf(replay2[0] as never)).toBe(foldedM0);
			expect(textOf(replay1[1] as never)).toBe(foldedM1);
			expect(textOf(replay2[1] as never)).toBe(foldedM1);
			expect(
				getOrCreateSessionMeta(db, state.sessionId).cachedM0UpgradeState,
			).toContain(COMPARTMENT_RENDER_EPOCH);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes m[0] when a LEGACY compartment appears (upgrade_state HARD flip)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-compartment-"));
		try {
			const state = piState(db, "ses-pi-compartment", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			expect(textOf(first[0] as never)).not.toContain("Compacted setup");

			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never, ["entry-1"]);

			expect(textOf(second[0] as never)).toContain("## 1-1 · Setup");
			expect(textOf(second[0] as never)).toContain("Compacted setup");
			expect(textOf(second[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("SOFT pass: new v2 compartment surfaces in m[1] WITHOUT re-materializing m[0], raw messages trimmed", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-soft-delta-"));
		try {
			const state = piState(db, "ses-pi-soft-delta", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "First",
					content: "U: first turn\nfirst compartment body",
					p1: "U: first turn\nfirst compartment body",
				},
			]);
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never, ["entry-0"]);
			expect(r0.m0Materialized).toBe(true);
			const baselineM0 = textOf(firstPass[0] as never);
			expect(baselineM0).toContain("first compartment body");

			// m[0].
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Delta",
					content: "U: second turn\nsecond compartment body",
					p1: "U: second turn\nsecond compartment body",
				},
			]);

			const secondPass = [
				userMessage("covered-0", 10), // entry-0 → already baseline
				userMessage("covered-1", 11), // entry-1 → new compartment, must trim
				userMessage("keep", 12), // live tail → must survive
			];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-0", "entry-1", "keep"],
				true,
			);

			expect(r1.m0Materialized).toBe(false);
			const m0 = textOf(secondPass[0] as never);
			expect(m0).toBe(baselineM0);
			expect(m0).not.toContain("second compartment body");
			expect(textOf(secondPass[1] as never)).toContain(
				"second compartment body",
			);
			expect(r1.skippedVisibleMessages).toBe(2);
			expect(textOf(secondPass[secondPass.length - 1] as never)).toBe("keep");
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with NULL required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-null-marker-"));
		try {
			const state = piState(db, "ses-pi-null-marker", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const second = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, second as never);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(textOf(second[0] as never)).toContain("<session-history>");
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps legacy cached max seq 0 when a real seq-0 compartment exists", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-legacy-zero-real-"));
		try {
			const state = piState(db, "ses-pi-legacy-zero-real", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Seq Zero",
					content: "U: first turn\nseq zero body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, ["entry-0"]);

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never, ["entry-0"]);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toContain("seq zero body");
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("normalizes legacy cached max seq 0 to empty only with zero compartments", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-legacy-zero-empty-"));
		try {
			const state = piState(db, "ses-pi-legacy-zero-empty", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = 0 WHERE session_id = ?",
			).run(state.sessionId);

			expect(getCompartments(db, state.sessionId)).toHaveLength(0);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(EMPTY_PROJECT_M0);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with any partial required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-partial-marker-"));
		try {
			const state = piState(db, "ses-pi-partial-marker", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_materialized_at = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes instead of reusing cached m[0] when compartment boundary is NULL", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-null-boundary-"));
		try {
			const state = piState(db, "ses-pi-null-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Boundary",
					content: "U: boundary turn\nboundary body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, ["entry-0"]);
			db.prepare(
				"UPDATE session_meta SET cached_m0_last_baseline_end_message_id = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const messages = [userMessage("covered", 10), userMessage("keep", 11)];
			const result = injectM0M1Pi(state, db, messages as never, [
				"entry-0",
				"keep",
			]);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[2] as never)).toBe("keep");
		} finally {
			closeQuietly(db);
		}
	});

	it("reuses cached m[0] (no rematerialize loop) when the compartment is legitimately boundaryless", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-empty-boundary-"));
		try {
			const state = piState(db, "ses-pi-empty-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "",
					endMessageId: "",
					title: "Boundaryless",
					content: "U: turn\nbody",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, []);

			expect(mustMaterializePi(state, db).value).toBe(false);

			const pass1Messages = [userMessage("hello", 10)];
			const result1 = injectM0M1Pi(state, db, pass1Messages as never, []);
			expect(result1.m0Materialized).toBe(false);
			expect(result1.skippedVisibleMessages).toBe(0);

			const pass2Messages = [userMessage("hello", 10)];
			const result2 = injectM0M1Pi(state, db, pass2Messages as never, []);
			expect(result2.m0Materialized).toBe(false);
			expect(result2.m0Reason).toBeNull();

			expect(textOf(pass2Messages[0] as never)).toBe(
				textOf(pass1Messages[0] as never),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("retries instead of losing seq-0 compartment published during materialization", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-seq0-race-"));
		try {
			const state = piState(db, "ses-pi-seq0-race", cwd);
			const originalExec = db.exec.bind(db);
			let injectedRace = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedRace) {
					injectedRace = true;
					appendCompartments(db, state.sessionId, [
						{
							sequence: 0,
							startMessage: 1,
							endMessage: 1,
							startMessageId: "entry-0",
							endMessageId: "entry-0",
							title: "First",
							content: "U: first turn\nseq zero body",
						},
					]);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const { m0, snapshotMarkers } = materializeM0PiWithRetry(state, db);

			expect(injectedRace).toBe(true);
			expect(snapshotMarkers.maxCompartmentSeq).toBe(0);
			expect(m0).toContain("seq zero body");
		} finally {
			closeQuietly(db);
		}
	});

	it("trims against the frozen cached boundary instead of live rewritten compartments", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-frozen-boundary-"));
		try {
			const state = piState(db, "ses-pi-frozen-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old-end",
					endMessageId: "old-end",
					title: "Frozen",
					content: "U: old turn\nfrozen body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			db.prepare(
				"UPDATE compartments SET end_message_id = ? WHERE session_id = ? AND sequence = 0",
			).run("too-far", state.sessionId);

			const messages = [
				userMessage("old visible", 10),
				userMessage("must stay", 11),
				userMessage("keep", 12),
			];
			const result = injectM0M1Pi(state, db, messages as never, [
				"old-end",
				"too-far",
				"keep",
			]);

			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[2] as never)).toBe("must stay");
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE error exposes only SQLITE_BUSY code", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-begin-busy-code-"));
		try {
			const state = piState(db, "ses-pi-begin-busy-code", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy Code",
					content: "U: busy code turn\nbusy code fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					const error = new Error("writer unavailable") as Error & {
						code: string;
					};
					error.code = "SQLITE_BUSY";
					throw error;
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(EMPTY_PROJECT_M0);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
			expect(textOf(messages[1] as never)).not.toContain(
				"busy code fallback body",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE is busy", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-begin-busy-"));
		try {
			const state = piState(db, "ses-pi-begin-busy", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy",
					content: "U: busy turn\nbusy fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					throw new Error("SQLITE_BUSY: database is locked");
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(EMPTY_PROJECT_M0);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
			expect(textOf(messages[1] as never)).not.toContain("busy fallback body");
		} finally {
			closeQuietly(db);
		}
	});

	it("folds a new claim into m[0] when its snapshot vector changes", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-claim-additive-fold-"));
		try {
			const state = piState(db, "ses-pi-claim-additive-fold", cwd);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Initial Pi claim.",
			});
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			const initialM0 = textOf(first[0] as never);

			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "New claim folds after vector change.",
			});
			const folded = [userMessage("fold", 11)];
			const foldResult = injectM0M1Pi(
				state,
				db,
				folded as never,
				undefined,
				false,
			);
			expect(foldResult.m0Materialized).toBe(true);
			expect(textOf(folded[0] as never)).toContain(
				"New claim folds after vector change.",
			);
			expect(textOf(folded[0] as never)).not.toBe(initialM0);

			const replay = [userMessage("replay", 12)];
			const replayResult = injectM0M1Pi(
				state,
				db,
				replay as never,
				undefined,
				false,
			);
			expect(replayResult.m0Materialized).toBe(false);
			expect(textOf(replay[0] as never)).toBe(textOf(folded[0] as never));
		} finally {
			closeQuietly(db);
		}
	});

	it("folds an archived memory out of m[0] when its snapshot key changes", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-memory-archive-fold-"));
		try {
			const state = piState(db, "ses-pi-memory-archive-fold", cwd);
			const memory = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Memory removed by lifecycle fold.",
			});
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			expect(textOf(first[0] as never)).toContain(
				"Memory removed by lifecycle fold.",
			);

			archiveSeededMemory(db, memory);
			const folded = [userMessage("fold", 11)];
			const foldResult = injectM0M1Pi(
				state,
				db,
				folded as never,
				undefined,
				false,
			);
			expect(foldResult.m0Materialized).toBe(true);
			expect(textOf(folded[0] as never)).not.toContain(
				"Memory removed by lifecycle fold.",
			);
			expect(textOf(folded[1] as never)).not.toContain("<memory-updates>");

			const replay = [userMessage("replay", 12)];
			const replayResult = injectM0M1Pi(
				state,
				db,
				replay as never,
				undefined,
				false,
			);
			expect(replayResult.m0Materialized).toBe(false);
			expect(textOf(replay[0] as never)).toBe(textOf(folded[0] as never));
		} finally {
			closeQuietly(db);
		}
	});

	it("folds when the memory snapshot key moves, and renders the state marker for a non-available read", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-snapshot-key-"));
		try {
			const state = piState(db, "ses-pi-snapshot-key", cwd);
			const seeded = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Frozen snapshot memory.",
			});
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, undefined, true);
			expect(mustMaterializePi(state, db)).toEqual({ value: false, reason: null });

			const kernel = kernelFor(db, state.projectIdentity);
			kernel.touch(seeded.id);
			expect(mustMaterializePi(state, db)).toEqual({ value: false, reason: null });
			const object = kernel.objects.get(seeded.id);
			if (object?.decision) object.decision.payload.summary = "Revised snapshot memory.";
			expect(mustMaterializePi(state, db)).toMatchObject({
				value: true,
				reason: "project_memory_change",
				mismatch: { signal: "memorySnapshotKey" },
			});

			const absent = piState(db, state.sessionId, cwd, {
				memory: { state: unavailable("daemon_absent"), rows: [], knownAsOf: null },
			});
			const messages = [userMessage("absent", 11)];
			const result = injectM0M1Pi(absent, db, messages as never, undefined, true);
			expect(result.m0Materialized).toBe(true);
			expect(result.memoryCount).toBe(0);
			expect(textOf(messages[0] as never)).toContain(
				"<project-memory>\nmemory: daemon not running\n</project-memory>",
			);
			expect(textOf(messages[0] as never)).not.toContain("Frozen snapshot memory.");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS rolls back and replays a sibling cached m1 on marker mismatch", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState(db, "ses-pi-m1-soft-cas", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_claim_format_epoch = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						Buffer.from(
							`<session-history>${"baseline ".repeat(300)}</session-history>`,
							"utf8",
						),
						99,
						Buffer.from("sibling cached m1", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[1] as never)).toBe("sibling cached m1");
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS rejects byte-different m[0] even when non-doc markers match", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-bytes-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState(db, "ses-pi-m1-soft-cas-bytes", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			const siblingM0 = Buffer.from(
				`<session-history>${"byte mismatch ".repeat(300)}</session-history>`,
				"utf8",
			);
			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						siblingM0,
						Buffer.from("sibling cached pi m1 byte mismatch", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[0] as never)).toBe(siblingM0.toString("utf8"));
			expect(textOf(bust[1] as never)).toBe(
				"sibling cached pi m1 byte mismatch",
			);
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});

	it("memory snapshot changes force a hard fold despite concurrent docs-marker drift", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-docs-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState(db, "ses-pi-m1-soft-cas-docs", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			const baselineM0 = textOf(first[0] as never);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Pi docs-hash-only CAS delta memory",
			});
			let changedDocsMarker = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !changedDocsMarker) {
					changedDocsMarker = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_project_docs_hash = ? WHERE session_id = ?",
					).run("docs-only-marker-drift", state.sessionId);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(changedDocsMarker).toBe(true);
			expect(result.m0Materialized).toBe(true);
			expect(textOf(bust[0] as never)).not.toBe(baselineM0);
			expect(textOf(bust[0] as never)).toContain(
				"Pi docs-hash-only CAS delta memory",
			);
			expect(textOf(bust[1] as never)).not.toContain("<new-memories>");
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});
});

describe("renderM0Pi sibling-block layout (OpenCode parity)", () => {
	it("renders <project-memory> as a SIBLING after </session-history>, not nested inside it", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-siblings-"));
		try {
			const state = piState(db, "ses-pi-siblings", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "The widget service owns rendering.",
			});

			const m0 = renderM0Pi(state, db);

			const historyClose = m0.indexOf("</session-history>");
			const memoryOpen = m0.indexOf("<project-memory>");
			expect(historyClose).toBeGreaterThan(-1);
			expect(memoryOpen).toBeGreaterThan(-1);
			expect(memoryOpen).toBeGreaterThan(historyClose);
			expect(m0).toContain("<ARCHITECTURE>\nmem_");
			expect(m0).not.toContain("<memory id=");
			const historyBlock = m0.slice(
				m0.indexOf("<session-history>"),
				historyClose,
			);
			expect(historyBlock).toContain("Compacted setup");
			expect(historyBlock).not.toContain("widget service");
		} finally {
			closeQuietly(db);
		}
	});

	it("materializeM0Pi binds object ids as locators and the memory snapshot key", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-locators-"));
		try {
			const state = piState(db, "ses-pi-locators", cwd);
			const locators = [
				"The widget service owns rendering.",
				"Orders flow through an async queue.",
				"Sessions use stateless JWT.",
			].map(
				(content) =>
					insertMemory(db, {
						projectPath: state.projectIdentity,
						category: "ARCHITECTURE",
						content,
					}).id,
			);

			const { snapshotMarkers, renderedRevisionLocators } = materializeM0Pi(
				state,
				db,
			);

			expect(new Set(renderedRevisionLocators)).toEqual(new Set(locators));
			expect(snapshotMarkers.renderedRevisionLocators).toEqual(
				renderedRevisionLocators,
			);
			expect(snapshotMarkers.memorySnapshotKey).toBe(
				memorySnapshotKey(state.memory),
			);
			expect(
				db
					.prepare(
						"SELECT cached_m0_claim_snapshot_vector AS key FROM session_meta WHERE session_id = ?",
					)
					.get(state.sessionId),
			).toEqual({ key: memorySnapshotKey(state.memory) });
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD fold binds materializedAt to the fold timestamp and renders one memory block", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-d16c-"));
		try {
			const state = piState(db, "ses-pi-d16c", cwd);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "KNOWN_ISSUES",
				content: "Pi D16c expiry-gap memory",
			});
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Pi D16c permanent anchor",
			});

			const realNow = Date.now;
			const foldAt = 10_000;
			let nowCalls = 0;
			Date.now = () => {
				nowCalls += 1;
				return nowCalls === 1 ? foldAt : 99_000;
			};

			try {
				state.hardSignals = {
					systemHash: "fold-a",
					modelKey: "model-v1",
					cacheExpired: false,
					lastResponseTime: 0,
				};
				const first = materializeM0Pi(state, db);
				expect(first.m0).toContain("Pi D16c expiry-gap memory");
				expect(first.snapshotMarkers.materializedAt).toBe(foldAt);

				nowCalls = 0;
				state.hardSignals = {
					systemHash: "fold-b",
					modelKey: "model-v1",
					cacheExpired: false,
					lastResponseTime: 0,
				};
				const second = materializeM0Pi(state, db);
				expect(second.m0).toContain("Pi D16c expiry-gap memory");
				expect(
					second.m0.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0],
				).toBe(
					first.m0.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0],
				);
			} finally {
				Date.now = realNow;
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("mustMaterializePi — SOFT/HARD taxonomy (parity with OpenCode)", () => {
	const baseHard = {
		systemHash: "sys-v1",
		modelKey: "anthropic/opus",
		cacheExpired: false,
		lastResponseTime: 0,
	};

	function compartment(seq: number, body: string) {
		return {
			sequence: seq,
			startMessage: seq,
			endMessage: seq,
			startMessageId: `entry-${seq}`,
			endMessageId: `entry-${seq}`,
			title: `T${seq}`,
			content: body,
			p1: body,
		};
	}

	it("does NOT materialize m[0] on a new compartment (it rides m[1])", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-newcomp-"));
		try {
			const state = piState(db, "ses-pi-tax-newcomp", cwd, {
				hardSignals: baseHard,
			});
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			appendCompartments(db, state.sessionId, [compartment(1, "Bravo")]);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD: a model change folds m[0]", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-"));
		try {
			const state = piState(db, "ses-pi-tax-model", cwd, {
				hardSignals: baseHard,
			});
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const switched = {
				...state,
				hardSignals: { ...baseHard, modelKey: "anthropic/sonnet" },
			};
			expect(mustMaterializePi(switched, db)).toMatchObject({
				value: true,
				reason: "model_change",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD: a system-hash change folds m[0]", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-sys-"));
		try {
			const state = piState(db, "ses-pi-tax-sys", cwd, {
				hardSignals: baseHard,
			});
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const changed = {
				...state,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			expect(mustMaterializePi(changed, db)).toMatchObject({
				value: true,
				reason: "system_hash",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("lazy-adopts a NULL cached project marker without a no-switch HARD fold", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-project-null-a-"));
		const cwdB = mkdtempSync(join(tmpdir(), "pi-tax-project-null-b-"));
		try {
			const state = piState(db, "ses-pi-tax-project-null", cwd, {
				hardSignals: baseHard,
			});
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(state, db, first as never, ["entry-0"]);
			const baselineM0 = textOf(first[0] as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_project_identity = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const noSwitch = [userMessage("same project", 11)];
			const noSwitchResult = injectM0M1Pi(state, db, noSwitch as never, [
				"entry-0",
			]);

			expect(noSwitchResult.m0Materialized).toBe(false);
			expect(noSwitchResult.m0Reason).not.toBe("first_render");
			expect(noSwitchResult.m0Reason).not.toBe("project_change");
			expect(textOf(noSwitch[0] as never)).toBe(baselineM0);
			expect(
				db
					.prepare(
						"SELECT cached_m0_project_identity FROM session_meta WHERE session_id = ?",
					)
					.get(state.sessionId),
			).toEqual({ cached_m0_project_identity: state.projectIdentity });

			const switched = piState(db, state.sessionId, cwdB, {
				hardSignals: baseHard,
			});
			expect(mustMaterializePi(switched, db)).toMatchObject({
				value: true,
				reason: "project_change",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("HARD: a genuine same-session project switch folds exactly once, then stabilizes", () => {
		const db = createTestDb();
		const cwdA = mkdtempSync(join(tmpdir(), "pi-tax-project-a-"));
		const cwdB = mkdtempSync(join(tmpdir(), "pi-tax-project-b-"));
		try {
			const stateA = piState(db, "ses-pi-tax-project-switch", cwdA, {
				hardSignals: baseHard,
			});
			insertMemory(db, {
				projectPath: stateA.projectIdentity,
				category: "ARCHITECTURE",
				content: "Project A memory must not replay after /cd.",
			});
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(stateA, db, first as never, undefined, true);
			expect(textOf(first[0] as never)).toContain("Project A memory");

			const stateB = piState(db, stateA.sessionId, cwdB, {
				hardSignals: baseHard,
			});
			insertMemory(db, {
				projectPath: stateB.projectIdentity,
				category: "ARCHITECTURE",
				content: "Project B memory is the switched project baseline.",
			});

			const switched = [userMessage("after cd", 11)];
			const switchedResult = injectM0M1Pi(
				stateB,
				db,
				switched as never,
				undefined,
				true,
			);
			expect(switchedResult.m0Materialized).toBe(true);
			expect(switchedResult.m0Reason).toBe("project_change");
			expect(textOf(switched[0] as never)).toContain("Project B memory");
			expect(textOf(switched[0] as never)).not.toContain("Project A memory");

			const stable = [userMessage("after cd stable", 12)];
			const stableResult = injectM0M1Pi(
				stateB,
				db,
				stable as never,
				undefined,
				false,
			);
			expect(stableResult.m0Materialized).toBe(false);
			expect(stableResult.m0Reason).toBeNull();
			expect(textOf(stable[0] as never)).toBe(textOf(switched[0] as never));
		} finally {
			rmSync(cwdA, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("model and system changes materialize with classified reasons, not first_render", () => {
		const db = createTestDb();
		const cwdModel = mkdtempSync(join(tmpdir(), "pi-tax-model-reason-"));
		const cwdSystem = mkdtempSync(join(tmpdir(), "pi-tax-system-reason-"));
		try {
			const modelState = piState(db, "ses-pi-tax-model-reason", cwdModel, {
				hardSignals: baseHard,
			});
			injectM0M1Pi(modelState, db, [userMessage("hi", 10)] as never);
			const modelChanged = {
				...modelState,
				hardSignals: { ...baseHard, modelKey: "anthropic/sonnet" },
			};
			const modelPass = [userMessage("model", 11)];
			const modelResult = injectM0M1Pi(modelChanged, db, modelPass as never);
			expect(modelResult.m0Materialized).toBe(true);
			expect(modelResult.m0Reason).toBe("model_change");
			expect(modelResult.m0Reason).not.toBe("first_render");

			const systemState = piState(db, "ses-pi-tax-system-reason", cwdSystem, {
				hardSignals: baseHard,
			});
			injectM0M1Pi(systemState, db, [userMessage("hi", 10)] as never);
			const systemChanged = {
				...systemState,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			const systemPass = [userMessage("system", 11)];
			const systemResult = injectM0M1Pi(systemChanged, db, systemPass as never);
			expect(systemResult.m0Materialized).toBe(true);
			expect(systemResult.m0Reason).toBe("system_hash");
			expect(systemResult.m0Reason).not.toBe("first_render");
		} finally {
			rmSync(cwdModel, { recursive: true, force: true });
			rmSync(cwdSystem, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("an empty current HARD signal is never treated as a change", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-empty-"));
		try {
			const state = piState(db, "ses-pi-tax-empty", cwd, {
				hardSignals: baseHard,
			});
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const unknown = {
				...state,
				hardSignals: {
					systemHash: "",
					modelKey: "",
					cacheExpired: false,
					lastResponseTime: 0,
				},
			};
			expect(mustMaterializePi(unknown, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("does NOT materialize m[0] on a project docs hash change", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-docs-soft-"));
		try {
			const state = piState(db, "ses-pi-tax-docs-soft", cwd, {
				hardSignals: baseHard,
			});
			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Old Pi docs\n");
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				undefined,
				true,
			);

			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# New Pi docs\n");

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("folds current project docs on the next natural HARD materialization", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-docs-hard-"));
		try {
			const state = piState(db, "ses-pi-tax-docs-hard", cwd, {
				hardSignals: baseHard,
			});
			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Old Pi architecture\n");
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			expect(textOf(first[0] as never)).toContain("Old Pi architecture");

			writeFileSync(
				join(cwd, "ARCHITECTURE.md"),
				"# Updated Pi architecture\nFresh Pi docs folded on hard bust.\n",
			);
			const changed = {
				...state,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			const second = [userMessage("hi again", 11)];
			const result = injectM0M1Pi(
				changed,
				db,
				second as never,
				undefined,
				true,
			);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("system_hash");
			expect(textOf(second[0] as never)).toContain("Updated Pi architecture");
			expect(textOf(second[0] as never)).toContain(
				"Fresh Pi docs folded on hard bust.",
			);
			expect(textOf(second[0] as never)).not.toContain("Old Pi architecture");
		} finally {
			closeQuietly(db);
		}
	});
	it("reproduces the copied live marker tuple and keeps three canonical-alias replays byte-identical", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-live-marker-repro-"));
		try {
			const state = piState(db, "019de471-4fdc-762d-9286-624dfad0b5fe", cwd, {
				projectIdentity: "git:f78f6db52b23c81d58dae3879c9383f550ec180e",
				injectionBudgetTokens: 15_000,
				historyBudgetTokens: 27_540,
				muralEnabled: true,
				hardSignals: {
					...baseHard,
					systemHash: "38b2cc92af20c9236054057c7da1a3df",
					modelKey: "openai-codex/gpt-5.6-sol",
				},
			});
			appendCompartments(db, state.sessionId, [
				{
					sequence: 417,
					startMessage: 417,
					endMessage: 417,
					startMessageId: "entry-417",
					endMessageId: "entry-417",
					title: "Cached production boundary",
					content: "cached production compartment",
					p1: "cached production compartment",
				},
			]);
			db.prepare(
				"INSERT INTO m0_mutation_log (id, session_id, mutation_type, target_id, queued_at) VALUES (15, ?, 'compartment_upgrade', NULL, 1)",
			).run(state.sessionId);
			const firstMessages = [userMessage("same quiet tail", 10)];
			injectM0M1Pi(state, db, firstMessages as never, ["entry-0"]);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 425,
					startMessage: 425,
					endMessage: 425,
					startMessageId: "entry-425",
					endMessageId: "entry-425",
					title: "Live additive compartment",
					content: "new m1-only content after the cached boundary",
					p1: "new m1-only content after the cached boundary",
				},
			]);
			const firstM0 = textOf(firstMessages[0] as never);
			const firstM1 = textOf(firstMessages[1] as never);
			const meta = getOrCreateSessionMeta(db, state.sessionId);
			expect(meta.cachedM0ModelKey).toBe("openai/gpt-5.6-sol");
			expect(meta.cachedM0MaxCompartmentSeq).toBe(417);
			expect(meta.cachedM0MaxMutationId).toBe(15);
			expect(meta.cachedM0UpgradeState).toContain("mural-enabled:1");
			expect(meta.cachedM0UpgradeState).toContain(
				"render-budgets:m15000-h27540",
			);

			for (let pass = 0; pass < 3; pass += 1) {
				const messages = [userMessage("same quiet tail", 10)];
				const result = injectM0M1Pi(
					state,
					db,
					messages as never,
					["entry-0"],
					false,
				);
				expect(result.m0Materialized).toBe(false);
				expect(result.m0Reason).toBeNull();
				expect(textOf(messages[0] as never)).toBe(firstM0);
				expect(textOf(messages[1] as never)).toBe(firstM1);
			}

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			expect(
				mustMaterializePi({ ...state, muralEnabled: undefined }, db),
			).toEqual({
				value: true,
				reason: "render_config",
				mismatch: { signal: "muralEnabled", cached: true, current: false },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("does not hard-fold when the current model switches from canonical to Pi alias spelling", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-alias-forward-"));
		try {
			const state = piState(db, "ses-pi-tax-model-alias-forward", cwd, {
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-sol" },
			});
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const aliasOnly = {
				...state,
				hardSignals: { ...baseHard, modelKey: "openai-codex/gpt-5.6-sol" },
			};
			expect(mustMaterializePi(aliasOnly, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("persists a Pi-native baseline canonically, then accepts the reverse spelling flip", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-alias-reverse-"));
		try {
			const state = piState(db, "ses-pi-tax-model-alias-reverse", cwd, {
				hardSignals: { ...baseHard, modelKey: "openai-codex/gpt-5.6-sol" },
			});
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);
			expect(getOrCreateSessionMeta(db, state.sessionId).cachedM0ModelKey).toBe(
				"openai/gpt-5.6-sol",
			);

			const aliasOnly = {
				...state,
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-sol" },
			};
			expect(mustMaterializePi(aliasOnly, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("does not hard-fold when an existing cached baseline stores a native alias", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-alias-upgrade-"));
		try {
			const state = piState(db, "ses-pi-tax-model-alias-upgrade", cwd, {
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-sol" },
			});
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);
			db.prepare(
				"UPDATE session_meta SET cached_m0_model_key = ? WHERE session_id = ?",
			).run("openai-codex/gpt-5.6-sol", state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("folds exactly once for a genuinely different model in the same alias family", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-alias-real-switch-"));
		try {
			const state = piState(db, "ses-pi-tax-model-alias-real-switch", cwd, {
				hardSignals: { ...baseHard, modelKey: "openai-codex/gpt-5.6-sol" },
			});
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const realSwitch = {
				...state,
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-codex" },
			};
			expect(mustMaterializePi(realSwitch, db)).toMatchObject({
				value: true,
				reason: "model_change",
				mismatch: {
					signal: "modelKey",
					cached: "openai/gpt-5.6-sol",
					current: "openai/gpt-5.6-codex",
				},
			});
			const folded = injectM0M1Pi(
				realSwitch,
				db,
				[userMessage("switch", 11)] as never,
				["entry-1"],
			);
			const replay = injectM0M1Pi(
				realSwitch,
				db,
				[userMessage("switch", 11)] as never,
				["entry-1"],
			);
			expect(folded.m0Materialized).toBe(true);
			expect(folded.m0Reason).toBe("model_change");
			expect(replay.m0Materialized).toBe(false);
			expect(replay.m0Reason).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("injectM0M1Pi m[1]-rendered coverage watermark (marker-drain liveness)", () => {
	it("reports the m[1] delta watermark on a fresh recompute and null on pure replay", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-coverage-"));
		try {
			const state = piState(db, "ses-pi-m1-coverage", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "First",
					content: "first compartment body",
					p1: "first compartment body",
				},
			]);
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never, ["entry-0"]);
			expect(r0.m0Materialized).toBe(true);
			// Full materialization folds the compartment into m[0].
			// The m[0] boundary covers the compartment, leaving no m[1] delta beyond the m[0] snapshot watermark.
			// `m[0]` coverage ends at its snapshot watermark.
			expect(r0.renderedBoundary.endMessageId).toBe("entry-0");
			expect(r0.m1RenderedCoverage).toBeNull();

			// A second Historian compartment is an m[1] delta; m[0] remains unchanged.
			// A new compartment produces an m[1] delta without rematerializing m[0]; `new_compartment` is not a hard trigger.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Delta",
					content: "second compartment body",
					p1: "second compartment body",
				},
			]);

			// A soft refresh recomputes m[1] from the same compartment snapshot and stores the new compartment as the m[1] delta watermark.
			// For an empty baseline, m[1] alone certifies coverage.
			const secondPass = [
				userMessage("covered-0", 10),
				userMessage("covered-1", 11),
				userMessage("keep", 12),
			];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-0", "entry-1", "keep"],
				true,
			);
			expect(r1.m0Materialized).toBe(false);
			expect(r1.contentionExhausted).toBe(false);
			expect(r1.m1RenderedCoverage).toEqual({
				endMessageId: "entry-1",
				ordinal: 2,
			});

			// A pure replay pass must leave the coverage-certification field null because an earlier pass rendered the served bytes.
			const thirdPass = [
				userMessage("covered-0", 10),
				userMessage("covered-1", 11),
				userMessage("keep", 12),
			];
			const r2 = injectM0M1Pi(
				state,
				db,
				thirdPass as never,
				["entry-0", "entry-1", "keep"],
				false,
			);
			expect(r2.m0Materialized).toBe(false);
			expect(r2.m1RenderedCoverage).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("certifies coverage from the m[1] delta when the m[0] baseline is empty (the liveness-gap shape)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-coverage-empty-"));
		try {
			const state = piState(db, "ses-pi-m1-coverage-empty", cwd);
			// The empty m[0] baseline's snapshot markers carry no compartment boundary.
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never);
			expect(r0.m0Materialized).toBe(true);
			expect(r0.renderedBoundary).toEqual({
				endMessageId: null,
				ordinal: null,
			});
			expect(r0.m1RenderedCoverage).toBeNull();

			// The publication renders only into m[1].
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "A",
					content: "chunk a",
					p1: "chunk a",
				},
				{
					sequence: 1,
					startMessage: 3,
					endMessage: 4,
					startMessageId: "entry-3",
					endMessageId: "entry-4",
					title: "B",
					content: "chunk b",
					p1: "chunk b",
				},
				{
					sequence: 2,
					startMessage: 5,
					endMessage: 7,
					startMessageId: "entry-5",
					endMessageId: "entry-7",
					title: "C",
					content: "chunk c",
					p1: "chunk c",
				},
			]);

			const secondPass = [userMessage("hello", 10), userMessage("tail", 12)];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-1", "keep"],
				true,
			);
			expect(r1.m0Materialized).toBe(false);
			// The `<none>` m[0] arm cannot certify the pending marker; the fresh m[1] delta covers it through ordinal 7.
			expect(r1.renderedBoundary).toEqual({
				endMessageId: null,
				ordinal: null,
			});
			expect(r1.m1RenderedCoverage).toEqual({
				endMessageId: "entry-7",
				ordinal: 7,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("soft m[1] refresh sibling-fallback reports null coverage even with a newer live compartment", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-coverage-sibling-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState(db, "ses-pi-m1-coverage-sibling", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);

			// Sibling fallback serves bytes rendered before the live compartment, so coverage cannot be derived from live DB rows.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "New",
					content: "new compartment body",
					p1: "new compartment body",
				},
			]);

			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_claim_format_epoch = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						Buffer.from(
							`<session-history>${"baseline ".repeat(300)}</session-history>`,
							"utf8",
						),
						99,
						Buffer.from("sibling cached m1", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[1] as never)).toBe("sibling cached m1");
			// Sibling fallback serves bytes that predate the live compartment while `recomputed = false` leaves `contentionExhausted` false; set coverage to null so the next fresh render drains the pending marker.
			expect(result.contentionExhausted).toBe(false);
			expect(result.m1RenderedCoverage).toBeNull();
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});
});
