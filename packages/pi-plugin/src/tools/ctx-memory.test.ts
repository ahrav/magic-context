import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToolStateText } from "@magic-context/core/shared/kernel-client";
import { FakeKernel } from "@magic-context/core/shared/kernel-client-testing/fake-kernel";
import {
	MEMORY_STATE_TABLE,
	stubKernelClient,
} from "@magic-context/core/shared/kernel-client-testing/state-table";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createCtxMemoryTools } from "@magic-context/core/tools/ctx-memory/tools";
import { createTestDb, fakeKernelResolver } from "../test-utils";
import { createCtxMemoryTool } from "./ctx-memory";

const PROJECT = "git:kernel-pi";
const CWD = "/tmp/kernel-pi";
const SESSION = "ses-kernel-pi";

interface CommitJson {
	action: string;
	outcome: string;
	commitSeq: number;
	knownAsOf: number;
	objects: string[];
}

interface ReadJson {
	action: string;
	knownAsOf: number;
	memories: Array<{ objectId: string; category: string; content: string }>;
	missingObjectIds?: string[];
}

function harness(
	kernel = new FakeKernel(),
	options: {
		allowDreamerActions?: boolean;
		kernelClient?: ReturnType<typeof fakeKernelResolver>["kernelClient"];
	} = {},
) {
	const db = createTestDb();
	const fake = fakeKernelResolver(kernel);
	const tool = createCtxMemoryTool({
		db,
		kernelClient: options.kernelClient ?? fake.kernelClient,
		resolveProjectIdentity: () => PROJECT,
		allowDreamerActions: options.allowDreamerActions ?? false,
	});
	const execute = async (args: Record<string, unknown>, callId: string) =>
		tool.execute(
			callId,
			args as never,
			new AbortController().signal,
			undefined,
			{
				cwd: CWD,
				sessionManager: { getSessionId: () => SESSION },
			} as never,
		);
	return { db, tool, execute, ...fake, close: () => closeQuietly(db) };
}

type ExecuteResult = Awaited<ReturnType<ReturnType<typeof harness>["execute"]>>;

function textOf(result: ExecuteResult): string {
	return result.content[0]?.text ?? "";
}

function parseResult<T>(result: ExecuteResult): T {
	expect(result.isError).toBeUndefined();
	return JSON.parse(textOf(result)) as T;
}

function createArgs(content: string) {
	return { action: "create", category: "ARCHITECTURE", content };
}

function reduced(inner: Record<string, unknown>) {
	return { reduced: true, summary: JSON.stringify(inner) };
}

describe("Pi ctx_memory create", () => {
	it("returns a commit receipt and stores the decision in the kernel", async () => {
		const tool = harness();
		try {
			const created = parseResult<CommitJson>(
				await tool.execute(createArgs("Pi uses the kernel."), "call-create"),
			);
			expect(created).toMatchObject({
				action: "create",
				outcome: "applied",
				commitSeq: 1,
			});
			expect(created.objects).toHaveLength(1);
			const objectId = created.objects[0] as string;
			expect(objectId).toMatch(/^mem_[0-9a-f]{32}$/);
			expect(tool.kernel.objects.get(objectId)?.decision).toEqual({
				decision_kind: "ARCHITECTURE",
				payload: { summary: "Pi uses the kernel.", rationale: "" },
			});
			const commit = tool.transport.calls[0]?.body as {
				intent: { actor: string };
			};
			expect(commit.intent.actor).toBe("agent:pi");
		} finally {
			tool.close();
		}
	});

	it("replays a duplicate call and creates no second object", async () => {
		const tool = harness();
		try {
			const args = createArgs("Replay exact bytes.");
			const first = parseResult<CommitJson>(
				await tool.execute(args, "call-replay"),
			);
			const second = parseResult<CommitJson>(
				await tool.execute(args, "call-replay"),
			);
			expect(second).toMatchObject({
				outcome: "already applied",
				objects: first.objects,
			});
			expect(tool.kernel.liveRows()).toHaveLength(1);
		} finally {
			tool.close();
		}
	});

	it("an aborted tool call answers cancelled without committing", async () => {
		const tool = harness();
		try {
			const controller = new AbortController();
			controller.abort();
			const result = await tool.tool.execute(
				"call-abort",
				createArgs("never lands") as never,
				controller.signal,
				undefined,
				{
					cwd: CWD,
					sessionManager: { getSessionId: () => SESSION },
				} as never,
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toBe(
				"Error: The memory request was cancelled before it completed.",
			);
			expect(tool.kernel.objects.size).toBe(0);
		} finally {
			tool.close();
		}
	});
});

describe("Pi ctx_memory revise", () => {
	it("revises by object id through the cached token and supersedes the target", async () => {
		const tool = harness();
		try {
			const created = parseResult<CommitJson>(
				await tool.execute(createArgs("Pi uses the kernel."), "call-create"),
			);
			const objectId = created.objects[0] as string;
			const revised = parseResult<CommitJson>(
				await tool.execute(
					{ action: "revise", objectId, content: "Pi uses the kernel routes." },
					"call-revise",
				),
			);
			expect(revised.outcome).toBe("applied");
			const survivor = revised.objects.find((id) => id !== objectId) as string;
			expect(tool.kernel.objects.get(objectId)?.superseded_by).toBe(survivor);
			expect(
				tool.kernel.objects.get(survivor)?.decision?.payload.summary,
			).toBe("Pi uses the kernel routes.");
			expect(tool.transport.methods()).toEqual([
				"kernel.commit",
				"kernel.read",
				"kernel.commit",
			]);
		} finally {
			tool.close();
		}
	});

	it("renders the same conflict text as OpenCode after a concurrent change", async () => {
		const kernel = new FakeKernel();
		kernel.seedDecision({
			object_id: "mem_seeded",
			decision_kind: "CONSTRAINTS",
			summary: "Seeded.",
		});
		const pi = harness(kernel);
		try {
			parseResult<ReadJson>(
				await pi.execute(
					{ action: "get", objectIds: ["mem_seeded"] },
					"call-get",
				),
			);
			kernel.beforeCommit = () => kernel.touch("mem_seeded");
			const piResult = await pi.execute(
				{ action: "revise", objectId: "mem_seeded", content: "Moved." },
				"call-revise-conflict",
			);
			expect(piResult.isError).toBe(true);
			const conflictText = renderToolStateText({
				kind: "conflict",
				reason: "known_as_of_advanced",
			});
			expect(textOf(piResult)).toBe(
				`Error: ${conflictText} Re-read mem_seeded with ctx_memory get, then retry.`,
			);

			const openCodeKernel = new FakeKernel();
			openCodeKernel.seedDecision({
				object_id: "mem_seeded",
				decision_kind: "CONSTRAINTS",
				summary: "Seeded.",
			});
			const openCodeFake = fakeKernelResolver(openCodeKernel);
			const openCode = createCtxMemoryTools({
				kernelClient: openCodeFake.kernelClient,
				resolveProjectPath: () => PROJECT,
			}).ctx_memory;
			const openCodeExecute = (
				args: Record<string, unknown>,
				callID: string,
			) =>
				openCode.execute(
					args as never,
					{
						sessionID: SESSION,
						directory: CWD,
						callID,
						agent: "primary",
					} as never,
				) as Promise<string>;
			await openCodeExecute(
				{ action: "get", objectIds: ["mem_seeded"] },
				"call-get",
			);
			openCodeKernel.beforeCommit = () => openCodeKernel.touch("mem_seeded");
			expect(
				await openCodeExecute(
					{ action: "revise", objectId: "mem_seeded", content: "Moved." },
					"call-revise-conflict",
				),
			).toBe(textOf(piResult));
		} finally {
			pi.close();
		}
	});
});

describe("Pi ctx_memory reads and role gates", () => {
	it("reads by object id, reports missing ids, and gates list behind dreamer actions", async () => {
		const kernel = new FakeKernel();
		kernel.seedDecision({
			object_id: "mem_a",
			decision_kind: "NAMING",
			summary: "A.",
		});
		const primary = harness(kernel);
		const dreamer = harness(kernel, { allowDreamerActions: true });
		try {
			const read = parseResult<ReadJson>(
				await primary.execute(
					{ action: "get", objectIds: ["mem_a", "mem_missing"] },
					"call-get",
				),
			);
			expect(read.memories.map((memory) => memory.objectId)).toEqual(["mem_a"]);
			expect(read.missingObjectIds).toEqual(["mem_missing"]);

			const denied = await primary.execute({ action: "list" }, "call-list");
			expect(denied.isError).toBe(true);
			expect(textOf(denied)).toContain("not allowed");

			const listed = parseResult<ReadJson>(
				await dreamer.execute({ action: "list" }, "call-list"),
			);
			expect(listed.memories.map((memory) => memory.objectId)).toEqual(["mem_a"]);
		} finally {
			primary.close();
			dreamer.close();
		}
	});

	it("rejects agent approve and enforce", async () => {
		const tool = harness();
		try {
			for (const action of ["approve", "enforce"]) {
				const result = await tool.execute({ action }, `call-${action}`);
				expect(result.isError).toBe(true);
				expect(textOf(result)).toBe(
					"Error: approve and enforce are human-host-owned commands, not agent actions.",
				);
			}
			expect(tool.transport.calls).toHaveLength(0);
		} finally {
			tool.close();
		}
	});
});

describe("Pi ctx_memory imitated reduced arguments", () => {
	it("decodes a reduced revise that names its object id", async () => {
		const kernel = new FakeKernel();
		kernel.seedDecision({
			object_id: "mem_reduced",
			decision_kind: "NAMING",
			summary: "Before.",
		});
		const tool = harness(kernel);
		try {
			const revised = parseResult<CommitJson>(
				await tool.execute(
					reduced({
						action: "revise",
						objectId: "mem_reduced",
						content: "After.",
					}),
					"call-reduced-revise",
				),
			);
			expect(revised.outcome).toBe("applied");
			expect(tool.kernel.objects.get("mem_reduced")?.superseded_by).toBeString();
		} finally {
			tool.close();
		}
	});

	it("decodes a reduced merge that names its object ids", async () => {
		const kernel = new FakeKernel();
		kernel.seedDecision({ object_id: "mem_x", decision_kind: "NAMING", summary: "X." });
		kernel.seedDecision({ object_id: "mem_y", decision_kind: "NAMING", summary: "Y." });
		const tool = harness(kernel);
		try {
			const merged = parseResult<CommitJson>(
				await tool.execute(
					reduced({
						action: "merge",
						objectIds: ["mem_x", "mem_y"],
						content: "XY.",
					}),
					"call-reduced-merge",
				),
			);
			expect(merged.outcome).toBe("applied");
			expect(tool.kernel.objects.get("mem_x")?.superseded_by).toBe(
				tool.kernel.objects.get("mem_y")?.superseded_by ?? "",
			);
		} finally {
			tool.close();
		}
	});
});

describe("Pi ctx_memory memory state table", () => {
	it.each(MEMORY_STATE_TABLE)(
		"a stubbed client answering %s drives the tool text",
		async (_key, state) => {
			const tool = harness(new FakeKernel(), {
				allowDreamerActions: true,
				kernelClient: () => stubKernelClient(state),
			});
			try {
				const result = await tool.execute({ action: "list" }, "call-list");
				if (state.kind === "available") {
					expect(parseResult<ReadJson>(result)).toMatchObject({
						action: "list",
						memories: [],
					});
				} else {
					expect(result.isError).toBe(true);
					expect(textOf(result)).toBe(`Error: ${renderToolStateText(state)}`);
				}
			} finally {
				tool.close();
			}
		},
	);
});

describe("Pi ctx_memory source", () => {
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
			"publicClaimId",
			"mutationToken",
		]) {
			expect(source).not.toContain(forbidden);
		}
	});
});
