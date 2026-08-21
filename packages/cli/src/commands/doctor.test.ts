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

    test("runs mixed v22 and claims flags sequentially and combines their exit status", () => {
        const v22 = source.indexOf("runV22BackfillCommands(");
        const claims = source.indexOf("runClaimsBackfillCommands(");
        const combinedReturn = source.indexOf(
            "if (sharedCommandExitCode !== null) return sharedCommandExitCode",
        );
        expect(v22).toBeLessThan(claims);
        expect(claims).toBeLessThan(combinedReturn);
        expect(
            source.match(/Math\.max\(sharedCommandExitCode \?\? 0, result\.exitCode\)/g),
        ).toHaveLength(2);
    });
});
