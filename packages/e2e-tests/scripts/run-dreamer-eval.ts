#!/usr/bin/env bun

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
    DREAMER_TASKS,
    dreamerEvalExitCode,
    parseScenario,
    type DreamerEvalRunReport,
    type DreamerEvalScenario,
    type DreamerTask,
} from "../src/dreamer-eval/contract";
import { DreamerEvalArtifactError, runDreamerEvalTask } from "../src/dreamer-eval/runner";
import { aggregateDreamerEvalVarianceFiles } from "../src/dreamer-eval/variance";

const E2E_ROOT = resolve(import.meta.dir, "..");

interface CliArgs {
    scenarioIds: string[];
    tasks: DreamerTask[];
    repeat: number;
    outputDir: string;
    /** Wall-clock budget for the whole live loop, in minutes, or null for none. */
    deadlineMinutes: number | null;
}

function parseArgs(args: string[]): CliArgs {
    const scenarioIds: string[] = [];
    const tasks: DreamerTask[] = [];
    let repeat = 1;
    let outputDir = join(E2E_ROOT, "artifacts", "dreamer-eval");
    let deadlineMinutes: number | null = null;
    const value = (flag: string, candidate: string | undefined): string => {
        if (candidate === undefined || candidate.startsWith("-")) throw new Error(`${flag} requires a value`);
        return candidate;
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--scenario") {
            scenarioIds.push(value(arg, args[++index]));
        } else if (arg === "--task") {
            const task = value(arg, args[++index]);
            if (!DREAMER_TASKS.includes(task as DreamerTask)) {
                throw new Error(`--task expects one of ${DREAMER_TASKS.join(", ")} (got ${task})`);
            }
            tasks.push(task as DreamerTask);
        } else if (arg === "--repeat") {
            const raw = value(arg, args[++index]);
            repeat = Number(raw);
            if (!Number.isSafeInteger(repeat) || repeat < 1) {
                throw new Error(`--repeat expects a positive integer (got ${raw})`);
            }
        } else if (arg === "--output-dir") {
            outputDir = value(arg, args[++index]);
        } else if (arg === "--deadline-minutes") {
            const raw = value(arg, args[++index]);
            deadlineMinutes = Number(raw);
            if (!Number.isSafeInteger(deadlineMinutes) || deadlineMinutes < 1) {
                throw new Error(`--deadline-minutes expects a positive integer (got ${raw})`);
            }
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: run-dreamer-eval.ts [--scenario <id>] [--task <task>] [--repeat <n>] [--output-dir <dir>] [--deadline-minutes <n>]",
            );
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return {
        scenarioIds: [...new Set(scenarioIds)],
        tasks: [...new Set(tasks)],
        repeat,
        outputDir: resolve(outputDir),
        deadlineMinutes,
    };
}

/**
 * Reserves `longestRunMs` before admitting a subsequent run so it can finish
 * by `deadlineAtMs` instead of being killed mid-flight by an external timeout.
 * The first run is always admitted so a tight budget still produces evidence.
 */
export function canStartDreamerEvalRun(
    deadlineAtMs: number | null,
    nowMs: number,
    longestRunMs: number,
    completedRuns: number,
): boolean {
    if (deadlineAtMs === null || completedRuns === 0) return true;
    return nowMs + longestRunMs <= deadlineAtMs;
}

export const DREAMER_EVAL_COVERAGE_SCHEMA = "dreamer-eval-coverage/v1";

export interface DreamerEvalGroupCoverage {
    scenarioId: string;
    task: DreamerTask;
    /** Repeats this invocation asked for, which is `--repeat` for every group. */
    requestedRuns: number;
    /**
     * Run reports written under the group directory. Defined against the archive
     * rather than against runs attempted, so an offline reader can confirm it by
     * counting files. A run that executed but failed to write its report is
     * therefore absent here, and `runFailed` is what records that it happened.
     */
    archivedRuns: number;
    /** Whether the group's `variance.json` was written. */
    varianceArchived: boolean;
}

/**
 * What the run set out to observe, beside what it archived.
 *
 * The report tree alone cannot express a gap: a group the deadline skipped
 * entirely leaves no directory, so it is indistinguishable from one a `--scenario`
 * or `--task` filter excluded, and a group truncated after one of three repeats
 * aggregates into a `variance.json` whose `repeatCount` is 1 — a complete
 * one-repeat experiment, not a curtailed three-repeat one. The exit code and the
 * console log carry that difference, and neither is inside the uploaded artifact.
 *
 * This is a separate artifact rather than extra fields on the versioned report and
 * variance contracts, because those are archived evidence that older tooling must
 * keep parsing, and because a wholly skipped group has no report to aggregate and
 * so cannot carry a variance artifact at all.
 */
export interface DreamerEvalRunCoverage {
    schema: typeof DREAMER_EVAL_COVERAGE_SCHEMA;
    requestedRuns: number;
    archivedRuns: number;
    /** Every requested run archived, and every group's variance written. */
    complete: boolean;
    deadlineReached: boolean;
    runFailed: boolean;
    aggregationFailed: boolean;
    /** Every selected group, including those left with `archivedRuns: 0`. */
    groups: DreamerEvalGroupCoverage[];
}

export function dreamerEvalRunCoverage(
    groups: readonly DreamerEvalGroupCoverage[],
    flags: { deadlineReached: boolean; runFailed: boolean; aggregationFailed: boolean },
): DreamerEvalRunCoverage {
    const requestedRuns = groups.reduce((total, group) => total + group.requestedRuns, 0);
    const archivedRuns = groups.reduce((total, group) => total + group.archivedRuns, 0);
    return {
        schema: DREAMER_EVAL_COVERAGE_SCHEMA,
        requestedRuns,
        archivedRuns,
        complete: archivedRuns === requestedRuns && groups.every((group) => group.varianceArchived),
        deadlineReached: flags.deadlineReached,
        runFailed: flags.runFailed,
        aggregationFailed: flags.aggregationFailed,
        groups: groups.map((group) => ({ ...group })),
    };
}

function loadScenarios(): DreamerEvalScenario[] {
    const directory = join(E2E_ROOT, "dreamer-eval", "dev");
    return readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => parseScenario(JSON.parse(readFileSync(join(directory, file), "utf8")), file));
}

function selectedScenarios(all: DreamerEvalScenario[], ids: readonly string[]): DreamerEvalScenario[] {
    if (ids.length === 0) return all;
    const selected = all.filter((scenario) => ids.includes(scenario.id));
    const missing = ids.filter((id) => !selected.some((scenario) => scenario.id === id));
    if (missing.length > 0) throw new Error(`unknown scenario: ${missing.join(", ")}`);
    return selected;
}

function opencodeVersion(): string {
    // `Bun.spawnSync` throws when the executable is not on PATH, and this runs
    // before any task, so an absent `opencode` would abort the whole run while
    // resolving a provenance field the report already accepts as "unknown".
    try {
        const result = Bun.spawnSync(["opencode", "--version"], {
            stdout: "pipe",
            stderr: "ignore",
        });
        return (result.success ? result.stdout.toString().trim() : "") || "unknown";
    } catch {
        return "unknown";
    }
}

async function main(): Promise<0 | 1 | 2> {
    const args = parseArgs(Bun.argv.slice(2));
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.DREAMER_EVAL_MODEL;
    if (!apiKey || !model) {
        throw new Error("live run needs ANTHROPIC_API_KEY and DREAMER_EVAL_MODEL (anthropic/model)");
    }
    if (!/^anthropic\/[^/\s]+$/.test(model)) {
        throw new Error("DREAMER_EVAL_MODEL must use the anthropic/model form");
    }
    const scenarios = selectedScenarios(loadScenarios(), args.scenarioIds);
    const taskFilter = new Set(args.tasks);
    const groups = scenarios.flatMap((scenario) =>
        scenario.tasks
            .filter((task) => taskFilter.size === 0 || taskFilter.has(task.task))
            .map((task) => ({ scenario, task })),
    );
    if (groups.length === 0) throw new Error("filters selected no scenario tasks");

    mkdirSync(args.outputDir, { recursive: true });
    const reports: DreamerEvalRunReport[] = [];
    let aggregationFailed = false;
    let runFailed = false;
    let deadlineReached = false;
    // Paired with each selected group before any run, so a group the deadline or a
    // structural failure never reaches still carries an entry with
    // `archivedRuns: 0` rather than vanishing the way its absent directory would.
    const plan: Array<{
        scenario: DreamerEvalScenario;
        task: DreamerEvalScenario["tasks"][number];
        coverage: DreamerEvalGroupCoverage;
    }> = groups.map(({ scenario, task }) => ({
        scenario,
        task,
        coverage: {
            scenarioId: scenario.id,
            task: task.task,
            requestedRuns: args.repeat,
            archivedRuns: 0,
            varianceArchived: false,
        },
    }));
    const version = opencodeVersion();
    // The deadline starts after argument parsing and scenario loading, so it
    // bounds evaluation runs only.
    const deadlineAtMs = args.deadlineMinutes === null ? null : Date.now() + args.deadlineMinutes * 60_000;
    let longestRunMs = 0;
    for (const { scenario, task, coverage: groupCoverage } of plan) {
        if (runFailed) break;
        const groupDir = join(args.outputDir, scenario.id, task.task);
        const groupReportPaths: string[] = [];
        for (let repeat = 1; repeat <= args.repeat; repeat += 1) {
            if (!canStartDreamerEvalRun(deadlineAtMs, Date.now(), longestRunMs, reports.length)) {
                deadlineReached = true;
                console.log(`dreamer-eval deadline reached before ${scenario.id}/${task.task} run ${repeat}`);
                break;
            }
            console.log(`${scenario.id}/${task.task}: run ${repeat}/${args.repeat}`);
            // A task classifies its own failures into an ERROR report, so a throw
            // here is structural — provenance, or the artifact write. Letting it
            // escape would reach the outer catch, which exits 1 without consulting
            // the reports already collected, dropping a previous repeat's safety
            // exit 2. Stop instead of continuing: a structural fault repeats, and
            // every further repeat would spend model credits to fail the same way.
            let report: DreamerEvalRunReport;
            const runStartedAtMs = Date.now();
            try {
                report = await runDreamerEvalTask(scenario, task, {
                    apiKey,
                    model,
                    artifactDir: groupDir,
                    opencodeVersion: version,
                });
            } catch (error) {
                runFailed = true;
                // An artifact failure still carries the run's report: count it, so a
                // classification the run established — including an irreversible
                // archival — reaches the exit code. Its path is not recorded, since
                // the file is what failed to be written.
                if (error instanceof DreamerEvalArtifactError) reports.push(error.report);
                console.error(
                    `${scenario.id}/${task.task}: run ${repeat} failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                break;
            }
            longestRunMs = Math.max(longestRunMs, Date.now() - runStartedAtMs);
            groupReportPaths.push(join(groupDir, `${report.runId}.json`));
            groupCoverage.archivedRuns += 1;
            reports.push(report);
            console.log(`${report.runId}: ${report.status}${report.reason === null ? "" : `:${report.reason}`}`);
        }
        if (groupReportPaths.length === 0) {
            if (deadlineReached) break;
            continue;
        }
        // A failure here must not swallow what the runs already established. The
        // outer catch exits 1 unconditionally, so letting this throw would downgrade
        // an applied wrong archival's safety exit 2 to 1 because a later artifact or
        // system-tuple error happened to surface after it.
        try {
            const variance = aggregateDreamerEvalVarianceFiles(groupReportPaths);
            writeFileSync(join(groupDir, "variance.json"), `${JSON.stringify(variance, null, 2)}\n`);
            groupCoverage.varianceArchived = true;
        } catch (error) {
            aggregationFailed = true;
            console.error(
                `${scenario.id}/${task.task}: variance aggregation failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (deadlineReached) break;
    }
    // Written for every outcome, including truncation and structural failure: the
    // gap it records is exactly what those outcomes leave behind. Guarded like the
    // aggregation above, because the outer catch exits 1 unconditionally and would
    // downgrade an applied wrong archival's safety exit 2 to 1.
    let coverageFailed = false;
    const runCoverage = dreamerEvalRunCoverage(
        plan.map((entry) => entry.coverage),
        { deadlineReached, runFailed, aggregationFailed },
    );
    try {
        writeFileSync(join(args.outputDir, "coverage.json"), `${JSON.stringify(runCoverage, null, 2)}\n`);
    } catch (error) {
        coverageFailed = true;
        console.error(`coverage write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!runCoverage.complete) {
        console.error(
            `dreamer-eval archived ${runCoverage.archivedRuns}/${runCoverage.requestedRuns} requested runs across ${runCoverage.groups.length} selected groups`,
        );
    }
    const code = dreamerEvalExitCode(reports);
    const expectedRunCount = groups.length * args.repeat;
    // A run-fatal set keeps exit 2; anything else fails the run.
    return code === 2
        ? code
        : aggregationFailed || runFailed || coverageFailed || reports.length !== expectedRunCount
          ? 1
          : code;
}

if (import.meta.main) {
    main()
        .then((code) => process.exit(code))
        .catch((error: unknown) => {
            console.error(`dreamer-eval failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        });
}
