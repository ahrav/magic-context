
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { isFailClosedBlockingError } from "@magic-context/core/features/magic-context/fail-closed-block";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { registerPiFailClosedSurface } from "../../pi-plugin/src/fail-closed-pi";
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
) as { branches: Array<Record<string, unknown>> };
const artifact = readArtifact("mutations/fm-pi-4.json");
const PROVIDER_PROVEN_LIMIT = 120_000;
const PROVIDER_PROVEN_PERCENTAGE = 96;

let h: PiTestHarness;

beforeAll(async () => {
	h = await PiTestHarness.create({
		modelContextLimit: 128_000,
		magicContextConfig: { execute_threshold_percentage: 40 },
	});
});

afterAll(async () => {
	await h?.dispose();
});

describe("FM-PI-4: provider-proven pressure at the Pi refusal boundary", () => {
	it("FM-PI-4-CONTINUE-95-PROVIDER records provider proof and continues the Pi emergency path", async () => {
		const lineageKey = "FM-PI-4-CONTINUE-95-PROVIDER";
		assertExternalProviderIsNotSupervised(lineageKey);
		assertTraceBranch(
			trace,
			"PI-RUST-PROVIDER-PROVEN-PRESSURE",
			"packages/pi-plugin/src/index.ts",
			"detectOverflow",
		);
		assertTraceBranch(
			trace,
			"PI-RUST-FAILURE-FAIL-CLOSED",
			"packages/pi-plugin/src/context-handler.ts",
			"isFailClosedBlockingError(err)",
		);

		h.mock.reset();
		let providerProofSent = false;
		h.mock.addMatcher((body) => {
			const messages = messagesOnly(body);
			if (messages.length === 0) return null;
			if (!providerProofSent) {
				providerProofSent = true;
				return {
					error: {
						status: 400,
						type: "invalid_request_error",
						message: `This model's maximum context length is ${PROVIDER_PROVEN_LIMIT} tokens. Please reduce the length of the messages.`,
					},
				};
			}
			return {
				text: "Pi continued after provider proof",
				usage: {
					input_tokens: 115_200,
					output_tokens: 20,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			};
		});

		try {
			await h.sendPrompt("FM-PI-4 provider-proof fault turn", {
				timeoutMs: 60_000,
			});
		} catch {
			// The first provider rejection is expected.
		}
		expect(providerProofSent).toBe(true);

		const recovered = await h.sendPrompt(
			"FM-PI-4 continue at provider-proven pressure",
			{ timeoutMs: 60_000, continueSession: true },
		);
		expect(recovered.sessionId).toBeTruthy();
		if (!recovered.sessionId)
			throw new Error(`${lineageKey}: missing lineage session id`);
		expect(
			textInMessages(messagesOnly(h.mock.lastRequest()?.body ?? {})),
		).toContain("FM-PI-4 continue at provider-proven pressure");

		const sessionId = recovered.sessionId;
		const metadata = await h.waitFor(
			() => {
				h.closeContextDb();
				const row = h
					.contextDb()
					.prepare(
						"SELECT detected_context_limit, last_context_percentage, harness FROM session_meta WHERE session_id = ?",
					)
					.get(sessionId) as {
					detected_context_limit?: number;
					last_context_percentage?: number;
					harness?: string;
				} | null;
				return row?.detected_context_limit === PROVIDER_PROVEN_LIMIT &&
					(row.last_context_percentage ?? 0) >= PROVIDER_PROVEN_PERCENTAGE
					? row
					: false;
			},
			{
				timeoutMs: 15_000,
				label: `${lineageKey}: provider proof and pressure`,
			},
		);
		expect(metadata.harness, `${lineageKey}: lineage ${sessionId}`).toBe("pi");
		expect(metadata.detected_context_limit).toBe(PROVIDER_PROVEN_LIMIT);
		expect(metadata.last_context_percentage).toBeGreaterThanOrEqual(
			PROVIDER_PROVEN_PERCENTAGE,
		);
	}, 120_000);

	it("FM-PI-4-REFUSE-95-PROVIDER rethrows an explicit fail-closed block", async () => {
		const lineageKey = "FM-PI-4-REFUSE-95-PROVIDER";
		assertExternalProviderIsNotSupervised(lineageKey);
		assertTraceBranch(
			trace,
			"PI-RUST-FAILURE-BOOT-SURFACE",
			"packages/pi-plugin/src/fail-closed-pi.ts",
			"controller.enforce",
		);
		const source = readRepositorySource(
			"packages/pi-plugin/src/context-handler.ts",
		);
		expect(source).toContain(
			"Loud fail-closed / emergency aborts must reach the user",
		);

		const fake = createFakePi();
		registerPiFailClosedSurface(fake.pi as never, {
			reason: {
				kind: "storage_failure",
				cause: `provider-proven pressure ${PROVIDER_PROVEN_PERCENTAGE}% with external module unavailable`,
			},
			tryReopen: async () => null,
			onRecovered: async (_db: ContextDatabase) => {},
		});

		let thrown: unknown;
		try {
			await fake.emit(
				"context",
				{ messages: [{ role: "user", content: "95%" }] },
				{},
			);
		} catch (error) {
			thrown = error;
		}
		expect(
			isFailClosedBlockingError(thrown),
			`${lineageKey}: refusal must be typed`,
		).toBe(true);
		expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain(
			`${PROVIDER_PROVEN_PERCENTAGE}%`,
		);
	});

	it("FM-PI-4 mutation records keep both halves and both rung mutations", () => {
		assertMutationDiscipline(artifact, [
			"FM-PI-4-CONTINUE-95-PROVIDER",
			"FM-PI-4-REFUSE-95-PROVIDER",
		]);
		const source = readRepositorySource("packages/pi-plugin/src/index.ts");
		expect(source).toContain("record the recovery flag");
		expect(source).toContain("detectOverflow");
	});
});
