import { describe, expect, it } from "bun:test";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { renderStatusText } from "./status-line";
import { createTestDb, fakeContext } from "./test-utils";

describe("Pi footer status", () => {
	it("reports percentage against the scheduler usable window", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-footer-usable";
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 50_000,
					percent: 50,
					contextWindow: 100_000,
				}),
			};

			const text = renderStatusText(ctx as never, db, sessionId);

			expect(text).toContain("mc: 50K (63%)");
			expect(text).not.toContain("(50%)");
		} finally {
			closeQuietly(db);
		}
	});

	it("preserves valid zero-valued usage fields", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-footer-zero";
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 0,
					percent: 0,
					contextWindow: 100_000,
				}),
			};

			const text = renderStatusText(ctx as never, db, sessionId);

			expect(text).toContain("mc: 0 (0%)");
			expect(text).not.toContain("--");
		} finally {
			closeQuietly(db);
		}
	});
});
