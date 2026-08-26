/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractMessageText, mainAgentRequests } from "../cache-analysis";
import { TestHarness } from "../harness";
import { MockProvider } from "../mock-provider/server";
import { spawnOpencode, type SpawnedOpencode } from "../opencode-runner/spawn";
import { goldEvidencePrompt } from "./gold-evidence";
import { liveModelSpawnOptions, mcOffOptions, naiveCompactionOptions } from "./presets";

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
            const killed = await Promise.allSettled([opencode.kill()]);
            const tempRoot = dirname(opencode.env.configDir);
            const removed = await Promise.allSettled([
                Promise.resolve().then(() => {
                    rmSync(tempRoot, { recursive: true, force: true });
                    expect(existsSync(tempRoot)).toBe(false);
                }),
            ]);
            const failure = [...killed, ...removed].find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );
            if (failure) throw failure.reason;
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
        // 127.0.0.1-bound server.
        const opencode = await spawnOpencode({
            mockProviderURL: baseURL,
            ...recipe,
            hostname: "0.0.0.0",
        });
        spawned.push(opencode);
        const config = JSON.parse(
            readFileSync(join(opencode.env.configDir, "opencode.json"), "utf8"),
        ) as { provider?: unknown };

        expect(config.provider).toEqual(providerBlock);
        expect(mock.requests()).toHaveLength(0);
    }, 120_000);

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
