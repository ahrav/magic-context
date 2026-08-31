#!/usr/bin/env bun

/**
 * Historian structural eval lane writes one report artifact per run.
 *
 *
 *       --report artifacts/historian-eval-report.json
 * Live routing reads HISTORIAN_EVAL_MODEL and HISTORIAN_EVAL_PROBE_MODEL as provider/model routes and reads ANTHROPIC_API_KEY.
 */

import { execSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import {
    HARD_NEGATIVE_FAMILIES,
    HistorianEvalContractError,
    buildReleaseTuple,
    lintScenario,
    parseModelRoute,
    parseScenario,
    type HistorianEvalScenario,
} from "../src/historian-eval/contract";
import { runMutationBattery } from "../src/historian-eval/mutations";
import { checkFamilyCoverage, loadRelease } from "../src/historian-eval/promote";
import {
    runScenario,
    runSystemTuple,
    type LiveHistorianMode,
    type SystemVersionTuple,
} from "../src/historian-eval/runner";
import {
    buildLaneReport,
    laneBudgetExhaustedScore,
    laneExitCode,
    scenarioNotCompletedScore,
    scoreRunRecord,
    type ScenarioScore,
} from "../src/historian-eval/scorer";
import { E2E_ROOT } from "./validate-mode-manifest";

interface CliArgs {
    mode: "lint" | "mutations" | "live";
    scenariosDir: string | null;
    releaseDir: string | null;
    reportPath: string;
    /**
     * deadlineMinutes sets the live loop's wall-clock budget in minutes; null disables the deadline.
     *
     * The aggregate deadline lets scheduled runs stop between scenarios and publish partial reports; direct runs default to no deadline.
     * A release contains at most 30 scenarios and runs each twice, so per-run wait bounds do not bound the job's total duration.
     */
    deadlineMinutes: number | null;
}

function parseArgs(args: string[]): CliArgs {
    let mode: CliArgs["mode"] | null = null;
    let scenariosDir: string | null = null;
    let releaseDir: string | null = null;
    let reportPath = join(E2E_ROOT, "artifacts", "historian-eval-report.json");
    let deadlineMinutes: number | null = null;
    /**
     *
     */
    const requireValue = (flag: string, value: string | undefined): string => {
        if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`);
        if (value.startsWith("-")) throw new Error(`${flag} requires a value (got the option ${value})`);
        return value;
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--lint" || arg === "--mutations" || arg === "--live") {
            if (mode !== null) throw new Error("select exactly one of --lint, --mutations, --live");
            mode = arg.slice(2) as CliArgs["mode"];
        } else if (arg === "--scenarios") {
            scenariosDir = requireValue(arg, args[++index]);
        } else if (arg === "--release") {
            releaseDir = requireValue(arg, args[++index]);
        } else if (arg === "--report") {
            reportPath = requireValue(arg, args[++index]);
        } else if (arg === "--deadline-minutes") {
            const raw = requireValue(arg, args[++index]);
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${arg} expects a positive number (got "${raw}")`);
            deadlineMinutes = parsed;
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: run-historian-eval.ts (--lint | --mutations | --live) [--scenarios <dir> | --release <dir>] [--report <path>] [--deadline-minutes <n>]",
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
    return { mode, scenariosDir, releaseDir, reportPath, deadlineMinutes };
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

/**
 * The development gate applies promotion's scenario lint, release identity, and hard-negative coverage rules.
 * Matching promotion prevents corpora that pass development gating but fail promotion.
 * The dev split may be smaller than a releasable corpus because promotion alone enforces the release-size budget.
 *
 * `buildReleaseTuple` enforces promotion's semantic-duplicate check.
 * A copied scenario with a new id and title passes per-scenario lint, id uniqueness, and family coverage.
 * `scenarioFingerprint` cannot detect renamed copies as duplicates.
 * A semantic duplicate double-weights one evaluation in every published aggregate.
 * `buildReleaseTuple` rejects corpora with name-independent semantic duplicates.
 * Calling `buildReleaseTuple` keeps corpus admission aligned with promotion.
 */
function corpusDiagnostics(scenarios: readonly HistorianEvalScenario[]): string[] {
    const diagnostics = scenarios.flatMap((scenario) => lintScenario(scenario));
    try {
        buildReleaseTuple(scenarios);
    } catch (error) {
        if (!(error instanceof HistorianEvalContractError)) throw error;
        diagnostics.push(...error.diagnostics);
    }
    diagnostics.push(...checkFamilyCoverage(scenarios));
    return diagnostics.sort();
}

function runLint(scenarios: readonly HistorianEvalScenario[]): number {
    const diagnostics = corpusDiagnostics(scenarios);
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

export function liveModeFromEnv(): LiveHistorianMode {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const historianModel = process.env.HISTORIAN_EVAL_MODEL;
    const probeModel = process.env.HISTORIAN_EVAL_PROBE_MODEL;
    if (!apiKey || !historianModel || !probeModel) {
        throw new Error(
            "live mode needs ANTHROPIC_API_KEY, HISTORIAN_EVAL_MODEL, and HISTORIAN_EVAL_PROBE_MODEL (provider/model)",
        );
    }
    // `parseModelRoute` validates the historian route before the plugin receives it.
    //
    // The runner forwards the normalized route so whitespace-padded provider IDs do not reach the plugin.
    // `modelID` keeps any interior `/`, so reassembly is faithful.
    const route = parseModelRoute("HISTORIAN_EVAL_MODEL", historianModel);
    return {
        kind: "live",
        apiKey,
        historianModel: `${route.providerID}/${route.modelID}`,
        probeModel: parseModelRoute("HISTORIAN_EVAL_PROBE_MODEL", probeModel),
    };
}

/**
 * The runner records the OpenCode release in the run report's system tuple because the installer serves the current release.
 * Without the OpenCode release, runs that differ only by harness runtime have identical system identities.
 * Reports from different harness runtimes are not longitudinally comparable.
 */
export function opencodeVersion(): string | null {
    try {
        const version = execSync("opencode --version", { encoding: "utf8" }).trim();
        return version.length > 0 ? version : null;
    } catch {
        return null;
    }
}

/**
 * The runner applies the same corpus gate and mutation battery before each live run.
 *
 */
export function liveAdmissionGate(scenarios: readonly HistorianEvalScenario[]): number {
    const diagnostics = corpusDiagnostics(scenarios);
    if (diagnostics.length > 0) {
        for (const diagnostic of diagnostics) console.error(`live admission: ${diagnostic}`);
        return 1;
    }
    const evidence = runMutationBattery(scenarios);
    if (!evidence.green) {
        for (const entry of evidence.scenarios) {
            for (const result of entry.results) {
                if (!result.green) console.error(`live admission: ${entry.scenarioId} ${result.mutationClass}: RED (${result.detail})`);
            }
        }
        return 1;
    }
    return 0;
}

/**
 * The runner rebuilds the plugin bundle so OpenCode loads code matching the source tree used for the run.
 *
 * `opencode-runner/spawn.ts` loads `packages/plugin/dist/index.js` whenever that bundle exists.
 * `dist/` is gitignored, so `git status --porcelain` cannot report bundle changes.
 * The runner's dirty-worktree digest excludes the gitignored `dist/` bundle.
 * A stale bundle can make OpenCode load old plugin code while the report names the current source commit.
 * The system tuple cannot reveal a mismatch between stale bundled code and the current source commit.
 * A stale bundle invalidates longitudinal comparisons because the recorded tuple does not identify the loaded plugin code.
 * The runner builds before live evaluation because a live run consumes provider time and tokens.
 * way.
 *
 * The runner rebuilds instead of comparing mtimes because checkout metadata makes mtimes unreliable across checkouts.
 * Building makes the loaded bytes current regardless of checkout metadata.
 * `spawn.ts` resolves the plugin entry for each spawn, so subsequent spawns use the bundle built here.
 */
export function buildPluginBundle(): number {
    const repoRoot = resolve(E2E_ROOT, "..", "..");
    console.log("building the plugin bundle the harness loads...");
    // Without removal, the build inherits the live credential from `process.env`.
    // The build does not require `ANTHROPIC_API_KEY`.
    // The build requires inherited variables such as `PATH`, `HOME`, and Bun cache configuration.
    const { ANTHROPIC_API_KEY: _live, ...credentialFreeEnv } = process.env;
    // `buildPluginBundle` invokes the Bun executable running this process, not `bun` from `PATH`.
    // `runSystemTuple` records this process's `Bun.version`; the build must use the same executable.
    // Using `process.execPath` keeps the build's Bun version equal to the version recorded in the system tuple.
    // The build prefixes `PATH` so nested `bun` invocations use `process.execPath`.
    // The `build` script invokes `bun` for the TUI build and bundle.
    // Nested `bun` invocations resolve from `PATH`.
    const build = Bun.spawnSync([process.execPath, "run", "--cwd", "packages/plugin", "build"], {
        cwd: repoRoot,
        stdout: "inherit",
        stderr: "inherit",
        env: {
            ...credentialFreeEnv,
            PATH: `${dirname(process.execPath)}${delimiter}${credentialFreeEnv.PATH ?? ""}`,
        },
    });
    try {
        if (!build.success) throw new Error(`exited with code ${build.exitCode}`);
        return 0;
    } catch (error) {
        console.error(
            `live admission: plugin build failed, so the harness would load a stale or missing bundle: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
    }
}

/**
 *
 * Rewriting the partial report after each scenario preserves finished scenarios when the job is killed.
 * A scenario permits 100 probes, each with two 180-second `sendPrompt` attempts.
 * The 200 `sendPrompt` attempts can consume up to 10 hours of timeout time.
 * The job can be killed mid-scenario, and the final report is written only at the end.
 *
 * The runner uses a separate partial-report path so incomplete data cannot appear as the final report.
 * removes it.
 */
/**
 * The artifacts directory stores files derived by this lane next to the report.
 *
 * Refusing report paths under the private namespace keeps derived paths unreachable.
 * One containment check prevents collisions for every derived artifact name.
 *
 * The runner keys each report's artifact subdirectory by its complete filename so artifacts for distinct reports cannot collide.
 * Each run clears only its own subdirectory.
 */
const LANE_ARTIFACTS_DIR = "historian-eval-artifacts";

function laneArtifactsRoot(reportPath: string): string {
    return join(dirname(resolve(reportPath)), LANE_ARTIFACTS_DIR);
}

function laneArtifactsDir(reportPath: string): string {
    return join(laneArtifactsRoot(reportPath), basename(resolve(reportPath)));
}

/* */
function liveRunArtifactsDir(reportPath: string): string {
    return join(laneArtifactsDir(reportPath), "runs");
}

function partialReportPath(reportPath: string): string {
    return join(laneArtifactsDir(reportPath), "partial-report.json");
}

/**
 *
 * `reportInsideLaneNamespaceError` rejects reports inside `LANE_ARTIFACTS_DIR` to prevent collisions with lane artifacts.
 * A report path outside `LANE_ARTIFACTS_DIR` cannot contain a lane artifact path.
 */
function reportInsideLaneNamespaceError(reportPath: string): string | null {
    // `reportInsideLaneNamespaceError` checks every path segment because `laneArtifactsRoot` for an in-namespace report is computed below the enclosing namespace.
    const report = canonicalPath(reportPath);
    // `reportInsideLaneNamespaceError` includes the final path segment because cleanup would delete a report path equal to the artifact directory.
    // previous one.
    if (report.split(sep).includes(LANE_ARTIFACTS_DIR)) {
        return `a report may not live inside a ${LANE_ARTIFACTS_DIR} directory (${report}): that is where this lane derives its own artifacts`;
    }
    return null;
}


function writePartialReport(
    reportPath: string,
    scores: readonly ScenarioScore[],
    releaseVersion: string | null,
    system: SystemVersionTuple,
): boolean {
    if (scores.length === 0) return false;
    try {
        const report = buildLaneReport(scores, {
            system,
            ...(releaseVersion === null ? {} : { releaseVersion }),
        });
        // `writePartialReport` writes to a sibling temporary file and renames it so a failed write cannot truncate the existing partial report.
        // A failed direct write, such as one caused by a full filesystem, could truncate the existing partial report.
        // Same-directory `renameSync` atomically replaces the partial report.
        // Same-directory `renameSync` leaves either the previous complete report or the new report.
        const destination = partialReportPath(reportPath);
        const staging = join(dirname(destination), "partial-report.json.tmp");
        try {
            writeFileSync(staging, `${JSON.stringify(report, null, 2)}\n`);
            renameSync(staging, destination);
        } catch (error) {
            rmSync(staging, { force: true });
            throw error;
        }
        return true;
    } catch (error) {
        console.error(`partial report not written: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * `reportPathShapeError` rejects symlink and non-file report paths because this run writes and clears the report.
 * write.
 *
 */
function reportPathShapeError(reportPath: string): string | null {
    const report = resolve(reportPath);
    // `reportPathShapeError` checks symlinks before `existsSync` because `existsSync` returns false for dangling symlinks.
    if (isSymlink(report)) {
        return `${report} is a symlink; a report path must be a regular file, since this run both writes and clears it`;
    }
    if (existsSync(report) && !lstatSync(report).isFile()) {
        return `${report} exists and is not a regular file, so this run cannot write its report there`;
    }
    return null;
}

/**
 *
 *
 */
function laneNamespaceRootShapeError(reportPath: string): string | null {
    const root = laneArtifactsRoot(reportPath);
    if (isSymlink(root)) {
        return `${root} is a symlink; this lane will not derive its artifacts through a link it would then clear recursively`;
    }
    if (existsSync(root) && !lstatSync(root).isDirectory()) {
        return `${root} exists and is not a directory, so this lane has nowhere to put its artifacts`;
    }
    return null;
}

async function runLive(args: CliArgs): Promise<number> {
    const { scenarios, releaseVersion } = loadCorpus(args);
    // requires.
    const mode = liveModeFromEnv();
    const built = buildPluginBundle();
    if (built !== 0) return built;
    const admission = liveAdmissionGate(scenarios);
    if (admission !== 0) return admission;
    const opencode = opencodeVersion();
    if (opencode === null) {
        console.error(
            "live admission: `opencode --version` did not resolve, so the report could not identify the release it ran against",
        );
        return 1;
    }
    const system = runSystemTuple({ mode, opencodeVersion: opencode });
    if (system.repoCommitSha === "unknown") {
        console.error(
            "live admission: the checkout commit could not be resolved, so the report could not identify the code it ran",
        );
        return 1;
    }
    const reportDir = dirname(resolve(args.reportPath));
    // Relying on `runScenario` would depend on its internal ordering and suppressed partial-write errors.
    mkdirSync(reportDir, { recursive: true });
    mkdirSync(laneArtifactsDir(args.reportPath), { recursive: true });
    const artifactsRoot = liveRunArtifactsDir(args.reportPath);
    // `laneArtifactsDir(args.reportPath)` can already exist because the user supplies `args.reportPath`.
    // Reject collisions before scenarios spend tokens.
    // Seeding `scores` makes each partial report include every scenario.
    // Seeding `scores` gives the initial partial report an incomplete entry for every scenario.
    // Write the initial partial report before the first request so an interrupted first scenario leaves an incomplete report.
    const scores: ScenarioScore[] = scenarios.map((scenario) => scenarioNotCompletedScore(scenario.id, system));
    // Set `deadlineAt` after the build and battery so it covers token-spending work.
    const deadlineAt = args.deadlineMinutes === null ? null : Date.now() + args.deadlineMinutes * 60_000;
    // The longest completed scenario estimates the next scenario's duration.
    // `index > 0` skips the deadline estimate for the first scenario because no completed scenario provides one.
    let longestScenarioMs = 0;
    // Write the initial partial report before the first request so an interrupted first scenario leaves an incomplete report.
    if (!writePartialReport(args.reportPath, scores, releaseVersion, system)) {
        console.error("live admission: the initial partial report could not be written; refusing to spend tokens");
        return 1;
    }
    for (const [index, scenario] of scenarios.entries()) {
        // Check the deadline before each scenario; never stop a scenario mid-run.
        // Starting a scenario whose estimated duration exceeds the remaining budget can exceed the lane deadline.
        if (deadlineAt !== null && index > 0 && Date.now() + longestScenarioMs > deadlineAt) {
            const unreached = scenarios.slice(index);
            console.error(
                `lane budget: ${unreached.length} scenario(s) not run; ${Math.round(longestScenarioMs / 60_000)} minute(s) needed for the next, ${Math.round((deadlineAt - Date.now()) / 60_000)} remaining`,
            );
            for (const [offset, skipped] of unreached.entries()) {
                scores[index + offset] = laneBudgetExhaustedScore(skipped.id, system);
            }
            writePartialReport(args.reportPath, scores, releaseVersion, system);
            break;
        }
        const artifactDir = join(artifactsRoot, scenario.id);
        console.log(`running ${scenario.id}...`);
        const startedAt = Date.now();
        const record = await runScenario(scenario, {
            mode,
            artifactDir,
            opencodeVersion: opencode,
        });
        longestScenarioMs = Math.max(longestScenarioMs, Date.now() - startedAt);
        const score = scoreRunRecord(record, scenario);
        scores[index] = score;
        console.log(
            `${scenario.id}: ${score.verdict}${score.failReasons.length > 0 ? ` [${score.failReasons.join(",")}]` : ""}${score.errorReason ? ` (${score.errorReason})` : ""}`,
        );
        writePartialReport(args.reportPath, scores, releaseVersion, system);
    }
    const report = buildLaneReport(scores, {
        system,
        ...(releaseVersion === null ? {} : { releaseVersion }),
    });
    // Write the completed report to staging, then rename it so a failed write cannot corrupt the completed-report path.
    // Write the completed report to staging so a failed write cannot corrupt the completed-report path.
    // Remove the partial report only after the completed report is renamed.
    // The rename succeeds before the partial report is removed, so one complete report remains available.
    const reportDestination = resolve(args.reportPath);
    const reportStaging = join(laneArtifactsDir(args.reportPath), "report.json.tmp");
    try {
        writeFileSync(reportStaging, `${JSON.stringify(report, null, 2)}\n`);
        renameSync(reportStaging, reportDestination);
    } catch (error) {
        rmSync(reportStaging, { force: true });
        throw error;
    }
    rmSync(partialReportPath(args.reportPath), { force: true });
    console.log(
        `published ${args.reportPath}: ${report.aggregate.total} scenario(s), red=${report.red}, runFatal=${report.runFatal}`,
    );
    return laneExitCode(report);
}

/**
 * Remove prior reports and run records before fallible work so a failed run cannot leave stale artifacts.
 *
 * Remove the completed report before fallible work so archival cannot collect a stale result.
 */
/**
 * canonicalPath returns a canonical filesystem location for a path that may not exist.
 *
 * `resolve` leaves symlink components intact, so containment checks must canonicalize an existing ancestor.
 */
function canonicalPath(path: string): string {
    const absolute = resolve(path);
    const trailing: string[] = [];
    let probe = absolute;
    for (;;) {
        if (existsSync(probe)) return join(realpathSync.native(probe), ...trailing.reverse());
        const parent = dirname(probe);
        if (parent === probe) return absolute;
        trailing.push(basename(probe));
        probe = parent;
    }
}

/**
 *
 * Check output-path overlap before cleanup to avoid deleting the selected corpus.
 * Reject artifact paths that overlap the selected corpus before cleanup can delete corpus input.
 * Cleanup can remove corpus input when an artifact path is inside the corpus.
 * A report path of `/tmp/a` derives `/tmp/a-runs`; selecting `/tmp/a-runs` as the corpus lets cleanup remove it recursively.
 * recursively removed.
 *
 * The overlap check tests containment in both directions: an artifact inside the corpus deletes part of it, and an artifact containing the corpus deletes all of it.
 * The overlap check resolves paths and requires a separator boundary, so `/tmp/a-runs` is outside `/tmp/a`.
 * inside `/tmp/a`.
 */



function artifactCorpusOverlapError(args: CliArgs): string | null {
    const corpus = args.releaseDir ?? args.scenariosDir;
    if (corpus === null) return null;
    const root = canonicalPath(corpus);
    const within = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}${sep}`);
    for (const [label, owned] of [
        ["report", canonicalPath(args.reportPath)],
        // `artifactCorpusOverlapError` checks `laneArtifactsDir(reportPath)` because cleanup removes that directory recursively.
        ["artifact directory", canonicalPath(laneArtifactsDir(args.reportPath))],
    ] as const) {
        if (within(owned, root) || within(root, owned)) {
            return `the ${label} path ${owned} overlaps the selected corpus at ${root}; refusing to clear artifacts that would delete corpus input`;
        }
    }
    return null;
}

/** `isSymlink` returns true for symlinks, including dangling symlinks (`existsSync` returns false). */
function isSymlink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

/* */
function removeIfFile(path: string): void {
    if (existsSync(path) && lstatSync(path).isFile()) rmSync(path, { force: true });
}

function clearPreviousLiveArtifacts(reportPath: string): void {
    // `rmSync` without `recursive` throws when the report path is a directory.
    removeIfFile(resolve(reportPath));
    // `lstatSync` identifies a symlink without following its target.
    // Removing a lane symlink prevents artifact writes from following it outside the lane namespace.
    // Removing either a directory or a symlink leaves `owned` absent.
    // Removing a symlink unlinks the symlink without removing its target.
    const owned = laneArtifactsDir(reportPath);
    if (existsSync(owned) || isSymlink(owned)) {
        rmSync(owned, { recursive: true, force: true });
    }
}

async function main(): Promise<number> {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.mode === "live") {
        // A refusal after cleanup cannot prevent cleanup from removing corpus input.
        for (const problem of [
            reportPathShapeError(args.reportPath),
            laneNamespaceRootShapeError(args.reportPath),
            reportInsideLaneNamespaceError(args.reportPath),
            artifactCorpusOverlapError(args),
        ]) {
            if (problem !== null) {
                console.error(`live admission: ${problem}`);
                return 1;
            }
        }
        clearPreviousLiveArtifacts(args.reportPath);
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
