#!/usr/bin/env bun

/**
 * Machine-readable JSON goes to stdout ONLY; every diagnostic goes to
 * stderr, so automation can parse stdout without filtering.
 *
 * Exit codes:
 *   0  complete report
 *   1  invalid input / contract violation / fail-closed resume
 *   2  incomplete evidence
 *   3  structurally invalid evidence
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContractError, loadReviewedRelease } from "./retrieval-benchmark";
import { loadProfileFile } from "./retrieval-benchmark/profiles";
import { RunnerError, runBenchmark } from "./retrieval-benchmark/runner";
import { SeedError } from "./retrieval-benchmark/seed";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "retrieval-benchmark");
const DEFAULT_RELEASE_DIR = join(FIXTURES_DIR, "v1");
const PROFILE_DIR = join(FIXTURES_DIR, "profiles", "v1");

const USAGE = `Usage: bun scripts/benchmark-retrieval.ts <command> [options]

Commands:
  check     Run the CI-sized deterministic profile (defaults --profile ci).
  matrix    Run a full profile matrix with atomic case checkpoints.

Options:
  --profile <name|path>     Profile name under scripts/fixtures/retrieval-benchmark/profiles/v1
                            or a path to a profile JSON file (check default: ci).
  --release <dir>           Reviewed release directory (default: scripts/fixtures/retrieval-benchmark/v1).
  --work-dir <dir>          Scratch directory for fixture databases (default: a fresh temp dir).
  --checkpoint-dir <dir>    Persistent checkpoint directory; enables compatible resume (matrix).
  --out <file>              Write the validated report to this path instead of stdout.
  --candidate-pool <file>   Also write the versioned unjudged candidate-pool artifact.

Machine-readable JSON is written to stdout only; diagnostics go to stderr.
Exit codes: 0 complete, 1 invalid input, 2 incomplete evidence, 3 invalid evidence.`;

interface CliArgs {
    command: "check" | "matrix";
    profile: string;
    releaseDir: string;
    workDir: string | null;
    checkpointDir: string | null;
    outPath: string | null;
    candidatePoolPath: string | null;
}

function parseArgs(argv: string[]): CliArgs {
    const [command, ...rest] = argv;
    if (command !== "check" && command !== "matrix") {
        throw new RunnerError([`usage: unknown command ${JSON.stringify(command ?? "")}`]);
    }
    const args: CliArgs = {
        command,
        profile: command === "check" ? "ci" : "",
        releaseDir: DEFAULT_RELEASE_DIR,
        workDir: null,
        checkpointDir: null,
        outPath: null,
        candidatePoolPath: null,
    };
    for (let i = 0; i < rest.length; i += 2) {
        const flag = rest[i];
        const value = rest[i + 1];
        if (value === undefined) throw new RunnerError([`usage: missing value for ${flag}`]);
        switch (flag) {
            case "--profile":
                args.profile = value;
                break;
            case "--release":
                args.releaseDir = value;
                break;
            case "--work-dir":
                args.workDir = value;
                break;
            case "--checkpoint-dir":
                args.checkpointDir = value;
                break;
            case "--out":
                args.outPath = value;
                break;
            case "--candidate-pool":
                args.candidatePoolPath = value;
                break;
            default:
                throw new RunnerError([`usage: unknown flag ${flag}`]);
        }
    }
    if (args.profile.length === 0) {
        throw new RunnerError(["usage: matrix requires --profile"]);
    }
    return args;
}

function resolveProfilePath(profile: string): string {
    return profile.includes("/") || profile.endsWith(".json")
        ? profile
        : join(PROFILE_DIR, `${profile}.json`);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const profile = loadProfileFile(resolveProfilePath(args.profile));
    if (args.command === "check" && profile.host.class !== "ci") {
        throw new RunnerError(["usage: check runs CI-class profiles only; use matrix"]);
    }
    const release = loadReviewedRelease(args.releaseDir);
    const workDir = args.workDir ?? mkdtempSync(join(tmpdir(), "retrieval-benchmark-"));

    console.error(`[benchmark-retrieval] ${args.command} profile=${profile.id}`);
    console.error(`[benchmark-retrieval] release=${args.releaseDir}`);
    console.error(`[benchmark-retrieval] workDir=${workDir}`);
    if (args.checkpointDir) {
        console.error(`[benchmark-retrieval] checkpointDir=${args.checkpointDir}`);
    }

    const result = await runBenchmark({
        release,
        profile,
        workDir,
        ...(args.checkpointDir ? { checkpointDir: args.checkpointDir } : {}),
    });
    for (const line of result.diagnostics) {
        console.error(`[benchmark-retrieval] ${line}`);
    }
    console.error(
        `[benchmark-retrieval] status=${result.report.status} scenarios=${result.report.evidence.scenarios.length} cases=${result.report.evidence.cases.length}`,
    );
    console.error(`[benchmark-retrieval] semanticFingerprint=${result.semanticFingerprint}`);
    console.error(`[benchmark-retrieval] evidenceDigest=${result.evidenceDigest}`);

    const reportJson = `${JSON.stringify(result.report, null, 2)}\n`;
    if (args.candidatePoolPath) {
        await Bun.write(
            args.candidatePoolPath,
            `${JSON.stringify(result.candidatePool, null, 2)}\n`,
        );
        console.error(`[benchmark-retrieval] candidatePool=${args.candidatePoolPath}`);
    }
    if (args.outPath) {
        await Bun.write(args.outPath, reportJson);
        console.log(
            JSON.stringify(
                {
                    reportPath: args.outPath,
                    status: result.report.status,
                    semanticFingerprint: result.semanticFingerprint,
                    evidenceDigest: result.evidenceDigest,
                },
                null,
                2,
            ),
        );
    } else {
        console.log(reportJson.trimEnd());
    }

    if (result.report.status === "incomplete") process.exitCode = 2;
    else if (result.report.status === "invalid") process.exitCode = 3;
}

main().catch((error) => {
    if (
        error instanceof RunnerError ||
        error instanceof ContractError ||
        error instanceof SeedError
    ) {
        for (const line of error.diagnostics) console.error(`[benchmark-retrieval] ${line}`);
        if (error instanceof RunnerError && error.diagnostics.some((d) => d.startsWith("usage:"))) {
            console.error(USAGE);
        }
    } else {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    process.exitCode = 1;
});
