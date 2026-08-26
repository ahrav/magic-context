import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	type DreamerConfig,
	DreamerConfigSchema,
} from "@magic-context/core/config/schema/magic-context";
import { getTaskScheduleState } from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { insertMemory } from "@magic-context/core/features/magic-context/memory";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { createClaimMemorySchema } from "@magic-context/core/features/magic-context/storage-claim-memory-schema";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { seedProjectMemoryClaim } from "@magic-context/core/features/magic-context/test-claim-database";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	awaitInFlightDreamers,
	registerPiDreamerProject,
	runPiDreamForProject,
	unregisterPiDreamerProject,
} from ".";

let db: Database | null = null;

type CapturedDreamClient = {
	session: {
		create: (args: unknown) => Promise<unknown>;
		prompt: (args: unknown) => Promise<unknown>;
	};
};

function requireCapturedClient(
	client: CapturedDreamClient | null,
): CapturedDreamClient {
	expect(client).not.toBeNull();
	if (!client) throw new Error("dreamer client was not captured");
	return client;
}

function createDb(): Database {
	const database = new Database(":memory:");
	initializeDatabase(database);
	runMigrations(database);
	database.transaction(() => createClaimMemorySchema(database)).immediate();
	return database;
}

function enabledConfig() {
	return DreamerConfigSchema.parse({
		model: "test/model",
		tasks: { verify: { schedule: "0 3 * * *" } },
	});
}

function disabledConfig() {
	return DreamerConfigSchema.parse({ disable: true });
}

function dreamerOptions(args: {
	database: Database;
	projectIdentity: string;
	projectDir?: string;
	config?: DreamerConfig;
	language?: string;
	onAdjunctsRefreshNeeded?: (projectIdentity: string) => void;
}) {
	return {
		db: args.database,
		projectDir:
			args.projectDir ??
			`/tmp/${args.projectIdentity.replace(/[^a-z0-9-]/gi, "-")}`,
		projectIdentity: args.projectIdentity,
		config: args.config ?? enabledConfig(),
		embeddingConfig: { provider: "off" as const },
		memoryEnabled: true,
		language: args.language,
		gitCommitIndexing: { enabled: false, since_days: 30, max_commits: 200 },
		onAdjunctsRefreshNeeded: args.onAdjunctsRefreshNeeded,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

const CURATE_PSEUDO_TOOL_CALL = `归档与全局用户画像完全重复且无项目特化信息的记忆条目。[historical tool call]
id: call_2080315
name: ctx_memory
arguments:
{"action":"archive","reason":"与全局用户画像重复","ids":[6]}`;

afterEach(() => {
	__test.reset();
	if (db) {
		closeQuietly(db);
		db = null;
	}
});

describe("Pi dreamer wiring", () => {
	test("disable=true config is a no-op", () => {
		db = createDb();

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/pi-project-disabled",
				projectIdentity: "git:pi-disabled",
				config: disabledConfig(),
			}),
		);

		expect(__test.registeredProjectCount()).toBe(0);
	});

	test("runnable config registers once for the same project", () => {
		db = createDb();
		const config = enabledConfig();
		const opts = dreamerOptions({
			database: db,
			projectDir: "/tmp/pi-project-enabled",
			projectIdentity: "git:pi-enabled",
			config,
		});

		registerPiDreamerProject(opts);
		registerPiDreamerProject(opts);

		expect(__test.registeredProjectCount()).toBe(1);
	});

	test("threads language into scheduled dreamer registration", async () => {
		db = createDb();
		let language: string | undefined;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			language = (registration as { language?: string }).language;
			return mock(() => {});
		});

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-language",
				language: "es",
			}),
		);
		await flushMicrotasks();

		expect(language).toBe("es");
	});

	test("manual dreamer passes a directive-bearing system prompt when language is set", async () => {
		db = createDb();
		let capturedSystem = "";
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async (args: { systemPrompt?: string }) => {
						capturedSystem = args.systemPrompt ?? "";
						return { ok: true, assistantText: "done" };
					}),
				}) as never,
		);
		seedProjectMemoryClaim(db, {
			projectIdentity: "git:pi-manual-language",
			category: "ARCHITECTURE",
			content: "The Pi harness runs dreamer prompts through a subprocess.",
		});

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: process.cwd(),
				projectIdentity: "git:pi-manual-language",
				config: DreamerConfigSchema.parse({
					model: "test/model",
					tasks: { curate: { schedule: "0 4 * * *" } },
				}),
				language: "es",
			}),
		);

		const result = await runPiDreamForProject(
			"git:pi-manual-language",
			"curate",
		);
		expect(
			getTaskScheduleState(db, "git:pi-manual-language", "curate")?.lastError,
		).toBeNull();
		expect(result).toEqual({
			ran: ["curate"],
			skippedNoWork: [],
			deferredBusy: [],
			failed: [],
			failureDetails: [],
			backlogBefore: { curate: { pending: 1, total: 1 } },
			backlogAfter: { curate: { pending: 1, total: 1 } },
		});

		expect(capturedSystem).toContain(
			"Write human-readable prose you author in: Spanish (Español).",
		);
	});

	test("shared curate validation retries Pi pseudo-tool-call text with the fallback model", async () => {
		db = createDb();
		const attemptedModels: Array<string | undefined> = [];
		__test.setStartDreamScheduleTimerFactory(async () => mock(() => {}));
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async (args: { model?: string }) => {
						attemptedModels.push(args.model);
						return {
							ok: true,
							assistantText:
								attemptedModels.length === 1
									? CURATE_PSEUDO_TOOL_CALL
									: "curation complete",
						};
					}),
				}) as never,
		);
		insertMemory(db, {
			projectPath: "git:pi-curate-pseudo-tool-call",
			category: "PROJECT_RULES",
			content: "Use the shared release checklist before publishing.",
		});

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: process.cwd(),
				projectIdentity: "git:pi-curate-pseudo-tool-call",
				config: DreamerConfigSchema.parse({
					model: "primary/curator",
					tasks: {
						curate: {
							schedule: "0 4 * * *",
							fallback_models: ["fallback/curator"],
						},
					},
				}),
			}),
		);

		const result = await runPiDreamForProject(
			"git:pi-curate-pseudo-tool-call",
			"curate",
		);

		expect(attemptedModels).toEqual(["primary/curator", "fallback/curator"]);
		expect(result.failed).toEqual([]);
		expect(result.ran).toEqual(["curate"]);
	});

	test("re-registering the SAME dir is a no-op (keeps the first timer)", async () => {
		db = createDb();
		const timerCleanup = mock(() => {});
		__test.setStartDreamScheduleTimerFactory(async () => timerCleanup);

		const opts = dreamerOptions({
			database: db,
			projectDir: "/tmp/pi-samedir",
			projectIdentity: "git:pi-samedir",
		});
		registerPiDreamerProject(opts);
		await flushMicrotasks();
		registerPiDreamerProject(opts);
		await flushMicrotasks();

		expect(__test.registeredProjectCount()).toBe(1);
		// Same dir → no rebuild → original timer never cleaned up.
		expect(timerCleanup).not.toHaveBeenCalled();
	});

	test("re-registering the same identity with a DIFFERENT dir rebuilds (worktree switch)", async () => {
		db = createDb();
		const firstCleanup = mock(() => {});
		const secondCleanup = mock(() => {});
		const cleanups = [firstCleanup, secondCleanup];
		const dirs: string[] = [];
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			dirs.push((registration as { directory: string }).directory);
			return cleanups.shift() ?? mock(() => {});
		});

		// Worktree A of the same repo → identity X.
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-A",
				projectIdentity: "git:pi-worktree",
			}),
		);
		await flushMicrotasks();
		// Worktree B of the SAME repo (same identity, different dir).
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/worktree-B",
				projectIdentity: "git:pi-worktree",
			}),
		);
		await flushMicrotasks();

		// Still one registration, but rebuilt: first timer torn down, second
		// timer started against worktree B.
		expect(__test.registeredProjectCount()).toBe(1);
		expect(firstCleanup).toHaveBeenCalledTimes(1);
		expect(dirs).toEqual(["/tmp/worktree-A", "/tmp/worktree-B"]);
	});

	test("unregister removes the project", () => {
		db = createDb();
		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectDir: "/tmp/pi-project-unregister",
				projectIdentity: "git:pi-unregister",
			}),
		);

		unregisterPiDreamerProject({ projectIdentity: "git:pi-unregister" });

		expect(__test.registeredProjectCount()).toBe(0);
	});

	test("awaitInFlightDreamers resolves immediately when nothing is running", async () => {
		await expect(awaitInFlightDreamers()).resolves.toBeUndefined();
	});

	test("fires onAdjunctsRefreshNeeded after successful dreamer prompt", async () => {
		db = createDb();
		let capturedClient: CapturedDreamClient | null = null;
		const timerCleanup = mock(() => {});
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			capturedClient = registration.client as unknown as CapturedDreamClient;
			return timerCleanup;
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({ ok: true, assistantText: "done" })),
				}) as never,
		);
		const onAdjunctsRefreshNeeded = mock(() => {});

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-g5-success",
				onAdjunctsRefreshNeeded,
			}),
		);
		const client = requireCapturedClient(capturedClient);
		const created = (await client.session.create({})) as {
			id: string;
		};
		await client.session.prompt({
			path: { id: created.id },
			body: { system: "system", parts: [{ text: "run dreamer" }] },
		});

		expect(onAdjunctsRefreshNeeded).toHaveBeenCalledTimes(1);
		expect(onAdjunctsRefreshNeeded).toHaveBeenCalledWith("git:pi-g5-success");
	});

	test("undefined onAdjunctsRefreshNeeded is a no-op after successful dreamer prompt", async () => {
		db = createDb();
		let capturedClient: CapturedDreamClient | null = null;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			capturedClient = registration.client as unknown as CapturedDreamClient;
			return mock(() => {});
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({ ok: true, assistantText: "done" })),
				}) as never,
		);

		registerPiDreamerProject(
			dreamerOptions({ database: db, projectIdentity: "git:pi-g5-noop" }),
		);
		const client = requireCapturedClient(capturedClient);
		const created = (await client.session.create({})) as {
			id: string;
		};
		await expect(
			client.session.prompt({
				path: { id: created.id },
				body: { system: "system", parts: [{ text: "run dreamer" }] },
			}),
		).resolves.toBeUndefined();
	});

	test("does not fire onAdjunctsRefreshNeeded when dreamer prompt fails", async () => {
		db = createDb();
		let capturedClient: CapturedDreamClient | null = null;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			capturedClient = registration.client as unknown as CapturedDreamClient;
			return mock(() => {});
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({
						ok: false,
						reason: "error",
						error: "boom",
					})),
				}) as never,
		);
		const onAdjunctsRefreshNeeded = mock(() => {});

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-g5-failure",
				onAdjunctsRefreshNeeded,
			}),
		);
		const client = requireCapturedClient(capturedClient);
		const created = (await client.session.create({})) as {
			id: string;
		};
		await expect(
			client.session.prompt({
				path: { id: created.id },
				body: { system: "system", parts: [{ text: "run dreamer" }] },
			}),
		).rejects.toThrow("Pi dreamer subagent failed");

		expect(onAdjunctsRefreshNeeded).not.toHaveBeenCalled();
	});

	test("preserves transient status when a child rejects before producing output", async () => {
		db = createDb();
		let capturedClient: CapturedDreamClient | null = null;
		__test.setStartDreamScheduleTimerFactory(async (registration) => {
			capturedClient = registration.client as unknown as CapturedDreamClient;
			return mock(() => {});
		});
		__test.setPiSubagentRunnerFactory(
			() =>
				({
					run: mock(async () => ({
						ok: false,
						reason: "invalid_prompt",
						transient: true,
						error: "zero-tool prompt missing",
						durationMs: 0,
					})),
				}) as never,
		);

		registerPiDreamerProject(
			dreamerOptions({
				database: db,
				projectIdentity: "git:pi-transient-child",
			}),
		);
		const client = requireCapturedClient(capturedClient);
		const created = (await client.session.create({})) as { id: string };
		await expect(
			client.session.prompt({
				path: { id: created.id },
				body: { system: "system", parts: [{ text: "run dreamer" }] },
			}),
		).rejects.toMatchObject({ transient: true });
	});

	test("unregister before timer promise resolves invokes timer cleanup when it eventually resolves", async () => {
		db = createDb();
		const timerCleanup = mock(() => {});
		const timer = deferred<() => void>();
		__test.setStartDreamScheduleTimerFactory(() => timer.promise);

		registerPiDreamerProject(
			dreamerOptions({ database: db, projectIdentity: "git:pi-g12-race" }),
		);
		unregisterPiDreamerProject({ projectIdentity: "git:pi-g12-race" });
		expect(timerCleanup).not.toHaveBeenCalled();

		timer.resolve(timerCleanup);
		await flushMicrotasks();

		expect(timerCleanup).toHaveBeenCalledTimes(1);
	});

	test("normal timer lifecycle invokes cleanup exactly once on unregister", async () => {
		db = createDb();
		const timerCleanup = mock(() => {});
		const timer = deferred<() => void>();
		__test.setStartDreamScheduleTimerFactory(() => timer.promise);

		registerPiDreamerProject(
			dreamerOptions({ database: db, projectIdentity: "git:pi-g12-normal" }),
		);
		timer.resolve(timerCleanup);
		await flushMicrotasks();

		unregisterPiDreamerProject({ projectIdentity: "git:pi-g12-normal" });
		unregisterPiDreamerProject({ projectIdentity: "git:pi-g12-normal" });

		expect(timerCleanup).toHaveBeenCalledTimes(1);
	});
});
