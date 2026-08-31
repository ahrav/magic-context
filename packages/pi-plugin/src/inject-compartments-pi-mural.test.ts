import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProjectMemoryClaimLifecycle } from "@magic-context/core/features/magic-context/memory/storage-claim-operations";
import { resolveMuralWire } from "@magic-context/core/features/magic-context/mural/render-trigger";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { seedProjectMemoryClaim } from "@magic-context/core/features/magic-context/test-claim-database";
import {
	clearModelsDevCache,
	refreshModelLimitsFromApi,
} from "@magic-context/core/shared/models-dev-cache";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	injectM0M1Pi,
	type PiM0M1State,
} from "./inject-compartments-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

const SESSION_ID = "ses_pi_mural_inject";

// FAKE_MURAL_DATA_URL encodes a 1x1 transparent PNG fixture.
const FAKE_MURAL_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const FAKE_MURAL_BASE64 = FAKE_MURAL_DATA_URL.slice(
	"data:image/png;base64,".length,
);

function muralOption() {
	return {
		enabled: true,
		supportsVision: true,
		dataUrl: FAKE_MURAL_DATA_URL,
		contentHash: "mural-hash-1",
	};
}

function baseState(overrides: Partial<PiM0M1State> = {}): PiM0M1State {
	return {
		sessionId: SESSION_ID,
		projectIdentity: "git:pi-mural",
		projectDirectory: "/tmp/pi-mural",
		hardSignals: {
			systemHash: "sys",
			modelKey: "anthropic/claude-sonnet-4",
			cacheExpired: false,
			lastResponseTime: 0,
		},
		...overrides,
	};
}

function replaceCurrentManifest(db: ReturnType<typeof createTestDb>): string {
	const image = Buffer.from("current pi mural", "utf8");
	db.prepare(
		`INSERT OR REPLACE INTO mural_manifest
			(project_path, image, content_hash, rendered_at, memory_ids_json, width, height)
		 VALUES (?, ?, ?, ?, '[]', 1, 1)`,
	).run("git:pi-mural", image, "current-pi-manifest", Date.now());
	return image.toString("base64");
}

function findM0Image(messages: Array<{ content?: unknown }>): {
	type?: string;
	mimeType?: string;
	data?: string;
} | null {
	const head = messages[0];
	if (!head || !Array.isArray(head.content)) return null;
	for (const part of head.content) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: string }).type === "image"
		) {
			return part as { type?: string; mimeType?: string; data?: string };
		}
	}
	return null;
}

describe("Pi m[0] mural image fold (on-demand render → wire)", () => {
	it("folds the <memory-mural> block and Pi image part on HARD, replays byte-identical on defer", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const state = baseState({ mural: muralOption() });

			const hardMessages = [userMessage("hello")];
			const first = injectM0M1Pi(
				state,
				db,
				hardMessages as never,
				undefined,
				true,
			);
			expect(first.injected).toBe(true);
			expect(first.m0Materialized).toBe(true);
			expect(textOf(hardMessages[0])).toContain("<memory-mural>");
			const hardImage = findM0Image(hardMessages);
			expect(hardImage).toBeDefined();
			expect(hardImage?.mimeType).toBe("image/png");
			expect(hardImage?.data).toBe(FAKE_MURAL_BASE64);

			// The defer must reload this session's persisted frozen payload instead.
			const currentManifestBase64 = replaceCurrentManifest(db);
			__test.clearPiMuralProcessCache(SESSION_ID);
			const deferState = baseState();
			const deferMessages = [userMessage("again")];
			const second = injectM0M1Pi(
				deferState,
				db,
				deferMessages as never,
				undefined,
				false,
			);
			expect(second.m0Reason).toBeNull();
			expect(second.m0Materialized).toBe(false);
			expect(textOf(deferMessages[0])).toContain("<memory-mural>");
			const deferImage = findM0Image(deferMessages);
			expect(deferImage?.data).toBe(FAKE_MURAL_BASE64);
			expect(deferImage?.data).not.toBe(currentManifestBase64);
			expect(textOf(deferMessages[0])).toBe(textOf(hardMessages[0]));
		} finally {
			closeQuietly(db);
		}
	});

	it("publishes no mural image and no marker when the claim snapshot went stale", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const state = baseState({
				mural: muralOption(),
				injectionBudgetTokens: 8_000,
				historyBudgetTokens: 60_000,
			});
			const claim = seedProjectMemoryClaim(db, {
				projectIdentity: "git:pi-mural",
				content: "Claim whose cue the mural draws.",
				category: "ARCHITECTURE",
			});

			// The hard pass caches the mural marker and image payload with the claim snapshot.
			const foldMessages = [userMessage("hello")];
			injectM0M1Pi(state, db, foldMessages as never, undefined, true);
			expect(textOf(foldMessages[0])).toContain("<memory-mural>");
			expect(textOf(foldMessages[0])).toContain("<project-memory>");
			expect(findM0Image(foldMessages)?.data).toBe(FAKE_MURAL_BASE64);

			// Withdrawing the claim after caching the mural forces the next pass to fold.
			setProjectMemoryClaimLifecycle(
				db,
				{ producer: "test", operationKey: "pi-mural-stale-archive" },
				{ token: claim.token, state: "archived", actor: "user:test" },
			);

			// A sibling process holding the materialize lock makes `BEGIN IMMEDIATE` fail and forces cached m[0] replay.
			// Cached m[0] retains the mural marker and image payload.
			const locked = new Proxy(db, {
				get(target, property, receiver) {
					if (property === "exec") {
						return (sql: string, ...rest: unknown[]) => {
							if (/BEGIN IMMEDIATE/i.test(sql)) {
								throw Object.assign(new Error("database is locked"), {
									code: "SQLITE_BUSY",
								});
							}
							return (
								target.exec as (sql: string, ...rest: unknown[]) => unknown
							)(sql, ...rest);
						};
					}
					const value = Reflect.get(target, property, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});

			const staleMessages = [userMessage("stale")];
			const stale = injectM0M1Pi(
				state,
				locked as never,
				staleMessages as never,
				undefined,
				true,
			);
			expect(stale.contentionExhausted).toBe(true);

			// The publication fence suppresses all claim-derived representations: the image part, mural marker, and replayable cached payload.
			const staleText = textOf(staleMessages[0]);
			expect(staleText).not.toContain("<project-memory>");
			expect(staleText).not.toContain("<memory-mural>");
			expect(findM0Image(staleMessages)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("folds once when mural is disabled, removes the image, then defers byte-identically", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const firstMessages = [userMessage("enabled")];
			injectM0M1Pi(
				baseState({
					muralEnabled: true,
					mural: muralOption(),
					injectionBudgetTokens: 8_000,
					historyBudgetTokens: 60_000,
				}),
				db,
				firstMessages as never,
				undefined,
				true,
			);
			expect(findM0Image(firstMessages)?.data).toBe(FAKE_MURAL_BASE64);

			const disabledMessages = [userMessage("disabled")];
			const disabled = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 8_000,
					historyBudgetTokens: 60_000,
				}),
				db,
				disabledMessages as never,
				undefined,
				false,
			);
			expect(disabled.m0Reason).toBe("render_config");
			expect(disabled.m0Materialized).toBe(true);
			expect(findM0Image(disabledMessages)).toBeNull();
			expect(textOf(disabledMessages[0])).not.toContain("<memory-mural>");

			const deferMessages = [userMessage("defer")];
			const defer = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 8_000,
					historyBudgetTokens: 60_000,
				}),
				db,
				deferMessages as never,
				undefined,
				false,
			);
			expect(defer.m0Materialized).toBe(false);
			expect(textOf(deferMessages[0])).toBe(textOf(disabledMessages[0]));
			expect(findM0Image(deferMessages)).toBeNull();
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("folds once when memory or history render budgets change", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 1_000,
					historyBudgetTokens: 2_000,
				}),
				db,
				[userMessage("first")] as never,
				undefined,
				true,
			);
			const changed = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 1_001,
					historyBudgetTokens: 2_000,
				}),
				db,
				[userMessage("changed")] as never,
				undefined,
				false,
			);
			expect(changed.m0Reason).toBe("render_config");
			expect(changed.m0Materialized).toBe(true);

			const unchanged = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 1_001,
					historyBudgetTokens: 2_000,
				}),
				db,
				[userMessage("unchanged")] as never,
				undefined,
				false,
			);
			expect(unchanged.m0Materialized).toBe(false);
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("hydrates a sibling cached-row mural payload", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({ mural: muralOption() }),
				db,
				[userMessage("hard")] as never,
				undefined,
				true,
			);

			const siblingDataUrl = "data:image/png;base64,cGktc2libGluZy1tdXJhbA==";
			db.prepare(
				`UPDATE session_meta
					SET cached_m0_mural_data_url = ?, cached_m0_mural_hash = ?,
						cached_m0_materialized_at = cached_m0_materialized_at + 1
				  WHERE session_id = ?`,
			).run(siblingDataUrl, "pi-sibling-hash", SESSION_ID);

			const messages = [userMessage("soft")];
			injectM0M1Pi(baseState(), db, messages as never, undefined, true);
			expect(findM0Image(messages)?.data).toBe(
				siblingDataUrl.slice("data:image/png;base64,".length),
			);
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("uses a text-only fallback when a legacy cached row lacks its image payload", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({ mural: muralOption() }),
				db,
				[userMessage("hard")] as never,
				undefined,
				true,
			);
			const currentManifestBase64 = replaceCurrentManifest(db);
			db.prepare(
				`UPDATE session_meta
					SET cached_m0_mural_data_url = NULL, cached_m0_mural_hash = NULL
				  WHERE session_id = ?`,
			).run(SESSION_ID);
			__test.clearPiMuralProcessCache(SESSION_ID);

			const messages = [userMessage("defer")];
			injectM0M1Pi(baseState(), db, messages as never, undefined, false);
			expect(findM0Image(messages)).toBeNull();
			expect(findM0Image(messages)?.data).not.toBe(currentManifestBase64);
			expect(textOf(messages[0])).not.toContain("<memory-mural>");
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("omits the mural when the feature flag is off", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const messages = [userMessage("hello")];
			const result = injectM0M1Pi(
				baseState({ muralEnabled: false }),
				db,
				messages as never,
				undefined,
				true,
			);
			expect(result.injected).toBe(true);
			expect(textOf(messages[0])).not.toContain("<memory-mural>");
			expect(findM0Image(messages)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("stays text-only when the model has no vision metadata (fail closed)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "mc-pi-mural-novision-"));
		const originalXdgData = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = tempDir;
		clearModelsDevCache();
		const db = createTestDb();
		try {
			// A non-vision model gives the gate metadata with vision=false.
			await refreshModelLimitsFromApi({
				config: {
					providers: async () => ({
						data: {
							providers: [
								{
									id: "anthropic",
									models: {
										"claude-sonnet-4": {
											limit: { context: 200_000, input: 200_000 },
										},
									},
								},
							],
						},
					}),
				},
			});
			getOrCreateSessionMeta(db, `${SESSION_ID}_novision`);
			const messages = [userMessage("hello")];
			injectM0M1Pi(
				baseState({
					sessionId: `${SESSION_ID}_novision`,
					muralEnabled: true,
					hardSignals: {
						systemHash: "sys",
						modelKey: "anthropic/claude-sonnet-4",
						cacheExpired: false,
						lastResponseTime: 0,
					},
				}),
				db,
				messages as never,
				undefined,
				true,
			);
			expect(textOf(messages[0])).not.toContain("<memory-mural>");
			expect(findM0Image(messages)).toBeNull();
		} finally {
			if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = originalXdgData;
			clearModelsDevCache();
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			closeQuietly(db);
		}
	});
});

describe("resolveMuralWire Pi provider-prefix translation", () => {
	let tempDir: string;
	let originalXdgData: string | undefined;

	beforeEach(() => {
		// A test-local models-dev cache prevents vision seeds from touching the real cache or leaking through cold-start reloads.
		tempDir = mkdtempSync(join(tmpdir(), "mc-pi-mural-models-"));
		originalXdgData = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = tempDir;
		clearModelsDevCache();
	});
	afterEach(() => {
		if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalXdgData;
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		clearModelsDevCache();
	});

	it("accepts Pi-native openai-codex/… after translating to canonical openai/…", async () => {
		await refreshModelLimitsFromApi({
			config: {
				providers: async () => ({
					data: {
						providers: [
							{
								id: "openai",
								models: {
									"gpt-4o": {
										limit: { context: 128_000, input: 128_000 },
										// models-dev vision detection accepts `modalities.input` containing "image" or model names containing "vision".
										modalities: { input: ["text", "image"] },
									},
								},
							},
						],
					},
				}),
			},
		});
		const db = createTestDb();
		try {
			// An empty cue pool sets supportsVision to true without a dataUrl.
			// `pi/` model keys are accepted rather than classified as unknown.
			const wire = resolveMuralWire(
				db,
				"git:pi-mural-prefix",
				"openai-codex/gpt-4o",
				true,
			);
			expect(wire.enabled).toBe(true);
			expect(wire.supportsVision).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("fails closed when models.dev metadata is absent", () => {
		clearModelsDevCache();
		const db = createTestDb();
		try {
			const wire = resolveMuralWire(
				db,
				"git:pi-mural-prefix",
				"openai-codex/gpt-4o",
				true,
			);
			expect(wire.supportsVision).toBe(false);
			expect(wire.dataUrl).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});
});
