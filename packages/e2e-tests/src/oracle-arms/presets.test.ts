/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractMessageText, mainAgentRequests } from "../cache-analysis";
import { TestHarness } from "../harness";
import { MockProvider } from "../mock-provider/server";
import {
    __spawnOpencodeTest,
    spawnOpencode,
    type SpawnedOpencode,
} from "../opencode-runner/spawn";
import { goldEvidencePrompt } from "./gold-evidence";
import { liveModelSpawnOptions, mcOffOptions, naiveCompactionOptions } from "./presets";

const { isInheritableEnvKey } = __spawnOpencodeTest;

const harnesses: TestHarness[] = [];
const spawned: SpawnedOpencode[] = [];
const mocks: MockProvider[] = [];

async function createHarness(
    options: Parameters<typeof TestHarness.create>[0] = {},
): Promise<TestHarness> {
    const harness = await TestHarness.create(options);
    harnesses.push(harness);
    return harness;
}

afterEach(async () => {
    const cleanup = [
        ...harnesses.splice(0).map((harness) => () => harness.dispose()),
        ...spawned.splice(0).map((opencode) => async () => {
            // Both steps always run: a failed kill must not leak the temp tree,
            // and a failed removal must not hide a kill error. First failure
            // wins, matching the cleanup idiom in `spawn.ts`.
            let cleanupError: unknown;
            try {
                await opencode.kill();
            } catch (error) {
                cleanupError = error;
            }
            try {
                const tempRoot = dirname(opencode.env.configDir);
                rmSync(tempRoot, { recursive: true, force: true });
                expect(existsSync(tempRoot)).toBe(false);
            } catch (error) {
                cleanupError ??= error;
            }
            if (cleanupError !== undefined) throw cleanupError;
        }),
        ...mocks.splice(0).map((mock) => () => mock.stop()),
    ];
    const results = await Promise.allSettled(
        cleanup.map((run) => Promise.resolve().then(run)),
    );
    const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
});

describe("oracle arm presets", () => {
    it("enables the complete native compaction block", () => {
        expect(naiveCompactionOptions()).toEqual({
            openCodeConfigExtra: { compaction: { auto: true, prune: false } },
        });
    });

    it("writes an empty plugin list for MC-off", async () => {
        const harness = await createHarness(mcOffOptions());
        const config = JSON.parse(
            readFileSync(join(harness.opencode.env.configDir, "opencode.json"), "utf8"),
        ) as { plugin?: unknown };

        expect(config.plugin).toEqual([]);
    }, 120_000);

    it("does not initialize context.db for naive compaction", async () => {
        const harness = await createHarness(naiveCompactionOptions());
        const sessionId = await harness.createSession();

        await harness.sendPrompt(sessionId, "focused naive-compaction preset prompt");

        expect(harness.hasContextDb()).toBe(false);
    }, 120_000);

    it("writes the live provider recipe without sending a prompt", async () => {
        const mock = new MockProvider();
        mocks.push(mock);
        const { baseURL } = await mock.start();
        const providerBlock = {
            anthropic: {
                api: "@ai-sdk/anthropic",
                name: "Anthropic",
                npm: "@ai-sdk/anthropic",
                env: ["ANTHROPIC_API_KEY"],
                models: {},
            },
        };
        const recipe = liveModelSpawnOptions({
            apiKey: "live-test-key",
            providerBlock,
        });

        expect(recipe.extraEnv).toEqual({ ANTHROPIC_API_KEY: "live-test-key" });
        expect(recipe.hostname).toBe("127.0.0.1");
        // The recipe pins loopback for real-credential runs; this CI spawn uses
        // a fake key and overrides back to the all-interfaces default because
        // GitHub-hosted runners sometimes time out Bun's fetch() against a
        // 127.0.0.1-bound server. The override needs the explicit waiver: the
        // spawn guard refuses a secret-shaped extraEnv key off loopback, and
        // "live-test-key" is a fixture value that reaches no real provider.
        const opencode = await spawnOpencode({
            mockProviderURL: baseURL,
            ...recipe,
            hostname: "0.0.0.0",
            allowSecretEnvOffLoopback: true,
        });
        spawned.push(opencode);
        const config = JSON.parse(
            readFileSync(join(opencode.env.configDir, "opencode.json"), "utf8"),
        ) as { provider?: Record<string, unknown> };

        expect(config.provider?.anthropic).toEqual(providerBlock.anthropic);
        expect(config.provider?.["mock-anthropic"]).toBeDefined();
        expect(mock.requests()).toHaveLength(0);
    }, 120_000);

    it("refuses a secret-shaped extraEnv key off loopback without an explicit waiver", async () => {
        const mock = new MockProvider();
        mocks.push(mock);
        const { baseURL } = await mock.start();
        const recipe = liveModelSpawnOptions({
            apiKey: "live-test-key",
            providerBlock: { anthropic: { models: {} } },
        });

        // The recipe's own pairing is what a real-credential caller spreads, so
        // it must satisfy the guard untouched. Overriding hostname back to the
        // all-interfaces default is what must fail: that is the shape a partial
        // options merge or a harness that drops `hostname` degrades into. One
        // pattern asserts the refused address and the offending key together, so
        // a message that names only one of them cannot pass.
        await expect(
            spawnOpencode({ mockProviderURL: baseURL, ...recipe, hostname: "0.0.0.0" }),
        ).rejects.toThrow(
            /refusing to bind the unauthenticated serve API to 0\.0\.0\.0 while extraEnv carries ANTHROPIC_API_KEY/,
        );

        // Nothing was allocated: the guard runs at the top of the spawn path,
        // ahead of Rust-mode provisioning as well as the port, directory, and
        // config work, so a refused spawn leaves no process to clean up. The
        // mock recorded no request, which a spawned child would have produced.
        expect(mock.requests()).toHaveLength(0);
    }, 30_000);

    it("never forwards an ambient secret from the runner environment to the child", () => {
        // The child inherits the runner's environment wholesale and binds all
        // interfaces by default, so the loopback guard would be a half measure
        // if it only policed the explicit channel: a CI job's own credentials
        // would ride along on every spawn and be served by an unauthenticated
        // API. These must be dropped regardless of hostname.
        for (const key of [
            "GITHUB_TOKEN",
            "NPM_TOKEN",
            "OPENAI_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "GH_COOKIE",
            "SSH_AUTH_SOCK",
            // Vendor-prefixed names carrying no secret-shaped word. These match
            // none of API_KEY, ACCESS_KEY, or PRIVATE_KEY, so a suffix-only rule
            // would forward them.
            "OPENAI_KEY",
            "GCP_SA_KEY",
            "SSH_KEY",
            "ANTHROPIC_BASE_URL",
            // Connection strings carry their credentials in the value's
            // userinfo, so the name alone reads as innocuous.
            "DATABASE_URL",
            "POSTGRES_URL",
            "REDIS_URL",
            "MONGODB_URI",
            "SENTRY_DSN",
            "STORAGE_CONNECTION_STRING",
        ]) {
            expect(isInheritableEnvKey(key)).toBe(false);
        }

        // Ordinary variables the child genuinely needs still pass through, so
        // the filter is not vacuously rejecting everything.
        for (const key of ["PATH", "HOME", "LANG", "MAGIC_CONTEXT_LOG_PATH", "MC_E2E_MODE"]) {
            expect(isInheritableEnvKey(key)).toBe(true);
        }

        // The pre-existing strips stay in force alongside the secret rule.
        for (const key of [
            "OPENCODE_SERVER_PASSWORD",
            "OPENCODE_SERVER_USERNAME",
            "NODE_ENV",
            "SUBC_MODULE_ID",
            "SUBC_LAUNCH_NONCE",
        ]) {
            expect(isInheritableEnvKey(key)).toBe(false);
        }
    });

    it("passes gold evidence verbatim in the main-agent request", async () => {
        const harness = await createHarness();
        const prompt = goldEvidencePrompt([
            { label: "constraint", content: "Keep the release channel stable." },
            { label: "value", content: "retry_limit = 3" },
        ]);
        const sessionId = await harness.createSession();

        await harness.sendPrompt(sessionId, prompt);

        const request = mainAgentRequests(harness.mock.requests()).find((candidate) =>
            JSON.stringify(candidate.body.messages).includes("Keep the release channel stable."),
        );
        expect(request).toBeDefined();
        expect(
            request ? extractMessageText(request.body, "Keep the release channel stable.") : null,
        ).toContain(prompt);
    }, 120_000);

    it("keeps quote and closing-tag content as intentional pass-through", () => {
        expect(
            goldEvidencePrompt([
                {
                    label: 'raw"label',
                    content: "Keep literal </gold-evidence> text unchanged.",
                },
            ]),
        ).toBe(
            '<gold-evidence label="raw"label">\nKeep literal </gold-evidence> text unchanged.\n</gold-evidence>',
        );
    });
});
