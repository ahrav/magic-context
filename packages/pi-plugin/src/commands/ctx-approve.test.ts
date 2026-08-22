import { afterEach, describe, expect, it } from "bun:test";
import { clearClaimCommandConfirmationsForTests } from "@magic-context/core/features/magic-context/memory/claim-policy-commands";
import { sha256Utf8Hex } from "@magic-context/core/features/magic-context/memory/storage-claims";
import {
	createMemoryWithClaimsInCurrentTransaction,
	runInMemoryClaimsWriteTransaction,
} from "@magic-context/core/features/magic-context/memory/storage-memory-claims";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { registerCtxApproveCommand } from "./ctx-approve";

type Handler = (args: string, ctx: MockCommandContext) => Promise<void>;

interface AppendedEntry {
	customType: string;
	data: { title: string; text: string; level?: string };
}

interface MockCommandContext {
	cwd: string;
	sessionManager: { getSessionId: () => string | undefined };
}

const PROJECT = "git:pi-approve";

function createMockPi() {
	const handlers = new Map<string, Handler>();
	const sent: AppendedEntry[] = [];
	return {
		pi: {
			registerCommand(name: string, options: { handler: Handler }) {
				handlers.set(name, options.handler);
			},
			registerEntryRenderer() {},
			appendEntry(customType: string, data: AppendedEntry["data"]) {
				sent.push({ customType, data });
			},
		},
		handlers,
		sent,
	};
}

function createDb() {
	const db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	initializeDatabase(db);
	runMigrations(db);
	return db;
}

function seedMemory(db: Database): number {
	const outcome = runInMemoryClaimsWriteTransaction(db, () =>
		createMemoryWithClaimsInCurrentTransaction(
			db,
			{
				producer: "pi-approve-test",
				operationKey: "seed-1",
				requestDigest: sha256Utf8Hex("seed-1"),
			},
			{
				projectPath: PROJECT,
				category: "CONSTRAINTS",
				content: "pi approval target",
				normalizedHash: "hash:pi approval target",
				importance: 60,
				sourceSessionId: "ses-pi",
				sourceType: "agent",
				nowMs: 1_000,
			},
		),
	);
	return outcome.result.memoryId;
}

const ctx: MockCommandContext = {
	cwd: "/tmp",
	sessionManager: { getSessionId: () => "ses-pi" },
};

afterEach(() => {
	clearClaimCommandConfirmationsForTests();
});

describe("/ctx-approve (pi)", () => {
	it("confirms first, records one approval on repeat, and matches OpenCode rows", async () => {
		const db = createDb();
		const memoryId = seedMemory(db);
		const mock = createMockPi();
		registerCtxApproveCommand(mock.pi as never, {
			db,
			projectDir: "/tmp",
			projectIdentity: PROJECT,
		});
		const handler = mock.handlers.get("ctx-approve");
		expect(handler).toBeDefined();
		await handler?.(String(memoryId), ctx);
		await handler?.(String(memoryId), ctx);
		expect(mock.sent[0]?.data.text).toContain("Confirmation Required");
		expect(mock.sent[1]?.data.text).toContain("Recorded");
		const row = db
			.prepare(
				"SELECT host, action, source_session_id AS sessionId FROM claim_approval_actions",
			)
			.get() as { host: string; action: string; sessionId: string };
		expect(row).toEqual({ host: "pi", action: "approve", sessionId: "ses-pi" });
		db.close();
	});

	it("rejects targets outside the active project", async () => {
		const db = createDb();
		const memoryId = seedMemory(db);
		const mock = createMockPi();
		registerCtxApproveCommand(mock.pi as never, {
			db,
			projectDir: "/tmp",
			projectIdentity: "git:some-other-project",
		});
		const handler = mock.handlers.get("ctx-approve");
		await handler?.(String(memoryId), ctx);
		expect(mock.sent[0]?.data.level).toBe("error");
		expect(
			(
				db
					.prepare("SELECT COUNT(*) AS count FROM claim_approval_actions")
					.get() as {
					count: number;
				}
			).count,
		).toBe(0);
		db.close();
	});
});
