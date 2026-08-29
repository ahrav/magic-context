import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext } from "../../../plugin/src/plugin/types";
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
import { computeClaimOperationRequestDigest } from "../../../plugin/src/features/magic-context/memory/claim-operation-contract";
import { sha256Utf8Hex } from "../../../plugin/src/features/magic-context/memory/storage-claims";
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
        runFatal: status === "FAIL" && reason === "wrong-archival",
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

    const stale = input.receipts.find((receipt) => receipt.outcome === "stale");
    if (stale !== undefined) {
        if (
            input.rejectionRequestDigest !== null &&
            stale.requestDigest === input.rejectionRequestDigest
        ) {
            return scored.status === "FAIL" && scored.reason === "invalid-output"
                ? outcome("FAIL", "invalid-output", scored.parsedManifest)
                : outcome("ERROR", "harness-failure", scored.parsedManifest);
        }
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
    requestDigest: string;
    outcome: string;
}

function modelProviderBlock(model: string): Record<string, unknown> {
    const [providerId, modelId] = model.split("/", 2);
    if (providerId !== "anthropic" || !modelId) {
        throw new Error("dreamer-eval live runner requires an anthropic/provider model pin");
    }
    return {
        anthropic: {
            api: "@ai-sdk/anthropic",
            name: "Anthropic",
            npm: "@ai-sdk/anthropic",
            env: ["ANTHROPIC_API_KEY"],
            models: {},
        },
    };
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

function rejectionDigest(args: {
    task: DreamerTask;
    parentSessionId: string;
    leaseKey: string;
    leaseGeneration: number;
    publicClaimIds: readonly string[];
    rawManifest: string;
}): string {
    const batchId = createHash("sha256")
        .update([...args.publicClaimIds].sort((left, right) => left.localeCompare(right)).join("\n"))
        .digest("hex")
        .slice(0, 24);
    return computeClaimOperationRequestDigest({
        identity: {
            batchId,
            leaseGeneration: String(args.leaseGeneration),
            leaseKey: args.leaseKey,
            runId: args.parentSessionId,
            task: args.task,
        },
        manifestDigest: sha256Utf8Hex(args.rawManifest),
        operation: "reject-autonomous-project-memory-manifest",
    });
}

function readReceipts(
    db: ReturnType<typeof openTestDb>,
    task: DreamerTask,
    logicalClaimIds: readonly string[],
): DreamerReceiptEvidence[] {
    const rows = db.prepare(
        `SELECT request_digest AS requestDigest, outcome
           FROM claim_operation_receipts
          WHERE producer = ?
          ORDER BY id`,
    ).all(`dreamer-${task}`) as ReceiptRow[];
    return rows.flatMap((row) =>
        logicalClaimIds.map((claimId) => ({
            claimId,
            operation: task,
            outcome: row.outcome,
            requestDigest: row.requestDigest,
        })),
    );
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

function systemTuple(options: RunDreamerEvalTaskOptions) {
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const repoCommitSha = options.repoCommitSha ?? head.stdout.toString().trim();
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
        const providerBlock = modelProviderBlock(options.model);
        const live = liveModelSpawnOptions({ apiKey: options.apiKey, providerBlock });
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
            .filter((row) => row.task === task.task);
        const latest = rows[0];
        invocation = latest
            ? {
                  status: latest.status,
                  providerId: latest.providerId,
                  modelId: latest.modelId,
              }
            : null;
        receipts = readReceipts(db, task.task, task.expectedInScopeClaimIds);
        const rejectionRequestDigest = rawManifest === null
            ? null
            : rejectionDigest({
                  task: task.task,
                  parentSessionId,
                  leaseKey,
                  leaseGeneration: acquired.generation,
                  publicClaimIds: expectedPublicIds,
                  rawManifest,
              });
        let fixtureUnchanged = true;
        try {
            assertFixtureFilesCommitted(seeded.workdir, fixturePaths(scenario));
            fixtureUnchanged =
                gitOutput(seeded.workdir, ["rev-parse", "HEAD"]) === fixtureHead &&
                gitOutput(seeded.workdir, ["status", "--porcelain"]) === "";
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
        system: systemTuple(options),
        poolBefore,
        poolAfter,
        rawManifest,
        parsedManifest: classification.parsedManifest as Record<string, unknown> | unknown[] | null,
        receiptOutcomes: receipts.map(({ claimId, operation, outcome: receiptOutcome }) => ({
            claimId,
            operation,
            outcome: receiptOutcome,
        })),
    };
    mkdirSync(options.artifactDir, { recursive: true });
    writeFileSync(join(options.artifactDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`);
    return report;
}
