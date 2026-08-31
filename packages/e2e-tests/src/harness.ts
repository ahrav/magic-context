/**
 *
 * Tests can assert persisted state through magicContext's `context.db`.
 *
 * Usage:
 *
 * ```ts
 * const h = await TestHarness.create({ magicContextConfig: { execute_threshold_percentage: 40 } });
 * h.mock.script([{ text: "ok", usage: { input_tokens: 100, output_tokens: 10 } }]);
 * const sessionId = await h.createSession();
 * await h.sendPrompt(sessionId, "hello");
 * expect(h.mock.requests().length).toBe(1);
 * await h.dispose();
 * ```
 */

import { Database } from "bun:sqlite";
import { storageSubtreePath } from "../../plugin/src/shared/data-path";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ballastProse } from "./ballast";
import {
    DEFAULT_MOCK_RESPONSE,
    type SdkClientCore,
    type SharedHarnessOptions,
} from "./harness-primitives";
import { MockProvider } from "./mock-provider/server";
import {
    spawnOpencode,
    type SpawnedOpencode,
    type SpawnOptions,
} from "./opencode-runner/spawn";

export interface TestHarnessOptions extends SharedHarnessOptions {
    /**
     * `extraEnv` overrides the fake API key after test defaults are merged.
     * Secret-bearing `extraEnv` requires `hostname: "127.0.0.1"`.
     */
    extraEnv?: SpawnOptions["extraEnv"];
    /** `hostname` must be `"127.0.0.1"` when `extraEnv` contains a secret. */
    hostname?: SpawnOptions["hostname"];
}

export interface SdkClient extends SdkClientCore {
    session: SdkClientCore["session"] & {
        children: (opts: { path: { id: string } }) => Promise<{ data?: unknown }>;
    };
}

/**
 * Wall-clock ceiling for one `sendPrompt` when the caller names none.
 *
 * Exported because callers that must BUDGET for a prompt they do not time
 * themselves need the same number the call enforces — a local copy silently
 * drifts from it and under-reserves.
 */
export const DEFAULT_PROMPT_TIMEOUT_MS = 180_000;

export class TestHarness {
    readonly mock: MockProvider;
    readonly opencode: SpawnedOpencode;
    readonly client: SdkClient;
    readonly mcHostStack: SpawnedOpencode["mcHostStack"];

    private contextDbCached: Database | null = null;

    private constructor(
        mock: MockProvider,
        opencode: SpawnedOpencode,
        client: SdkClient,
    ) {
        this.mock = mock;
        this.opencode = opencode;
        this.client = client;
        this.mcHostStack = opencode.mcHostStack;
    }

    static async create(
        options: TestHarnessOptions = {},
    ): Promise<TestHarness> {
        const mock = new MockProvider();
        const { baseURL } = await mock.start();

        // `TestHarness.create` installs a default response so unexpected mock requests do not return 500.
        mock.setDefault(options.mockDefault ?? DEFAULT_MOCK_RESPONSE);

        const spawnOpts: SpawnOptions = {
            mockProviderURL: baseURL,
            magicContextConfig: options.magicContextConfig,
            openCodeConfigExtra: options.openCodeConfigExtra,
            modelContextLimit: options.modelContextLimit,
            extraEnv: options.extraEnv,
            hostname: options.hostname,
        };
        const opencode = await spawnOpencode(spawnOpts);

        const sdk = await import("@opencode-ai/sdk");
        // TestHarness uses only `SdkClient` methods shared with the generated SDK client.
        const client = sdk.createOpencodeClient({
            baseUrl: opencode.url,
        }) as unknown as SdkClient;

        return new TestHarness(mock, opencode, client);
    }

    /** `createSession` binds each session to the harness's isolated workdir. */
    async createSession(): Promise<string> {
        return this.createSessionWithRetry(
            () =>
                this.client.session.create({
                    query: { directory: this.opencode.env.workdir },
                }),
            "session.create",
        );
    }

    /**
     * `createSession` retries when `/doc` is ready but `/session` returns no `data`; no session exists before a response includes `data`.
     * After retries are exhausted, `createSession` throws with captured stderr and stdout.
     */
    private async createSessionWithRetry(
        attempt: () => Promise<{ data?: { id: string } | null }>,
        label: string,
    ): Promise<string> {
        const maxAttempts = 5;
        for (let i = 1; i <= maxAttempts; i++) {
            const res = await attempt();
            if (res.data) return res.data.id;
            if (i < maxAttempts) {
                await Bun.sleep(200 * i);
                continue;
            }
            throw new Error(
                `${label} failed after ${maxAttempts} attempts. stderr:\n${this.opencode.stderr()}\nstdout:\n${this.opencode.stdout()}`,
            );
        }
        throw new Error(`${label} failed`);
    }

    /**
     * `parentID` makes the plugin mark the `session_meta` row `isSubagent=true` from `session.created`.
     *
     */
    async createChildSession(
        parentId: string,
        title?: string,
    ): Promise<string> {
        return this.createSessionWithRetry(
            () =>
                this.client.session.create({
                    query: { directory: this.opencode.env.workdir },
                    body: { parentID: parentId, ...(title ? { title } : {}) },
                }),
            "child session.create",
        );
    }

    /**
     * `session_meta` may be absent until the plugin processes `session.created`; callers must wait with `waitFor`.
     */
    isSubagent(sessionId: string): boolean | null {
        try {
            const db = this.contextDb();
            const row = db
                .prepare(
                    "SELECT is_subagent FROM session_meta WHERE session_id = ?",
                )
                .get(sessionId) as { is_subagent: number } | null;
            if (!row) return null;
            return row.is_subagent === 1;
        } catch {
            return null;
        }
    }

    /**
     * `status` accepts magic-context `TagStatus` values `"active"` and `"dropped"`.
     */
    countTagsByStatus(sessionId: string, status: string): number {
        try {
            const db = this.contextDb();
            const row = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = ?",
                )
                .get(sessionId, status) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /**
     */
    /**
     *
     *
     */
    ballast(tokens: number): string {
        return ballastProse(tokens);
    }

    async sendPrompt(
        sessionId: string,
        text: string,
        options: {
            modelID?: string;
            providerID?: string;
            agent?: string;
            timeoutMs?: number;
        } = {},
    ): Promise<unknown> {
        // Default bumped from 30s → 180s. CI runners (GitHub-hosted ubuntu)
        // can take 10-30s just for opencode serve to process a single prompt
        // when historian/compressor work is involved. 180s leaves room for
        // multi-step assistant turns while still catching genuinely stuck
        // prompts. Individual tests can still pass a smaller timeoutMs.
        const timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
        const promptPromise = this.client.session.prompt({
            path: { id: sessionId },
            body: {
                model: {
                    providerID: options.providerID ?? "mock-anthropic",
                    modelID: options.modelID ?? "mock-sonnet",
                },
                parts: [{ type: "text", text }],
                ...(options.agent ? { agent: options.agent } : {}),
            },
        });
        const timeout = new Promise<null>((r) =>
            setTimeout(() => r(null), timeoutMs),
        );
        const result = await Promise.race([promptPromise, timeout]);
        if (result === null) {
            throw new Error(
                `sendPrompt did not complete within ${timeoutMs}ms. stderr:\n${this.opencode.stderr().slice(-2000)}`,
            );
        }
        return result;
    }

    /**
     */
    contextDb(): Database {
        if (this.contextDbCached) return this.contextDbCached;
        const dbPath = this.contextDbPath();
        if (!existsSync(dbPath)) {
            throw new Error(
                `context.db not found at ${dbPath} — plugin may not have initialized yet.`,
            );
        }
        this.contextDbCached = new Database(dbPath, { readonly: true });
        return this.contextDbCached;
    }

    /* */
    contextDbPath(): string {
        // The shared cortexkit/magic-context path lets OpenCode and Pi share
        // state. See packages/plugin/src/shared/data-path.ts.
        return join(storageSubtreePath(this.opencode.env.dataDir), "context.db");
    }

    /* */
    hasContextDb(): boolean {
        return existsSync(this.contextDbPath());
    }

    /* */
    async waitFor<T>(
        predicate: () => T | null | undefined | false,
        opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
    ): Promise<T> {
        // smaller timeoutMs.
        const timeoutMs = opts.timeoutMs ?? 60_000;
        const intervalMs = opts.intervalMs ?? 100;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const value = predicate();
            if (value) return value as T;
            await Bun.sleep(intervalMs);
        }
        throw new Error(
            `waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`,
        );
    }

    /**
     * `countCompartments()` returns 0 when the table is empty or missing.
     */
    countCompartments(sessionId: string): number {
        try {
            const db = this.contextDb();
            const row = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?",
                )
                .get(sessionId) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /* */
    countTags(sessionId: string): number {
        try {
            const db = this.contextDb();
            const row = db
                .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ?")
                .get(sessionId) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /* */
    requests() {
        return this.mock.requests();
    }

    async dispose(): Promise<void> {
        if (this.contextDbCached) {
            try {
                this.contextDbCached.close();
            } catch {
            }
            this.contextDbCached = null;
        }
        await this.opencode.kill();
        await this.mock.stop();
        rmSync(dirname(this.opencode.env.configDir), {
            recursive: true,
            force: true,
        });
    }
}
