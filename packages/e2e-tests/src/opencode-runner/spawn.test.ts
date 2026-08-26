/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
