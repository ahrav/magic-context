import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { UnifiedSearchResult } from "./search";
import { encodePhysicalResultLocator, parsePhysicalResultLocator } from "./search-result-locator";

function result(partial: Record<string, unknown>): UnifiedSearchResult {
    return partial as unknown as UnifiedSearchResult;
}

describe("encodePhysicalResultLocator", () => {
    const cases: Array<[UnifiedSearchResult, string]> = [
        [result({ source: "memory", memoryId: 42 }), "memory:42"],
        [result({ source: "message", messageId: "msg_abc123" }), "message:msg_abc123"],
        [result({ source: "compartment", compartmentId: 7 }), "chunk:7"],
        [
            result({ source: "git_commit", sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" }),
            "commit:a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        ],
        [result({ source: "primer", primerId: 3 }), "primer:3"],
        [result({ source: "note", noteId: 11 }), "note:11"],
    ];

    it("encodes every source to the exact legacy measurement string", () => {
        for (const [input, expected] of cases) {
            expect(encodePhysicalResultLocator(input)).toBe(expected);
        }
    });

    it("round-trips kind and local locator through the parser", () => {
        for (const [, encoded] of cases) {
            const parsed = parsePhysicalResultLocator(encoded);
            expect(parsed.ok).toBe(true);
            if (parsed.ok) {
                expect(`${parsed.value.kind}:${parsed.value.locator}`).toBe(encoded);
            }
        }
    });
});

describe("parsePhysicalResultLocator", () => {
    it("rejects malformed locators with deterministic non-sensitive reasons", () => {
        expect(parsePhysicalResultLocator("")).toEqual({ ok: false, reason: "missing-separator" });
        expect(parsePhysicalResultLocator("memory42")).toEqual({
            ok: false,
            reason: "missing-separator",
        });
        expect(parsePhysicalResultLocator(":42")).toEqual({
            ok: false,
            reason: "missing-separator",
        });
        expect(parsePhysicalResultLocator("claim:42")).toEqual({
            ok: false,
            reason: "unknown-kind",
        });
        expect(parsePhysicalResultLocator("compartment:42")).toEqual({
            ok: false,
            reason: "unknown-kind",
        });
        expect(parsePhysicalResultLocator("git_commit:abc")).toEqual({
            ok: false,
            reason: "unknown-kind",
        });
        expect(parsePhysicalResultLocator("memory:")).toEqual({
            ok: false,
            reason: "empty-locator",
        });
    });

    it("failure objects never echo the raw input", () => {
        const sensitive = "unknown:/home/someuser/.ssh/id_rsa";
        const parsed = parsePhysicalResultLocator(sensitive);
        expect(JSON.stringify(parsed)).not.toContain("someuser");
    });
});

describe("layering", () => {
    it("production locator code has no import edge to the benchmark scripts", () => {
        const source = readFileSync(join(import.meta.dir, "search-result-locator.ts"), "utf8");
        const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
        expect(importLines.some((line) => line.includes("retrieval-benchmark"))).toBe(false);
    });

    it("no production magic-context module imports the benchmark scripts", () => {
        const dir = import.meta.dir;
        // Recursive: subdirectories (memory/, dreamer/, ...) are production
        // modules too and must honor the same layering invariant.
        for (const name of readdirSync(dir, { recursive: true }) as string[]) {
            if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
            const source = readFileSync(join(dir, name), "utf8");
            expect(source.includes("scripts/retrieval-benchmark")).toBe(false);
        }
    });
});
