/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
	existsSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { seedProjectMemoryClaim } from "../../plugin/src/features/magic-context/test-claim-database";
import { PiTestHarness } from "../src/pi-harness";
import { openTestDb } from "../src/test-db";

function isMagicContextRequest(body: Record<string, unknown>): boolean {
	return JSON.stringify(body.system ?? "").includes("## Magic Context");
}

function latestSessionFile(h: PiTestHarness): string | null {
	const files: string[] = [];
	const visit = (dir: string): void => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl"))
				files.push(path);
		}
	};
	visit(join(h.env.agentDir, "sessions"));
	visit(h.env.agentDir);
	files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
	return files[0] ?? null;
}

describe("Pi compaction-off mode", () => {
	it("keeps memory injection while native Pi compaction proceeds without MC mutations", async () => {
		const h = await PiTestHarness.create({
			modelContextLimit: 100_000,
			magicContextConfig: {
				compaction: { enabled: false },
				memory: { enabled: true, auto_promote: false },
			},
		});
		try {
			// The first turn creates the isolated context.db. It must complete before
			// the fixture seeds memory used by the following additive-only pass.
			await h.sendPrompt(
				`initialize additive Pi context ${h.ballast(40_000)}`,
				{
					continueSession: true,
					timeoutMs: 120_000,
				},
			);
			const db = openTestDb(h.contextDbPath(), { readwrite: true });
			try {
				seedProjectMemoryClaim(
					db as unknown as Parameters<typeof seedProjectMemoryClaim>[0],
					{
						projectIdentity: resolveProjectIdentity(realpathSync(h.env.workdir)),
						category: "ARCHITECTURE",
						content: "Pi compaction-off memory survives native compaction.",
					},
				);
			} finally {
				db.close();
			}

			const turn = await h.sendPrompt(
				`verify additive Pi context ${h.ballast(40_000)}`,
				{
					continueSession: true,
					timeoutMs: 120_000,
				},
			);
			expect(turn.sessionId).toBeTruthy();
			const sessionId = turn.sessionId!;
			const request = h.mock
				.requests()
				.filter((candidate) => isMagicContextRequest(candidate.body))
				.at(-1);
			expect(JSON.stringify(request?.body.messages ?? [])).toContain(
				"Pi compaction-off memory survives native compaction.",
			);
			expect(h.countTags(sessionId)).toBe(0);
			expect(h.countPendingOps(sessionId)).toBe(0);
			expect(
				(
					h
						.contextDb()
						.prepare(
							"SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?",
						)
						.get(sessionId) as { n: number }
				).n,
			).toBe(0);

			await h.compactNow();
			const file = latestSessionFile(h);
			const entries = file
				? readFileSync(file, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as { type?: string })
				: [];
			expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
			expect(h.countTags(sessionId)).toBe(0);
			expect(h.countPendingOps(sessionId)).toBe(0);
		} finally {
			await h.dispose();
		}
	}, 180_000);
});
