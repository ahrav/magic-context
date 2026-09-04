#!/usr/bin/env bun

import { rmSync } from "node:fs";
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

export const HELP_REQUESTED = { kind: "help" } as const;
export type ParsedArgs = ({ kind: "run" } & ScorecardCliArgs) | typeof HELP_REQUESTED;

/**
 * Help is reported as a value rather than exiting in place so the exported parser never terminates
 * its host process; the entrypoint maps it to a non-promotion exit code.
 */
export function parseArgs(argv: readonly string[], root: string = E2E_ROOT): ParsedArgs {
    if (argv.includes("--help") || argv.includes("-h")) return HELP_REQUESTED;
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index]!;
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
        kind: "run",
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

/**
 * Argument parsing is fallible and runs before `runScorecard` can remove the previous report, so a
 * malformed rerun clears the path it names first.
 */
export function removeNamedOutput(argv: readonly string[]): void {
    const value = argv[argv.indexOf("--out") + 1];
    if (argv.includes("--out") && value !== undefined && !value.startsWith("--")) rmSync(resolve(value), { force: true });
}

export function runScorecard(args: ScorecardCliArgs, log: (line: string) => void = console.log): ScorecardExitCode {
    // A refused run must not leave an earlier report, possibly promotion-allowed, at the documented output path.
    rmSync(args.out, { force: true });
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
        removeNamedOutput(Bun.argv.slice(2));
        const parsed = parseArgs(Bun.argv.slice(2));
        if (parsed.kind === "help") {
            console.log(USAGE);
            code = 2;
        } else {
            code = runScorecard(parsed);
        }
    } catch (error) {
        console.error(`scorecard failed: ${error instanceof Error ? error.message : String(error)}`);
        code = 2;
    }
    process.exit(code);
}
