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
import { runDreamerEvalTask } from "../src/dreamer-eval/runner";
import { aggregateDreamerEvalVarianceFiles } from "../src/dreamer-eval/variance";

const E2E_ROOT = resolve(import.meta.dir, "..");

interface CliArgs {
    scenarioIds: string[];
    tasks: DreamerTask[];
    repeat: number;
    outputDir: string;
}

function parseArgs(args: string[]): CliArgs {
    const scenarioIds: string[] = [];
    const tasks: DreamerTask[] = [];
    let repeat = 1;
    let outputDir = join(E2E_ROOT, "artifacts", "dreamer-eval");
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
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: run-dreamer-eval.ts [--scenario <id>] [--task <task>] [--repeat <n>] [--output-dir <dir>]",
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
    const version = opencodeVersion();
    for (const { scenario, task } of groups) {
        const groupDir = join(args.outputDir, scenario.id, task.task);
        const groupReportPaths: string[] = [];
        for (let repeat = 1; repeat <= args.repeat; repeat += 1) {
            console.log(`${scenario.id}/${task.task}: run ${repeat}/${args.repeat}`);
            const report = await runDreamerEvalTask(scenario, task, {
                apiKey,
                model,
                artifactDir: groupDir,
                opencodeVersion: version,
            });
            groupReportPaths.push(join(groupDir, `${report.runId}.json`));
            reports.push(report);
            console.log(`${report.runId}: ${report.status}${report.reason === null ? "" : `:${report.reason}`}`);
        }
        const variance = aggregateDreamerEvalVarianceFiles(groupReportPaths);
        writeFileSync(join(groupDir, "variance.json"), `${JSON.stringify(variance, null, 2)}\n`);
    }
    return dreamerEvalExitCode(reports);
}

if (import.meta.main) {
    main()
        .then((code) => process.exit(code))
        .catch((error: unknown) => {
            console.error(`dreamer-eval failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        });
}
