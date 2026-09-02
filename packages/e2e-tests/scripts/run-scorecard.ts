#!/usr/bin/env bun

import { join, resolve } from "node:path";
import { HEX64_RE } from "../src/contract-primitives";
import { loadEvidenceBundle, type EvidenceSources } from "../src/scorecard/evidence";
import { ScorecardContractError } from "../src/scorecard/policy";
import { buildScorecardReport, publishScorecardReport, scorecardExitCode, type ScorecardExitCode } from "../src/scorecard/report";
import { E2E_ROOT } from "./validate-mode-manifest";

export interface ScorecardCliArgs {
    sources: EvidenceSources;
    out: string;
}

const USAGE = "Usage: run-scorecard.ts --freeze <manifest-dir> --freeze-fingerprint <hex64> --artifacts <dir> --out <path> "
    + "[--policies <dir>] [--paired-delta-policy <path>] [--baseline <path>]";
const KNOWN_FLAGS = ["--freeze", "--freeze-fingerprint", "--artifacts", "--out", "--policies", "--paired-delta-policy", "--baseline"];

export function parseArgs(argv: readonly string[], root: string = E2E_ROOT): ScorecardCliArgs {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index]!;
        if (flag === "--help" || flag === "-h") {
            console.log(USAGE);
            process.exit(0);
        }
        const value = argv[index + 1];
        if (!KNOWN_FLAGS.includes(flag)) throw new Error(`unknown argument: ${flag}\n${USAGE}`);
        if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value\n${USAGE}`);
        if (values.has(flag)) throw new Error(`${flag} given twice`);
        values.set(flag, value);
    }
    const required = (flag: string): string => {
        const value = values.get(flag);
        if (value === undefined) throw new Error(`${flag} is required\n${USAGE}`);
        return value;
    };
    const freezeFingerprint = required("--freeze-fingerprint");
    if (!HEX64_RE.test(freezeFingerprint)) throw new Error("--freeze-fingerprint must be the lowercase hex64 fingerprint recorded in the trusted manifest registry");
    const policiesDir = resolve(values.get("--policies") ?? join(root, "prospective-holdout", "policies"));
    const baseline = values.get("--baseline");
    return {
        sources: {
            freeze: { artifactDir: resolve(required("--freeze")), expectedManifestFingerprint: freezeFingerprint },
            policies: {
                analysisPath: join(policiesDir, "analysis-policy.json"),
                scorecardPath: join(policiesDir, "scorecard-policy.json"),
            },
            pairedDeltaPolicyPath: resolve(values.get("--paired-delta-policy") ?? join(root, "pools", "paired-delta-policy.json")),
            artifactsDir: resolve(required("--artifacts")),
            baselinePath: baseline === undefined ? null : resolve(baseline),
        },
        out: resolve(required("--out")),
    };
}

export function runScorecard(args: ScorecardCliArgs, log: (line: string) => void = console.log): ScorecardExitCode {
    try {
        const bundle = loadEvidenceBundle(args.sources);
        const report = buildScorecardReport(bundle);
        publishScorecardReport(report, args.out);
        log(JSON.stringify({ reportFingerprint: report.reportFingerprint, outcome: report.body.outcome, limitations: report.body.limitations }, null, 2));
        return scorecardExitCode(report);
    } catch (error) {
        if (error instanceof ScorecardContractError) {
            log(JSON.stringify({ refused: error.diagnostics }, null, 2));
            return 2;
        }
        throw error;
    }
}

if (import.meta.main) {
    let code: number;
    try {
        code = runScorecard(parseArgs(Bun.argv.slice(2)));
    } catch (error) {
        console.error(`scorecard failed: ${error instanceof Error ? error.message : String(error)}`);
        code = 2;
    }
    process.exit(code);
}
