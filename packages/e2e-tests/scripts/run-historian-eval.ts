#!/usr/bin/env bun

/**
 * Historian structural eval lane — one report artifact per run (U7/R14).
 *
 * Deterministic parts run per-PR with no credentials:
 *   run-historian-eval.ts --lint       [--scenarios <dir> | --release <dir>]
 *   run-historian-eval.ts --mutations  [--scenarios <dir> | --release <dir>]
 *
 * Live scenario runs are scheduled or operator-dispatched only (R14):
 *   run-historian-eval.ts --live --release historian-eval/releases/v1 \
 *       --report artifacts/historian-eval-report.json
 * Live routing reads HISTORIAN_EVAL_MODEL ("provider/model"),
 * HISTORIAN_EVAL_PROBE_MODEL ("provider/model"), and ANTHROPIC_API_KEY.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
    HARD_NEGATIVE_FAMILIES,
    lintCorpus,
    parseModelRoute,
    parseScenario,
    type HistorianEvalScenario,
} from "../src/historian-eval/contract";
import { runMutationBattery } from "../src/historian-eval/mutations";
import { loadRelease } from "../src/historian-eval/promote";
import { runScenario, type LiveHistorianMode, type SystemVersionTuple } from "../src/historian-eval/runner";
import { buildLaneReport, laneExitCode, scoreRunRecord, type ScenarioScore } from "../src/historian-eval/scorer";
import { E2E_ROOT } from "./validate-mode-manifest";

interface CliArgs {
    mode: "lint" | "mutations" | "live";
    scenariosDir: string | null;
    releaseDir: string | null;
    reportPath: string;
}

function parseArgs(args: string[]): CliArgs {
    let mode: CliArgs["mode"] | null = null;
    let scenariosDir: string | null = null;
    let releaseDir: string | null = null;
    let reportPath = join(E2E_ROOT, "artifacts", "historian-eval-report.json");
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--lint" || arg === "--mutations" || arg === "--live") {
            if (mode !== null) throw new Error("select exactly one of --lint, --mutations, --live");
            mode = arg.slice(2) as CliArgs["mode"];
        } else if (arg === "--scenarios") {
            scenariosDir = args[++index];
        } else if (arg === "--release") {
            releaseDir = args[++index];
        } else if (arg === "--report") {
            reportPath = args[++index];
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: run-historian-eval.ts (--lint | --mutations | --live) [--scenarios <dir> | --release <dir>] [--report <path>]",
            );
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    if (mode === null) throw new Error("select one of --lint, --mutations, --live");
    if (scenariosDir !== null && releaseDir !== null) {
        throw new Error("--scenarios and --release are mutually exclusive");
    }
    if (scenariosDir === null && releaseDir === null) {
        scenariosDir = join(E2E_ROOT, "historian-eval", "dev");
    }
    return { mode, scenariosDir, releaseDir, reportPath };
}

function loadCorpus(args: CliArgs): { scenarios: HistorianEvalScenario[]; releaseVersion: string | null } {
    if (args.releaseDir !== null) {
        const release = loadRelease(resolve(args.releaseDir));
        return { scenarios: release.scenarios, releaseVersion: release.manifest.releaseVersion };
    }
    const dir = resolve(args.scenariosDir as string);
    const scenarios = readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => parseScenario(JSON.parse(readFileSync(join(dir, file), "utf8")), file));
    if (scenarios.length === 0) throw new Error(`no scenarios found in ${dir}`);
    return { scenarios, releaseVersion: null };
}

function runLint(scenarios: readonly HistorianEvalScenario[]): number {
    const diagnostics = lintCorpus(scenarios);
    if (diagnostics.length > 0) {
        for (const diagnostic of diagnostics) console.error(`lint: ${diagnostic}`);
        return 1;
    }
    console.log(`lint clean: ${scenarios.length} scenario(s), all ${HARD_NEGATIVE_FAMILIES.length} families covered`);
    return 0;
}

function runMutations(scenarios: readonly HistorianEvalScenario[]): number {
    const evidence = runMutationBattery(scenarios);
    for (const entry of evidence.scenarios) {
        for (const result of entry.results) {
            const status = result.green ? "green" : "RED";
            console.log(`${entry.scenarioId} ${result.mutationClass}: ${status} (${result.detail})`);
        }
    }
    if (!evidence.green) {
        console.error("mutation battery RED");
        return 1;
    }
    console.log(`mutation battery green across ${evidence.scenarios.length} scenario(s)`);
    return 0;
}

function liveModeFromEnv(): LiveHistorianMode {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const historianModel = process.env.HISTORIAN_EVAL_MODEL;
    const probeModel = process.env.HISTORIAN_EVAL_PROBE_MODEL;
    if (!apiKey || !historianModel || !probeModel) {
        throw new Error(
            "live mode needs ANTHROPIC_API_KEY, HISTORIAN_EVAL_MODEL, and HISTORIAN_EVAL_PROBE_MODEL (provider/model)",
        );
    }
    // The historian route is validated for shape too: it is passed through to
    // the plugin config as a whole string, so an empty model component there
    // also fails only once the historian is invoked.
    parseModelRoute("HISTORIAN_EVAL_MODEL", historianModel);
    return {
        kind: "live",
        apiKey,
        historianModel,
        probeModel: parseModelRoute("HISTORIAN_EVAL_PROBE_MODEL", probeModel),
    };
}

function repoCommitSha(): string {
    try {
        return execSync("git rev-parse HEAD", { cwd: E2E_ROOT, encoding: "utf8" }).trim();
    } catch {
        return "unknown";
    }
}

/**
 * Recorded in the run report's system tuple: the installer serves whatever
 * OpenCode release is current, so identical weekly runs can sit on different
 * harness runtimes. Without this, their system identity would match and the
 * reports would look longitudinally comparable when they are not.
 */
function opencodeVersion(): string {
    try {
        const version = execSync("opencode --version", { encoding: "utf8" }).trim();
        return version.length > 0 ? version : "unknown";
    } catch {
        return "unknown";
    }
}

async function runLive(args: CliArgs): Promise<number> {
    const { scenarios, releaseVersion } = loadCorpus(args);
    const mode = liveModeFromEnv();
    const sha = repoCommitSha();
    const opencode = opencodeVersion();
    const artifactsRoot = join(dirname(resolve(args.reportPath)), "historian-eval-runs");
    const scores: ScenarioScore[] = [];
    let system: SystemVersionTuple | undefined;
    for (const scenario of scenarios) {
        const artifactDir = join(artifactsRoot, scenario.id);
        rmSync(artifactDir, { recursive: true, force: true });
        console.log(`running ${scenario.id}...`);
        const record = await runScenario(scenario, {
            mode,
            artifactDir,
            repoCommitSha: sha,
            opencodeVersion: opencode,
        });
        system = record.system;
        // The record's snapshot path is relative to the record's own
        // directory, so re-scoring the archived artifact elsewhere resolves it
        // against wherever it was unpacked.
        const score = scoreRunRecord(record, scenario, { recordDir: artifactDir });
        scores.push(score);
        console.log(
            `${scenario.id}: ${score.verdict}${score.failReasons.length > 0 ? ` [${score.failReasons.join(",")}]` : ""}${score.errorReason ? ` (${score.errorReason})` : ""}`,
        );
    }
    const report = buildLaneReport(scores, {
        ...(releaseVersion === null ? {} : { releaseVersion }),
        ...(system === undefined ? {} : { system }),
    });
    mkdirSync(dirname(resolve(args.reportPath)), { recursive: true });
    writeFileSync(resolve(args.reportPath), `${JSON.stringify(report, null, 2)}\n`);
    console.log(
        `published ${args.reportPath}: ${report.aggregate.total} scenario(s), red=${report.red}, runFatal=${report.runFatal}`,
    );
    return laneExitCode(report);
}

async function main(): Promise<number> {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.mode === "live") {
        // A stale successful report must never be collected by an always-run
        // artifact step after a failed run.
        rmSync(resolve(args.reportPath), { force: true });
        return runLive(args);
    }
    const { scenarios } = loadCorpus(args);
    return args.mode === "lint" ? runLint(scenarios) : runMutations(scenarios);
}

if (import.meta.main) {
    main()
        .then((code) => process.exit(code))
        .catch((error: unknown) => {
            console.error(`historian-eval failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        });
}
