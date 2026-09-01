import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSmartNoteCapabilities, type SmartNoteCapabilityApi } from "./capabilities";
import {
    manifestAdvisoryWarnings,
    normalizeCompiledCheck,
    normalizeCron,
    normalizeManifest,
    parseCompilerOutput,
} from "./compiler";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";

const fakeCap: SmartNoteCapabilityApi = {
    readFile: async (filePath) => (filePath === "ready.txt" ? "ready" : null),
    gitHeadSha: async () => "abc123",
    gitTag: async () => "v1.2.3",
    gitLog: async () => [{ sha: "abc", subject: "initial", authorDate: "2026-01-01T00:00:00Z" }],
    httpGet: async () => ({ status: 200, body: "ok" }),
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "mc-smart-note-compiler-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("smart-note compiler runtime boundary", () => {
    test("blocks .envrc reads at runtime", async () => {
        await withTempDir(async (dir) => {
            await writeFile(path.join(dir, ".envrc"), "SECRET=1", "utf8");
            const result = await runCompiledSmartNoteCheck({
                compiledCheck: `function check(cap) { return { met: cap.readFile(".envrc") !== null }; }`,
                capabilities: createSmartNoteCapabilities({
                    projectRoot: dir,
                    signal: new AbortController().signal,
                }),
            });

            expect(result).toEqual({ ok: true, result: { met: false } });
        });
    });

    test("blocks internal metadata IP fetches at runtime", async () => {
        await withTempDir(async (dir) => {
            const result = await runCompiledSmartNoteCheck({
                compiledCheck: `function check(cap) { cap.httpGet("https://169.254.169.254/latest/meta-data/"); return { met: true }; }`,
                capabilities: createSmartNoteCapabilities({
                    projectRoot: dir,
                    signal: new AbortController().signal,
                }),
            });

            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toContain("internal address");
        });
    });

    test("enforces sandbox time limits", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { while (true) {} }`,
            capabilities: fakeCap,
            timeoutMs: 100,
        });

        expect(result.ok).toBe(false);
    });

    test("enforces sandbox memory limits", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { const chunks = []; for (let i = 0; i < 100; i++) chunks.push(new ArrayBuffer(1024 * 1024)); return { met: false }; }`,
            capabilities: fakeCap,
            heapLimitBytes: 64 * 1024,
            timeoutMs: 1_000,
        });

        expect(result.ok).toBe(false);
    });

    test("does not expose the raw host capability bridge to guest code", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" && typeof __mcHostCap === "undefined" && !Object.prototype.hasOwnProperty.call(globalThis, "__mcHostCap") }; }`,
            capabilities: fakeCap,
        });

        expect(result).toEqual({ ok: true, result: { met: true } });
    });

    test("treats manifest drift as advisory instead of enforcement", async () => {
        const compiledCheck = `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }`;
        expect(manifestAdvisoryWarnings(compiledCheck, { capabilities: [] })).toContain(
            "manifest omits capability readFile",
        );

        const result = await runCompiledSmartNoteCheck({ compiledCheck, capabilities: fakeCap });
        expect(result).toEqual({ ok: true, result: { met: true } });
    });
});

describe("smart-note compiler output bounds", () => {
    test("rejects impossible cron expressions within the scheduling ceiling", () => {
        const startedAt = performance.now();
        expect(() => normalizeCron("0 0 31 2 *")).toThrow(/scheduling ceiling/);
        expect(performance.now() - startedAt).toBeLessThan(50);
    });

    test("bounds compiler output, source, manifest entries, and cron length", () => {
        expect(() => parseCompilerOutput("x".repeat(128 * 1024 + 1))).toThrow(/128 KiB/);
        expect(() =>
            normalizeCompiledCheck(
                `function check() { return { met: false }; }/*${"x".repeat(64 * 1024)}*/`,
            ),
        ).toThrow(/64 KiB/);
        expect(
            normalizeManifest({
                capabilities: [],
                signals: Array.from({ length: 100 }, (_, index) => `signal-${index}`),
            }).signals,
        ).toHaveLength(64);
        expect(() =>
            normalizeManifest({
                capabilities: [],
                signals: Array.from(
                    { length: 4 },
                    (_, index) => `${index}-${"s".repeat(10 * 1024)}`,
                ),
            }),
        ).toThrow(/32 KiB/);
        expect(() => normalizeCron("*".repeat(257))).toThrow(/256 bytes/);
    });
});

describe("wire-limit parity with the Rust module (static)", () => {
    test("MAX_MANIFEST_BYTES matches NOTE_EVALUATOR_MAX_MANIFEST_BYTES", () => {
        // TypeScript must reject manifests larger than the module limit.
        const tsSource = readFileSync(path.join(import.meta.dir, "compiler.ts"), "utf8");
        const rustSource = readFileSync(
            path.join(import.meta.dir, "../../../../../../crates/mc-module/src/lib.rs"),
            "utf8",
        );
        const tsLimit = tsSource.match(/const MAX_MANIFEST_BYTES = (.+);/)?.[1];
        const rustLimit = rustSource.match(
            /const NOTE_EVALUATOR_MAX_MANIFEST_BYTES: usize = (.+);/,
        )?.[1];
        expect(tsLimit).toBeDefined();
        expect(rustLimit).toBeDefined();
        expect(tsLimit).toBe(rustLimit);
    });
});
