/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifyReleaseRoot } from "../prospective-holdout/release-root";
import { releaseRootFixture } from "../prospective-holdout/test-fixtures";
import type { HermeticMcHostStack } from "../rust-runner/hermetic-mc-host";
import { __spawnOpencodeTest, type IsolatedEnv } from "./spawn";

class FakeChild extends EventEmitter {
    readonly pid = 42;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    readonly signals: NodeJS.Signals[] = [];

    kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        this.signals.push(signal);
        if (signal === "SIGKILL") {
            queueMicrotask(() => {
                this.signalCode = signal;
                this.emit("exit", null, signal);
            });
        }
        return true;
    }
}

function childProcess(fake: FakeChild): ChildProcess {
    return fake as unknown as ChildProcess;
}

describe("opencode child lifecycle", () => {
    it("merges contributed providers beside the generated mock provider", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-provider-merge-"));
        const env: IsolatedEnv = {
            configDir: join(root, "config"),
            dataDir: join(root, "data"),
            cacheDir: join(root, "cache"),
            workdir: join(root, "work"),
        };
        try {
            for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
            __spawnOpencodeTest.writeConfigs(env, "http://127.0.0.1:4321", {
                mockProviderURL: "http://127.0.0.1:4321",
                openCodeConfigExtra: {
                    provider: {
                        anthropic: {
                            api: "@ai-sdk/anthropic",
                            env: ["ANTHROPIC_API_KEY"],
                            models: {
                                "claude-sonnet-4-5-20250929": {
                                    limit: { context: 32_000 },
                                },
                            },
                        },
                        "mock-anthropic": { name: "must-not-replace-generated-mock" },
                    },
                },
            });

            const config = JSON.parse(
                readFileSync(join(env.configDir, "opencode.json"), "utf8"),
            ) as {
                provider: Record<string, {
                    name?: string;
                    options?: { baseURL?: string };
                    models?: Record<string, unknown>;
                }>;
            };
            expect(Object.keys(config.provider).sort()).toEqual(["anthropic", "mock-anthropic"]);
            expect(config.provider["mock-anthropic"]?.name).toBe("Mock Anthropic");
            expect(config.provider["mock-anthropic"]?.options?.baseURL).toBe(
                "http://127.0.0.1:4321",
            );
            expect(config.provider.anthropic?.models).toHaveProperty(
                "claude-sonnet-4-5-20250929",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects inline credentials in contributed provider config before writing", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-provider-secret-"));
        const env: IsolatedEnv = {
            configDir: join(root, "config"),
            dataDir: join(root, "data"),
            cacheDir: join(root, "cache"),
            workdir: join(root, "work"),
        };
        try {
            for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
            expect(() =>
                __spawnOpencodeTest.writeConfigs(env, "http://127.0.0.1:4321", {
                    mockProviderURL: "http://127.0.0.1:4321",
                    openCodeConfigExtra: {
                        provider: {
                            anthropic: {
                                options: { apiKey: "sk-live-must-stay-in-extra-env" },
                            },
                        },
                    },
                }),
            ).toThrow(
                /credential-shaped key: openCodeConfigExtra\.provider\.anthropic\.options\.apiKey/,
            );
            expect(existsSync(join(env.configDir, "opencode.json"))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects compound credential key shapes while allowing count-like keys", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-provider-shapes-"));
        const env: IsolatedEnv = {
            configDir: join(root, "config"),
            dataDir: join(root, "data"),
            cacheDir: join(root, "cache"),
            workdir: join(root, "work"),
        };
        const write = (options: Record<string, unknown>) => () =>
            __spawnOpencodeTest.writeConfigs(env, "http://127.0.0.1:4321", {
                mockProviderURL: "http://127.0.0.1:4321",
                openCodeConfigExtra: {
                    provider: { anthropic: { options } },
                },
            });
        try {
            for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
            expect(write({ headers: { "x-api-key": "sk-live" } })).toThrow(
                /credential-shaped key: openCodeConfigExtra\.provider\.anthropic\.options\.headers\.x-api-key/,
            );
            expect(write({ accessToken: "sk-live" })).toThrow(/accessToken/);
            expect(write({ clientSecret: "sk-live" })).toThrow(/clientSecret/);
            expect(write({ secret_access_key: "sk-live" })).toThrow(/secret_access_key/);
            expect(write({ maxTokens: 4096, baseURL: "http://127.0.0.1:1" })).not.toThrow();

            // Everything in the extra config reaches the same serve config, so a
            // credential outside `provider` is refused as well.
            expect(() =>
                __spawnOpencodeTest.writeConfigs(env, "http://127.0.0.1:4321", {
                    mockProviderURL: "http://127.0.0.1:4321",
                    openCodeConfigExtra: {
                        mcp: { docs: { headers: { Authorization: "Bearer sk-live" } } },
                    },
                })
            ).toThrow(
                /credential-shaped key: openCodeConfigExtra\.mcp\.docs\.headers\.Authorization/,
            );

            // Names `isSecretKey` reads as benign: an unlisted qualifier, or no
            // case transition to split on at all.
            for (const key of [
                "masterKey",
                "dbPassword",
                "webhookSecret",
                "signingSecret",
                "encryptionKey",
                "idToken",
                "APIKEY",
                "apikey",
            ]) {
                expect(write({ [key]: "sk-live" })).toThrow(
                    new RegExp(`credential-shaped key: .*\\.${key}`),
                );
            }
            // Counting keys keep working: `token` alone is not a credential word.
            expect(write({ maxTokens: 4096, promptTokens: 12, tokenBudget: 7 })).not.toThrow();

            for (const header of ["Cookie", "Proxy-Authorization", "set-cookie"]) {
                expect(() =>
                    __spawnOpencodeTest.writeConfigs(env, "http://127.0.0.1:4321", {
                        mockProviderURL: "http://127.0.0.1:4321",
                        openCodeConfigExtra: {
                            mcp: { docs: { headers: { [header]: "sk-live" } } },
                        },
                    })
                ).toThrow(new RegExp(`credential-shaped key: .*${header}`));
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("resolves the plugin entry when spawning, not when this module was imported", () => {
        // Each spawn resolves the plugin entry so it uses a bundle created after module import.
        const repoRoot = resolve(import.meta.dir, "../../../..");
        const dist = join(repoRoot, "packages/plugin/dist/index.js");
        const distExisted = existsSync(dist);
        const stash = `${dist}.spawn-entry-test`;
        const root = mkdtempSync(join(tmpdir(), "opencode-plugin-entry-"));
        const env: IsolatedEnv = {
            configDir: join(root, "config"),
            dataDir: join(root, "data"),
            cacheDir: join(root, "cache"),
            workdir: join(root, "work"),
        };
        const pluginOf = (): string => {
            __spawnOpencodeTest.writeConfigs(env, "http://127.0.0.1:1", { mockProviderURL: "http://127.0.0.1:1" });
            return (
                JSON.parse(readFileSync(join(env.configDir, "opencode.json"), "utf8")) as { plugin: string[] }
            ).plugin[0] as string;
        };
        try {
            for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
            if (distExisted) renameSync(dist, stash);
            expect(pluginOf()).toBe(`file://${join(repoRoot, "packages/plugin/src/index.ts")}`);

            mkdirSync(dirname(dist), { recursive: true });
            writeFileSync(dist, distExisted ? readFileSync(stash) : "// built after import\n");
            expect(pluginOf()).toBe(`file://${dist}`);
        } finally {
            if (distExisted) {
                renameSync(stash, dist);
            } else {
                rmSync(dist, { force: true });
            }
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("uses selected plugin and database bytes only when release root is supplied", () => {
        const release = mkdtempSync(join(tmpdir(), "opencode-release-root-"));
        const active = mkdtempSync(join(tmpdir(), "opencode-active-root-"));
        const root = mkdtempSync(join(tmpdir(), "opencode-selected-root-"));
        const env: IsolatedEnv = {
            configDir: join(root, "config"),
            dataDir: join(root, "data"),
            cacheDir: join(root, "cache"),
            workdir: join(root, "work"),
        };
        try {
            for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
            const manifest = releaseRootFixture(release);
            const verified = verifyReleaseRoot(release, manifest, {
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            });
            __spawnOpencodeTest.initializeIsolatedContextDb(env.dataDir, verified);
            __spawnOpencodeTest.writeConfigs(env, "http://127.0.0.1:1", {
                mockProviderURL: "http://127.0.0.1:1",
                releaseRoot: verified,
            });
            const config = JSON.parse(readFileSync(join(env.configDir, "opencode.json"), "utf8")) as { plugin: string[] };
            expect(config.plugin).toEqual([`file://${join(verified.root, "packages/plugin/dist/index.js")}`]);
            const database = join(env.dataDir, "cortexkit/magic-context/context.db");
            expect(readFileSync(database, "utf8")).toBe("db");
            expect(() => accessSync(database, constants.W_OK)).not.toThrow();
        } finally {
            rmSync(release, { recursive: true, force: true });
            rmSync(active, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects startup on child spawn error", async () => {
        const child = new FakeChild();
        const startup = __spawnOpencodeTest.rejectOnSpawnError(childProcess(child));
        child.emit("error", new Error("spawn opencode ENOENT"));
        expect(String(await startup.catch((error: unknown) => error))).toContain(
            "spawn opencode ENOENT",
        );
    });

    it("escalates a SIGTERM-ignoring child and waits for exit", async () => {
        const child = new FakeChild();
        let exitObserved = false;
        child.once("exit", () => {
            exitObserved = true;
        });

        await __spawnOpencodeTest.stopChild(childProcess(child), 5);

        expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(exitObserved).toBe(true);
        expect(child.signalCode).toBe("SIGKILL");
    });

    it("stops the Rust fixture when config serialization fails before spawn", async () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-spawn-rollback-"));
        const env: IsolatedEnv = {
            configDir: join(root, "config"),
            dataDir: join(root, "data"),
            cacheDir: join(root, "cache"),
            workdir: join(root, "work"),
        };
        for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
        const fixtureState = join(env.dataDir, "fixture-state");
        writeFileSync(fixtureState, "running");

        let stopCalls = 0;
        const mcHost = {
            connectionFile: join(env.dataDir, "mc-host-connection.json"),
            async stop(): Promise<void> {
                stopCalls++;
                rmSync(root, { recursive: true, force: true });
            },
        } as HermeticMcHostStack;
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const previousMode = process.env.MC_E2E_MODE;
        process.env.MC_E2E_MODE = "rust";

        try {
            const error = await __spawnOpencodeTest
                .spawnOpencodeWithProvision(
                    {
                        mockProviderURL: "http://127.0.0.1:1",
                        port: 1,
                        openCodeConfigExtra: cyclic,
                    },
                    async () => ({ env, connectionFile: mcHost.connectionFile, mcHost }),
                )
                .catch((failure: unknown) => failure);

            expect(String(error)).toContain("cyclic structures");
            expect(stopCalls).toBe(1);
            expect(existsSync(fixtureState)).toBe(false);
            expect(existsSync(dirname(env.dataDir))).toBe(false);
        } finally {
            if (previousMode === undefined) delete process.env.MC_E2E_MODE;
            else process.env.MC_E2E_MODE = previousMode;
            rmSync(root, { recursive: true, force: true });
        }
    });
});
