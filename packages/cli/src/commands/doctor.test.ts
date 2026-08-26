import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./doctor.ts", import.meta.url), "utf8");

describe("pending reset marker blocks doctor", () => {
    test("returns before any database is opened", () => {
        // The marker promises initialization stays blocked until the reset is
        // completed or rolled back. Warning and continuing let the migration
        // sweep and the backfills open context.db read-write, and those writes
        // can rebind the artifacts the marker covers, after which the recovery
        // it exists to enable is refused.
        const marker = source.indexOf("databaseResetMarkerPath(sharedDbPath)");
        expect(marker).toBeGreaterThan(-1);

        // The guard returns rather than warning and falling through.
        const guardBody = source.slice(marker, marker + 600);
        expect(guardBody).toContain("return 1");

        for (const opener of [
            "runV22BackfillCommands(",
            "runClaimsBackfillCommands(",
            "openExistingContextDatabaseForMutation(",
            "resolveAdaptersForCommand(",
        ]) {
            const at = source.indexOf(opener);
            expect(at).toBeGreaterThan(-1);
            expect(marker).toBeLessThan(at);
        }
    });
});

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

    test("dispatches shared-DB commands before interactive harness resolution", () => {
        // The shared-DB path takes no adapter input, and resolution exits 0 on
        // cancel, an empty selection, or a headless host. Dispatch placed after
        // resolution would silently skip the requested check on those paths, so
        // both shared-DB blocks (and their exit-code return) must precede the
        // resolveAdaptersForCommand call.
        const resolution = source.indexOf("resolveAdaptersForCommand(");
        expect(resolution).toBeGreaterThan(-1);
        expect(source.indexOf("runV22BackfillCommands(")).toBeLessThan(resolution);
        expect(source.indexOf("runClaimsBackfillCommands(")).toBeLessThan(resolution);
        expect(
            source.indexOf("if (sharedCommandExitCode !== null) return sharedCommandExitCode"),
        ).toBeLessThan(resolution);
    });
});
