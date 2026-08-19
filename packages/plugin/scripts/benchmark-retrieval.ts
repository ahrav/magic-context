#!/usr/bin/env bun

/**
 * Machine-readable JSON goes to stdout ONLY; every diagnostic goes to
 * stderr, so automation can parse stdout without filtering.
 *
 * Exit codes:
 *   0  complete report / pass / quality-only where latency is not required
 *   1  invalid input / contract violation / fail-closed resume /
 *      policy failure / non-comparable / needs_judgment /
 *      quality-only where the gate requires latency
 *   2  incomplete evidence
 *   3  structurally invalid evidence / A/A mechanical failure
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContractError, loadReviewedRelease } from "./retrieval-benchmark";
import { AUDIT_CELL, type BenchmarkProfile, loadProfileFile } from "./retrieval-benchmark/profiles";
import {
    aaMechanicalCheck,
    buildLatencyBaseline,
    buildQualityBaseline,
    CLAIM_ELIGIBILITIES,
    type ClaimEligibility,
    evaluateRegression,
    type HostEvidence,
    type LatencyBaselineArtifact,
    loadBaselineFile,
    loadRegressionPolicyFile,
    parseHostEvidence,
    publishBaseline,
    type RegressionClaim,
    RegressionError,
    type RegressionVerdict,
    REQUIRED_RUN_COUNT,
} from "./retrieval-benchmark/regression";
import { type BenchmarkReport, parseReport } from "./retrieval-benchmark/report";
import { RunnerError, runBenchmark } from "./retrieval-benchmark/runner";
import { SeedError } from "./retrieval-benchmark/seed";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "retrieval-benchmark");
const DEFAULT_RELEASE_DIR = join(FIXTURES_DIR, "v1");
const PROFILE_DIR = join(FIXTURES_DIR, "profiles", "v1");
const BASELINE_DIR = join(FIXTURES_DIR, "baselines", "v1");
const DEFAULT_POLICY_PATH = join(BASELINE_DIR, "policy.json");
const DEFAULT_QUALITY_BASELINE_PATH = join(BASELINE_DIR, "quality.json");

const USAGE = `Usage: bun scripts/benchmark-retrieval.ts <command> [options]

Commands:
  check            Run the CI-sized deterministic profile (defaults --profile ci).
  matrix           Run a full profile matrix with atomic case checkpoints.
  baseline-create  Publish an immutable quality or latency baseline from three complete runs.
  regression       Apply the KTD17 policy to three candidate runs against a baseline.

check / matrix options:
  --profile <name|path>     Profile name under scripts/fixtures/retrieval-benchmark/profiles/v1
                            or a path to a profile JSON file (check default: ci).
  --release <dir>           Reviewed release directory (default: scripts/fixtures/retrieval-benchmark/v1).
  --work-dir <dir>          Scratch directory for fixture databases (default: a fresh temp dir).
  --checkpoint-dir <dir>    Persistent checkpoint directory; enables compatible resume (matrix).
  --out <file>              Write the validated report to this path instead of stdout.
  --candidate-pool <file>   Also write the versioned unjudged candidate-pool artifact.

baseline-create options:
  --kind <quality|latency>          Baseline kind (default: quality).
  --policy <file>                   Regression policy artifact (default: baselines/v1/policy.json).
  --run <report.json>               Complete run report; pass exactly three times.
  --out <file>                      Destination baseline file; existing files are never overwritten.
  --claim-eligibility <value>       quality only: judged-support-only (default) or measured-win-eligible.
  --host-class <arm-neon|x86-avx2>  latency only, required.
  --host-evidence <file>            latency only: one host-evidence JSON per run, three times.

regression options:
  --policy <file>              Regression policy artifact (default: baselines/v1/policy.json).
  --baseline <file>            Quality baseline (default: baselines/v1/quality.json).
  --candidate <report.json>    Complete candidate run report; pass exactly three times.
  --latency-baseline <file>    Host-bound latency baseline; omitting it yields at most quality-only.
  --host-evidence <file>       Candidate host evidence, three times, when comparing latency.
  --claim <regression|measured-win>  Claim under evaluation (default: regression).
  --require-latency            The gate requires latency; quality-only cannot unblock it.
  --profile <name|path>        Resolve the 100K/384 automatic audit cell for the TS audit.
  --aa <report.json>           Run ONLY the identical-artifact A/A mechanical check.
  --out <file>                 Write the result JSON to this path instead of stdout.

Machine-readable JSON is written to stdout only; diagnostics go to stderr.
Exit codes: 0 pass/complete, 1 invalid input or policy/comparability failure,
2 incomplete evidence, 3 invalid evidence or A/A mechanical failure.`;

interface CliArgs {
    command: "check" | "matrix";
    profile: string;
    releaseDir: string;
    workDir: string | null;
    checkpointDir: string | null;
    outPath: string | null;
    candidatePoolPath: string | null;
}

interface ParsedFlags {
    single: Map<string, string>;
    repeated: Map<string, string[]>;
    booleans: Set<string>;
}

function parseFlags(
    rest: string[],
    spec: { single?: string[]; repeated?: string[]; boolean?: string[] },
): ParsedFlags {
    const single = new Map<string, string>();
    const repeated = new Map<string, string[]>();
    const booleans = new Set<string>();
    for (let i = 0; i < rest.length; i += 1) {
        const flag = rest[i];
        if (spec.boolean?.includes(flag)) {
            booleans.add(flag);
            continue;
        }
        const value = rest[i + 1];
        if (value === undefined) throw new RunnerError([`usage: missing value for ${flag}`]);
        i += 1;
        if (spec.repeated?.includes(flag)) {
            const values = repeated.get(flag) ?? [];
            values.push(value);
            repeated.set(flag, values);
            continue;
        }
        if (spec.single?.includes(flag)) {
            if (single.has(flag)) throw new RunnerError([`usage: duplicate flag ${flag}`]);
            single.set(flag, value);
            continue;
        }
        throw new RunnerError([`usage: unknown flag ${flag}`]);
    }
    return { single, repeated, booleans };
}

function parseArgs(command: "check" | "matrix", rest: string[]): CliArgs {
    const flags = parseFlags(rest, {
        single: [
            "--profile",
            "--release",
            "--work-dir",
            "--checkpoint-dir",
            "--out",
            "--candidate-pool",
        ],
    });
    const args: CliArgs = {
        command,
        profile: flags.single.get("--profile") ?? (command === "check" ? "ci" : ""),
        releaseDir: flags.single.get("--release") ?? DEFAULT_RELEASE_DIR,
        workDir: flags.single.get("--work-dir") ?? null,
        checkpointDir: flags.single.get("--checkpoint-dir") ?? null,
        outPath: flags.single.get("--out") ?? null,
        candidatePoolPath: flags.single.get("--candidate-pool") ?? null,
    };
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

function readReportFile(path: string): BenchmarkReport {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new RunnerError([`usage: unreadable report ${path}`]);
    }
    return parseReport(parsed);
}

function readHostEvidenceFile(path: string): HostEvidence {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new RunnerError([`usage: unreadable host evidence ${path}`]);
    }
    return parseHostEvidence(parsed);
}

async function emitResult(value: unknown, outPath: string | null): Promise<void> {
    const text = JSON.stringify(value, null, 2);
    if (outPath) {
        await Bun.write(outPath, `${text}\n`);
        console.error(`[benchmark-retrieval] result=${outPath}`);
    } else {
        console.log(text);
    }
}

function requireThree(label: string, values: string[] | undefined): [string, string, string] {
    if (!values || values.length !== REQUIRED_RUN_COUNT) {
        throw new RunnerError([
            `usage: ${label} must be provided exactly ${REQUIRED_RUN_COUNT} times`,
        ]);
    }
    return values as [string, string, string];
}

async function runBaselineCreate(rest: string[]): Promise<void> {
    const flags = parseFlags(rest, {
        single: ["--kind", "--policy", "--out", "--claim-eligibility", "--host-class"],
        repeated: ["--run", "--host-evidence"],
    });
    const kind = flags.single.get("--kind") ?? "quality";
    if (kind !== "quality" && kind !== "latency") {
        throw new RunnerError([`usage: unknown baseline kind ${kind}`]);
    }
    const outPath = flags.single.get("--out");
    if (!outPath) throw new RunnerError(["usage: baseline-create requires --out"]);
    const policy = loadRegressionPolicyFile(flags.single.get("--policy") ?? DEFAULT_POLICY_PATH);
    const reports = requireThree("--run", flags.repeated.get("--run")).map(readReportFile);

    if (kind === "quality") {
        const claimEligibility = (flags.single.get("--claim-eligibility") ??
            "judged-support-only") as ClaimEligibility;
        if (!CLAIM_ELIGIBILITIES.includes(claimEligibility)) {
            throw new RunnerError([`usage: unknown claim eligibility ${claimEligibility}`]);
        }
        const artifact = buildQualityBaseline({ policy, reports, claimEligibility });
        const { path } = publishBaseline(artifact, outPath);
        console.error(`[benchmark-retrieval] published quality baseline ${path}`);
        await emitResult(
            {
                baselinePath: path,
                kind,
                claimEligibility,
                policyFingerprint: artifact.policyFingerprint,
                runs: artifact.runs.map((run) => run.evidenceDigest),
            },
            null,
        );
        return;
    }

    const hostClass = flags.single.get("--host-class");
    if (hostClass !== "arm-neon" && hostClass !== "x86-avx2") {
        throw new RunnerError([
            "usage: baseline-create --kind latency requires --host-class arm-neon|x86-avx2",
        ]);
    }
    const hostEvidence = requireThree(
        "--host-evidence",
        flags.repeated.get("--host-evidence"),
    ).map(readHostEvidenceFile);
    const artifact = buildLatencyBaseline({ policy, reports, hostClass, hostEvidence });
    const { path } = publishBaseline(artifact, outPath);
    console.error(`[benchmark-retrieval] published latency baseline ${path}`);
    await emitResult(
        {
            baselinePath: path,
            kind,
            hostClass,
            hostFingerprint: artifact.hostFingerprint,
            policyFingerprint: artifact.policyFingerprint,
            runs: artifact.runs.map((run) => run.evidenceDigest),
        },
        null,
    );
}

function auditCaseIds(profile: BenchmarkProfile): string[] {
    return profile.cases
        .filter(
            (profileCase) =>
                profileCase.scale === AUDIT_CELL.scale &&
                profileCase.dims === AUDIT_CELL.dims &&
                profileCase.mode === "automatic",
        )
        .map((profileCase) => profileCase.id);
}

function regressionExitCode(verdict: RegressionVerdict, unblocked: boolean): number {
    if (verdict === "incomplete") return 2;
    if (verdict === "invalid-evidence") return 3;
    return unblocked ? 0 : 1;
}

async function runRegression(rest: string[]): Promise<void> {
    const flags = parseFlags(rest, {
        single: [
            "--policy",
            "--baseline",
            "--latency-baseline",
            "--claim",
            "--profile",
            "--aa",
            "--out",
        ],
        repeated: ["--candidate", "--host-evidence"],
        boolean: ["--require-latency"],
    });
    const policy = loadRegressionPolicyFile(flags.single.get("--policy") ?? DEFAULT_POLICY_PATH);
    const outPath = flags.single.get("--out") ?? null;

    const aaPath = flags.single.get("--aa");
    if (aaPath) {
        const result = aaMechanicalCheck({ policy, report: readReportFile(aaPath) });
        console.error(`[benchmark-retrieval] aa status=${result.status}`);
        await emitResult(result, outPath);
        if (result.status !== "ok") process.exitCode = 3;
        return;
    }

    const claim = (flags.single.get("--claim") ?? "regression") as RegressionClaim;
    if (claim !== "regression" && claim !== "measured-win") {
        throw new RunnerError([`usage: unknown claim ${claim}`]);
    }
    const baseline = loadBaselineFile(flags.single.get("--baseline") ?? DEFAULT_QUALITY_BASELINE_PATH);
    if (baseline.kind !== "quality") {
        throw new RunnerError(["usage: --baseline must be a quality baseline"]);
    }
    const candidates = requireThree("--candidate", flags.repeated.get("--candidate")).map(
        readReportFile,
    );

    let latency: {
        baseline: LatencyBaselineArtifact;
        candidateHostEvidence: HostEvidence[];
    } | null = null;
    const latencyBaselinePath = flags.single.get("--latency-baseline");
    if (latencyBaselinePath) {
        const latencyBaseline = loadBaselineFile(latencyBaselinePath);
        if (latencyBaseline.kind !== "latency") {
            throw new RunnerError(["usage: --latency-baseline must be a latency baseline"]);
        }
        const candidateHostEvidence = requireThree(
            "--host-evidence",
            flags.repeated.get("--host-evidence"),
        ).map(readHostEvidenceFile);
        latency = {
            baseline: latencyBaseline,
            candidateHostEvidence,
        };
    }

    const profileFlag = flags.single.get("--profile");
    const audit = profileFlag ? auditCaseIds(loadProfileFile(resolveProfilePath(profileFlag))) : [];

    const result = evaluateRegression({
        policy,
        baseline,
        candidates,
        claim,
        latency,
        latencyRequired: flags.booleans.has("--require-latency"),
        auditCaseIds: audit,
    });
    console.error(
        `[benchmark-retrieval] regression verdict=${result.verdict} unblocked=${result.gate.unblocked}`,
    );
    for (const reason of result.reasons) {
        console.error(`[benchmark-retrieval] reason: ${reason}`);
    }
    await emitResult(result, outPath);
    process.exitCode = regressionExitCode(result.verdict, result.gate.unblocked);
}

async function runCheckOrMatrix(command: "check" | "matrix", rest: string[]): Promise<void> {
    const args = parseArgs(command, rest);
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

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    if (command === "check" || command === "matrix") {
        await runCheckOrMatrix(command, rest);
        return;
    }
    if (command === "baseline-create") {
        await runBaselineCreate(rest);
        return;
    }
    if (command === "regression") {
        await runRegression(rest);
        return;
    }
    throw new RunnerError([`usage: unknown command ${JSON.stringify(command ?? "")}`]);
}

main().catch((error) => {
    if (
        error instanceof RunnerError ||
        error instanceof ContractError ||
        error instanceof SeedError ||
        error instanceof RegressionError
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
