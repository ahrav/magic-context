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
     * Wall-clock budget for the whole live loop, in minutes, or null for none.
     *
     * A scheduled run needs this because the per-run historian waits are bounded
     * individually, not in aggregate: the release size budget allows 30 scenarios
     * and two runs each, so the worst-case waits exceed any job timeout GitHub
     * permits. Without a budget the runner is killed mid-scenario and publishes no
     * report at all, having already spent the tokens. With one it stops between
     * scenarios and publishes what it has. An operator running directly has no such
     * external killer, so the default is no deadline.
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
     * Value for an option that requires one, or a diagnostic naming the option.
     *
     * A bare `args[++index]` yields `undefined` for a trailing flag, and
     * `undefined !== null` skips the default fallback below — so `--lint
     * --scenarios` reached `resolve(undefined)` and died on `The "paths[0]"
     * property must be of type string`, which names neither the flag nor the
     * mistake. Omitting a value mid-command is worse: `--scenarios --report x`
     * consumed `--report` as the directory and then blamed `x` as an unknown
     * argument. Rejecting a leading `-` catches that case at the flag that is
     * actually missing its value.
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
 * Corpus admission for the per-PR gate, built from the same rules freeze
 * promotion applies: per-scenario lint, the release tuple's corpus-level identity
 * rules, and hard-negative family coverage. Mirroring promotion is the point — a
 * corpus this gate accepts but promotion would reject could never be frozen, and
 * the reverse would let a release freeze in a state that keeps this gate
 * permanently red. The release size budget is promotion-only: the dev split is
 * deliberately smaller than a releasable corpus.
 *
 * `buildReleaseTuple` is CALLED rather than its rules restated, because one of
 * them cannot be reproduced by any check written here. Hand-rolled id uniqueness
 * misses a scenario copied under a new id and title: every per-scenario lint stays
 * clean, the ids differ, family coverage is unchanged — and `scenarioFingerprint`
 * covers id and title, so the copy has a new identity by construction and no
 * identity-based test can see it, while it double-weights one evaluation in every
 * aggregate the report publishes. The tuple's name-independent semantic
 * fingerprint is the check that catches it, and promotion already refuses such a
 * corpus. Calling the same function keeps the two exactly as strict as each other
 * instead of as strict as whoever last edited both.
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
    //
    // The NORMALIZED components are what travel onward. `parseModelRoute` trims
    // each side, so forwarding the raw value lets `anthropic / claude-sonnet-4-5`
    // satisfy this preflight and then fail inside the historian on a provider id
    // containing a space — after the harness, transcript, and run work is spent.
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
 * Recorded in the run report's system tuple: the installer serves whatever
 * OpenCode release is current, so identical weekly runs can sit on different
 * harness runtimes. Without this, their system identity would match and the
 * reports would look longitudinally comparable when they are not.
 */
function opencodeVersion(): string | null {
    try {
        const version = execSync("opencode --version", { encoding: "utf8" }).trim();
        return version.length > 0 ? version : null;
    } catch {
        return null;
    }
}

/**
 * Deterministic admission for a live run: the same corpus gate and mutation
 * battery the per-PR lane applies, re-run here against the corpus this
 * invocation actually loaded.
 *
 * Only the GitHub workflow chains `--lint` and `--mutations` ahead of `--live`,
 * so a direct `--live --scenarios <dir>` — the documented operator command —
 * would otherwise drive real provider traffic against a semantically invalid or
 * mutation-red corpus and publish stability verdicts off it. The gates are
 * deterministic and cost seconds; a live run costs minutes and tokens, so they
 * run ahead of the loop and refuse rather than warn. Applied to a frozen release
 * too: the release's own evidence proves the battery was green when it froze, not
 * that it is green under the scorer in this checkout.
 */
function liveAdmissionGate(scenarios: readonly HistorianEvalScenario[]): number {
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
 * Rebuild the plugin bundle the harness will load, so the recorded commit
 * identifies the code that actually ran.
 *
 * `opencode-runner/spawn.ts` prefers `packages/plugin/dist/index.js` over
 * `src/index.ts` whenever the bundle exists, and `dist/` is gitignored — so
 * `git status --porcelain` never sees it and the runner's dirty-worktree digest
 * excludes it entirely. A stale bundle therefore makes OpenCode load old plugin
 * code while the report names the current source commit, with no system-tuple
 * mismatch to reveal it. That silently invalidates exactly the longitudinal
 * comparison the tuple exists to protect, and a live run is far too expensive to
 * discover it afterwards. The scheduled workflow already builds before running;
 * this is the same command, so the documented direct command behaves the same
 * way.
 *
 * Rebuilding rather than staleness-checking: an mtime comparison is a weak oracle
 * across checkouts, and building makes the loaded bytes current by construction.
 * `spawn.ts` resolves its plugin entry per spawn rather than at module load, so
 * this build is visible to the run that follows it — including the case where no
 * bundle existed beforehand, which previously latched the entry to `src/` for the
 * whole process and made a direct run exercise a different plugin entrypoint than
 * a prebuilt scheduled run under the same recorded identity.
 */
function buildPluginBundle(): number {
    const repoRoot = resolve(E2E_ROOT, "..", "..");
    console.log("building the plugin bundle the harness loads...");
    // The live credential is already in this process's environment by the time
    // this runs, and the workflow deliberately builds the plugin in a
    // credential-free step. Inheriting the ambient environment would hand the
    // production key to `tsc`, Bun's bundler, and the TUI build script — a build
    // toolchain with no need for it — before any provider call. Stripped rather
    // than passing a minimal allowlist, because the build legitimately needs PATH,
    // HOME, and the Bun install cache, and enumerating those is how a build breaks
    // on the next toolchain change.
    const { ANTHROPIC_API_KEY: _live, ...credentialFreeEnv } = process.env;
    // The RUNNING Bun, not whatever `bun` resolves to on PATH. `runSystemTuple`
    // records `Bun.version` of this process, so shelling out to a different
    // executable — an absolute version-manager path invoking the lane is enough —
    // produced a bundle built by Bun B under a tuple claiming Bun A, which is the
    // drift the field was added to make visible.
    // PATH is prefixed as well as the argv0 being explicit, because the package's
    // `build` script itself shells out to `bun` several times — for the TUI build and
    // the bundle — and those nested calls resolve from PATH. Setting only argv0 left
    // them on a different executable, which is the same drift one level down.
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
 * Partial report beside the real one, rewritten after every scenario.
 *
 * This — not the deadline below — is what guarantees the run leaves evidence. A
 * per-scenario worst case cannot be predicted usefully: the contract admits 100
 * probes, each of which can take two `sendPrompt` attempts at the harness's
 * 180-second default, so one scenario's true bound is around ten hours, above any
 * job timeout GitHub allows. Gating on that would refuse to start a scenario the
 * lane is supposed to run; gating on anything smaller is an estimate a scenario
 * can exceed. Either way the job can be killed mid-scenario, and the report is
 * only written at the end.
 *
 * So the report becomes incremental instead. A separate `.partial.json` path
 * rather than the real one, because a truncated report at the documented path
 * would read as a complete result for a smaller corpus: the aggregate rates are
 * micro-averaged over whatever it contains. The workflow archives the whole
 * artifacts directory with `if: always()`, so a killed job now uploads the
 * scenarios that finished, clearly labelled as partial, and a completed run
 * removes it.
 */
/**
 * Directory holding every artifact this lane derives, beside the report.
 *
 * A PRIVATE namespace, and reports are refused inside it — that pairing is what
 * makes the derived paths unreachable. Decorating the operator's report path
 * instead put each artifact at a name the CLI also accepts as a report, and every
 * such name became a collision to patch: `foo-runs` versus a report named
 * `foo-runs`, `foo.partial.json`, `foo.partial.json.tmp`, then a report nested
 * under `foo-runs/`. One containment refusal covers all of them and every name
 * added later, which is why the per-name guards are gone.
 *
 * Per-report subdirectory keyed by the report's complete filename: distinct reports
 * in one directory have distinct filenames, so their artifacts cannot collide, and
 * a run only ever clears its own subdirectory.
 */
const LANE_ARTIFACTS_DIR = "historian-eval-artifacts";

function laneArtifactsRoot(reportPath: string): string {
    return join(dirname(resolve(reportPath)), LANE_ARTIFACTS_DIR);
}

function laneArtifactsDir(reportPath: string): string {
    return join(laneArtifactsRoot(reportPath), basename(resolve(reportPath)));
}

/** Run records and DB snapshots, one subdirectory per scenario. */
function liveRunArtifactsDir(reportPath: string): string {
    return join(laneArtifactsDir(reportPath), "runs");
}

function partialReportPath(reportPath: string): string {
    return join(laneArtifactsDir(reportPath), "partial-report.json");
}

/**
 * Whether the report itself was aimed inside the lane's private namespace.
 *
 * The one refusal the namespace needs: with reports kept out, no accepted report
 * path can equal or contain any artifact path, so staging files, records trees, and
 * partial reports are all unreachable without a per-name check.
 */
function reportInsideLaneNamespaceError(reportPath: string): string | null {
    // Tested against every ancestor SEGMENT, not against this report's own derived
    // root. `laneArtifactsRoot` is relative to the report's directory, so a report
    // already sitting inside a namespace has its root computed one level deeper and
    // a containment test against that root passes — which is how
    // `<dir>/historian-eval-artifacts/r.json` slipped through and nested a second
    // namespace inside the first.
    const report = canonicalPath(reportPath);
    // The whole path, final segment included. Checking only ancestors let
    // `--report <dir>/historian-eval-artifacts` through, and then
    // `laneArtifactsRoot` equalled the report itself: cleanup removed the report,
    // `mkdirSync` recreated that path as a directory, and the shape check rejected
    // the run — a report path that can never produce a report but can destroy the
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
        // Temp sibling then rename, because `writeFileSync` TRUNCATES before it
        // writes: a failure partway — a full filesystem is the obvious one — would
        // otherwise replace the accumulated evidence with truncated JSON, which is
        // strictly worse than not writing at all and would falsify the guarantee
        // below. `renameSync` within one directory is atomic, so the partial is
        // either the previous complete report or the new one.
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
        // Never let progress bookkeeping fail a run that already has evidence on
        // disk — a failed write now leaves the previous partial intact, which is
        // stale but real, because the write above is atomic. The caller decides;
        // only the SEED write is fatal, because until the first scenario finishes it
        // is the only report there is.
        console.error(`partial report not written: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Whether the operator-named report path already exists in a shape this run cannot
 * write.
 *
 * Only the report needs this now. Every other artifact lives inside the lane's
 * private subdirectory, which `clearPreviousLiveArtifacts` removes and recreates
 * wholesale, so it cannot be occupied by something of the wrong shape. Reported as
 * an admission failure so the run refuses before provider traffic instead of
 * surfacing a bare EISDIR from the final write.
 */
function reportPathShapeError(reportPath: string): string | null {
    const report = resolve(reportPath);
    // Symlinks first, because a DANGLING one makes `existsSync` false and skips the
    // shape test below — and `canonicalPath` resolves it to its own location rather
    // than its target, so the corpus-overlap check compares the wrong path while the
    // final write follows the link. A live symlink is refused for the same reason:
    // this path is also removed, and following a link to decide what to delete is
    // how the namespace-root case below went wrong.
    if (isSymlink(report)) {
        return `${report} is a symlink; a report path must be a regular file, since this run both writes and clears it`;
    }
    if (existsSync(report) && !lstatSync(report).isFile()) {
        return `${report} exists and is not a regular file, so this run cannot write its report there`;
    }
    return null;
}

/**
 * Whether the lane's namespace ROOT is something other than a real directory.
 *
 * The per-report path being safe is not enough: with
 * `<report-dir>/historian-eval-artifacts` linked elsewhere, `laneArtifactsDir`
 * traverses the link and the recursive clear deletes the matching subtree in the
 * target — a link to `/data` makes a run for `report.json` remove `/data/report.json`.
 *
 * Refused rather than replaced, unlike the per-report path. The root is shared by
 * every report in the directory, so removing it would discard sibling reports'
 * evidence, and an operator who linked it did so deliberately.
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
    // Routing first: it is instantaneous, and an operator who forgot a variable
    // should not wait out the build and battery to be told so. All three still
    // precede the first request, which is what "before any token is spent"
    // requires.
    const mode = liveModeFromEnv();
    const built = buildPluginBundle();
    if (built !== 0) return built;
    const admission = liveAdmissionGate(scenarios);
    if (admission !== 0) return admission;
    // An unresolved version is refused rather than recorded as "unknown". The
    // installer serves whatever release is current, so this field is the only thing
    // distinguishing two runs on different OpenCode releases — and a wrapper that
    // answers `serve` but not `--version` would let a costly evaluation publish a
    // tuple that silently matches a different release's.
    const opencode = opencodeVersion();
    if (opencode === null) {
        console.error(
            "live admission: `opencode --version` did not resolve, so the report could not identify the release it ran against",
        );
        return 1;
    }
    // Built BEFORE the first request, from the same function the runner records, so
    // an interrupted first scenario still publishes a report that names the commit,
    // OpenCode version, and model routes that spent the tokens. Supplying it to
    // `buildLaneReport` also cross-checks it: `resolveReportSystem` rejects a
    // supplied tuple that disagrees with the scored records'.
    const system = runSystemTuple({ mode, opencodeVersion: opencode });
    // Same reasoning as the OpenCode version: an exported tree with no `.git` leaves
    // `resolveRepoCommitSha` at "unknown", and two different code versions then
    // publish identical tuples after spending tokens. The sha is the primary axis of
    // this identity, so it is the last thing that should degrade to a placeholder.
    if (system.repoCommitSha === "unknown") {
        console.error(
            "live admission: the checkout commit could not be resolved, so the report could not identify the code it ran",
        );
        return 1;
    }
    const reportDir = dirname(resolve(args.reportPath));
    // Before anything writes into it, including the first partial. Today the
    // directory happens to exist by the time that write lands, because
    // `runScenario` creates `<reportDir>/<report-stem>-runs/<id>`
    // recursively — but that is an accident of where the run artifacts live and of
    // the runner's internal ordering, and the partial write swallows its errors,
    // so relying on it would make the guarantee silently depend on both.
    // Removal of the PREVIOUS run's artifacts happens earlier still, in
    // `clearPreviousLiveArtifacts`, ahead of everything that can reject.
    mkdirSync(reportDir, { recursive: true });
    mkdirSync(laneArtifactsDir(args.reportPath), { recursive: true });
    const artifactsRoot = liveRunArtifactsDir(args.reportPath);
    // Refused here rather than discovered inside the first scenario. All three paths
    // are derived from a user-supplied report name, so each can already exist in the
    // wrong shape — a previous audit written to `--report <this>-runs`, or a
    // directory where a report file belongs. `clearPreviousLiveArtifacts` will not
    // remove any of them, so left unchecked the collision surfaces as a raw ENOTDIR
    // or EISDIR from deep inside the first scenario, after its tokens are spent.
    // One entry per scenario from the start, replaced in place as each finishes.
    // Seeding the whole corpus is what makes every partial describe the whole
    // corpus, and what leaves evidence when the process dies inside the FIRST
    // scenario — the case "write after each scenario" cannot cover, because
    // nothing has completed while the tokens are already spent.
    const scores: ScenarioScore[] = scenarios.map((scenario) => scenarioNotCompletedScore(scenario.id, system));
    // Measured after the build and battery, so the budget covers the part that
    // spends tokens rather than the deterministic preamble.
    const deadlineAt = args.deadlineMinutes === null ? null : Date.now() + args.deadlineMinutes * 60_000;
    // Reserve for the next scenario, learned from the ones already run rather than
    // predicted. A scenario's true bound is unusable (see `partialReportPath`), and
    // an invented one is either too pessimistic to run the corpus or too optimistic
    // to hold. The longest completed scenario is the honest estimate of the next
    // one, the first scenario always runs, and a scenario that overruns the
    // estimate costs the partial report rather than the whole artifact.
    let longestScenarioMs = 0;
    // Admission, not bookkeeping: this seed is the only report until the first
    // scenario completes, so a directory that cannot take it means an interruption
    // would leave nothing to archive — after the tokens were spent. Checked here,
    // still before the first request.
    if (!writePartialReport(args.reportPath, scores, releaseVersion, system)) {
        console.error("live admission: the initial partial report could not be written; refusing to spend tokens");
        return 1;
    }
    for (const [index, scenario] of scenarios.entries()) {
        // Checked BEFORE starting, never mid-scenario: a scenario abandoned
        // half-way has spent its tokens and produced no record, so the only useful
        // decision point is whether to begin.
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
        // `repoCommitSha` is deliberately not supplied: the runner's own
        // resolver folds an uncommitted tracked diff and the untracked set into
        // the recorded sha, and overriding it with a plain `git rev-parse HEAD`
        // gave two different experimental trees the same system tuple — exactly
        // the collision that identity exists to prevent.
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
    // Same temp-then-rename as the partial, and for a sharper reason: a failure
    // partway through this write leaves invalid JSON at the path operators are
    // documented to read as the completed result, which would hide the valid partial
    // beside it. The partial is removed only after the rename succeeds, so at every
    // instant at least one complete report exists.
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
 * Every artifact a previous live run may have left behind, removed together and
 * before anything that can fail.
 *
 * The completed report was already cleared here so an always-run archive step
 * could not collect a stale success after a failure. The partial report and the
 * run-record tree need the same treatment and the same timing: corpus loading,
 * route validation, the plugin build, and the admission gate can all reject, and
 * clearing downstream of them left a previous run's partial and records sitting in
 * a directory whose completed report had just been deleted — evidence that reads
 * as this invocation's.
 */
/**
 * Canonical filesystem location of a path that may not exist yet.
 *
 * `resolve` is purely lexical, so it leaves symlink components intact and a
 * containment test over its output can be defeated by one: with `/tmp/out` linked
 * to `/tmp/dev`, `--report /tmp/out/hse-a.json` is lexically outside
 * `--scenarios /tmp/dev` while writing straight into it. Output paths do not exist
 * when the check runs, and `realpathSync` throws on a missing path, so the nearest
 * EXISTING ancestor is canonicalized and the remaining segments are rejoined.
 */
function canonicalPath(path: string): string {
    const absolute = resolve(path);
    const trailing: string[] = [];
    let probe = absolute;
    for (;;) {
        if (existsSync(probe)) return join(realpathSync.native(probe), ...trailing.reverse());
        const parent = dirname(probe);
        // Filesystem root: nothing above it exists either, so the lexical form is
        // the best available answer.
        if (parent === probe) return absolute;
        trailing.push(basename(probe));
        probe = parent;
    }
}

/**
 * Whether any path this run will WRITE overlaps the corpus it will READ.
 *
 * Checked before a single removal, because the cleanup runs before `loadCorpus`:
 * `--scenarios dev --report dev/hse-foo.json` deletes a scenario and then evaluates
 * the silently reduced corpus, publishing a report over a corpus nobody selected and
 * finally overwriting the input with it. The records directory is worse — a report of
 * `/tmp/a` derives `/tmp/a-runs`, so `--scenarios /tmp/a-runs` has its entire corpus
 * recursively removed.
 *
 * Containment is tested BOTH ways: an artifact inside the corpus deletes part of it,
 * and an artifact that contains the corpus deletes all of it. Comparison is on
 * resolved paths with a separator boundary, so `/tmp/a-runs` is not treated as living
 * inside `/tmp/a`.
 */



function artifactCorpusOverlapError(args: CliArgs): string | null {
    const corpus = args.releaseDir ?? args.scenariosDir;
    if (corpus === null) return null;
    const root = canonicalPath(corpus);
    const within = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}${sep}`);
    for (const [label, owned] of [
        ["report", canonicalPath(args.reportPath)],
        // The per-report artifact directory, because that is what cleanup removes
        // RECURSIVELY. Listing only its `partial-report.json` and `runs` children
        // missed a corpus selected from anywhere else inside it.
        ["artifact directory", canonicalPath(laneArtifactsDir(args.reportPath))],
    ] as const) {
        if (within(owned, root) || within(root, owned)) {
            return `the ${label} path ${owned} overlaps the selected corpus at ${root}; refusing to clear artifacts that would delete corpus input`;
        }
    }
    return null;
}

/** True for a symlink, including one whose target is missing (`existsSync` is false). */
function isSymlink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

/** Removes a path only when it is a regular file; see `clearPreviousLiveArtifacts`. */
function removeIfFile(path: string): void {
    if (existsSync(path) && lstatSync(path).isFile()) rmSync(path, { force: true });
}

function clearPreviousLiveArtifacts(reportPath: string): void {
    // The report is operator-named, so it is only removed when it is a real file —
    // `rmSync` without `recursive` throws on a directory, and that shape is reported
    // as an admission failure rather than as a bare filesystem error.
    removeIfFile(resolve(reportPath));
    // Everything else lives in this report's own subdirectory of the lane namespace,
    // which no accepted report path can occupy, so one recursive remove is safe
    // where decorated sibling names needed a guard each.
    // `lstatSync` does not follow the link, so a SYMLINK here is not a directory and
    // was skipped — after which `mkdirSync` and every artifact write followed it,
    // landing outside the private namespace. Both branches end with the path absent;
    // removing a symlink does not touch its target, and anything at this path is the
    // lane's to clear because reports are refused from the namespace.
    const owned = laneArtifactsDir(reportPath);
    if (existsSync(owned) || isSymlink(owned)) {
        rmSync(owned, { recursive: true, force: true });
    }
}

async function main(): Promise<number> {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.mode === "live") {
        // EVERY path refusal precedes cleanup, which is the whole point: the removals
        // below are what these checks protect against, so a check running after them
        // has already lost. Shape first, because a symlinked report or namespace root
        // makes the containment tests compare the wrong location.
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
