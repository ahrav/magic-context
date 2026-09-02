import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCanonicalJsonFile } from "../../plugin/scripts/retrieval-benchmark/canonical-json";
import { parseScorecardReport } from "../src/scorecard/report-contract";
import { policyFixture, scannableDreamerReportFixture, writeReleaseTree, type ReleaseTreeOptions } from "../src/scorecard/test-fixtures";
import { parseArgs, runScorecard, type ScorecardCliArgs } from "./run-scorecard";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function release(options: ReleaseTreeOptions = {}): { args: ScorecardCliArgs; root: string; lines: string[] } {
    const root = mkdtempSync(join(tmpdir(), "scorecard-script-"));
    roots.push(root);
    const sources = writeReleaseTree(root, { lanes: { dreamer: [scannableDreamerReportFixture()] }, ...options });
    return { args: { sources, out: join(root, "out", "scorecard-report.json") }, root, lines: [] };
}

describe("run-scorecard", () => {
    it("publishes a canonical report over lane-built fixtures and exits 2 with four not-observed gates", () => {
        const { args, lines } = release();
        const code = runScorecard(args, (line) => lines.push(line));
        expect(code).toBe(2);
        const report = parseScorecardReport(readCanonicalJsonFile(args.out, (failure) => new Error(failure)));
        expect(report.body.safetyGates.filter((row) => row.status === "not-observed")).toHaveLength(4);
        expect(report.body.safetyGates.find((row) => row.gateId === "gate-injection-promoted")?.status).toBe("passed");
        expect(report.body.evidence.lanes.every((row) => row.status === "present")).toBe(true);
        expect(report.body.outcome.mandatoryEvidenceComplete).toBe(true);
        const printed = JSON.parse(lines.join("")) as { reportFingerprint: string; outcome: unknown };
        expect(printed.reportFingerprint).toBe(report.reportFingerprint);
        expect(printed.outcome).toEqual(report.body.outcome);
    });

    it("refuses without writing a report when the freeze manifest does not bind the policy", () => {
        const { args, lines } = release();
        const other = release({ policy: policyFixture({ maxToleratedRegressions: 2 }) });
        const swapped: ScorecardCliArgs = { ...args, sources: { ...args.sources, policies: other.args.sources.policies } };
        expect(runScorecard(swapped, (line) => lines.push(line))).toBe(2);
        expect(existsSync(args.out)).toBe(false);
        expect(lines.join("")).toContain("policy-not-frozen");
        expect(existsSync(join(args.out, ".."))).toBe(false);
    });

    it("still publishes a report when a lane artifact is absent and records the lane as missing", () => {
        const { args } = release({ omitLanes: ["retrieval"] });
        expect(runScorecard(args, () => {})).toBe(2);
        const report = parseScorecardReport(readCanonicalJsonFile(args.out, (failure) => new Error(failure)));
        expect(report.body.evidence.lanes.find((row) => row.lane === "retrieval")).toMatchObject({ status: "missing", reportFingerprint: null });
        expect(report.body.outcome.mandatoryEvidenceComplete).toBe(false);
        expect(readdirSync(join(args.out, "..")).sort()).toEqual(["scorecard-report.json"]);
    });
});

describe("run-scorecard parseArgs", () => {
    const hex = "a".repeat(64);
    const base = ["--freeze", "freeze", "--freeze-fingerprint", hex, "--artifacts", "artifacts", "--out", "out.json"];

    it("resolves paths, defaults the policy locations to the e2e root, and accepts an optional baseline", () => {
        const args = parseArgs(base, "/root");
        expect(args.sources.freeze).toEqual({ artifactDir: join(process.cwd(), "freeze"), expectedManifestFingerprint: hex });
        expect(args.sources.policies.scorecardPath).toBe("/root/prospective-holdout/policies/scorecard-policy.json");
        expect(args.sources.pairedDeltaPolicyPath).toBe("/root/pools/paired-delta-policy.json");
        expect(args.sources.baselinePath).toBeNull();
        expect(parseArgs([...base, "--baseline", "b.json"], "/root").sources.baselinePath).toBe(join(process.cwd(), "b.json"));
    });

    it("rejects missing, repeated, unknown, and malformed flags", () => {
        expect(() => parseArgs(base.slice(2), "/root")).toThrow(/--freeze is required/);
        expect(() => parseArgs([...base, "--out", "twice"], "/root")).toThrow(/given twice/);
        expect(() => parseArgs([...base, "--verbose", "1"], "/root")).toThrow(/unknown argument/);
        expect(() => parseArgs([...base, "--baseline"], "/root")).toThrow(/requires a value/);
        expect(() => parseArgs(["--freeze", "f", "--freeze-fingerprint", "nope", "--artifacts", "a", "--out", "o"], "/root")).toThrow(/hex64/);
    });
});
