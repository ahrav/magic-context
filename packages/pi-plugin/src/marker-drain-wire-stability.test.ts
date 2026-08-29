import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	setPendingPiCompactionMarkerState,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
} from "./context-handler";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	toolResultMessage,
	userMessage,
} from "./test-utils";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function wireBytes(messages: readonly unknown[]): number {
	return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const row = message as { content?: unknown; summary?: unknown };
	if (typeof row.summary === "string") return row.summary;
	if (typeof row.content === "string") return row.content;
	if (!Array.isArray(row.content)) return "";
	return row.content
		.map((part) =>
			part &&
			typeof part === "object" &&
			typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("");
}

function classifyMessage(message: unknown): string {
	if (!message || typeof message !== "object") return "unknown";
	const row = message as { role?: unknown };
	const text = messageText(message);
	if (text.includes("<session-history>")) return "m0";
	if (text.includes("<session-history-since>")) return "m1";
	if (row.role === "compactionSummary") return "synth-user compaction entry";
	if (text.includes("<!-- +")) return "temporal gap marker/raw history";
	return typeof row.role === "string" ? `raw ${row.role}` : "unknown";
}

function physicalContext(
	sessionManager: SessionManager,
	contextTokens: number,
): Record<string, unknown> {
	return {
		cwd: process.cwd(),
		hasUI: false,
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			contextWindow: 100_000,
		},
		sessionManager,
		getContextUsage: () => ({
			tokens: contextTokens,
			percent: contextTokens / 1_000,
			contextWindow: 100_000,
		}),
	};
}

function entryIdAt(entryIds: readonly string[], index: number): string {
	const entryId = entryIds[index];
	if (!entryId) throw new Error(`missing fixture entry ${index}`);
	return entryId;
}

function appendFixtureMessages(sessionManager: SessionManager): string[] {
	const ids: string[] = [];
	const baseTimestamp = Date.UTC(2026, 0, 1);
	for (let ordinal = 1; ordinal <= 320; ordinal += 1) {
		const timestamp = baseTimestamp + ordinal * 10 * 60_000;
		let message: unknown;
		if (ordinal >= 256 && ordinal <= 277) {
			const toolIndex = Math.floor((ordinal - 256) / 2) + 1;
			message =
				ordinal % 2 === 0
					? assistantToolCall(
							`call-${toolIndex}`,
							"Read",
							{ path: `/tmp/${toolIndex}` },
							timestamp,
						)
					: toolResultMessage(
							`call-${toolIndex}`,
							`covered tool payload ${toolIndex} ${"x".repeat(900)}`,
							timestamp,
						);
		} else if (ordinal === 308) {
			message = userMessage(
				`first kept user ${ordinal} ${"k".repeat(420)}`,
				timestamp,
			);
		} else if (ordinal % 2 === 0) {
			message = assistantMessage(
				`assistant raw history ${ordinal} ${"a".repeat(420)}`,
				timestamp,
			);
		} else {
			message = userMessage(
				`user raw history ${ordinal} ${"u".repeat(420)}`,
				timestamp,
			);
		}
		ids.push(sessionManager.appendMessage(message as never));
	}
	return ids;
}

describe("Pi marker-drain wire stability", () => {
	it("lands the marker projection in the same pass as deferred publication", async () => {
		const sessionDir = join(
			tmpdir(),
			`mc-pi-marker-wire-${crypto.randomUUID()}`,
		);
		tempDirs.push(sessionDir);
		const sessionId = "ses-pi-marker-wire-two-bust";
		const sessionManager = SessionManager.create(process.cwd(), sessionDir, {
			id: sessionId,
		});
		const entryIds = appendFixtureMessages(sessionManager);
		const db = createTestDb();
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 255,
					startMessageId: entryIdAt(entryIds, 0),
					endMessageId: entryIdAt(entryIds, 254),
					title: "Existing baseline",
					content: "History already folded into m0.",
				},
			]);
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });

			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				protectedTags: 0,
				scheduler: { executeThresholdPercentage: 65 },
				injection: {
					injectionBudgetTokens: 10_000,
					temporalAwareness: true,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: unknown[] },
				ctx: unknown,
			) => Promise<{ messages: unknown[] }>;

			const baselineInput = structuredClone(
				sessionManager.buildSessionContext().messages,
			) as unknown[];
			const baseline = await handler(
				{ messages: baselineInput },
				physicalContext(sessionManager, 10_000) as never,
			);
			expect(messageText(baseline.messages[1]).length).toBeLessThan(200);

			const toolTags = getTagsBySession(db, sessionId).filter(
				(tag) => tag.type === "tool",
			);
			expect(toolTags.length).toBeGreaterThanOrEqual(11);
			const selectedToolTags = toolTags.slice(0, 11);
			for (const tag of selectedToolTags) {
				queuePendingOp(db, sessionId, tag.tagNumber, "drop", Date.now());
			}
			expect(getPendingOps(db, sessionId)).toHaveLength(11);

			appendCompartments(db, sessionId, [
				{
					sequence: 1,
					startMessage: 256,
					endMessage: 307,
					startMessageId: entryIdAt(entryIds, 255),
					endMessageId: entryIdAt(entryIds, 306),
					title: "New publication",
					content: `Newly published history ${"c".repeat(2_450)}`,
				},
			]);
			setPendingPiCompactionMarkerState(db, sessionId, {
				firstKeptEntryId: entryIdAt(entryIds, 307),
				endMessageId: entryIdAt(entryIds, 306),
				ordinal: 307,
				tokensBefore: 20_000,
				summary: "Magic Context marker projection",
				publishedAt: Date.now(),
			});
			signalPiDeferredHistoryRefresh(sessionId);
			signalPiDeferredMaterialization(sessionId);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 70,
				lastInputTokens: 70_000,
			});

			const pass1Input = structuredClone(
				sessionManager.buildSessionContext().messages,
			) as unknown[];
			const pass1 = await handler(
				{ messages: pass1Input },
				physicalContext(sessionManager, 70_000) as never,
			);
			expect(getPendingOps(db, sessionId)).toHaveLength(0);
			const droppedTagNumbers = new Set(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.status === "dropped")
					.map((tag) => tag.tagNumber),
			);
			expect(
				selectedToolTags.every((tag) => droppedTagNumbers.has(tag.tagNumber)),
			).toBe(true);
			expect(pass1.messages).toHaveLength(15);
			expect(messageText(pass1.messages[1]).length).toBeGreaterThan(2_400);

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("expected persisted Pi session file");
			const physicalEntries = readFileSync(sessionFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const physicalCompactions = physicalEntries.filter(
				(entry) => entry.type === "compaction",
			);
			expect(physicalCompactions).toHaveLength(1);
			expect(physicalCompactions[0]).toMatchObject({
				firstKeptEntryId: entryIdAt(entryIds, 307),
				fromHook: true,
				details: {
					source: "magic-context",
					lastCompactedOrdinal: 307,
				},
			});

			const newTurnId = sessionManager.appendMessage(
				userMessage(
					"legitimate next-turn tail growth",
					Date.UTC(2026, 0, 5),
				) as never,
			);
			updateSessionMeta(db, sessionId, {
				lastContextPercentage: 10,
				lastInputTokens: 10_000,
			});
			const pass2Input = structuredClone(
				sessionManager.buildSessionContext().messages,
			) as unknown[];
			const pass2 = await handler(
				{ messages: pass2Input },
				physicalContext(sessionManager, 10_000) as never,
			);

			const pass2Stable = pass2.messages.slice(0, -1);
			const differences = Array.from(
				{ length: Math.max(pass1.messages.length, pass2Stable.length) },
				(_, index) => ({
					index,
					pass1: classifyMessage(pass1.messages[index]),
					pass2: classifyMessage(pass2Stable[index]),
					identical:
						JSON.stringify(pass1.messages[index]) ===
						JSON.stringify(pass2Stable[index]),
				}),
			).filter((difference) => !difference.identical);

			expect(sessionManager.getEntry(newTurnId)).toBeDefined();
			expect(pass2.messages.length).toBe(pass1.messages.length + 1);
			expect(wireBytes(pass2Stable)).toBe(wireBytes(pass1.messages));
			expect(differences).toEqual([]);
			expect(pass2Stable).toEqual(pass1.messages);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});
