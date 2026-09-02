import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, scorecardUnitFiles } from "./run-test-selection";

describe("scorecard unit selection", () => {
    it("selects every scorecard test file plus the operator script test when present", () => {
        const files = scorecardUnitFiles();
        expect(files.length).toBeGreaterThan(0);
        expect(files.every((file) => file.startsWith("src/scorecard/") || file === "scripts/run-scorecard.test.ts")).toBe(true);
        expect(files).toEqual([...files].sort());
    });

    it("fails when the scorecard glob matches nothing", () => {
        const root = mkdtempSync(join(tmpdir(), "scorecard-selection-"));
        try {
            mkdirSync(join(root, "src", "scorecard"), { recursive: true });
            expect(() => scorecardUnitFiles(root)).toThrow(/scorecard unit selection is empty/);
            writeFileSync(join(root, "src", "scorecard", "policy.test.ts"), "");
            expect(scorecardUnitFiles(root)).toEqual(["src/scorecard/policy.test.ts"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("parses --scorecard-unit as a unit selection", () => {
        expect(parseArgs(["--scorecard-unit"]).selection).toEqual({ kind: "unit", flag: "--scorecard-unit" });
        expect(() => parseArgs(["--scorecard-unit", "--paired-delta-unit"])).toThrow(/select exactly one/);
    });
});
