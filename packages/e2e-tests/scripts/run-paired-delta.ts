#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import {
    parsePolicyOwnerDocument,
} from "../src/prospective-holdout/contract";
import {
    ARM_IDS,
    PRIMARY_ARM_IDS,
    parsePairedDeltaManifest,
    type ArmId,
    type ScenarioDeclaration,
} from "../src/paired-delta/contract";
import {
    estimateFamilyDeltas,
    type FamilyDeltaAnalysis,
    type FamilyDeltaObservation,
    type FamilyNoiseFloor,
} from "../src/paired-delta/estimator";
import { buildPairedDeltaRegistry } from "../src/paired-delta/registry";
import {
    buildCalibrationRecord,
    buildPairedDeltaReport,
    publishCalibrationRecord,
    publishPairedDeltaReport,
    type RawRegretLadder,
} from "../src/paired-delta/report";
import {
    FileRolloutStore,
    ProviderUnavailableError,
    baseScriptFingerprint,
    runPairedDelta,
    verifyDualMockResolution,
    type InterventionDescriptor,
    type PairedDeltaRunResult,
    type RolloutObservation,
    type RolloutRecord,
    type RunnerDependencies,
    type TokenPrices,
} from "../src/paired-delta/runner";
import { canonicalFingerprint } from "../../plugin/scripts/retrieval-benchmark/canonical-json";

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

interface LanePolicy {
    minimumAnalyzableFamilyCount: number;
    bootstrapResamples: number;
    poolManifestFingerprint: string;
    modelMatrix: Array<{
        providerId: string;
        modelId: string;
        contextLimit: number;
    }>;
    replicateCount: number;
    costBudgetUsd: Record<LiveMode, number>;
    pricesPerMillionTokens: TokenPrices;
}

interface PromptResult {
    providerId: string;
    modelId: string;
    usage: RolloutObservation["usage"];
    text: string;
    error: boolean;
}

function parseArgs(argv: string[]): CliArgs {
    let mode: Mode | null = null;
    let recordsPath: string | null = null;
    let reportPath: string | null = null;
    let calibrationRecordPath = "artifacts/paired-delta-calibration.json";
    let resume = false;
    let maxCostUsd: number | null = null;
    let deadlineMinutes = 290;
    const selectMode = (next: Mode): void => {
        if (mode !== null) throw new Error("select exactly one paired-delta mode");
        mode = next;
    };
    const value = (flag: string, index: number): string => {
        const candidate = argv[index];
        if (!candidate || candidate.startsWith("-")) {
            throw new Error(`${flag} requires a value`);
        }
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
        } else if (arg === "--max-cost-usd") {
            maxCostUsd = Number(value(arg, ++index));
        } else if (arg === "--deadline-minutes") {
            deadlineMinutes = Number(value(arg, ++index));
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    if (mode === null) throw new Error("select --smoke, --calibration, --weekly, or --release");
    if (maxCostUsd !== null && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)) {
        throw new Error("--max-cost-usd expects a non-negative number");
    }
    if (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0) {
        throw new Error("--deadline-minutes expects a positive number");
    }
    const stem = mode === "smoke" ? "paired-delta-smoke" : `paired-delta-${mode}`;
    return {
        mode,
        recordsPath: resolve(recordsPath ?? `artifacts/${stem}-records.json`),
        reportPath: resolve(reportPath ?? `artifacts/${stem}-report.json`),
        calibrationRecordPath: resolve(calibrationRecordPath),
        resume,
        maxCostUsd,
        deadlineMinutes,
    };
}

function lanePolicy(): LanePolicy {
    const document = parsePolicyOwnerDocument(policyJson, "magic-context-x4l.14");
    if (document.status !== "ready" || document.policy === null) {
        throw new Error("paired-delta policy is not ready");
    }
    return document.policy as LanePolicy;
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
        error: info.error !== undefined,
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
            : {};
    return mergeHarnessOptions(live, arm, scenario.modelContextLimit);
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
        return JSON.stringify(config.compaction) === JSON.stringify({
            auto: true,
            prune: false,
        });
    }
    return Array.isArray(config.plugin) && config.plugin.length > 0;
}

function authoredEvidenceAbsentFromMemory(
    harness: TestHarness,
    scenario: ScenarioDeclaration,
): boolean {
    if (!harness.hasContextDb()) return false;
    try {
        const evidence = scenario.turnScript.find(
            ({ id }) => id === scenario.absencePrecondition.evidenceTurnId,
        )?.content;
        if (!evidence) return false;
        const row = harness.contextDb()
            .prepare("SELECT COUNT(*) AS count FROM claim_revisions WHERE content LIKE ?")
            .get(`%${evidence}%`) as { count: number } | null;
        return (row?.count ?? 0) === 0;
    } catch {
        return false;
    }
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
            const harness = await TestHarness.create(
                armOptions(
                    input.apiKey,
                    input.providerId,
                    input.modelId,
                    scenario,
                    coordinate.armId,
                ),
            );
            let seeded: ReturnType<typeof seedGoldMemories> = [];
            let scriptedTurnText: string | undefined;
            return {
                async prepare() {
                    if (coordinate.armId !== "r1" && coordinate.armId !== "r2") return;
                    const rows: GoldMemoryRow[] = scenario.interventions.r2.memories.map(
                        ({ claim, evidence }) => ({
                            category: "PROJECT_RULES",
                            content: `${claim}\nEvidence: ${evidence}`,
                        }),
                    );
                    seeded = seedGoldMemories({
                        workdir: harness.opencode.env.workdir,
                        dbPath: harness.contextDbPath(),
                        rows,
                        verification: coordinate.armId === "r1" ? "candidate" : "verified",
                    });
                },
                async run(): Promise<RolloutObservation> {
                    const sessionId = await harness.createSession();
                    const responses: PromptResult[] = [];
                    const assistantText: string[] = [];
                    let ballastBytes = 0;
                    for (const turn of scenario.turnScript) {
                        if (turn.role !== "user") {
                            throw new Error("live paired-delta supports authored user turns only");
                        }
                        let content = turn.content;
                        if (turn.id === "turn-burial") {
                            const ballast = ballastProse(
                                Math.ceil(
                                    scenario.absencePrecondition.minimumBallastBytes / 4,
                                ),
                            );
                            ballastBytes = Buffer.byteLength(ballast);
                            content = `${content}\n\n${ballast}`;
                        }
                        if (
                            coordinate.armId === "r3" &&
                            turn.id === scenario.turnScript.at(-1)?.id
                        ) {
                            content = `${goldEvidencePrompt([{
                                label: scenario.scenarioId,
                                content: scenario.interventions.r3.evidence,
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
                        if (response.error && coordinate.armId !== "mc-off") {
                            throw new ProviderUnavailableError("live provider returned an error");
                        }
                        responses.push(response);
                        assistantText.push(response.text);
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
                    const checks = await scenario.verifier({
                        armId: coordinate.armId,
                        workspacePath: harness.opencode.env.workdir,
                        ...(scriptedTurnText === undefined ? {} : { scriptedTurnText }),
                    });
                    const evidenceIndex = scenario.turnScript.findIndex(
                        ({ id }) => id === scenario.absencePrecondition.evidenceTurnId,
                    );
                    const burialIndex = scenario.turnScript.findIndex(
                        ({ id }) => id === "turn-burial",
                    );
                    const structuralAbsence =
                        evidenceIndex >= 0 &&
                        evidenceIndex < burialIndex &&
                        ballastBytes >= scenario.absencePrecondition.minimumBallastBytes &&
                        ballastBytes > scenario.modelContextLimit;
                    const absencePreconditionHeld =
                        structuralAbsence &&
                        (
                            coordinate.armId !== "mc-on" ||
                            authoredEvidenceAbsentFromMemory(harness, scenario)
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
                        );
                    return {
                        checks,
                        claimedDone: assistantText.some((text) =>
                            /\b(?:done|completed|finished)\b/i.test(text)),
                        absencePreconditionHeld,
                        armIdentityMatches,
                        echoedProviderId: last.providerId,
                        echoedModelId: last.modelId,
                        usage: responses.reduce(
                            (sum, response) => ({
                                input: sum.input + response.usage.input,
                                output: sum.output + response.usage.output,
                                cacheCreation:
                                    sum.cacheCreation + response.usage.cacheCreation,
                                cacheRead: sum.cacheRead + response.usage.cacheRead,
                            }),
                            { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
                        ),
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

function score(record: RolloutRecord, checkIds: readonly string[]): number {
    const selected = record.checks.filter(({ id }) => checkIds.includes(id));
    if (selected.length === 0) throw new Error("paired delta has no shared checks");
    return selected.filter(({ passed }) => passed).length / selected.length;
}

function buildAnalysis(
    result: PairedDeltaRunResult,
    scenarios: readonly ScenarioDeclaration[],
    policy: LanePolicy,
    noiseFloors: readonly FamilyNoiseFloor[],
): { analysis: FamilyDeltaAnalysis; rawRegret: RawRegretLadder[] } {
    const byId = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
    const observations: FamilyDeltaObservation[] = [];
    const rawRegret: RawRegretLadder[] = [];
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
                const shared = scenario.checks
                    .filter(({ appliesToArms }) =>
                        appliesToArms.includes("mc-on") &&
                        appliesToArms.includes(baseline))
                    .map(({ id }) => id);
                observations.push({
                    coordinateId,
                    familyId: scenario.familyId,
                    endpoint,
                    delta:
                        score(coordinate.cells["mc-on"]!, shared) -
                        score(coordinate.cells[baseline]!, shared),
                    runHealth: "completed",
                });
            }
        }
        const regret = coordinate.regret;
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
            rawRegret.push({
                coordinateId,
                familyId: scenario.familyId,
                retrieval: regret.retrieval ?? null,
                formation: regret.formation ?? null,
                representation: regret.representation ?? null,
                label: "raw-non-inferential",
            });
        }
    }
    const analysis = observations.length > 0
        ? estimateFamilyDeltas({
            observations,
            minimumAnalyzableFamilyCount: policy.minimumAnalyzableFamilyCount,
            bootstrapSeed: 20260831,
            bootstrapResamples: policy.bootstrapResamples,
            noiseFloors,
        })
        : {
            bootstrapSeed: 20260831,
            bootstrapResamples: policy.bootstrapResamples,
            minimumAnalyzableFamilyCount: policy.minimumAnalyzableFamilyCount,
            analyzableFamilyCount: 0,
            evidenceSufficient: false,
            endpoints: [],
            liveRegret: [],
            providerMixedRegret: [],
            rawRegretRecords: [],
        };
    return { analysis, rawRegret };
}

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
        invalidSuccessRateByArm: Object.fromEntries(
            [...byArm].map(([armId, rows]) => [
                armId,
                rows.filter(({ cell }) => cell.invalidSuccess).length / rows.length,
            ]),
        ),
        tokensByArm: metric(({ usage }) =>
            usage.input + usage.output + usage.cacheCreation + usage.cacheRead),
        wallClockMsByArm: metric(({ wallClockMs }) => wallClockMs),
        turnsByArm: metric(({ turns }) => turns),
    };
}

function repoCommit(): string {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
        cwd: resolve(import.meta.dir, "../../.."),
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error("cannot resolve repository commit");
    return result.stdout.toString().trim();
}

function smokeScenarios(): ScenarioDeclaration[] {
    const scenario = (scenarioId: string): ScenarioDeclaration => ({
        scenarioId,
        familyId: "fam-smoke",
        title: scenarioId,
        checks: [{
            id: "check-smoke-outcome",
            appliesToArms: ["mc-on", "mc-off", "compaction", "r1", "r2", "r3"],
        }],
        criticalCheckIds: ["check-smoke-outcome"],
        turnScript: [
            { id: "turn-smoke-evidence", role: "user", content: "Remember smoke-id-17." },
            { id: "turn-smoke-probe", role: "user", content: "Return the smoke identifier." },
        ],
        interventions: {
            r1: {
                insertAfterTurnId: "turn-smoke-evidence",
                query: "smoke-id-17",
                locatorIds: ["mem-smoke"],
            },
            r2: { memories: [{ claim: "smoke identifier", evidence: "smoke-id-17" }] },
            r3: { evidence: "smoke-id-17" },
        },
        absencePrecondition: {
            evidenceTurnId: "turn-smoke-evidence",
            minimumBallastBytes: 1024,
        },
        modelContextLimit: 4096,
        restartArms: [],
        verifier: () => [],
    });
    return [
        scenario("var-smoke-provider-error"),
        scenario("var-smoke-failing-verifier"),
    ];
}

async function runSmoke(args: CliArgs): Promise<void> {
    const scenarios = smokeScenarios();
    const result = await runPairedDelta(
        {
            scenarios,
            poolManifestFingerprint: "smoke-pool-v1",
            repoCommit: "smoke-fixture",
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
                baseScriptFingerprint: fingerprint,
                intervention,
            }) {
                return {
                    async run() {
                        if (
                            (
                                scenario.scenarioId === "var-smoke-provider-error" &&
                                coordinate.armId === "mc-off"
                            ) ||
                            (
                                scenario.scenarioId === "var-smoke-failing-verifier" &&
                                coordinate.armId === "r2"
                            )
                        ) {
                            throw new ProviderUnavailableError("scripted provider error");
                        }
                        const passed = coordinate.armId !== "mc-on";
                        return {
                            checks: [{ id: "check-smoke-outcome", passed }],
                            claimedDone: true,
                            absencePreconditionHeld: true,
                            armIdentityMatches: true,
                            echoedProviderId: "mock-live",
                            echoedModelId: "mock-snapshot-2026-08-31",
                            usage: {
                                input: 1000,
                                output: 100,
                                cacheCreation: 100,
                                cacheRead: 100,
                            },
                            turns: scenario.turnScript.length,
                            baseScriptFingerprint: fingerprint,
                            intervention,
                        };
                    },
                    async dispose() {},
                };
            },
        },
    );
    await verifyDualMockResolution({
        liveProviderId: "mock-live",
        liveModelId: "mock-snapshot-2026-08-31",
        modelContextLimit: 4096,
        async sendPrompt(route) {
            return {
                ...route,
                contextLimit: route.providerId === "mock-live" ? 4096 : 200_000,
            };
        },
    });
    console.log(JSON.stringify({
        status: result.status,
        recordsPath: args.recordsPath,
        rolloutCount: result.records.length,
        resumedRollouts: result.resumedRollouts,
        completeRegretLadders: result.coordinates.filter(({ regret }) =>
            regret?.retrieval !== undefined &&
            regret.formation !== undefined &&
            regret.representation !== undefined).length,
        partialRegretLadders: result.coordinates.filter(({ regret }) =>
            regret !== null &&
            (regret.formation === undefined || regret.representation === undefined)).length,
        exclusionCounts: result.exclusionCounts,
    }, null, 2));
}

async function runLive(args: CliArgs): Promise<void> {
    const apiKey = process.env.PAIRED_DELTA_ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error("live paired-delta mode requires PAIRED_DELTA_ANTHROPIC_API_KEY");
    }
    const policy = lanePolicy();
    const manifest = parsePairedDeltaManifest(manifestJson);
    const manifestFingerprint = canonicalFingerprint(manifest);
    if (manifestFingerprint !== policy.poolManifestFingerprint) {
        throw new Error("paired-delta policy does not bind the current pool manifest");
    }
    const model = policy.modelMatrix[0];
    if (!model || !/-\d{8}$/.test(model.modelId)) {
        throw new Error("paired-delta policy requires a dated model snapshot");
    }
    const registry = buildPairedDeltaRegistry();
    const selectedIds = new Set(
        manifest.scenarios
            .filter(({ runModes }) => runModes.includes(args.mode as LiveMode))
            .map(({ scenarioId }) => scenarioId),
    );
    const scenarios = [...registry.values()]
        .map(({ declaration }) => declaration)
        .filter(({ scenarioId }) => selectedIds.has(scenarioId));
    const result = await runPairedDelta(
        {
            scenarios,
            poolManifestFingerprint: manifestFingerprint,
            repoCommit: repoCommit(),
            pinnedProviderId: model.providerId,
            pinnedSnapshotId: model.modelId,
            replicateCount: policy.replicateCount,
            deskCostCeilingUsd: 45,
            maxCostUsd: args.maxCostUsd ?? policy.costBudgetUsd[args.mode as LiveMode],
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
    );
    const scenarioFamilies = new Map(
        scenarios.map(({ scenarioId, familyId }) => [scenarioId, familyId]),
    );
    let noiseFloors: FamilyNoiseFloor[] = [];
    if (args.mode === "calibration") {
        const calibration = buildCalibrationRecord({
            records: result.records,
            scenarioFamilies,
            runStatus: result.status,
            poolManifestFingerprint: manifestFingerprint,
            pinnedSnapshotId: model.modelId,
            decisions: {
                poolSize: 20,
                familyCount: policy.minimumAnalyzableFamilyCount,
                replicateCount: policy.replicateCount,
                cadence: "weekly-and-release",
            },
        });
        publishCalibrationRecord(calibration, args.calibrationRecordPath);
        noiseFloors = calibration.familyNoise.map(({ familyId, spread, interval }) => ({
            familyId,
            value: spread,
            interval,
        }));
    } else if (existsSync(args.calibrationRecordPath)) {
        const raw = JSON.parse(readFileSync(args.calibrationRecordPath, "utf8")) as {
            familyNoise?: Array<{
                familyId: string;
                spread: number;
                interval: { lower: number; upper: number };
            }>;
        };
        noiseFloors = (raw.familyNoise ?? []).map(({ familyId, spread, interval }) => ({
            familyId,
            value: spread,
            interval,
        }));
    }
    const { analysis, rawRegret } = buildAnalysis(result, scenarios, policy, noiseFloors);
    const report = buildPairedDeltaReport({
        poolManifestFingerprint: manifestFingerprint,
        pinnedSnapshotId: model.modelId,
        policyDocument: policyJson,
        analysis,
        exclusions: flattenExclusions(result),
        secondaryMetrics: secondaryMetrics(result.records),
        rawRegretRecords: rawRegret,
        runSummary: {
            status: result.status,
            spentUsd: result.spentUsd,
            observedCostRollouts: result.observedCostRollouts,
            estimatedCostRollouts: result.estimatedCostRollouts,
        },
    });
    publishPairedDeltaReport(report, args.reportPath);
    console.log(JSON.stringify({
        status: result.status,
        reportPath: args.reportPath,
        recordsPath: args.recordsPath,
        calibrationRecordPath:
            args.mode === "calibration" ? args.calibrationRecordPath : null,
        spentUsd: result.spentUsd,
        analyzableFamilyCount: analysis.analyzableFamilyCount,
        evidenceSufficient: analysis.evidenceSufficient,
    }, null, 2));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
    const args = parseArgs(argv);
    if (args.mode === "smoke") await runSmoke(args);
    else await runLive(args);
}

if (import.meta.main) await main();
