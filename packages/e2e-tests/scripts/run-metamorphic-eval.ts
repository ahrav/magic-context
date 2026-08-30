#!/usr/bin/env bun

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseScenario, type HistorianEvalScenario } from "../src/historian-eval/contract";
import {
    buildPluginBundle,
    liveAdmissionGate,
    liveModeFromEnv,
    opencodeVersion,
} from "./run-historian-eval";
import { runSystemTuple } from "../src/historian-eval/runner";
import {
    runLiveMetamorphicEval,
    type LiveMetamorphicOptions,
} from "../src/metamorphic-eval/live";
import { metamorphicExitCode, type MetamorphicReport } from "../src/metamorphic-eval/report";
import { runDeterministicMetamorphicEval } from "../src/metamorphic-eval/runner";
import { TRANSFORMS, type Transform } from "../src/metamorphic-eval/transforms";

const E2E_ROOT = resolve(import.meta.dir, "..");

interface LivePreambleDependencies {
    liveModeFromEnv: typeof liveModeFromEnv;
    liveAdmissionGate: typeof liveAdmissionGate;
    buildPluginBundle: typeof buildPluginBundle;
    opencodeVersion: typeof opencodeVersion;
    runSystemTuple: typeof runSystemTuple;
}

export function prepareLivePreamble(
    corpus: readonly HistorianEvalScenario[],
    overrides: Partial<LivePreambleDependencies> = {},
): { mode: LiveMetamorphicOptions["mode"]; opencodeVersion: string } | null {
    const dependencies: LivePreambleDependencies = {
        liveModeFromEnv,
        liveAdmissionGate,
        buildPluginBundle,
        opencodeVersion,
        runSystemTuple,
        ...overrides,
    };
    const mode = dependencies.liveModeFromEnv();
    if (dependencies.liveAdmissionGate(corpus) !== 0) return null;
    if (dependencies.buildPluginBundle() !== 0) return null;
    const opencode = dependencies.opencodeVersion();
    if (opencode === null) {
        console.error("live admission: `opencode --version` did not resolve");
        return null;
    }
    if (dependencies.runSystemTuple({ mode, opencodeVersion: opencode }).repoCommitSha === "unknown") {
        console.error(
            "live admission: the checkout commit could not be resolved, so the report could not identify the code it ran",
        );
        return null;
    }
    return { mode, opencodeVersion: opencode };
}

export interface CliArgs {
    live: boolean;
    reportPath: string;
    corpusDirectory: string;
    scenarioIds: string[];
    transformIds: string[];
    deadlineMinutes: number | null;
}

export function loadCorpus(directory: string): HistorianEvalScenario[] {
    if (!existsSync(directory)) throw new Error(`scenario directory does not exist: ${directory}`);
    if (!statSync(directory).isDirectory()) throw new Error(`scenario path is not a directory: ${directory}`);
    const scenarios = readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => parseScenario(JSON.parse(readFileSync(join(directory, file), "utf8")), file));
    if (scenarios.length === 0) throw new Error(`no scenarios found in ${directory}`);
    return scenarios;
}

function requireValue(flag: string, value: string | undefined): string {
    if (value === undefined || value.length === 0 || value.startsWith("-")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

export function parseArgs(args: readonly string[]): CliArgs {
    let live = false;
    let reportPath = join(E2E_ROOT, "artifacts", "metamorphic-eval-report.json");
    let corpusDirectory = join(E2E_ROOT, "historian-eval", "dev");
    const scenarioIds: string[] = [];
    const transformIds: string[] = [];
    let deadlineMinutes: number | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--live") {
            live = true;
        } else if (arg === "--report") {
            reportPath = resolve(requireValue(arg, args[++index]));
        } else if (arg === "--scenarios") {
            corpusDirectory = resolve(requireValue(arg, args[++index]));
        } else if (arg === "--scenario") {
            scenarioIds.push(requireValue(arg, args[++index]));
        } else if (arg === "--transform") {
            transformIds.push(requireValue(arg, args[++index]));
        } else if (arg === "--deadline-minutes") {
            const raw = requireValue(arg, args[++index]);
            deadlineMinutes = Number(raw);
            if (!Number.isSafeInteger(deadlineMinutes) || deadlineMinutes < 1) {
                throw new Error(`--deadline-minutes expects a positive integer (got ${raw})`);
            }
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: run-metamorphic-eval.ts [--live] [--scenarios <dir>] [--scenario <id>] [--transform <id>] [--report <path>] [--deadline-minutes <n>]",
            );
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return {
        live,
        reportPath,
        corpusDirectory,
        scenarioIds: [...new Set(scenarioIds)].sort(),
        transformIds: [...new Set(transformIds)].sort(),
        deadlineMinutes,
    };
}

export function selectInputs(
    corpus: readonly HistorianEvalScenario[],
    args: Pick<CliArgs, "scenarioIds" | "transformIds"> & { live?: boolean },
): { scenarios: HistorianEvalScenario[]; transforms: Transform[] } {
    const knownScenarioIds = new Set(corpus.map((scenario) => scenario.id));
    const unknownScenarios = args.scenarioIds.filter((id) => !knownScenarioIds.has(id));
    if (unknownScenarios.length > 0) throw new Error(`unknown scenario filter(s): ${unknownScenarios.join(", ")}`);
    const knownTransformIds = new Set(TRANSFORMS.map((transform) => transform.id));
    const unknownTransforms = args.transformIds.filter((id) => !knownTransformIds.has(id));
    if (unknownTransforms.length > 0) throw new Error(`unknown transform filter(s): ${unknownTransforms.join(", ")}`);
    const scenarios = args.scenarioIds.length === 0
        ? [...corpus]
        : corpus.filter((scenario) => args.scenarioIds.includes(scenario.id));
    const transforms = args.transformIds.length === 0
        ? [...TRANSFORMS]
        : TRANSFORMS.filter((transform) => args.transformIds.includes(transform.id));
    if (args.live && scenarios.length !== 1) {
        throw new Error(`live metamorphic eval requires exactly one scenario; selected ${scenarios.length}`);
    }
    return { scenarios, transforms };
}

function writeReportFile(destination: string, report: MetamorphicReport): void {
    mkdirSync(dirname(destination), { recursive: true });
    const staging = `${destination}.tmp`;
    try {
        writeFileSync(staging, `${JSON.stringify(report, null, 2)}\n`);
        renameSync(staging, destination);
    } catch (error) {
        rmSync(staging, { force: true });
        throw error;
    }
}

export function partialReportPath(destination: string): string {
    return destination.endsWith(".json")
        ? `${destination.slice(0, -".json".length)}.partial.json`
        : `${destination}.partial.json`;
}

function containsPath(parent: string, candidate: string): boolean {
    const path = relative(resolve(parent), resolve(candidate));
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function removeRegularFile(path: string): void {
    if (existsSync(path) && lstatSync(path).isFile()) rmSync(path);
}

export function prepareLiveOutputPaths(
    reportPath: string,
    corpusDirectory: string,
): { artifactNamespace: string; partialPath: string } {
    const partialPath = partialReportPath(reportPath);
    const artifactNamespace = join(dirname(reportPath), "metamorphic-eval-artifacts");
    const overlapsCorpus = [reportPath, partialPath, artifactNamespace].some((path) =>
        containsPath(corpusDirectory, path),
    ) || containsPath(artifactNamespace, corpusDirectory);
    if (overlapsCorpus) {
        throw new Error("live report, partial report, and artifact paths must not overlap the scenario corpus");
    }
    removeRegularFile(reportPath);
    removeRegularFile(partialPath);
    return { artifactNamespace, partialPath };
}

function tierInvalidMessage(destination: string, report: MetamorphicReport): string | null {
    const reason = report.tierInvalidReason;
    if (reason === null) return null;
    if (reason.kind === "incomplete") return "metamorphic evaluation is incomplete";
    if (reason.kind === "selection-empty") return `metamorphic selection invalid: ${reason.reason}`;
    if (reason.kind === "deadline-exhausted") {
        return `metamorphic deadline reached before ${reason.nextRole}; inspect final report ${destination}`;
    }
    return "metamorphic tier invalid: control runs disagreed; product pairs were not evaluated";
}

export function logReport(destination: string, report: MetamorphicReport): 0 | 1 | 2 {
    const exitCode = metamorphicExitCode(report);
    const invalid = tierInvalidMessage(destination, report);
    if (invalid !== null) console.error(invalid);
    if (exitCode !== 0) {
        for (const hit of report.injectionCanaryHits) {
            console.error(`injection canary: ${JSON.stringify(hit)}`);
        }
        for (const coverage of report.coverage) {
            for (const violation of coverage.violations) {
                console.error(`coverage violation: ${coverage.scenarioId}: ${violation}`);
            }
        }
        for (const entry of report.entries) {
            const coordinates = `${entry.scenarioId}/${entry.transformId}@v${entry.transformVersion}/seed-${entry.seed}`;
            if (entry.kind !== "scored") {
                console.error(`non-scored pair: ${coordinates}: ${entry.kind}: ${"error" in entry ? entry.error : entry.diagnostics.join("; ")}`);
                continue;
            }
            if (entry.baselineScore.verdict !== "PASS" || entry.derivativeScore.verdict !== "PASS") {
                console.error(
                    `non-PASS pair: ${coordinates}: baseline=${entry.baselineScore.verdict}(${entry.baselineScore.failReasons.join(",")}) derivative=${entry.derivativeScore.verdict}(${entry.derivativeScore.failReasons.join(",")})`,
                );
            }
            for (const invariant of entry.invariants) {
                if (!invariant.holds) console.error(`failed invariant: ${coordinates}: ${JSON.stringify(invariant)}`);
            }
        }
    }
    console.log(
        `metamorphic eval: ${report.entries.length} pair(s), ${report.coverage.length} scenario(s), exit ${exitCode}; report ${destination}`,
    );
    return exitCode;
}

function writeReport(destination: string, report: MetamorphicReport): 0 | 1 | 2 {
    writeReportFile(destination, report);
    return logReport(destination, report);
}

export async function runLiveAndWriteReport(
    destination: string,
    scenarios: readonly HistorianEvalScenario[],
    options: LiveMetamorphicOptions,
): Promise<MetamorphicReport> {
    const partialPath = partialReportPath(destination);
    const callerProgress = options.onProgress;
    let partialSeeded = false;
    const report = await runLiveMetamorphicEval(scenarios, {
        ...options,
        onProgress(partial) {
            if (!partialSeeded) {
                writeReportFile(partialPath, partial);
                partialSeeded = true;
            } else {
                try {
                    writeReportFile(partialPath, partial);
                } catch (error) {
                    console.error(`metamorphic partial report update failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            try {
                callerProgress?.(partial);
            } catch (error) {
                console.error(`metamorphic progress observer failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    });
    writeReportFile(destination, report);
    if (partialSeeded) removeRegularFile(partialPath);
    logReport(destination, report);
    return report;
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<0 | 1 | 2> {
    const parsed = parseArgs(args);
    const corpus = loadCorpus(parsed.corpusDirectory);
    const selected = selectInputs(corpus, parsed);
    if (!parsed.live) {
        return writeReport(
            parsed.reportPath,
            runDeterministicMetamorphicEval(selected.scenarios, { transforms: selected.transforms }),
        );
    }

    const outputPaths = prepareLiveOutputPaths(parsed.reportPath, parsed.corpusDirectory);
    const prepared = prepareLivePreamble(corpus);
    if (prepared === null) return 1;
    const artifactRoot = join(
        outputPaths.artifactNamespace,
        `${basename(parsed.reportPath)}-${Date.now()}`,
    );
    const report = await runLiveAndWriteReport(parsed.reportPath, selected.scenarios, {
        mode: prepared.mode,
        artifactRoot,
        opencodeVersion: prepared.opencodeVersion,
        transforms: selected.transforms,
        deadlineAtMs: parsed.deadlineMinutes === null ? null : Date.now() + parsed.deadlineMinutes * 60_000,
    });
    return metamorphicExitCode(report);
}

if (import.meta.main) {
    main()
        .then((code) => process.exit(code))
        .catch((error: unknown) => {
            console.error(`metamorphic eval failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        });
}
