/**
 *
 *
 * tagTranscript persists pre-§N§ text for text parts in source_contents.
 */
import { describe, expect, it } from "bun:test";
import { getSourceContents } from "@magic-context/core/features/magic-context/storage-source";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { assistantMessage, createTestDb, userMessage } from "./test-utils";
import { createPiTranscript } from "./transcript-pi";

describe("tagTranscript source_contents persistence", () => {
	it("persists original text content for text parts so caveman has source to compress from", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-source-contents";
			const messages = [
				userMessage("Original user prompt about distributed systems", 1),
				assistantMessage(
					"Here is a long assistant explanation that should be persisted as source content.",
					2,
				),
				userMessage("Follow up question with specific details", 3),
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);

			expect(targets.size).toBe(3);

			const tagNumbers = Array.from(targets.keys());
			const persisted = getSourceContents(db, sessionId, tagNumbers);

			expect(persisted.size).toBe(3);

			// tagTranscript persists unprefixed source content because Caveman compresses pristine content.
			const allContent = Array.from(persisted.values());
			expect(allContent).toContain(
				"Original user prompt about distributed systems",
			);
			expect(allContent).toContain(
				"Here is a long assistant explanation that should be persisted as source content.",
			);
			expect(allContent).toContain("Follow up question with specific details");

			for (const content of allContent) {
				expect((content as string).startsWith("\u00a7")).toBe(false);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("strips any pre-existing §N§ prefix before persisting source content", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-prefix-strip";
			const messages = [
				userMessage("\u00a742\u00a7 stale prefix from earlier tagging", 1),
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);

			expect(targets.size).toBe(1);
			const tagNumbers = Array.from(targets.keys());
			const persisted = getSourceContents(db, sessionId, tagNumbers);

			const contentValues = Array.from(persisted.values());
			expect(contentValues.length).toBe(1);
			expect(contentValues[0]).toBe("stale prefix from earlier tagging");
		} finally {
			closeQuietly(db);
		}
	});

	it("uses INSERT OR IGNORE — first-write-wins on repeated tag passes", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-idempotent";
			const messages = [userMessage("original message", 1)];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);

			const transcript1 = createPiTranscript(messages, sessionId);
			tagTranscript(sessionId, transcript1, tagger, db);

			// saveSourceContent uses INSERT OR IGNORE to preserve the first value on repeated tag passes.
			const messages2 = [userMessage("\u00a71\u00a7 original message", 2)];
			const transcript2 = createPiTranscript(messages2, sessionId);
			tagTranscript(sessionId, transcript2, tagger, db);

			const persisted = getSourceContents(db, sessionId, [1]);
			expect(persisted.get(1)).toBe("original message");
		} finally {
			closeQuietly(db);
		}
	});
});
