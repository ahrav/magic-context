import { afterEach, describe, expect, it } from "bun:test";
import { clearClaimCommandConfirmationsForTests } from "@magic-context/core/features/magic-context/memory/claim-policy-commands";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { seedProjectMemoryClaim } from "@magic-context/core/features/magic-context/test-claim-database";
import { createDirectTestDatabase } from "@magic-context/core/features/magic-context/test-database";
import type { Database } from "@magic-context/core/shared/sqlite";
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
	const db = createDirectTestDatabase().db;
	db.exec("PRAGMA foreign_keys=ON");
	return db;
}

function seedClaim(db: Database): string {
	return seedProjectMemoryClaim(db, {
		projectIdentity: PROJECT,
		category: "CONSTRAINTS",
		content: "pi approval target",
		importance: 60,
	}).publicClaimId;
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
		const publicClaimId = seedClaim(db);
		const mock = createMockPi();
		registerCtxApproveCommand(mock.pi as never, {
			db,
			projectDir: "/tmp",
			projectIdentity: PROJECT,
		});
		const handler = mock.handlers.get("ctx-approve");
		expect(handler).toBeDefined();
		await handler?.(publicClaimId, ctx);
		await handler?.(publicClaimId, ctx);
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

	it("refuses subagent sessions before any confirmation detail", async () => {
		const db = createDb();
		const publicClaimId = seedClaim(db);
		getOrCreateSessionMeta(db, "ses-pi-sub");
		db.prepare(
			"UPDATE session_meta SET is_subagent = 1 WHERE session_id = 'ses-pi-sub'",
		).run();
		const mock = createMockPi();
		registerCtxApproveCommand(mock.pi as never, {
			db,
			projectDir: "/tmp",
			projectIdentity: PROJECT,
		});
		const handler = mock.handlers.get("ctx-approve");
		await handler?.(publicClaimId, {
			cwd: "/tmp",
			sessionManager: { getSessionId: () => "ses-pi-sub" },
		});
		expect(mock.sent[0]?.data.text).toContain("user-only");
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

	it("rejects targets outside the active project", async () => {
		const db = createDb();
		const publicClaimId = seedClaim(db);
		const mock = createMockPi();
		registerCtxApproveCommand(mock.pi as never, {
			db,
			projectDir: "/tmp",
			projectIdentity: "git:some-other-project",
		});
		const handler = mock.handlers.get("ctx-approve");
		await handler?.(publicClaimId, ctx);
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
