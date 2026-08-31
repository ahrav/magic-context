#!/usr/bin/env bun

import { resolve } from "node:path";
import {
    FileRolloutStore,
    ProviderUnavailableError,
    runPairedDelta,
    verifyDualMockResolution,
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

/** A resume must not skip coordinates recorded by a different checkout: `bindingMatches` compares `repoCommit`, so a constant would let a post-change smoke report success without executing the changed code. commentlint: allow(JUDGE) */
function smokeRepoCommit(): string {
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: resolve(import.meta.dir, "..") });
    if (head.exitCode !== 0) throw new Error("cannot resolve HEAD for the smoke records binding");
    const commit = head.stdout.toString().trim();
    const dirty = Bun.spawnSync(["git", "status", "--porcelain"], {
        cwd: resolve(import.meta.dir, ".."),
    });
    if (dirty.exitCode !== 0) throw new Error("cannot resolve the worktree state");
    /** An uncommitted worktree shares its parent's commit, so the digest keeps a resume from reusing records written before the edit. commentlint: allow(JUDGE) */
    const pending = dirty.stdout.toString().trim();
    if (pending === "") return commit;
    return `${commit}-dirty-${Bun.hash(pending).toString(16)}`;
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
            repoCommit: smokeRepoCommit(),
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

    console.log(JSON.stringify({
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
    }, null, 2));
    if (result.status !== "completed") process.exitCode = 1;
}

await main();
