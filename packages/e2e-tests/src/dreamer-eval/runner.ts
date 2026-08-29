import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext } from "../../../plugin/src/plugin/types";
import type { Database } from "../../../plugin/src/shared/sqlite";
import { extractLatestAssistantText } from "../../../plugin/src/shared/assistant-message-extractor";
import {
    setKeepSubagents,
    shouldKeepSubagents,
} from "../../../plugin/src/shared/keep-subagents";
import {
    acquireLeaseWithAcquisition,
    leaseOwnershipMatches,
    releaseLease,
} from "../../../plugin/src/features/magic-context/dreamer/lease";
import { leaseKeyFor } from "../../../plugin/src/features/magic-context/dreamer/task-registry";
import { runVerify, type VerifyResult } from "../../../plugin/src/features/magic-context/dreamer/verify";
import { mapMemories } from "../../../plugin/src/features/magic-context/dreamer/map-memories";
import { runClassify } from "../../../plugin/src/features/magic-context/dreamer/classify";
import { getSubagentInvocations } from "../../../plugin/src/features/magic-context/storage-subagent-invocations";
import { computeAutonomousManifestRejectionRequestDigest } from "../../../plugin/src/features/magic-context/memory/storage-claim-autonomous";
import { dreamerManifestIdentity } from "../../../plugin/src/features/magic-context/dreamer/claim-manifest";
import { TestHarness } from "../harness";
import { openTestDb } from "../test-db";
import { liveModelSpawnOptions } from "../oracle-arms/presets";
import {
    DREAMER_EVAL_REPORT_SCHEMA,
    type ClaimOperationReceiptOutcome,
    type ClaimSnapshotProjection,
    type DreamerEvalRunReport,
    type DreamerEvalScenario,
    type DreamerRunStatus,
    type DreamerTask,
    type DreamerTaskScenario,
    type ErrorReason,
    type FailReason,
    type ParsedLayerGold,
    type PoolDescriptor,
    isRunFatalFailure,
} from "./contract";
import {
    scoreClassifyManifest,
    scoreMapManifest,
    scoreVerifyManifest,
    type ManifestScore,
} from "./scorer";
import {
    assertFixtureFilesCommitted,
    DreamerEvalSeederError,
    readDreamerEvalPoolDescriptor,
    seedDreamerEvalTask,
} from "./seeder";

const TASK_TITLES: Record<DreamerTask, string> = {
    verify: "magic-context-dream-verify",
    "verify-broad": "magic-context-dream-verify",
    "map-memories": "magic-context-dream-map-memories",
    "classify-memories": "magic-context-dream-classify",
};

interface DreamerTaskClient {
    session: {
        create: PluginContext["client"]["session"]["create"];
        prompt: PluginContext["client"]["session"]["prompt"];
        messages: PluginContext["client"]["session"]["messages"];
        delete: PluginContext["client"]["session"]["delete"];
        children: PluginContext["client"]["session"]["children"];
    };
}

export interface DreamerInvocationEvidence {
    status: "completed" | "failed" | "aborted";
    providerId: string | null;
    modelId: string | null;
}

export interface DreamerReceiptEvidence extends ClaimOperationReceiptOutcome {
    requestDigest: string;
}

export interface DreamerRunClassificationInput {
    task: DreamerTask;
    pool: PoolDescriptor;
    gold: ParsedLayerGold;
    pinnedModel: string;
    rawManifest: string | null;
    childMessages: unknown;
    childCount: number;
    expectedChildCount: number;
    invocation: DreamerInvocationEvidence | null;
    receipts: readonly DreamerReceiptEvidence[];
    rejectionRequestDigest: string | null;
    fixtureUnchanged: boolean;
    leaseLost: boolean;
    expectedResultMode: string | null;
    actualResultMode: string | null;
}

export interface DreamerRunClassification {
    status: DreamerRunStatus;
    reason: ErrorReason | FailReason | null;
    runFatal: boolean;
    parsedManifest: ManifestScore["parsedManifest"];
}

function outcome(
    status: DreamerRunStatus,
    reason: ErrorReason | FailReason | null,
    parsedManifest: ManifestScore["parsedManifest"] = null,
): DreamerRunClassification {
    return {
        status,
        reason,
        runFatal: isRunFatalFailure(status, reason),
        parsedManifest,
    };
}

function scoreManifest(input: DreamerRunClassificationInput): ManifestScore {
    const text = input.rawManifest ?? "";
    const evidence = { messages: input.childMessages };
    if ((input.task === "verify" || input.task === "verify-broad") && input.gold.kind === "verify") {
        return scoreVerifyManifest(text, input.pool, input.gold, evidence);
    }
    if (input.task === "map-memories" && input.gold.kind === "map") {
        return scoreMapManifest(text, input.pool, input.gold, evidence);
    }
    if (input.task === "classify-memories" && input.gold.kind === "classify") {
        return scoreClassifyManifest(text, input.pool, input.gold, evidence);
    }
    return {
        stage: "infra-rejected",
        status: "ERROR",
        reason: "harness-failure",
        runFatal: false,
        parsedManifest: null,
    };
}

export function classifyDreamerRun(input: DreamerRunClassificationInput): DreamerRunClassification {
    if (!input.fixtureUnchanged) return outcome("ERROR", "fixture-drift");
    if (input.childCount !== input.expectedChildCount) return outcome("ERROR", "harness-failure");
    if (input.leaseLost) return outcome("ERROR", "lease-lost");
    if (
        input.expectedResultMode !== null &&
        input.actualResultMode !== input.expectedResultMode
    ) {
        return outcome("ERROR", "wrong-result-mode");
    }
    if (input.rawManifest === null || input.rawManifest.trim().length === 0) {
        return outcome("ERROR", "provider-failure");
    }

    const scored = scoreManifest(input);
    const matchingRejection = input.rejectionRequestDigest === null
        ? undefined
        : input.receipts.find((receipt) => receipt.requestDigest === input.rejectionRequestDigest);
    if (scored.status === "ERROR") {
        return outcome("ERROR", scored.reason, scored.parsedManifest);
    }
    if (scored.stage === "scored" && input.invocation?.status !== "completed") {
        return outcome("ERROR", "harness-failure", scored.parsedManifest);
    }
    if (input.invocation?.status === "completed") {
        const actualModel =
            input.invocation.providerId && input.invocation.modelId
                ? `${input.invocation.providerId}/${input.invocation.modelId}`
                : null;
        if (actualModel !== input.pinnedModel) return outcome("ERROR", "fallback-engaged");
    }
    if (matchingRejection !== undefined) {
        return outcome("FAIL", "invalid-output", scored.parsedManifest);
    }

    const stale = input.receipts.find((receipt) => receipt.outcome === "stale");
    if (stale !== undefined) {
        return outcome("ERROR", "apply-not-applied", scored.parsedManifest);
    }
    if (scored.status === "FAIL" && scored.reason === "invalid-output") {
        return outcome("ERROR", "harness-failure", scored.parsedManifest);
    }
    return outcome(scored.status, scored.reason, scored.parsedManifest);
}

export function reconstructPoolEndState(
    report: Pick<DreamerEvalRunReport, "poolAfter">,
): ClaimSnapshotProjection[] {
    return report.poolAfter.map((claim) => ({ ...claim, files: [...claim.files] }));
}

export interface RunDreamerEvalTaskOptions {
    apiKey: string;
    model: string;
    artifactDir: string;
    runId?: string;
    nowMs?: number;
    timeoutMs?: number;
    repoCommitSha?: string;
    opencodeVersion?: string;
}

interface CapturedChildren {
    messages: unknown[];
    count: number;
}

interface ReceiptRow {
    receiptId: number;
    requestDigest: string;
    operationKey: string;
    outcome: string;
    publicClaimId: string | null;
}

const ANTHROPIC_PROVIDER_BLOCK: Record<string, unknown> = {
    anthropic: {
        api: "@ai-sdk/anthropic",
        name: "Anthropic",
        npm: "@ai-sdk/anthropic",
        env: ["ANTHROPIC_API_KEY"],
        models: {},
    },
};

export function assertDreamerModelPin(model: string): void {
    if (!/^anthropic\/[^/\s]+$/.test(model)) {
        throw new Error("DREAMER_EVAL_MODEL must use the anthropic/model form");
    }
}

function expectedBatchCount(task: DreamerTask, count: number): number {
    const batchSize = task === "map-memories" ? 80 : 50;
    return count === 0 ? 0 : Math.ceil(count / batchSize);
}

async function captureChildren(
    client: DreamerTaskClient,
    parentSessionId: string,
    task: DreamerTask,
    expectedPublicIds: readonly string[],
): Promise<CapturedChildren> {
    const response = await client.session.children({ path: { id: parentSessionId } });
    const children = Array.isArray(response.data)
        ? response.data as Array<{ id?: unknown; title?: unknown; time?: { created?: number } }>
        : [];
    const matches: Array<{ messages: unknown[]; created: number }> = [];
    for (const child of children) {
        if (typeof child.id !== "string" || child.title !== TASK_TITLES[task]) continue;
        const messagesResponse = await client.session.messages({
            path: { id: child.id },
        });
        const messages = Array.isArray(messagesResponse.data) ? messagesResponse.data : [];
        const transcript = JSON.stringify(messages);
        if (!expectedPublicIds.every((publicId) => transcript.includes(publicId))) continue;
        matches.push({ messages, created: child.time?.created ?? 0 });
    }
    matches.sort((left, right) => right.created - left.created);
    return {
        messages: matches.flatMap((match) => match.messages),
        count: matches.length,
    };
}

function assertDreamerSchedulerDisabled(harness: TestHarness): void {
    const configPath = join(
        harness.opencode.env.configDir,
        "opencode",
        "magic-context.jsonc",
    );
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        dreamer?: { disable?: unknown };
    };
    if (config.dreamer?.disable !== true) {
        throw new Error("dreamer-eval requires the harness dreamer scheduler to be disabled");
    }
}

export function readDreamerReceipts(
    db: Database,
    task: DreamerTask,
    publicClaimIds: Readonly<Record<string, string>>,
): DreamerReceiptEvidence[] {
    const rows = db.prepare(
        `SELECT receipts.id AS receiptId,
                receipts.request_digest AS requestDigest,
                receipts.operation_key AS operationKey,
                receipts.outcome,
                public.public_id AS publicClaimId
           FROM claim_operation_receipts receipts
           LEFT JOIN claim_operation_effects effects ON effects.receipt_id = receipts.id
           LEFT JOIN claim_public_ids public ON public.claim_id = effects.claim_id
          WHERE receipts.producer = ?
          ORDER BY receipts.id, effects.id`,
    ).all(`dreamer-${task}`) as ReceiptRow[];
    const logicalByPublic = new Map(
        Object.entries(publicClaimIds).map(([logical, publicId]) => [publicId, logical]),
    );
    const receipts = new Map<number, DreamerReceiptEvidence>();
    for (const row of rows) {
        const receipt = receipts.get(row.receiptId) ?? {
            requestDigest: row.requestDigest,
            operationKey: row.operationKey,
            outcome: row.outcome,
            affectedClaimIds: [],
        };
        if (row.publicClaimId !== null) {
            const logicalClaimId = logicalByPublic.get(row.publicClaimId);
            if (logicalClaimId === undefined) {
                throw new Error(`dreamer receipt affected unknown claim ${row.publicClaimId}`);
            }
            if (!receipt.affectedClaimIds.includes(logicalClaimId)) {
                receipt.affectedClaimIds.push(logicalClaimId);
            }
        }
        receipts.set(row.receiptId, receipt);
    }
    return [...receipts.values()];
}

function fixturePaths(scenario: DreamerEvalScenario): string[] {
    return [...new Set(scenario.pool.claims.flatMap((claim) => claim.fixtureFiles.map((file) => file.path)))];
}

function gitOutput(workdir: string, args: readonly string[]): string | null {
    const result = Bun.spawnSync(["git", ...args], {
        cwd: workdir,
        stdout: "pipe",
        stderr: "ignore",
    });
    return result.success ? result.stdout.toString().trim() : null;
}

export function resolveDreamerSystemTuple(options: RunDreamerEvalTaskOptions) {
    const repoCommitSha = options.repoCommitSha ?? gitOutput(process.cwd(), ["rev-parse", "HEAD"]) ?? "";
    if (!/^[0-9a-f]{40,64}$/.test(repoCommitSha)) {
        throw new Error("dreamer-eval could not resolve a concrete repository commit");
    }
    return {
        repoCommitSha,
        bunVersion: Bun.version,
        opencodeVersion: options.opencodeVersion ?? "unknown",
        modelId: options.model,
        parserImpl: "ts" as const,
    };
}

async function invokeTask(args: {
    task: DreamerTaskScenario;
    db: ReturnType<typeof openTestDb>;
    client: DreamerTaskClient;
    projectIdentity: string;
    parentSessionId: string;
    workdir: string;
    holderId: string;
    leaseKey: string;
    leaseAcquisition: NonNullable<ReturnType<typeof acquireLeaseWithAcquisition>>;
    model: string;
    deadline: number;
}): Promise<VerifyResult | { batches?: number; chunks?: number }> {
    const common = {
        db: args.db,
        client: args.client as unknown as PluginContext["client"],
        projectIdentity: args.projectIdentity,
        parentSessionId: args.parentSessionId,
        sessionDirectory: args.workdir,
        holderId: args.holderId,
        leaseKey: args.leaseKey,
        deadline: args.deadline,
        leaseAcquisition: args.leaseAcquisition,
        model: args.model,
        fallbackModels: [],
    };
    if (args.task.task === "verify" || args.task.task === "verify-broad") {
        return runVerify({ ...common, forceBroad: args.task.task === "verify-broad" });
    }
    if (args.task.task === "map-memories") return mapMemories(common);
    return runClassify(common);
}

export async function runDreamerEvalTask(
    scenario: DreamerEvalScenario,
    task: DreamerTaskScenario,
    options: RunDreamerEvalTaskOptions,
): Promise<DreamerEvalRunReport> {
    const nowMs = options.nowMs ?? Date.now();
    const runId = options.runId ?? `run-${randomUUID().replaceAll("-", "")}`;
    assertDreamerModelPin(options.model);
    const system = resolveDreamerSystemTuple(options);
    let harness: TestHarness | null = null;
    let db: ReturnType<typeof openTestDb> | null = null;
    let parentSessionId = "";
    let poolBefore: ClaimSnapshotProjection[] = [];
    let poolAfter: ClaimSnapshotProjection[] = [];
    let rawManifest: string | null = null;
    let receipts: DreamerReceiptEvidence[] = [];
    let invocation: DreamerInvocationEvidence | null = null;
    let actualResultMode: string | null = null;
    let classification = outcome("ERROR", "harness-failure");
    let holderId = "";
    let leaseKey = "";
    let acquired: NonNullable<ReturnType<typeof acquireLeaseWithAcquisition>> | null = null;
    const priorKeepSubagents = shouldKeepSubagents();
    try {
        const live = liveModelSpawnOptions({ apiKey: options.apiKey, providerBlock: ANTHROPIC_PROVIDER_BLOCK });
        const activeHarness = await TestHarness.create({ ...live });
        harness = activeHarness;
        assertDreamerSchedulerDisabled(activeHarness);
        if (!activeHarness.hasContextDb()) {
            await activeHarness.waitFor(() => activeHarness.hasContextDb(), { label: "context.db initialization" });
        }
        db = openTestDb(activeHarness.contextDbPath(), { readwrite: true });
        parentSessionId = await activeHarness.createSession();
        if (parentSessionId.trim().length === 0) throw new Error("dreamer-eval parent session id is empty");
        const seeded = await seedDreamerEvalTask({
            db,
            scenario,
            task,
            workdir: activeHarness.opencode.env.workdir,
            nowMs,
        });
        const fixtureHead = gitOutput(seeded.workdir, ["rev-parse", "HEAD"]);
        if (fixtureHead === null) throw new Error("dreamer-eval fixture HEAD is unavailable");
        poolBefore = seeded.pool.claims;
        holderId = `dreamer-eval:${runId}`;
        leaseKey = leaseKeyFor(task.task, seeded.projectIdentity);
        acquired = acquireLeaseWithAcquisition(db, holderId, leaseKey);
        if (acquired === null) throw new Error("dreamer-eval could not acquire lease");

        const taskClient = activeHarness.client as unknown as DreamerTaskClient;
        setKeepSubagents(true);
        let taskError: unknown = null;
        let taskResult: Awaited<ReturnType<typeof invokeTask>> | null = null;
        try {
            taskResult = await invokeTask({
                task,
                db,
                client: taskClient,
                projectIdentity: seeded.projectIdentity,
                parentSessionId,
                workdir: seeded.workdir,
                holderId,
                leaseKey,
                leaseAcquisition: acquired,
                model: options.model,
                deadline: Date.now() + (options.timeoutMs ?? 10 * 60_000),
            });
        } catch (error) {
            taskError = error;
        }
        actualResultMode = taskResult && "mode" in taskResult ? taskResult.mode : null;
        const expectedPublicIds = task.expectedInScopeClaimIds.map(
            (claimId) => seeded.publicClaimIds[claimId]!,
        );
        const captured = await captureChildren(taskClient, parentSessionId, task.task, expectedPublicIds);
        rawManifest = extractLatestAssistantText(captured.messages);
        const rows = getSubagentInvocations(db, parentSessionId, { subagent: "dreamer" })
        const latest = rows.find((row) => row.task === task.task);
        invocation = latest
            ? {
                  status: latest.status,
                  providerId: latest.providerId,
                  modelId: latest.modelId,
              }
            : null;
        receipts = readDreamerReceipts(db, task.task, seeded.publicClaimIds);
        const rejectionRequestDigest = rawManifest === null
            ? null
            : computeAutonomousManifestRejectionRequestDigest(
                  dreamerManifestIdentity({
                      db,
                      holderId,
                      leaseKey,
                      parentSessionId,
                      task: task.task,
                      publicClaimIds: expectedPublicIds,
                  }),
                  rawManifest,
              );
        let fixtureUnchanged = true;
        try {
            assertFixtureFilesCommitted(seeded.workdir, fixturePaths(scenario));
            fixtureUnchanged =
                gitOutput(seeded.workdir, ["rev-parse", "HEAD"]) === fixtureHead;
        } catch {
            fixtureUnchanged = false;
        }
        const leaseLost = !leaseOwnershipMatches(
            db,
            holderId,
            acquired.generation,
            leaseKey,
        );
        poolAfter = readDreamerEvalPoolDescriptor({
            db,
            scenario,
            publicClaimIds: seeded.publicClaimIds,
        }).claims;
        classification = classifyDreamerRun({
            task: task.task,
            pool: seeded.pool,
            gold: task.gold,
            pinnedModel: options.model,
            rawManifest,
            childMessages: captured.messages,
            childCount: captured.count,
            expectedChildCount: expectedBatchCount(task.task, task.expectedInScopeClaimIds.length),
            invocation,
            receipts,
            rejectionRequestDigest,
            fixtureUnchanged,
            leaseLost,
            expectedResultMode: task.expectedResultMode,
            actualResultMode,
        });
        if (taskError !== null && classification.status === "PASS") {
            classification = outcome("ERROR", "harness-failure");
        }
    } catch (error) {
        if (error instanceof DreamerEvalSeederError) {
            classification = outcome("ERROR", error.reason);
        } else {
            classification = outcome("ERROR", "harness-failure");
        }
    } finally {
        if (acquired !== null && db !== null) releaseLease(db, holderId, leaseKey);
        setKeepSubagents(priorKeepSubagents);
        db?.close();
        if (harness !== null) await harness.dispose();
    }

    const report: DreamerEvalRunReport = {
        schema: DREAMER_EVAL_REPORT_SCHEMA,
        scenarioId: scenario.id,
        task: task.task,
        runId,
        nowMs,
        status: classification.status,
        reason: classification.reason,
        runFatal: classification.runFatal,
        system,
        poolBefore,
        poolAfter,
        rawManifest,
        parsedManifest: classification.parsedManifest as Record<string, unknown> | unknown[] | null,
        receiptOutcomes: receipts,
    };
    mkdirSync(options.artifactDir, { recursive: true });
    writeFileSync(join(options.artifactDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`);
    return report;
}
