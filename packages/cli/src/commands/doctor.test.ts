import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./doctor.ts", import.meta.url), "utf8");

describe("unified doctor claims backfill dispatch", () => {
    test("owns one shared-database dispatch before the per-harness loop", () => {
        expect(source.match(/runClaimsBackfillCommands\s*\(/g)).toHaveLength(1);
        expect(source.indexOf("runClaimsBackfillCommands(")).toBeLessThan(
            source.indexOf("for (const adapter of adapters)"),
        );
    });
});
