import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../storage";
import { getProjectState } from "../storage-project-state";
import {
    applyMemoryMigration,
    buildMemoryMigrationPrompt,
    isMemoryMigrationDone,
    markMemoryMigrationDone,
    parseMemoryMigrationOutput,
} from "./memory-migration";
import {
    getAllActiveMemoriesForMigration,
    getMemoriesByProject,
    insertMemory,
} from "./storage-memory";
import { getCurrentMemoryClaimByLegacyMemoryId } from "./storage-memory-claims";
import { recordMemoryMapping } from "./storage-memory-verifications";
import type { Memory } from "./types";

let prevDataHome: string | undefined;
let tempHome: string;

beforeEach(() => {
    prevDataHome = process.env.XDG_DATA_HOME;
    tempHome = mkdtempSync(join(tmpdir(), "mc-memmig-"));
    process.env.XDG_DATA_HOME = tempHome;
    mkdirSync(join(tempHome, "cortexkit", "magic-context"), { recursive: true });
    closeDatabase();
});

afterEach(() => {
    closeDatabase();
    if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevDataHome;
    rmSync(tempHome, { recursive: true, force: true });
});

function fakeMemory(category: string, content: string): Memory {
    return {
        id: 0,
        projectPath: "p",
        category: category as Memory["category"],
        content,
        sourceType: "historian",
        status: "active",
    } as Memory;
}

function openTestDb() {
    const db = openDatabase();
    if (!db) throw new Error("openDatabase returned null in test setup");
    return db;
}

describe("memory migration (E3.2)", () => {
    describe("buildMemoryMigrationPrompt", () => {
        it("lists every existing memory with its legacy category and the 5 target categories", () => {
            const prompt = buildMemoryMigrationPrompt([
                fakeMemory("ARCHITECTURE_DECISIONS", "uses SQLite"),
                fakeMemory("USER_DIRECTIVES", "always run release.sh"),
            ]);
            expect(prompt).toContain("[ARCHITECTURE_DECISIONS] uses SQLite");
            expect(prompt).toContain("[USER_DIRECTIVES] always run release.sh");
            for (const cat of [
                "PROJECT_RULES",
                "ARCHITECTURE",
                "CONSTRAINTS",
                "CONFIG_VALUES",
                "NAMING",
            ]) {
                expect(prompt).toContain(cat);
            }
            // USER traits must be routed out, not kept in project memory.
            expect(prompt).toContain("<user_observations>");
        });
    });

    describe("parseMemoryMigrationOutput", () => {
        it("extracts 5-cat memories and user observations, ignoring unknown categories", () => {
            const out = `Some preamble.
<migrated>
<ARCHITECTURE>
* SSE client owns reconnection.
</ARCHITECTURE>
<CONFIG_VALUES>
* reconnect cap: 8 attempts.
</CONFIG_VALUES>
<USER_DIRECTIVES>
* this should be ignored (not a v2 category)
</USER_DIRECTIVES>
</migrated>
<user_observations>
* User prefers terse communication.
</user_observations>`;
            const result = parseMemoryMigrationOutput(out);
            expect(result.memories).toHaveLength(2);
            expect(result.memories.find((m) => m.category === "ARCHITECTURE")?.content).toBe(
                "SSE client owns reconnection.",
            );
            expect(result.memories.find((m) => m.category === "CONFIG_VALUES")?.content).toBe(
                "reconnect cap: 8 attempts.",
            );
            // Unknown legacy category inside <migrated> is ignored (not a v2 cat).
            expect(result.memories.some((m) => m.content.includes("ignored"))).toBe(false);
            expect(result.userObservations).toEqual(["User prefers terse communication."]);
        });

        it("returns empty result when no <migrated> block present", () => {
            const result = parseMemoryMigrationOutput("no xml here");
            expect(result.memories).toHaveLength(0);
            expect(result.userObservations).toHaveLength(0);
        });
    });

    describe("applyMemoryMigration", () => {
        it("replaces the project's memories with the re-categorized set", () => {
            const db = openTestDb();
            const projectPath = "git:testproject";
            // Seed legacy memories.
            insertMemory(db, { projectPath, category: "ARCHITECTURE_DECISIONS", content: "old A" });
            insertMemory(db, { projectPath, category: "KNOWN_ISSUES", content: "old issue" });
            insertMemory(db, {
                projectPath,
                category: "USER_DIRECTIVES",
                content: "old directive",
            });
            expect(getMemoriesByProject(db, projectPath)).toHaveLength(3);

            const counts = applyMemoryMigration(db, projectPath, {
                memories: [
                    { category: "ARCHITECTURE", content: "new A" },
                    { category: "CONSTRAINTS", content: "external limit" },
                ],
                userObservations: ["routed elsewhere"],
                parsed: true,
            });

            expect(counts.removed).toBe(3);
            expect(counts.inserted).toBe(2);
            const after = getMemoriesByProject(db, projectPath);
            expect(after).toHaveLength(2);
            expect(after.map((m) => m.category).sort()).toEqual(["ARCHITECTURE", "CONSTRAINTS"]);
        });

        it("does not touch a different project's memories", () => {
            const db = openTestDb();
            insertMemory(db, {
                projectPath: "git:other",
                category: "ARCHITECTURE",
                content: "keep",
            });
            insertMemory(db, {
                projectPath: "git:target",
                category: "KNOWN_ISSUES",
                content: "drop",
            });

            applyMemoryMigration(db, "git:target", {
                memories: [{ category: "ARCHITECTURE", content: "rebuilt" }],
                userObservations: [],
                parsed: true,
            });

            expect(getMemoriesByProject(db, "git:other")).toHaveLength(1);
            expect(getMemoriesByProject(db, "git:other")[0].content).toBe("keep");
        });

        it("REFUSES to wipe the pool when the result has 0 recognized v2 memories", () => {
            // Root-cause regression (dogfood 2026-05-31): a parsed-but-empty
            // <migrated> result must NOT hard-delete the active pool.
            const db = openTestDb();
            const projectPath = "git:emptyresult";
            insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE_DECISIONS",
                content: "keep A",
            });
            insertMemory(db, { projectPath, category: "CONSTRAINTS", content: "keep B" });

            const counts = applyMemoryMigration(db, projectPath, {
                memories: [], // degenerate / truncated model output
                userObservations: ["something"],
                parsed: true,
            });

            expect(counts).toEqual({ removed: 0, inserted: 0 });
            expect(getMemoriesByProject(db, projectPath)).toHaveLength(2);
        });

        it("deletes EXPIRED active memories too (no expired-survivor partial wipe)", () => {
            // Root-cause regression: migration must operate on ALL active rows,
            // not just unexpired ones, or expired actives are stranded.
            const db = openTestDb();
            const projectPath = "git:expired";
            const past = Date.now() - 86_400_000; // 1 day ago
            insertMemory(db, {
                projectPath,
                category: "KNOWN_ISSUES",
                content: "expired issue",
                expiresAt: past,
            });
            insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE_DECISIONS",
                content: "unexpired",
            });

            const counts = applyMemoryMigration(db, projectPath, {
                memories: [{ category: "ARCHITECTURE", content: "rebuilt" }],
                userObservations: [],
                parsed: true,
            });

            // BOTH the expired and unexpired rows were removed (not just unexpired).
            expect(counts.removed).toBe(2);
            expect(counts.inserted).toBe(1);
            // No stranded expired row: only the 1 rebuilt memory remains.
            expect(getAllActiveMemoriesForMigration(db, projectPath)).toHaveLength(1);
        });

        it("retires each removed row's claim and creates a claim per replacement, with the epoch bump (U3)", () => {
            const db = openTestDb();
            const projectPath = "git:claims-migration";
            const oldA = insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE_DECISIONS",
                content: "old A",
            });
            const oldB = insertMemory(db, {
                projectPath,
                category: "KNOWN_ISSUES",
                content: "old B",
            });
            recordMemoryMapping(db, oldA.id, ["src/a.ts"], 1_000);
            const epochBefore = getProjectState(db, projectPath)?.projectMemoryEpoch ?? 0;

            const counts = applyMemoryMigration(db, projectPath, {
                memories: [{ category: "ARCHITECTURE", content: "rebuilt fact" }],
                userObservations: [],
                parsed: true,
            });
            expect(counts).toEqual({ removed: 2, inserted: 1 });

            // Removed rows retain archived claims after their projections are deleted.
            for (const removed of [oldA, oldB]) {
                const claim = getCurrentMemoryClaimByLegacyMemoryId(db, removed.id);
                expect(claim?.state).toBe("archived");
                expect(claim?.content).toBe(removed.content);
                const projectionRow = db
                    .prepare("SELECT 1 AS present FROM memories WHERE id = ?")
                    .get(removed.id);
                expect(projectionRow).toBeFalsy();
            }
            const mappingRows = db
                .prepare("SELECT COUNT(*) AS count FROM memory_verifications WHERE memory_id = ?")
                .get(oldA.id) as { count: number };
            expect(mappingRows.count).toBe(0);

            const rebuilt = getMemoriesByProject(db, projectPath)[0];
            const rebuiltClaim = getCurrentMemoryClaimByLegacyMemoryId(db, rebuilt.id);
            expect(rebuiltClaim?.state).toBe("active");
            expect(rebuiltClaim?.revision).toBe(1);
            expect(rebuiltClaim?.content).toBe("rebuilt fact");

            const epochAfter = getProjectState(db, projectPath)?.projectMemoryEpoch ?? 0;
            expect(epochAfter).toBeGreaterThan(epochBefore);
        });

        it("shares one claim project generation across the whole delete+reinsert batch", () => {
            const db = openTestDb();
            const projectPath = "git:generation-batch";
            insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE_DECISIONS",
                content: "old A",
            });
            insertMemory(db, { projectPath, category: "KNOWN_ISSUES", content: "old B" });
            const beforeMax = (
                db.prepare("SELECT COALESCE(MAX(id), 0) AS max FROM claim_change_outbox").get() as {
                    max: number;
                }
            ).max;

            applyMemoryMigration(db, projectPath, {
                memories: [
                    { category: "ARCHITECTURE", content: "new A" },
                    { category: "CONSTRAINTS", content: "new B" },
                ],
                userObservations: [],
                parsed: true,
            });

            // Every claim operation in the batch (2 deletes + 2 inserts) shares
            // the generation allocated once for the migration transaction.
            const generations = db
                .prepare(
                    "SELECT DISTINCT generation FROM claim_change_outbox WHERE id > ? ORDER BY generation",
                )
                .all(beforeMax) as Array<{ generation: number }>;
            expect(generations).toHaveLength(1);
        });
    });

    describe("once-per-project guard", () => {
        it("flips done and is idempotent", () => {
            const db = openTestDb();
            expect(isMemoryMigrationDone(db, "git:x")).toBe(false);
            markMemoryMigrationDone(db, "git:x");
            expect(isMemoryMigrationDone(db, "git:x")).toBe(true);
            // idempotent re-mark
            markMemoryMigrationDone(db, "git:x");
            expect(isMemoryMigrationDone(db, "git:x")).toBe(true);
            // scoped per project
            expect(isMemoryMigrationDone(db, "git:y")).toBe(false);
        });
    });

    describe("runMemoryMigration — fallback escalation", () => {
        it("escalates to a configured fallback model when the primary returns empty output", async () => {
            const db = openTestDb();
            const dir = process.cwd();
            // resolveProjectIdentity(dir) is the project path; seed one active memory.
            const { resolveProjectIdentity } = await import("./project-identity");
            const projectPath = resolveProjectIdentity(dir);
            insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE_DECISIONS" as Memory["category"],
                content: "Old fact in legacy taxonomy.",
                sourceType: "historian",
            });

            const validXml =
                "<migrated>\n<ARCHITECTURE>\n* Re-evaluated fact.\n</ARCHITECTURE>\n</migrated>\n<user_observations></user_observations>";

            // Track which model each prompt call used so we can assert escalation.
            const promptModels: Array<{ providerID: string; modelID: string } | undefined> = [];
            let createCount = 0;
            const client = {
                session: {
                    create: async () => {
                        createCount += 1;
                        return { data: { id: `child-${createCount}` } };
                    },
                    prompt: async (args: {
                        body?: { model?: { providerID: string; modelID: string } };
                    }) => {
                        promptModels.push(args.body?.model);
                        return {};
                    },
                    messages: async () => {
                        // First (primary, no model override) → empty; fallback → valid.
                        const last = promptModels[promptModels.length - 1];
                        const text = last ? validXml : "";
                        return {
                            data: [
                                {
                                    info: {
                                        role: "assistant",
                                        time: { created: promptModels.length },
                                    },
                                    parts: [{ type: "text", text }],
                                },
                            ],
                        };
                    },
                    delete: async () => ({}),
                },
            };

            const { runMemoryMigration } = await import("./memory-migration");
            const outcome = await runMemoryMigration({
                client: client as never,
                db,
                directory: dir,
                parentSessionId: "ses-parent",
                fallbackModels: ["anthropic/claude-sonnet-4-6"],
            });

            // Primary (undefined model) then the configured fallback were both tried.
            expect(promptModels[0]).toBeUndefined();
            expect(promptModels[1]).toEqual({
                providerID: "anthropic",
                modelID: "claude-sonnet-4-6",
            });
            // The fallback's valid output was applied.
            expect(outcome.ran).toBe(true);
            const after = getMemoriesByProject(db, projectPath).map((m) => m.content);
            expect(after).toContain("Re-evaluated fact.");
            expect(after).not.toContain("Old fact in legacy taxonomy.");
        });
    });
});
