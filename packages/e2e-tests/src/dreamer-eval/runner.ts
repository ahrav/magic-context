import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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
import {
    DREAM_VERIFY_SESSION_TITLE,
    runVerify,
    VERIFY_BATCH_SIZE,
    type VerifyResult,
} from "../../../plugin/src/features/magic-context/dreamer/verify";
import {
    DREAM_MAP_MEMORIES_SESSION_TITLE,
    MAP_BATCH_SIZE,
    mapMemories,
} from "../../../plugin/src/features/magic-context/dreamer/map-memories";
import {
    CLASSIFY_CHUNK_SIZE,
    DREAM_CLASSIFY_SESSION_TITLE,
    runClassify,
} from "../../../plugin/src/features/magic-context/dreamer/classify";
import { dreamerManifestIdentity } from "../../../plugin/src/features/magic-context/dreamer/claim-manifest";
import { sha256Utf8Hex } from "../../../plugin/src/features/magic-context/memory/storage-claims";
import { getSubagentInvocations } from "../../../plugin/src/features/magic-context/storage-subagent-invocations";
import { autonomousManifestRejectionRequestDigest } from "../../../plugin/src/features/magic-context/memory/storage-claim-autonomous";
import { TestHarness } from "../harness";
import { PLUGIN_BUNDLE_ENTRY, PLUGIN_REPO_ROOT, pluginEntryPath } from "../opencode-runner/spawn";
import { openTestDb } from "../test-db";
import { liveModelSpawnOptions } from "../oracle-arms/presets";
import {
    DREAMER_EVAL_REPORT_SCHEMA,
    isRunFatal,
    isValidRepoCommitSha,
    isValidRunId,
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
    type PluginRuntimeSource,
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
    fixtureGitEnv,
    readDreamerEvalPoolDescriptor,
    seedDreamerEvalTask,
} from "./seeder";

const TASK_TITLES: Record<DreamerTask, string> = {
    verify: DREAM_VERIFY_SESSION_TITLE,
    "verify-broad": DREAM_VERIFY_SESSION_TITLE,
    "map-memories": DREAM_MAP_MEMORIES_SESSION_TITLE,
    "classify-memories": DREAM_CLASSIFY_SESSION_TITLE,
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
    /** Every path the scenario's fixture commits — the universe production's
     *  `git ls-files` lookup resolves an observed mapping path against. */
    trackedFiles: readonly string[];
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
        runFatal: isRunFatal(status, reason),
        parsedManifest,
    };
}

function scoreManifest(input: DreamerRunClassificationInput): ManifestScore {
    const text = input.rawManifest ?? "";
    const evidence = { messages: input.childMessages };
    if ((input.task === "verify" || input.task === "verify-broad") && input.gold.kind === "verify") {
        return scoreVerifyManifest(text, input.pool, input.gold, input.trackedFiles, evidence);
    }
    if (input.task === "map-memories" && input.gold.kind === "map") {
        return scoreMapManifest(text, input.pool, input.gold, input.trackedFiles, evidence);
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

/** The scored outcome when this run committed an irreversible mutation, or null. */
function appliedRunFatalScore(input: DreamerRunClassificationInput): ManifestScore | null {
    if (input.rawManifest === null || input.rawManifest.trim().length === 0) return null;
    if (!input.receipts.some((receipt) => receipt.outcome === "applied")) return null;
    const scored = scoreManifest(input);
    return isRunFatal(scored.status, scored.reason) ? scored : null;
}

export function classifyDreamerRun(input: DreamerRunClassificationInput): DreamerRunClassification {
    if (!input.fixtureUnchanged) return outcome("ERROR", "fixture-drift");
    if (input.childCount !== input.expectedChildCount) return outcome("ERROR", "harness-failure");
    // The lease is checked after the run, so it can expire while evidence is being
    // collected. An `applied` receipt under this run's producer proves its write
    // committed, and a run-fatal score says what committed was irreversible — an
    // expiry afterwards cannot unmake that, and reporting `lease-lost` would drop
    // the safety exit 2 for data that really was destroyed. Scoped to this check
    // deliberately: fixture drift and a child-count mismatch undermine the evidence
    // the score itself rests on, so they still win.
    if (input.leaseLost && appliedRunFatalScore(input) === null) {
        return outcome("ERROR", "lease-lost");
    }
    // Only a task that returned a result can disagree about its mode. A verify
    // lane whose task threw — a credential, transport, abort, or typed provider
    // output failure — leaves this null, and reporting that as a gate partition
    // mismatch buries the real fault; the checks below name it instead.
    if (
        input.expectedResultMode !== null &&
        input.actualResultMode !== null &&
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
    // A run-fatal score records an effect that cannot be undone, and
    // `dreamerEvalExitCode` turns it into the safety exit 2. Replacing it with
    // the model mismatch below would drop that to exit 1, reporting an invalid
    // experiment where a destructive one happened — so a fatal score keeps its
    // classification and continues through the receipt checks.
    if (!isRunFatal(scored.status, scored.reason) && input.invocation?.status === "completed") {
        const actualModel =
            input.invocation.providerId && input.invocation.modelId
                ? `${input.invocation.providerId}/${input.invocation.modelId}`
                : null;
        if (actualModel !== input.pinnedModel) return outcome("ERROR", "fallback-engaged");
    }

    // A receipt and the mutations it covers are written in one transaction —
    // `runClaimOperationInCurrentTransaction` records it inside the transaction
    // that stages the items, with a `noop` outcome when nothing changed — so an
    // applied or noop receipt is the only proof the pool took the manifest, and a
    // `stale` one is proof it did not.
    const applied = input.receipts.some(
        (receipt) => receipt.outcome === "applied" || receipt.outcome === "noop",
    );
    const refusedThisManifest =
        input.rejectionRequestDigest !== null &&
        input.receipts.some(
            (receipt) =>
                receipt.outcome === "stale" && receipt.requestDigest === input.rejectionRequestDigest,
        );
    const staleApply = input.receipts.some(
        (receipt) =>
            receipt.outcome === "stale" &&
            !(refusedThisManifest && receipt.requestDigest === input.rejectionRequestDigest),
    );

    // Two claims depend on the manifest having been committed: a PASS reports a
    // successful applied experiment, and a run-fatal reason reports an
    // irreversible mutation and drives the safety exit 2. Without an applied
    // receipt neither happened, and reporting exit 2 for a proposal the pool
    // refused is a false alarm about destroyed data. Ordinary failures assert
    // neither, so they keep the scorer's reason.
    const overstated = scored.status === "PASS" || isRunFatal(scored.status, scored.reason);
    if (overstated && !applied) {
        return outcome("ERROR", "apply-not-applied", scored.parsedManifest);
    }
    if (refusedThisManifest) {
        // Production refused these exact bytes and recorded the rejection. The
        // scorer judged the same bytes, so its failure reason is the honest report
        // — `wrong-mapping` for a manifest whose paths are all untracked,
        // `wrong-update-content` for a blank or over-long body, `invalid-output`
        // for one the validator threw on. A PASS beside a refusal is the two
        // contracts disagreeing, which is a harness fault rather than a result.
        return scored.status === "FAIL"
            ? outcome(scored.status, scored.reason, scored.parsedManifest)
            : outcome("ERROR", "harness-failure", scored.parsedManifest);
    }
    if (staleApply) return outcome("ERROR", "apply-not-applied", scored.parsedManifest);
    if (scored.status === "FAIL" && scored.reason === "invalid-output") {
        // The validator threw but production recorded no rejection for it, so the
        // two disagree about the same bytes.
        return outcome("ERROR", "harness-failure", scored.parsedManifest);
    }
    return outcome(scored.status, scored.reason, scored.parsedManifest);
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
    const batchSize =
        task === "map-memories"
            ? MAP_BATCH_SIZE
            : task === "classify-memories"
              ? CLASSIFY_CHUNK_SIZE
              : VERIFY_BATCH_SIZE;
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

function readReceipts(
    db: ReturnType<typeof openTestDb>,
    producer: string,
    task: DreamerTask,
    logicalClaimIds: readonly string[],
): DreamerReceiptEvidence[] {
    const rows = db.prepare(
        `SELECT request_digest AS requestDigest, outcome
           FROM claim_operation_receipts
          WHERE producer = ?
          ORDER BY id`,
    ).all(producer) as ReceiptRow[];
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

/**
 * Every path the seeded fixture repository tracks, which is the universe
 * production's `git ls-files` lookup resolves an observed mapping path against.
 *
 * Read from git rather than from the scenario's declared fixture files: the seeder
 * also commits its `.dreamer-eval-fixture` marker, so production would accept and
 * store a mapping naming it while a declared-file universe would drop it and hide
 * the extra mapping.
 */
function trackedFixtureFiles(workdir: string): string[] {
    // `-z`: plain `ls-files` quotes and escapes a path with non-ASCII bytes, a
    // backslash, or a newline, which would record the displayed spelling instead of
    // the tracked path production resolves — and a quoted form can itself violate
    // the report's path rules.
    const listed = gitOutput(workdir, ["ls-files", "-z"]);
    if (listed === null) throw new Error("dreamer-eval could not list the fixture's tracked files");
    return listed.split("\0").filter((path) => path.length > 0);
}

function reportCleanupFailure(step: string, error: unknown): void {
    console.error(
        `dreamer-eval cleanup failed at ${step}: ${error instanceof Error ? error.message : String(error)}`,
    );
}

function gitOutput(workdir: string, args: readonly string[]): string | null {
    const result = Bun.spawnSync(["git", ...args], {
        cwd: workdir,
        env: fixtureGitEnv(),
        stdout: "pipe",
        stderr: "ignore",
    });
    return result.success ? result.stdout.toString().trim() : null;
}

/**
 * What this run will actually execute, beyond what the commit pins.
 *
 * `pluginEntry` is resolved by asking the spawner, not by recomputing its choice:
 * a second copy would describe the wrong file the moment its preference changed.
 *
 * The digest covers the loaded bundle's bytes when a bundle is loaded — the bundle
 * is one file with every import inlined, and it is normally ignored by git, so the
 * tree says nothing about it — plus every working-tree deviation from HEAD across
 * the whole repository. Deviations carry content, not just names: `git diff HEAD`
 * omits untracked files entirely, so an untracked module that an import already
 * resolves could be edited without moving the digest. The scope is the repository
 * rather than `packages/plugin` because the runner, scorers, contract, seeder, and
 * scenario corpus all decide a run's outcome too.
 *
 * The run's own output tree is excluded. Outputs are not inputs, and a
 * `--output-dir` inside the repository but outside the ignored default would
 * otherwise make each completed repeat an untracked deviation seen by the next
 * repeat — giving every repeat a different tuple, discovered only after every
 * model call, when variance refuses to aggregate them.
 */
function runtimeProvenance(artifactDir: string): {
    pluginEntry: PluginRuntimeSource;
    runtimeDigest: string;
} {
    const pluginEntry: PluginRuntimeSource = pluginEntryPath() === PLUGIN_BUNDLE_ENTRY ? "dist" : "src";
    const head = gitOutput(PLUGIN_REPO_ROOT, ["rev-parse", "HEAD"]);
    // `-z` because a path may contain whitespace, and porcelain quotes such paths
    // otherwise. Ignored files stay out, which is what keeps artifact directories
    // from entering the digest.
    const status = gitOutput(PLUGIN_REPO_ROOT, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (head === null || status === null) {
        throw new Error("dreamer-eval could not resolve the runtime working-tree state");
    }
    const outputRoot = resolve(artifactDir);
    // The exclusion below is sound only if the directory holds no runtime inputs.
    // A caller pointing `artifactDir` at the repository root or a source ancestor
    // would otherwise hide every dirty file under it, letting two different
    // implementations share one tuple. A directory containing tracked files is not
    // an output directory.
    const trackedUnderOutput = gitOutput(PLUGIN_REPO_ROOT, ["ls-files", "-z", "--", outputRoot]);
    if (trackedUnderOutput === null) {
        throw new Error("dreamer-eval could not inspect the artifact directory");
    }
    if (trackedUnderOutput.split("\0").some((path) => path.length > 0)) {
        throw new Error("dreamer-eval artifact directory must not contain tracked files");
    }
    const deviations = status
        .split("\0")
        .filter((entry) => entry.length > 3)
        .filter((entry) => {
            const absolute = resolve(PLUGIN_REPO_ROOT, entry.slice(3));
            return absolute !== outputRoot && !absolute.startsWith(`${outputRoot}${sep}`);
        })
        .map((entry) => {
            const path = entry.slice(3);
            const absolute = join(PLUGIN_REPO_ROOT, path);
            let content = "";
            try {
                content = statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : "";
            } catch {
                // Deleted, or unreadable: the status code below still records the
                // deviation, and an unreadable path cannot be an evaluator input.
                content = "";
            }
            return `${entry.slice(0, 2)}\u0000${path}\u0000${sha256Utf8Hex(content)}`;
        })
        .sort();
    const bundle = pluginEntry === "dist" ? sha256Utf8Hex(readFileSync(PLUGIN_BUNDLE_ENTRY, "utf8")) : "";
    return {
        pluginEntry,
        runtimeDigest: sha256Utf8Hex([head, bundle, ...deviations].join("\u0001")),
    };
}

function systemTuple(options: RunDreamerEvalTaskOptions) {
    const repoCommitSha =
        options.repoCommitSha ?? gitOutput(import.meta.dir, ["rev-parse", "HEAD"]) ?? "";
    // The report contract's own predicate: a length this accepted but that refused
    // would spend a model run and then lose the artifact to `parseRunReport`.
    if (!isValidRepoCommitSha(repoCommitSha)) {
        throw new Error("dreamer-eval could not resolve a concrete repository commit");
    }
    return {
        repoCommitSha,
        bunVersion: Bun.version,
        opencodeVersion: options.opencodeVersion ?? "unknown",
        modelId: options.model,
        platform: process.platform,
        parserImpl: "ts" as const,
        ...runtimeProvenance(options.artifactDir),
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
    // Checked before the harness starts: this value is interpolated into the
    // artifact filename, so `../../result` would escape `artifactDir` and overwrite
    // an unrelated file, and any malformed id yields a report `parseRunReport`
    // refuses once the live run has already been paid for.
    if (!isValidRunId(runId)) throw new Error(`dreamer-eval run id is invalid: ${runId}`);
    // Resolve provenance before the run so a failure cannot spend model
    // credits and then lose the report artifact to a late throw.
    const system = systemTuple(options);
    let harness: TestHarness | null = null;
    let db: ReturnType<typeof openTestDb> | null = null;
    let parentSessionId = "";
    let trackedFiles: string[] = [];
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
        trackedFiles = trackedFixtureFiles(seeded.workdir);
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
        const manifestIdentity = dreamerManifestIdentity({
            db,
            holderId,
            leaseKey,
            parentSessionId,
            task: task.task,
            publicClaimIds: expectedPublicIds,
        });
        receipts = readReceipts(db, manifestIdentity.producer, task.task, task.expectedInScopeClaimIds);
        const rejectionRequestDigest = rawManifest === null
            ? null
            : autonomousManifestRejectionRequestDigest({
                  identity: manifestIdentity,
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
            trackedFiles,
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
        // Each step stands alone. A throw from one — a busy database on lease
        // release, a dispose race — used to skip every step after it, leaking
        // process-global keep-subagents state and a live harness into every
        // later run in the same process. A cleanup failure does not change this
        // run's classification: the report's evidence is already captured, and
        // what a leak damages is the runs that follow.
        if (acquired !== null && db !== null) {
            try {
                releaseLease(db, holderId, leaseKey);
            } catch (error) {
                reportCleanupFailure("lease release", error);
            }
        }
        try {
            setKeepSubagents(priorKeepSubagents);
        } catch (error) {
            reportCleanupFailure("keep-subagents restore", error);
        }
        try {
            db?.close();
        } catch (error) {
            reportCleanupFailure("database close", error);
        }
        if (harness !== null) {
            try {
                await harness.dispose();
            } catch (error) {
                reportCleanupFailure("harness dispose", error);
            }
        }
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
        trackedFiles,
        poolBefore,
        poolAfter,
        rawManifest,
        parsedManifest: classification.parsedManifest,
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
