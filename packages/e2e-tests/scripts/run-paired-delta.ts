#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isWithin } from "../../plugin/src/features/magic-context/memory/verification-paths";
import {
    FileRolloutStore,
    ProviderUnavailableError,
    runPairedDelta,
    verifyDualMockResolution,
    type PairedDeltaRunResult,
    type RolloutObservation,
} from "../src/paired-delta/runner";
import {
    parseScenarioDeclaration,
    type ArmId,
    type ScenarioDeclaration,
} from "../src/paired-delta/contract";

interface CliArgs {
    recordsPath: string;
    resume: boolean;
    maxCostUsd: number;
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

function parseArgs(argv: string[]): CliArgs {
    let smoke = false;
    let recordsPath = "artifacts/paired-delta-smoke-records.json";
    let resume = false;
    let maxCostUsd = 100;
    let deadlineMinutes = 5;
    const value = (flag: string, index: number): string => {
        const candidate = argv[index];
        if (!candidate || candidate.startsWith("-")) throw new Error(`${flag} requires a value`);
        return candidate;
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--smoke") smoke = true;
        else if (arg === "--resume") resume = true;
        else if (arg === "--records") recordsPath = value(arg, ++index);
        else if (arg === "--max-cost-usd") maxCostUsd = Number(value(arg, ++index));
        else if (arg === "--deadline-minutes") deadlineMinutes = Number(value(arg, ++index));
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (!smoke) throw new Error("U2/U3 runner currently requires --smoke; live modes are not enabled");
    if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
        throw new Error("--max-cost-usd expects a non-negative number");
    }
    if (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0) {
        throw new Error("--deadline-minutes expects a positive number");
    }
    return { recordsPath: resolve(recordsPath), resume, maxCostUsd, deadlineMinutes };
}

/** Returns the worktree-relative POSIX path, or null when the target sits outside the worktree and cannot appear in its status. `isWithin` owns the boundary test, which several e2e modules already share. commentlint: allow(JUDGE) */
function relativeTo(root: string, target: string): string | null {
    const rooted = resolve(root);
    const path = resolve(target);
    if (path === rooted || !isWithin(rooted, path)) return null;
    /** `relative` returns the platform separator, while a git pathspec always takes `/`. commentlint: allow(JUDGE) */
    return relative(rooted, path).split(sep).join("/");
}

/** A resume must not skip coordinates recorded by a different checkout: `bindingMatches` compares `repoCommit`, so a constant would let a post-change smoke report success without executing the changed code. commentlint: allow(JUDGE) */
function smokeRepoCommit(recordsPath: string): string {
    const started = resolve(import.meta.dir, "..");
    const at = (cwd: string) => (args: string[]): string => {
        const run = Bun.spawnSync(["git", ...args], { cwd });
        if (run.exitCode !== 0) {
            throw new Error(`cannot resolve the smoke records binding: git ${args.join(" ")}`);
        }
        return run.stdout.toString();
    };
    /** Run from the worktree root: `git ls-files --others` and the paths `git status` prints are both relative to the working directory, so a package-local cwd would miss a change made anywhere else in the repository. commentlint: allow(JUDGE) */
    const root = at(started)(["rev-parse", "--show-toplevel"]).trim();
    const git = at(root);
    const commit = git(["rev-parse", "HEAD"]).trim();
    /** The runner writes its own records file, so hashing it would change the binding on every run and reject every completed coordinate the resume exists to reuse. commentlint: allow(JUDGE) */
    /** The store's lock file sits beside the records file and a killed run leaves it behind, so it is runner-owned output too: hashing it would reject every completed record on the resume that is about to reclaim it. commentlint: allow(JUDGE) */
    /** `publishJsonAtomically` writes through `${path}.tmp-<hex>` before renaming, so a run killed mid-write leaves one behind; the lock is a directory the next run reclaims. Both are runner-owned output, and hashing either would reject every stored coordinate. commentlint: allow(JUDGE) */
    const owned = [recordsPath, `${recordsPath}.lock`, `${recordsPath}.tmp-*`]
        .map((path) => relativeTo(root, path))
        .filter((path): path is string => path !== null);
    const scope = [".", ...owned.map((path) => `:(exclude)${path}`)];
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
        Buffer.from(git(["diff", "HEAD", "--", ...scope]), "utf8"),
    ];
    for (const path of untracked) {
        parts.push(Buffer.from(`${path}\n`, "utf8"));
        try {
            parts.push(readFileSync(resolve(root, path)));
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
    /** Keys are sorted before comparing: `exclusionCounts` and `providerCalls` are built in iteration order, so a change in arm scheduling or route resolution would otherwise report drift for identical content. commentlint: allow(JUDGE) */
    const canonical = (value: unknown): string =>
        JSON.stringify(value, (_key, nested: unknown) =>
            nested !== null && typeof nested === "object" && !Array.isArray(nested)
                ? Object.fromEntries(
                    Object.entries(nested as Record<string, unknown>).sort(([left], [right]) =>
                        left < right ? -1 : left > right ? 1 : 0
                    ),
                )
                : nested);
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

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
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

    const result = await runPairedDelta(
        {
            scenarios: SCENARIOS,
            poolManifestFingerprint: "smoke-pool-v1",
            repoCommit: smokeRepoCommit(args.recordsPath),
            pinnedProviderId: "mock-live",
            pinnedSnapshotId: "mock-snapshot-2026-08-31",
            replicateCount: 1,
            deskCostCeilingUsd: 0.01,
            maxCostUsd: args.maxCostUsd,
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
    );

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

await main();
