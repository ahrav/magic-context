import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearModelsDevCache,
    getModelsDevCacheState,
    getSdkContextLimit,
    getSdkInputLimit,
    getSdkWindowGeometry,
    refreshModelLimitsAfterAuthOnce,
    refreshModelLimitsFromApi,
    resetAuthRewarmLatchForTest,
    resolveLimit,
    setOutputReserveConfig,
} from "./models-dev-cache";

/**
 * Model context limits resolve from OpenCode's SDK only (`config.providers()`),
 * The cache bounds limits to [20k, 3M] and persists last-known-good values for cold start.
 * The cache does not read OpenCode's `models.json` file.
 */
describe("output-token reservation", () => {
    beforeEach(() => setOutputReserveConfig(undefined));

    test("keeps a pre-carved OpenAI catalog input limit unchanged", () => {
        expect(
            resolveLimit(
                { context: 1_050_000, input: 922_000, output: 128_000 },
                "openai",
                "gpt-5.4",
            ),
        ).toBe(922_000);
    });

    test("input equal to context falls through to shared-window reservation", () => {
        expect(
            resolveLimit(
                { context: 372_000, input: 372_000, output: 64_000 },
                "openai",
                "literal-config",
            ),
        ).toBe(308_000);
    });

    test("reserves output for Anthropic shared windows", () => {
        expect(resolveLimit({ context: 1_000_000, output: 64_000 }, "anthropic", "claude")).toBe(
            936_000,
        );
    });

    test("makes the reporter's 95% send safe under the shared provider wall", () => {
        const usable = resolveLimit(
            { context: 122_880, output: 16_384 },
            "openai-compatible",
            "reporter-model",
        );
        expect(usable).toBe(106_496);
        expect((usable ?? 0) * 0.95 + 16_384).toBeLessThanOrEqual(131_072);
    });

    test("caps absurd catalog output at 25% of context", () => {
        expect(
            resolveLimit({ context: 100_000, output: 60_000 }, "anthropic", "absurd-output"),
        ).toBe(75_000);
    });

    test("keeps proven separate-quota Gemini windows unchanged", () => {
        expect(
            resolveLimit({ context: 1_048_576, output: 65_536 }, "google", "gemini-2.5-pro"),
        ).toBe(1_048_576);
        expect(
            resolveLimit(
                { context: 1_048_576, output: 65_536 },
                "google-antigravity",
                "gemini-2.5-pro",
            ),
        ).toBe(1_048_576);
    });

    test("output_reserve accepts both harness provider spellings with canonical precedence", () => {
        const limit = { context: 100_000, output: 20_000 };
        expect(
            resolveLimit(limit, "openai-codex", "gpt-5.6-sol", {
                default: 0,
                "openai-codex/gpt-5.6-sol": 8_000,
            }),
        ).toBe(92_000);
        expect(
            resolveLimit(limit, "openai-codex", "gpt-5.6-sol", {
                default: 0,
                "openai-codex/gpt-5.6-sol": 8_000,
                "openai/gpt-5.6-sol": 4_000,
            }),
        ).toBe(96_000);
    });

    test("output_reserve overrides shared and separate quota defaults", () => {
        expect(resolveLimit({ context: 100_000, output: 20_000 }, "anthropic", "claude", 0)).toBe(
            100_000,
        );
        const perModelReserve = { default: 4_000, "google/gemini": 8_000 };
        expect(
            resolveLimit({ context: 100_000, output: 20_000 }, "google", "gemini", perModelReserve),
        ).toBe(92_000);
        expect(
            resolveLimit(
                { context: 100_000, output: 20_000 },
                "google-antigravity",
                "gemini",
                perModelReserve,
            ),
        ).toBe(92_000);
    });

    test("clamps reservation to both the 50% and 1024-token usable floors", () => {
        expect(resolveLimit({ context: 100_000 }, "custom", "tiny", 90_000)).toBe(50_000);
        expect(resolveLimit({ context: 1_200 }, "custom", "micro", 1_000)).toBe(1_024);
    });
});

describe("models-dev-cache (SDK-only)", () => {
    let tempDir: string;
    let originalXdgData: string | undefined;

    function makeClient(providers: Array<unknown>) {
        return { config: { providers: async () => ({ data: { providers } }) } };
    }

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "mc-models-dev-"));
        // Use a temp data dir so tests never touch the real `~/.local/share/cortexkit/magic-context` cache.
        originalXdgData = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = tempDir;
        setOutputReserveConfig(undefined);
        clearModelsDevCache();
    });

    afterEach(() => {
        if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdgData;
        try {
            rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Cache cleanup ignores `EBUSY` errors on Windows. */
        }
        clearModelsDevCache();
    });

    test("honors the reporter's default output_reserve on the SDK geometry path", async () => {
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "openai-codex",
                    models: {
                        "gpt-5.6-sol": {
                            limit: { context: 400_000, input: 272_000, output: 128_000 },
                        },
                    },
                },
            ]),
        );
        setOutputReserveConfig({ default: 16_384 });

        const geometry = getSdkWindowGeometry("openai-codex", "gpt-5.6-sol");
        expect(geometry?.usableSoft).toBe(272_000 - 16_384);
        expect(geometry?.derivation).toMatchObject({
            window: 272_000,
            reserve: 16_384,
            reserveSource: "output_config",
        });
    });

    test("resolves from the SDK and prefers limit.input over limit.context", async () => {
        // GitHub Copilot and Codex report `input` as the maximum prompt and `context` as the total window.
        // Pressure math uses the input cap.
        // github-copilot and codex use the same shape, so a 400k-context / 272k-input model resolves to 272k.
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "github-copilot",
                    models: {
                        "gpt-5.3-codex": { limit: { context: 400000, input: 272000 } },
                        "legacy-only-context": { limit: { context: 100000 } },
                    },
                },
            ]),
        );

        expect(getSdkContextLimit("github-copilot", "gpt-5.3-codex")).toBe(272000);
        expect(getSdkInputLimit("github-copilot", "gpt-5.3-codex")).toBe(272000);
        expect(getSdkContextLimit("github-copilot", "legacy-only-context")).toBe(100000);
        expect(getSdkInputLimit("github-copilot", "legacy-only-context")).toBeUndefined();
        expect(getSdkContextLimit("unknown", "unknown")).toBeUndefined();
    });

    test("Codex-OAuth cap is honored: a 400k/272k gpt-5.5 resolves to 272k (not the stale 922k)", async () => {
        // The auth-resolved SDK cap overrides larger stale cached values.
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "openai",
                    models: { "gpt-5.5": { limit: { context: 400000, input: 272000 } } },
                },
            ]),
        );
        expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
        expect(getSdkInputLimit("openai", "gpt-5.5")).toBe(272000);
    });

    test("derived experimental.modes inherit the effective (input) limit", async () => {
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "openai",
                    models: {
                        "gpt-5.4": {
                            limit: { context: 1050000, input: 922000 },
                            experimental: { modes: { fast: {}, mini: {} } },
                        },
                    },
                },
            ]),
        );
        expect(getSdkContextLimit("openai", "gpt-5.4")).toBe(922000);
        expect(getSdkContextLimit("openai", "gpt-5.4-fast")).toBe(922000);
        expect(getSdkContextLimit("openai", "gpt-5.4-mini")).toBe(922000);
    });

    test("narrows raw context with detected wire truth before reserving output", async () => {
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "anthropic",
                    models: {
                        claude: { limit: { context: 200_000, output: 20_000 } },
                    },
                },
            ]),
        );

        expect(
            getSdkContextLimit("anthropic", "claude", 120_000, {
                detectedLimitProvenance: "combined",
            }),
        ).toBe(100_000);
        // A provider-reported prompt ceiling is pre-carved, so the resolver must not subtract the 20K output allowance again.
        // The resolver must not subtract the 20K output allowance from a provider-reported pre-carved prompt ceiling.
        expect(
            getSdkContextLimit("anthropic", "claude", 120_000, {
                detectedLimitProvenance: "prompt_only",
            }),
        ).toBe(120_000);
    });

    test("matches a tagged ollama model against its tag-less SDK entry", async () => {
        await refreshModelLimitsFromApi(
            makeClient([
                {
                    id: "ollama-cloud",
                    models: {
                        "deepseek-v4-pro": { limit: { context: 1048576 } },
                        "gemma3:27b": { limit: { context: 131072 } },
                    },
                },
            ]),
        );
        // Tagged invocation falls back to the tag-less entry.
        expect(getSdkContextLimit("ollama-cloud", "deepseek-v4-pro:cloud")).toBe(1048576);
        // Exact tagged matches take precedence over tag-less fallback.
        expect(getSdkContextLimit("ollama-cloud", "gemma3:27b")).toBe(131072);
        // Unknown tagged model with no tag-less base stays undefined.
        expect(getSdkContextLimit("ollama-cloud", "nonexistent:cloud")).toBeUndefined();
    });

    describe("sanity bounds [20k, 3M]", () => {
        test("rejects an implausibly small limit (torn-read garbage like 6748)", async () => {
            await refreshModelLimitsFromApi(
                makeClient([
                    {
                        id: "ollama-cloud",
                        // The resolver rejects limits below 20,000.
                        // The resolver rejects limits below 20,000.
                        models: { "deepseek-v4-pro": { limit: { context: 6748 } } },
                    },
                ]),
            );
            expect(getSdkContextLimit("ollama-cloud", "deepseek-v4-pro")).toBeUndefined();
        });

        test("rejects a below-floor 8192 num_ctx default", async () => {
            await refreshModelLimitsFromApi(
                makeClient([{ id: "p", models: { m: { limit: { context: 8192 } } } }]),
            );
            expect(getSdkContextLimit("p", "m")).toBeUndefined();
        });

        test("rejects an impossibly large limit (> 3M)", async () => {
            await refreshModelLimitsFromApi(
                makeClient([{ id: "p", models: { m: { limit: { context: 5_000_000 } } } }]),
            );
            expect(getSdkContextLimit("p", "m")).toBeUndefined();
        });

        test("accepts values exactly on the bounds", async () => {
            await refreshModelLimitsFromApi(
                makeClient([
                    {
                        id: "p",
                        models: {
                            lo: { limit: { context: 20000 } },
                            hi: { limit: { context: 3000000 } },
                        },
                    },
                ]),
            );
            expect(getSdkContextLimit("p", "lo")).toBe(20000);
            expect(getSdkContextLimit("p", "hi")).toBe(3000000);
        });
    });

    describe("persisted cache (cold start)", () => {
        test("seeds from the persisted file after a clear (restart simulation)", async () => {
            await refreshModelLimitsFromApi(
                makeClient([{ id: "openai", models: { "gpt-5.5": { limit: { input: 272000 } } } }]),
            );
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
            expect(getSdkInputLimit("openai", "gpt-5.5")).toBe(272000);

            // With no in-memory cache, the next lookup seeds from `XDG_DATA_HOME`.
            // The cache file remains under `XDG_DATA_HOME`; the next lookup seeds from disk.
            clearModelsDevCache();
            expect(getModelsDevCacheState().apiLoaded).toBe(false);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
            expect(getModelsDevCacheState().apiLoaded).toBe(true);
        });

        test("does not persist or seed insane values", async () => {
            await refreshModelLimitsFromApi(
                makeClient([
                    {
                        id: "p",
                        models: {
                            good: { limit: { context: 200000 } },
                            bad: { limit: { context: 6748 } },
                        },
                    },
                ]),
            );
            clearModelsDevCache();
            expect(getSdkContextLimit("p", "good")).toBe(200000);
            expect(getSdkContextLimit("p", "bad")).toBeUndefined();
        });
    });

    describe("after-auth re-warm (once per process)", () => {
        // Startup warming can cache pre-auth limits; the first authenticated usage event refreshes and persists the auth-resolved cap once.
        // Startup warming can cache pre-auth limits; the first authenticated usage event refreshes and persists the auth-resolved cap once.
        // Startup warming can cache pre-auth limits; the first authenticated usage event refreshes and persists the auth-resolved cap once.
        // Startup warming can cache pre-auth limits; the first authenticated usage event refreshes and persists the auth-resolved cap once.
        function makeCountingClient(input: number) {
            let calls = 0;
            return {
                client: {
                    config: {
                        providers: async () => {
                            calls++;
                            return {
                                data: {
                                    providers: [
                                        {
                                            id: "openai",
                                            models: { "gpt-5.5": { limit: { input } } },
                                        },
                                    ],
                                },
                            };
                        },
                    },
                },
                calls: () => calls,
            };
        }

        test("re-warm overwrites a stale pre-auth limit and runs only once per process", async () => {
            resetAuthRewarmLatchForTest();
            await refreshModelLimitsFromApi(
                makeClient([{ id: "openai", models: { "gpt-5.5": { limit: { input: 922000 } } } }]),
            );
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(922000);

            const { client, calls } = makeCountingClient(272000);
            await refreshModelLimitsAfterAuthOnce(client);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
            expect(calls()).toBe(1);

            // Subsequent usage events are a no-op (latch held).
            await refreshModelLimitsAfterAuthOnce(client);
            await refreshModelLimitsAfterAuthOnce(client);
            expect(calls()).toBe(1);
        });

        test("a failed re-warm resets the latch so a later usage event retries", async () => {
            resetAuthRewarmLatchForTest();
            let calls = 0;
            const flaky = {
                config: {
                    providers: async () => {
                        calls++;
                        // An empty payload does not warm the cache.
                        if (calls === 1) return { data: { providers: [] } };
                        return {
                            data: {
                                providers: [
                                    {
                                        id: "openai",
                                        models: { "gpt-5.5": { limit: { input: 272000 } } },
                                    },
                                ],
                            },
                        };
                    },
                },
            };
            await refreshModelLimitsAfterAuthOnce(flaky);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBeUndefined();
            // A failure resets the latch, so the next event retries and succeeds.
            await refreshModelLimitsAfterAuthOnce(flaky);
            expect(getSdkContextLimit("openai", "gpt-5.5")).toBe(272000);
            expect(calls).toBe(2);
        });
    });

    describe("startup retry", () => {
        test("retries when the provider payload is empty, then succeeds", async () => {
            let calls = 0;
            const client = {
                config: {
                    providers: async () => {
                        calls++;
                        if (calls === 1) return { data: { providers: [] } };
                        return {
                            data: {
                                providers: [
                                    { id: "p", models: { m: { limit: { context: 200000 } } } },
                                ],
                            },
                        };
                    },
                },
            };
            await refreshModelLimitsFromApi(client, { retries: 2, retryDelayMs: 1 });
            expect(calls).toBe(2);
            expect(getSdkContextLimit("p", "m")).toBe(200000);
        });

        test("stops early on first successful load (no wasted retries)", async () => {
            let calls = 0;
            const client = {
                config: {
                    providers: async () => {
                        calls++;
                        return {
                            data: {
                                providers: [
                                    { id: "p", models: { m: { limit: { context: 200000 } } } },
                                ],
                            },
                        };
                    },
                },
            };
            await refreshModelLimitsFromApi(client, { retries: 3, retryDelayMs: 1 });
            expect(calls).toBe(1);
        });
    });

    test("tolerates empty / malformed / thrown responses without populating", async () => {
        await refreshModelLimitsFromApi({
            config: { providers: async () => ({ data: undefined }) },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);

        await refreshModelLimitsFromApi({
            config: { providers: async () => ({ data: { providers: "not an array" } }) },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);

        await refreshModelLimitsFromApi({
            config: {
                providers: async () => {
                    throw new Error("network error");
                },
            },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);
    });

    test("repeated refreshes replace cache state without corruption", async () => {
        const clientA = makeClient([
            {
                id: "p",
                models: {
                    m1: { limit: { context: 200000 } },
                    m2: { limit: { context: 200000 } },
                    m3: { limit: { context: 200000 } },
                },
            },
        ]);
        const clientB = makeClient([
            {
                id: "p",
                models: { m1: { limit: { context: 200000 } }, m2: { limit: { context: 200000 } } },
            },
        ]);

        await refreshModelLimitsFromApi(clientA);
        expect(getModelsDevCacheState().apiCount).toBe(3);
        await refreshModelLimitsFromApi(clientB);
        expect(getModelsDevCacheState().apiCount).toBe(2);
        await refreshModelLimitsFromApi(clientA);
        expect(getModelsDevCacheState().apiCount).toBe(3);

        expect(getSdkContextLimit("p", "m1")).toBe(200000);
        expect(getSdkContextLimit("p", "m3")).toBe(200000);
    });
});

describe("getSdkContextLimit prompt_only pre-carve arm", () => {
    // A `prompt_only` detected limit uses the input arm and does not subtract output reservation.
    // Combined detections narrow raw context before output reservation.
    // Combined detections narrow raw context before output reservation; routing `prompt_only` through the context arm subtracts output reservation twice.
    // Routing `prompt_only` through the context arm subtracts output reservation twice.
    beforeEach(() => clearModelsDevCache());
    afterEach(() => clearModelsDevCache());
    const seed = () =>
        refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "anthropic",
                                models: {
                                    "prov-model": {
                                        limit: { context: 200000, output: 64000 },
                                    },
                                },
                            },
                        ],
                    },
                }),
            },
        });

    test("prompt_only detection routes through the input arm without double reservation", async () => {
        await seed();
        expect(
            getSdkContextLimit("anthropic", "prov-model", 167000, {
                detectedLimitProvenance: "prompt_only",
            }),
        ).toBe(167000);
    });

    test("combined detection narrows raw context before reservation", async () => {
        await seed();
        expect(
            getSdkContextLimit("anthropic", "prov-model", 131072, {
                detectedLimitProvenance: "combined",
            }),
        ).toBe(131072 - 32768);
    });

    test("prompt_only with reservation none serves the prompt cap as the native denominator", async () => {
        await seed();
        // With `reservation: "none"`, the input arm returns the provider-enforced prompt cap without consulting the raw window.
        // With `reservation: "none"`, the input arm returns the provider-enforced prompt cap without consulting the raw window.
        expect(
            getSdkContextLimit("anthropic", "prov-model", 167000, {
                detectedLimitProvenance: "prompt_only",
                reservation: "none",
            }),
        ).toBe(167000);
    });
});
