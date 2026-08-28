import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearClaimCommandConfirmationsForTests } from "@magic-context/core/features/magic-context/memory/claim-policy-commands";
import { seedProjectMemoryClaim } from "@magic-context/core/features/magic-context/test-claim-database";
import { createDirectTestDatabase } from "@magic-context/core/features/magic-context/test-database";
import { registerCtxApproveCommand } from "./ctx-approve";
import { registerCtxEnforceCommand } from "./ctx-enforce";

type Handler = (args: string, ctx: MockCommandContext) => Promise<void>;

interface AppendedEntry {
	customType: string;
	data: { title: string; text: string; level?: string };
}

interface MockCommandContext {
	cwd: string;
	sessionManager: { getSessionId: () => string | undefined };
}

const PROJECT = "git:pi-enforce";

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

const ctx: MockCommandContext = {
	cwd: "/tmp",
	sessionManager: { getSessionId: () => "ses-pi-enf" },
};

afterEach(() => {
	clearClaimCommandConfirmationsForTests();
});

describe("/ctx-enforce (pi)", () => {
	it("requires approval first and refuses unapproved revisions", async () => {
		const db = createDirectTestDatabase().db;
		db.exec("PRAGMA foreign_keys=ON");
		const projectDir = mkdtempSync(join(tmpdir(), "pi-enforce-"));
		try {
			const publicClaimId = seedProjectMemoryClaim(db, {
				projectIdentity: PROJECT,
				category: "CONSTRAINTS",
				content: "pi enforcement target",
				importance: 60,
			}).publicClaimId;
			writeFileSync(join(projectDir, "gate.test.ts"), "bytes");
			const mock = createMockPi();
			registerCtxApproveCommand(mock.pi as never, {
				db,
				projectDir,
				projectIdentity: PROJECT,
			});
			registerCtxEnforceCommand(mock.pi as never, {
				db,
				projectDir,
				projectIdentity: PROJECT,
			});
			const enforce = mock.handlers.get("ctx-enforce");
			await enforce?.(`${publicClaimId} gate.test.ts`, ctx);
			expect(mock.sent.at(-1)?.data.text).toContain("not approved");

			const approve = mock.handlers.get("ctx-approve");
			await approve?.(publicClaimId, ctx);
			await approve?.(publicClaimId, ctx);
			await enforce?.(`${publicClaimId} gate.test.ts`, ctx);
			expect(mock.sent.at(-1)?.data.text).toContain("Confirmation Required");
			expect(
				(
					db
						.prepare(
							"SELECT COUNT(*) AS count FROM claim_enforcement_artifacts",
						)
						.get() as { count: number }
				).count,
			).toBe(0);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
			db.close();
		}
	});
});
