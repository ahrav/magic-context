#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isWithin } from "../../plugin/src/features/magic-context/memory/verification-paths";
import { canonicalFingerprint } from "../../plugin/scripts/retrieval-benchmark/canonical-json";
import { detectOverflow } from "../../plugin/src/features/magic-context/overflow-detection";
import manifestJson from "../pools/paired-delta-manifest.json";
import policyJson from "../pools/paired-delta-policy.json";
import { ballastProse } from "../src/ballast";
import { TestHarness, type TestHarnessOptions } from "../src/harness";
import { goldEvidencePrompt } from "../src/oracle-arms/gold-evidence";
import {
    liveModelSpawnOptions,
    mcOffOptions,
    naiveCompactionOptions,
} from "../src/oracle-arms/presets";
import { scriptedCtxSearchTurn } from "../src/oracle-arms/scripted-ctx-search";
import {
    seedGoldMemories,
    type GoldMemoryRow,
} from "../src/oracle-arms/seed-gold-memories";
import { parsePolicyOwnerDocument } from "../src/prospective-holdout/contract";
import { pairedFactsFingerprint } from "../src/prospective-holdout/report";
import {
    MIN_BOOTSTRAP_RESAMPLES,
    estimateFamilyDeltas,
    type FamilyDeltaAnalysis,
    type FamilyDeltaObservation,
    type FamilyNoiseFloor,
} from "../src/paired-delta/estimator";
import { assertFrozenPool, buildPairedDeltaRegistry } from "../src/paired-delta/registry";
import { validSuccess } from "../src/paired-delta/scoring";
import {
    buildCalibrationRecord,
    buildPairedDeltaReport,
    calibrationNoiseFloors,
    publishCalibrationRecord,
    publishPairedDeltaReport,
    readCalibrationRecord,
} from "../src/paired-delta/report";
import {
    FileRolloutStore,
    ProviderUnavailableError,
    RolloutRecordsInvalidError,
    RolloutStorePublishConflictError,
    runPairedDelta,
    verifyDualMockResolution,
    type PairedDeltaRunResult,
    type RolloutObservation,
    type RolloutRecord,
    type RunnerDependencies,
    type TokenPrices,
} from "../src/paired-delta/runner";
import {
    ARM_IDS,
    PRIMARY_ARM_IDS,
    parsePairedDeltaManifest,
    parsePairedDeltaPolicy,
    parseScenarioDeclaration,
    r3PromptEvidence,
    type ArmId,
    type PairedDeltaPolicy,
    type ScenarioDeclaration,
} from "../src/paired-delta/contract";
import {
    r1QueryLeaksAnswer,
    r1WireDelivered,
} from "../src/paired-delta/scenarios/support";
import { stableStringify } from "../../plugin/src/shared/stable-json";

type LiveMode = "calibration" | "weekly" | "release";
type Mode = "smoke" | LiveMode;

interface CliArgs {
    mode: Mode;
    recordsPath: string;
    reportPath: string;
    calibrationRecordPath: string;
    resume: boolean;
    maxCostUsd: number | null;
    deadlineMinutes: number;
}

/** A caller keyed off the exit code has to be able to tell a budget stop from a state that forbids the obvious retry: `harness-unreclaimed` means a live harness may still be running, and `invalid-stored-records` means the records file needs inspection before any `--resume` can be trusted. commentlint: allow(JUDGE) */
const SMOKE_EXPECTED_ROLLOUTS = 11;

const EXIT_CODES: Record<PairedDeltaRunResult["status"], number> = {
    completed: 0,
    "cost-cap-reached": 1,
    "deadline-reached": 1,
    "invalid-stored-records": 2,
    "harness-unreclaimed": 3,
};

/** A malformed records file reached the top level as an unhandled rejection and exited 1 — the same code a cost or deadline stop uses — so automation could read a file that needs inspection as a resumable budget stop and retry it forever. Returning null asks the caller to stop after the dedicated code is set. commentlint: allow(JUDGE) */
async function runOrReportInvalidRecords(
    run: () => Promise<PairedDeltaRunResult>,
): Promise<PairedDeltaRunResult | null> {
    try {
        return await run();
    } catch (error) {
        /** A publication that lost its lock is classified with a malformed file, not with a budget stop: both mean the records path has to be inspected before any resume, and the generic code is the one automation is entitled to retry. commentlint: allow(JUDGE) */
        const inspectable = error instanceof RolloutRecordsInvalidError ||
            error instanceof RolloutStorePublishConflictError;
        if (!inspectable) throw error;
        console.error(`paired-delta: ${(error as Error).message}`);
        process.exitCode = EXIT_CODES["invalid-stored-records"];
        return null;
    }
}

/** Names the filesystem type so two different non-regular entries at one path do not hash alike. commentlint: allow(JUDGE) */
function entryKind(entry: Stats): string {
    if (entry.isDirectory()) return "directory";
    if (entry.isFIFO()) return "fifo";
    if (entry.isSocket()) return "socket";
    if (entry.isBlockDevice()) return "block-device";
    if (entry.isCharacterDevice()) return "character-device";
    return "unknown";
}

function parseArgs(argv: string[]): CliArgs {
    let mode: Mode | null = null;
    let recordsPath: string | null = null;
    let reportPath: string | null = null;
    /** Relative to this file, not the working directory: the CLI runs from the repository root, where a bare `artifacts/` is unignored and its contents would enter the implementation digest. */
    const artifacts = resolve(import.meta.dir, "../artifacts");
    let calibrationRecordPath: string | null = null;
    let resume = false;
    let maxCostUsd: number | null = null;
    let deadlineMinutes: number | null = null;
    const selectMode = (next: Mode): void => {
        if (mode !== null) throw new Error("select exactly one paired-delta mode");
        mode = next;
    };
    const value = (flag: string, index: number): string => {
        const candidate = argv[index];
        if (!candidate || candidate.startsWith("-")) throw new Error(`${flag} requires a value`);
        return candidate;
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--smoke") selectMode("smoke");
        else if (arg === "--calibration") selectMode("calibration");
        else if (arg === "--weekly") selectMode("weekly");
        else if (arg === "--release") selectMode("release");
        else if (arg === "--resume") resume = true;
        else if (arg === "--records") recordsPath = value(arg, ++index);
        else if (arg === "--report") reportPath = value(arg, ++index);
        else if (arg === "--calibration-record") {
            calibrationRecordPath = value(arg, ++index);
        } else if (arg === "--max-cost-usd") maxCostUsd = Number(value(arg, ++index));
        else if (arg === "--deadline-minutes") deadlineMinutes = Number(value(arg, ++index));
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (mode === null) {
        throw new Error("select --smoke, --calibration, --weekly, or --release");
    }
    const selected: Mode = mode;
    if (maxCostUsd !== null && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)) {
        throw new Error("--max-cost-usd expects a non-negative number");
    }
    /** The smoke lane runs against mocks in CI, so it keeps a short deadline; a live dispatch runs under the workflow's own step timeout. */
    const deadline = deadlineMinutes ?? (selected === "smoke" ? 5 : 290);
    if (!Number.isFinite(deadline) || deadline <= 0) {
        throw new Error("--deadline-minutes expects a positive number");
    }
    const stem = selected === "smoke" ? "paired-delta-smoke" : `paired-delta-${selected}`;
    const destinations = {
        records: resolve(recordsPath ?? join(artifacts, `${stem}-records.json`)),
        report: resolve(reportPath ?? join(artifacts, `${stem}-report.json`)),
        calibration: resolve(
            calibrationRecordPath ?? join(artifacts, "paired-delta-calibration.json"),
        ),
    };
    /** Publishing is atomic per path, so a shared destination silently replaces one artifact with another and the loss surfaces only on the next resume or weekly run. */
    if (new Set(Object.values(destinations)).size !== 3) {
        throw new Error(
            "paired-delta records, report, and calibration destinations must be distinct",
        );
    }
    return {
        mode: selected,
        recordsPath: destinations.records,
        reportPath: destinations.report,
        calibrationRecordPath: destinations.calibration,
        resume,
        maxCostUsd: selected === "smoke" ? maxCostUsd ?? 100 : maxCostUsd,
        deadlineMinutes: deadline,
    };
}

/** Returns the worktree-relative POSIX path, or null when the target sits outside the worktree and cannot appear in its status. `isWithin` owns the boundary test, which several e2e modules already share. commentlint: allow(JUDGE) */
function relativeTo(root: string, target: string): string | null {
    const rooted = resolve(root);
    const path = resolve(target);
    if (path === rooted || !isWithin(rooted, path)) return null;
    /** `relative` returns the platform separator, while a git pathspec always takes `/`. commentlint: allow(JUDGE) */
    return relative(rooted, path).split(sep).join("/");
}

/** A resume must not skip coordinates recorded by a different checkout: `bindingMatches` compares `repoCommit`, so a constant would let a post-change run report success without executing the changed code. commentlint: allow(JUDGE) */
/**
 * Digest the declared calibration scope from the worktree, so the binding changes when the running
 * system does and not when an unrelated commit lands.
 *
 * Tracked contents come from each path's git tree or blob object, which is content-addressed, and
 * uncommitted changes inside the scope are hashed on top so a dirty checkout is distinguished.
 */
function scopeDigest(): string {
    const root = worktreeRoot();
    const git = gitAt(root);
    const parts: Uint8Array[] = [];
    for (const path of CALIBRATION_SCOPE) {
        parts.push(Buffer.from(`${path}\0`, "utf8"));
        /** `rev-parse HEAD:<path>` names the tree or blob object, so unrelated commits do not move it. */
        const object = Bun.spawnSync(["git", "rev-parse", `HEAD:${path}`], { cwd: root });
        if (object.exitCode !== 0) {
            throw new Error(`paired-delta calibration scope path is not tracked: ${path}`);
        }
        parts.push(Buffer.from(object.stdout.toString().trim(), "utf8"));
        parts.push(Buffer.from(git(["status", "--porcelain", "--untracked-files=all", "--", path]), "utf8"));
        parts.push(Buffer.from(git(["diff", "--binary", "HEAD", "--", path]), "utf8"));
        /** `status` names an untracked file without its bytes and `diff HEAD` omits it, so scoped code importing a new file would keep one digest across edits. */
        for (const untracked of git([
            "ls-files", "--others", "--exclude-standard", "-z", "--", path,
        ]).split("\0").filter(Boolean)) {
            parts.push(Buffer.from(`${untracked}\n`, "utf8"));
            try {
                const absolute = resolve(root, untracked);
                const entry = lstatSync(absolute);
                if (entry.isSymbolicLink()) {
                    parts.push(Buffer.from(`<symlink>${readlinkSync(absolute)}`, "utf8"));
                } else if (!entry.isFile()) {
                    parts.push(Buffer.from(`<non-file>${entryKind(entry)}`, "utf8"));
                } else {
                    parts.push(readFileSync(absolute));
                }
            } catch {
                parts.push(Buffer.from("<unreadable>", "utf8"));
            }
        }
    }
    return Bun.hash(Buffer.concat(parts)).toString(16);
}

function worktreeRoot(): string {
    const started = resolve(import.meta.dir, "..");
    return gitAt(started)(["rev-parse", "--show-toplevel"]).trim();
}

function gitAt(cwd: string): (args: string[]) => string {
    return (args: string[]): string => {
        const run = Bun.spawnSync(["git", ...args], { cwd });
        if (run.exitCode !== 0) {
            throw new Error(`paired-delta cannot read the worktree: git ${args.join(" ")}`);
        }
        return run.stdout.toString();
    };
}

function recordsRepoCommit(ownedPaths: readonly string[]): string {
    /** Run from the worktree root: `git ls-files --others` and the paths `git status` prints are both relative to the working directory, so a package-local cwd would miss a change made anywhere else in the repository. commentlint: allow(JUDGE) */
    const root = worktreeRoot();
    const git = gitAt(root);
    const commit = git(["rev-parse", "HEAD"]).trim();
    /** The runner writes its own records file, so hashing it would change the binding on every run and reject every completed coordinate the resume exists to reuse. commentlint: allow(JUDGE) */
    /** The store's lock file sits beside the records file and a killed run leaves it behind, so it is runner-owned output too: hashing it would reject every completed record on the resume that is about to reclaim it. commentlint: allow(JUDGE) */
    /** `publishJsonAtomically` writes through `${path}.tmp-<hex>` before renaming, so a run killed mid-write leaves one behind; the lock is a directory the next run reclaims. Both are runner-owned output, and hashing either would reject every stored coordinate. commentlint: allow(JUDGE) */
    /** A reclaimer renames a judged lock to `<lock>.reclaimed-<nonce>` and deliberately leaves it when neither restoration succeeds, so it is runner-owned residue like the lock itself; hashing it would derive a different binding than the run that wrote the records and reject every coordinate the resume exists to reuse. commentlint: allow(JUDGE) */
    const relative = (path: string): string | null => relativeTo(root, path);
    /** The exact paths are excluded as literals because they come from `--records`: a value carrying pathspec metacharacters — `artifacts/run[1].json` — would otherwise exclude unrelated matching paths, dropping their changes from the status, the diff, and the untracked hash, so a resume could reuse records produced against different working code. commentlint: allow(JUDGE) */
    const exact = ownedPaths.flatMap((path) => [path, `${path}.lock`])
        .map(relative)
        .filter((path): path is string => path !== null)
        .map((path) => `:(exclude,literal)${path}`);
    /** The suffix families need pattern meaning, so they cannot be literal; the caller-supplied prefix is escaped instead, leaving only the trailing `*` as a wildcard. commentlint: allow(JUDGE) */
    const escapeGlob = (path: string): string => path.replace(/[\\[\]*?]/g, "\\$&");
    const globbed = ownedPaths
        .flatMap((path) => [".lock.reclaimed-", ".tmp-"].map((suffix) => `${path}${suffix}`))
        .map((owned) => {
            const prefix = relative(owned);
            return prefix === null ? null : `:(exclude)${escapeGlob(prefix)}*`;
        })
        .filter((path): path is string => path !== null);
    const scope = [".", ...exact, ...globbed];
    const status = git([
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ...scope,
    ]).trim();
    if (status === "") return commit;
    /** An uncommitted worktree shares its parent's commit, so the digest covers the working content itself: paths and status codes alone stay identical when a file's bytes change, and a resume would reuse records written before the edit. commentlint: allow(JUDGE) */
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...scope])
        .split("\0")
        .filter(Boolean);
    /** Untracked contents are hashed as raw bytes: decoding to UTF-8 first maps distinct binary payloads onto the same replacement character, and `git status` cannot tell them apart either while `git diff HEAD` omits untracked files entirely. commentlint: allow(JUDGE) */
    const parts: Uint8Array[] = [
        Buffer.from(status, "utf8"),
        /** `--binary` because a plain diff reduces a modified binary file to a stable `Binary files … differ` line, so its bytes could change while the digest did not. commentlint: allow(JUDGE) */
        Buffer.from(git(["diff", "--binary", "HEAD", "--", ...scope]), "utf8"),
    ];
    for (const path of untracked) {
        parts.push(Buffer.from(`${path}\n`, "utf8"));
        try {
            const absolute = resolve(root, path);
            /** A symlink's worktree identity is the text it points at, not the bytes it resolves to: following it left the digest unchanged when the same path was retargeted at another module with identical contents, so a resume could reuse records produced against different working code. `lstat` because `readFileSync` and `statSync` both dereference. commentlint: allow(JUDGE) */
            const entry = lstatSync(absolute);
            if (entry.isSymbolicLink()) {
                parts.push(Buffer.from(`<symlink>${readlinkSync(absolute)}`, "utf8"));
            } else if (!entry.isFile()) {
                /** Only a regular file has contents to hash. Opening anything else can block indefinitely — a named pipe waits for a writer — and this runs before the experiment starts, so its deadline cannot interrupt it. The type is recorded so the entry still changes the digest. commentlint: allow(JUDGE) */
                parts.push(Buffer.from(`<non-file>${entryKind(entry)}`, "utf8"));
            } else {
                parts.push(readFileSync(absolute));
            }
        } catch {
            /** An unreadable path still changes the digest through its own name. commentlint: allow(JUDGE) */
            parts.push(Buffer.from("<unreadable>", "utf8"));
        }
    }
    return `${commit}-dirty-${Bun.hash(Buffer.concat(parts)).toString(16)}`;
}

function fixtureScenario(
    scenarioId: string,
    title: string,
): ScenarioDeclaration {
    /** The declaration goes through `parseScenarioDeclaration` so the smoke exercises a scenario the paired-delta contract accepts: the evidence turn precedes the R1 insertion point, no turn from that point on repeats the answer, and one R2 claim carries it. commentlint: allow(JUDGE) */
    return parseScenarioDeclaration({
        scenarioId,
        familyId: "fam-smoke",
        title,
        expectedAnswer: "smoke-id-17",
        answerMatch: "case-insensitive",
        checks: ["check-smoke-outcome"],
        criticalCheckIds: ["check-smoke-outcome"],
        turnScript: [
            { id: "turn-smoke-evidence", role: "user", content: "Remember smoke-id-17." },
            { id: "turn-smoke-filler", role: "user", content: "Acknowledge the note." },
            { id: "turn-smoke-probe", role: "user", content: "Return the smoke identifier." },
        ],
        interventions: {
            r1: {
                insertAfterTurnId: "turn-smoke-filler",
                locatorIds: ["mem-smoke"],
            },
            r2: {
                memories: [{
                    claim: "The smoke identifier is smoke-id-17",
                    evidence: "turn-smoke-evidence",
                }],
            },
        },
        absencePrecondition: {
            evidenceTurnId: "turn-smoke-evidence",
            minimumBallastBytes: 4096 * 4,
        },
        modelContextLimit: 4096,
        restartArms: [],
        verifier: () => [],
    });
}

const SCENARIOS = [
    fixtureScenario("var-smoke-provider-error", "Provider error classification"),
    fixtureScenario("var-smoke-failing-verifier", "Failure-gated oracle replay"),
];

function smokeObservation(
    scenario: ScenarioDeclaration,
    armId: ArmId,
    baseScriptFingerprint: string,
    intervention: RolloutObservation["intervention"],
): RolloutObservation {
    const passed = armId !== "mc-on";
    return {
        checks: [{ id: "check-smoke-outcome", passed }],
        claimedDone: true,
        absencePreconditionHeld: true,
        armIdentityMatches: true,
        echoedProviderId: "mock-live",
        echoedModelId: "mock-snapshot-2026-08-31",
        usage: { input: 1000, output: 100, cacheCreation: 100, cacheRead: 100 },
        turns: scenario.turnScript.length,
        baseScriptFingerprint,
        intervention,
    };
}

/**
 * The runner's status stays `completed` through a provider-unavailable cell, a malformed
 * classification, and a ladder that never fired, because none of those are run failures. A
 * smoke gate has to assert the classifications themselves, or a regression that stops
 * scheduling the regret arms — or misreads either scripted error — still exits zero.
 *
 * A resumed run rehydrates instead of re-executing, so only the counts that survive a resume
 * are asserted then.
 */
function smokeExpectationDrift(
    summary: {
        rolloutCount: number;
        providerCalls: Record<string, number>;
        completeRegretLadders: number;
        partialRegretLadders: number;
        exclusionCounts: PairedDeltaRunResult["exclusionCounts"];
        invalidStoredCoordinates: readonly unknown[];
    },
    args: CliArgs,
): string[] {
    const drift: string[] = [];
    /** Keys are sorted before comparing: `exclusionCounts` and `providerCalls` are built in iteration order, so a change in arm scheduling or route resolution would otherwise report drift for identical content. `stableStringify` is the shared implementation of that ordering, so a fix to its edge cases reaches this comparison too. commentlint: allow(JUDGE) */
    const canonical = stableStringify;
    const expect = (label: string, actual: unknown, expected: unknown): void => {
        const shown = canonical(actual);
        const wanted = canonical(expected);
        if (shown !== wanted) drift.push(`${label}: expected ${wanted}, observed ${shown}`);
    };
    expect("rolloutCount", summary.rolloutCount, SMOKE_EXPECTED_ROLLOUTS);
    expect("invalidStoredCoordinates", summary.invalidStoredCoordinates.length, 0);
    /** `smokeObservation` fails mc-on's critical check in both scenarios, so both fire the ladder. `var-smoke-provider-error` loses only mc-off, leaving r1/r2/r3 to complete one full ladder; `var-smoke-failing-verifier` loses r2, so its ladder carries retrieval and stops. commentlint: allow(JUDGE) */
    expect("completeRegretLadders", summary.completeRegretLadders, 1);
    expect("partialRegretLadders", summary.partialRegretLadders, 1);
    expect("exclusionCounts", summary.exclusionCounts, {
        "mc-off": { "provider-unavailable": 1 },
        r2: { "provider-unavailable": 1 },
    });
    if (!args.resume) {
        /** Both routes must resolve independently, so each is prompted exactly once. commentlint: allow(JUDGE) */
        expect("providerCalls", summary.providerCalls, { "mock-anthropic": 1, "mock-live": 1 });
    }
    return drift;
}

async function runSmoke(args: CliArgs): Promise<void> {
    const providerCalls = new Map<string, number>();
    await verifyDualMockResolution({
        liveProviderId: "mock-live",
        liveModelId: "mock-snapshot-2026-08-31",
        modelContextLimit: 4096,
        async sendPrompt(route) {
            providerCalls.set(route.providerId, (providerCalls.get(route.providerId) ?? 0) + 1);
            return {
                ...route,
                contextLimit: route.providerId === "mock-live" ? 4096 : 200_000,
            };
        },
    });

    const result = await runOrReportInvalidRecords(() => runPairedDelta(
        {
            scenarios: SCENARIOS,
            poolManifestFingerprint: "smoke-pool-v1",
            repoCommit: recordsRepoCommit([args.recordsPath, args.reportPath, args.calibrationRecordPath]),
            pinnedProviderId: "mock-live",
            pinnedSnapshotId: "mock-snapshot-2026-08-31",
            replicateCount: 1,
            deskCostCeilingUsd: 0.01,
            maxCostUsd: args.maxCostUsd ?? 100,
            deadlineEpochMs: Date.now() + args.deadlineMinutes * 60_000,
            pricesPerMillionTokens: {
                input: 3,
                output: 15,
                cacheCreation: 3.75,
                cacheRead: 0.3,
            },
            resume: args.resume,
            store: new FileRolloutStore(args.recordsPath),
        },
        {
            now: Date.now,
            async createRollout({
                scenario,
                coordinate,
                baseScriptFingerprint,
                intervention,
            }) {
                return {
                    async prepare() {},
                    async run() {
                        if (
                            scenario.scenarioId === "var-smoke-provider-error" &&
                            coordinate.armId === "mc-off"
                        ) {
                            throw new ProviderUnavailableError("scripted mock provider error");
                        }
                        if (
                            scenario.scenarioId === "var-smoke-failing-verifier" &&
                            coordinate.armId === "r2"
                        ) {
                            throw new ProviderUnavailableError("scripted mock R2 error");
                        }
                        return smokeObservation(
                            scenario,
                            coordinate.armId,
                            baseScriptFingerprint,
                            intervention,
                        );
                    },
                    async dispose() {},
                };
            },
        },
    ));
    if (result === null) return;

    const summary = {
        status: result.status,
        recordsPath: args.recordsPath,
        rolloutCount: result.records.length,
        providerCalls: Object.fromEntries(providerCalls),
        invalidStoredCoordinates: result.invalidStoredCoordinates,
        completeRegretLadders: result.coordinates.filter(({ regret }) =>
            regret?.retrieval !== undefined &&
            regret.formation !== undefined &&
            regret.representation !== undefined).length,
        partialRegretLadders: result.coordinates.filter(({ regret }) =>
            regret !== null &&
            (regret.formation === undefined || regret.representation === undefined)).length,
        exclusionCounts: result.exclusionCounts,
    };
    console.log(JSON.stringify(summary, null, 2));
    const drift = smokeExpectationDrift(summary, args);
    for (const line of drift) console.error(`smoke expectation: ${line}`);
    /** A non-completed status outranks drift, because `harness-unreclaimed` means a live harness may still be running and a caller keyed on that code must not lose it: drift gets its own code only when the status itself reports success. commentlint: allow(JUDGE) */
    if (result.status !== "completed") {
        process.exitCode = EXIT_CODES[result.status];
        return;
    }
    if (drift.length > 0) {
        process.exitCode = 4;
        return;
    }
    process.exitCode = EXIT_CODES[result.status];
}


function scenarioIdsForMode(
    manifest: ReturnType<typeof parsePairedDeltaManifest>,
    mode: LiveMode,
): Set<string> {
    return new Set(
        manifest.scenarios
            .filter(({ runModes }) => runModes.includes(mode))
            .map(({ scenarioId }) => scenarioId),
    );
}

const POLICY_OWNER = "magic-context-x4l.14";

/**
 * Paths whose contents decide whether calibration evidence still describes the running system.
 *
 * Binding calibration to the commit broke the schedule: any later commit on the default branch, an
 * unrelated documentation change included, invalidated the record and left weekly and release
 * refusing until someone re-dispatched calibration at that exact revision. A declared scope keeps
 * the binding meaningful — a plugin, harness, oracle, or lane change still invalidates it — without
 * tying it to commits that cannot affect the measurement. The workflow's cache key hashes the same
 * globs, so a scope change misses the cache rather than restoring a record the runner will reject.
 */
const CALIBRATION_SCOPE = [
    "packages/plugin/src",
    /** `canonicalFingerprint` lives here, and every fingerprint in the record and report is its output. */
    "packages/plugin/scripts/retrieval-benchmark",
    /**
     * The whole e2e source tree rather than the lane's own directories. A transitive-import audit of
     * this script reaches 322 modules, including `prospective-holdout`, `atomic-publish`,
     * `code-unit-order`, `contract-primitives`, `test-db`, `mock-provider`, and the harness
     * primitives, so an enumerated list of directories was already incomplete and would drift again
     * with the next import. Over-triggering costs one re-calibration; under-triggering publishes
     * noise measured against different code.
     */
    "packages/e2e-tests/src",
    "packages/e2e-tests/scripts/run-paired-delta.ts",
    "packages/e2e-tests/pools",
    /** A dependency or build-script change installs a different SDK or builds a different plugin without touching a source file. */
    "bun.lock",
    "package.json",
    "packages/plugin/package.json",
    "packages/e2e-tests/package.json",
    /** Pins the OpenCode version and its digest, and native compaction, prompt routing, and the session ledger are all part of the measured behaviour. */
    ".github/workflows/paired-delta-eval.yml",
] as const;

function lanePolicy(document: ReturnType<typeof parsePolicyOwnerDocument>): PairedDeltaPolicy {
    if (document.status !== "ready" || document.policy === null) {
        throw new Error("paired-delta policy is not ready");
    }
    return parsePairedDeltaPolicy(document.policy);
}

function mergeHarnessOptions(
    live: TestHarnessOptions,
    arm: TestHarnessOptions,
    modelContextLimit: number,
): TestHarnessOptions {
    return {
        ...live,
        ...arm,
        modelContextLimit,
        openCodeConfigExtra: {
            ...(live.openCodeConfigExtra ?? {}),
            ...(arm.openCodeConfigExtra ?? {}),
            provider: live.openCodeConfigExtra?.provider,
        },
    };
}

interface PromptResult {
    providerId: string;
    modelId: string;
    usage: RolloutObservation["usage"];
    text: string;
    error: unknown;
}

function parsePromptResult(raw: unknown): PromptResult {
    const data = (raw as { data?: unknown } | null)?.data as {
        info?: {
            providerID?: unknown;
            modelID?: unknown;
            error?: unknown;
            tokens?: {
                input?: unknown;
                output?: unknown;
                cache?: { write?: unknown; read?: unknown };
            };
        };
        parts?: Array<{ type?: unknown; text?: unknown }>;
    } | undefined;
    const info = data?.info;
    if (
        typeof info?.providerID !== "string" ||
        typeof info.modelID !== "string" ||
        typeof info.tokens?.input !== "number" ||
        typeof info.tokens.output !== "number" ||
        typeof info.tokens.cache?.write !== "number" ||
        typeof info.tokens.cache.read !== "number"
    ) {
        throw new Error("live prompt returned malformed assistant metadata");
    }
    return {
        providerId: info.providerID,
        modelId: info.modelID,
        usage: {
            input: info.tokens.input,
            output: info.tokens.output,
            cacheCreation: info.tokens.cache.write,
            cacheRead: info.tokens.cache.read,
        },
        text: (data?.parts ?? [])
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
            .join("\n"),
        /** A successful assistant turn carries `error: null`, matching the plugin's own readers, so absence is tested against null rather than undefined. */
        error: info.error ?? null,
    };
}

function armOptions(
    apiKey: string,
    providerId: string,
    modelId: string,
    scenario: ScenarioDeclaration,
    armId: ArmId,
): TestHarnessOptions {
    const live = liveModelSpawnOptions({
        apiKey,
        providerBlock: {
            [providerId]: {
                api: "@ai-sdk/anthropic",
                name: "Pinned Anthropic",
                /** `api` does not name the package OpenCode loads for a configured provider; the package README's live recipe and the dreamer runner both declare it. */
                npm: "@ai-sdk/anthropic",
                env: ["ANTHROPIC_API_KEY"],
                models: {
                    [modelId]: {
                        name: modelId,
                        limit: { context: scenario.modelContextLimit },
                    },
                },
            },
        },
    });
    const arm = armId === "mc-off"
        ? mcOffOptions()
        : armId === "compaction"
            ? naiveCompactionOptions()
            /**
             * The historian deletes its child session on success, which erases the only record of a
             * model call the cap has to charge and the identity gate has to route-check. Retaining
             * the child keeps it in the session tree the rollout prices from; it changes cleanup,
             * not compaction behaviour.
             */
            : { magicContextConfig: { keep_subagents: true } };
    return mergeHarnessOptions(live, arm, scenario.modelContextLimit);
}

interface SessionUsage {
    usage: RolloutObservation["usage"];
    offPinRoute: { providerId: string; modelId: string } | null;
}

const ZERO_USAGE = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

function addUsage(
    left: RolloutObservation["usage"],
    right: RolloutObservation["usage"],
): RolloutObservation["usage"] {
    return {
        input: left.input + right.input,
        output: left.output + right.output,
        cacheCreation: left.cacheCreation + right.cacheCreation,
        cacheRead: left.cacheRead + right.cacheRead,
    };
}

interface LedgerMessage {
    providerID?: unknown;
    modelID?: unknown;
    tokens?: {
        input?: unknown;
        output?: unknown;
        cache?: { write?: unknown; read?: unknown };
    };
}

function ledgerEntries(payload: unknown): LedgerMessage[] {
    const rows = (payload as { data?: unknown } | null)?.data;
    if (!Array.isArray(rows)) return [];
    return rows
        .map((row) => (row as { info?: LedgerMessage } | null)?.info)
        .filter((info): info is LedgerMessage =>
            info !== null && info !== undefined && typeof info.providerID === "string");
}

/**
 * Total the model calls OpenCode itself recorded for a session and its children, rather than only the prompts this runner issued.
 *
 * Native compaction on the `compaction` arm and the historian on the plugin arms both call a model
 * without appearing among the authored responses, so a reducer over those responses understated
 * `usage`, and therefore `costUsd`, `spentUsd`, and the reserve the cap checks before the next arm.
 * Reading OpenCode's own ledger also removes any dependence on the plugin recording its own
 * accounting, which it does on a best-effort path.
 *
 * The mock-served R1 oracle turn is not billed, because pricing it as live spend would overstate
 * the cap. Every other call is billed whatever route served it, including a fallback to another
 * snapshot, which is real money the cap has to see; the route is reported separately so the
 * runner's identity comparison still excludes the cell.
 */
async function sessionUsage(
    harness: TestHarness,
    sessionId: string,
    pinned: { providerId: string; modelId: string },
): Promise<SessionUsage> {
    let usage = ZERO_USAGE;
    let offPinRoute: SessionUsage["offPinRoute"] = null;
    const pending = [sessionId];
    const seen = new Set<string>();
    while (pending.length > 0) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const info of ledgerEntries(await harness.client.session.messages({
            path: { id },
        }))) {
            const route = {
                providerId: info.providerID as string,
                modelId: typeof info.modelID === "string" ? info.modelID : "",
            };
            const tokens = info.tokens;
            if (
                typeof tokens?.input !== "number" ||
                typeof tokens.output !== "number" ||
                typeof tokens.cache?.write !== "number" ||
                typeof tokens.cache.read !== "number"
            ) {
                continue;
            }
            const spent = {
                input: tokens.input,
                output: tokens.output,
                cacheCreation: tokens.cache.write,
                cacheRead: tokens.cache.read,
            };
            /** The mock provider serves the R1 oracle turn by design, so it is neither billable nor an identity failure. */
            if (route.providerId === "mock-anthropic") continue;
            if (route.providerId !== pinned.providerId || route.modelId !== pinned.modelId) {
                if (offPinRoute === null) offPinRoute = route;
                /**
                 * The cell's evidence is rejected, but the call was billed, so it is charged: a
                 * fallback to another snapshot is real money and the cap has to see it.
                 */
                usage = addUsage(usage, spent);
                continue;
            }
            usage = addUsage(usage, spent);
        }
        const children = (await harness.client.session.children({ path: { id } }))
            .data;
        if (Array.isArray(children)) {
            for (const child of children) {
                const childId = (child as { id?: unknown } | null)?.id;
                if (typeof childId === "string") pending.push(childId);
            }
        }
    }
    return { usage, offPinRoute };
}

/**
 * A row the plugin wrote for this session, which the harness cannot have precreated.
 *
 * `spawnOpencode` initializes `context.db` before the server starts for every arm without native
 * compaction, so file existence proves only that the schema was installed. `session_meta` is keyed
 * by a session id generated at runtime and written by the tagger as the plugin processes the
 * session, so its presence is evidence the treatment actually ran.
 */
function pluginProcessedSession(harness: TestHarness, sessionId: string): boolean {
    if (!harness.hasContextDb()) return false;
    try {
        const row = harness.contextDb()
            .prepare("SELECT COUNT(*) AS count FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { count: number } | null;
        return (row?.count ?? 0) > 0;
    } catch {
        return false;
    }
}

function configMatchesArm(
    harness: TestHarness,
    armId: ArmId,
    providerId: string,
    modelId: string,
    modelContextLimit: number,
    apiKey: string,
): boolean {
    const text = readFileSync(join(harness.opencode.env.configDir, "opencode.json"), "utf8");
    if (text.includes(apiKey)) return false;
    const config = JSON.parse(text) as {
        plugin?: unknown;
        compaction?: unknown;
        provider?: Record<string, {
            models?: Record<string, { limit?: { context?: number } }>;
        }>;
    };
    const providersMatch =
        config.provider?.["mock-anthropic"] !== undefined &&
        config.provider?.[providerId]?.models?.[modelId]?.limit?.context === modelContextLimit;
    if (!providersMatch) return false;
    if (armId === "mc-off") return Array.isArray(config.plugin) && config.plugin.length === 0;
    if (armId === "compaction") {
        return canonicalFingerprint(config.compaction) === canonicalFingerprint(
            naiveCompactionOptions().openCodeConfigExtra?.compaction,
        );
    }
    return Array.isArray(config.plugin) && config.plugin.length > 0;
}

export function createLiveDependencies(input: {
    apiKey: string;
    providerId: string;
    modelId: string;
}): RunnerDependencies {
    return {
        now: Date.now,
        async createRollout({
            scenario,
            coordinate,
            baseScriptFingerprint: expectedFingerprint,
            intervention,
        }) {
            const harnessOptions = armOptions(
                input.apiKey,
                input.providerId,
                input.modelId,
                scenario,
                coordinate.armId,
            );
            let harness = await TestHarness.create(harnessOptions);
            let seeded: ReturnType<typeof seedGoldMemories> = [];
            let scriptedTurnText: string | undefined;
            /** The declaration names the point the evidence must already be buried by, so the ballast is keyed to it rather than to a literal turn id. */
            const burialTurnId = scenario.interventions.r1.insertAfterTurnId;
            /** R2 supplies the gold as memory and R3 supplies the same content in the prompt, so the seeded row carries the declared claim alone; a second labelled copy of the evidence would make `R3 - R2` measure duplicated content as well as representation. */
            const seedOracleMemories = async (): Promise<typeof seeded> => {
                /** `seedGoldMemories` requires `context.db` to exist; the plugin creates it after the server reports ready. */
                await harness.waitFor(() => harness.hasContextDb(), {
                    label: "context.db created",
                });
                const rows: GoldMemoryRow[] = scenario.interventions.r2.memories.map(
                    ({ claim }) => ({ category: "PROJECT_RULES", content: claim }),
                );
                return seedGoldMemories({
                    workdir: harness.opencode.env.workdir,
                    dbPath: harness.contextDbPath(),
                    rows,
                    verification: coordinate.armId === "r1" ? "candidate" : "verified",
                });
            };
            const locatorIds = (): string[] =>
                seeded.map(({ publicClaimId }) => publicClaimId);
            return {
                async prepare() {
                    if (coordinate.armId !== "r1" && coordinate.armId !== "r2") return;
                    seeded = await seedOracleMemories();
                    if (coordinate.armId !== "r1") return;
                    /**
                     * A resolved id that contains the answer would reveal the gold in the model-visible query, and `seedGoldMemories` resolves a repeated row onto the same claim, so a new id needs a new database.
                     * Reseeding rather than excluding keeps the sample: exclusion is input-dependent and removes R1 observations only for scenarios with short answers, biasing the retrieval rung.
                     */
                    for (
                        let attempt = 1;
                        r1QueryLeaksAnswer(scenario, locatorIds());
                        attempt++
                    ) {
                        if (attempt > R1_RESEED_ATTEMPTS) {
                            throw new Error(
                                `paired-delta r1 locator ids revealed the answer for ` +
                                `${scenario.scenarioId} across ${R1_RESEED_ATTEMPTS} reseeds`,
                            );
                        }
                        await harness.dispose();
                        harness = await TestHarness.create(harnessOptions);
                        seeded = await seedOracleMemories();
                    }
                },
                async run(): Promise<RolloutObservation> {
                    const sessionId = await harness.createSession();
                    const responses: PromptResult[] = [];
                    let ballastBytes = 0;
                    let ballastTokens = 0;
                    for (const turn of scenario.turnScript) {
                        if (turn.role !== "user") {
                            throw new Error("live paired-delta supports authored user turns only");
                        }
                        let content = turn.content;
                        if (turn.id === burialTurnId) {
                            /** The authored floor is bytes and the window is tokens, so the burial turn carries whichever demand is larger once converted. */
                            ballastTokens = Math.max(
                                Math.ceil(
                                    scenario.absencePrecondition.minimumBallastBytes / 4,
                                ),
                                scenario.modelContextLimit + 1,
                            );
                            const ballast = ballastProse(ballastTokens);
                            ballastBytes = Buffer.byteLength(ballast);
                            content = `${content}\n\n${ballast}`;
                        }
                        if (
                            coordinate.armId === "r3" &&
                            turn.id === scenario.turnScript.at(-1)?.id
                        ) {
                            content = `${goldEvidencePrompt([{
                                label: scenario.scenarioId,
                                content: r3PromptEvidence(scenario),
                            }])}\n\n${content}`;
                        }
                        const response = parsePromptResult(await harness.sendPrompt(
                            sessionId,
                            content,
                            {
                                providerID: input.providerId,
                                modelID: input.modelId,
                            },
                        ));
                        if (response.error != null) {
                            const tolerated = coordinate.armId === "mc-off" &&
                                detectOverflow(response.error).isOverflow;
                            if (!tolerated) {
                                throw new ProviderUnavailableError(
                                    "live provider returned an error",
                                );
                            }
                        }
                        responses.push(response);
                        if (
                            coordinate.armId === "r1" &&
                            turn.id === scenario.interventions.r1.insertAfterTurnId
                        ) {
                            scriptedTurnText = await scriptedCtxSearchTurn(
                                harness,
                                sessionId,
                                seeded,
                            );
                        }
                    }
                    const last = responses.at(-1);
                    if (!last) throw new Error("scenario produced no live prompts");
                    const ledger = await sessionUsage(harness, sessionId, {
                        providerId: input.providerId,
                        modelId: input.modelId,
                    });
                    /**
                     * The runner compares one echoed route against the pin, so the offending turn is reported rather than the final one.
                     * A rollout whose earlier turns were served by a fallback provider or snapshot produced its outcome, and its persisted memory, partly off the pin.
                     */
                    const offPin = responses.find(({ providerId, modelId }) =>
                        providerId !== input.providerId || modelId !== input.modelId) ??
                        ledger.offPinRoute ??
                        last;
                    const resolvedLocatorIds = locatorIds();
                    const checks = await scenario.verifier({
                        armId: coordinate.armId,
                        workspacePath: harness.opencode.env.workdir,
                        ...(scriptedTurnText === undefined ? {} : { scriptedTurnText }),
                        resolvedLocatorIds,
                    });
                    const evidenceIndex = scenario.turnScript.findIndex(
                        ({ id }) => id === scenario.absencePrecondition.evidenceTurnId,
                    );
                    const burialIndex = scenario.turnScript.findIndex(
                        ({ id }) => id === burialTurnId,
                    );
                    const structuralAbsence =
                        evidenceIndex >= 0 &&
                        evidenceIndex < burialIndex &&
                        ballastBytes >= scenario.absencePrecondition.minimumBallastBytes &&
                        ballastTokens > scenario.modelContextLimit;
                    /**
                     * The precondition establishes that the authored evidence was displaced from the model's ordinary context, which the ballast does for every arm alike.
                     * It deliberately says nothing about the treatment's memory: persisting that evidence is the mechanism `mc-on` exists to measure, so requiring its absence excluded exactly the rollouts where the treatment worked.
                     * Pre-run contamination is not reachable either, because every rollout builds a fresh harness and database, and only R1 and R2 seed one.
                     */
                    const absencePreconditionHeld = structuralAbsence;
                    /**
                     * An undelivered search turn leaves an arm that is not R1, and the observation carries no separate validity channel, so the gate folds into arm identity.
                     * `prepare` reseeds until the locator query is non-leaking, so the leak test here only catches a reseed loop that stopped honoring its own contract.
                     */
                    const r1Valid = coordinate.armId !== "r1" ||
                        (
                            r1WireDelivered(scenario, {
                                armId: coordinate.armId,
                                workspacePath: harness.opencode.env.workdir,
                                ...(scriptedTurnText === undefined ? {} : { scriptedTurnText }),
                                resolvedLocatorIds,
                            }) &&
                            !r1QueryLeaksAnswer(scenario, resolvedLocatorIds)
                        );
                    const armIdentityMatches =
                        configMatchesArm(
                            harness,
                            coordinate.armId,
                            input.providerId,
                            input.modelId,
                            scenario.modelContextLimit,
                            input.apiKey,
                        ) &&
                        (
                            coordinate.armId !== "compaction" ||
                            !harness.hasContextDb()
                        ) &&
                        (
                            coordinate.armId !== "mc-on" ||
                            pluginProcessedSession(harness, sessionId)
                        ) &&
                        r1Valid;
                    return {
                        checks,
                        /** The probe turn is the last authored turn, and an earlier turn can acknowledge the authored rule without producing the answer. */
                        claimedDone: claimsCompletion(last.text),
                        absencePreconditionHeld,
                        armIdentityMatches,
                        echoedProviderId: offPin.providerId,
                        echoedModelId: offPin.modelId,
                        usage: ledger.usage,
                        turns: scenario.turnScript.length +
                            (scriptedTurnText === undefined ? 0 : 1),
                        baseScriptFingerprint: expectedFingerprint,
                        intervention,
                    };
                },
                async dispose() {
                    await harness.dispose();
                },
            };
        },
    };
}

/**
 * A completion word is only a claim when it is not negated: `invalidSuccess` counts an arm asserting success it did not achieve, so a refusal that says "not done" is the opposite of the thing being measured.
 * The window covers the bare negations plus any `n't` contraction, which reaches `haven't`, `isn't`, and `wasn't` without enumerating auxiliaries, rather than attempting sentence parsing.
 * Only a short allowlist of filler words may sit between the negation and the verb, so an unrelated earlier clause — "I did not need help and completed the task" — does not swallow a genuine claim.
 */
const NEGATION = "(?:\\b(?:not|never|cannot|unable|failed|without|no)\\b|n't)";
/** Filler the negation may reach across: the listed auxiliaries and objects, plus any `-ly` adverb, which covers `successfully`, `entirely`, `properly` without enumerating them. A conjunction is absent on purpose, so an unrelated earlier clause still cannot reach the verb. */
const NEGATION_FILLER =
    "(?:\\s+(?:yet|ever|even|quite|able|been|being|manage|managed|have|has|had|to|the|task|it|this|that|work|job|[a-z]+ly)\\b)*";
const NEGATED_COMPLETION = new RegExp(`${NEGATION}${NEGATION_FILLER}[\\s,]*$`);

export function claimsCompletion(text: string): boolean {
    const completion = /\b(?:done|completed|finished|complete)\b/gi;
    for (const match of text.matchAll(completion)) {
        const before = text.slice(Math.max(0, match.index - 40), match.index).toLowerCase();
        if (NEGATED_COMPLETION.test(before)) {
            continue;
        }
        return true;
    }
    return false;
}

function buildAnalysis(
    result: PairedDeltaRunResult,
    scenarios: readonly ScenarioDeclaration[],
    policy: PairedDeltaPolicy,
    policyFingerprint: string,
    poolManifestFingerprint: string,
    pinnedSnapshotId: string,
    noiseFloors: readonly FamilyNoiseFloor[],
): { analysis: FamilyDeltaAnalysis; refusedRegretLadders: Record<string, number> } {
    const byId = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
    const observations: FamilyDeltaObservation[] = [];
    /** A refused ladder leaves the cell `completed`, so it carries no `reasonCode` and would otherwise be indistinguishable from a run that scheduled no regret arms. */
    const refusedRegretLadders: Record<string, number> = {};
    for (const coordinate of result.coordinates) {
        const scenario = byId.get(coordinate.scenarioId);
        if (!scenario) continue;
        const coordinateId = `${coordinate.scenarioId}:${coordinate.replicateIndex}`;
        if (PRIMARY_ARM_IDS.every((armId) =>
            coordinate.cells[armId]?.cell.runHealth === "completed")) {
            for (const [baseline, endpoint] of [
                ["mc-off", "mc-on-vs-mc-off"],
                ["compaction", "mc-on-vs-compaction"],
            ] as const) {
                observations.push({
                    coordinateId,
                    familyId: scenario.familyId,
                    endpoint,
                    delta:
                        validSuccess(coordinate.cells["mc-on"]!) -
                        validSuccess(coordinate.cells[baseline]!),
                    runHealth: "completed",
                });
            }
        }
        const regret = coordinate.regret;
        if (regret?.refusedReason) {
            refusedRegretLadders[regret.refusedReason] =
                (refusedRegretLadders[regret.refusedReason] ?? 0) + 1;
        }
        if (regret && !regret.refusedReason) {
            for (const endpoint of ["retrieval", "formation", "representation"] as const) {
                const delta = regret[endpoint];
                if (delta === undefined) continue;
                observations.push({
                    coordinateId,
                    familyId: scenario.familyId,
                    endpoint,
                    delta,
                    runHealth: "completed",
                });
            }
        }
    }
    /**
     * The live lane analyses its own rollout records, not prospective release-over-release pairs, so it binds the empty paired-fact set rather than fabricating release roles the experiment never had.
     * Provenance for this analysis is the pool manifest, the pinned snapshot, and the policy fingerprint, all of which the binding already carries.
     */
    const lane = {
        poolManifestFingerprint,
        pinnedSnapshotId,
        policyFingerprint,
        pairedFactsFingerprint: pairedFactsFingerprint(LIVE_LANE_PAIRS),
    };
    if (observations.length === 0) {
        return {
            refusedRegretLadders,
            analysis: {
            ...lane,
            bootstrapSeed: BOOTSTRAP_SEED,
            bootstrapResamples: policy.bootstrapResamples,
            minimumAnalyzableFamilyCount: policy.minimumAnalyzableFamilyCount,
            analyzableFamilyCount: 0,
            evidenceSufficient: false,
            endpoints: [],
            liveRegret: [],
            providerMixedRegret: [],
            rawRegretRecords: [],
            },
        };
    }
    return {
        refusedRegretLadders,
        analysis: estimateFamilyDeltas({
        observations,
        minimumAnalyzableFamilyCount: policy.minimumAnalyzableFamilyCount,
        bootstrapSeed: BOOTSTRAP_SEED,
        bootstrapResamples: policy.bootstrapResamples,
        lane,
        noiseFloors,
        }),
    };
}

const BOOTSTRAP_SEED = 20260831;

/** The one endpoint `buildAnalysis` estimates. A policy naming another is rejected rather than silently estimating this one. */
const SUPPORTED_ENDPOINT = "paired-valid-success-delta";

/** `armOptions` keys the provider block dynamically but always supplies the Anthropic adapter and `ANTHROPIC_API_KEY`. */
const SUPPORTED_PROVIDER = "anthropic";

/** Bound on R1 database reseeds. Each attempt draws fresh 32-hex ids, so exhausting the bound is a contract failure rather than bad luck, and it is reported as one. */
const R1_RESEED_ATTEMPTS = 8;

/** A run that completes without meeting its evidence gate exits with its own code: a calibration would otherwise be cached and rejected by every later dispatch, and a weekly or release dispatch would report green with nothing to monitor. */
const INSUFFICIENT_EVIDENCE_EXIT = 5;

/** The live lane derives its deltas from rollout records, so it publishes no prospective paired-case facts. */
const LIVE_LANE_PAIRS = [] as const;

function flattenExclusions(result: PairedDeltaRunResult) {
    return ARM_IDS.flatMap((armId) =>
        Object.entries(result.exclusionCounts[armId] ?? {}).map(
            ([reasonCode, count]) => ({
                armId,
                reasonCode: reasonCode as keyof typeof result.exclusionCounts[typeof armId],
                count,
            }),
        ),
    ) as Parameters<typeof buildPairedDeltaReport>[0]["exclusions"];
}

function secondaryMetrics(records: readonly RolloutRecord[]) {
    const byArm = new Map<ArmId, RolloutRecord[]>();
    for (const record of records) {
        const rows = byArm.get(record.armId) ?? [];
        rows.push(record);
        byArm.set(record.armId, rows);
    }
    const metric = (
        value: (record: RolloutRecord) => number,
    ): Partial<Record<ArmId, number>> => Object.fromEntries(
        [...byArm].map(([armId, rows]) => [
            armId,
            rows.reduce((sum, row) => sum + value(row), 0),
        ]),
    );
    return {
        /**
         * Denominated on completed cells only. An excluded record carries `invalidSuccess: false`
         * because no response was assessable, so counting it diluted the rate: one false claim
         * among ten attempts, nine of them provider-unavailable, published as 10% rather than 100%
         * of what could be scored — and differential infrastructure failure then reads as an arm
         * being less prone to false success claims.
         */
        invalidSuccessRateByArm: Object.fromEntries(
            [...byArm]
                .map(([armId, rows]) => [
                    armId,
                    rows.filter(({ cell }) => cell.runHealth === "completed"),
                ] as const)
                .filter(([, scorable]) => scorable.length > 0)
                .map(([armId, scorable]) => [
                    armId,
                    scorable.filter(({ cell }) => cell.invalidSuccess).length / scorable.length,
                ]),
        ),
        tokensByArm: metric(({ usage }) =>
            usage.input + usage.output + usage.cacheCreation + usage.cacheRead),
        wallClockMsByArm: metric(({ wallClockMs }) => wallClockMs),
        turnsByArm: metric(({ turns }) => turns),
    };
}

function deskCostCeilingUsd(
    scenarios: readonly ScenarioDeclaration[],
    prices: TokenPrices,
): number {
    const perTokenUsd =
        (prices.input + prices.output + prices.cacheCreation + prices.cacheRead) /
        1_000_000;
    const worstUsd = Math.max(
        0.01,
        ...scenarios.map(({ turnScript, modelContextLimit }) =>
            (turnScript.length + 1) * modelContextLimit * perTokenUsd),
    );
    return Math.ceil(worstUsd * 2 * 100) / 100;
}

async function runLive(args: CliArgs): Promise<void> {
    const mode = args.mode as LiveMode;
    const apiKey = process.env.PAIRED_DELTA_ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error("live paired-delta mode requires PAIRED_DELTA_ANTHROPIC_API_KEY");
    }
    const policyDocument = parsePolicyOwnerDocument(policyJson, POLICY_OWNER);
    if (policyDocument.policyFingerprint === null) {
        throw new Error("paired-delta policy is not ready");
    }
    const policy = lanePolicy(policyDocument);
    const manifest = parsePairedDeltaManifest(manifestJson);
    const manifestFingerprint = canonicalFingerprint(manifest);
    if (manifestFingerprint !== policy.poolManifestFingerprint) {
        throw new Error("paired-delta policy does not bind the current pool manifest");
    }
    /** The report binds the whole policy fingerprint, so executing one entry of a longer matrix would publish coverage the run never had. */
    if (policy.modelMatrix.length !== 1) {
        throw new Error(
            `paired-delta live lane executes exactly one model; the policy declares ` +
            `${policy.modelMatrix.length}`,
        );
    }
    const model = policy.modelMatrix[0];
    if (!model || !/-\d{8}$/.test(model.modelId)) {
        throw new Error("paired-delta policy requires a dated model snapshot");
    }
    /** `buildAnalysis` computes one endpoint unconditionally, so a policy naming a different one would publish a fingerprint claiming an estimator this lane does not implement. */
    if (policy.endpoint !== SUPPORTED_ENDPOINT) {
        throw new Error(
            `paired-delta lane implements ${SUPPORTED_ENDPOINT}; the policy declares ` +
            `${policy.endpoint}`,
        );
    }
    /** The report is fingerprinted to the policy, so an override above the preregistered budget would publish as though it executed a cap it exceeded. */
    if (args.maxCostUsd !== null && args.maxCostUsd > policy.costBudgetUsd[mode]) {
        throw new Error(
            `--max-cost-usd ${args.maxCostUsd} exceeds the ${mode} policy budget ` +
            `${policy.costBudgetUsd[mode]}; an override may only lower it`,
        );
    }
    /** The provider block is keyed by the declared id but backed by the Anthropic SDK and credential, so another id would echo a provider the run never used. */
    if (model.providerId !== SUPPORTED_PROVIDER) {
        throw new Error(
            `paired-delta live lane serves ${SUPPORTED_PROVIDER} only; the policy declares ` +
            `${model.providerId}`,
        );
    }
    /** The estimator runs only after the experiment, so its own floor is checked before the budget is spent. */
    if (policy.bootstrapResamples < MIN_BOOTSTRAP_RESAMPLES) {
        throw new Error(
            `paired-delta policy declares bootstrapResamples ` +
            `${policy.bootstrapResamples}; the estimator requires at least ` +
            `${MIN_BOOTSTRAP_RESAMPLES}`,
        );
    }
    /**
     * Calibration evidence is validated before the first provider call rather than after the experiment.
     * A weekly or release dispatch with a missing or unbound record would otherwise spend its whole budget and then discard the result.
     */
    const implementationDigest = scopeDigest();
    let noiseFloors: FamilyNoiseFloor[] = [];
    if (mode !== "calibration") {
        if (!existsSync(args.calibrationRecordPath)) {
            throw new Error(
                `paired-delta ${mode} mode requires a calibration record at ` +
                args.calibrationRecordPath,
            );
        }
        const calibration = readCalibrationRecord(args.calibrationRecordPath);
        /** Binding is checked first: a stale record's `poolSize` could otherwise raise a cohort complaint that points at re-authoring the pool when the record simply does not describe this run. */
        if (
            calibration.poolManifestFingerprint !== manifestFingerprint ||
            calibration.pinnedSnapshotId !== model.modelId ||
            calibration.policyFingerprint !== policyDocument.policyFingerprint ||
            calibration.implementationDigest !== implementationDigest ||
            !calibration.validForPoolSizing
        ) {
            throw new Error("paired-delta calibration record does not bind this run");
        }
        /**
         * The calibrated size is a decision, and a cohort below it cannot support the preregistered
         * detectable delta, so the dispatch refuses before spending rather than publishing an
         * underpowered directional verdict. Widening the cohort means re-authoring the frozen pool
         * or the policy's replicate count, neither of which the runner may do at dispatch time.
         */
        const cohort = scenarioIdsForMode(manifest, mode).size * policy.replicateCount;
        if (cohort < calibration.decisions.poolSize) {
            const perFamily = Math.ceil(
                calibration.decisions.poolSize / calibration.decisions.familyCount,
            );
            throw new Error(
                `paired-delta ${mode} cohort of ${cohort} coordinates is below the calibrated ` +
                `${calibration.decisions.poolSize} (${perFamily} per family for a ` +
                `${policy.targetMinimumDetectableDelta} detectable delta at the measured ` +
                `variance); the pool supplies ${scenarioIdsForMode(manifest, mode).size} ` +
                `scenarios at replicateCount ${policy.replicateCount}. Raise the pool or the ` +
                "replicate count in the policy, or lower the target delta; re-calibrating alone " +
                "will not close a gap this large",
            );
        }
        noiseFloors = calibrationNoiseFloors(calibration);
    }
    const registry = buildPairedDeltaRegistry();
    /**
     * The manifest fingerprint is stamped into every record, the calibration binding, and the
     * report, so a changed scenario or verifier executed against a stale manifest publishes
     * evidence attributed to a pool that was never run. The unit suite asserts this too, but a
     * direct paid invocation does not go through it.
     */
    assertFrozenPool(registry, manifest);
    const selectedIds = scenarioIdsForMode(manifest, mode);
    const scenarios = [...registry.values()]
        .map(({ declaration }) => declaration)
        .filter(({ scenarioId }) => selectedIds.has(scenarioId));
    /** `evidenceSufficient` counts distinct families, so a mode selecting fewer than the minimum can never satisfy it however well the run goes. */
    const selectedFamilies = new Set(scenarios.map(({ familyId }) => familyId));
    if (selectedFamilies.size < policy.minimumAnalyzableFamilyCount) {
        throw new Error(
            `paired-delta ${mode} selects ${selectedFamilies.size} families but the policy ` +
            `requires ${policy.minimumAnalyzableFamilyCount}`,
        );
    }
    // The fingerprinted policy documents the executed configuration, so the
    // context limit it pins must match what the scenarios actually request.
    for (const scenario of scenarios) {
        /** Rejected here rather than mid-rollout: the throw inside `run` lands after earlier user turns have already billed, and records every arm as a harness failure. */
        const authored = scenario.turnScript.find(({ role }) => role !== "user");
        if (authored) {
            throw new Error(
                `paired-delta live lane replays authored user turns only; ` +
                `${scenario.scenarioId} declares a ${authored.role} turn (${authored.id})`,
            );
        }
        if (scenario.modelContextLimit !== model.contextLimit) {
            throw new Error(
                `paired-delta policy pins contextLimit ${model.contextLimit} but ` +
                `${scenario.scenarioId} declares ${scenario.modelContextLimit}`,
            );
        }
    }
    const result = await runOrReportInvalidRecords(() => runPairedDelta(
        {
            scenarios,
            poolManifestFingerprint: manifestFingerprint,
            repoCommit: recordsRepoCommit([
                args.recordsPath,
                args.reportPath,
                args.calibrationRecordPath,
            ]),
            pinnedProviderId: model.providerId,
            pinnedSnapshotId: model.modelId,
            replicateCount: policy.replicateCount,
            deskCostCeilingUsd: deskCostCeilingUsd(
                scenarios,
                policy.pricesPerMillionTokens,
            ),
            maxCostUsd: args.maxCostUsd ?? policy.costBudgetUsd[mode],
            deadlineEpochMs: Date.now() + args.deadlineMinutes * 60_000,
            pricesPerMillionTokens: policy.pricesPerMillionTokens,
            resume: args.resume,
            store: new FileRolloutStore(args.recordsPath),
        },
        createLiveDependencies({
            apiKey,
            providerId: model.providerId,
            modelId: model.modelId,
        }),
    ));
    if (result === null) return;
    const scenarioFamilies = new Map(
        scenarios.map(({ scenarioId, familyId }) => [scenarioId, familyId]),
    );
    let calibrationValidForSizing = true;
    if (mode === "calibration") {
        const calibration = buildCalibrationRecord({
            records: result.records,
            scenarioFamilies,
            runStatus: result.status,
            poolManifestFingerprint: manifestFingerprint,
            pinnedSnapshotId: model.modelId,
            policyFingerprint: policyDocument.policyFingerprint,
            implementationDigest,
            targetMinimumDetectableDelta: policy.targetMinimumDetectableDelta,
            decisions: {
                familyCount: policy.minimumAnalyzableFamilyCount,
                replicateCount: policy.replicateCount,
                cadence: "weekly-and-release",
            },
        });
        publishCalibrationRecord(calibration, args.calibrationRecordPath);
        noiseFloors = calibrationNoiseFloors(calibration);
        calibrationValidForSizing = calibration.validForPoolSizing;
    }
    const plannedCoordinates = scenarios.length * policy.replicateCount;
    const healthyCoordinates = result.coordinates.filter(({ cells }) =>
        PRIMARY_ARM_IDS.every((armId) => cells[armId]?.cell.runHealth === "completed")).length;
    const { analysis, refusedRegretLadders } = buildAnalysis(
        result,
        scenarios,
        policy,
        policyDocument.policyFingerprint,
        manifestFingerprint,
        model.modelId,
        noiseFloors,
    );
    /**
     * Decided before publication, because the workflow archives the report even when the step
     * fails: an artifact claiming `evidenceSufficient` while the dispatch exited on a shortfall is
     * the one output nobody re-reads the logs to correct.
     */
    const evidenceComplete = mode === "calibration"
        ? calibrationValidForSizing
        : analysis.evidenceSufficient && healthyCoordinates >= plannedCoordinates;
    const report = buildPairedDeltaReport({
        poolManifestFingerprint: manifestFingerprint,
        pinnedSnapshotId: model.modelId,
        policyDocument: policyJson,
        implementationDigest,
        pairs: LIVE_LANE_PAIRS,
        analysis,
        exclusions: flattenExclusions(result),
        secondaryMetrics: secondaryMetrics(result.records),
        runSummary: {
            status: result.status,
            spentUsd: result.spentUsd,
            observedCostRollouts: result.observedCostRollouts,
            estimatedCostRollouts: result.estimatedCostRollouts,
            refusedRegretLadders,
            plannedCoordinates,
            healthyCoordinates,
            evidenceComplete,
        },
    });
    publishPairedDeltaReport(report, args.reportPath);
    console.log(JSON.stringify({
        status: result.status,
        reportPath: args.reportPath,
        recordsPath: args.recordsPath,
        calibrationRecordPath:
            mode === "calibration" ? args.calibrationRecordPath : null,
        spentUsd: result.spentUsd,
        analyzableFamilyCount: analysis.analyzableFamilyCount,
        evidenceSufficient: analysis.evidenceSufficient,
        plannedCoordinates,
        healthyCoordinates,
        refusedRegretLadders,
        validForPoolSizing: mode === "calibration" ? calibrationValidForSizing : null,
    }, null, 2));
    /** A non-completed status outranks the calibration verdict, because the caller keyed on `harness-unreclaimed` must not lose it. */
    if (result.status !== "completed") {
        process.exitCode = EXIT_CODES[result.status];
        return;
    }
    if (!evidenceComplete && mode === "calibration") {
        console.error(
            "paired-delta calibration completed without evidence valid for pool sizing",
        );
        process.exitCode = INSUFFICIENT_EVIDENCE_EXIT;
        return;
    }
    /** A weekly or release dispatch whose cells were all excluded still completes, so the preregistered evidence gate decides the exit rather than the run status alone. */
    if (mode !== "calibration" && !analysis.evidenceSufficient) {
        console.error(
            `paired-delta ${mode} completed without sufficient evidence: ` +
            `${analysis.analyzableFamilyCount} of ` +
            `${policy.minimumAnalyzableFamilyCount} families analyzable`,
        );
        process.exitCode = INSUFFICIENT_EVIDENCE_EXIT;
        return;
    }
    /**
     * Family representation is not the preregistered gate. `all-primary-arms-completed` covers
     * every planned coordinate, so one healthy replicate per family would otherwise pass while
     * the rest of the matrix failed.
     */
    if (mode !== "calibration" && healthyCoordinates < plannedCoordinates) {
        console.error(
            `paired-delta ${mode} completed ${healthyCoordinates} of ` +
            `${plannedCoordinates} planned primary coordinates`,
        );
        process.exitCode = INSUFFICIENT_EVIDENCE_EXIT;
        return;
    }
    process.exitCode = EXIT_CODES[result.status];
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === "smoke") await runSmoke(args);
    else await runLive(args);
}

/** Guarded so a test can import the module's helpers without launching a dispatch. */
if (import.meta.main) await main();
