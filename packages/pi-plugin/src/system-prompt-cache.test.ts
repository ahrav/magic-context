/**
 *
 * Stable turns replace date drift with the first-observed date to preserve the prefix cache across midnight.
 * Cache-busting turns update the sticky date to the live date.
 * The first pass initializes the hash without reporting `hashChanged`.
 *     session_meta.
 */

import { describe, expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import { createTestDb } from "./test-utils";

describe("processSystemPromptForCache", () => {
	it("initializes hash on first pass without reporting hashChanged", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-init";
			getOrCreateSessionMeta(db, sessionId);

			const result = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});

			expect(result.hashChanged).toBe(false);
			expect(result.currentHash).toMatch(/^[0-9a-f]{32}$/);

			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.systemPromptHash).toBe(result.currentHash);
			expect(meta.systemPromptTokens).toBeGreaterThan(0);
		} finally {
			clearPiSystemPromptSession("ses-init");
			closeQuietly(db);
		}
	});

	it("freezes the date on subsequent stable turns when not cache-busting", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-freeze";
			getOrCreateSessionMeta(db, sessionId);

			const turn1 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});
			expect(turn1.systemPrompt).toContain("2026-05-01");

			// On a non-cache-busting turn, the function must retain the first-observed date.
			const turn2 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-02",
				isCacheBusting: false,
			});
			expect(turn2.systemPrompt).toContain("2026-05-01");
			expect(turn2.systemPrompt).not.toContain("2026-05-02");
			expect(turn2.hashChanged).toBe(false);
			expect(turn2.currentHash).toBe(turn1.currentHash);
		} finally {
			clearPiSystemPromptSession("ses-freeze");
			closeQuietly(db);
		}
	});

	it("adopts the live date on cache-busting turns and updates the sticky", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-adopt";
			getOrCreateSessionMeta(db, sessionId);

			processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});

			// A cache-busting turn adopts the live date.
			const turn2 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-02",
				isCacheBusting: true,
			});
			expect(turn2.systemPrompt).toContain("2026-05-02");
			expect(turn2.hashChanged).toBe(true);

			// A later non-cache-busting turn retains the date adopted by the cache-busting turn.
			const turn3 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "You are a helpful assistant.\nToday's date: 2026-05-02",
				isCacheBusting: false,
			});
			expect(turn3.systemPrompt).toContain("2026-05-02");
			expect(turn3.hashChanged).toBe(false);
		} finally {
			clearPiSystemPromptSession("ses-adopt");
			closeQuietly(db);
		}
	});

	it("reports hashChanged on real prompt content change", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-content-change";
			getOrCreateSessionMeta(db, sessionId);

			// Turn 1.
			const turn1 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "First prompt.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});
			expect(turn1.hashChanged).toBe(false); // first pass

			const turn2 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt:
					"Second prompt with different content.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});
			expect(turn2.hashChanged).toBe(true);
			expect(turn2.currentHash).not.toBe(turn1.currentHash);

			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.systemPromptHash).toBe(turn2.currentHash);
		} finally {
			clearPiSystemPromptSession("ses-content-change");
			closeQuietly(db);
		}
	});

	it("does NOT report hashChanged when only the date drifted (sticky restores it)", () => {
		// A midnight date flip on an otherwise identical non-cache-busting prompt must not bust the prefix cache.
		const db = createTestDb();
		try {
			const sessionId = "ses-midnight";
			getOrCreateSessionMeta(db, sessionId);

			processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Stable prompt.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});

			// Non-cache-busting turns replace the live date with the first-observed date.
			const turn2 = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Stable prompt.\nToday's date: 2026-05-02",
				isCacheBusting: false,
			});

			expect(turn2.hashChanged).toBe(false);
			expect(turn2.systemPrompt).toContain("2026-05-01");
		} finally {
			clearPiSystemPromptSession("ses-midnight");
			closeQuietly(db);
		}
	});

	it("clearPiSystemPromptSession resets the sticky date", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-clear";
			getOrCreateSessionMeta(db, sessionId);

			processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Prompt.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});

			clearPiSystemPromptSession(sessionId);

			// value.
			const turn = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Prompt.\nToday's date: 2026-06-15",
				isCacheBusting: false,
			});
			expect(turn.systemPrompt).toContain("2026-06-15");
		} finally {
			clearPiSystemPromptSession("ses-clear");
			closeQuietly(db);
		}
	});

	it("treats previousHash='' / '0' as first-pass (no spurious hashChanged)", () => {
		// The first pass stores a computed hash without reporting `hashChanged`.
		// The first pass does not report `hashChanged`.
		const db = createTestDb();
		try {
			const sessionId = "ses-zero-hash";
			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, { systemPromptHash: "0" });

			const result = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Prompt.\nToday's date: 2026-05-01",
				isCacheBusting: false,
			});

			expect(result.hashChanged).toBe(false);
			expect(result.currentHash).toMatch(/^[0-9a-f]{32}$/);
			expect(result.currentHash).not.toBe("0");
		} finally {
			clearPiSystemPromptSession("ses-zero-hash");
			closeQuietly(db);
		}
	});
});
