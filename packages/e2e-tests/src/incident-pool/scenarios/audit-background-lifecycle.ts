import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Database } from "../../../../plugin/src/shared/sqlite";
import type { PluginContext } from "../../../../plugin/src/plugin/types";
import { initializeDatabase } from "../../../../plugin/src/features/magic-context/storage-db";
import { runMigrations } from "../../../../plugin/src/features/magic-context/migrations";
import { runValidatedHistorianPass } from "../../../../plugin/src/hooks/magic-context/compartment-runner-historian";
import { createDreamTaskExecutor } from "../../../../plugin/src/features/magic-context/dreamer/task-executor";
import {
    acquireLeaseWithAcquisition,
    getLeaseGeneration,
    getLeaseHolder,
} from "../../../../plugin/src/features/magic-context/dreamer/lease";
import { leaseKeyFor } from "../../../../plugin/src/features/magic-context/dreamer/task-registry";
import type { DreamTaskRuntimeConfig } from "../../../../plugin/src/features/magic-context/dreamer/task-scheduler";
import type {
    CaseDriverContext,
    JsonValue,
    NormalizedObservation,
    PreconditionOutcome,
    RegisteredIncidentCase,
    VerifierCheck,
} from "../registry";
import {
    caseHarnessIsWorkspaceScoped,
    caseNamespaceIsUnique,
    createCaseHarness,
    DEFER_USAGE,
    findToolResultText,
    readContextDb,
    runScriptedToolCall,
} from "../support/tool-loop";

function check(id: string, passed: boolean): VerifierCheck {
    return { id, passed };
}

function unmet(): PreconditionOutcome {
    return { satisfied: false, reason: "precondition_unmet", blockedBy: [] };
}

function exactRecord<T>(
    raw: unknown,
    kind: string,
    fields: Record<string, "boolean" | "number" | "string" | "string-array">,
): T {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`${kind} observation must be an object`);
    }
    const record = raw as Record<string, unknown>;
    if (record.kind !== kind) {
        throw new Error(`observation kind must be ${kind}`);
    }
    const expected = ["kind", ...Object.keys(fields)].sort((left, right) =>
        left.localeCompare(right),
    );
    const actual = Object.keys(record).sort((left, right) =>
        left.localeCompare(right),
    );
    if (
        expected.length !== actual.length ||
        expected.some((key, index) => key !== actual[index])
    ) {
        throw new Error(
            `${kind} observation must contain exactly ${expected.join(", ")}`,
        );
    }
    for (const [field, fieldKind] of Object.entries(fields)) {
        const value = record[field];
        if (fieldKind === "string-array") {
            if (
                !Array.isArray(value) ||
                !value.every((entry) => typeof entry === "string")
            ) {
                throw new Error(
                    `${kind} observation field ${field} must be a string array`,
                );
            }
        } else if (typeof value !== fieldKind) {
            throw new Error(
                `${kind} observation field ${field} must be a ${fieldKind}`,
            );
        }
    }
    return raw as T;
}

const A28_FIELDS = {
    workspaceScoped: "boolean",
    namespaceUnique: "boolean",
    failurePathCompleted: "boolean",
    contentCanaryRetained: "boolean",
    terminalCanaryRetained: "boolean",
    shellCanaryRetained: "boolean",
    dumpProjectLocal: "boolean",
    dumpGitignored: "boolean",
    dumpRetainedAfterFailure: "boolean",
    publishedReportRedacted: "boolean",
    sideEffectAbsent: "boolean",
} as const;

export type HistorianFailureDumpObservation = {
    kind: "a28-historian-dump-containment";
    workspaceScoped: boolean;
    namespaceUnique: boolean;
    failurePathCompleted: boolean;
    contentCanaryRetained: boolean;
    terminalCanaryRetained: boolean;
    shellCanaryRetained: boolean;
    dumpProjectLocal: boolean;
    dumpGitignored: boolean;
    dumpRetainedAfterFailure: boolean;
    publishedReportRedacted: boolean;
    sideEffectAbsent: boolean;
};

export const HISTORIAN_FAILURE_DUMP_FIXTURE = {
    response:
        "invalid historian XML with three distinct synthetic canary classes",
    dumpBoundary: "case-owned project-local historian directory",
    retention: "failed validation dumps remain until case teardown",
    publication: "static containment facts only",
} as const;

export function normalizeHistorianFailureDump(
    raw: JsonValue,
): HistorianFailureDumpObservation {
    return exactRecord<HistorianFailureDumpObservation>(
        raw,
        "a28-historian-dump-containment",
        A28_FIELDS,
    );
}

export function preconditionHistorianFailureDump(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const value = normalizeHistorianFailureDump(observation);
    return value.workspaceScoped &&
        value.namespaceUnique &&
        value.failurePathCompleted &&
        value.contentCanaryRetained &&
        value.terminalCanaryRetained &&
        value.shellCanaryRetained
        ? { satisfied: true }
        : unmet();
}

export function verifyHistorianFailureDump(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const value = normalizeHistorianFailureDump(observation);
    return [
        check("check-a28-project-local-dump", value.dumpProjectLocal),
        check("check-a28-gitignore-coverage", value.dumpGitignored),
        check(
            "check-a28-intentional-retention",
            value.dumpRetainedAfterFailure,
        ),
        check("check-a28-report-redaction", value.publishedReportRedacted),
        check("check-a28-metacharacter-safety", value.sideEffectAbsent),
    ];
}

/**
 * Containment against the CANONICAL form of both paths.
 *
 * `resolve` does not follow symlinks, so a workspace reached through one (a
 * symlinked home or temp dir) compares unequal to the same directory named by its
 * real path, and containment fails on a path that is genuinely inside. The
 * sibling check in `support/tool-loop.ts` canonicalizes for the same reason. A
 * path that cannot be canonicalized (it does not exist yet) falls back to
 * `resolve`, so a missing dump is judged as not contained rather than throwing.
 */
function pathInside(root: string, path: string): boolean {
    const canonical = (value: string): string => {
        try {
            return realpathSync(value);
        } catch {
            return resolve(value);
        }
    };
    const resolvedRoot = canonical(root);
    const resolvedPath = canonical(path);
    return (
        resolvedPath === resolvedRoot ||
        resolvedPath.startsWith(`${resolvedRoot}${sep}`)
    );
}

export async function driveHistorianFailureDump(
    context: CaseDriverContext,
): Promise<JsonValue> {
    const projectRoot = join(context.workspaceRoot, "project");
    const sideEffectPath = join(context.workspaceRoot, "a28-shell-side-effect");
    mkdirSync(projectRoot, { recursive: true });

    const contentCanary = "A28_CONTENT_CANARY_7f6d";
    const terminalCanary =
        "\u001b]8;;https://invalid.example\u0007A28_TERMINAL_CANARY\u001b]8;;\u0007";
    const shellCanary = `$(touch ${sideEffectPath}) ; A28_SHELL_CANARY`;
    const invalidOutput = `<output><broken>${contentCanary}${terminalCanary}${shellCanary}</broken>`;
    const dumpPaths: string[] = [];
    const db = new Database(join(context.storeDir, "a28-context.db"));
    initializeDatabase(db);
    runMigrations(db);

    try {
        const client = {
            session: {
                create: async () => ({ data: { id: "a28-historian-child" } }),
                prompt: async () => ({}),
                messages: async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [{ type: "text", text: invalidOutput }],
                        },
                    ],
                }),
                delete: async () => ({}),
            },
        };
        const result = await runValidatedHistorianPass({
            client: client as never,
            db,
            parentSessionId: "a28-parent",
            sessionDirectory: projectRoot,
            prompt: "Return one valid synthetic historian compartment.",
            chunk: {
                startIndex: 0,
                endIndex: 0,
                lines: [{ ordinal: 1, messageId: "a28-message" }],
            },
            priorCompartments: [],
            sequenceOffset: 0,
            dumpLabelBase: "a28-invalid",
            responseDumpObserver: (dumpPath) => dumpPaths.push(dumpPath),
        });

        const dumpPath = dumpPaths[0] ?? "";
        const dumpText =
            dumpPath && existsSync(dumpPath)
                ? readFileSync(dumpPath, "utf8")
                : "";
        const gitInit = Bun.spawnSync(["git", "init", "-q", projectRoot], {
            stdout: "ignore",
            stderr: "ignore",
        });
        const ignored = dumpPath
            ? Bun.spawnSync(
                  [
                      "git",
                      "-C",
                      projectRoot,
                      "check-ignore",
                      "-q",
                      "--",
                      relative(projectRoot, dumpPath),
                  ],
                  { stdout: "ignore", stderr: "ignore" },
              )
            : null;
        const staticFacts = {
            kind: "a28-historian-dump-containment" as const,
            workspaceScoped: pathInside(context.workspaceRoot, projectRoot),
            namespaceUnique: caseNamespaceIsUnique(context),
            failurePathCompleted: !result.ok && dumpPaths.length >= 2,
            contentCanaryRetained: dumpText.includes(contentCanary),
            terminalCanaryRetained: dumpText.includes(terminalCanary),
            shellCanaryRetained: dumpText.includes(shellCanary),
            dumpProjectLocal:
                dumpPath.length > 0 && pathInside(projectRoot, dumpPath),
            dumpGitignored: gitInit.exitCode === 0 && ignored?.exitCode === 0,
            dumpRetainedAfterFailure: dumpPaths.every((path) =>
                existsSync(path),
            ),
            publishedReportRedacted: true,
            sideEffectAbsent: !existsSync(sideEffectPath),
        };
        const serializedFacts = JSON.stringify(staticFacts);
        staticFacts.publishedReportRedacted =
            !serializedFacts.includes(contentCanary) &&
            !serializedFacts.includes(terminalCanary) &&
            !serializedFacts.includes(shellCanary) &&
            // `includes("")` is true for every string, so an absent dump path
            // would read as a leak. Guarded to match `dumpProjectLocal`, which
            // already treats an empty path as "nothing to check".
            (dumpPath.length === 0 || !serializedFacts.includes(dumpPath));
        return staticFacts;
    } finally {
        db.close();
    }
}

const A47_FIELDS = {
    workspaceScoped: "boolean",
    namespaceUnique: "boolean",
    driverCompleted: "boolean",
    curatePathUsed: "boolean",
    memoryToolPublished: "boolean",
    providerToolResultObserved: "boolean",
    originalLeaseAcquired: "boolean",
    originalOwnershipRead: "boolean",
    preWriteBarrierReached: "boolean",
    replacementOwnershipCommitted: "boolean",
    replacementOwnershipRead: "boolean",
    fencingIdUnique: "boolean",
    mutationAbsentBeforeRelease: "boolean",
    barrierReleased: "boolean",
    guardedWriteAttempted: "boolean",
    postCommitMemoryStatus: "string",
    postCommitMutationCount: "number",
    mutationIdsUnique: "boolean",
    terminalLeaseLossEvents: "number",
    taskReportedLeaseLoss: "boolean",
    childReleased: "boolean",
    trace: "string-array",
} as const;

export type LeaseLossResidualWriteObservation = {
    kind: "a47-lease-loss-residual-write";
    workspaceScoped: boolean;
    namespaceUnique: boolean;
    driverCompleted: boolean;
    curatePathUsed: boolean;
    memoryToolPublished: boolean;
    providerToolResultObserved: boolean;
    originalLeaseAcquired: boolean;
    originalOwnershipRead: boolean;
    preWriteBarrierReached: boolean;
    replacementOwnershipCommitted: boolean;
    replacementOwnershipRead: boolean;
    fencingIdUnique: boolean;
    mutationAbsentBeforeRelease: boolean;
    barrierReleased: boolean;
    guardedWriteAttempted: boolean;
    postCommitMemoryStatus: string;
    postCommitMutationCount: number;
    mutationIdsUnique: boolean;
    terminalLeaseLossEvents: number;
    taskReportedLeaseLoss: boolean;
    childReleased: boolean;
    trace: string[];
};

export const LEASE_LOSS_RESIDUAL_WRITE_FIXTURE = {
    task: "curate agentic child with one real ctx_memory archive",
    race: "replacement lease commits while child waits at an injected pre-prompt barrier",
    observation: "separate durable memory status and mutation-log row count",
    resolution: "memory remains active and mutation-log row count remains zero",
    terminal: "one injected delivery through the executor lease-loss handler",
} as const;

export function normalizeLeaseLossResidualWrite(
    raw: JsonValue,
): LeaseLossResidualWriteObservation {
    return exactRecord<LeaseLossResidualWriteObservation>(
        raw,
        "a47-lease-loss-residual-write",
        A47_FIELDS,
    );
}

export function preconditionLeaseLossResidualWrite(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const value = normalizeLeaseLossResidualWrite(observation);
    const satisfied = [
        value.workspaceScoped,
        value.namespaceUnique,
        value.driverCompleted,
        value.curatePathUsed,
        value.memoryToolPublished,
        value.providerToolResultObserved,
        value.originalLeaseAcquired,
        value.originalOwnershipRead,
        value.preWriteBarrierReached,
        value.replacementOwnershipCommitted,
        value.replacementOwnershipRead,
        value.fencingIdUnique,
        value.mutationAbsentBeforeRelease,
        value.barrierReleased,
        value.guardedWriteAttempted,
        // `terminalLeaseLossEvents === 1` is deliberately NOT required here.
        // `check-a47-single-terminal-lease-event` asserts it, and requiring it
        // as setup too made that check unfailable: the verifier only ran when it
        // already held. Production's own lease-loss report stays a precondition
        // because it IS setup — the lease really was lost.
        value.taskReportedLeaseLoss,
        value.childReleased,
    ].every(Boolean);
    return satisfied ? { satisfied: true } : unmet();
}

const A47_TRACE_WITH_COMMIT = [
    "original-ownership",
    "pre-write-barrier",
    "replacement-ownership",
    "mutation-absent",
    "barrier-release",
    "guarded-write-attempt",
    "mutation-commit",
    "terminal-lease-loss",
    "child-release",
];
const A47_TRACE_WITHOUT_COMMIT = A47_TRACE_WITH_COMMIT.filter(
    (event) => event !== "mutation-commit",
);

function traceEquals(
    actual: readonly string[],
    expected: readonly string[],
): boolean {
    return (
        actual.length === expected.length &&
        actual.every((event, index) => event === expected[index])
    );
}

export function verifyLeaseLossResidualWrite(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const value = normalizeLeaseLossResidualWrite(observation);
    const postLeaseMutationObserved =
        value.postCommitMemoryStatus !== "active" ||
        value.postCommitMutationCount !== 0;
    const expectedTrace = postLeaseMutationObserved
        ? A47_TRACE_WITH_COMMIT
        : A47_TRACE_WITHOUT_COMMIT;
    const durableTrace =
        traceEquals(value.trace, expectedTrace) &&
        value.originalOwnershipRead &&
        value.replacementOwnershipRead &&
        value.fencingIdUnique &&
        value.postCommitMemoryStatus !== "missing" &&
        value.postCommitMutationCount >= 0 &&
        (value.postCommitMutationCount === 0 || value.mutationIdsUnique);
    return [
        check(
            "check-a47-no-post-lease-loss-commit",
            value.postCommitMemoryStatus === "active" &&
                value.postCommitMutationCount === 0,
        ),
        check("check-a47-durable-happens-before", durableTrace),
        check(
            "check-a47-single-terminal-lease-event",
            // The counter is incremented by the harness's own `afterPrompt`
            // closure, so on its own it measures this test's instrumentation
            // rather than production behavior. Pairing it with production's
            // lease-loss report makes the check fail when the executor never
            // detects the loss, and the trace marker ties the count to the
            // durable ordering the neighbouring check reads.
            value.terminalLeaseLossEvents === 1 &&
                value.taskReportedLeaseLoss &&
                value.trace.filter((entry) => entry === "terminal-lease-loss")
                    .length === 1,
        ),
        check("check-a47-child-released", value.childReleased),
    ];
}

interface Barrier {
    arrived: Promise<void>;
    release(): void;
    signal(): Promise<void>;
}

async function completionSignal(
    promise: Promise<unknown>,
    value: boolean,
): Promise<boolean> {
    await promise;
    return value;
}

function barrier(): Barrier {
    let arrive: (() => void) | undefined;
    let release: (() => void) | undefined;
    const arrived = new Promise<void>((resolveArrived) => {
        arrive = resolveArrived;
    });
    const released = new Promise<void>((resolveReleased) => {
        release = resolveReleased;
    });
    return {
        arrived,
        release: () => release?.(),
        signal: async () => {
            arrive?.();
            await released;
        },
    };
}

function publishedToolName(
    body: Record<string, unknown>,
    expected: string,
): string | null {
    if (!Array.isArray(body.tools)) return null;
    for (const tool of body.tools) {
        if (
            tool &&
            typeof tool === "object" &&
            (tool as { name?: unknown }).name === expected
        ) {
            return expected;
        }
    }
    return null;
}

function contextDbPath(context: CaseDriverContext, dataDir: string): string {
    const path = join(dataDir, "cortexkit", "magic-context", "context.db");
    if (!pathInside(context.workspaceRoot, path)) {
        throw new Error("A47 context database escaped the case workspace");
    }
    return path;
}

export async function driveLeaseLossResidualWrite(
    context: CaseDriverContext,
): Promise<JsonValue> {
    const h = await createCaseHarness(context, {
        modelContextLimit: 100_000,
        magicContextConfig: {
            execute_threshold_percentage: 20,
            protected_tags: 1,
            dreamer: { disable: false },
            sidekick: { disable: true },
            compressor: { enabled: false },
            memory: {
                enabled: true,
                auto_promote: false,
                auto_search: { enabled: false },
                git_commit_indexing: { enabled: false },
            },
            embedding: { provider: "off" },
        },
    });
    const seedContent = "A47 synthetic lease-loss archive target.";
    const toolCallId = "toolu_a47_guarded_archive";
    const originalHolder = `${context.storeNamespace}-original`;
    const replacementHolder = `${context.storeNamespace}-replacement`;
    const trace: string[] = [];
    const promptBarrier = barrier();
    let barrierReleased = false;
    let terminalLeaseLossEvents = 0;
    let childReleased = false;
    let guardedWriteAttempted = false;
    let curatePathUsed = false;
    let memoryToolPublished = false;
    let postCommitMemoryStatus = "missing";
    let postCommitMutationCount = -1;
    let mutationIdsUnique = false;
    let taskReportedLeaseLoss = false;
    let executorPromise: Promise<unknown> | null = null;
    let executorJoined = false;
    let executorDb: Database | null = null;
    let replacementDb: Database | null = null;
    let leaseKey = "";

    try {
        const parentSessionId = await h.createSession();
        await runScriptedToolCall(h, parentSessionId, {
            tool: "ctx_memory",
            input: {
                action: "write",
                content: seedContent,
                category: "CONSTRAINTS",
            },
            prompt: "Store one synthetic A47 fixture.",
        });
        const seed = readContextDb(
            h,
            (db) =>
                db
                    .prepare(
                        "SELECT id, project_path, status FROM memories WHERE content = ?",
                    )
                    .get(seedContent) as
                    | { id: number; project_path: string; status: string }
                    | undefined,
        );
        if (!seed) throw new Error("A47 seed memory was not persisted");

        const dbPath = contextDbPath(context, h.opencode.env.dataDir);
        executorDb = new Database(dbPath);
        replacementDb = new Database(dbPath);
        leaseKey = leaseKeyFor("curate", seed.project_path);
        const acquisition = acquireLeaseWithAcquisition(
            executorDb,
            originalHolder,
            leaseKey,
        );
        const originalLeaseAcquired = acquisition !== null;
        if (!acquisition)
            throw new Error("A47 could not acquire the original curate lease");
        const originalGeneration = acquisition.generation;
        const originalOwnershipRead = readContextDb(
            h,
            (db) =>
                getLeaseHolder(db, leaseKey) === originalHolder &&
                getLeaseGeneration(db, leaseKey) === originalGeneration,
        );
        if (originalOwnershipRead) trace.push("original-ownership");

        h.mock.reset();
        h.mock.addMatcher((body) => {
            if (guardedWriteAttempted) return null;
            if (
                !JSON.stringify(body).includes(
                    "## Task: Curate Project Memory Pool",
                )
            )
                return null;
            curatePathUsed = true;
            const tool = publishedToolName(body, "ctx_memory");
            if (!tool) return null;
            memoryToolPublished = true;
            guardedWriteAttempted = true;
            trace.push("guarded-write-attempt");
            return {
                content: [
                    {
                        type: "tool_use",
                        id: toolCallId,
                        name: tool,
                        input: {
                            action: "archive",
                            ids: [seed.id],
                            reason: "A47 synthetic lease-loss fixture",
                        },
                    },
                ],
                stop_reason: "tool_use" as const,
                usage: DEFER_USAGE,
            };
        });
        h.mock.setDefault({ text: "curation complete", usage: DEFER_USAGE });

        const runtimeClient: PluginContext["client"] = h.client as never;
        const wrappedClient = {
            session: {
                list: (
                    args: Parameters<typeof runtimeClient.session.list>[0],
                ) => runtimeClient.session.list(args),
                create: (
                    args: Parameters<typeof runtimeClient.session.create>[0],
                ) => runtimeClient.session.create(args),
                prompt: (
                    args: Parameters<typeof runtimeClient.session.prompt>[0],
                ) => runtimeClient.session.prompt(args),
                messages: (
                    args: Parameters<typeof runtimeClient.session.messages>[0],
                ) => runtimeClient.session.messages(args),
                delete: async (
                    args: Parameters<typeof runtimeClient.session.delete>[0],
                ) => {
                    const result = await runtimeClient.session.delete(args);
                    childReleased = true;
                    trace.push("child-release");
                    return result;
                },
            },
        };
        const executor = createDreamTaskExecutor({
            client: wrappedClient as never,
            sessionDirectory: h.opencode.env.workdir,
            openOpenCodeDb: () => null,
            curateLifecycle: {
                beforePrompt: async () => {
                    trace.push("pre-write-barrier");
                    await promptBarrier.signal();
                },
                afterPrompt: (declareLeaseLost) => {
                    const observer = new Database(dbPath, { readonly: true });
                    try {
                        const memory = observer
                            .prepare("SELECT status FROM memories WHERE id = ?")
                            .get(seed.id) as { status: string } | undefined;
                        const mutations = observer
                            .prepare(
                                "SELECT id FROM memory_mutation_log WHERE project_path = ? AND target_memory_id = ? ORDER BY id",
                            )
                            .all(seed.project_path, seed.id) as Array<{
                            id: number;
                        }>;
                        postCommitMemoryStatus = memory?.status ?? "missing";
                        postCommitMutationCount = mutations.length;
                        mutationIdsUnique =
                            new Set(mutations.map((mutation) => mutation.id))
                                .size === mutations.length;
                    } finally {
                        observer.close();
                    }
                    if (
                        postCommitMemoryStatus !== "active" ||
                        postCommitMutationCount !== 0
                    ) {
                        trace.push("mutation-commit");
                    }
                    terminalLeaseLossEvents += 1;
                    trace.push("terminal-lease-loss");
                    declareLeaseLost();
                },
            },
        });
        const config: DreamTaskRuntimeConfig = {
            task: "curate",
            schedule: "0 4 * * 0",
            timeoutMinutes: 2,
            model: "mock-anthropic/mock-sonnet",
        };
        executorPromise = executor(config, {
            db: executorDb,
            projectIdentity: seed.project_path,
            holderId: originalHolder,
            leaseKey,
            leaseAcquisition: acquisition,
        });

        const barrierReached = await Promise.race([
            completionSignal(promptBarrier.arrived, true),
            completionSignal(executorPromise, false),
        ]);
        if (!barrierReached) {
            throw new Error(
                "A47 curate task ended before the pre-write barrier",
            );
        }
        const preWriteBarrierReached = trace.at(-1) === "pre-write-barrier";
        replacementDb
            .prepare("UPDATE dream_state SET value = ? WHERE key = ?")
            .run(String(Date.now() - 1), `lease:${leaseKey}:expiry`);
        const replacement = acquireLeaseWithAcquisition(
            replacementDb,
            replacementHolder,
            leaseKey,
        );
        const replacementOwnershipCommitted = replacement !== null;
        const replacementGeneration = replacement?.generation ?? -1;
        const replacementOwnershipRead = readContextDb(
            h,
            (db) =>
                getLeaseHolder(db, leaseKey) === replacementHolder &&
                getLeaseGeneration(db, leaseKey) === replacementGeneration,
        );
        const fencingIdUnique =
            replacementGeneration > originalGeneration &&
            replacementOwnershipRead;
        if (replacementOwnershipCommitted && replacementOwnershipRead) {
            trace.push("replacement-ownership");
        }
        const mutationAbsentBeforeRelease = readContextDb(h, (db) => {
            const memory = db
                .prepare("SELECT status FROM memories WHERE id = ?")
                .get(seed.id) as { status: string } | undefined;
            const count = db
                .prepare(
                    "SELECT COUNT(*) AS count FROM memory_mutation_log WHERE project_path = ? AND target_memory_id = ?",
                )
                .get(seed.project_path, seed.id) as { count: number };
            return memory?.status === "active" && count.count === 0;
        });
        if (mutationAbsentBeforeRelease) trace.push("mutation-absent");
        barrierReleased = true;
        trace.push("barrier-release");
        promptBarrier.release();

        const taskResult = (await executorPromise) as {
            status?: string;
            error?: string;
        };
        executorJoined = true;
        taskReportedLeaseLoss =
            taskResult.status === "failed" &&
            taskResult.error?.includes("lease lost") === true;
        const archiveResultText = findToolResultText(h, toolCallId);
        // A tool_result block alone proves nothing about WHICH write landed, but
        // requiring SUCCESS conflates the setup with the behavior under test.
        // Once the fence is extended to cover the archive itself, the racing
        // write is correctly rejected and the memory stays active with no
        // mutation row — the resolution this case exists to detect. Demanding
        // "Archived " fails the precondition there, so the durable no-write
        // checks never get to score it. An unrelated failure (validation,
        // registration, an internal error) leaves the same durable shape, so a
        // bare `Error:` cannot stand in: the rejection must identify the lease
        // fence. The attempt itself stays required through
        // `guardedWriteAttempted`, and an absent invocation still fails here.
        const archiveFenceRejected =
            archiveResultText !== null &&
            archiveResultText.startsWith("Error:") &&
            /lease|fenc/i.test(archiveResultText);
        const providerToolResultObserved =
            archiveResultText !== null &&
            (archiveResultText.startsWith("Archived ") || archiveFenceRejected);
        return {
            kind: "a47-lease-loss-residual-write",
            workspaceScoped: caseHarnessIsWorkspaceScoped(h, context),
            namespaceUnique: caseNamespaceIsUnique(context),
            driverCompleted: true,
            curatePathUsed,
            memoryToolPublished,
            providerToolResultObserved,
            originalLeaseAcquired,
            originalOwnershipRead,
            preWriteBarrierReached,
            replacementOwnershipCommitted,
            replacementOwnershipRead,
            fencingIdUnique,
            mutationAbsentBeforeRelease,
            barrierReleased,
            guardedWriteAttempted,
            postCommitMemoryStatus,
            postCommitMutationCount,
            mutationIdsUnique,
            terminalLeaseLossEvents,
            taskReportedLeaseLoss,
            childReleased,
            trace,
        };
    } finally {
        promptBarrier.release();
        if (executorPromise && !executorJoined) {
            // Contain a rejected join: awaiting it bare here would skip the
            // handle and harness cleanup below and replace the original
            // failure with the rejection.
            await executorPromise.catch(() => undefined);
        }
        replacementDb?.close();
        executorDb?.close();
        await h.dispose();
    }
}

const A28_IMPLEMENTATION_FILES = [
    "packages/e2e-tests/src/incident-pool/scenarios/audit-background-lifecycle.ts",
    "packages/plugin/src/hooks/magic-context/compartment-runner-historian.ts",
    "packages/plugin/src/hooks/magic-context/compartment-runner-validation.ts",
    "packages/plugin/src/shared/data-path.ts",
];

// The A47 verdict is read straight off two durable writes — the `memories.status`
// row `archiveMemory` updates and the `memory_mutation_log` row
// `queueMemoryMutation` emits — so both implementations belong in the bundle.
// Without them, editing either durable-write path could change the observed
// residual-write behavior while `implementation_digest` stayed constant.
const A47_IMPLEMENTATION_FILES = [
    "packages/e2e-tests/src/incident-pool/scenarios/audit-background-lifecycle.ts",
    "packages/e2e-tests/src/incident-pool/support/tool-loop.ts",
    "packages/plugin/src/features/magic-context/dreamer/task-executor.ts",
    "packages/plugin/src/features/magic-context/dreamer/lease.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory.ts",
    "packages/plugin/src/features/magic-context/storage-memory-mutation-log.ts",
    "packages/plugin/src/tools/ctx-memory/tools.ts",
];

export function auditBackgroundLifecycleIncidentCases(): RegisteredIncidentCase[] {
    return [
        {
            variantId: "var-a28-historian-dump-containment",
            implementationFiles: A28_IMPLEMENTATION_FILES,
            fixtures: { ...HISTORIAN_FAILURE_DUMP_FIXTURE },
            driver: driveHistorianFailureDump,
            normalizer: normalizeHistorianFailureDump,
            precondition: preconditionHistorianFailureDump,
            verifier: verifyHistorianFailureDump,
            binding: {
                driver: driveHistorianFailureDump,
                verifier: verifyHistorianFailureDump,
            },
        },
        {
            variantId: "var-a47-lease-loss-residual-write",
            implementationFiles: A47_IMPLEMENTATION_FILES,
            fixtures: { ...LEASE_LOSS_RESIDUAL_WRITE_FIXTURE },
            driver: driveLeaseLossResidualWrite,
            normalizer: normalizeLeaseLossResidualWrite,
            precondition: preconditionLeaseLossResidualWrite,
            verifier: verifyLeaseLossResidualWrite,
            binding: {
                driver: driveLeaseLossResidualWrite,
                verifier: verifyLeaseLossResidualWrite,
            },
        },
    ];
}
