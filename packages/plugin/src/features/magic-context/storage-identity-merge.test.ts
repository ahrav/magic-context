import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { partitionVerifyScope } from "./dreamer/verify-gate";
import { createSourceSpan } from "./memory/storage-claims";
import {
    deleteMemory,
    insertMemory as insertMemoryThroughKernel,
    updateMemoryStatus,
} from "./memory/storage-memory";
import {
    getCurrentMemoryClaimByLegacyMemoryId,
    memoryClaimSupersessionExists,
    readMemoryClaimLink,
    runInMemoryClaimsWriteTransaction,
} from "./memory/storage-memory-claims";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { auditIdentityMerge, mergeProjectIdentities } from "./storage-identity-merge";

let db: Database | null = null;

function makeDb(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function insertMemory(
    database: Database,
    projectPath: string,
    content: string,
    hash: string,
): number {
    return runInMemoryClaimsWriteTransaction(database, () => {
        const result = database
            .prepare(
                `INSERT INTO memories
                (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?, 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`,
            )
            .run(projectPath, content, hash) as { lastInsertRowid?: number };
        return Number(result.lastInsertRowid);
    });
}

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("project identity merge", () => {
    test("dry-run audits schema-scoped tables without writing", () => {
        const database = makeDb();
        insertMemory(database, "dir:old", "old", "old-hash");
        database.prepare("INSERT INTO project_state(project_path) VALUES (?)").run("dir:old");

        const report = mergeProjectIdentities(database, "dir:old", "git:new", { dryRun: true });

        expect(report.dryRun).toBe(true);
        expect(report.auditedTables.map((table) => table.tableName)).toContain("memories");
        expect(report.auditedTables.map((table) => table.tableName)).toContain("project_state");
        expect(report.changedRows).toBe(2);
        expect(database.prepare("SELECT COUNT(*) AS count FROM identity_merge_log").get()).toEqual({
            count: 0,
        });
        expect(database.prepare("SELECT project_path FROM memories").get()).toEqual({
            project_path: "dir:old",
        });
    });

    test("rekeys audited rows, supersedes memory collisions, bumps epoch, and logs each mutation", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "legacy", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        database
            .prepare("INSERT INTO project_state(project_path, project_memory_epoch) VALUES (?, 4)")
            .run("git:new");
        database
            .prepare(
                "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run("ses-old", "opencode", "dir:old", 1);
        database
            .prepare(
                "INSERT INTO git_commits(sha, project_path, short_sha, message, committed_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run("sha-old", "dir:old", "sha-old", "legacy commit", 1, 1);

        const report = mergeProjectIdentities(database, "dir:old", "git:new", { now: 10 });

        expect(report.changedRows).toBeGreaterThanOrEqual(4);
        expect(
            database
                .prepare(
                    "SELECT project_path, status, superseded_by_memory_id FROM memories WHERE id = ?",
                )
                .get(sourceId),
        ).toEqual({
            project_path: "dir:old",
            status: "archived",
            superseded_by_memory_id: targetId,
        });
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memories WHERE project_path = 'git:new'")
                .get(),
        ).toEqual({
            count: 1,
        });
        expect(
            database
                .prepare("SELECT project_path FROM session_projects WHERE session_id = 'ses-old'")
                .get(),
        ).toEqual({
            project_path: "git:new",
        });
        expect(
            database.prepare("SELECT project_path FROM git_commits WHERE sha = 'sha-old'").get(),
        ).toEqual({
            project_path: "git:new",
        });
        expect(
            database
                .prepare(
                    "SELECT project_memory_epoch FROM project_state WHERE project_path = 'git:new'",
                )
                .get(),
        ).toEqual({
            project_memory_epoch: 5,
        });
        expect(database.prepare("SELECT COUNT(*) AS count FROM identity_merge_log").get()).toEqual({
            count: report.changedRows,
        });
    });

    test("preserves the oldest open broad cycle when task schedule rows collide", async () => {
        const database = makeDb();
        insertMemory(database, "dir:old", "legacy", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                 VALUES (?, 'src/banked.ts', 150, 150)`,
                )
                .run(targetId);
        });
        database
            .prepare(
                `INSERT INTO task_schedule_state
                    (project_path, task, last_run_at, next_due_at, schedule, last_status,
                     retry_count, last_broad_run_at)
                 VALUES (?, 'verify-broad', 50, 60, 'old', 'completed', 0, 100)`,
            )
            .run("dir:old");
        database
            .prepare(
                `INSERT INTO task_schedule_state
                    (project_path, task, last_run_at, next_due_at, schedule, last_status,
                     retry_count, last_broad_run_at)
                 VALUES (?, 'verify-broad', 200, 210, 'new', 'completed', 0, NULL)`,
            )
            .run("git:new");

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 250 });

        expect(
            database
                .prepare(
                    `SELECT last_run_at, last_broad_run_at
                       FROM task_schedule_state
                      WHERE project_path = 'git:new' AND task = 'verify-broad'`,
                )
                .get(),
        ).toEqual({ last_run_at: 200, last_broad_run_at: 100 });
        const gate = await partitionVerifyScope({
            db: database,
            projectIdentity: "git:new",
            projectDirectory: process.cwd(),
            forceBroad: true,
            now: 300,
        });
        expect(gate.broadCycleStartAt).toBe(100);
        expect(gate.inScopeIds).toEqual([]);
        expect(gate.skippedIds).toEqual([targetId]);
    });

    test("moves newer classification, mural cue, and verifications to a collision survivor", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "legacy", "same-hash");
        const targetId = insertMemory(database, "git:new", "canonical", "same-hash");
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    `UPDATE memories
                    SET importance = 91, scope = 'ecosystem', shareable = 1, classified_at = 20,
                        mural_cue = 'new cue', mural_cue_hash = 'cue-hash', mural_cue_at = 30,
                        mural_cue_rejection_count = 2
                  WHERE id = ?`,
                )
                .run(sourceId);
            database
                .prepare(
                    `UPDATE memories
                    SET importance = 12, scope = 'project', shareable = 0, classified_at = 10
                  WHERE id = ?`,
                )
                .run(targetId);
            database
                .prepare(
                    `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                 VALUES (?, 'src/shared.ts', 40, 35), (?, 'src/source.ts', 30, 25)`,
                )
                .run(sourceId, sourceId);
            database
                .prepare(
                    `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                 VALUES (?, 'src/shared.ts', 15, 10)`,
                )
                .run(targetId);
        });

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 50 });

        expect(
            database
                .prepare(
                    `SELECT importance, scope, shareable, classified_at, mural_cue,
                            mural_cue_hash, mural_cue_at, mural_cue_rejection_count
                       FROM memories WHERE id = ?`,
                )
                .get(targetId),
        ).toEqual({
            importance: 91,
            scope: "ecosystem",
            shareable: 1,
            classified_at: 20,
            mural_cue: "new cue",
            mural_cue_hash: "cue-hash",
            mural_cue_at: 30,
            mural_cue_rejection_count: 2,
        });
        expect(
            database
                .prepare(
                    `SELECT memory_id, file_path, verified_at, mapped_at
                       FROM memory_verifications
                      WHERE memory_id = ?
                      ORDER BY file_path`,
                )
                .all(targetId),
        ).toEqual([
            {
                memory_id: targetId,
                file_path: "src/shared.ts",
                verified_at: 40,
                mapped_at: 35,
            },
            {
                memory_id: targetId,
                file_path: "src/source.ts",
                verified_at: 30,
                mapped_at: 25,
            },
        ]);
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memory_verifications WHERE memory_id = ?")
                .get(sourceId),
        ).toEqual({ count: 0 });
    });

    test("refuses a module-owned source pool before any mutation", () => {
        const database = makeDb();
        insertMemory(database, "dir:module", "memory", "module-hash");
        database
            .prepare(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, ?, ?)",
            )
            .run("dir:module", "store", 1);

        expect(() => mergeProjectIdentities(database, "dir:module", "git:new")).toThrow(
            "managed by the Rust module",
        );
        expect(auditIdentityMerge(database, "dir:module", "git:new").changedRows).toBe(2);
        expect(database.prepare("SELECT project_path FROM memories").get()).toEqual({
            project_path: "dir:module",
        });
    });

    test("flattens the numeric project registry and the v22 map in the same merge", () => {
        const database = makeDb();
        database.exec(`
            INSERT INTO projects (canonical_identity, created_at) VALUES ('git:source', 1), ('git:target', 1);
            INSERT INTO project_aliases (alias_identity, project_id, created_at)
            SELECT canonical_identity, id, 1 FROM projects;
            INSERT INTO v22_identity_rekey_map (old_project_path, new_project_path, rekeyed_at)
            VALUES ('git:oldest', 'git:source', 1);
        `);
        insertMemory(database, "git:source", "payload", "payload-hash");
        const targetId = (
            database
                .prepare("SELECT id FROM projects WHERE canonical_identity = 'git:target'")
                .get() as { id: number }
        ).id;

        mergeProjectIdentities(database, "git:source", "git:target", { now: 50 });

        expect(
            database
                .prepare(
                    "SELECT project_id FROM project_aliases WHERE alias_identity = 'git:source'",
                )
                .get(),
        ).toEqual({ project_id: targetId });
        expect(database.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({
            count: 1,
        });
        expect(
            database
                .prepare(
                    "SELECT new_project_path AS target FROM v22_identity_rekey_map WHERE old_project_path = 'git:oldest'",
                )
                .get(),
        ).toEqual({ target: "git:target" });
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memories WHERE project_path = 'git:target'")
                .get(),
        ).toEqual({ count: 1 });
    });

    test("refuses to merge a registered historical alias away from its project", () => {
        const database = makeDb();
        database.exec(`
            INSERT INTO projects (canonical_identity, created_at) VALUES ('git:target', 1);
            INSERT INTO project_aliases (alias_identity, project_id, created_at)
            SELECT 'git:target', id, 1 FROM projects;
            INSERT INTO project_aliases (alias_identity, project_id, created_at)
            SELECT 'dir:old', id, 1 FROM projects;
        `);

        expect(() => mergeProjectIdentities(database, "dir:old", "git:elsewhere")).toThrow(
            /historical alias of git:target/,
        );

        // The rolled-back merge leaves both registries untouched.
        expect(
            database.prepare("SELECT COUNT(*) AS count FROM v22_identity_rekey_map").get(),
        ).toEqual({ count: 0 });
        expect(
            database.prepare("SELECT canonical_identity AS canonical FROM projects").get(),
        ).toEqual({ canonical: "git:target" });
    });

    test("rolls back the whole merge when the source project owns authoritative children", () => {
        const database = makeDb();
        database.exec(`
            INSERT INTO projects (canonical_identity, created_at) VALUES ('git:source', 1), ('git:target', 1);
            INSERT INTO project_aliases (alias_identity, project_id, created_at)
            SELECT canonical_identity, id, 1 FROM projects;
        `);
        const sourceId = (
            database
                .prepare("SELECT id FROM projects WHERE canonical_identity = 'git:source'")
                .get() as { id: number }
        ).id;
        database
            .prepare("INSERT INTO episodes (project_id, created_at) VALUES (?, 1)")
            .run(sourceId);
        insertMemory(database, "git:source", "payload", "payload-hash");

        expect(() => mergeProjectIdentities(database, "git:source", "git:target")).toThrow(
            /authoritative episodes or claims/,
        );

        expect(database.prepare("SELECT project_path FROM memories").get()).toEqual({
            project_path: "git:source",
        });
        expect(
            database
                .prepare(
                    "SELECT project_id FROM project_aliases WHERE alias_identity = 'git:source'",
                )
                .get(),
        ).toEqual({ project_id: sourceId });
        expect(
            database.prepare("SELECT COUNT(*) AS count FROM v22_identity_rekey_map").get(),
        ).toEqual({ count: 0 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM identity_merge_log").get()).toEqual({
            count: 0,
        });
    });
});

describe("project identity merge claims (v84)", () => {
    function aliasProjectId(database: Database, identity: string): number {
        return (
            database
                .prepare("SELECT project_id AS id FROM project_aliases WHERE alias_identity = ?")
                .get(identity) as { id: number }
        ).id;
    }

    test("a true two-project merge relocates memories and keeps mirror claim history consistent", () => {
        const database = makeDb();
        const movedSource = insertMemoryThroughKernel(database, {
            projectPath: "git:source",
            category: "CONSTRAINTS",
            content: "source-only fact",
        });
        const collidingSource = insertMemoryThroughKernel(database, {
            projectPath: "git:source",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const collidingTarget = insertMemoryThroughKernel(database, {
            projectPath: "git:target",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const sourceProjectId = aliasProjectId(database, "git:source");
        const targetProjectId = aliasProjectId(database, "git:target");

        mergeProjectIdentities(database, "git:source", "git:target", { now: 77 });

        // The unique memory moves through the authorized cross-project move:
        // a fresh row + claim at the target, the source row deleted, the
        // source claim retired. The colliding memory archives in place under
        // the survivor.
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memories WHERE id = ?")
                .get(movedSource.id),
        ).toEqual({ count: 0 });
        const movedRow = database
            .prepare(
                `SELECT id, status FROM memories
                  WHERE project_path = 'git:target' AND content = 'source-only fact'`,
            )
            .get() as { id: number; status: string };
        expect(movedRow.status).toBe("active");
        expect(
            database
                .prepare("SELECT status, superseded_by_memory_id AS by FROM memories WHERE id = ?")
                .get(collidingSource.id),
        ).toEqual({ status: "archived", by: collidingTarget.id });

        // Both identities resolve to the target project.
        expect(aliasProjectId(database, "git:source")).toBe(targetProjectId);
        expect(aliasProjectId(database, "git:target")).toBe(targetProjectId);

        // The source projects row survives as the owner of its immutable
        // mirror history (append-only crosswalk/episodes, frozen claim
        // project ids), so no claim-graph row dangles.
        expect(
            database
                .prepare("SELECT canonical_identity AS c FROM projects WHERE id = ?")
                .get(sourceProjectId),
        ).toEqual({ c: "git:source" });
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claims c
                      LEFT JOIN projects p ON p.id = c.project_id
                     WHERE p.id IS NULL`,
                )
                .get(),
        ).toEqual({ count: 0 });
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM legacy_memory_claims lmc
                      LEFT JOIN projects p ON p.id = lmc.project_id
                     WHERE p.id IS NULL`,
                )
                .get(),
        ).toEqual({ count: 0 });

        // The moved row's claim is owned by the TARGET project, so later
        // claims-aware writes pass the outbox project guard; the deleted
        // source row's claim retired with cross-project lineage.
        const movedClaim = getCurrentMemoryClaimByLegacyMemoryId(database, movedRow.id);
        expect(movedClaim?.state).toBe("active");
        expect(movedClaim?.content).toBe("source-only fact");
        expect(movedClaim?.projectId).toBe(targetProjectId);
        const movedLink = readMemoryClaimLink(database, movedRow.id);
        expect(movedLink?.projectId).toBe(targetProjectId);
        expect(getCurrentMemoryClaimByLegacyMemoryId(database, movedSource.id)?.state).toBe(
            "archived",
        );
        updateMemoryStatus(database, movedRow.id, "permanent");
        expect(
            database.prepare("SELECT status FROM memories WHERE id = ?").get(movedRow.id),
        ).toEqual({ status: "permanent" });

        // The colliding source claim retires with cross-project lineage; the
        // moved claim records its own lineage row.
        const collidingClaimId = (
            database
                .prepare("SELECT claim_id AS id FROM legacy_memory_claims WHERE memory_id = ?")
                .get(collidingSource.id) as { id: number }
        ).id;
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(collidingClaimId),
        ).toEqual({ state: "archived" });
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_merge_lineage
                      WHERE source_project_id = ? AND target_project_id = ?`,
                )
                .get(sourceProjectId, targetProjectId),
        ).toEqual({ count: 2 });
    });

    test("still refuses a two-project merge when the source owns an authoritative episode", () => {
        const database = makeDb();
        insertMemoryThroughKernel(database, {
            projectPath: "git:source",
            category: "CONSTRAINTS",
            content: "mirrored fact",
        });
        insertMemoryThroughKernel(database, {
            projectPath: "git:target",
            category: "CONSTRAINTS",
            content: "target fact",
        });
        const sourceProjectId = aliasProjectId(database, "git:source");
        // A bare episode carries no observations, so it cannot be the
        // memories-compatibility mirror; it is authoritative history even
        // while mirror claims and adoption episodes coexist beside it.
        database
            .prepare("INSERT INTO episodes (project_id, created_at) VALUES (?, 1)")
            .run(sourceProjectId);

        expect(() => mergeProjectIdentities(database, "git:source", "git:target")).toThrow(
            /authoritative episodes or claims/,
        );

        // The rolled-back merge leaves rows and aliases untouched.
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memories WHERE project_path = 'git:source'")
                .get(),
        ).toEqual({ count: 1 });
        expect(aliasProjectId(database, "git:source")).toBe(sourceProjectId);
        expect(database.prepare("SELECT COUNT(*) AS count FROM identity_merge_log").get()).toEqual({
            count: 0,
        });
    });

    test("still refuses a two-project merge when the source owns a claim outside the crosswalk", () => {
        const database = makeDb();
        insertMemoryThroughKernel(database, {
            projectPath: "git:source",
            category: "CONSTRAINTS",
            content: "mirrored fact",
        });
        insertMemoryThroughKernel(database, {
            projectPath: "git:target",
            category: "CONSTRAINTS",
            content: "target fact",
        });
        const sourceProjectId = aliasProjectId(database, "git:source");
        database
            .prepare(
                `INSERT INTO claims (project_id, subject, predicate, scope, created_at)
                 VALUES (?, 'edge:1', 'states', 'authoritative', 1)`,
            )
            .run(sourceProjectId);

        expect(() => mergeProjectIdentities(database, "git:source", "git:target")).toThrow(
            /authoritative episodes or claims/,
        );
        expect(aliasProjectId(database, "git:source")).toBe(sourceProjectId);
    });

    test("in-place dir: to git: adoption retains the numeric project and claims", () => {
        const database = makeDb();
        const memory = insertMemoryThroughKernel(database, {
            projectPath: "dir:old-checkout",
            category: "CONSTRAINTS",
            content: "durable fact",
        });
        const projectId = (
            database
                .prepare("SELECT project_id AS id FROM project_aliases WHERE alias_identity = ?")
                .get("dir:old-checkout") as { id: number }
        ).id;
        const linkBefore = database
            .prepare("SELECT * FROM legacy_memory_claims WHERE memory_id = ?")
            .get(memory.id);

        mergeProjectIdentities(database, "dir:old-checkout", "git:new-identity", { now: 50 });

        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(memory.id),
        ).toEqual({ project_path: "git:new-identity" });
        expect(database.prepare("SELECT id, canonical_identity FROM projects").all()).toEqual([
            { id: projectId, canonical_identity: "git:new-identity" },
        ]);
        expect(
            database
                .prepare("SELECT * FROM legacy_memory_claims WHERE memory_id = ?")
                .get(memory.id),
        ).toEqual(linkBefore);
        const current = getCurrentMemoryClaimByLegacyMemoryId(database, memory.id);
        expect(current?.projectId).toBe(projectId);
        expect(current?.state).toBe("active");
        expect(current?.content).toBe("durable fact");
    });

    test("an in-place adoption collision links the archived source to the canonical claim once", () => {
        const database = makeDb();
        const source = insertMemoryThroughKernel(database, {
            projectPath: "dir:old-checkout",
            category: "CONSTRAINTS",
            content: "same fact",
        });
        const sourceHash = (
            database
                .prepare("SELECT normalized_hash AS hash FROM memories WHERE id = ?")
                .get(source.id) as { hash: string }
        ).hash;
        const targetId = insertMemory(database, "git:new-identity", "same fact", sourceHash);

        mergeProjectIdentities(database, "dir:old-checkout", "git:new-identity", { now: 99 });

        expect(
            database
                .prepare("SELECT status, superseded_by_memory_id AS by FROM memories WHERE id = ?")
                .get(source.id),
        ).toEqual({ status: "archived", by: targetId });
        const links = database
            .prepare(
                "SELECT memory_id, canonical_memory_id, claim_id FROM legacy_memory_claims ORDER BY memory_id",
            )
            .all() as Array<{ memory_id: number; canonical_memory_id: number; claim_id: number }>;
        expect(links).toEqual([
            { memory_id: source.id, canonical_memory_id: source.id, claim_id: links[0].claim_id },
            { memory_id: targetId, canonical_memory_id: source.id, claim_id: links[0].claim_id },
        ]);
        expect(database.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({
            count: 1,
        });
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(links[0].claim_id),
        ).toEqual({ state: "active" });
        expect(database.prepare("SELECT COUNT(*) AS count FROM claim_conflicts").get()).toEqual({
            count: 0,
        });
    });

    test("a collision merge emits the archived source's dedup-link upsert effect", () => {
        const database = makeDb();
        const target = insertMemoryThroughKernel(database, {
            projectPath: "git:new",
            category: "CONSTRAINTS",
            content: "announced fact",
        });
        const targetHash = (
            database
                .prepare("SELECT normalized_hash AS hash FROM memories WHERE id = ?")
                .get(target.id) as { hash: string }
        ).hash;
        const sourceId = insertMemory(database, "dir:old", "announced fact", targetHash);

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 60 });

        const sourceLink = readMemoryClaimLink(database, sourceId);
        const targetLink = readMemoryClaimLink(database, target.id);
        if (!sourceLink || !targetLink) throw new Error("expected both rows to link");
        expect(sourceLink.claimId).toBe(targetLink.claimId);
        // The archived source's dedup crosswalk link is a fresh row; its
        // upsert effect is the only outbox announcement the boundary
        // reconciliation oracle gets for that link.
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_change_outbox
                      WHERE effect_key = ? AND effect_type = 'upsert'
                        AND claim_id = ? AND project_id = ?`,
                )
                .get(`memory:${sourceId}:upsert`, sourceLink.claimId, sourceLink.projectId),
        ).toEqual({ count: 1 });
    });

    test("an empty-content collision target skips the row with a diagnostic instead of rolling back", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "dir:old", "legacy fact", "same-hash");
        const targetId = insertMemory(database, "git:new", "", "same-hash");

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 50 });

        // The merge completes; the skipped row survives untouched under the
        // source identity and the stalled merge surfaces as a blocking
        // diagnostic.
        expect(
            database
                .prepare(
                    "SELECT project_path, status, superseded_by_memory_id AS by FROM memories WHERE id = ?",
                )
                .get(sourceId),
        ).toEqual({ project_path: "dir:old", status: "active", by: null });
        expect(
            database
                .prepare(
                    `SELECT phase, item_kind, reason_code, disposition
                       FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(`memory:${sourceId}:collision-merge:${targetId}`),
        ).toEqual({
            phase: "relationships",
            item_kind: "merge",
            reason_code: "empty-content",
            disposition: "blocking",
        });
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS count FROM identity_merge_log WHERE table_name = 'memories'",
                )
                .get(),
        ).toEqual({ count: 0 });
    });

    test("a collision merge between unregistered raw paths records a blocking diagnostic for the skipped claim work", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "/old/raw-checkout", "shared fact", "same-hash");
        const targetId = insertMemory(database, "/new/raw-checkout", "shared fact", "same-hash");

        mergeProjectIdentities(database, "/old/raw-checkout", "/new/raw-checkout", { now: 70 });

        // The merge proceeds: the source is archived as superseded by the
        // collision survivor even though no claim work could run.
        expect(
            database
                .prepare("SELECT status, superseded_by_memory_id AS by FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ status: "archived", by: targetId });
        // The skipped claims-side work is observable as a blocking failure
        // keyed to the source row.
        expect(
            database
                .prepare(
                    `SELECT reason_code, disposition FROM claim_backfill_failures
                      WHERE item_kind = 'memory' AND item_key = ?`,
                )
                .get(String(sourceId)),
        ).toEqual({ reason_code: "unresolved-project-identity", disposition: "blocking" });
    });

    test("a collision merge carries the winning classification into the survivor's claim", () => {
        const database = makeDb();
        const source = insertMemoryThroughKernel(database, {
            projectPath: "git:source",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const target = insertMemoryThroughKernel(database, {
            projectPath: "git:target",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    `UPDATE memories
                        SET importance = 91, scope = 'ecosystem', shareable = 1, classified_at = 20
                      WHERE id = ?`,
                )
                .run(source.id);
            database
                .prepare(
                    `UPDATE memories
                        SET importance = 12, scope = 'project', shareable = 0, classified_at = 10
                      WHERE id = ?`,
                )
                .run(target.id);
        });
        const revisionBefore = getCurrentMemoryClaimByLegacyMemoryId(database, target.id)?.revision;

        mergeProjectIdentities(database, "git:source", "git:target", { now: 60 });

        // The survivor's current claim metadata reflects the winning
        // classification through an appended revision, not a projection-only
        // UPDATE.
        const survivorClaim = getCurrentMemoryClaimByLegacyMemoryId(database, target.id);
        expect(survivorClaim?.importance).toBe(91);
        expect(survivorClaim?.memoryScope).toBe("ecosystem");
        expect(survivorClaim?.shareable).toBe(1);
        expect(survivorClaim?.revision).toBe((revisionBefore ?? 0) + 1);
        expect(
            database
                .prepare(
                    "SELECT importance, scope, shareable, classified_at FROM memories WHERE id = ?",
                )
                .get(target.id),
        ).toEqual({ importance: 91, scope: "ecosystem", shareable: 1, classified_at: 20 });
    });

    test("a collision merge re-snapshots the archived source row's rewritten lineage", () => {
        const database = makeDb();
        const source = insertMemoryThroughKernel(database, {
            projectPath: "git:source",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const target = insertMemoryThroughKernel(database, {
            projectPath: "git:target",
            category: "CONSTRAINTS",
            content: "shared fact",
        });

        mergeProjectIdentities(database, "git:source", "git:target", { now: 60 });

        // The archive UPDATE rewrites the source row's lineage after the
        // adoption snapshot, so the post-archive values need their own
        // relationship source or the v84 guard rejects every later lineage
        // write on the row.
        const archived = database
            .prepare(
                `SELECT merged_from AS mergedFrom, superseded_by_memory_id AS supersededBy
                   FROM memories WHERE id = ?`,
            )
            .get(source.id) as { mergedFrom: string; supersededBy: number };
        expect(archived.supersededBy).toBe(target.id);
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_memory_relationship_sources
                      WHERE memory_id = ? AND merged_from IS ? AND superseded_by_memory_id IS ?`,
                )
                .get(source.id, archived.mergedFrom, archived.supersededBy),
        ).toEqual({ count: 1 });

        // A later claims-capable lineage write on the archived row passes the
        // relationship guard instead of aborting.
        expect(() =>
            runInMemoryClaimsWriteTransaction(database, () => {
                database
                    .prepare("UPDATE memories SET superseded_by_memory_id = NULL WHERE id = ?")
                    .run(source.id);
            }),
        ).not.toThrow();
    });

    test("a collision merge promotes a verified source's status onto the survivor with claim evidence", () => {
        const database = makeDb();
        const source = insertMemoryThroughKernel(database, {
            projectPath: "git:source",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const target = insertMemoryThroughKernel(database, {
            projectPath: "git:target",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    "UPDATE memories SET verification_status = 'verified', verified_at = 123 WHERE id = ?",
                )
                .run(source.id);
        });

        mergeProjectIdentities(database, "git:source", "git:target", { now: 60 });

        // The survivor's projection is promoted (compat readers filter on
        // verified_at) with the source's verified_at preserved.
        expect(
            database
                .prepare(
                    "SELECT verification_status AS status, verified_at AS at FROM memories WHERE id = ?",
                )
                .get(target.id),
        ).toEqual({ status: "verified", at: 123 });
        // The survivor's claim carries exactly one verified event and the
        // promotion emits an evidence effect.
        const survivorClaim = getCurrentMemoryClaimByLegacyMemoryId(database, target.id);
        expect(
            database
                .prepare(
                    `SELECT outcome, verifier FROM verification_events
                      WHERE revision_id IN (SELECT id FROM claim_revisions WHERE claim_id = ?)`,
                )
                .all(survivorClaim?.claimId ?? 0),
        ).toEqual([{ outcome: "verified", verifier: "identity-merge" }]);
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_change_outbox
                      WHERE effect_key = ? AND effect_type = 'evidence'`,
                )
                .get(`memory:${target.id}:evidence`),
        ).toEqual({ count: 1 });
    });

    test("a collision merge promotes a side-table-only verified source onto the survivor with claim evidence", () => {
        const database = makeDb();
        const source = insertMemoryThroughKernel(database, {
            projectPath: "git:source",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const target = insertMemoryThroughKernel(database, {
            projectPath: "git:target",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        // Pre-v84 TypeScript verification: positive verified_at lives only in
        // memory_verifications; the projection columns stay unverified.
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                     VALUES (?, 'src/compat.ts', 123, 100)`,
                )
                .run(source.id);
        });

        mergeProjectIdentities(database, "git:source", "git:target", { now: 60 });

        expect(
            database
                .prepare(
                    "SELECT verification_status AS status, verified_at AS at FROM memories WHERE id = ?",
                )
                .get(target.id),
        ).toEqual({ status: "verified", at: 123 });
        const survivorClaim = getCurrentMemoryClaimByLegacyMemoryId(database, target.id);
        expect(
            database
                .prepare(
                    `SELECT outcome, verifier FROM verification_events
                      WHERE revision_id IN (SELECT id FROM claim_revisions WHERE claim_id = ?)`,
                )
                .all(survivorClaim?.claimId ?? 0),
        ).toEqual([{ outcome: "verified", verifier: "identity-merge" }]);
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_change_outbox
                      WHERE effect_key = ? AND effect_type = 'evidence'`,
                )
                .get(`memory:${target.id}:evidence`),
        ).toEqual({ count: 1 });
    });

    test("a collision merge records a freshly-adopted target's own side-table verification as claim evidence", () => {
        const database = makeDb();
        insertMemory(database, "git:source", "shared fact", "shared-h1");
        const targetId = insertMemory(database, "git:target", "shared fact", "shared-h1");
        // Pre-v84 TypeScript verification on the TARGET only: positive
        // verified_at lives in memory_verifications; the source carries no
        // verification anywhere.
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                     VALUES (?, 'src/compat.ts', 123, 100)`,
                )
                .run(targetId);
        });

        mergeProjectIdentities(database, "git:source", "git:target", { now: 60 });

        // The unlinked target is adopted during the merge; its pre-existing
        // verification promotes the projection and lands on the fresh claim
        // instead of leaving it eventless.
        expect(
            database
                .prepare(
                    "SELECT verification_status AS status, verified_at AS at FROM memories WHERE id = ?",
                )
                .get(targetId),
        ).toEqual({ status: "verified", at: 123 });
        const survivorClaim = getCurrentMemoryClaimByLegacyMemoryId(database, targetId);
        expect(
            database
                .prepare(
                    `SELECT outcome, verifier FROM verification_events
                      WHERE revision_id IN (SELECT id FROM claim_revisions WHERE claim_id = ?)`,
                )
                .all(survivorClaim?.claimId ?? 0),
        ).toEqual([{ outcome: "verified", verifier: "identity-merge" }]);
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_change_outbox
                      WHERE effect_key = ? AND effect_type = 'evidence'`,
                )
                .get(`memory:${targetId}:evidence`),
        ).toEqual({ count: 1 });
    });

    test("a collision merge with both sides verified records exactly one verified event", () => {
        const database = makeDb();
        const sourceId = insertMemory(database, "git:source", "shared fact", "shared-h1");
        const targetId = insertMemory(database, "git:target", "shared fact", "shared-h1");
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    "UPDATE memories SET verification_status = 'verified', verified_at = 123 WHERE id = ?",
                )
                .run(sourceId);
            database
                .prepare(
                    `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                     VALUES (?, 'src/compat.ts', 200, 100)`,
                )
                .run(targetId);
        });

        mergeProjectIdentities(database, "git:source", "git:target", { now: 60 });

        // Both the source transfer and the target's own adoption qualify, but
        // the single funnel records one event with the maximum verified_at.
        expect(
            database
                .prepare(
                    "SELECT verification_status AS status, verified_at AS at FROM memories WHERE id = ?",
                )
                .get(targetId),
        ).toEqual({ status: "verified", at: 200 });
        const survivorClaim = getCurrentMemoryClaimByLegacyMemoryId(database, targetId);
        expect(
            database
                .prepare(
                    `SELECT outcome, verifier FROM verification_events
                      WHERE revision_id IN (SELECT id FROM claim_revisions WHERE claim_id = ?)`,
                )
                .all(survivorClaim?.claimId ?? 0),
        ).toEqual([{ outcome: "verified", verifier: "identity-merge" }]);
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_change_outbox
                      WHERE effect_key = ? AND effect_type = 'evidence'`,
                )
                .get(`memory:${targetId}:evidence`),
        ).toEqual({ count: 1 });
    });

    test("a non-collision merge carries a side-table-only verified unlinked row onto its claim with evidence", () => {
        const database = makeDb();
        const rowId = insertMemory(database, "dir:old", "legacy verified fact", "legacy-v1");
        // Pre-v84 TypeScript verification: positive verified_at lives only in
        // memory_verifications; the projection columns stay unverified.
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                     VALUES (?, 'src/compat.ts', 123, 100)`,
                )
                .run(rowId);
        });

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 60 });

        // The rekeyed row adopts a claim carrying one verified event plus a
        // matching evidence effect — the same promotion the collision branch
        // performs.
        const claim = getCurrentMemoryClaimByLegacyMemoryId(database, rowId);
        expect(claim?.state).toBe("active");
        expect(
            database
                .prepare(
                    `SELECT outcome, verifier FROM verification_events
                      WHERE revision_id IN (SELECT id FROM claim_revisions WHERE claim_id = ?)`,
                )
                .all(claim?.claimId ?? 0),
        ).toEqual([{ outcome: "verified", verifier: "identity-merge" }]);
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_change_outbox
                      WHERE effect_key = ? AND effect_type = 'evidence'`,
                )
                .get(`memory:${rowId}:evidence`),
        ).toEqual({ count: 1 });
    });

    test("a non-collision merge onto a claims-deleted equivalent reactivates the adopted claim", () => {
        const database = makeDb();
        const deleted = insertMemoryThroughKernel(database, {
            projectPath: "git:new",
            category: "CONSTRAINTS",
            content: "revived fact",
        });
        const archivedLink = readMemoryClaimLink(database, deleted.id);
        deleteMemory(database, deleted.id);
        expect(
            database
                .prepare("SELECT state FROM claims WHERE id = ?")
                .get(archivedLink?.claimId ?? 0),
        ).toEqual({ state: "archived" });
        const sourceId = insertMemory(database, "dir:old", "revived fact", deleted.normalizedHash);

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 60 });

        // The rekeyed row adopts the archived canonical claim and reactivates
        // it from the row's status, with a lifecycle effect for the
        // transition.
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(sourceId),
        ).toEqual({ project_path: "git:new" });
        const claim = getCurrentMemoryClaimByLegacyMemoryId(database, sourceId);
        expect(claim?.claimId).toBe(archivedLink?.claimId ?? 0);
        expect(claim?.state).toBe("active");
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_change_outbox
                      WHERE effect_key = ? AND effect_type = 'lifecycle'`,
                )
                .get(`memory:${sourceId}:lifecycle`),
        ).toEqual({ count: 1 });
    });

    test("a collision merge onto a claims-deleted equivalent reactivates the survivor's claim", () => {
        const database = makeDb();
        const deleted = insertMemoryThroughKernel(database, {
            projectPath: "git:new",
            category: "CONSTRAINTS",
            content: "revived fact",
        });
        const archivedLink = readMemoryClaimLink(database, deleted.id);
        deleteMemory(database, deleted.id);
        expect(
            database
                .prepare("SELECT state FROM claims WHERE id = ?")
                .get(archivedLink?.claimId ?? 0),
        ).toEqual({ state: "archived" });
        // A re-added unlinked twin of the deleted row: the collision survivor
        // that dedups onto the archived canonical claim.
        const targetId = insertMemory(database, "git:new", "revived fact", deleted.normalizedHash);
        const sourceId = insertMemory(database, "dir:old", "revived fact", deleted.normalizedHash);

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 60 });

        expect(
            database
                .prepare("SELECT status, superseded_by_memory_id AS by FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ status: "archived", by: targetId });
        const survivorClaim = getCurrentMemoryClaimByLegacyMemoryId(database, targetId);
        expect(survivorClaim?.claimId).toBe(archivedLink?.claimId ?? 0);
        expect(survivorClaim?.state).toBe("active");
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_change_outbox
                      WHERE effect_key = ? AND effect_type = 'lifecycle'`,
                )
                .get(`memory:${targetId}:lifecycle`),
        ).toEqual({ count: 1 });
    });

    test("a collision merge onto a NULL-status target activates the claim with the projection", () => {
        const database = makeDb();
        const targetId = insertMemory(database, "git:new", "null status fact", "null-h1");
        const sourceId = insertMemory(database, "dir:old", "null status fact", "null-h1");
        // Schema-legal drift: memories.status has a DEFAULT but no NOT NULL,
        // and adoption derives the canonical claim's state from this column.
        runInMemoryClaimsWriteTransaction(database, () => {
            database.prepare("UPDATE memories SET status = NULL WHERE id = ?").run(targetId);
        });

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 80 });

        expect(database.prepare("SELECT status FROM memories WHERE id = ?").get(targetId)).toEqual({
            status: "active",
        });
        expect(
            database
                .prepare("SELECT status, superseded_by_memory_id AS by FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ status: "archived", by: targetId });
        const survivorClaim = getCurrentMemoryClaimByLegacyMemoryId(database, targetId);
        expect(survivorClaim?.state).toBe("active");
    });

    test("a rejected NULL-status collision target keeps its NULL status when the merge is skipped", () => {
        const database = makeDb();
        const targetId = insertMemory(database, "git:new", "rejected null fact", "null-h2");
        const sourceId = insertMemory(database, "dir:old", "rejected null fact", "null-h2");
        // Schema-legal drift on the target: NULL status plus claim-invalid
        // importance, so the adoption gate rejects it.
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare("UPDATE memories SET status = NULL, importance = 0 WHERE id = ?")
                .run(targetId);
        });

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 80 });

        // The skipped target keeps its NULL status: normalizing it would
        // publish a claim-invalid row active while its claim work stays
        // skipped.
        expect(database.prepare("SELECT status FROM memories WHERE id = ?").get(targetId)).toEqual({
            status: null,
        });
        expect(
            database
                .prepare(
                    "SELECT project_path, status, superseded_by_memory_id AS by FROM memories WHERE id = ?",
                )
                .get(sourceId),
        ).toEqual({ project_path: "dir:old", status: "active", by: null });
        expect(
            database
                .prepare(
                    `SELECT reason_code, disposition FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(`memory:${sourceId}:collision-merge:${targetId}`),
        ).toEqual({ reason_code: "invalid-importance", disposition: "blocking" });
    });

    test("a pre-claims collision merge normalizes the survivor's NULL status", () => {
        // Deliberately-unmigrated database: no claims compat schema, so the
        // merge takes the claims-inactive collision path (the doctor
        // merge-identity shape on a pre-v84 store).
        const database = new Database(":memory:");
        db = database;
        database.exec(`
            CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                normalized_hash TEXT NOT NULL,
                seen_count INTEGER DEFAULT 1,
                status TEXT DEFAULT 'active',
                importance INTEGER,
                scope TEXT,
                shareable INTEGER,
                classified_at INTEGER,
                mural_cue TEXT,
                mural_cue_hash TEXT,
                mural_cue_at INTEGER,
                mural_cue_rejection_count INTEGER DEFAULT 0,
                merged_from TEXT,
                superseded_by_memory_id INTEGER,
                updated_at INTEGER,
                UNIQUE(project_path, category, normalized_hash)
            );
            CREATE TABLE memory_verifications (
                memory_id INTEGER NOT NULL,
                file_path TEXT NOT NULL,
                verified_at INTEGER,
                mapped_at INTEGER,
                UNIQUE(memory_id, file_path)
            );
            CREATE TABLE memory_mutation_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                mutation_type TEXT NOT NULL,
                target_memory_id INTEGER,
                superseded_by_id INTEGER,
                category TEXT,
                queued_at INTEGER
            );
            CREATE TABLE identity_merge_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_identity TEXT NOT NULL,
                to_identity TEXT NOT NULL,
                table_name TEXT NOT NULL,
                row_id TEXT NOT NULL,
                action TEXT NOT NULL,
                target_row_id TEXT,
                merged_at INTEGER NOT NULL
            );
            CREATE TABLE project_state (
                project_path TEXT PRIMARY KEY,
                project_memory_epoch INTEGER,
                project_user_profile_version INTEGER,
                updated_at INTEGER
            );
        `);
        const insert = database.prepare(
            "INSERT INTO memories (project_path, category, content, normalized_hash, status) VALUES (?, 'CONSTRAINTS', ?, ?, ?)",
        );
        const targetId = Number(
            insert.run("git:new", "pre-claims fact", "pre-h1", null).lastInsertRowid,
        );
        const sourceId = Number(
            insert.run("dir:old", "pre-claims fact", "pre-h1", "active").lastInsertRowid,
        );

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 90 });

        // The survivor is live by contract: its NULL status normalizes to
        // 'active' on the claims-inactive path too.
        expect(database.prepare("SELECT status FROM memories WHERE id = ?").get(targetId)).toEqual({
            status: "active",
        });
        expect(
            database
                .prepare("SELECT status, superseded_by_memory_id AS by FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ status: "archived", by: targetId });
    });

    test("a collision merge keeps a shared source claim live for its alias sibling and retires a last-link claim", () => {
        const database = makeDb();
        const source = insertMemoryThroughKernel(database, {
            projectPath: "dir:old",
            category: "CONSTRAINTS",
            content: "shared alias fact",
        });
        // Both identities resolve to the same numeric project, so the second
        // insert takes the dedup branch and shares the source's claim.
        database
            .prepare(
                `INSERT INTO project_aliases (alias_identity, project_id, created_at)
                 SELECT 'dir:old-alias', project_id, 1 FROM project_aliases
                  WHERE alias_identity = 'dir:old'`,
            )
            .run();
        const sibling = insertMemoryThroughKernel(database, {
            projectPath: "dir:old-alias",
            category: "CONSTRAINTS",
            content: "shared alias fact",
        });
        const sharedLink = readMemoryClaimLink(database, source.id);
        expect(sharedLink?.claimId).toBe(readMemoryClaimLink(database, sibling.id)?.claimId ?? -1);
        // A last-link source in the same merge: its claim has no live sibling.
        const soleSource = insertMemoryThroughKernel(database, {
            projectPath: "dir:old",
            category: "CONSTRAINTS",
            content: "sole claim fact",
        });
        const soleLink = readMemoryClaimLink(database, soleSource.id);
        // Pre-linked collision targets carrying their own claims.
        const sharedTarget = insertMemoryThroughKernel(database, {
            projectPath: "git:new",
            category: "CONSTRAINTS",
            content: "shared alias fact",
        });
        const soleTarget = insertMemoryThroughKernel(database, {
            projectPath: "git:new",
            category: "CONSTRAINTS",
            content: "sole claim fact",
        });

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 90 });

        // The sibling still asserts the shared claim: it stays live with no
        // supersession edge and no lifecycle effect for the archived source.
        const sharedTargetLink = readMemoryClaimLink(database, sharedTarget.id);
        const soleTargetLink = readMemoryClaimLink(database, soleTarget.id);
        if (!sharedLink || !soleLink || !sharedTargetLink || !soleTargetLink) {
            throw new Error("expected claim links on both merge pairs");
        }
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(sharedLink.claimId),
        ).toEqual({ state: "active" });
        expect(getCurrentMemoryClaimByLegacyMemoryId(database, sibling.id)?.state).toBe("active");
        expect(memoryClaimSupersessionExists(database, sharedLink, sharedTargetLink)).toBe(false);
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_change_outbox
                      WHERE effect_key = ? AND effect_type = 'lifecycle'`,
                )
                .get(`memory:${source.id}:lifecycle`),
        ).toEqual({ count: 0 });
        // The last-link claim still retires with supersession lineage.
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(soleLink.claimId),
        ).toEqual({ state: "archived" });
        expect(memoryClaimSupersessionExists(database, soleLink, soleTargetLink)).toBe(true);
    });

    test("a claim-invalid source's newer classification is skipped instead of aborting the merge", () => {
        const database = makeDb();
        const targetId = insertMemory(database, "git:new", "bogus scope fact", "bogus-h1");
        const sourceId = insertMemory(database, "dir:old", "bogus scope fact", "bogus-h1");
        // Schema-legal but claim-invalid: `memories` has no CHECK on scope,
        // while the kernel's revision metadata does — promoting the raw value
        // would abort the whole merge.
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare("UPDATE memories SET scope = 'bogus', classified_at = 20 WHERE id = ?")
                .run(sourceId);
        });

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 60 });

        // The merge completes; the promotion is skipped and the survivor
        // keeps its own classification.
        expect(
            database
                .prepare("SELECT status, superseded_by_memory_id AS by FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ status: "archived", by: targetId });
        expect(
            database
                .prepare("SELECT scope, classified_at FROM memories WHERE id = ?")
                .get(targetId),
        ).toEqual({ scope: "project", classified_at: null });
        // The adoption pass recorded the blocking diagnostic for the
        // unadoptable source.
        expect(
            database
                .prepare(
                    `SELECT reason_code, disposition FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(String(sourceId)),
        ).toEqual({ reason_code: "invalid-scope", disposition: "blocking" });
    });

    test("a linked claim-invalid source records a blocking diagnostic and its promotion lands on retry after repair", () => {
        const database = makeDb();
        const target = insertMemoryThroughKernel(database, {
            projectPath: "git:new",
            category: "CONSTRAINTS",
            content: "promoted fact",
        });
        const source = insertMemoryThroughKernel(database, {
            projectPath: "dir:old",
            category: "CONSTRAINTS",
            content: "promoted fact",
        });
        // Schema-legal but claim-invalid drift on the LINKED source:
        // `memories` has no CHECK on scope, while the kernel's revision
        // metadata does — promoting the raw value would abort the merge.
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare("UPDATE memories SET scope = 'bogus', classified_at = 20 WHERE id = ?")
                .run(source.id);
        });

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 60 });

        // The merge proceeds — source archived with an announced lineage
        // edge — but the classification promotion is skipped and stays
        // observable as a blocking diagnostic even though the source is
        // linked.
        expect(
            database
                .prepare("SELECT status, superseded_by_memory_id AS by FROM memories WHERE id = ?")
                .get(source.id),
        ).toEqual({ status: "archived", by: target.id });
        expect(
            database
                .prepare("SELECT scope, classified_at FROM memories WHERE id = ?")
                .get(target.id),
        ).toEqual({ scope: "project", classified_at: null });
        expect(
            database
                .prepare(
                    "SELECT reason_code, disposition FROM claim_backfill_failures WHERE item_key = ?",
                )
                .get(String(source.id)),
        ).toEqual({ reason_code: "invalid-scope", disposition: "blocking" });
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count FROM claim_change_outbox
                      WHERE effect_key = ? AND effect_type = 'evidence'`,
                )
                .get(`memory:${target.id}:supersede`),
        ).toEqual({ count: 1 });

        // Repair the drift, then retry: the promotion now runs through the
        // kernel and lands on the survivor.
        runInMemoryClaimsWriteTransaction(database, () => {
            database.prepare("UPDATE memories SET scope = 'ecosystem' WHERE id = ?").run(source.id);
        });
        mergeProjectIdentities(database, "dir:old", "git:new", { now: 70 });
        expect(
            database
                .prepare("SELECT scope, classified_at FROM memories WHERE id = ?")
                .get(target.id),
        ).toEqual({ scope: "ecosystem", classified_at: 20 });
    });

    test("a claim-invalid unlinked row is diagnosed without rolling back the rest of the merge", () => {
        const database = makeDb();
        const healthyId = insertMemory(database, "dir:old", "healthy fact", "healthy-h1");
        const invalidId = insertMemory(
            database,
            "dir:old",
            "invalid importance fact",
            "invalid-h1",
        );
        // Schema-legal but claim-invalid: `memories` has no CHECK on importance.
        runInMemoryClaimsWriteTransaction(database, () => {
            database.prepare("UPDATE memories SET importance = 0 WHERE id = ?").run(invalidId);
        });

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 70 });

        // The healthy row rekeys and links; the invalid row rekeys unlinked
        // with a blocking diagnostic instead of aborting the whole merge.
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(healthyId),
        ).toEqual({ project_path: "git:new" });
        expect(readMemoryClaimLink(database, healthyId)).not.toBeNull();
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(invalidId),
        ).toEqual({ project_path: "git:new" });
        expect(readMemoryClaimLink(database, invalidId)).toBeNull();
        expect(
            database
                .prepare(
                    `SELECT phase, item_kind, reason_code, disposition
                       FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(String(invalidId)),
        ).toEqual({
            phase: "rows",
            item_kind: "memory",
            reason_code: "invalid-importance",
            disposition: "blocking",
        });
    });

    test("a collision merge skips an unlinked lineage-bearing claim-invalid source instead of aborting", () => {
        const database = makeDb();
        const targetId = insertMemory(database, "git:new", "colliding target fact", "coll-h1");
        const sourceId = insertMemory(database, "dir:old", "colliding source fact", "coll-h1");
        const healthyId = insertMemory(database, "dir:old", "healthy fact", "healthy-coll-h1");
        // Schema-legal but claim-invalid (`memories` has no CHECK on
        // importance) plus lineage: the collision archive would rewrite the
        // source's lineage columns with no relationship snapshot to satisfy
        // the v84 relationship guard, aborting the whole merge.
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare("UPDATE memories SET importance = 0, merged_from = 'legacy' WHERE id = ?")
                .run(sourceId);
        });

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 70 });

        // The healthy row rekeys and links; the colliding source stays live
        // under the source identity with a blocking diagnostic instead of
        // being archived into the unadoptable-shaped merge.
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(healthyId),
        ).toEqual({ project_path: "git:new" });
        expect(readMemoryClaimLink(database, healthyId)).not.toBeNull();
        expect(
            database
                .prepare(
                    "SELECT project_path, status, superseded_by_memory_id AS s FROM memories WHERE id = ?",
                )
                .get(sourceId),
        ).toEqual({ project_path: "dir:old", status: "active", s: null });
        expect(readMemoryClaimLink(database, sourceId)).toBeNull();
        expect(
            database
                .prepare(
                    `SELECT phase, item_kind, reason_code, disposition
                       FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(`memory:${sourceId}:collision-merge:${targetId}`),
        ).toEqual({
            phase: "relationships",
            item_kind: "merge",
            reason_code: "invalid-importance",
            disposition: "blocking",
        });
    });

    test("a generic rekey routes an unadoptable lineage-bearing row to a diagnostic instead of aborting", () => {
        const database = makeDb();
        const adoptableId = insertMemory(database, "dir:old", "movable fact", "move-h1");
        const strandedId = insertMemory(database, "dir:old", "", "empty-h1");
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare("UPDATE memories SET merged_from = 'identity-merge' WHERE id = ?")
                .run(strandedId);
        });

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 70 });

        // The adoptable row rekeys; the unadoptable row cannot satisfy the
        // v84 relationship guard (no claim link, so no snapshot), so it stays
        // under the source identity with a blocking diagnostic.
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(adoptableId),
        ).toEqual({ project_path: "git:new" });
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(strandedId),
        ).toEqual({ project_path: "dir:old" });
        expect(
            database
                .prepare(
                    `SELECT phase, item_kind, reason_code, disposition
                       FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(String(strandedId)),
        ).toEqual({
            phase: "rows",
            item_kind: "memory",
            reason_code: "empty-content",
            disposition: "blocking",
        });
    });

    test("a claim-invalid unlinked boundary row is skipped with a diagnostic instead of aborting the merge", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        // Pre-migration boundary row: unlinked, claim-invalid metadata
        // (`memories` has no CHECK on scope), no lineage.
        const boundaryId = Number(
            db
                .prepare(
                    `INSERT INTO memories (project_path, category, content, normalized_hash, scope,
                        first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES ('dir:old', 'CONSTRAINTS', 'boundary fact', 'boundary-h1', 'bogus', 1, 1, 1, 1)`,
                )
                .run().lastInsertRowid,
        );
        runMigrations(db);
        const database = db;
        const healthyId = insertMemory(database, "dir:old", "healthy fact", "healthy-boundary-h1");

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 70 });

        // The healthy row rekeys and links; the unadoptable boundary row
        // cannot satisfy the v84 identity-move guard (no claim link), so it
        // stays under the source identity with a blocking diagnostic.
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(healthyId),
        ).toEqual({ project_path: "git:new" });
        expect(readMemoryClaimLink(database, healthyId)).not.toBeNull();
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(boundaryId),
        ).toEqual({ project_path: "dir:old" });
        expect(readMemoryClaimLink(database, boundaryId)).toBeNull();
        expect(
            database
                .prepare(
                    `SELECT phase, item_kind, reason_code, disposition
                       FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(String(boundaryId)),
        ).toEqual({
            phase: "rows",
            item_kind: "memory",
            reason_code: "invalid-scope",
            disposition: "blocking",
        });
    });

    test("still refuses a two-project merge when a mirror episode also carries an observation-less span", () => {
        const database = makeDb();
        insertMemoryThroughKernel(database, {
            projectPath: "git:source",
            category: "CONSTRAINTS",
            content: "mirrored fact",
        });
        insertMemoryThroughKernel(database, {
            projectPath: "git:target",
            category: "CONSTRAINTS",
            content: "target fact",
        });
        const sourceProjectId = aliasProjectId(database, "git:source");
        const episodeId = (
            database
                .prepare("SELECT id FROM episodes WHERE project_id = ? ORDER BY id LIMIT 1")
                .get(sourceProjectId) as { id: number }
        ).id;
        // The mirror episode's own observation is crosswalked, so the episode
        // satisfies neither authoritative branch on its own; a span carrying
        // no observation at all is authoritative history and must refuse the
        // merge rather than strand the episode on a merged-away project.
        createSourceSpan(database, {
            episodeId,
            sourceLocator: "conversation:manual",
            content: "authoritative span",
            startOffset: 0,
            endOffset: 18,
        });

        expect(() => mergeProjectIdentities(database, "git:source", "git:target")).toThrow(
            /authoritative episodes or claims/,
        );
        expect(aliasProjectId(database, "git:source")).toBe(sourceProjectId);
    });
});
