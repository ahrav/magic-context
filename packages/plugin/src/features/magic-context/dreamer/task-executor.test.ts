/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createDreamTimerModuleClient } from "../../../plugin/dream-timer-module-client";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { ensureContextStoreUuid } from "../context-authority";
import { insertMemory } from "../memory";
import {
    applyProjectMemoryMapping,
    computeProjectMemoryMutationToken,
} from "../memory/storage-claim-operations";
import { runMigrations } from "../migrations";
import { getClaimMuralCueStates } from "../mural/storage-mural-cues";
import { createClaimMemorySchema } from "../storage-claim-memory-schema";
import { initializeDatabase } from "../storage-db";
import { type SeededProjectMemoryClaim, seedProjectMemoryClaim } from "../test-claim-database";
import {
    getUserMemoryCandidates,
    insertUserMemory,
    insertUserMemoryCandidates,
} from "../user-memory/storage-user-memory";
import { readDreamerProjectClaims } from "./claim-manifest";
import { acquireLease, acquireLeaseWithAcquisition, releaseLease } from "./lease";
import { applyRetrospectiveLearnings } from "./retrospective-learnings";
import { getDreamRuns } from "./storage-dream-runs";
import {
    getTaskScheduleState,
    seedTaskScheduleState,
    writeTaskScheduleState,
} from "./storage-task-schedule";
import { createDreamTaskExecutor } from "./task-executor";
import { leaseKeyFor } from "./task-registry";
import { type DreamTaskRuntimeConfig, runDueTasksForProject } from "./task-scheduler";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    database.transaction(() => createClaimMemorySchema(database)).immediate();
    return database;
}

function mapClaim(database: Database, claim: SeededProjectMemoryClaim, paths: string[]): void {
    const result = applyProjectMemoryMapping(
        database,
        { producer: "task-executor-test", operationKey: `map-${claim.publicClaimId}` },
        {
            token: computeProjectMemoryMutationToken(database, claim.publicClaimId),
            revisionLocator: claim.revisionLocator,
            paths: { state: "known", exact: paths },
        },
    );
    expect(result.outcome).toBe("applied");
}

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

function providerFailureMessages(text: string) {
    return [
        {
            info: {
                role: "assistant",
                time: { created: Date.now() },
                finish: "stop",
                error: null,
                tokens: { output: 8, reasoning: 0 },
            },
            parts: [{ type: "text", text }],
        },
    ];
}

const CURATE_PSEUDO_TOOL_CALL = `归档与全局用户画像完全重复且无项目特化信息的记忆条目。[historical tool call]
id: call_2080315
name: ctx_memory
arguments:
{"action":"archive","reason":"与全局用户画像重复","ids":[6]}`;

describe("createDreamTaskExecutor — curate", () => {
    test("runs whole-pool curation without verification gate or watermark patch", async () => {
        db = freshDb();
        const project = "dir:/repo/project";
        const firstContent = "First memory uses src/first.ts because it is load-bearing.";
        const secondContent = "Second memory is a project workflow rule.";
        const first = seedProjectMemoryClaim(db, {
            projectIdentity: project,
            category: "ARCHITECTURE",
            content: firstContent,
        });
        const second = seedProjectMemoryClaim(db, {
            projectIdentity: project,
            category: "PROJECT_RULES",
            content: secondContent,
        });
        mapClaim(db, first, ["src/first.ts"]);
        insertUserMemory(db, "Prefer concise answers globally.", []);

        let capturedPrompt = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    capturedPrompt = args.body?.parts?.[0]?.text ?? "";
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages(
                        `<curate><keep claim="${first.publicClaimId}"/><keep claim="${second.publicClaimId}"/></curate>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const config: DreamTaskRuntimeConfig = {
            task: "curate",
            schedule: "0 4 * * 0",
            timeoutMinutes: 20,
        };

        const result = await executor(config, {
            db,
            projectIdentity: project,
            holderId: "holder-curate",
            leaseKey: leaseKeyFor("curate", project),
        });

        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
        expect(capturedPrompt).toContain("## Task: Curate Project Memory Pool (hygiene)");
        expect(capturedPrompt).toContain(firstContent);
        expect(capturedPrompt).toContain(secondContent);
        expect(capturedPrompt).toContain(first.revisionLocator);
        expect(capturedPrompt).toContain(first.contentDigest);
        expect(capturedPrompt).toContain("Mapped files: src/first.ts");
        expect(capturedPrompt).toContain("### Global user profile (for the redundancy check)");
        expect(capturedPrompt).toContain("Prefer concise answers globally.");
        expect(capturedPrompt).not.toContain('ctx_memory(action="verified"');
        expect(capturedPrompt).not.toContain("verified_files");
    });

    test("rejects a textual pseudo-tool-call and retries with the fallback model", async () => {
        db = freshDb();
        const project = "dir:/repo/curate-pseudo-tool-call";
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: project,
            category: "PROJECT_RULES",
            content: "Use the shared release checklist before publishing.",
        });

        let promptCalls = 0;
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async () => {
                    promptCalls += 1;
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages(
                        promptCalls === 1
                            ? CURATE_PSEUDO_TOOL_CALL
                            : `<curate><keep claim="${claim.publicClaimId}"/></curate>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        const result = await executor(
            {
                task: "curate",
                schedule: "0 4 * * 0",
                timeoutMinutes: 20,
                fallbackModels: ["fallback/curator"],
            },
            {
                db,
                projectIdentity: project,
                holderId: "holder-curate-pseudo-tool-call",
                leaseKey: leaseKeyFor("curate", project),
            },
        );

        expect(promptCalls).toBe(2);
        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
    });

    test("adds the content language directive to curated prose tasks", async () => {
        db = freshDb();
        const project = "dir:/repo/language-project";
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: project,
            category: "ARCHITECTURE",
            content: "The project stores prompts in src/prompts.ts.",
        });

        let capturedSystem = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async (args: { body?: { system?: string } }) => {
                    capturedSystem = args.body?.system ?? "";
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages(
                        `<curate><keep claim="${claim.publicClaimId}"/></curate>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            language: "tr",
        });

        await executor(
            { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-curate-language",
                leaseKey: leaseKeyFor("curate", project),
            },
        );

        expect(capturedSystem).toContain(
            "Write human-readable prose you author in: Turkish (Türkçe).",
        );
        expect(capturedSystem).toContain("Copy required output schemas exactly");
    });
});

describe("createDreamTaskExecutor — verify-broad disposition", () => {
    test("records cycle progress as a completed run result instead of an error status", async () => {
        db = freshDb();
        const project = "dir:/repo/verify-broad-result";
        seedTaskScheduleState(db, project, "verify-broad", null, null, "0 3 * * 0");
        for (let i = 0; i < 51; i += 1) {
            const claim = seedProjectMemoryClaim(db, {
                projectIdentity: project,
                category: "ARCHITECTURE",
                content: `Mapped broad fact ${i}.`,
            });
            mapClaim(db, claim, ["package.json"]);
        }

        let promptCalls = 0;
        let childCount = 0;
        const manifests = new Map<string, string>();
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: `verify-child-${++childCount}` } })),
                prompt: mock(
                    async (args: {
                        path?: { id?: string };
                        body?: { parts?: Array<{ text?: string }> };
                    }) => {
                        promptCalls += 1;
                        const prompt = args.body?.parts?.[0]?.text ?? "";
                        const ids = [...prompt.matchAll(/^\[(mcm_[^\]]+)\]/gm)].map(
                            (match) => match[1] ?? "",
                        );
                        manifests.set(
                            args.path?.id ?? "",
                            promptCalls > 1
                                ? "<verify>"
                                : `<verify>${ids.map((id) => `<verified claim="${id}" files="package.json"/>`).join("")}</verify>`,
                        );
                        return {};
                    },
                ),
                messages: mock(async (args: { path?: { id?: string } }) => ({
                    data: assistantMessages(
                        manifests.get(args.path?.id ?? "") ?? "<verify></verify>",
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: process.cwd(),
            openOpenCodeDb: () => null,
        });
        const leaseKey = leaseKeyFor("verify-broad", project);
        expect(acquireLease(db, "holder-broad-result", leaseKey)).toBe(true);

        const result = await executor(
            { task: "verify-broad", schedule: "0 3 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-broad-result",
                leaseKey,
            },
        );

        expect(result.status).toBe("completed");
        expect(result.error).toBeUndefined();
        const state = getTaskScheduleState(db, project, "verify-broad");
        expect(state?.lastBroadRunAt).toBeGreaterThan(0);
        const run = getDreamRuns(db, project)[0];
        expect(run?.tasks_failed).toBe(0);
        const task = JSON.parse(run?.tasks_json ?? "[]")[0] as {
            error?: string;
            progress?: string;
            backlog?: { pendingAtStart: number; pendingAtEnd: number; processed: number };
        };
        expect(task.error).toBeUndefined();
        expect(task.progress).toContain("verify-broad cycle");
        expect(task.progress).toContain("remain");
        expect(task.backlog).toMatchObject({ pendingAtStart: 51, pendingAtEnd: 1, processed: 50 });
    });

    test("surfaces provider-outage completions as transient task failures", async () => {
        db = freshDb();
        const project = "dir:/repo/verify-broad-provider-outage";
        seedTaskScheduleState(db, project, "verify-broad", null, null, "0 3 * * 0");
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: project,
            category: "ARCHITECTURE",
            content: "Mapped fact blocked by a provider outage.",
        });
        mapClaim(db, claim, ["src/fact.ts"]);
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "verify-provider-outage" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: providerFailureMessages("All Antigravity endpoints failed"),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const leaseKey = leaseKeyFor("verify-broad", project);
        expect(acquireLease(db, "holder-broad-provider-outage", leaseKey)).toBe(true);

        const result = await executor(
            { task: "verify-broad", schedule: "0 3 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-broad-provider-outage",
                leaseKey,
            },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(result.error).toContain("provider-outage completion");
        expect(result.error).not.toContain("manifest missing");
        expect(getTaskScheduleState(db, project, "verify-broad")?.lastBroadRunAt).toBeGreaterThan(
            0,
        );
        const run = getDreamRuns(db, project)[0];
        expect(run?.tasks_failed).toBe(1);
        const task = JSON.parse(run?.tasks_json ?? "[]")[0] as { error?: string };
        expect(task.error).toContain("provider-outage completion");
    });

    test("keeps a zero-progress broad run failed", async () => {
        db = freshDb();
        const project = "dir:/repo/verify-broad-zero";
        seedTaskScheduleState(db, project, "verify-broad", null, null, "0 3 * * 0");
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: project,
            category: "ARCHITECTURE",
            content: "Mapped fact that cannot be verified yet.",
        });
        mapClaim(db, claim, ["src/fact.ts"]);
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => {
                    throw new Error("provider unavailable");
                }),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const leaseKey = leaseKeyFor("verify-broad", project);
        expect(acquireLease(db, "holder-broad-zero", leaseKey)).toBe(true);

        const result = await executor(
            { task: "verify-broad", schedule: "0 3 * * 0", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-broad-zero",
                leaseKey,
            },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(getTaskScheduleState(db, project, "verify-broad")?.lastBroadRunAt).toBeGreaterThan(
            0,
        );
        expect(getDreamRuns(db, project)[0]?.tasks_failed).toBe(1);
    });
});

describe("createDreamTaskExecutor — review-user-memories", () => {
    test("forwards project identity and commits project promotion through claim operation", async () => {
        db = freshDb();
        const project = "git:user-review-executor";
        db.prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES ('user-review-source', 'opencode', ?, ?)`,
        ).run(project, Date.now());
        insertUserMemoryCandidates(db, [
            {
                content: "This project requires focused tests before commit",
                sessionId: "user-review-source",
            },
        ]);
        const [candidate] = getUserMemoryCandidates(db);
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "user-review-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: assistantMessages(
                        JSON.stringify({
                            promote_project: [
                                {
                                    content: "Run focused tests before commit.",
                                    category: "PROJECT_RULES",
                                    candidate_ids: [candidate.id],
                                },
                            ],
                            consume_candidate_ids: [candidate.id],
                        }),
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: "/repo/user-review-executor",
            openOpenCodeDb: () => null,
        });
        const leaseKey = leaseKeyFor("review-user-memories", project);

        const result = await executor(
            {
                task: "review-user-memories",
                schedule: "0 3 * * *",
                timeoutMinutes: 20,
                promotionThreshold: 1,
            },
            {
                db,
                projectIdentity: project,
                holderId: "holder-user-review",
                leaseKey,
            },
        );

        expect(result).toEqual({ status: "completed" });
        expect(readDreamerProjectClaims(db, project, "hygiene").map((claim) => claim.content)).toEqual([
            "Run focused tests before commit.",
        ]);
        expect(getUserMemoryCandidates(db)).toHaveLength(0);
        expect(
            (
                db.prepare("SELECT COUNT(*) AS count FROM claim_operation_effects").get() as {
                    count: number;
                }
            ).count,
        ).toBe(1);
    });
});

describe("createDreamTaskExecutor — parent session resolution", () => {
    test("concurrent task runs all create children under the resolved parentID (no race-NULL)", async () => {
        db = freshDb();
        const project = "dir:/repo/project";
        for (let i = 0; i < 3; i += 1) {
            insertMemory(db, {
                sourceType: "user",
                projectPath: project,
                category: "ARCHITECTURE",
                content: `Memory ${i} backed by src/file${i}.ts.`,
            });
        }

        // Delay session.list so the resolution await spans both concurrent calls
        // — the exact window the old flag-before-await memo leaked undefined into.
        let listCalls = 0;
        const createParentIds: Array<string | undefined> = [];
        const client = {
            session: {
                list: mock(async () => {
                    listCalls += 1;
                    await new Promise((r) => setTimeout(r, 20));
                    return { data: [{ id: "real-parent-session" }] };
                }),
                create: mock(async (args: { body?: { parentID?: string } }) => {
                    createParentIds.push(args.body?.parentID);
                    return { data: { id: `child-${createParentIds.length}` } };
                }),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: assistantMessages("done") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        // Two DIFFERENT lease domains run concurrently (as the scheduler does via
        // Promise.all): curate (memory domain) + maintain-docs (its own domain).
        const curateKey = leaseKeyFor("curate", project);
        const docsKey = leaseKeyFor("maintain-docs", project);
        expect(acquireLease(db, "h-curate", curateKey)).toBe(true);
        expect(acquireLease(db, "h-docs", docsKey)).toBe(true);
        await Promise.all([
            executor(
                { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
                { db, projectIdentity: project, holderId: "h-curate", leaseKey: curateKey },
            ),
            executor(
                { task: "maintain-docs", schedule: "0 4 * * 0", timeoutMinutes: 20 },
                { db, projectIdentity: project, holderId: "h-docs", leaseKey: docsKey },
            ),
        ]);

        // The list runs once (shared promise), and BOTH children carry the real
        // parent — none created with an undefined parentID.
        expect(listCalls).toBe(1);
        expect(createParentIds.length).toBe(2);
        expect(createParentIds.every((id) => id === "real-parent-session")).toBe(true);
    });
});

describe("createDreamTaskExecutor — lease setup fence", () => {
    test("aborts after a pre-heartbeat TTL stall lets an interloper acquire and release", async () => {
        db = freshDb();
        const project = "dir:/repo/lease-setup-stall";
        const leaseKey = leaseKeyFor("curate", project);
        const realNow = Date.now();
        const clock = { value: realNow };
        const nowSpy = spyOn(Date, "now").mockImplementation(() => clock.value);
        try {
            const acquisition = acquireLeaseWithAcquisition(db, "stalled-holder", leaseKey);
            expect(acquisition).not.toBeNull();
            const create = mock(async () => ({ data: { id: "must-not-create" } }));
            const client = {
                session: {
                    list: mock(async () => {
                        clock.value = realNow + 3 * 60 * 1_000;
                        expect(acquireLease(db as Database, "interloper", leaseKey)).toBe(true);
                        releaseLease(db as Database, "interloper", leaseKey);
                        return { data: [] };
                    }),
                    create,
                },
            };
            const executor = createDreamTaskExecutor({
                client: client as never,
                sessionDirectory: project,
                openOpenCodeDb: () => null,
            });

            let thrown: unknown;
            try {
                await executor(
                    { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
                    {
                        db,
                        projectIdentity: project,
                        holderId: "stalled-holder",
                        leaseKey,
                        leaseAcquisition: acquisition ?? undefined,
                    },
                );
            } catch (error) {
                thrown = error;
            }

            expect(String(thrown)).toContain("lease lost during executor setup");
            expect(create).not.toHaveBeenCalled();
        } finally {
            nowSpy.mockRestore();
        }
    });
});

describe("createDreamTaskExecutor — classify-memories", () => {
    test("runs the non-agentic XML transform and applies the manifest host-side", async () => {
        db = freshDb();
        const project = "dir:/repo/project";
        const claims = Array.from({ length: 12 }, (_, index) =>
            seedProjectMemoryClaim(db as Database, {
                projectIdentity: project,
                category: "ARCHITECTURE",
                content: `Memory ${index}: the transform lives in src/file${index}.ts.`,
            }),
        );

        let capturedPrompt = "";
        let capturedAgent = "";
        // The classifier emits ONE <classify> manifest; the host parses + applies.
        const manifest = `<classify>\n${claims
            .map(
                (claim, index) =>
                    `<memory claim="${claim.publicClaimId}" importance="${40 + (index % 30)}" scope="project" shareable="true"/>`,
            )
            .join("\n")}\n</classify>`;
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(
                    async (args: {
                        body?: { agent?: string; parts?: Array<{ text?: string }> };
                    }) => {
                        capturedPrompt = args.body?.parts?.[0]?.text ?? "";
                        capturedAgent = args.body?.agent ?? "";
                        return {};
                    },
                ),
                messages: mock(async () => ({ data: assistantMessages(manifest) })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        // classify applies the manifest host-side under a lease-guarded
        // transaction, so the holder must actually hold the lease.
        const leaseKey = leaseKeyFor("classify-memories", project);
        expect(acquireLease(db, "holder-classify", leaseKey)).toBe(true);

        const result = await executor(
            { task: "classify-memories", schedule: "0 6 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-classify",
                leaseKey,
            },
        );

        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
        // Zero-tool pure transform agent + the new XML prompt (no ctx_memory call).
        expect(capturedAgent).toBe("dreamer-classifier");
        expect(capturedPrompt).toContain("## Task: Classify Project Memories");
        expect(capturedPrompt).toContain("Emit one <classify> manifest");
        expect(capturedPrompt).not.toContain('ctx_memory(action="classify"');

        const classified = readDreamerProjectClaims(db, project, "hygiene");
        expect(classified).toHaveLength(12);
        expect(
            classified.every((claim) =>
                claim.evidence.independenceKeys.some((key) => key.startsWith("classify-memories:")),
            ),
        ).toBe(true);
        expect(classified.every((claim) => claim.revision === 2)).toBe(true);
    });

    test("provider-outage chunk aborts the run without advancing lastRunAt", async () => {
        db = freshDb();
        const project = "dir:/repo/classify-provider-outage";
        for (let index = 0; index < 201; index += 1) {
            seedProjectMemoryClaim(db, {
                projectIdentity: project,
                category: "ARCHITECTURE",
                content: `Provider outage classification fixture ${index}.`,
            });
        }
        let promptCalls = 0;
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "classify-provider-outage" } })),
                prompt: mock(async () => {
                    promptCalls += 1;
                    return {};
                }),
                messages: mock(async () => ({
                    data: providerFailureMessages("All Antigravity endpoints failed"),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const now = Date.now();
        const task: DreamTaskRuntimeConfig = {
            task: "classify-memories",
            schedule: "0 6 * * *",
            timeoutMinutes: 20,
            fallbackModels: ["provider/fallback-one", "provider/fallback-two"],
        };
        writeTaskScheduleState(db, {
            projectPath: project,
            task: task.task,
            lastRunAt: 1_234,
            nextDueAt: now - 1_000,
            schedule: task.schedule,
            lastStatus: "completed",
            lastError: null,
            retryCount: 0,
        });

        await runDueTasksForProject({
            db,
            projectIdentity: project,
            tasks: [task],
            executor,
            now,
        });

        expect(promptCalls).toBe(3);
        expect(
            readDreamerProjectClaims(db, project, "hygiene").every(
                (claim) =>
                    !claim.evidence.independenceKeys.some((key) =>
                        key.startsWith("classify-memories:"),
                    ),
            ),
        ).toBe(true);
        expect(getTaskScheduleState(db, project, task.task)).toMatchObject({
            lastRunAt: 1_234,
            lastStatus: "failed",
            retryCount: 1,
        });
    });

    test("direct authority.status selects rust MODULE without a prior transform", async () => {
        db = freshDb();
        const project = "dir:/repo/rust-classify";
        ensureContextStoreUuid(db);
        const sensitive = seedProjectMemoryClaim(db, {
            projectIdentity: project,
            category: "PROJECT_RULES",
            content: "Use token sk-test-secret only on my localhost machine.",
        });
        const claims = [sensitive];
        for (let i = 0; i < 11; i += 1) {
            claims.push(
                seedProjectMemoryClaim(db, {
                    projectIdentity: project,
                    category: "ARCHITECTURE",
                    content: `The cache-neutral classification path is module-owned (${i}).`,
                }),
            );
        }
        const moduleCalls: Array<{ method: string; body: unknown }> = [];
        let authorityStatusCalls = 0;
        const client = {
            session: {
                list: mock(async () => ({ data: [{ id: "parent" }] })),
                create: mock(async () => ({ data: { id: "must-not-create" } })),
                delete: mock(async () => ({})),
            },
        };
        // This must be a class-backed fake: object-literal mocks cannot expose a detached-method
        // regression because they do not need instance state through the timer adapter.
        class StatefulTimerModuleClient {
            private readonly instanceState = "timer-transport";

            async authorityStatus() {
                authorityStatusCalls += 1;
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                return { authority: { state: "MODULE", generation: 3 } };
            }

            async call(args: { method: string; body: unknown }) {
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                moduleCalls.push(args);
                if (args.method !== "dreamer.run_task") throw new Error("unexpected module call");
                const body = args.body as {
                    payload: {
                        items: Array<{
                            public_claim_id: string;
                            revision_locator: string;
                            content_digest: string;
                            mutation_token: { publicClaimId: string };
                        }>;
                    };
                };
                return {
                    ok: true,
                    manifest_text: `<classify>${body.payload.items
                        .map(
                            (item) =>
                                `<memory claim="${item.public_claim_id}" importance="80" scope="project" shareable="true"/>`,
                        )
                        .join("")}</classify>`,
                    truncated: false,
                };
            }
        }
        const moduleClient = createDreamTimerModuleClient(new StatefulTimerModuleClient() as never);
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            moduleClient: moduleClient as never,
        });
        const leaseKey = leaseKeyFor("classify-memories", project);
        expect(acquireLease(db, "holder-rust-classify", leaseKey)).toBe(true);
        const result = await executor(
            {
                task: "classify-memories",
                schedule: "0 6 * * *",
                timeoutMinutes: 20,
                model: "test/classify-model",
            },
            { db, projectIdentity: project, holderId: "holder-rust-classify", leaseKey },
        );
        expect(result.status).toBe("completed");
        expect(authorityStatusCalls).toBe(1);
        expect(client.session.create).not.toHaveBeenCalled();
        expect(moduleCalls.map((call) => call.method)).toEqual(["dreamer.run_task"]);
        const producerBody = moduleCalls[0]?.body as {
            payload: {
                items: Array<{
                    public_claim_id: string;
                    revision_locator: string;
                    content_digest: string;
                    mutation_token: { publicClaimId: string };
                }>;
            };
        };
        expect(producerBody.payload.items).toHaveLength(12);
        expect(
            producerBody.payload.items.every(
                (item) =>
                    item.revision_locator.length > 0 &&
                    item.content_digest.length > 0 &&
                    item.mutation_token.publicClaimId === item.public_claim_id,
            ),
        ).toBe(true);
        expect(
            readDreamerProjectClaims(db, project, "hygiene").find(
                (claim) => claim.publicClaimId === sensitive.publicClaimId,
            )?.sharing,
        ).toBe("private");
    });
    test("module failures are transient and never fall back to a TypeScript child", async () => {
        db = freshDb();
        const project = "dir:/repo/rust-classify-failure";
        ensureContextStoreUuid(db);
        for (let i = 0; i < 12; i += 1) {
            seedProjectMemoryClaim(db, {
                projectIdentity: project,
                category: "ARCHITECTURE",
                content: `Module classification failure fixture ${i}.`,
            });
        }

        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "must-not-create" } })),
                delete: mock(async () => ({})),
            },
        };
        const moduleCalls: string[] = [];
        class FailingTimerModuleClient {
            private readonly instanceState = "timer-transport";

            async authorityStatus() {
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                return { authority: { state: "MODULE", generation: 9 } };
            }

            async call(args: { method: string }) {
                if (this.instanceState !== "timer-transport")
                    throw new Error("lost transport this");
                moduleCalls.push(args.method);
                throw new Error("module transport unavailable");
            }
        }
        const moduleClient = createDreamTimerModuleClient(new FailingTimerModuleClient() as never);
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            moduleClient: moduleClient as never,
        });
        const leaseKey = leaseKeyFor("classify-memories", project);
        expect(acquireLease(db, "holder-rust-classify-failure", leaseKey)).toBe(true);

        const result = await executor(
            {
                task: "classify-memories",
                schedule: "0 6 * * *",
                timeoutMinutes: 20,
                model: "test/classify-model",
            },
            {
                db,
                projectIdentity: project,
                holderId: "holder-rust-classify-failure",
                leaseKey,
            },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(result.error).toContain("Rust dreamer classify module failed");
        expect(client.session.create).not.toHaveBeenCalled();
        expect(moduleCalls).toEqual(["dreamer.run_task"]);
    });
});

describe("createDreamTaskExecutor — compress-cues", () => {
    test("rust-authority fixture writes claim cues locally without a module facade call", async () => {
        db = freshDb();
        const project = "dir:/repo/module-cues";
        ensureContextStoreUuid(db);
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: project,
            content: "A cue candidate compressed under module authority.",
            category: "ARCHITECTURE",
        });
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "cue-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: assistantMessages(
                        `<cues><cue id="${claim.publicClaimId}">module cue</cue></cues>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const authorityStatus = mock(async () => ({
            authority: { state: "MODULE", generation: 12 },
        }));
        const moduleCall = mock(async () => {
            throw new Error("claim cues are context-owned; no facade call may run");
        });
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            mural: { enabled: true },
            moduleClient: { authorityStatus, call: moduleCall } as never,
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-module-cues", leaseKey)).toBe(true);

        const result = await executor(
            { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-module-cues", leaseKey },
        );

        expect(result).toEqual({ status: "completed" });
        expect(client.session.create).toHaveBeenCalledTimes(1);
        expect(client.session.prompt).toHaveBeenCalledTimes(1);
        expect(moduleCall).not.toHaveBeenCalled();
        const state = getClaimMuralCueStates(db, [claim.publicClaimId]).get(claim.publicClaimId);
        expect(state?.cue).toBe("module cue");
        expect(state?.revisionLocator).toBe(claim.revisionLocator);
    });

    test("defers cue mutation while Rust authority is draining", async () => {
        db = freshDb();
        const project = "dir:/repo/draining-cues";
        ensureContextStoreUuid(db);
        const memory = insertMemory(db, {
            sourceType: "user",
            projectPath: project,
            category: "ARCHITECTURE",
            content: "A cue candidate must wait for module drain replay.",
        });
        const create = mock(async () => ({ data: { id: "must-not-create" } }));
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create,
            },
        };
        const authorityStatus = mock(async () => ({
            authority: { state: "DRAINING", generation: 12 },
        }));
        const moduleCall = mock(async () => ({ accepted: [], rejected: [] }));
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            mural: { enabled: true },
            moduleClient: { authorityStatus, call: moduleCall } as never,
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-draining-cues", leaseKey)).toBe(true);

        let thrown: unknown;
        try {
            await executor(
                { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
                { db, projectIdentity: project, holderId: "holder-draining-cues", leaseKey },
            );
        } catch (error) {
            thrown = error;
        }

        expect(String(thrown)).toContain("dreamer mutation deferred");
        expect(create).not.toHaveBeenCalled();
        expect(moduleCall).not.toHaveBeenCalled();
        expect(db.prepare("SELECT mural_cue FROM memories WHERE id = ?").get(memory.id)).toEqual({
            mural_cue: null,
        });
    });

    test("reports a structural membership failure as transient", async () => {
        db = freshDb();
        const project = "dir:/repo/malformed-cues";
        seedProjectMemoryClaim(db, {
            projectIdentity: project,
            content: "A cue candidate omitted by the manifest.",
            category: "ARCHITECTURE",
        });
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "cue-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: assistantMessages("<cues></cues>") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            mural: { enabled: true },
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-malformed-cues", leaseKey)).toBe(true);

        const result = await executor(
            { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-malformed-cues", leaseKey },
        );

        expect(result.status).toBe("failed");
        expect(result.transient).toBe(true);
        expect(result.error).toContain("1 remain (was 1 at run start; processed 0 this run)");
        expect(client.session.prompt).toHaveBeenCalledTimes(1);
    });

    test("reports a fully drained cue set as completed", async () => {
        db = freshDb();
        const project = "dir:/repo/complete-cues";
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: project,
            content: "A cue candidate completed by the manifest.",
            category: "ARCHITECTURE",
        });
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "cue-child" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: assistantMessages(
                        `<cues><cue id="${claim.publicClaimId}">completed anchor</cue></cues>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            mural: { enabled: true },
        });
        const leaseKey = leaseKeyFor("compress-cues", project);
        expect(acquireLease(db, "holder-complete-cues", leaseKey)).toBe(true);

        const result = await executor(
            { task: "compress-cues", schedule: "0 7 * * *", timeoutMinutes: 20 },
            { db, projectIdentity: project, holderId: "holder-complete-cues", leaseKey },
        );

        expect(result).toEqual({ status: "completed" });
    });
});

describe("createDreamTaskExecutor — retrospective", () => {
    test("retrospective memory insert writes direct claim state atomically", () => {
        db = freshDb();
        const project = "dir:/repo/project";
        const content =
            "Verify provider-executed tool availability before describing it as supported.";

        const applied = db
            .transaction(() =>
                applyRetrospectiveLearnings({
                    db: db as Database,
                    projectIdentity: project,
                    sourceSessionId: "s1",
                    learnings: [{ route: "memory", category: "PROJECT_RULES", content }],
                    identity: {
                        producer: "dreamer-retrospective",
                        task: "retrospective",
                        runId: "retro-direct-run",
                        leaseKey: leaseKeyFor("retrospective", project),
                        leaseGeneration: 1,
                        batchId: "retro-direct-window",
                    },
                    userMemoryCollectionEnabled: false,
                    sourceUserTexts: [],
                }),
            )
            .immediate();

        expect(applied.memoryWritten).toBe(1);
        expect(
            readDreamerProjectClaims(db, project, "hygiene").map((claim) => claim.content),
        ).toEqual([content]);
    });

    test("gate returns 'n' → one gate turn, child created+deleted, watermark advances, no deepen", async () => {
        db = freshDb();
        const project = "dir:/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please add a focused migration test for the new config key.",
                        ts: 200,
                    },
                ],
                truncated: false,
            })),
            readUserMessagesBefore: mock(() => []),
        };
        let prompts = 0;
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(async () => {
                    prompts += 1;
                    return {};
                }),
                // Gate turn → verdict "n" (no friction). The deepen turn never runs.
                messages: mock(async () => ({ data: assistantMessages("n") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: true,
        });

        const result = await executor(
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-clean",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        // Completed with the content watermark advanced to the max ts scanned.
        expect(result).toEqual({
            status: "completed",
            schedulePatch: { retrospectiveWatermarkMs: 200 },
        });
        expect(client.session.create).toHaveBeenCalled();
        expect(prompts).toBe(1); // gate only — no deepen turn
        expect(client.session.delete).toHaveBeenCalled(); // child always cleaned up
        expect(readDreamerProjectClaims(db, project, "hygiene")).toHaveLength(0);
    });

    test("signal deepens, parses XML, host-applies memory and gated observation", async () => {
        db = freshDb();
        const project = "dir:/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please verify provider-executed tools on the wire before saying they work.",
                        ts: 200,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 2,
                        role: "assistant" as const,
                        text: "It should work.",
                        ts: 210,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 3,
                        role: "user" as const,
                        text: "Please verify provider executed tools on wire before saying they work.",
                        ts: 220,
                    },
                ],
                truncated: false,
            })),
        };
        provider.readUserMessagesBefore = mock(() => []);
        // The two turns share one `messages` mock — drive the response off the
        // per-prompt system string the runner sets: gate system → "y: <ord>",
        // deepen system → the learnings XML.
        const captured: Array<{ agent: string; system: string; prompt: string }> = [];
        let lastSystem = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(
                    async (args: {
                        body?: {
                            agent?: string;
                            system?: string;
                            parts?: Array<{ text?: string }>;
                        };
                    }) => {
                        lastSystem = args.body?.system ?? "";
                        captured.push({
                            agent: args.body?.agent ?? "",
                            system: lastSystem,
                            prompt: args.body?.parts?.[0]?.text ?? "",
                        });
                        return {};
                    },
                ),
                messages: mock(async () => {
                    const isGate = lastSystem.includes("friction detector");
                    return {
                        data: assistantMessages(
                            isGate
                                ? "y: 3"
                                : `<learnings>
  <learning route="memory" category="PROJECT_RULES">Verify provider-executed tool availability on wire before describing it as supported.</learning>
  <learning route="observation">Prefers concise root-cause summaries before implementation details.</learning>
  <learning route="memory" category="PROJECT_RULES">On 2026-06-01 the user said &quot;wrong again&quot;.</learning>
</learnings>`,
                        ),
                    };
                }),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: true,
        });

        const result = await executor(
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-hit",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        expect(result).toEqual({
            status: "completed",
            schedulePatch: { retrospectiveWatermarkMs: 220 },
        });
        // Two turns: gate (friction-detector system) then deepen (learning system).
        expect(captured).toHaveLength(2);
        expect(captured[0]?.system).toContain("friction detector");
        expect(captured[1]?.agent).toBe("dreamer-retrospective");
        expect(captured[1]?.system).toContain("retrospective learning agent");
        expect(captured[1]?.prompt).toContain("### Friction window");
        expect(captured[1]?.prompt).not.toContain("ctx_memory");
        const claims = readDreamerProjectClaims(db, project, "hygiene");
        expect(claims.map((claim) => claim.content)).toEqual([
            "Verify provider-executed tool availability on wire before describing it as supported.",
        ]);
        expect(
            claims[0]?.evidence.independenceKeys.some((key) => key.startsWith("retrospective:")),
        ).toBe(true);
        expect(getUserMemoryCandidates(db).map((candidate) => candidate.content)).toEqual([
            "Prefers concise root-cause summaries before implementation details.",
        ]);
    });

    test("drops observation learnings when user-memory collection is disabled", async () => {
        db = freshDb();
        const project = "dir:/repo/project";
        const provider = {
            listProjectSessions: mock(() => [{ sessionId: "s1" }]),
            readUserMessagesSince: mock(() => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 1,
                        role: "user" as const,
                        text: "Please stop assuming CLI commands work without checking the actual output.",
                        ts: 200,
                    },
                    {
                        sessionId: "s1",
                        ordinal: 2,
                        role: "user" as const,
                        text: "Please stop assuming CLI commands work without checking actual output.",
                        ts: 220,
                    },
                ],
                truncated: false,
            })),
            readUserMessagesBefore: mock(() => []),
        };
        let lastSystem = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "retro-child" } })),
                prompt: mock(async (args: { body?: { system?: string } }) => {
                    lastSystem = args.body?.system ?? "";
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages(
                        lastSystem.includes("friction detector")
                            ? "y: 2"
                            : `<learnings>
  <learning route="observation">Prefers tool claims backed by observed command output.</learning>
</learnings>`,
                    ),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            userMemoryCollectionEnabled: false,
        });

        await executor(
            { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-retro-observation-off",
                leaseKey: leaseKeyFor("retrospective", project),
            },
        );

        expect(getUserMemoryCandidates(db)).toEqual([]);
    });
});
