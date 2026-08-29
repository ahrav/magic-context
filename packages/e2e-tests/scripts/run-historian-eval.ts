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
    lintScenario,
    parseModelRoute,
    parseScenario,
    type HistorianEvalScenario,
} from "../src/historian-eval/contract";
import { runMutationBattery } from "../src/historian-eval/mutations";
import { checkFamilyCoverage, loadRelease } from "../src/historian-eval/promote";
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

/**
 * Corpus admission for the per-PR gate, built from the same rules freeze
 * promotion applies: per-scenario lint, unique ids, and hard-negative family
 * coverage. Mirroring promotion is the point — a corpus this gate accepts but
 * promotion would reject could never be frozen, and the reverse would let a
 * release freeze in a state that keeps this gate permanently red. The release
 * size budget is promotion-only: the dev split is deliberately smaller than a
 * releasable corpus.
 */
function corpusDiagnostics(scenarios: readonly HistorianEvalScenario[]): string[] {
    const diagnostics = scenarios.flatMap((scenario) => lintScenario(scenario));
    if (scenarios.length === 0) diagnostics.push("corpus: empty");
    const ids = new Set(scenarios.map((scenario) => scenario.id));
    if (ids.size !== scenarios.length) diagnostics.push("corpus: duplicate scenario ids");
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
function opencodeVersion(): string {
    try {
        const version = execSync("opencode --version", { encoding: "utf8" }).trim();
        return version.length > 0 ? version : "unknown";
    } catch {
        return "unknown";
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
    try {
        execSync("bun run --cwd packages/plugin build", { cwd: repoRoot, stdio: "inherit" });
        return 0;
    } catch (error) {
        console.error(
            `live admission: plugin build failed, so the harness would load a stale or missing bundle: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
    }
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
    const opencode = opencodeVersion();
    const artifactsRoot = join(dirname(resolve(args.reportPath)), "historian-eval-runs");
    const scores: ScenarioScore[] = [];
    let system: SystemVersionTuple | undefined;
    for (const scenario of scenarios) {
        const artifactDir = join(artifactsRoot, scenario.id);
        rmSync(artifactDir, { recursive: true, force: true });
        console.log(`running ${scenario.id}...`);
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
        system = record.system;
        const score = scoreRunRecord(record, scenario);
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
