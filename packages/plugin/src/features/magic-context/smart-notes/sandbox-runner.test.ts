import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSmartNoteCapabilities, type SmartNoteCapabilityApi } from "./capabilities";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";
import { SmartNoteNetworkError } from "./types";

const fakeCap: SmartNoteCapabilityApi = {
    readFile: async (path) => (path === "ready.txt" ? "ready" : null),
    gitHeadSha: async () => "abc123",
    gitTag: async () => "v1.2.3",
    gitLog: async () => [{ sha: "abc", subject: "initial", authorDate: "2026-01-01T00:00:00Z" }],
    httpGet: async () => ({ status: 200, body: "ok" }),
};

describe("compiled smart-note QuickJS runner", () => {
    test("runs a check with injected capabilities", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }`,
            capabilities: fakeCap,
        });
        expect(result).toEqual({ ok: true, result: { met: true } });
    });

    test("rejects malformed return values", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { return { reason: "nope" }; }`,
            capabilities: fakeCap,
        });
        expect(result.ok).toBe(false);
    });

    test("interrupts infinite loops as execution failures", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { while (true) {} }`,
            capabilities: fakeCap,
            timeoutMs: 50,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.cancelled).toBe(false);
    });

    test("returns a typed cancelled result for a pre-aborted run", async () => {
        const controller = new AbortController();
        controller.abort(new Error("sweep deadline"));

        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { return { met: true }; }`,
            capabilities: fakeCap,
            signal: controller.signal,
        });

        expect(result).toEqual({
            ok: false,
            cancelled: true,
            error: "sweep deadline",
            network: false,
        });
    });

    test("aborts host capabilities on the run timeout and frees the shared lock", async () => {
        await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { return { met: true }; }`,
            capabilities: fakeCap,
        });

        const startedAt = Date.now();
        const timedOut = (await Promise.race([
            runCompiledSmartNoteCheck({
                compiledCheck: `function check(cap) { cap.httpGet("https://example.test/"); return { met: false }; }`,
                capabilityFactory: (signal) => ({
                    ...fakeCap,
                    httpGet: () =>
                        new Promise((_resolve, reject) => {
                            const abort = () =>
                                reject(new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted"));
                            if (signal.aborted) {
                                abort();
                                return;
                            }
                            signal.addEventListener("abort", abort, { once: true });
                        }),
                }),
                timeoutMs: 100,
            }),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error("sandbox timeout did not abort the host capability")),
                    1_000,
                ),
            ),
        ])) as Awaited<ReturnType<typeof runCompiledSmartNoteCheck>>;
        const elapsed = Date.now() - startedAt;

        expect(timedOut.ok).toBe(false);
        if (!timedOut.ok) {
            expect(timedOut.network).toBe(true);
        }
        expect(elapsed).toBeGreaterThanOrEqual(50);
        expect(elapsed).toBeLessThan(1_000);

        const followup = (await Promise.race([
            runCompiledSmartNoteCheck({
                compiledCheck: `function check() { return { met: true }; }`,
                capabilities: fakeCap,
            }),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                "follow-up sandbox run stayed blocked behind the timed-out host call",
                            ),
                        ),
                    500,
                ),
            ),
        ])) as Awaited<ReturnType<typeof runCompiledSmartNoteCheck>>;
        expect(followup).toEqual({ ok: true, result: { met: true } });
    });

    test("rejects a project FIFO without wedging the shared sandbox lock", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "mc-smart-note-fifo-"));
        try {
            const fifo = path.join(dir, "events.fifo");
            const created = spawnSync("mkfifo", [fifo]);
            if (created.error || created.status !== 0) return;

            const controller = new AbortController();
            const abortTimer = setTimeout(
                () => controller.abort(new Error("sweep budget exhausted")),
                50,
            );
            const startedAt = Date.now();
            const result = await runCompiledSmartNoteCheck({
                compiledCheck: `function check(cap) { cap.readFile("events.fifo"); cap.httpGet("https://example.test/"); return { met: false }; }`,
                capabilityFactory: (signal) => ({
                    ...createSmartNoteCapabilities({ projectRoot: dir, signal }),
                    httpGet: () =>
                        new Promise((_resolve, reject) => {
                            const abort = () =>
                                reject(new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted"));
                            if (signal.aborted) abort();
                            else signal.addEventListener("abort", abort, { once: true });
                        }),
                }),
                signal: controller.signal,
                timeoutMs: 500,
            });
            clearTimeout(abortTimer);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.cancelled).toBe(true);
            expect(Date.now() - startedAt).toBeLessThan(500);

            const followup = await runCompiledSmartNoteCheck({
                compiledCheck: `function check() { return { met: true }; }`,
                capabilities: fakeCap,
            });
            expect(followup).toEqual({ ok: true, result: { met: true } });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("serializes concurrent checks whose host calls suspend (shared-module asyncify safety)", async () => {
        // The shared asyncify module has one suspension stack.
        // Concurrent checks that suspend in host awaits share that stack.
        // Concurrent host awaits corrupt the shared suspension stack.
        // Serialization must let all eight checks succeed.
        const slowCap: SmartNoteCapabilityApi = {
            ...fakeCap,
            readFile: async (path) => {
                await new Promise((r) => setTimeout(r, 5));
                return path === "ready.txt" ? "ready" : null;
            },
        };
        const check = `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }`;
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                runCompiledSmartNoteCheck({ compiledCheck: check, capabilities: slowCap }),
            ),
        );
        for (const result of results) {
            expect(result).toEqual({ ok: true, result: { met: true } });
        }
    });
});
