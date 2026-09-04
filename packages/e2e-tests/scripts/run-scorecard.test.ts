import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCanonicalJsonFile } from "../../plugin/scripts/retrieval-benchmark/canonical-json";
import { parseScorecardReport } from "../src/scorecard/report-contract";
import { policyFixture, scannableDreamerReportFixture, writeReleaseTree, type ReleaseTreeOptions } from "../src/scorecard/test-fixtures";
import { HELP_REQUESTED, parseArgs, removeNamedOutput, runScorecard, type ScorecardCliArgs } from "./run-scorecard";

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

    it("removes a stale report at the output path before a run that is then refused", () => {
        const { args, lines } = release();
        mkdirSync(join(args.out, ".."), { recursive: true });
        writeFileSync(args.out, "{\"stale\":true}\n");
        const other = release({ policy: policyFixture({ maxToleratedRegressions: 2 }) });
        const swapped: ScorecardCliArgs = { ...args, sources: { ...args.sources, policies: other.args.sources.policies } };
        expect(runScorecard(swapped, (line) => lines.push(line))).toBe(2);
        expect(lines.join("")).toContain("policy-not-frozen");
        expect(existsSync(args.out)).toBe(false);
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

describe("removeNamedOutput", () => {
    it("clears the report an invocation names even when the rest of the invocation is malformed", () => {
        const root = mkdtempSync(join(tmpdir(), "scorecard-stale-"));
        roots.push(root);
        const out = join(root, "scorecard-report.json");
        writeFileSync(out, "{\"stale\":true}\n");
        const argv = ["--freeze", "f", "--freeze-fingerprint", "nope", "--out", out];
        expect(() => parseArgs(argv, "/root")).toThrow(/hex64/);
        removeNamedOutput(argv);
        expect(existsSync(out)).toBe(false);
        const scratch = join(root, "scratch.json");
        writeFileSync(out, "{\"stale\":true}\n");
        writeFileSync(scratch, "{}\n");
        const duplicated = ["--out", scratch, "--out", out];
        expect(() => parseArgs(duplicated, "/root")).toThrow(/given twice/);
        removeNamedOutput(duplicated);
        expect(existsSync(scratch)).toBe(false);
        expect(existsSync(out)).toBe(false);
        writeFileSync(out, "{\"stale\":true}\n");
        removeNamedOutput(["--out"]);
        removeNamedOutput(["--out", "--freeze", out]);
        removeNamedOutput([]);
        removeNamedOutput(["--help", "--out", out]);
        removeNamedOutput(["--out", out, "-h"]);
        expect(existsSync(out)).toBe(true);
    });

    it("leaves an output that names or lies inside an input alone, and the parser refuses that invocation", () => {
        const root = mkdtempSync(join(tmpdir(), "scorecard-overlap-"));
        roots.push(root);
        const artifacts = join(root, "artifacts");
        mkdirSync(artifacts);
        const baseline = join(root, "scorecard-report.json");
        const inside = join(artifacts, "scorecard-report.json");
        writeFileSync(baseline, "{}\n");
        writeFileSync(inside, "{}\n");
        const hex = "a".repeat(64);
        const common = ["--freeze", join(root, "freeze"), "--freeze-fingerprint", hex, "--artifacts", artifacts];
        for (const argv of [
            [...common, "--baseline", baseline, "--out", baseline],
            [...common, "--out", inside],
            [...common, "--out", artifacts],
            [...common, "--out", join(root, "freeze", "manifest.json")],
            [...common, "--policies", root, "--out", join(root, "anything.json")],
        ]) {
            expect(() => parseArgs(argv, "/root")).toThrow(/--out must not name an input/);
            removeNamedOutput(argv, "/root");
        }
        expect(existsSync(baseline)).toBe(true);
        expect(existsSync(inside)).toBe(true);
        expect(parseArgs([...common, "--baseline", baseline, "--out", join(root, "out", "report.json")], "/root").kind).toBe("run");
    });
});

describe("run-scorecard parseArgs", () => {
    const hex = "a".repeat(64);
    const base = ["--freeze", "freeze", "--freeze-fingerprint", hex, "--artifacts", "artifacts", "--out", "out.json"];

    function cli(argv: readonly string[]): ScorecardCliArgs {
        const parsed = parseArgs(argv, "/root");
        if (parsed.kind === "help") throw new Error("unexpected help request");
        return parsed;
    }

    it("resolves paths, defaults the policy locations to the e2e root, and accepts an optional baseline", () => {
        const args = cli(base);
        expect(args.sources.freeze).toEqual({ artifactDir: join(process.cwd(), "freeze"), expectedManifestFingerprint: hex });
        expect(args.sources.artifactsDir).toBe(join(process.cwd(), "artifacts"));
        expect(args.out).toBe(join(process.cwd(), "out.json"));
        expect(args.sources.policies).toEqual({
            analysisPath: "/root/prospective-holdout/policies/analysis-policy.json",
            scorecardPath: "/root/prospective-holdout/policies/scorecard-policy.json",
        });
        expect(args.sources.pairedDeltaPolicyPath).toBe("/root/pools/paired-delta-policy.json");
        expect(args.sources.baselinePath).toBeNull();
        expect(cli([...base, "--baseline", "b.json"]).sources.baselinePath).toBe(join(process.cwd(), "b.json"));
    });

    it("resolves explicit policy overrides relative to the working directory", () => {
        const args = cli([...base, "--policies", "pol", "--paired-delta-policy", "pd.json"]);
        expect(args.sources.policies).toEqual({
            analysisPath: join(process.cwd(), "pol", "analysis-policy.json"),
            scorecardPath: join(process.cwd(), "pol", "scorecard-policy.json"),
        });
        expect(args.sources.pairedDeltaPolicyPath).toBe(join(process.cwd(), "pd.json"));
    });

    it("reports a help request as a value instead of exiting, wherever the flag appears", () => {
        expect(parseArgs(["--help"], "/root")).toBe(HELP_REQUESTED);
        expect(parseArgs([...base, "-h"], "/root")).toBe(HELP_REQUESTED);
        expect(parseArgs(["--freeze", "--help"], "/root")).toBe(HELP_REQUESTED);
    });

    it("rejects missing, repeated, unknown, and malformed flags", () => {
        expect(() => cli(base.slice(2))).toThrow(/--freeze is required/);
        expect(() => cli([...base.slice(0, 4), ...base.slice(6)])).toThrow(/--artifacts is required/);
        expect(() => cli(base.slice(0, 6))).toThrow(/--out is required/);
        expect(() => cli([...base, "--out", "twice"])).toThrow(/given twice/);
        expect(() => cli([...base, "--verbose", "1"])).toThrow(/unknown argument/);
        expect(() => cli([...base, "--baseline"])).toThrow(/requires a value/);
        expect(() => cli(["--freeze", "f", "--freeze-fingerprint", "nope", "--artifacts", "a", "--out", "o"])).toThrow(/hex64/);
    });
});
