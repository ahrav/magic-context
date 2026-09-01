#!/usr/bin/env bun

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseScenario, type HistorianEvalScenario } from "../src/historian-eval/contract";
import {
    buildPluginBundle,
    liveAdmissionGate,
    liveModeFromEnv,
    opencodeVersion,
} from "./run-historian-eval";
import { liveRoleWallClockBudgetMs, runSystemTuple, type SystemVersionTuple } from "../src/historian-eval/runner";
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
): { mode: LiveMetamorphicOptions["mode"]; opencodeVersion: string; system: SystemVersionTuple } | null {
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
    const system = dependencies.runSystemTuple({ mode, opencodeVersion: opencode });
    if (system.repoCommitSha === "unknown") {
        console.error(
            "live admission: the checkout commit could not be resolved, so the report could not identify the code it ran",
        );
        return null;
    }
    return { mode, opencodeVersion: opencode, system };
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

export function stagingReportPath(destination: string): string {
    return `${destination}.tmp`;
}

function writeReportFile(destination: string, report: MetamorphicReport): void {
    mkdirSync(dirname(destination), { recursive: true });
    const staging = stagingReportPath(destination);
    /** lstat, not existsSync: writeFileSync would follow a symlink here and overwrite its target, then renameSync would publish the link. */
    const occupant = lstatSync(staging, { throwIfNoEntry: false });
    if (occupant !== undefined) {
        if (!occupant.isFile() && !occupant.isSymbolicLink()) {
            throw new Error(`report staging path is not a regular file: ${staging}`);
        }
        rmSync(staging, { force: true });
    }
    try {
        writeFileSync(staging, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
        renameSync(staging, destination);
    } catch (error) {
        rmSync(staging, { force: true });
        throw error;
    }
}

export function partialReportPath(destination: string): string {
    /** Appended rather than substituted for `.json`, because substituting maps `foo` and `foo.json` onto one partial. */
    return `${destination}.partial.json`;
}

/** Walks to the nearest existing ancestor and realpaths it, because a lexical resolve treats a symlinked corpus and its target as unrelated. */
function canonicalPath(path: string): string {
    const absolute = resolve(path);
    let existing = absolute;
    const missing: string[] = [];
    while (!existsSync(existing)) {
        const parent = dirname(existing);
        if (parent === existing) return absolute;
        missing.unshift(basename(existing));
        existing = parent;
    }
    return join(realpathSync(existing), ...missing);
}

function containsPath(parent: string, candidate: string): boolean {
    const path = relative(canonicalPath(parent), canonicalPath(candidate));
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function removeRegularFile(path: string): void {
    if (existsSync(path) && lstatSync(path).isFile()) rmSync(path);
}

/** Every path the runner itself writes, so preflight covers the staging files that publication touches only at the very end. */
function reportDestinations(reportPath: string): string[] {
    const partialPath = partialReportPath(reportPath);
    return [reportPath, stagingReportPath(reportPath), partialPath, stagingReportPath(partialPath)];
}

/** Suffixes the runner derives for its own auxiliary files and unlinks during preflight. */
const RESERVED_REPORT_SUFFIXES = [".tmp", ".partial.json"] as const;

function requireOwnableReportPath(reportPath: string): void {
    for (const suffix of RESERVED_REPORT_SUFFIXES) {
        if (reportPath.endsWith(suffix)) {
            throw new Error(
                `report path may not end in ${suffix}, a name this runner derives and deletes for its own auxiliary files: ${reportPath}`,
            );
        }
    }
}

/** Resolves each corpus entry, because a scenario symlink can target a path the directory-level containment check does not cover. */
function corpusFileTargets(corpusDirectory: string): Set<string> {
    if (!existsSync(corpusDirectory)) return new Set();
    try {
        return new Set(
            readdirSync(corpusDirectory)
                .filter((file) => file.endsWith(".json"))
                .map((file) => canonicalPath(join(corpusDirectory, file))),
        );
    } catch {
        return new Set();
    }
}

function requireReplaceableReportPath(label: string, path: string): void {
    const occupant = lstatSync(path, { throwIfNoEntry: false });
    if (occupant === undefined) return;
    if (occupant.isSymbolicLink()) {
        throw new Error(`${label} is a symlink; refusing to write through it: ${path}`);
    }
    if (!occupant.isFile()) {
        throw new Error(`${label} exists and is not a regular file: ${path}`);
    }
}

/** The namespace is a directory every live run reuses, so it takes a directory rule rather than the report-file shape check. */
function requireUsableArtifactNamespace(path: string): void {
    const occupant = lstatSync(path, { throwIfNoEntry: false });
    if (occupant === undefined) return;
    if (!occupant.isDirectory()) {
        throw new Error(`artifact namespace exists and is not a directory: ${path}`);
    }
}

function validateReportDestinations(
    label: string,
    reportPath: string,
    corpusDirectory: string,
    overlapPaths: readonly string[],
    reportFilePaths: readonly string[],
): void {
    requireOwnableReportPath(reportPath);
    if (overlapPaths.some((path) => containsPath(corpusDirectory, path))) {
        throw new Error(`${label} must not overlap the scenario corpus`);
    }
    const corpusTargets = corpusFileTargets(corpusDirectory);
    if (overlapPaths.some((path) => corpusTargets.has(canonicalPath(path)))) {
        throw new Error(`${label} must not resolve onto a scenario file in the corpus`);
    }
    for (const path of reportFilePaths) requireReplaceableReportPath(label, path);
}

export function prepareDeterministicOutputPaths(reportPath: string, corpusDirectory: string): void {
    const outputs = reportDestinations(reportPath);
    validateReportDestinations("report and staging paths", reportPath, corpusDirectory, outputs, outputs);
    for (const path of outputs) removeRegularFile(path);
}

export function prepareLiveOutputPaths(
    reportPath: string,
    corpusDirectory: string,
): { artifactNamespace: string; partialPath: string } {
    const partialPath = partialReportPath(reportPath);
    const artifactNamespace = join(dirname(reportPath), "metamorphic-eval-artifacts");
    const outputs = reportDestinations(reportPath);
    const label = "live report, partial report, staging, and artifact paths";
    if (containsPath(artifactNamespace, corpusDirectory)) {
        throw new Error(`${label} must not overlap the scenario corpus`);
    }
    validateReportDestinations(label, reportPath, corpusDirectory, [...outputs, artifactNamespace], outputs);
    requireUsableArtifactNamespace(artifactNamespace);
    /** The control run creates the namespace as a directory, so renameSync could never publish a report that lives inside it. */
    if (outputs.some((path) => containsPath(artifactNamespace, path))) {
        throw new Error(`live report paths must stay outside the artifact namespace: ${artifactNamespace}`);
    }
    for (const path of outputs) removeRegularFile(path);
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
    if (reason.kind === "control-error") {
        return `metamorphic tier invalid: a baseline control run errored (control-a=${reason.controlAErrorReason ?? "none"}, control-b=${reason.controlBErrorReason ?? "none"}); product pairs were not evaluated`;
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

/**
 * Reserve for one role, taken from the widest scenario in the selection.
 *
 * Delegates to `liveRoleWallClockBudgetMs` rather than multiplying the declared
 * runs by the historian wait: the runs are only the first of three phases the
 * runner waits on, and reserving just them under-counts a two-run, two-probe
 * role by half, which is enough for a role admitted just inside the deadline to
 * overrun the step timeout and lose the final report.
 *
 * Per scenario, not a corpus-wide product, because the reserve answers "can the
 * NEXT role finish" and a role runs exactly one scenario.
 */
export function liveRoleBudgetMs(
    scenarios: readonly HistorianEvalScenario[],
    mode: LiveMetamorphicOptions["mode"],
): number {
    return Math.max(0, ...scenarios.map((scenario) => liveRoleWallClockBudgetMs(scenario, mode)));
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<0 | 1 | 2> {
    /**
     * Anchored HERE, before any work, because the deadline's whole purpose is to
     * stay inside an external kill bound — the workflow step timeout — whose clock
     * starts when the step starts.
     *
     * Anchoring it at the `runLiveAndWriteReport` call instead excluded everything
     * before it: the output preflight, corpus load, selection, and
     * `prepareLivePreamble`, which resolves `opencode --version` and the commit.
     * A slow preamble then shifted the whole deadline later, so
     * `deadline < step timeout` no longer implied the run finished before the step
     * was killed, and the process could die mid-role after paid calls with only
     * partial evidence on disk. Measured from process start the nesting holds by
     * construction, with the preamble inside the deadline rather than beside it.
     */
    const startedAtMs = Date.now();
    const parsed = parseArgs(args);
    /** Output preflight precedes corpus loading and selection, whose throws would otherwise leave a previous green report at the destination. */
    if (!parsed.live) {
        prepareDeterministicOutputPaths(parsed.reportPath, parsed.corpusDirectory);
        const deterministicCorpus = loadCorpus(parsed.corpusDirectory);
        const deterministicSelection = selectInputs(deterministicCorpus, parsed);
        return writeReport(
            parsed.reportPath,
            runDeterministicMetamorphicEval(deterministicSelection.scenarios, {
                transforms: deterministicSelection.transforms,
            }),
        );
    }

    const outputPaths = prepareLiveOutputPaths(parsed.reportPath, parsed.corpusDirectory);
    const corpus = loadCorpus(parsed.corpusDirectory);
    const selected = selectInputs(corpus, parsed);
    const prepared = prepareLivePreamble(corpus);
    if (prepared === null) return 1;
    const roleBudgetMs = liveRoleBudgetMs(selected.scenarios, prepared.mode);
    /** Inclusive, matching the runner's own gate, so a deadline it would refuse never reaches paid setup. */
    if (parsed.deadlineMinutes !== null && parsed.deadlineMinutes * 60_000 <= roleBudgetMs) {
        console.error(
            `--deadline-minutes ${parsed.deadlineMinutes} does not exceed one role's budget of ${Math.ceil(roleBudgetMs / 60_000)} minutes; no scenario role could start`,
        );
        return 1;
    }
    const artifactRoot = join(
        outputPaths.artifactNamespace,
        `${basename(parsed.reportPath)}-${Date.now()}`,
    );
    const report = await runLiveAndWriteReport(parsed.reportPath, selected.scenarios, {
        mode: prepared.mode,
        artifactRoot,
        opencodeVersion: prepared.opencodeVersion,
        system: prepared.system,
        transforms: selected.transforms,
        roleBudgetMs,
        deadlineAtMs: parsed.deadlineMinutes === null ? null : startedAtMs + parsed.deadlineMinutes * 60_000,
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
