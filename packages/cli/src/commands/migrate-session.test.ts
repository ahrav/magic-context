import { afterEach, describe, expect, it } from "bun:test";
import {
    AUTHORITY_DOMAINS,
    type AuthorityState,
} from "@magic-context/core/features/magic-context/context-authority";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { seedProjectMemoryClaim } from "@magic-context/core/features/magic-context/test-claim-database";
import { createDirectTestDatabase } from "@magic-context/core/features/magic-context/test-database";
import { Database } from "@magic-context/core/shared/sqlite";

import {
    applyMigrateSession,
    assertMigrateSessionIsSafeToRehome,
    type MigrateSessionDeps,
    type MigrateSessionSafetyModule,
    planMigrateSession,
} from "./migrate-session";

const databases: Array<{ close(): void }> = [];

afterEach(() => {
    for (const db of databases) {
        try {
            db.close();
        } catch {
            /* ignore */
        }
    }
    databases.length = 0;
});

function makeOpencodeDb(): Database {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(`
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            directory TEXT,
            path TEXT,
            workspace_id TEXT,
            title TEXT
        );
        CREATE TABLE project (
            id TEXT PRIMARY KEY,
            worktree TEXT NOT NULL
        );
    `);
    db.prepare("INSERT INTO project (id, worktree) VALUES ('global', '/')").run();
    return db;
}

function makeContextDb(): Database {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(`
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            normalized_hash TEXT NOT NULL,
            importance INTEGER,
            source_session_id TEXT,
            source_type TEXT DEFAULT 'historian',
            seen_count INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active',
            created_at INTEGER NOT NULL DEFAULT 0,
            UNIQUE(project_path, category, normalized_hash)
        );
        CREATE TABLE memory_embeddings (
            memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
            embedding BLOB NOT NULL,
            model_id TEXT
        );
        CREATE TABLE session_projects (
            session_id TEXT NOT NULL,
            harness TEXT NOT NULL DEFAULT 'opencode',
            project_path TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(session_id, harness)
        );
        CREATE TABLE compartment_chunk_embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            project_path TEXT NOT NULL
        );
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            cached_m0_bytes BLOB,
            cached_m1_bytes BLOB
        );
        CREATE TABLE project_state (
            project_path TEXT PRIMARY KEY,
            project_memory_epoch INTEGER NOT NULL DEFAULT 0,
            project_user_profile_version INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE authority_managed (
            project_path TEXT PRIMARY KEY,
            context_store_uuid TEXT NOT NULL,
            marked_at INTEGER NOT NULL
        );
    `);
    return db;
}

let hashCounter = 0;
function insertMemory(
    db: Database,
    projectPath: string,
    sourceSessionId: string | null,
    opts: { status?: string; category?: string; content?: string; withEmbedding?: boolean } = {},
): number {
    const content = opts.content ?? `memory-${++hashCounter}`;
    const hash = `hash-${hashCounter}`;
    const res = db
        .prepare(
            `INSERT INTO memories (project_path, category, content, normalized_hash, importance, source_session_id, source_type, seen_count, status, created_at)
             VALUES (?, ?, ?, ?, 50, ?, 'historian', 1, ?, 0)`,
        )
        .run(
            projectPath,
            opts.category ?? "ARCHITECTURE",
            content,
            hash,
            sourceSessionId,
            opts.status ?? "active",
        ) as { lastInsertRowid: number | bigint };
    const id = Number(res.lastInsertRowid);
    if (opts.withEmbedding) {
        db.prepare(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, 'm')",
        ).run(id, new Uint8Array([1, 2, 3]));
    }
    return id;
}

const FROM = "git:from";
const TO = "git:to";
const SID = "ses_test";
const OTHER_SID = "ses_other";

function seedSession(oc: Database, ctx: Database): void {
    oc.prepare(
        "INSERT INTO session (id, project_id, directory, path) VALUES (?, 'global', '/old/dir', 'old/dir')",
    ).run(SID);
    ctx.prepare(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, 0)",
    ).run(SID, FROM);
    ctx.prepare(
        "INSERT INTO compartment_chunk_embeddings (session_id, project_path) VALUES (?, ?)",
    ).run(SID, FROM);
    ctx.prepare(
        "INSERT INTO compartment_chunk_embeddings (session_id, project_path) VALUES (?, ?)",
    ).run(SID, FROM);
    ctx.prepare("INSERT INTO session_meta (session_id, cached_m0_bytes) VALUES (?, ?)").run(
        SID,
        new Uint8Array([9]),
    );
}

function makeDeps(oc: Database, ctx: Database, targetIsGit = true): MigrateSessionDeps {
    return {
        opencodeDb: oc,
        contextDb: ctx,
        resolveIdentity: (dir) => (dir.includes("benchmarks") ? TO : FROM),
        hasGitDir: () => targetIsGit,
        realpath: (p) => p,
        now: 1000,
    };
}

function installAuthorityMarker(ctx: Database, projectPath: string): void {
    ctx.prepare(
        "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?, 'store-test', 0)",
    ).run(projectPath);
}

function makeSafetyModule(
    opts: {
        authorityState?: Partial<Record<(typeof AUTHORITY_DOMAINS)[number], AuthorityState>>;
        authorityError?: Error;
        sessionStatus?: unknown | Error;
    } = {},
): {
    module: MigrateSessionSafetyModule;
    authorityCalls: Array<{ project: string; projectRoot?: string; domain: string }>;
    sessionCalls: Array<{ sessionId: string; projectRoot: string }>;
} {
    const authorityCalls: Array<{ project: string; projectRoot?: string; domain: string }> = [];
    const sessionCalls: Array<{ sessionId: string; projectRoot: string }> = [];
    return {
        module: {
            async authorityStatus({ context_store_uuid, project, projectRoot, domain }) {
                authorityCalls.push({ project, projectRoot, domain });
                if (opts.authorityError) throw opts.authorityError;
                const state = opts.authorityState?.[domain] ?? "TS";
                return {
                    authority: {
                        context_store_uuid,
                        project,
                        domain,
                        state,
                        generation: 1,
                    },
                };
            },
            async sessionStatus(args) {
                sessionCalls.push(args);
                if (opts.sessionStatus instanceof Error) throw opts.sessionStatus;
                return opts.sessionStatus ?? { row_version: null };
            },
        },
        authorityCalls,
        sessionCalls,
    };
}

describe("planMigrateSession", () => {
    it("resolves a git target to its existing project row", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('proj_bench', ?)").run(
            "/home/u/benchmarks",
        );
        seedSession(oc, ctx);
        insertMemory(ctx, FROM, SID);
        insertMemory(ctx, FROM, OTHER_SID);

        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, true));
        expect(plan.ocProjectId).toBe("proj_bench");
        expect(plan.ocWorktree).toBe("/home/u/benchmarks");
        expect(plan.ocProjectResolvedFromRow).toBe(true);
        expect(plan.sessionPath).toBe(""); // relative(worktree, dir) when equal
        expect(plan.fromMcIdentity).toBe(FROM);
        expect(plan.toMcIdentity).toBe(TO);
    });

    it("falls back to global (with flag) when a git target has no registered project (empty repo)", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        seedSession(oc, ctx);
        // hasGitDir=true but no per-worktree project row → OpenCode would use
        // global (empty repo, no commit/remote). Must NOT dead-end.
        const plan = planMigrateSession(SID, "/home/u/unregistered", makeDeps(oc, ctx, true));
        expect(plan.ocProjectId).toBe("global");
        expect(plan.targetIsGit).toBe(true);
        expect(plan.ocProjectResolvedFromRow).toBe(false);
    });

    it("resolves a non-git target to the global project", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        seedSession(oc, ctx);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, false));
        expect(plan.ocProjectId).toBe("global");
        expect(plan.ocWorktree).toBe("/");
        expect(plan.sessionPath).toBe("home/u/benchmarks");
        expect(plan.targetIsGit).toBe(false);
    });

    it("throws for an unknown session", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        expect(() => planMigrateSession("ses_nope", "/x", makeDeps(oc, ctx))).toThrow(/not found/);
    });
});

describe("assertMigrateSessionIsSafeToRehome", () => {
    function safetyPlan(ctx: Database): ReturnType<typeof planMigrateSession> {
        const oc = makeOpencodeDb();
        seedSession(oc, ctx);
        return planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
    }

    for (const [role, projectPath] of [
        ["source", FROM],
        ["target", TO],
    ] as const) {
        for (const domain of AUTHORITY_DOMAINS) {
            it(`refuses ${domain} module authority for the ${role} project`, async () => {
                const ctx = makeContextDb();
                installAuthorityMarker(ctx, projectPath);
                const plan = safetyPlan(ctx);
                const { module } = makeSafetyModule({ authorityState: { [domain]: "MODULE" } });

                await expect(
                    assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module }),
                ).rejects.toThrow(new RegExp(`${domain} authority.*MODULE`));
            });
        }
    }

    it("checks a durable source marker even when the source is outside the current cwd", async () => {
        const ctx = makeContextDb();
        installAuthorityMarker(ctx, FROM);
        const plan = safetyPlan(ctx);
        const { module, authorityCalls } = makeSafetyModule({
            authorityState: { memories: "DRAINING" },
        });

        await expect(
            assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module }),
        ).rejects.toThrow(/drain-authority \/old\/dir/);
        expect(authorityCalls).toContainEqual(
            expect.objectContaining({ project: FROM, projectRoot: "/old/dir" }),
        );
    });

    it("refuses an unreachable module when a durable marker exists", async () => {
        const ctx = makeContextDb();
        installAuthorityMarker(ctx, TO);
        const plan = safetyPlan(ctx);
        const { module } = makeSafetyModule({ authorityError: new Error("subc offline") });

        await expect(
            assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module }),
        ).rejects.toThrow(/module unreachable.*writes remain fenced.*drain-authority/i);
    });

    it("refuses an unreachable session.status probe when a marker exists", async () => {
        const ctx = makeContextDb();
        installAuthorityMarker(ctx, TO);
        const plan = safetyPlan(ctx);
        const { module } = makeSafetyModule({ sessionStatus: new Error("subc offline") });

        await expect(
            assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module }),
        ).rejects.toThrow(
            /session-cache state is unreachable.*writes remain fenced.*drain-authority/i,
        );
    });

    it("warns but proceeds when session.status is unreachable and no markers exist", async () => {
        const ctx = makeContextDb();
        const plan = safetyPlan(ctx);
        const { module } = makeSafetyModule({ sessionStatus: new Error("subc offline") });

        const result = await assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module });
        expect(result.warnings).toEqual([
            expect.stringContaining("session-cache state was not checked"),
        ]);
    });

    it("refuses a session with module transform cache state without deleting it", async () => {
        const ctx = makeContextDb();
        const plan = safetyPlan(ctx);
        const { module, sessionCalls } = makeSafetyModule({ sessionStatus: { row_version: 7 } });

        await expect(
            assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module }),
        ).rejects.toThrow(/transform cache state.*TypeScript transform mode.*ck session delete/i);
        expect(sessionCalls).toEqual([{ sessionId: SID, projectRoot: "/old/dir" }]);
    });

    it("allows a TypeScript-authority migration to apply as before", async () => {
        const ctx = makeContextDb();
        const oc = makeOpencodeDb();
        seedSession(oc, ctx);
        installAuthorityMarker(ctx, FROM);
        installAuthorityMarker(ctx, TO);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        const { module, authorityCalls } = makeSafetyModule();

        await expect(
            assertMigrateSessionIsSafeToRehome({ plan, contextDb: ctx, module }),
        ).resolves.toEqual({
            warnings: [],
        });
        applyMigrateSession(plan, makeDeps(oc, ctx));
        expect(
            (
                ctx
                    .prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
                    .get(SID) as { project_path: string }
            ).project_path,
        ).toBe(TO);
        expect(authorityCalls).toHaveLength(AUTHORITY_DOMAINS.length * 2);
    });
});

describe("applyMigrateSession — OpenCode + context re-stamp", () => {
    it("updates the session row and re-stamps context.db, clearing cached m0/m1", () => {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('proj_bench', ?)").run(
            "/home/u/benchmarks",
        );
        seedSession(oc, ctx);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, true));
        const res = applyMigrateSession(plan, makeDeps(oc, ctx, true));

        const session = oc.prepare("SELECT * FROM session WHERE id = ?").get(SID) as {
            project_id: string;
            directory: string;
            path: string;
            workspace_id: string | null;
        };
        expect(session.project_id).toBe("proj_bench");
        expect(session.directory).toBe("/home/u/benchmarks");
        expect(session.workspace_id).toBeNull();

        const ownership = ctx
            .prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
            .get(SID) as { project_path: string };
        expect(ownership.project_path).toBe(TO);
        expect(res.chunkEmbeddingsRestamped).toBe(2);
        const remainingOldChunks = (
            ctx
                .prepare(
                    "SELECT COUNT(*) AS c FROM compartment_chunk_embeddings WHERE session_id = ? AND project_path = ?",
                )
                .get(SID, FROM) as { c: number }
        ).c;
        expect(remainingOldChunks).toBe(0);
        const meta = ctx
            .prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?")
            .get(SID) as { cached_m0_bytes: unknown };
        expect(meta.cached_m0_bytes).toBeNull();
        expect(res.dryRun).toBe(false);
    });

    it("only updates session columns that exist (schema-resilient)", () => {
        const oc = new Database(":memory:");
        databases.push(oc);
        oc.exec(
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);",
        );
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('global', '/')").run();
        oc.prepare("INSERT INTO session (id, directory) VALUES (?, '/old')").run(SID);
        const ctx = makeContextDb();
        ctx.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, 0)",
        ).run(SID, FROM);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx, false));
        // Must not throw even though project_id/path/workspace_id columns are absent.
        applyMigrateSession(plan, makeDeps(oc, ctx, false));
        const row = oc.prepare("SELECT directory FROM session WHERE id = ?").get(SID) as {
            directory: string;
        };
        expect(row.directory).toBe("/home/u/benchmarks");
    });
});

describe("applyMigrateSession — memory actions", () => {
    function setup(): { oc: Database; ctx: Database } {
        const oc = makeOpencodeDb();
        const ctx = makeContextDb();
        oc.prepare("INSERT INTO project (id, worktree) VALUES ('proj_bench', ?)").run(
            "/home/u/benchmarks",
        );
        seedSession(oc, ctx);
        return { oc, ctx };
    }

    it("scenario 7: session re-home leaves project memory rows and embeddings unchanged", () => {
        const { oc, ctx } = setup();
        insertMemory(ctx, FROM, SID, { withEmbedding: true });
        insertMemory(ctx, FROM, OTHER_SID);
        const before = {
            memories: ctx.prepare("SELECT * FROM memories ORDER BY id").all(),
            embeddings: ctx.prepare("SELECT * FROM memory_embeddings ORDER BY memory_id").all(),
            projectState: ctx.prepare("SELECT * FROM project_state ORDER BY project_path").all(),
        };
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));

        applyMigrateSession(plan, makeDeps(oc, ctx));

        expect({
            memories: ctx.prepare("SELECT * FROM memories ORDER BY id").all(),
            embeddings: ctx.prepare("SELECT * FROM memory_embeddings ORDER BY memory_id").all(),
            projectState: ctx.prepare("SELECT * FROM project_state ORDER BY project_path").all(),
        }).toEqual(before);
        expect(
            ctx.prepare("SELECT project_path FROM session_projects WHERE session_id = ?").get(SID),
        ).toEqual({ project_path: TO });
    });

    it("compensates the OpenCode move when the context.db transaction fails (no split-brain)", () => {
        const { oc, ctx } = setup();
        // Force the context.db transaction to throw AFTER the OpenCode commit by
        // dropping a table its transaction writes to.
        ctx.exec("DROP TABLE compartment_chunk_embeddings");
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        expect(() => applyMigrateSession(plan, makeDeps(oc, ctx))).toThrow();
        // OpenCode must be restored to its pre-migration values.
        const session = oc
            .prepare("SELECT directory, project_id FROM session WHERE id = ?")
            .get(SID) as { directory: string; project_id: string };
        expect(session.directory).toBe("/old/dir");
        expect(session.project_id).toBe("global");
    });

    it("refuses to apply when the OpenCode session row is missing (no half-migration)", () => {
        const { oc, ctx } = setup();
        const plan = planMigrateSession(SID, "/home/u/benchmarks", makeDeps(oc, ctx));
        // Session vanishes between plan and apply (e.g. deleted while we worked).
        oc.prepare("DELETE FROM session WHERE id = ?").run(SID);
        expect(() => applyMigrateSession(plan, makeDeps(oc, ctx))).toThrow(/not found/i);
        // Context.db must be untouched — ownership stays on the source identity.
        const ownership = ctx
            .prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
            .get(SID) as { project_path: string };
        expect(ownership.project_path).toBe(FROM);
    });
});

describe("applyMigrateSession — direct claims", () => {
    it("scenario 7: re-homes session runtime without remapping durable claim identity", () => {
        const oc = makeOpencodeDb();
        const ctx = createDirectTestDatabase().db;
        databases.push(ctx);
        initializeDatabase(ctx);
        oc.prepare(
            "INSERT INTO session (id, project_id, directory, path) VALUES (?, 'global', '/old/dir', 'old/dir')",
        ).run(SID);
        ctx.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, 0)",
        ).run(SID, FROM);
        seedProjectMemoryClaim(ctx, {
            projectIdentity: FROM,
            content: "Session provenance stays durable.",
            operationKey: "u7-session-rehome",
            provenance: { sourceSessionId: SID },
        });
        const before = {
            claims: ctx.prepare("SELECT * FROM claims ORDER BY id").all(),
            revisions: ctx.prepare("SELECT * FROM claim_revisions ORDER BY id").all(),
            evidence: ctx
                .prepare("SELECT * FROM claim_evidence ORDER BY revision_id, observation_id")
                .all(),
            receipts: ctx.prepare("SELECT * FROM claim_operation_receipts ORDER BY id").all(),
            derivations: ctx.prepare("SELECT * FROM claim_derivations ORDER BY id").all(),
            generations: ctx
                .prepare("SELECT * FROM claim_project_generations ORDER BY project_id")
                .all(),
        };

        const deps = makeDeps(oc, ctx);
        const plan = planMigrateSession(SID, "/home/u/benchmarks", deps);
        applyMigrateSession(plan, deps);

        expect(
            ctx.prepare("SELECT project_path FROM session_projects WHERE session_id = ?").get(SID),
        ).toEqual({ project_path: TO });
        expect({
            claims: ctx.prepare("SELECT * FROM claims ORDER BY id").all(),
            revisions: ctx.prepare("SELECT * FROM claim_revisions ORDER BY id").all(),
            evidence: ctx
                .prepare("SELECT * FROM claim_evidence ORDER BY revision_id, observation_id")
                .all(),
            receipts: ctx.prepare("SELECT * FROM claim_operation_receipts ORDER BY id").all(),
            derivations: ctx.prepare("SELECT * FROM claim_derivations ORDER BY id").all(),
            generations: ctx
                .prepare("SELECT * FROM claim_project_generations ORDER BY project_id")
                .all(),
        }).toEqual(before);
    });
});
