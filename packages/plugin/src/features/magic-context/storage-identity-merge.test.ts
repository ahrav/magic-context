import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { auditIdentityMerge, mergeProjectIdentities } from "./storage-identity-merge";
import { seedProjectMemoryClaim } from "./test-claim-database";
import { createDirectTestDatabase } from "./test-database";

let db: Database | null = null;

function makeDb(): Database {
    db = createDirectTestDatabase().db;
    return db;
}

function makeDirectDb(): Database {
    db = createDirectTestDatabase().db;
    return db;
}

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("project identity merge", () => {
    test("preserves the oldest open broad cycle when task schedule rows collide", async () => {
        const database = makeDb();
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
    });
    test("refuses a module-owned source pool before any mutation", () => {
        const database = makeDb();
        database
            .prepare(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, ?, ?)",
            )
            .run("dir:module", "store", 1);

        expect(() => mergeProjectIdentities(database, "dir:module", "git:new")).toThrow(
            "managed by the Rust module",
        );
        expect(auditIdentityMerge(database, "dir:module", "git:new").changedRows).toBe(1);
        expect(database.prepare("SELECT project_path FROM authority_managed").get()).toEqual({
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

        expect(() => mergeProjectIdentities(database, "git:source", "git:target")).toThrow(
            /authoritative episodes or claims/,
        );

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

describe("U7 direct project identity adoption", () => {
    test("scenario 1: dir-to-git adoption keeps one numeric project and immutable claim history", () => {
        const database = makeDirectDb();
        const seeded = seedProjectMemoryClaim(database, {
            projectIdentity: "dir:old",
            content: "Identity-stable claim.",
            operationKey: "u7-identity-seed",
        });
        database
            .prepare("INSERT INTO workspaces (name, created_at, updated_at) VALUES ('u7', 1, 1)")
            .run();
        database
            .prepare(
                `INSERT INTO workspace_members
                    (workspace_id, project_path, display_name, display_path, added_at)
                 VALUES (1, 'dir:old', 'Old', '/old', 1)`,
            )
            .run();
        const before = {
            claim: database
                .prepare(
                    `SELECT claims.id, claims.current_revision_id AS revisionId,
                            ids.public_id AS publicId
                       FROM claims JOIN claim_public_ids ids ON ids.claim_id = claims.id
                      WHERE ids.public_id = ?`,
                )
                .get(seeded.publicClaimId),
            revisions: database.prepare("SELECT * FROM claim_revisions ORDER BY id").all(),
            evidence: database
                .prepare("SELECT * FROM claim_evidence ORDER BY revision_id, observation_id")
                .all(),
            receipts: database.prepare("SELECT * FROM claim_operation_receipts ORDER BY id").all(),
            generations: database
                .prepare("SELECT * FROM claim_project_generations ORDER BY project_id")
                .all(),
        };

        mergeProjectIdentities(database, "dir:old", "git:new", { now: 10 });

        expect(
            database.prepare("SELECT id FROM projects WHERE canonical_identity = 'git:new'").get(),
        ).toEqual({ id: seeded.projectId });
        expect(
            database
                .prepare(
                    "SELECT project_id AS projectId FROM project_aliases WHERE alias_identity = ?",
                )
                .get("dir:old"),
        ).toEqual({ projectId: seeded.projectId });
        expect(database.prepare("SELECT project_path FROM workspace_members").get()).toEqual({
            project_path: "git:new",
        });
        expect({
            claim: database
                .prepare(
                    `SELECT claims.id, claims.current_revision_id AS revisionId,
                            ids.public_id AS publicId
                       FROM claims JOIN claim_public_ids ids ON ids.claim_id = claims.id
                      WHERE ids.public_id = ?`,
                )
                .get(seeded.publicClaimId),
            revisions: database.prepare("SELECT * FROM claim_revisions ORDER BY id").all(),
            evidence: database
                .prepare("SELECT * FROM claim_evidence ORDER BY revision_id, observation_id")
                .all(),
            receipts: database.prepare("SELECT * FROM claim_operation_receipts ORDER BY id").all(),
            generations: database
                .prepare("SELECT * FROM claim_project_generations ORDER BY project_id")
                .all(),
        }).toEqual(before);
    });

    test("scenario 2: true merge of claim-owning projects refuses unchanged and guides copy or move", () => {
        const database = makeDirectDb();
        seedProjectMemoryClaim(database, {
            projectIdentity: "git:source",
            content: "Source claim.",
            operationKey: "u7-source-seed",
        });
        seedProjectMemoryClaim(database, {
            projectIdentity: "git:target",
            content: "Target claim.",
            operationKey: "u7-target-seed",
        });
        const before = {
            projects: database.prepare("SELECT * FROM projects ORDER BY id").all(),
            aliases: database
                .prepare("SELECT * FROM project_aliases ORDER BY alias_identity")
                .all(),
            claims: database.prepare("SELECT * FROM claims ORDER BY id").all(),
            receipts: database.prepare("SELECT * FROM claim_operation_receipts ORDER BY id").all(),
            generations: database
                .prepare("SELECT * FROM claim_project_generations ORDER BY project_id")
                .all(),
        };

        expect(() =>
            mergeProjectIdentities(database, "git:source", "git:target", { now: 20 }),
        ).toThrow(/explicit claim copy or move/);
        expect({
            projects: database.prepare("SELECT * FROM projects ORDER BY id").all(),
            aliases: database
                .prepare("SELECT * FROM project_aliases ORDER BY alias_identity")
                .all(),
            claims: database.prepare("SELECT * FROM claims ORDER BY id").all(),
            receipts: database.prepare("SELECT * FROM claim_operation_receipts ORDER BY id").all(),
            generations: database
                .prepare("SELECT * FROM claim_project_generations ORDER BY project_id")
                .all(),
        }).toEqual(before);
    });
});
