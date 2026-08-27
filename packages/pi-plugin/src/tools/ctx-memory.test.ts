import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	computeProjectMemoryMutationToken,
	getProjectMemoryClaimByPublicId,
} from "@magic-context/core/features/magic-context/memory/storage-claim-operations";
import {
	createClaimReaderTestDatabase,
	seedProjectMemoryClaim,
} from "@magic-context/core/features/magic-context/test-claim-database";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createCtxMemoryTools } from "@magic-context/core/tools/ctx-memory/tools";
import { createCtxMemoryTool } from "./ctx-memory";

const PROJECT = "git:u4-pi";
const FOREIGN = "git:u4-pi-foreign";

type MutationToken = ReturnType<typeof computeProjectMemoryMutationToken>;
type JsonResult = {
	action: string;
	outcome: string;
	staleReason: string | null;
	affectedClaims?: Array<{
		publicClaimId: string;
		revisionLocator: string;
		mutationToken: MutationToken;
	}>;
	claims?: Array<{
		publicClaimId: string;
		revisionLocator: string;
		content: string;
		lifecycleState: string;
		mutationToken: MutationToken;
	}>;
	missingPublicClaimIds?: string[];
	effects: unknown[];
	generation: number | null;
};

function harness(
	db: ReturnType<typeof createClaimReaderTestDatabase>,
	allowDreamerActions = false,
	resolveProjectIdentity: () => string = () => PROJECT,
) {
	const tool = createCtxMemoryTool({
		db,
		resolveProjectIdentity,
		allowDreamerActions,
	});
	const execute = async (args: Record<string, unknown>, callId: string) =>
		tool.execute(
			callId,
			args as never,
			new AbortController().signal,
			undefined,
			{
				cwd: "/tmp/u4-pi",
				sessionManager: { getSessionId: () => "ses-u4-pi" },
			} as never,
		);
	return { tool, execute };
}

function textOf(
	result: Awaited<ReturnType<ReturnType<typeof harness>["execute"]>>,
): string {
	return result.content[0]?.text ?? "";
}

function parseResult(
	result: Awaited<ReturnType<ReturnType<typeof harness>["execute"]>>,
): JsonResult {
	const text = textOf(result);
	expect(result.isError).toBeUndefined();
	return JSON.parse(text) as JsonResult;
}

function createArgs(content: string) {
	return { action: "create", category: "ARCHITECTURE", content };
}

/**
 * A model that saw a clamped tool call in reduced history imitates that wrapper.
 * Mutations must survive the imitation, tokens included.
 */
function reduced(inner: Record<string, unknown>) {
	return { reduced: true, summary: JSON.stringify(inner) };
}

describe("Pi ctx_memory U4 scenario 1: create", () => {
	it("returns canonical direct-claim result", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const result = parseResult(
				await harness(db).execute(
					createArgs("Pi uses direct claims."),
					"call-create",
				),
			);
			expect(result).toMatchObject({
				action: "create",
				outcome: "applied",
			});
			expect(result.affectedClaims?.[0]?.publicClaimId).toMatch(
				/^mcm_[0-9a-f]{32}$/,
			);
			expect(result.affectedClaims?.[0]?.revisionLocator).toContain("/r1/");
			expect(result.generation).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi ctx_memory U4 scenario 2: get/list", () => {
	it("reads by public ID and role-gates list", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const seeded = seedProjectMemoryClaim(db, {
				projectIdentity: PROJECT,
				content: "Pi reader claim.",
				operationKey: "u4-pi-read",
			});
			const primary = harness(db);
			const got = parseResult(
				await primary.execute(
					{ action: "get", publicClaimIds: [seeded.publicClaimId] },
					"call-get",
				),
			);
			expect(got.claims?.[0]).toMatchObject({
				publicClaimId: seeded.publicClaimId,
				revisionLocator: seeded.revisionLocator,
				content: "Pi reader claim.",
			});
			expect(
				textOf(await primary.execute({ action: "list" }, "call-list")),
			).toContain("not allowed");
			const listed = parseResult(
				await harness(db, true).execute(
					{ action: "list" },
					"call-list-dreamer",
				),
			);
			expect(listed.claims?.map((claim) => claim.publicClaimId)).toEqual([
				seeded.publicClaimId,
			]);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi ctx_memory U4 scenario 3: revise/lifecycle", () => {
	it("revises, archives, and restores with claim tokens", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const tool = harness(db);
			const created = parseResult(
				await tool.execute(createArgs("Pi lifecycle original."), "call-create"),
			);
			const first = created.affectedClaims?.[0];
			if (!first) throw new Error("missing create result");
			const revised = parseResult(
				await tool.execute(
					{
						action: "revise",
						publicClaimId: first.publicClaimId,
						mutationToken: first.mutationToken,
						content: "Pi lifecycle revised.",
					},
					"call-revise",
				),
			);
			const second = revised.affectedClaims?.[0];
			if (!second) throw new Error("missing revise result");
			expect(second.revisionLocator).toContain("/r2/");
			const archived = parseResult(
				await tool.execute(
					{
						action: "archive",
						publicClaimId: second.publicClaimId,
						mutationToken: second.mutationToken,
					},
					"call-archive",
				),
			);
			const archivedToken = archived.affectedClaims?.[0]?.mutationToken;
			if (!archivedToken) throw new Error("missing archive token");
			const restored = parseResult(
				await tool.execute(
					{
						action: "restore",
						publicClaimId: second.publicClaimId,
						mutationToken: archivedToken,
					},
					"call-restore",
				),
			);
			expect(restored.outcome).toBe("applied");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi ctx_memory U4 scenario 4: same-project merge", () => {
	it("retires same-project sources and rejects foreign sources", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const target = seedProjectMemoryClaim(db, {
				projectIdentity: PROJECT,
				content: "Pi merge target.",
				operationKey: "u4-pi-merge-target",
			});
			const source = seedProjectMemoryClaim(db, {
				projectIdentity: PROJECT,
				content: "Pi merge source.",
				operationKey: "u4-pi-merge-source",
			});
			const foreign = seedProjectMemoryClaim(db, {
				projectIdentity: FOREIGN,
				content: "Pi foreign source.",
				operationKey: "u4-pi-merge-foreign",
			});
			const tool = harness(db);
			const merged = parseResult(
				await tool.execute(
					{
						action: "merge",
						mutationTokens: [target.token, source.token],
						content: "Pi merged claim.",
					},
					"call-merge",
				),
			);
			expect(
				merged.affectedClaims?.map((claim) => claim.publicClaimId).sort(),
			).toEqual([target.publicClaimId, source.publicClaimId].sort());
			const blocked = await tool.execute(
				{
					action: "merge",
					mutationTokens: [
						computeProjectMemoryMutationToken(db, target.publicClaimId),
						foreign.token,
					],
				},
				"call-merge-foreign",
			);
			expect(blocked.isError).toBeTrue();
			expect(textOf(blocked)).toBe(
				"Error: claim not found or not visible from this project",
			);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi ctx_memory U4 scenario 5: replay", () => {
	it("replays exact args and rejects key reuse", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const tool = harness(db);
			const args = createArgs("Pi replay claim.");
			const firstResult = await tool.execute(args, "call-replay");
			const firstText = textOf(firstResult);
			const first = parseResult(firstResult).affectedClaims?.[0];
			if (!first) throw new Error("missing Pi replay create result");
			await tool.execute(
				{
					action: "revise",
					publicClaimId: first.publicClaimId,
					mutationToken: first.mutationToken,
					content: "Pi replay state moved later.",
				},
				"call-replay-state-move",
			);
			expect(textOf(await tool.execute(args, "call-replay"))).toBe(firstText);
			const changed = await tool.execute(
				createArgs("Changed Pi args."),
				"call-replay",
			);
			expect(changed.isError).toBeTrue();
			expect(textOf(changed)).toBe(
				"Error: this tool call id was already committed with different arguments. Retry as a new call.",
			);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi ctx_memory U4 scenario 6: privacy/ownership", () => {
	it("makes hidden equal missing and refuses foreign mutation", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const hidden = seedProjectMemoryClaim(db, {
				projectIdentity: PROJECT,
				content: "Pi hidden claim.",
				operationKey: "u4-pi-hidden",
			});
			const hiddenRef = getProjectMemoryClaimByPublicId(
				db,
				hidden.publicClaimId,
			);
			if (!hiddenRef) throw new Error("missing hidden claim");
			db.transaction(() => {
				db.prepare(
					`INSERT INTO claim_disposition_events
						(revision_id, project_id, disposition, action, actor, policy_version, recorded_at)
					 VALUES (?, ?, 'quarantined', 'assert', 'user:test', 1, ?)`,
				).run(hiddenRef.currentRevisionId, hidden.projectId, Date.now());
				db.prepare(
					"UPDATE claim_effective_policy SET hard_hidden = 1, auto_eligible = 0, explicit_eligible = 0 WHERE revision_id = ?",
				).run(hiddenRef.currentRevisionId);
			}).immediate();
			const missingId = `mcm_${"e".repeat(32)}`;
			const tool = harness(db);
			const hiddenGet = parseResult(
				await tool.execute(
					{ action: "get", publicClaimIds: [hidden.publicClaimId] },
					"call-hidden",
				),
			);
			const missingGet = parseResult(
				await tool.execute(
					{ action: "get", publicClaimIds: [missingId] },
					"call-missing",
				),
			);
			expect(hiddenGet.claims).toEqual(missingGet.claims);
			const foreign = seedProjectMemoryClaim(db, {
				projectIdentity: FOREIGN,
				content: "Pi foreign claim.",
				operationKey: "u4-pi-foreign",
			});
			const blocked = await tool.execute(
				{
					action: "archive",
					publicClaimId: foreign.publicClaimId,
					mutationToken: foreign.token,
				},
				"call-foreign-archive",
			);
			expect(blocked.isError).toBeTrue();
			expect(textOf(blocked)).toBe(
				"Error: claim not found or not visible from this project",
			);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi ctx_memory U4 scenario 6b: active project binding", () => {
	it("rejects a mutation retry after the active project changes", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			let activeProject = PROJECT;
			const tool = harness(db, false, () => activeProject);
			const args = createArgs("Project-bound Pi operation.");
			expect(
				(await tool.execute(args, "call-project-bound")).isError,
			).toBeUndefined();
			activeProject = FOREIGN;
			const retry = await tool.execute(args, "call-project-bound");
			expect(retry.isError).toBeTrue();
			expect(textOf(retry)).toContain("different arguments");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi ctx_memory U4 scenario 7: human authority", () => {
	it("rejects agent approve and enforce", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const tool = harness(db);
			const approve = await tool.execute({ action: "approve" }, "call-approve");
			const enforce = await tool.execute({ action: "enforce" }, "call-enforce");
			for (const result of [approve, enforce]) {
				expect(result.isError).toBeTrue();
				expect(textOf(result)).toContain("human-host-owned");
			}
			const unknown = await harness(db, true).execute(
				{ action: "delete" },
				"call-delete",
			);
			expect(unknown.isError).toBeTrue();
			expect(textOf(unknown)).toContain("not allowed");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi ctx_memory imitated reduced arguments carry mutation tokens", () => {
	it("decodes a reduced revise that carries its single token", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const tool = harness(db);
			const created = parseResult(
				await tool.execute(
					createArgs("Pi reduced original."),
					"call-reduced-create",
				),
			);
			const first = created.affectedClaims?.[0];
			if (!first) throw new Error("missing create result");
			const revised = parseResult(
				await tool.execute(
					reduced({
						action: "revise",
						publicClaimId: first.publicClaimId,
						mutationToken: first.mutationToken,
						content: "Pi reduced revised.",
					}),
					"call-reduced-revise",
				),
			);
			expect(revised).toMatchObject({ action: "revise", outcome: "applied" });
			expect(revised.affectedClaims?.[0]?.revisionLocator).toContain("/r2/");
			expect(
				getProjectMemoryClaimByPublicId(db, first.publicClaimId)?.revision,
			).toBe(2);
		} finally {
			closeQuietly(db);
		}
	});

	it("decodes a reduced merge that carries an ordered token array", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const target = seedProjectMemoryClaim(db, {
				projectIdentity: PROJECT,
				content: "Pi reduced merge target.",
				operationKey: "u4-pi-reduced-merge-target",
			});
			const source = seedProjectMemoryClaim(db, {
				projectIdentity: PROJECT,
				content: "Pi reduced merge source.",
				operationKey: "u4-pi-reduced-merge-source",
			});
			const tool = harness(db);
			const merged = parseResult(
				await tool.execute(
					reduced({
						action: "merge",
						mutationTokens: [target.token, source.token],
						content: "Pi reduced merged claim.",
					}),
					"call-reduced-merge",
				),
			);
			expect(
				merged.affectedClaims?.map((claim) => claim.publicClaimId).sort(),
			).toEqual([target.publicClaimId, source.publicClaimId].sort());
			const sourceGet = parseResult(
				await tool.execute(
					{ action: "get", publicClaimIds: [source.publicClaimId] },
					"call-reduced-merge-get",
				),
			);
			expect(sourceGet.claims?.[0]?.lifecycleState).toBe("retired");
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects a malformed reduced token without reaching the mutation path", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const tool = harness(db);
			const created = parseResult(
				await tool.execute(
					createArgs("Pi reduced malformed base."),
					"call-reduced-create",
				),
			);
			const first = created.affectedClaims?.[0];
			if (!first) throw new Error("missing create result");

			for (const [index, badToken] of [
				{
					...first.mutationToken,
					revision: String(first.mutationToken.revision),
				},
				{ ...first.mutationToken, extra: "smuggled" },
				"not-an-object",
			].entries()) {
				const rejected = await tool.execute(
					reduced({
						action: "revise",
						publicClaimId: first.publicClaimId,
						mutationToken: badToken,
						content: "Must not apply.",
					}),
					`call-reduced-bad-${index}`,
				);
				expect(rejected.isError).toBeTrue();
				expect(textOf(rejected)).toContain("not allowed");
			}

			expect(
				getProjectMemoryClaimByPublicId(db, first.publicClaimId)?.revision,
			).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("ctx_memory U4 cross-harness parity", () => {
	it("returns identical canonical reads and authority errors", async () => {
		const db = createClaimReaderTestDatabase();
		try {
			const seeded = seedProjectMemoryClaim(db, {
				projectIdentity: PROJECT,
				content: "Cross-harness claim.",
				operationKey: "u4-cross-harness",
			});
			const openCode = createCtxMemoryTools({
				db,
				resolveProjectPath: () => PROJECT,
			}).ctx_memory;
			const openCodeExecute = (args: Record<string, unknown>, callID: string) =>
				openCode.execute(
					args as never,
					{
						sessionID: "ses-u4-cross-harness",
						directory: "/tmp/u4-cross-harness",
						callID,
						agent: "primary",
					} as never,
				) as Promise<string>;
			const pi = harness(db);
			const args = { action: "get", publicClaimIds: [seeded.publicClaimId] };
			expect(textOf(await pi.execute(args, "call-get-pi"))).toBe(
				await openCodeExecute(args, "call-get-opencode"),
			);
			expect(
				textOf(await pi.execute({ action: "approve" }, "call-approve-pi")),
			).toBe(
				await openCodeExecute({ action: "approve" }, "call-approve-opencode"),
			);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi ctx_memory U4 scenario 8: no legacy active path", () => {
	it("contains no legacy IDs, embeddings, or mutation-log writes", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "ctx-memory.ts"),
			"utf8",
		);
		for (const forbidden of [
			"memory_embeddings",
			"memory_mutation_log",
			"storage-memory-claims",
			'storage-memory"',
			"memoryId",
		]) {
			expect(source).not.toContain(forbidden);
		}
	});
});
