/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    getProjectEmbeddings,
    insertMemory,
    loadAllEmbeddings,
    peekProjectEmbeddings,
    resetEmbeddingCacheForTests,
    saveEmbedding,
} from "../memory";
import { getMemoryById } from "../memory/storage-memory";
import { getCurrentMemoryClaimByLegacyMemoryId } from "../memory/storage-memory-claims";
import {
    getMemoryVerifications,
    recordMemoryVerifications,
} from "../memory/storage-memory-verifications";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { acquireLease } from "./lease";
import { DreamerProviderOutputFailureError } from "./provider-output-failure";
import { getTaskScheduleState, seedTaskScheduleState } from "./storage-task-schedule";
import { applyVerifyManifest, runVerify, type VerifyArgs } from "./verify";

const tempDirs: string[] = [];

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function tempProject(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-verify-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "old.ts"), "export const oldValue = 1;", "utf8");
    writeFileSync(path.join(dir, "src", "new.ts"), "export const newValue = 2;", "utf8");
    return dir;
}

function verifyArgs(db: Database, sessionDirectory: string, projectIdentity: string): VerifyArgs {
    const holderId = "verify-holder";
    const leaseKey = `verify-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: undefined,
        sessionDirectory,
        holderId,
        leaseKey,
        deadline: Date.now() + 60_000,
    };
}

afterEach(() => {
    resetEmbeddingCacheForTests();
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

function tokenizedAssistantMessages(
    text: string,
    created: number,
    tokens: { output: number; reasoning: number },
) {
    return [
        {
            info: {
                role: "assistant",
                time: { created },
                finish: "stop",
                error: null,
                tokens,
            },
            parts: [{ type: "text", text }],
        },
    ];
}

type ScriptedVerifyResponse = { kind: "manifest" } | { kind: "provider-failure"; text: string };

function scriptedVerifyClient(responseFor: (promptCall: number) => ScriptedVerifyResponse): {
    client: unknown;
    promptCalls: () => number;
} {
    let promptCalls = 0;
    let childCount = 0;
    const messages = new Map<string, unknown[]>();
    return {
        client: {
            session: {
                create: async () => ({ data: { id: `verify-child-${++childCount}` } }),
                prompt: async (args: {
                    path?: { id?: string };
                    body?: { parts?: Array<{ text?: string }> };
                }) => {
                    promptCalls += 1;
                    const prompt = args.body?.parts?.[0]?.text ?? "";
                    const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) =>
                        Number(match[1]),
                    );
                    const response = responseFor(promptCalls);
                    const text =
                        response.kind === "manifest"
                            ? `<verify>${ids.map((id) => `<verified id="${id}"/>`).join("")}</verify>`
                            : response.text;
                    messages.set(
                        args.path?.id ?? "",
                        tokenizedAssistantMessages(
                            text,
                            promptCalls,
                            response.kind === "manifest"
                                ? { output: Math.max(40, ids.length * 4), reasoning: 100 }
                                : { output: 8, reasoning: 0 },
                        ),
                    );
                    return {};
                },
                messages: async (args: { path?: { id?: string } }) => ({
                    data: messages.get(args.path?.id ?? "") ?? [],
                }),
                delete: async () => ({}),
            },
        },
        promptCalls: () => promptCalls,
    };
}

function successfulVerifyClient(onPrompt?: () => void) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "verify-child" } }),
            prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                // Omit files from the synthetic manifest to avoid filesystem/Git
                // normalization; mappings recorded before the run still select each batch.
                manifest = `<verify>${ids.map((id) => `<verified id="${id}"/>`).join("")}</verify>`;
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

function addMappedMemories(db: Database, projectIdentity: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
        const memory = insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: `Mapped fact ${index}.`,
            sourceSessionId: "ses",
        });
        recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1_000);
    }
}

describe("runVerify disposition", () => {
    test("banks a completed batch and reports the deadline remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-deadline";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 51);
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = successfulVerifyClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const result = await runVerify(args);

            expect(result.verified).toBe(50);
            expect(result.remaining).toBe(1);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports complete after fully draining the selected set", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-complete";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 1);
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = successfulVerifyClient() as never;

            const result = await runVerify(args);
            expect(result.verified).toBe(1);
            expect(result.remaining).toBe(0);
            expect(result.complete).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("continues a broad cycle across deadlines and closes it on the final run", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-broad-cycle";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 51);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = successfulVerifyClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const first = await runVerify(args);
            expect(first.verified).toBe(50);
            expect(first.remaining).toBe(1);
            expect(first.complete).toBe(false);
            const cycleStart = getTaskScheduleState(
                db,
                projectIdentity,
                "verify-broad",
            )?.lastBroadRunAt;
            expect(cycleStart).toBeGreaterThan(0);

            args.deadline = Date.now() + 60_000;
            args.client = successfulVerifyClient() as never;
            const second = await runVerify(args);
            expect(second.verified).toBe(1);
            expect(second.remaining).toBe(0);
            expect(second.complete).toBe(true);
            expect(
                getTaskScheduleState(db, projectIdentity, "verify-broad")?.lastBroadRunAt,
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("classifies outage text before manifest parsing and retries every fallback model", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-provider-outage";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 1);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");
            const scripted = scriptedVerifyClient(() => ({
                kind: "provider-failure",
                text: "All Antigravity endpoints failed",
            }));
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.model = "antigravity/primary";
            args.fallbackModels = ["antigravity/fallback-a", "antigravity/fallback-b"];
            args.client = scripted.client as never;

            let failure: unknown;
            try {
                await runVerify(args);
            } catch (error) {
                failure = error;
            }

            expect(failure).toBeInstanceOf(DreamerProviderOutputFailureError);
            expect(String(failure)).toContain("provider-outage completion");
            expect(String(failure)).not.toContain("manifest missing");
            expect(scripted.promptCalls()).toBe(3);
            expect(
                getTaskScheduleState(db, projectIdentity, "verify-broad")?.lastBroadRunAt,
            ).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("aborts after two identical provider-failure batches", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-provider-circuit";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 101);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");
            const scripted = scriptedVerifyClient(() => ({
                kind: "provider-failure",
                text: "All Antigravity endpoints failed",
            }));
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = scripted.client as never;

            await expect(runVerify(args)).rejects.toBeInstanceOf(DreamerProviderOutputFailureError);
            expect(scripted.promptCalls()).toBe(2);
        } finally {
            closeQuietly(db);
        }
    });

    test("banks completed batches before an outage and resumes the open broad cycle", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-provider-resume";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 51);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");
            const scripted = scriptedVerifyClient((promptCall) =>
                promptCall === 1
                    ? { kind: "manifest" }
                    : {
                          kind: "provider-failure",
                          text: "All Antigravity endpoints failed",
                      },
            );
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = scripted.client as never;

            await expect(runVerify(args)).rejects.toBeInstanceOf(DreamerProviderOutputFailureError);
            expect(scripted.promptCalls()).toBe(2);
            const cycleStart = getTaskScheduleState(
                db,
                projectIdentity,
                "verify-broad",
            )?.lastBroadRunAt;
            expect(cycleStart).toBeGreaterThan(0);

            args.client = successfulVerifyClient() as never;
            args.deadline = Date.now() + 60_000;
            const resumed = await runVerify(args);
            expect(resumed.inScope).toBe(1);
            expect(resumed.verified).toBe(1);
            expect(resumed.remaining).toBe(0);
            expect(resumed.complete).toBe(true);
            expect(
                getTaskScheduleState(db, projectIdentity, "verify-broad")?.lastBroadRunAt,
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("reports a swallowed batch failure as incomplete", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:verify-failure";
            const dir = tempProject();
            addMappedMemories(db, projectIdentity, 1);
            seedTaskScheduleState(db, projectIdentity, "verify-broad", null, null, "0 3 * * 0");
            const args = verifyArgs(db, dir, projectIdentity);
            args.forceBroad = true;
            args.client = {
                session: {
                    create: async () => {
                        throw new Error("provider unavailable");
                    },
                },
            } as never;

            const result = await runVerify(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(1);
            expect(
                getTaskScheduleState(db, projectIdentity, "verify-broad")?.lastBroadRunAt,
            ).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("applyVerifyManifest", () => {
    test("content rewrites clear stale file mappings and embedding cache", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Old value lives in src/old.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);
            saveEmbedding(db, memory.id, new Float32Array([1, 2, 3, 4]), "model-a");
            expect(getProjectEmbeddings(db, projectIdentity, "model-a").has(memory.id)).toBe(true);

            const result = await applyVerifyManifest(
                verifyArgs(db, dir, projectIdentity),
                [
                    {
                        id: memory.id,
                        category: memory.category,
                        content: memory.content,
                        mappedFiles: ["src/old.ts"],
                    },
                ],
                `<verify><update id="${memory.id}" files="src/new.ts">New value lives in src/new.ts.</update></verify>`,
            );

            expect(result).toEqual({ verified: 0, updated: 1, archived: 0 });
            expect(getMemoryById(db, memory.id)?.content).toBe("New value lives in src/new.ts.");
            expect(getMemoryVerifications(db, [memory.id]).has(memory.id)).toBe(false);
            expect(loadAllEmbeddings(db, projectIdentity, "model-a").has(memory.id)).toBe(false);
            expect(peekProjectEmbeddings(projectIdentity, "model-a")?.has(memory.id)).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects conflicting terminal verdicts for the same memory id", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Old value lives in src/old.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);

            await expect(
                applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            mappedFiles: ["src/old.ts"],
                        },
                    ],
                    `<verify><verified id="${memory.id}" files="src/old.ts"/><archive id="${memory.id}" reason="stale"/></verify>`,
                ),
            ).rejects.toThrow(/duplicate id/);

            expect(getMemoryById(db, memory.id)?.status).toBe("active");
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/old.ts"]);
            expect(state?.verifiedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects a truncated manifest before any DB write", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Old value lives in src/old.ts.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, ["src/old.ts"], 1_000);

            await expect(
                applyVerifyManifest(
                    verifyArgs(db, dir, projectIdentity),
                    [
                        {
                            id: memory.id,
                            category: memory.category,
                            content: memory.content,
                            mappedFiles: ["src/old.ts"],
                        },
                    ],
                    `<verify><archive id="${memory.id}" reason="stale"/>`,
                ),
            ).rejects.toThrow(/closing root/);

            expect(getMemoryById(db, memory.id)?.status).toBe("active");
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/old.ts"]);
            expect(state?.verifiedAt).toBe(1_000);
        } finally {
            closeQuietly(db);
        }
    });

    test("verify, update, and archive outcomes commit the matching claim state (U3/KTD5)", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const seed = (content: string) =>
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content,
                    sourceSessionId: "ses",
                });
            const verifiedMemory = seed("Verified fact lives in src/old.ts.");
            const updatedMemory = seed("Old value lives in src/old.ts.");
            const archivedMemory = seed("Removed thing lived in src/old.ts.");
            const items = [verifiedMemory, updatedMemory, archivedMemory].map((memory) => ({
                id: memory.id,
                category: memory.category,
                content: memory.content,
                mappedFiles: ["src/old.ts"],
            }));

            const result = await applyVerifyManifest(
                verifyArgs(db, dir, projectIdentity),
                items,
                `<verify>` +
                    `<verified id="${verifiedMemory.id}" files="src/old.ts"/>` +
                    `<update id="${updatedMemory.id}" files="src/new.ts">New value lives in src/new.ts.</update>` +
                    `<archive id="${archivedMemory.id}" reason="stale"/>` +
                    `</verify>`,
            );
            expect(result).toEqual({ verified: 1, updated: 1, archived: 1 });

            const eventOutcomes = (memoryId: number): string[] => {
                const claim = getCurrentMemoryClaimByLegacyMemoryId(db, memoryId);
                if (!claim) return [];
                return (
                    db
                        .prepare(
                            `SELECT ve.outcome AS outcome FROM verification_events ve
                               JOIN claim_revisions rev ON rev.id = ve.revision_id
                              WHERE rev.claim_id = ? ORDER BY ve.id`,
                        )
                        .all(claim.claimId) as Array<{ outcome: string }>
                ).map((row) => row.outcome);
            };

            const verifiedClaim = getCurrentMemoryClaimByLegacyMemoryId(db, verifiedMemory.id);
            expect(verifiedClaim?.state).toBe("active");
            expect(verifiedClaim?.revision).toBe(1);
            expect(eventOutcomes(verifiedMemory.id)).toEqual(["verified"]);

            const updatedClaim = getCurrentMemoryClaimByLegacyMemoryId(db, updatedMemory.id);
            expect(updatedClaim?.revision).toBe(2);
            expect(updatedClaim?.content).toBe("New value lives in src/new.ts.");
            expect(eventOutcomes(updatedMemory.id)).toEqual([]);

            const archivedClaim = getCurrentMemoryClaimByLegacyMemoryId(db, archivedMemory.id);
            expect(archivedClaim?.state).toBe("archived");
            expect(eventOutcomes(archivedMemory.id)).toEqual(["archive"]);
            expect(getMemoryById(db, archivedMemory.id)?.status).toBe("archived");
        } finally {
            closeQuietly(db);
        }
    });

    test("one manifest transaction shares a single claim generation across items (KTD7)", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const dir = tempProject();
            const seed = (content: string) =>
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content,
                    sourceSessionId: "ses",
                });
            const verifiedMemory = seed("Verified fact lives in src/old.ts.");
            const updatedMemory = seed("Old value lives in src/old.ts.");
            const archivedMemory = seed("Removed thing lived in src/old.ts.");
            const items = [verifiedMemory, updatedMemory, archivedMemory].map((memory) => ({
                id: memory.id,
                category: memory.category,
                content: memory.content,
                mappedFiles: ["src/old.ts"],
            }));
            const generationBefore = (
                db
                    .prepare(
                        "SELECT COALESCE(MAX(generation), 0) AS generation FROM claim_project_generations",
                    )
                    .get() as { generation: number }
            ).generation;

            const result = await applyVerifyManifest(
                verifyArgs(db, dir, projectIdentity),
                items,
                `<verify>` +
                    `<verified id="${verifiedMemory.id}" files="src/old.ts"/>` +
                    `<update id="${updatedMemory.id}" files="src/new.ts">New value lives in src/new.ts.</update>` +
                    `<archive id="${archivedMemory.id}" reason="stale"/>` +
                    `</verify>`,
            );
            expect(result).toEqual({ verified: 1, updated: 1, archived: 1 });

            // All three items commit inside one lease-guarded transaction, so
            // the project generation advances by exactly one.
            const generationAfter = (
                db
                    .prepare(
                        "SELECT COALESCE(MAX(generation), 0) AS generation FROM claim_project_generations",
                    )
                    .get() as { generation: number }
            ).generation;
            expect(generationAfter).toBe(generationBefore + 1);
        } finally {
            closeQuietly(db);
        }
    });
});
