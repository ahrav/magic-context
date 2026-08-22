import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { SIDEKICK_AGENT } from "../../agents/sidekick";
import {
    computeNormalizedHash,
    deleteMemory,
    getMemoriesByProject,
    getMemoryById,
    getMemoryMutationsForRender,
    getProjectState,
    getUnclassifiedMemoryIds,
    insertMemory,
    insertMemoryIdempotent,
    normalizeStoredProjectPath,
    setMemoryClassification,
} from "../../features/magic-context";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    type ProjectEmbeddingRegistrationSnapshot,
    registerProjectEmbedding,
} from "../../features/magic-context/memory/embedding";
import type {
    EmbeddingProvider,
    EmbeddingPurpose,
} from "../../features/magic-context/memory/embedding-provider";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import {
    clearMemoryClaimFailpoints,
    getCurrentMemoryClaimByLegacyMemoryId,
    runInMemoryClaimsWriteTransaction,
    setMemoryClaimFailpoint,
} from "../../features/magic-context/memory/storage-memory-claims";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";

const { createCtxMemoryTools } = await import("./tools");

function createTestDb(dbPath = ":memory:"): Database {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS authority_managed (
            project_path TEXT PRIMARY KEY,
            context_store_uuid TEXT NOT NULL,
            marked_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memories
        (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path            TEXT    NOT NULL,
            category                TEXT    NOT NULL,
            content                 TEXT    NOT NULL,
            normalized_hash         TEXT    NOT NULL,
            importance              INTEGER NOT NULL DEFAULT 50,
            scope                   TEXT    NOT NULL DEFAULT 'project',
            shareable               INTEGER NOT NULL DEFAULT 0,
            source_session_id       TEXT,
            source_type             TEXT    DEFAULT 'historian',
            seen_count              INTEGER DEFAULT 1,
            retrieval_count         INTEGER DEFAULT 0,
            first_seen_at           INTEGER NOT NULL,
            created_at              INTEGER NOT NULL,
            updated_at              INTEGER NOT NULL,
            last_seen_at            INTEGER NOT NULL,
            last_retrieved_at       INTEGER,
            status                  TEXT    DEFAULT 'active',
            expires_at              INTEGER,
            verification_status     TEXT    DEFAULT 'unverified',
            verified_at             INTEGER,
            classified_at           INTEGER,
            superseded_by_memory_id INTEGER,
            merged_from             TEXT,
            metadata_json           TEXT,
            UNIQUE (project_path, category, normalized_hash)
        );

        CREATE TABLE IF NOT EXISTS memory_embeddings
        (
            memory_id INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
            embedding BLOB NOT NULL,
            model_id  TEXT NOT NULL,
            PRIMARY KEY (memory_id, model_id)
        );

        CREATE TABLE IF NOT EXISTS embedding_identity_active (
            project_path   TEXT NOT NULL,
            scope          TEXT NOT NULL,
            model_id       TEXT NOT NULL,
            last_active_at INTEGER NOT NULL,
            PRIMARY KEY (project_path, scope, model_id)
        );

        CREATE TABLE IF NOT EXISTS session_projects (
            session_id   TEXT NOT NULL,
            harness      TEXT NOT NULL DEFAULT 'opencode',
            project_path TEXT NOT NULL,
            updated_at   INTEGER NOT NULL,
            PRIMARY KEY (session_id, harness)
        );

        CREATE TABLE IF NOT EXISTS compartment_chunk_embeddings (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            compartment_id INTEGER NOT NULL,
            session_id     TEXT NOT NULL,
            project_path   TEXT NOT NULL,
            harness        TEXT NOT NULL DEFAULT 'opencode',
            window_index   INTEGER NOT NULL DEFAULT 0,
            start_ordinal  INTEGER NOT NULL DEFAULT 0,
            end_ordinal    INTEGER NOT NULL DEFAULT 0,
            chunk_hash     TEXT NOT NULL DEFAULT '',
            model_id       TEXT NOT NULL DEFAULT '',
            dims           INTEGER NOT NULL DEFAULT 0,
            vector         BLOB NOT NULL DEFAULT X'',
            created_at     INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS memory_verifications (
            memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            verified_at INTEGER NOT NULL,
            mapped_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (memory_id, file_path)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_verifications_memory ON memory_verifications(memory_id);

        CREATE TABLE IF NOT EXISTS task_schedule_state (
            project_path TEXT NOT NULL,
            task TEXT NOT NULL,
            last_run_at INTEGER,
            next_due_at INTEGER,
            schedule TEXT,
            last_status TEXT,
            last_error TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_checked_commit TEXT,
            last_broad_run_at INTEGER,
            retrospective_watermark_ms INTEGER,
            PRIMARY KEY(project_path, task)
        );

        CREATE TABLE IF NOT EXISTS project_state
        (
            project_path                 TEXT PRIMARY KEY,
            project_memory_epoch         INTEGER NOT NULL DEFAULT 0,
            project_user_profile_version INTEGER NOT NULL DEFAULT 0,
            updated_at                   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_mutation_log
        (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path     TEXT NOT NULL,
            mutation_type    TEXT NOT NULL,
            target_memory_id INTEGER NOT NULL,
            superseded_by_id INTEGER,
            category         TEXT,
            new_content      TEXT,
            queued_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
            ON memory_mutation_log(project_path, id);

        CREATE TABLE IF NOT EXISTS workspaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            share_categories TEXT
        );

        CREATE TABLE IF NOT EXISTS workspace_members (
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            project_path TEXT NOT NULL,
            display_name TEXT NOT NULL,
            display_path TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, project_path)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique ON workspace_members(project_path);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name ON workspace_members(workspace_id, display_name);

        CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
            old_project_path TEXT PRIMARY KEY,
            new_project_path TEXT NOT NULL,
            rekeyed_at INTEGER NOT NULL
        );

        CREATE
        VIRTUAL
        TABLE IF
        NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.id, new.content, new.category);
        END;
    `);
    return db;
}

function hideFirstClaimOperationRead(database: Database): Database {
    let hidden = false;
    return new Proxy(database, {
        get(target, property) {
            if (property === "prepare") {
                return (sql: string) => {
                    const statement = target.prepare(sql);
                    if (
                        !hidden &&
                        sql.includes(
                            "SELECT request_digest AS requestDigest, result_json AS resultJson FROM claim_operations",
                        )
                    ) {
                        hidden = true;
                        return new Proxy(statement, {
                            get(statementTarget, statementProperty) {
                                if (statementProperty === "get") return () => undefined;
                                const value = Reflect.get(
                                    statementTarget,
                                    statementProperty,
                                    statementTarget,
                                );
                                return typeof value === "function"
                                    ? value.bind(statementTarget)
                                    : value;
                            },
                        });
                    }
                    return statement;
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Database;
}

const toolContext = (sessionID = "ses-memory", agent = "general", callID?: string) =>
    ({ sessionID, agent, directory: "/repo/project", ...(callID ? { callID } : {}) }) as never;

const dreamerToolContext = (directory: string) =>
    ({ sessionID: "ses-dream", agent: DREAMER_AGENT, directory }) as never;

function wait(ms = 0): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProjectMemoryEpoch(db: Database, projectPath: string): number {
    return getProjectState(db, normalizeStoredProjectPath(projectPath))?.projectMemoryEpoch ?? 0;
}

function getMutationRows(db: Database, projectPath: string, renderedMemoryIds: number[]) {
    return getMemoryMutationsForRender(
        db,
        normalizeStoredProjectPath(projectPath),
        0,
        renderedMemoryIds,
    );
}

function installTestEmbeddingProvider(
    embedImpl: (text: string) => Promise<Float32Array | null>,
): void {
    _setTestProviderFactoryForProject(
        () =>
            ({
                modelId: "test-provider-model",
                initialize: async () => true,
                embed: async (text: string, _signal?: AbortSignal, _purpose?: EmbeddingPurpose) => {
                    const vector = await embedImpl(text);
                    return vector ?? new Float32Array();
                },
                embedBatch: async (
                    texts: string[],
                    _signal?: AbortSignal,
                    _purpose?: EmbeddingPurpose,
                ) => {
                    const vectors: Float32Array[] = [];
                    for (const text of texts) {
                        vectors.push((await embedImpl(text)) ?? new Float32Array());
                    }
                    return vectors;
                },
                dispose: async () => {},
                isLoaded: () => true,
            }) satisfies EmbeddingProvider,
    );
}

function registerMemoryEmbeddingsForProject(
    db: Database,
    projectPath = "/repo/project",
): ProjectEmbeddingRegistrationSnapshot {
    const snapshot = registerProjectEmbedding(
        db,
        projectPath,
        { provider: "local", model: "mock-model" },
        { memoryEnabled: true, gitCommitEnabled: false },
        projectPath,
    );
    const normalizedProjectPath = normalizeStoredProjectPath(projectPath);
    if (normalizedProjectPath !== projectPath) {
        registerProjectEmbedding(
            db,
            normalizedProjectPath,
            { provider: "local", model: "mock-model" },
            { memoryEnabled: true, gitCommitEnabled: false },
            projectPath,
        );
    }
    return snapshot;
}

describe("createCtxMemoryTools", () => {
    let db: Database;
    let tools: ReturnType<typeof createCtxMemoryTools>;

    beforeEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        _setTestProviderFactoryForProject(null);
        db = createTestDb();
        tools = createCtxMemoryTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: true,
            embeddingEnabled: false,
        });
    });

    afterEach(() => {
        closeQuietly(db);
        _setTestProviderFactoryForProject(null);
        _resetProjectEmbeddingRegistryForTests();
    });

    it("writes and reads a memory through an opted-in home session identity", async () => {
        const homeIdentity = resolveProjectIdentityForSession(homedir(), true);
        expect(homeIdentity).toBeDefined();
        const homeTools = createCtxMemoryTools({
            db,
            resolveProjectPath: (directory) => resolveProjectIdentityForSession(directory, true),
            memoryEnabled: true,
            embeddingEnabled: false,
        });
        const homeContext = {
            sessionID: "ses-memory",
            agent: "general",
            directory: homedir(),
        } as never;

        const write = await homeTools.ctx_memory.execute(
            {
                action: "write",
                category: "USER_DIRECTIVES",
                content: "Retain global troubleshooting context.",
            },
            homeContext,
        );
        expect(write).toContain("Saved memory [ID:");

        const [memory] = getMemoriesByProject(db, homeIdentity as string);
        if (!memory) throw new Error("expected home-session memory");
        expect(memory.content).toBe("Retain global troubleshooting context.");
        const read = await homeTools.ctx_memory.execute(
            { action: "get", ids: [memory.id] },
            homeContext,
        );
        expect(read).toContain("Retain global troubleshooting context.");
    });

    describe("#given write action", () => {
        it("triggers one rust memory sync after a write while keeping the TS write authority", async () => {
            const syncSessions: string[] = [];
            const rustTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                rustToolBackends: {
                    memorySync: (sessionId) => syncSessions.push(sessionId),
                },
            });

            const result = await rustTools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Keep the context database authoritative.",
                },
                toolContext(),
            );

            expect(result).toContain("Saved memory [ID:");
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(1);
            expect(syncSessions).toEqual(["ses-memory"]);

            const tsTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
            });
            await tsTools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "TS mode has no module sync trigger.",
                },
                toolContext(),
            );
            expect(syncSessions).toEqual(["ses-memory"]);
        });

        it("routes all module-owned memory actions without writing the TS table", async () => {
            const routed: Array<{ action: string; ids?: number[]; memoryProject: string }> = [];
            const moduleTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                rustToolBackends: {
                    authorityState: async () => "MODULE",
                    memory: async (request) => {
                        routed.push({
                            action: request.action,
                            ids: request.ids,
                            memoryProject: request.memoryProject,
                        });
                        return { content: [{ type: "text", text: `module ${request.action}` }] };
                    },
                },
            });
            const actions = [
                { action: "write", category: "CONSTRAINTS", content: "module write" },
                { action: "update", ids: [1], content: "module update" },
                { action: "archive", ids: [1] },
                { action: "merge", ids: [1, 2], content: "module merge" },
                { action: "get", ids: [1] },
            ] as const;
            for (const request of actions) {
                const result = await moduleTools.ctx_memory.execute(request, toolContext());
                expect(result).toContain(`module ${request.action}`);
            }
            expect(routed.map((request) => request.action)).toEqual([
                "write",
                "update",
                "archive",
                "merge",
                "get",
            ]);
            expect(routed.every((request) => request.memoryProject === "/repo/project")).toBe(true);
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(0);
        });

        it("maps a raced module drain rejection to the transition retry message", async () => {
            const moduleTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                rustToolBackends: {
                    authorityState: async () => "MODULE",
                    memory: async () => {
                        const error = new Error("authority is draining") as Error & {
                            code: string;
                        };
                        error.code = "authority_draining";
                        throw error;
                    },
                },
            });
            const result = await moduleTools.ctx_memory.execute(
                { action: "write", category: "CONSTRAINTS", content: "retry me" },
                toolContext(),
            );
            expect(result).toContain("Write REFUSED and NOT saved");
            expect(result).toContain("RESEND");
            expect(result).toContain("Content to resend:\nretry me");
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(0);
        });

        it("does not echo content attached to a read-only module refusal", async () => {
            const moduleTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                rustToolBackends: {
                    authorityState: async () => "MODULE",
                    memory: async () => ({
                        error: { code: "authority_draining", message: "authority is draining" },
                    }),
                },
            });
            const result = await moduleTools.ctx_memory.execute(
                { action: "get", ids: [1], content: "read-only content must not echo" },
                toolContext(),
            );
            expect(result).toContain("REFUSED and NOT applied");
            expect(result).toContain("RESEND");
            expect(result).not.toContain("read-only content must not echo");
        });

        it("fails closed when module authority is active without the memory protocol", async () => {
            const moduleTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                rustToolBackends: { authorityState: async () => "MODULE" },
            });
            const result = await moduleTools.ctx_memory.execute(
                { action: "write", category: "CONSTRAINTS", content: "must not fall back" },
                toolContext(),
            );
            expect(result).toContain("does not support ctx_memory");
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(0);
        });

        it("creates a new memory with agent source type", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Always run bun test before shipping.",
                },
                toolContext(),
            );

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(result).toContain("Saved memory [ID:");
            expect(memories).toHaveLength(1);
            expect(memories[0]?.sourceType).toBe("agent");
            expect(memories[0]?.sourceSessionId).toBe("ses-memory");
            expect(memories[0]?.category).toBe("USER_DIRECTIVES");
        });

        it("does not bump project memory epoch for additive writes", async () => {
            const identity = normalizeStoredProjectPath("/repo/project");

            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Prefer compact diffs.",
                },
                toolContext(),
            );

            expect(result).toContain("Saved memory");
            expect(getProjectState(db, identity)).toBeNull();
        });

        it("returns error when content is missing", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("'content' is required");
        });

        it("returns error when category is missing", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    content: "Remember this.",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("'category' is required");
        });

        it("returns error for unknown category", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "UNKNOWN_CATEGORY",
                    content: "Remember this.",
                },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("Unknown memory category");
        });

        it("always uses project scope for writes", async () => {
            await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_PREFERENCES",
                    content: "Keep answers dense.",
                },
                toolContext(),
            );

            const memories = getMemoriesByProject(db, "/repo/project");

            expect(memories).toHaveLength(1);
            expect(memories[0]?.projectPath).toBe("/repo/project");
        });

        it("stores a fresh embedding when the memory content stays unchanged", async () => {
            const snapshot = registerMemoryEmbeddingsForProject(db);
            let release: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                installTestEmbeddingProvider(async () => {
                    resolve();
                    await new Promise<void>((resume) => {
                        release = resume;
                    });
                    return new Float32Array([1, 2]);
                });
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Keep the fresh embedding.",
                },
                toolContext(),
            );
            const memory = getMemoriesByProject(db, "/repo/project")[0];

            expect(result).toContain("Saved memory [ID:");
            expect(memory).toBeDefined();
            await started;
            release?.();
            await wait();

            const row = db
                .prepare(
                    "SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ? AND model_id = ?",
                )
                .get(memory?.id, snapshot.modelId) as { count?: number } | null;
            expect(row?.count).toBe(1);
        });

        it("returns an exact-dedup response when another writer wins after the pre-check", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "ctx-memory-race-"));
            const dbPath = join(tempDir, "context.db");
            const db1 = createTestDb(dbPath);
            const db2 = createTestDb(dbPath);
            const tools1 = createCtxMemoryTools({
                db: db1,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
            });
            const originalPrepare = db1.prepare.bind(db1);
            let injected = false;
            let winnerInsert: ReturnType<typeof insertMemoryIdempotent> | null = null;
            (db1 as unknown as { prepare: typeof db1.prepare }).prepare = ((sql: string) => {
                const stmt = originalPrepare(sql);
                if (sql.startsWith("INSERT INTO memories")) {
                    const run = stmt.run.bind(stmt);
                    (stmt as unknown as { run: typeof stmt.run }).run = ((...args: unknown[]) => {
                        if (!injected) {
                            injected = true;
                            winnerInsert = insertMemoryIdempotent(db2, {
                                projectPath: "/repo/project",
                                category: "USER_DIRECTIVES",
                                content: "Race-safe exact dedup",
                                sourceSessionId: "ses-memory-2",
                                sourceType: "agent",
                            });
                        }
                        return run(...(args as Parameters<typeof stmt.run>));
                    }) as typeof stmt.run;
                }
                return stmt;
            }) as typeof db1.prepare;

            try {
                const loserResult = await tools1.ctx_memory.execute(
                    {
                        action: "write",
                        category: "USER_DIRECTIVES",
                        content: "Race-safe exact dedup",
                    },
                    toolContext("ses-memory-1"),
                );
                expect(winnerInsert).not.toBeNull();
                const memories = getMemoriesByProject(db1, "/repo/project");

                expect(
                    (winnerInsert as ReturnType<typeof insertMemoryIdempotent> | null)?.inserted,
                ).toBe(true);
                expect(loserResult).toContain("Memory already exists");
                expect(memories).toHaveLength(1);
                expect(memories[0]?.seenCount).toBe(2);
            } finally {
                closeQuietly(db1);
                closeQuietly(db2);
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe("#given archive action by a PRIMARY agent", () => {
        // archive is now a primary action (it replaced the redundant `delete`
        // alias). A primary agent — no DREAMER_AGENT context — must be able to
        // soft-remove a memory it sees in the injected project-memory block.
        it("archives the memory by ID", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Legacy parser fails on malformed XML.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id] },
                toolContext(),
            );
            const updated = getMemoryById(db, memory.id);

            expect(result).toContain("Archived memory");
            expect(updated?.status).toBe("archived");
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [memory.id])).toMatchObject([
                { mutationType: "archive", targetMemoryId: memory.id },
            ]);
        });

        it("archives a batch of memories in one call, all-or-nothing", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Stale issue one.",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Stale issue two.",
            });

            const batch = await tools.ctx_memory.execute(
                { action: "archive", ids: [first.id, second.id], reason: "obsolete" },
                toolContext(),
            );
            expect(batch).toContain(`Archived memories [ID: ${first.id}, ${second.id}]`);
            expect(getMemoryById(db, first.id)?.status).toBe("archived");
            expect(getMemoryById(db, second.id)?.status).toBe("archived");

            // A bad id anywhere in the batch must archive NOTHING.
            const third = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Still active.",
            });
            const failed = await tools.ctx_memory.execute(
                { action: "archive", ids: [third.id, 99_999] },
                toolContext(),
            );
            expect(failed).toContain("Error");
            expect(getMemoryById(db, third.id)?.status).toBe("active");
        });

        it("archives with a tool-call id on a database without the claims schema", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Pre-claims archive target.",
            });

            // A pre-v84 database has no claim_operations table; the replay
            // gate must not read it just because a tool-call id is present.
            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id] },
                toolContext("ses-memory", "general", "tool-call-pre-claims"),
            );

            expect(result).toContain(`Archived memory [ID: ${memory.id}]`);
            expect(getMemoryById(db, memory.id)?.status).toBe("archived");
        });

        it("rejects archived memories with the same inactive-memory error used by update and merge", async () => {
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Already curated away.",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [archived.id] },
                toolContext(),
            );

            expect(result).toContain("restore it before archiving");
            expect(getMemoryById(db, archived.id)?.status).toBe("archived");
            expect(getMutationRows(db, "/repo/project", [archived.id])).toHaveLength(0);
        });

        it("rejects a non-integer archive id without mutating", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Still active.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id, memory.id + 0.5] },
                toolContext(),
            );

            expect(result).toContain("integer memory ID");
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
        });

        it("rejects malformed archive ids without mutating", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Malformed id should not archive this.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id, memory.id + 0.5] },
                toolContext(),
            );

            expect(result).toContain("integer memory ID");
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
        });

        it("returns error when ID is missing", async () => {
            const result = await tools.ctx_memory.execute({ action: "archive" }, toolContext());

            expect(result).toContain("Error");
            expect(result).toContain("'ids' must contain at least one integer memory ID");
        });

        it("returns error when memory not found", async () => {
            const result = await tools.ctx_memory.execute(
                { action: "archive", ids: [999] },
                toolContext(),
            );

            expect(result).toContain("Error");
            expect(result).toContain("was not found");
        });
    });

    describe("#given list action", () => {
        it("returns a formatted memory table", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always run bun test before shipping.",
            });
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Do not use npm in this repo.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "list", limit: 10 },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Found 2 active memories");
            expect(result).toContain("CATEGORY");
            expect(result).toContain("Always run bun test before shipping.");
            expect(result).toContain("Do not use npm in this repo.");
        });
    });

    it("rejects archiving a foreign workspace memory even when the category is shared", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const memory = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "Foreign shared constraint is readable but not mutable.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [memory.id] },
            toolContext(),
        );

        expect(result).toBe(`Error: Memory with ID ${memory.id} was not found.`);
        expect(getMemoryById(db, memory.id)?.status).toBe("active");
        expect(getMemoryMutationsForRender(db, "/repo/foreign", 0, [memory.id])).toHaveLength(0);
    });

    it("REFUSES to archive a foreign memory in a NON-shared category", async () => {
        // Workspace shares only CONSTRAINTS. A foreign member's ARCHITECTURE
        // memory is invisible in the render — the tool must not mutate it either.
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const foreignHidden = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "ARCHITECTURE",
            content: "Foreign architecture detail not shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [foreignHidden.id] },
            toolContext(),
        );

        expect(result).not.toContain("Archived memory");
        expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
    });

    it("rejects archiving a foreign memory in a SHARED category", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const foreignShared = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "Foreign constraint shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [foreignShared.id] },
            toolContext(),
        );

        expect(result).toBe(`Error: Memory with ID ${foreignShared.id} was not found.`);
        expect(getMemoryById(db, foreignShared.id)?.status).toBe("active");
    });

    it("always allows mutating OWN-project memory regardless of share categories", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE", // own project, non-shared category — still mutable
            content: "Own architecture detail.",
        });

        const result = await tools.ctx_memory.execute(
            { action: "archive", ids: [own.id] },
            toolContext(),
        );

        expect(result).toContain("Archived memory");
        expect(getMemoryById(db, own.id)?.status).toBe("archived");
    });

    it("REFUSES a PRIMARY merge that pulls in a foreign memory in a NON-shared category", async () => {
        // Primary mutations require ownership, not workspace visibility. A shared
        // workspace may make foreign memories readable, but the caller may only
        // update, archive, or merge memories from its own project identity set.
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE",
            content: "Own architecture detail A.",
        });
        const foreignHidden = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "ARCHITECTURE",
            content: "Foreign architecture detail not shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreignHidden.id],
                content: "Merged architecture detail.",
                category: "ARCHITECTURE",
            },
            toolContext(),
        );

        expect(result).toContain(`Memory with ID ${foreignHidden.id} was not found`);
        expect(getMemoryById(db, own.id)?.status).toBe("active");
        expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
    });

    it("rejects a PRIMARY merge of a foreign memory in a SHARED category", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "CONSTRAINTS",
            content: "Own constraint A.",
        });
        const foreignShared = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "Foreign constraint shared with this project.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreignShared.id],
                content: "Merged shared constraint.",
                category: "CONSTRAINTS",
            },
            toolContext(),
        );

        expect(result).toBe(`Error: Memory with ID ${foreignShared.id} was not found.`);
        expect(getMemoryById(db, own.id)?.status).toBe("active");
        expect(getMemoryById(db, foreignShared.id)?.status).toBe("active");
    });

    it("REJECTS merging memories from DIFFERENT categories (structural guard)", async () => {
        const arch = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE",
            content: "Execute threshold is capped at 80% for safety headroom.",
        });
        const cfg = insertMemory(db, {
            projectPath: "/repo/project",
            category: "CONFIG_VALUES",
            content: "execute_threshold_percentage accepts 20-80 as scalar or map.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [arch.id, cfg.id],
                content: "Execute threshold stuff.",
                category: "CONFIG_VALUES",
            },
            dreamerToolContext("/repo/project"),
        );

        expect(result).toContain("different categories");
        // both sources remain untouched — no destructive collapse
        expect(getMemoryById(db, arch.id)?.status).toBe("active");
        expect(getMemoryById(db, cfg.id)?.status).toBe("active");
    });

    it("REFUSES a DREAMER merge of a foreign NON-shared-category memory INSIDE a workspace (D1)", async () => {
        // The dreamer keeps cross-project merge OUTSIDE a workspace (#5971), but
        // INSIDE a workspace the per-category sharing policy is the user's explicit
        // privacy boundary the dreamer must honor too.
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE",
            content: "Own architecture detail D1.",
        });
        const foreignHidden = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "ARCHITECTURE", // foreign, NON-shared category
            content: "Foreign architecture not shared with this workspace member.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreignHidden.id],
                content: "Merged architecture detail D1.",
                category: "ARCHITECTURE",
            },
            toolContext("ses-dreamer", DREAMER_AGENT),
        );

        expect(result).toContain("not shared with this workspace member");
        expect(getMemoryById(db, own.id)?.status).toBe("active");
        expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
    });

    it("REFUSES a DREAMER merge when workspace share_categories is malformed", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, 'not-json');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "CONSTRAINTS",
            content: "Own constraint malformed policy.",
        });
        const foreign = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS",
            content: "Foreign constraint hidden by malformed policy.",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreign.id],
                content: "Merged constraint under malformed policy.",
                category: "CONSTRAINTS",
            },
            toolContext("ses-dreamer", DREAMER_AGENT),
        );

        expect(result).toContain("not shared with this workspace member");
        expect(getMemoryById(db, own.id)?.status).toBe("active");
        expect(getMemoryById(db, foreign.id)?.status).toBe("active");
    });

    it("ALLOWS a DREAMER merge of a foreign SHARED-category memory INSIDE a workspace (D1)", async () => {
        db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
        const own = insertMemory(db, {
            projectPath: "/repo/project",
            category: "CONSTRAINTS",
            content: "Own constraint D1.",
        });
        const foreignShared = insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "CONSTRAINTS", // shared
            content: "Foreign constraint shared with the workspace.",
        });
        db.prepare("UPDATE memories SET shareable = 1, scope = 'project' WHERE id = ?").run(
            foreignShared.id,
        );

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreignShared.id],
                content: "Merged shared constraint D1.",
                category: "CONSTRAINTS",
            },
            toolContext("ses-dreamer", DREAMER_AGENT),
        );

        expect(result).not.toContain("not shared");
        expect(getMemoryById(db, own.id)?.status).toBe("archived");
        expect(getMemoryById(db, foreignShared.id)?.status).toBe("archived");
    });

    describe("#given update action", () => {
        it("rejects updating a foreign workspace memory even when the category is shared", async () => {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
            const foreign = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "CONSTRAINTS",
                content: "Old foreign shared constraint.",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [foreign.id],
                    content: "Updated foreign shared constraint.",
                },
                toolContext(),
            );

            expect(result).toBe(`Error: Memory with ID ${foreign.id} was not found.`);
            expect(getMemoryById(db, foreign.id)?.content).toBe("Old foreign shared constraint.");
            expect(getMemoryMutationsForRender(db, "/repo/foreign", 0, [foreign.id])).toHaveLength(
                0,
            );
        });

        it("updates memory content and invalidates stale embeddings", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`Updated memory [ID: ${memory.id}]`);
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=10m");
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [memory.id])).toMatchObject([
                {
                    mutationType: "update",
                    targetMemoryId: memory.id,
                    category: "CONFIG_DEFAULTS",
                    newContent: "cache_ttl=10m",
                },
            ]);
        });

        it("skips saving an embedding when the memory content changes before the provider returns", async () => {
            registerMemoryEmbeddingsForProject(db);
            let release: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                installTestEmbeddingProvider(async () => {
                    resolve();
                    await new Promise<void>((resume) => {
                        release = resume;
                    });
                    return new Float32Array([3, 4]);
                });
            });
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`Updated memory [ID: ${memory.id}]`);
            await started;
            db.prepare(
                "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
            ).run("cache_ttl=30m", computeNormalizedHash("cache_ttl=30m"), Date.now(), memory.id);
            release?.();
            await wait();

            const row = db
                .prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?")
                .get(memory.id) as { count?: number } | null;
            expect(row?.count).toBe(0);
        });

        it("normalizes legacy raw project paths before queueing the mutation", async () => {
            const rawProjectPath = "/legacy/raw-project";
            const projectIdentity = normalizeStoredProjectPath(rawProjectPath);
            const legacyTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => projectIdentity,
                memoryEnabled: true,
                embeddingEnabled: false,
            });
            const memory = insertMemory(db, {
                projectPath: rawProjectPath,
                category: "CONFIG_DEFAULTS",
                content: "timeout=5s",
            });

            const result = await legacyTools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "timeout=10s",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`Updated memory [ID: ${memory.id}]`);
            expect(getProjectState(db, projectIdentity)).toBeNull();
            expect(getProjectState(db, rawProjectPath)).toBeNull();
            expect(getMutationRows(db, projectIdentity, [memory.id])).toMatchObject([
                { mutationType: "update", targetMemoryId: memory.id, newContent: "timeout=10s" },
            ]);
        });

        it("rejects malformed update ids without mutating", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id + 0.5],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-primary", "general"),
            );

            expect(result).toContain("integer memory ID");
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=5m");
        });

        it("rejects archived or superseded memories for primary-agent update", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(memory.id);

            const result = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "cache_ttl=10m",
                },
                toolContext("ses-primary", "general"),
            );

            expect(result).toBe(
                `Error: Memory with ID ${memory.id} is archived or superseded; restore it before updating.`,
            );
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=5m");
            expect(getMemoryById(db, memory.id)?.status).toBe("archived");
        });

        it("rolls back content updates when queueing the mutation fails", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONFIG_DEFAULTS",
                content: "cache_ttl=5m",
            });
            db.exec("DROP TABLE memory_mutation_log");

            let thrown: unknown;
            try {
                await tools.ctx_memory.execute(
                    {
                        action: "update",
                        ids: [memory.id],
                        content: "cache_ttl=10m",
                    },
                    toolContext("ses-dreamer", DREAMER_AGENT),
                );
            } catch (error) {
                thrown = error;
            }

            expect(String(thrown)).toContain("memory_mutation_log");
            expect(getMemoryById(db, memory.id)?.content).toBe("cache_ttl=5m");
        });
    });

    describe("#given merge action", () => {
        it("creates a canonical merged memory and archives source memories", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for all scripts in this repo",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Merged memories");
            const activeMemories = getMemoriesByProject(db, "/repo/project");
            expect(activeMemories).toHaveLength(1);
            expect(activeMemories[0]?.content).toBe("Use bun for all scripts in this repository.");
            expect(getMemoryById(db, first.id)?.status).toBe("archived");
            expect(getMemoryById(db, second.id)?.status).toBe("archived");
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [first.id, second.id])).toMatchObject([
                {
                    mutationType: "superseded",
                    targetMemoryId: first.id,
                    supersededById: activeMemories[0]?.id,
                },
                {
                    mutationType: "superseded",
                    targetMemoryId: second.id,
                    supersededById: activeMemories[0]?.id,
                },
            ]);
        });

        it("queues an update row when an existing canonical memory content changes", async () => {
            const canonical = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const duplicate = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for all scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [canonical.id, duplicate.id],
                    content: "USE BUN FOR SCRIPTS",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`canonical memory [ID: ${canonical.id}]`);
            expect(getMemoryById(db, canonical.id)?.content).toBe("USE BUN FOR SCRIPTS");
            expect(
                getMutationRows(db, "/repo/project", [canonical.id, duplicate.id]),
            ).toMatchObject([
                {
                    mutationType: "superseded",
                    targetMemoryId: duplicate.id,
                    supersededById: canonical.id,
                },
                {
                    mutationType: "update",
                    targetMemoryId: canonical.id,
                    newContent: "USE BUN FOR SCRIPTS",
                },
            ]);
        });

        it("rejects a PRIMARY-agent merge that includes another project's memory", async () => {
            const own = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const foreign = insertMemory(db, {
                projectPath: "/repo/other-project",
                category: "CONSTRAINTS",
                content: "Use bun for build scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [own.id, foreign.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-primary", "general"),
            );

            // Cross-identity merge is dreamer-only; a primary agent must not
            // be able to mutate another project's memories. Same opaque
            // "not found" reply as update/archive (no existence oracle).
            expect(result).toBe(`Error: Memory with ID ${foreign.id} was not found.`);
            expect(getMemoryById(db, own.id)?.status).toBe("active");
            expect(getMemoryById(db, foreign.id)?.status).toBe("active");
            expect(getMutationRows(db, "/repo/other-project", [foreign.id])).toHaveLength(0);
        });

        it("rejects archived or superseded memories for primary-agent merge", async () => {
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const active = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for test scripts",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [archived.id, active.id],
                    content: "Use bun for scripts",
                },
                toolContext("ses-primary", "general"),
            );

            expect(result).toBe(
                `Error: Memory with ID ${archived.id} is archived or superseded; restore it before merging.`,
            );
            expect(getMemoryById(db, archived.id)?.status).toBe("archived");
            expect(getMemoryById(db, active.id)?.status).toBe("active");
        });

        it("keeps dreamer able to curate archived memories during merge", async () => {
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const active = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for test scripts",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [archived.id, active.id],
                    content: "Use bun for scripts",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain(`canonical memory [ID: ${archived.id}]`);
            expect(getMemoryById(db, archived.id)?.status).toBe("active");
            expect(getMemoryById(db, active.id)?.status).toBe("archived");
        });

        it("rejects malformed or duplicate merge ids", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Use bun for tests",
            });

            const malformed = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id + 0.5],
                    content: "Use bun for all scripts.",
                },
                toolContext("ses-primary", "general"),
            );
            const duplicate = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, first.id],
                    content: "Use bun for scripts.",
                },
                toolContext("ses-primary", "general"),
            );

            expect(malformed).toContain("integer memory IDs");
            expect(duplicate).toContain("distinct memory IDs");
            expect(getMemoryById(db, first.id)?.status).toBe("active");
            expect(getMemoryById(db, second.id)?.status).toBe("active");
        });

        it("queues superseded rows under each affected project identity when merging across identities", async () => {
            const first = insertMemory(db, {
                projectPath: "/repo/project-a",
                category: "CONSTRAINTS",
                content: "Use bun for scripts",
            });
            const second = insertMemory(db, {
                projectPath: "/repo/project-a",
                category: "CONSTRAINTS",
                content: "Use bun for test scripts",
            });
            const third = insertMemory(db, {
                projectPath: "/repo/project-b",
                category: "CONSTRAINTS",
                content: "Use bun for build scripts",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "merge",
                    ids: [first.id, second.id, third.id],
                    content: "Use bun for all scripts in this repository.",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Merged memories");
            expect(getProjectMemoryEpoch(db, "/repo/project-a")).toBe(0);
            expect(getProjectMemoryEpoch(db, "/repo/project-b")).toBe(0);
            expect(getMutationRows(db, "/repo/project-a", [first.id, second.id])).toMatchObject([
                { mutationType: "superseded", targetMemoryId: first.id },
                { mutationType: "superseded", targetMemoryId: second.id },
            ]);
            expect(getMutationRows(db, "/repo/project-b", [third.id])).toMatchObject([
                { mutationType: "superseded", targetMemoryId: third.id },
            ]);
        });
    });

    describe("#given archive action", () => {
        it("archives the memory and stores the archive reason in metadata", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Old issue entry",
            });

            const result = await tools.ctx_memory.execute(
                {
                    action: "archive",
                    ids: [memory.id],
                    reason: "Removed subsystem no longer exists",
                },
                toolContext("ses-dreamer", DREAMER_AGENT),
            );

            expect(result).toContain("Archived memory");
            expect(getMemoryById(db, memory.id)?.metadataJson).toContain(
                "Removed subsystem no longer exists",
            );
            expect(getProjectMemoryEpoch(db, "/repo/project")).toBe(0);
            expect(getMutationRows(db, "/repo/project", [memory.id])).toMatchObject([
                { mutationType: "archive", targetMemoryId: memory.id },
            ]);
        });
    });

    describe("#given disabled memory", () => {
        it("returns disabled message for all actions", async () => {
            const disabledTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: false,
                embeddingEnabled: false,
            });

            const results = await Promise.all([
                disabledTools.ctx_memory.execute(
                    { action: "write", category: "USER_DIRECTIVES", content: "x" },
                    toolContext(),
                ),
                disabledTools.ctx_memory.execute({ action: "archive", ids: [1] }, toolContext()),
            ]);

            expect(results).toEqual([
                "Cross-session memory is disabled for this project.",
                "Cross-session memory is disabled for this project.",
            ]);
        });
    });

    describe("#given restricted actions", () => {
        // Primary set = write/archive/update/merge. list/verified/classify are dreamer-only.
        const PRIMARY_ACTIONS = ["write", "archive", "update", "merge"] as const;

        it("rejects sidekick ctx_memory calls even if the tool is exposed", async () => {
            const result = await tools.ctx_memory.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "Sidekick should not be able to write this.",
                },
                toolContext("ses-sidekick", SIDEKICK_AGENT),
            );

            expect(result).toBe("Error: ctx_memory is not available to the sidekick agent.");
            expect(getMemoriesByProject(db, "/repo/project")).toHaveLength(0);
        });

        it("keeps the dreamer-only `list` action in the schema so OpenCode can deliver it to execute", () => {
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            const actionSchema = primaryTools.ctx_memory.args.action as unknown as {
                safeParse: (value: unknown) => { success: boolean };
            };

            // The shared schema must still accept `list` (the runtime gate, not
            // the schema, blocks it for primary agents).
            expect(actionSchema.safeParse("list").success).toBe(true);
            expect(actionSchema.safeParse("merge").success).toBe(true);
            // verified/classify are no longer tool actions (host-applied tasks).
            expect(actionSchema.safeParse("classify").success).toBe(false);
            expect(actionSchema.safeParse("verified").success).toBe(false);
        });

        it("rejects the dreamer-only `list` action for primary-agent tool instances", async () => {
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            const result = await primaryTools.ctx_memory.execute({ action: "list" }, toolContext());

            expect(result).toContain("not allowed");
        });

        it("allows primary agents to use archive/update/merge (no longer dreamer-only)", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Stale fact the agent spotted mid-session.",
            });
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            // archive by a primary agent (no dreamer context) must succeed.
            const result = await primaryTools.ctx_memory.execute(
                { action: "archive", ids: [memory.id] },
                toolContext(),
            );

            expect(result).toContain("Archived memory");
        });

        it("allows dreamer sessions to use the dreamer-only `list` action on the shared tool", async () => {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Keep replies concise.",
            });
            const primaryTools = createCtxMemoryTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                allowedActions: [...PRIMARY_ACTIONS],
            });

            const result = await primaryTools.ctx_memory.execute(
                { action: "list" },
                toolContext("ses-dream", "dreamer"),
            );

            expect(result).toContain("Found 1 active memory");
        });
    });

    describe("#given content update invalidates classification", () => {
        it("an `update` to content RESETS a prior shareable=1 and clears classified_at (fail closed on re-edit)", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "PROJECT_RULES",
                content: "Historian runs as a hidden subagent.",
            });
            // The classify task (host-side) had marked it shareable + classified.
            setMemoryClassification(db, memory.id, { shareable: true, importance: 70 });
            expect(getMemoryById(db, memory.id)).toMatchObject({ shareable: 1 });
            expect(getUnclassifiedMemoryIds(db, [memory.id])).toEqual([]); // classified

            // A later content edit (primary agent) must invalidate the stale flag
            // AND clear classified_at so the changed fact is re-scored.
            const res = await tools.ctx_memory.execute(
                {
                    action: "update",
                    ids: [memory.id],
                    content: "Historian runs as a hidden subagent at endpoint 192.168.1.9.",
                },
                toolContext("ses-primary"),
            );
            expect(res).not.toContain("Error");
            expect(getMemoryById(db, memory.id)).toMatchObject({ shareable: 0 });
            expect(getUnclassifiedMemoryIds(db, [memory.id])).toEqual([memory.id]); // re-scorable
        });
    });

    describe("#given get action", () => {
        it("returns an own-project memory by id", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Always run bun before shipping.",
            });
            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [memory.id] },
                toolContext(),
            );
            expect(result).toContain(`Found 1 active memory`);
            expect(result).toContain(String(memory.id));
            expect(result).toContain("Always run bun before shipping.");
        });

        it("unwraps imitated reduced get calls without overriding real arguments", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Run the focused test suite.",
            });
            const plain = await tools.ctx_memory.execute(
                { action: "get", ids: [memory.id] },
                toolContext(),
            );
            const imitated = await tools.ctx_memory.execute(
                {
                    reduced: true,
                    summary: JSON.stringify({ action: "get", ids: [memory.id] }),
                },
                toolContext(),
            );
            const malformed = await tools.ctx_memory.execute(
                { reduced: true, summary: "not JSON" },
                toolContext(),
            );
            const realArguments = await tools.ctx_memory.execute(
                {
                    action: "get",
                    ids: [memory.id],
                    reduced: true,
                    summary: JSON.stringify({ action: "archive", ids: [memory.id] }),
                },
                toolContext(),
            );

            expect(imitated).toBe(plain);
            expect(malformed).toBe("Error: Action 'undefined' is not allowed in this context.");
            expect(realArguments).toBe(plain);
            expect(getMemoryById(db, memory.id)?.status).toBe("active");
        });

        it("labels archived rows with their status instead of hiding them", async () => {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Retired issue entry the user just referenced.",
            });
            db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(memory.id);

            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [memory.id] },
                toolContext(),
            );
            expect(result).toContain(String(memory.id));
            expect(result).toContain("archived");
            expect(result).toContain("Retired issue entry the user just referenced.");
        });

        it("surfaces a foreign shared-category memory (workspace visibility)", async () => {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
            const foreign = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "CONSTRAINTS",
                content: "Foreign shared constraint.",
            });

            db.prepare("UPDATE memories SET shareable = 1, scope = 'project' WHERE id = ?").run(
                foreign.id,
            );
            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [foreign.id] },
                toolContext(),
            );
            expect(result).toContain(String(foreign.id));
            expect(result).toContain("Foreign shared constraint.");
        });

        it("hides foreign private, archived, and expired rows in a shared category", async () => {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
            const privateMemory = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "CONSTRAINTS",
                content: "private foreign memory",
            });
            const archived = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "CONSTRAINTS",
                content: "archived foreign memory",
            });
            const expired = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "CONSTRAINTS",
                content: "expired foreign memory",
            });
            db.prepare(
                "UPDATE memories SET shareable = 1, scope = 'project', status = 'archived' WHERE id = ?",
            ).run(archived.id);
            db.prepare(
                "UPDATE memories SET shareable = 1, scope = 'project', expires_at = 0 WHERE id = ?",
            ).run(expired.id);
            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [privateMemory.id, archived.id, expired.id] },
                toolContext(),
            );
            for (const memory of [privateMemory, archived, expired]) {
                expect(result).toContain(
                    `id ${memory.id}: not found or not visible from this project`,
                );
                expect(result).not.toContain(memory.content);
            }
        });

        it("reports a foreign non-shared-category memory as not visible (no existence oracle)", async () => {
            db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
                VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, '/repo/project', 'Own', '/repo/project', 1),
                       (1, '/repo/foreign', 'Foreign', '/repo/foreign', 1);
            `);
            const foreign = insertMemory(db, {
                projectPath: "/repo/foreign",
                category: "ARCHITECTURE",
                content: "Foreign architecture hidden by the share policy.",
            });

            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [foreign.id] },
                toolContext(),
            );
            // The id must be reported as not visible, NOT as a normal hit.
            expect(result).toContain(
                `id ${foreign.id}: not found or not visible from this project`,
            );
            expect(result).not.toContain("Foreign architecture hidden by the share policy.");
        });

        it("rejects >20 ids with a clear error and emits nothing", async () => {
            const ids = Array.from({ length: 21 }, (_, i) => i + 1);
            const result = await tools.ctx_memory.execute({ action: "get", ids }, toolContext());
            expect(result).toContain("at most 20");
        });

        it("returns a per-id report mixing hits and misses in call order", async () => {
            const own = insertMemory(db, {
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Own constraint present.",
            });
            const missing = 999_999;

            const result = await tools.ctx_memory.execute(
                { action: "get", ids: [own.id, missing] },
                toolContext(),
            );
            expect(result).toContain(String(own.id));
            expect(result).toContain("Own constraint present.");
            expect(result).toContain(`id ${missing}: not found or not visible from this project`);
        });
    });
});

describe("createCtxMemoryTools on a migrated v84 database (claims kernel, U3)", () => {
    const OWN_PROJECT = "git:claims-own";
    const FOREIGN_PROJECT = "git:claims-foreign";

    let db: Database;
    let tools: ReturnType<typeof createCtxMemoryTools>;

    beforeEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        _setTestProviderFactoryForProject(null);
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        tools = createCtxMemoryTools({
            db,
            resolveProjectPath: () => OWN_PROJECT,
            memoryEnabled: true,
            embeddingEnabled: false,
        });
    });

    afterEach(() => {
        clearMemoryClaimFailpoints();
        closeQuietly(db);
    });

    function countRows(database: Database, table: string, where = "1=1"): number {
        return (
            database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as {
                count: number;
            }
        ).count;
    }

    function claimRevisionContents(database: Database, memoryId: number): string[] {
        const claim = getCurrentMemoryClaimByLegacyMemoryId(database, memoryId);
        if (!claim) return [];
        return (
            database
                .prepare("SELECT content FROM claim_revisions WHERE claim_id = ? ORDER BY revision")
                .all(claim.claimId) as Array<{ content: string }>
        ).map((row) => row.content);
    }

    it("writing the same content twice keeps one projection row and one revision while telemetry increments", async () => {
        const write = await tools.ctx_memory.execute(
            { action: "write", category: "CONSTRAINTS", content: "Use bun for scripts." },
            toolContext(),
        );
        expect(write).toContain("Saved memory [ID:");
        const [memory] = getMemoriesByProject(db, OWN_PROJECT);

        const duplicate = await tools.ctx_memory.execute(
            { action: "write", category: "CONSTRAINTS", content: "Use bun for scripts." },
            toolContext(),
        );
        expect(duplicate).toContain("Memory already exists");
        expect(duplicate).toContain("seen count incremented");

        expect(countRows(db, "memories", `project_path = '${OWN_PROJECT}'`)).toBe(1);
        expect(getMemoryById(db, memory.id)?.seenCount).toBe(2);
        expect(claimRevisionContents(db, memory.id)).toEqual(["Use bun for scripts."]);
    });

    it("updating an unlinked pre-v84 row adopts the preimage as revision 1 and the new content as revision 2", async () => {
        // An unlinked row simulates a boundary member the lazy backfill has
        // not adopted yet: a projection row with no crosswalk entry.
        let unlinkedId = 0;
        runInMemoryClaimsWriteTransaction(db, () => {
            const inserted = db
                .prepare(
                    `INSERT INTO memories (project_path, category, content, normalized_hash,
                        seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?, 'CONSTRAINTS', 'Old unlinked fact.', 'hash:old-unlinked', 1, 0, 1, 1, 1, 1)`,
                )
                .run(OWN_PROJECT);
            unlinkedId = Number(inserted.lastInsertRowid);
        });
        expect(getCurrentMemoryClaimByLegacyMemoryId(db, unlinkedId)).toBeNull();

        const result = await tools.ctx_memory.execute(
            { action: "update", ids: [unlinkedId], content: "Corrected unlinked fact." },
            toolContext(),
        );
        expect(result).toContain(`Updated memory [ID: ${unlinkedId}]`);

        expect(claimRevisionContents(db, unlinkedId)).toEqual([
            "Old unlinked fact.",
            "Corrected unlinked fact.",
        ]);
        expect(countRows(db, "claim_operations")).toBe(1);
        expect(getMemoryById(db, unlinkedId)?.content).toBe("Corrected unlinked fact.");
    });

    it("same OpenCode tool-call id replays a lost acknowledgement without duplicate tuple effects", async () => {
        const memory = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "CONSTRAINTS",
            content: "Lost acknowledgement original.",
        });
        const args = {
            action: "update" as const,
            ids: [memory.id],
            content: "Lost acknowledgement corrected.",
        };
        const context = toolContext("ses-lost-ack", "general", "tool-call-lost-ack");

        const first = await tools.ctx_memory.execute(args, context);
        const afterFirst = [
            "claim_revisions",
            "claim_operations",
            "claim_change_outbox",
            "claim_project_generations",
            "memory_mutation_log",
        ].map((table) => countRows(db, table));
        const second = await tools.ctx_memory.execute(args, context);

        expect(second).toBe(first);
        expect(
            [
                "claim_revisions",
                "claim_operations",
                "claim_change_outbox",
                "claim_project_generations",
                "memory_mutation_log",
            ].map((table) => countRows(db, table)),
        ).toEqual(afterFirst);
        expect(claimRevisionContents(db, memory.id)).toEqual([
            "Lost acknowledgement original.",
            "Lost acknowledgement corrected.",
        ]);
        expect(
            countRows(
                db,
                "claim_operations",
                `producer = 'ctx-memory-opencode' AND operation_key = 'ses-lost-ack:tool-call-lost-ack:update:${memory.id}'`,
            ),
        ).toBe(1);
        expect(
            countRows(
                db,
                "memory_mutation_log",
                `mutation_type = 'update' AND target_memory_id = ${memory.id}`,
            ),
        ).toBe(1);

        // A reused tool-call id with a different digest surfaces as a tool
        // result instead of an unhandled throw.
        expect(
            await tools.ctx_memory.execute(
                { ...args, content: "Different request under reused id." },
                context,
            ),
        ).toBe(
            "Error: this tool call id was already committed with different arguments. Retry as a new call.",
        );
    });

    it("a duplicate write with a tool-call id persists an envelope and replays without a second seen-count bump", async () => {
        const memory = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "CONSTRAINTS",
            content: "Duplicate write original.",
        });
        let syncCalls = 0;
        const syncTools = createCtxMemoryTools({
            db,
            resolveProjectPath: () => OWN_PROJECT,
            memoryEnabled: true,
            embeddingEnabled: false,
            rustToolBackends: {
                memorySync: () => {
                    syncCalls += 1;
                },
            },
        });
        const args = {
            action: "write" as const,
            category: "CONSTRAINTS" as const,
            content: "Duplicate write original.",
        };
        const context = toolContext("ses-dup-write", "general", "tool-call-dup-write");

        const first = await syncTools.ctx_memory.execute(args, context);
        expect(first).toBe(
            `Memory already exists [ID: ${memory.id}] in CONSTRAINTS (seen count incremented).`,
        );
        expect(getMemoryById(db, memory.id)?.seenCount).toBe(2);
        expect(syncCalls).toBe(1);
        expect(
            countRows(
                db,
                "claim_operations",
                "producer = 'ctx-memory-opencode' AND operation_key = 'ses-dup-write:tool-call-dup-write:write'",
            ),
        ).toBe(1);

        const replay = await syncTools.ctx_memory.execute(args, context);
        expect(replay).toBe(first);
        expect(getMemoryById(db, memory.id)?.seenCount).toBe(2);
        expect(syncCalls).toBe(1);
    });

    it("update replay returns the stored result after the target row is archived", async () => {
        const memory = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "CONSTRAINTS",
            content: "Replay update original.",
        });
        const args = {
            action: "update" as const,
            ids: [memory.id],
            content: "Replay update corrected.",
        };
        const context = toolContext("ses-replay-update", "general", "tool-call-replay-update");

        const first = await tools.ctx_memory.execute(args, context);
        expect(first).toBe(`Updated memory [ID: ${memory.id}] in CONSTRAINTS.`);

        const archived = await tools.ctx_memory.execute(
            { action: "archive", ids: [memory.id] },
            toolContext(),
        );
        expect(archived).toContain("Archived memory");

        const operationsBefore = countRows(db, "claim_operations");
        const replay = await tools.ctx_memory.execute(args, context);
        expect(replay).toBe(first);
        expect(countRows(db, "claim_operations")).toBe(operationsBefore);
        expect(getMemoryById(db, memory.id)?.status).toBe("archived");
    });

    it("merge replay returns the stored result after a source memory is deleted", async () => {
        const first = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "CONSTRAINTS",
            content: "Merge replay source one.",
        });
        const second = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "CONSTRAINTS",
            content: "Merge replay source two.",
        });
        const args = {
            action: "merge" as const,
            ids: [first.id, second.id],
            category: "CONSTRAINTS" as const,
            content: "Merge replay canonical.",
        };
        const context = toolContext("ses-replay-merge", "general", "tool-call-replay-merge");

        const merged = await tools.ctx_memory.execute(args, context);
        expect(merged).toContain("Merged memories");

        deleteMemory(db, first.id);
        expect(getMemoryById(db, first.id)).toBeNull();

        const replay = await tools.ctx_memory.execute(args, context);
        expect(replay).toBe(merged);
    });

    it("merge replay works without a category argument after every source is hard-deleted", async () => {
        const first = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "CONSTRAINTS",
            content: "Merge replay derived-category source one.",
        });
        const second = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "CONSTRAINTS",
            content: "Merge replay derived-category source two.",
        });
        // No `category`: the first run derives it from the sources; the
        // replay identity must not depend on that derivation.
        const args = {
            action: "merge" as const,
            ids: [first.id, second.id],
            content: "Merge replay derived-category canonical.",
        };
        const context = toolContext(
            "ses-replay-merge-derived",
            "general",
            "tool-call-replay-merge-derived",
        );

        const merged = await tools.ctx_memory.execute(args, context);
        expect(merged).toContain("Merged memories");
        expect(merged).toContain("in CONSTRAINTS");

        deleteMemory(db, first.id);
        deleteMemory(db, second.id);
        expect(getMemoryById(db, first.id)).toBeNull();
        expect(getMemoryById(db, second.id)).toBeNull();

        const replay = await tools.ctx_memory.execute(args, context);
        expect(replay).toBe(merged);
    });

    it("two connections replay stable merges before mutating existing or fresh canonicals", async () => {
        for (const existingCanonical of [true, false]) {
            closeQuietly(db);
            _resetProjectEmbeddingRegistryForTests();
            const dir = mkdtempSync(join(tmpdir(), "ctx-memory-merge-race-"));
            const path = join(dir, "context.db");
            db = new Database(path);
            initializeDatabase(db);
            runMigrations(db);
            db.exec("PRAGMA busy_timeout=1000");
            const peer = new Database(path);
            peer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
            try {
                const first = insertMemory(db, {
                    projectPath: OWN_PROJECT,
                    category: "CONSTRAINTS",
                    content: `stable merge first ${existingCanonical}`,
                });
                const second = insertMemory(db, {
                    projectPath: OWN_PROJECT,
                    category: "CONSTRAINTS",
                    content: `stable merge second ${existingCanonical}`,
                });
                const content = existingCanonical
                    ? first.content
                    : `stable merge fresh canonical ${existingCanonical}`;
                let embeddingCalls = 0;
                let syncCalls = 0;
                installTestEmbeddingProvider(async () => {
                    embeddingCalls += 1;
                    return new Float32Array([1, 0]);
                });
                registerMemoryEmbeddingsForProject(db, OWN_PROJECT);
                const deps = {
                    resolveProjectPath: () => OWN_PROJECT,
                    memoryEnabled: true,
                    embeddingEnabled: true,
                    rustToolBackends: {
                        memorySync: () => {
                            syncCalls += 1;
                        },
                    },
                };
                const winningTools = createCtxMemoryTools({ ...deps, db: peer });
                const args = {
                    action: "merge" as const,
                    ids: [first.id, second.id],
                    category: "CONSTRAINTS" as const,
                    content,
                };
                const context = toolContext(
                    "ses-stable-merge",
                    DREAMER_AGENT,
                    `stable-merge-${existingCanonical}`,
                );

                const winner = await winningTools.ctx_memory.execute(args, context);
                for (
                    let attempt = 0;
                    countRows(db, "memory_embeddings") === 0 && attempt < 20;
                    attempt += 1
                ) {
                    await wait(5);
                }
                const tables = [
                    "claim_revisions",
                    "claim_operations",
                    "claim_change_outbox",
                    "claim_project_generations",
                    "memory_mutation_log",
                    "memory_embeddings",
                ];
                const afterWinner = tables.map((table) => countRows(db, table));

                const staleTools = createCtxMemoryTools({
                    ...deps,
                    db: hideFirstClaimOperationRead(db),
                });
                const replay = await staleTools.ctx_memory.execute(args, context);

                expect(replay).toBe(winner);
                expect(tables.map((table) => countRows(db, table))).toEqual(afterWinner);
                expect(embeddingCalls).toBe(1);
                expect(syncCalls).toBe(1);
                expect(
                    countRows(
                        db,
                        "claim_operations",
                        `producer = 'ctx-memory-opencode' AND operation_key = 'ses-stable-merge:stable-merge-${existingCanonical}:merge:2'`,
                    ),
                ).toBe(1);
                expect(
                    await staleTools.ctx_memory.execute(
                        { ...args, content: `${content} digest mismatch` },
                        context,
                    ),
                ).toBe(
                    "Error: this tool call id was already committed with different arguments. Retry as a new call.",
                );
            } finally {
                closeQuietly(peer);
                closeQuietly(db);
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it("archive with and without a reason commits claim retirement, projection, mutation log, outbox, and generation together", async () => {
        const withReason = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "KNOWN_ISSUES",
            content: "Old issue entry.",
        });
        const withoutReason = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "KNOWN_ISSUES",
            content: "Other issue entry.",
        });
        const outboxBefore = countRows(db, "claim_change_outbox");
        const generationBefore =
            (
                db
                    .prepare("SELECT MAX(generation) AS generation FROM claim_project_generations")
                    .get() as { generation: number | null }
            ).generation ?? 0;

        const first = await tools.ctx_memory.execute(
            { action: "archive", ids: [withReason.id], reason: "Subsystem removed" },
            toolContext(),
        );
        expect(first).toContain("Archived memory");
        const second = await tools.ctx_memory.execute(
            { action: "archive", ids: [withoutReason.id] },
            toolContext(),
        );
        expect(second).toContain("Archived memory");

        for (const memoryId of [withReason.id, withoutReason.id]) {
            const claim = getCurrentMemoryClaimByLegacyMemoryId(db, memoryId);
            expect(claim?.state).toBe("archived");
            expect(getMemoryById(db, memoryId)?.status).toBe("archived");
            const archiveEvents = countRows(
                db,
                "verification_events",
                `outcome = 'archive' AND revision_id = ${claim?.revisionId}`,
            );
            expect(archiveEvents).toBe(1);
        }
        expect(getMemoryById(db, withReason.id)?.metadataJson).toContain("Subsystem removed");
        expect(getMemoryById(db, withoutReason.id)?.metadataJson).toBeNull();
        expect(getMutationRows(db, OWN_PROJECT, [withReason.id, withoutReason.id])).toMatchObject([
            { mutationType: "archive", targetMemoryId: withReason.id },
            { mutationType: "archive", targetMemoryId: withoutReason.id },
        ]);
        expect(
            countRows(db, "claim_change_outbox", "effect_type = 'lifecycle'"),
        ).toBeGreaterThanOrEqual(2);
        // The reasoned archive rewrites metadata_json, which appends a revision
        // and an upsert effect alongside its lifecycle effect; the reasonless
        // archive emits a lifecycle effect only.
        expect(countRows(db, "claim_change_outbox")).toBe(outboxBefore + 3);
        const generationAfter = (
            db
                .prepare("SELECT MAX(generation) AS generation FROM claim_project_generations")
                .get() as { generation: number | null }
        ).generation as number;
        expect(generationAfter).toBe(generationBefore + 2);
    });

    it("same-project merge preserves stats policy, records supersession, and retires sources", async () => {
        const first = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "CONSTRAINTS",
            content: "Use bun for scripts",
        });
        const second = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "CONSTRAINTS",
            content: "Use bun for all scripts in this repo",
        });

        const result = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [first.id, second.id],
                content: "Use bun for all scripts in this repository.",
            },
            toolContext("ses-dreamer", DREAMER_AGENT),
        );
        expect(result).toContain("Merged memories");
        expect(result).toContain(`superseded [${first.id}, ${second.id}]`);

        const [canonical] = getMemoriesByProject(db, OWN_PROJECT);
        expect(canonical.seenCount).toBe(2);
        expect(canonical.mergedFrom).toBe(JSON.stringify([first.id, second.id]));
        const canonicalClaim = getCurrentMemoryClaimByLegacyMemoryId(db, canonical.id);
        expect(canonicalClaim?.state).toBe("active");
        for (const sourceId of [first.id, second.id]) {
            const sourceClaim = getCurrentMemoryClaimByLegacyMemoryId(db, sourceId);
            expect(sourceClaim?.state).toBe("archived");
            expect(
                countRows(
                    db,
                    "claim_conflicts",
                    `relation = 'supersedes' AND right_revision_id = ${sourceClaim?.revisionId}`,
                ),
            ).toBe(1);
        }
        expect(countRows(db, "claim_merge_lineage")).toBe(0);
    });

    it("a dreamer cross-project merge records only audit lineage; a primary merge of a foreign memory is refused", async () => {
        db.exec(`
            INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
            VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, '${OWN_PROJECT}', 'Own', 'own', 1),
                   (1, '${FOREIGN_PROJECT}', 'Foreign', 'foreign', 1);
        `);
        const own = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "CONSTRAINTS",
            content: "Own constraint.",
        });
        const foreign = insertMemory(db, {
            projectPath: FOREIGN_PROJECT,
            category: "CONSTRAINTS",
            content: "Foreign shared constraint.",
        });
        runInMemoryClaimsWriteTransaction(db, () => {
            db.prepare("UPDATE memories SET shareable = 1, scope = 'project' WHERE id = ?").run(
                foreign.id,
            );
        });

        const refused = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreign.id],
                content: "Merged across projects.",
                category: "CONSTRAINTS",
            },
            toolContext(),
        );
        expect(refused).toContain("Error");
        expect(countRows(db, "claim_merge_lineage")).toBe(0);
        expect(getMemoryById(db, foreign.id)?.status).toBe("active");

        const merged = await tools.ctx_memory.execute(
            {
                action: "merge",
                ids: [own.id, foreign.id],
                content: "Merged across projects.",
                category: "CONSTRAINTS",
            },
            toolContext("ses-dreamer", DREAMER_AGENT),
        );
        expect(merged).toContain("Merged memories");

        const foreignClaim = getCurrentMemoryClaimByLegacyMemoryId(db, foreign.id);
        expect(foreignClaim?.state).toBe("archived");
        expect(
            countRows(
                db,
                "claim_merge_lineage",
                `source_revision_id = ${foreignClaim?.revisionId}`,
            ),
        ).toBe(1);
        expect(
            countRows(
                db,
                "claim_conflicts",
                `relation = 'supersedes' AND right_revision_id = ${foreignClaim?.revisionId}`,
            ),
        ).toBe(0);
    });

    it("a mid-operation failure leaves claims, projection, mutation log, outbox, and generations at pre-operation values", async () => {
        const memory = insertMemory(db, {
            projectPath: OWN_PROJECT,
            category: "KNOWN_ISSUES",
            content: "Issue to archive.",
        });
        const tables = [
            "memories",
            "claims",
            "claim_revisions",
            "claim_operations",
            "claim_change_outbox",
            "claim_project_generations",
            "verification_events",
            "memory_mutation_log",
        ];
        const before = tables.map((table) => countRows(db, table));

        setMemoryClaimFailpoint("memory-claim.020.projection.after", () => {
            throw new Error("injected projection failure");
        });
        await expect(
            tools.ctx_memory.execute(
                { action: "archive", ids: [memory.id], reason: "will fail" },
                toolContext(),
            ),
        ).rejects.toThrow("injected projection failure");
        clearMemoryClaimFailpoints();

        expect(tables.map((table) => countRows(db, table))).toEqual(before);
        expect(getMemoryById(db, memory.id)?.status).toBe("active");
        const claim = getCurrentMemoryClaimByLegacyMemoryId(db, memory.id);
        expect(claim?.state).toBe("active");
        expect(getMemoryById(db, memory.id)?.metadataJson).toBeNull();
    });
});
