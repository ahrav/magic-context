/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { isFailClosedBlockingError } from "@magic-context/core/features/magic-context/fail-closed-block";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { registerPiFailClosedSurface } from "../../pi-plugin/src/fail-closed-pi";
import { readPiSessionMessages } from "../../pi-plugin/src/read-session-pi";
import { PiTestHarness } from "../src/pi-harness";
import {
	assertExternalProviderIsNotSupervised,
	assertMutationDiscipline,
	assertTraceBranch,
	createFakePi,
	messagesOnly,
	readArtifact,
	readRepositorySource,
	textInMessages,
} from "./pi-rust-degradation-support";

const trace = JSON.parse(
	await Bun.file(
		join(import.meta.dir, "..", "pi-rust-degradation-trace.json"),
	).text(),
) as { branches: Array<Record<string, unknown>>; trace_conclusion: string };
const artifact = readArtifact("mutations/fm-pi-1.json");

let h: PiTestHarness;

beforeAll(async () => {
	h = await PiTestHarness.create({
		magicContextConfig: { execute_threshold_percentage: 40 },
	});
});

afterAll(async () => {
	await h?.dispose();
});

describe("FM-PI-1: external module loss at the Pi JSONL seam", () => {
	it("FM-PI-1-CONTINUE-JSONL continues on the same lineage after a mid-session fault", async () => {
		const lineageKey = "FM-PI-1-CONTINUE-JSONL";
		assertExternalProviderIsNotSupervised(lineageKey);
		assertTraceBranch(
			trace,
			"PI-RUST-INGRESS-BRANCH-PROJECTION",
			"packages/pi-plugin/src/context-handler.ts",
			"function readPiBranchEntriesForContext",
		);
		assertTraceBranch(
			trace,
			"PI-RUST-FAILURE-ORDINARY",
			"packages/pi-plugin/src/context-handler.ts",
			"context handler failed (continuing without mutation)",
		);
		const rawFallback = readPiSessionMessages({
			sessionManager: {
				getBranch: () => {
					throw new Error("simulated JSONL branch outage");
				},
			},
		} as never);
		expect(
			rawFallback,
			`${lineageKey}: JSONL outage falls back to an empty raw read`,
		).toEqual([]);

		h.mock.reset();
		let faultInjected = false;
		h.mock.addMatcher((body) => {
			const messages = messagesOnly(body);
			if (messages.length === 0) return null;
			if (!faultInjected) {
				faultInjected = true;
				return {
					error: {
						status: 503,
						type: "overloaded_error",
						message: "external module process was killed during this session",
					},
				};
			}
			return {
				text: "recovered after Pi-owned raw fallback",
				usage: {
					input_tokens: 100,
					output_tokens: 20,
					cache_creation_input_tokens: 100,
					cache_read_input_tokens: 0,
				},
			};
		});

		let failedTurn:
			| Awaited<ReturnType<PiTestHarness["sendPrompt"]>>
			| undefined;
		try {
			failedTurn = await h.sendPrompt(
				"FM-PI-1 fault turn: continue through the Pi JSONL seam",
				{ timeoutMs: 60_000 },
			);
		} catch {
		}
		expect(faultInjected).toBe(true);

		const recovered = await h.sendPrompt(
			"FM-PI-1 recovery turn: preserve this Pi lineage",
			{ timeoutMs: 60_000, continueSession: true },
		);
		const sessionId = recovered.sessionId ?? failedTurn?.sessionId;
		expect(
			sessionId,
			`${lineageKey}: session id is the lineage key`,
		).toBeTruthy();
		if (!sessionId)
			throw new Error(`${lineageKey}: missing lineage session id`);
		expect(recovered.exitCode).toBeNull();
		expect(
			textInMessages(messagesOnly(h.mock.lastRequest()?.body ?? {})),
		).toContain("FM-PI-1 recovery turn");

		h.closeContextDb();
		const meta = h
			.contextDb()
			.prepare("SELECT harness FROM session_meta WHERE session_id = ?")
			.get(sessionId) as { harness?: string } | null;
		expect(meta?.harness, `${lineageKey}: lineage ${sessionId}`).toBe("pi");
	}, 120_000);

	it("FM-PI-1-REFUSE-JSONL preserves the loud refusal half", async () => {
		const lineageKey = "FM-PI-1-REFUSE-JSONL";
		assertExternalProviderIsNotSupervised(lineageKey);
		assertTraceBranch(
			trace,
			"PI-RUST-FAILURE-FAIL-CLOSED",
			"packages/pi-plugin/src/context-handler.ts",
			"if (isFailClosedBlockingError(err) && !baseOptions.compactionOff)",
		);
		expect(trace.trace_conclusion).toContain("Pi coverage is required");

		const fake = createFakePi();
		registerPiFailClosedSurface(fake.pi as never, {
			reason: {
				kind: "storage_failure",
				cause: "external module unavailable at the Pi JSONL boundary",
			},
			tryReopen: async () => null,
			onRecovered: async (_db: ContextDatabase) => {},
		});

		let thrown: unknown;
		try {
			await fake.emit(
				"context",
				{ messages: [{ role: "user", content: "raw" }] },
				{},
			);
		} catch (error) {
			thrown = error;
		}
		expect(
			isFailClosedBlockingError(thrown),
			`${lineageKey}: refusal must be typed`,
		).toBe(true);
	});

	it("FM-PI-1 mutation records keep both halves and both rung mutations", () => {
		assertMutationDiscipline(artifact, [
			"FM-PI-1-CONTINUE-JSONL",
			"FM-PI-1-REFUSE-JSONL",
		]);
		const source = readRepositorySource(
			"packages/pi-plugin/src/fail-closed-pi.ts",
		);
		expect(source).toContain("controller.enforce");
		expect(source).toContain("throw createFailClosedBlockingError");
	});
});
