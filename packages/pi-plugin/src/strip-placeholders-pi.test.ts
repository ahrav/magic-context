import { describe, expect, it } from "bun:test";
import { getStrippedPlaceholderIds } from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { stripPiDroppedPlaceholderMessages } from "./strip-placeholders-pi";
import { assistantMessage, createTestDb, userMessage } from "./test-utils";

describe("stripPiDroppedPlaceholderMessages", () => {
	it("discovers and removes ONLY assistant placeholder-only messages, never user-role", () => {
		const db = createTestDb();
		try {
			// A user message reduced to only [dropped §N§] must NOT be removed:
			const messages = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
				userMessage([{ type: "text", text: "[dropped §3§]" }], 3),
				assistantMessage("real answer", 4),
			];

			const result = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages,
				isCacheBusting: true,
			});

			expect(result).toEqual({ removed: 1, discovered: 1 });
			expect(messages.map((m) => (m as { role: string }).role)).toEqual([
				"user",
				"user",
				"assistant",
			]);
			expect(
				(messages[1] as { content: { text: string }[] }).content[0].text,
			).toBe("[dropped §3§]");
			expect(getStrippedPlaceholderIds(db, "ses-placeholders").size).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not recognize the stripped-image marker as a dropped sentinel", () => {
		const db = createTestDb();
		try {
			const marker = assistantMessage("[image stripped]", 2);
			const messages = [userMessage("keep", 1), marker];
			const result = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-image-marker",
				messages,
				isCacheBusting: true,
			});

			expect(result).toEqual({ removed: 0, discovered: 0 });
			expect(messages).toContain(marker);
		} finally {
			closeQuietly(db);
		}
	});

	it("replays persisted stripping on defer passes without discovering new ids", () => {
		const db = createTestDb();
		try {
			const first = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
			];
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages: first,
				isCacheBusting: true,
			});

			const replay = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
				assistantMessage("[dropped §3§]", 3),
			];
			const result = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages: replay,
				isCacheBusting: false,
			});

			expect(result).toEqual({ removed: 1, discovered: 0 });
			expect(replay).toHaveLength(2);
		} finally {
			closeQuietly(db);
		}
	});

	it("leaves newly discovered placeholders in place when durable CAS persistence fails", () => {
		const db = createTestDb();
		try {
			const runPass = () => {
				const placeholder = assistantMessage("[dropped §2§]", 2);
				const messages = [userMessage("keep", 1), placeholder];
				const stableIdByRef = new Map<object, string>([
					[messages[0] as object, "entry-keep"],
					[placeholder as object, "entry-placeholder"],
				]);
				const result = stripPiDroppedPlaceholderMessages({
					db,
					sessionId: "ses-cas-failure",
					messages,
					isCacheBusting: true,
					stableIdByRef,
					applyDelta: () => false,
				});
				return { result, wire: JSON.stringify(messages) };
			};

			const first = runPass();
			const second = runPass();
			expect(first.result).toEqual({ removed: 0, discovered: 0 });
			expect(second.wire).toBe(first.wire);
			expect(getStrippedPlaceholderIds(db, "ses-cas-failure").size).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("prunes below-boundary ids from the persisted set on cache-busting passes", () => {
		const db = createTestDb();
		try {
			const phA = assistantMessage("[dropped §2§]", 2);
			const phB = assistantMessage("[dropped §3§]", 3);
			const pass1 = [userMessage("keep", 1), phA, phB];
			const map1 = new Map<object, string>([
				[pass1[0] as object, "entry-keep"],
				[phA as object, "entry-A"],
				[phB as object, "entry-B"],
			]);
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-prune",
				messages: pass1,
				isCacheBusting: true,
				stableIdByRef: map1,
			});
			expect(getStrippedPlaceholderIds(db, "ses-prune").size).toBe(2);

			// Cache-busting passes prune persisted IDs absent from the current window.
			const phB2 = assistantMessage("[dropped §3§]", 3);
			const pass2 = [userMessage("keep", 1), phB2];
			const map2 = new Map<object, string>([
				[pass2[0] as object, "entry-keep"],
				[phB2 as object, "entry-B"],
			]);
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-prune",
				messages: pass2,
				isCacheBusting: true,
				stableIdByRef: map2,
			});
			const remaining = getStrippedPlaceholderIds(db, "ses-prune");
			expect(remaining.has("entry-B")).toBe(true);
			expect(remaining.has("entry-A")).toBe(false); // pruned below-boundary
			expect(remaining.size).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("does NOT prune on defer passes (storage-only GC gated to cache-busting)", () => {
		const db = createTestDb();
		try {
			const phA = assistantMessage("[dropped §2§]", 2);
			const pass1 = [userMessage("keep", 1), phA];
			const map1 = new Map<object, string>([
				[pass1[0] as object, "entry-keep"],
				[phA as object, "entry-A"],
			]);
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-defer-noprune",
				messages: pass1,
				isCacheBusting: true,
				stableIdByRef: map1,
			});
			expect(
				getStrippedPlaceholderIds(db, "ses-defer-noprune").has("entry-A"),
			).toBe(true);

			// Defer passes do not mutate persisted replay state.
			// Defer passes do not mutate persisted replay state.
			const pass2 = [userMessage("keep", 1)];
			const map2 = new Map<object, string>([
				[pass2[0] as object, "entry-keep"],
			]);
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-defer-noprune",
				messages: pass2,
				isCacheBusting: false,
				stableIdByRef: map2,
			});
			expect(
				getStrippedPlaceholderIds(db, "ses-defer-noprune").has("entry-A"),
			).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses the carried-id map by object-ref and survives an index shift", () => {
		const db = createTestDb();
		try {
			const placeholder = assistantMessage("[dropped §9§]", 2);
			const pass1 = [userMessage("keep", 1), placeholder];
			const map1 = new Map<object, string>([
				[pass1[0] as object, "entry-keep"],
				[placeholder as object, "entry-PH"],
			]);
			const r1 = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-carry",
				messages: pass1,
				isCacheBusting: true,
				stableIdByRef: map1,
			});
			expect(r1).toEqual({ removed: 1, discovered: 1 });
			// The stripper persists the stable entry ID instead of a `pi-msg-*` ID.
			expect(getStrippedPlaceholderIds(db, "ses-carry").has("entry-PH")).toBe(
				true,
			);

			// Removal uses object identity, so index shifts do not affect mapped placeholders.
			// Removal uses object identity to strip mapped placeholder messages and skip unmapped prepended messages.
			const syntheticPrepend = userMessage("<session-history>…", 0);
			const pass2 = [
				syntheticPrepend,
				userMessage("newer", 3),
				userMessage("keep", 1),
				placeholder,
			];
			const map2 = new Map<object, string>([
				[pass2[1] as object, "entry-newer"],
				[pass2[2] as object, "entry-keep"],
				[placeholder as object, "entry-PH"],
			]);
			const r2 = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-carry",
				messages: pass2,
				isCacheBusting: false,
				stableIdByRef: map2,
			});
			expect(r2.removed).toBe(1); // only the placeholder
			expect(pass2).not.toContain(placeholder);
			expect(pass2).toContain(syntheticPrepend); // unmapped → never stripped
		} finally {
			closeQuietly(db);
		}
	});
});
