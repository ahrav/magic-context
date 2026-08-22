import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    copyMemoriesToProject,
    moveMemoriesToProject,
    rekeyMemoryRowWithCollisionMerge,
    selectRelocatableMemoryIds,
} from "./relocate-memory";
import { deleteMemory, insertMemory } from "./storage-memory";
import {
    getCurrentMemoryClaimByLegacyMemoryId,
    memoryClaimSupersessionExists,
    readMemoryClaimLink,
    runInMemoryClaimsWriteTransaction,
} from "./storage-memory-claims";

let db: Database | null = null;

function makeDb(): Database {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** Direct projection insert without a claim crosswalk link. */
function insertUnlinkedMemory(
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
            .run(projectPath, content, hash) as { lastInsertRowid: number | bigint };
        return Number(result.lastInsertRowid);
    });
}

function inTransaction<T>(database: Database, fn: () => T): T {
    return database.transaction(fn).immediate();
}

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("relocate-memory claims (v84)", () => {
    test("rekeying an unlinked row adopts its claim under the target project before the identity move", () => {
        const database = makeDb();
        const rowId = insertUnlinkedMemory(database, "/raw/legacy/path", "raw fact", "rk-h1");

        const changed = inTransaction(database, () =>
            rekeyMemoryRowWithCollisionMerge(database, rowId, "/raw/legacy/path", "git:resolved"),
        );

        expect(changed).toBe(true);
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(rowId),
        ).toEqual({ project_path: "git:resolved" });
        const current = getCurrentMemoryClaimByLegacyMemoryId(database, rowId);
        expect(current?.content).toBe("raw fact");
        expect(
            database
                .prepare("SELECT canonical_identity FROM projects WHERE id = ?")
                .get(current?.projectId ?? 0),
        ).toEqual({ canonical_identity: "git:resolved" });
    });

    test("a rekey onto the linked row's own numeric project keeps the claim untouched", () => {
        const database = makeDb();
        const memory = insertMemory(database, {
            projectPath: "git:stable",
            category: "CONSTRAINTS",
            content: "stable fact",
        });
        // Both identities resolve to the same numeric project.
        database
            .prepare(
                `INSERT INTO project_aliases (alias_identity, project_id, created_at)
                 SELECT 'git:alias-of-stable', project_id, 1 FROM project_aliases
                  WHERE alias_identity = 'git:stable'`,
            )
            .run();
        const linkBefore = readMemoryClaimLink(database, memory.id);

        const changed = inTransaction(database, () =>
            rekeyMemoryRowWithCollisionMerge(
                database,
                memory.id,
                "git:stable",
                "git:alias-of-stable",
            ),
        );

        expect(changed).toBe(true);
        expect(readMemoryClaimLink(database, memory.id)).toEqual(linkBefore);
        expect(database.prepare("SELECT COUNT(*) AS c FROM claims").get()).toEqual({ c: 1 });
    });

    test("a collision request cannot move a row owned by another source project", () => {
        const database = makeDb();
        insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "equivalent relocation fact",
        });
        const sourceC = insertMemory(database, {
            projectPath: "git:project-c",
            category: "CONSTRAINTS",
            content: "equivalent relocation fact",
        });
        const before = JSON.stringify({
            memories: database.prepare("SELECT * FROM memories ORDER BY id").all(),
            links: database.prepare("SELECT * FROM legacy_memory_claims ORDER BY memory_id").all(),
            claims: database.prepare("SELECT * FROM claims ORDER BY id").all(),
            generations: database
                .prepare("SELECT * FROM claim_project_generations ORDER BY project_id")
                .all(),
        });

        const changed = inTransaction(database, () =>
            rekeyMemoryRowWithCollisionMerge(
                database,
                sourceC.id,
                "git:project-a",
                "git:project-b",
            ),
        );

        expect(changed).toBeFalse();
        expect(
            JSON.stringify({
                memories: database.prepare("SELECT * FROM memories ORDER BY id").all(),
                links: database
                    .prepare("SELECT * FROM legacy_memory_claims ORDER BY memory_id")
                    .all(),
                claims: database.prepare("SELECT * FROM claims ORDER BY id").all(),
                generations: database
                    .prepare("SELECT * FROM claim_project_generations ORDER BY project_id")
                    .all(),
            }),
        ).toBe(before);
    });

    test("a collision merge selects one canonical claim, links the deleted source, and preserves stats", () => {
        const database = makeDb();
        const target = insertMemory(database, {
            projectPath: "git:shared",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const targetHash = (
            database
                .prepare("SELECT normalized_hash AS hash FROM memories WHERE id = ?")
                .get(target.id) as { hash: string }
        ).hash;
        const sourceId = insertUnlinkedMemory(
            database,
            "/raw/twin/path",
            "shared fact",
            targetHash,
        );
        database
            .prepare("UPDATE memory_stats SET seen_count = 6 WHERE memory_id = ?")
            .run(sourceId);

        const changed = inTransaction(database, () =>
            rekeyMemoryRowWithCollisionMerge(database, sourceId, "/raw/twin/path", "git:shared"),
        );

        expect(changed).toBe(true);
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(sourceId),
        ).toEqual({ c: 0 });
        expect(
            database
                .prepare("SELECT seen_count FROM memory_stats WHERE memory_id = ?")
                .get(target.id),
        ).toEqual({ seen_count: 6 });
        const links = database
            .prepare(
                "SELECT memory_id, canonical_memory_id, claim_id FROM legacy_memory_claims ORDER BY memory_id",
            )
            .all() as Array<{ memory_id: number; canonical_memory_id: number; claim_id: number }>;
        expect(links).toEqual([
            { memory_id: target.id, canonical_memory_id: target.id, claim_id: links[0].claim_id },
            { memory_id: sourceId, canonical_memory_id: target.id, claim_id: links[0].claim_id },
        ]);
        expect(database.prepare("SELECT COUNT(*) AS c FROM claims").get()).toEqual({ c: 1 });
    });

    test("an authorized cross-project move creates the target claim and retires the source claim with lineage", () => {
        const database = makeDb();
        const source = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "moving fact",
        });
        // A source sibling that references the moving row keeps referencing
        // the replacement row after the move mints a fresh row id.
        const pointer = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "pointing fact",
        });
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare("UPDATE memories SET superseded_by_memory_id = ? WHERE id = ?")
                .run(source.id, pointer.id);
            database
                .prepare(
                    "INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at) VALUES (?, 'src/moved.ts', 0, 7)",
                )
                .run(source.id);
        });
        insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "resident fact",
        });
        const sourceLink = readMemoryClaimLink(database, source.id);

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [source.id], "git:project-a", "git:project-b"),
        );

        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(source.id),
        ).toEqual({ c: 0 });
        const moved = database
            .prepare(
                "SELECT id FROM memories WHERE project_path = 'git:project-b' AND content = 'moving fact'",
            )
            .get() as { id: number };
        expect(moved).toBeDefined();
        expect(
            database
                .prepare(
                    "SELECT file_path, mapped_at FROM memory_verifications WHERE memory_id = ?",
                )
                .all(moved.id),
        ).toEqual([{ file_path: "src/moved.ts", mapped_at: 7 }]);
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(pointer.id),
        ).toEqual({ s: moved.id });
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(sourceLink?.claimId ?? 0),
        ).toEqual({ state: "archived" });
        const movedClaim = getCurrentMemoryClaimByLegacyMemoryId(database, moved.id);
        expect(movedClaim?.state).toBe("active");
        expect(movedClaim?.content).toBe("moving fact");
        expect(movedClaim?.claimId).not.toBe(sourceLink?.claimId);
        expect(database.prepare("SELECT COUNT(*) AS c FROM claim_merge_lineage").get()).toEqual({
            c: 2,
        });
    });

    test("a cross-project move of one shared-claim link keeps the claim live for the surviving sibling and retires it only with the last link", () => {
        const database = makeDb();
        const sibling = insertMemory(database, {
            projectPath: "git:stable",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        // Both identities resolve to the same numeric project, so the second
        // insert takes the dedup branch and shares the sibling's claim.
        database
            .prepare(
                `INSERT INTO project_aliases (alias_identity, project_id, created_at)
                 SELECT 'git:alias-of-stable', project_id, 1 FROM project_aliases
                  WHERE alias_identity = 'git:stable'`,
            )
            .run();
        const moving = insertMemory(database, {
            projectPath: "git:alias-of-stable",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const sharedLink = readMemoryClaimLink(database, moving.id);
        expect(sharedLink?.claimId).toBe(readMemoryClaimLink(database, sibling.id)?.claimId ?? -1);
        // Target numeric projects must exist for the authorized move path.
        insertMemory(database, {
            projectPath: "git:project-x",
            category: "CONSTRAINTS",
            content: "resident fact x",
        });
        insertMemory(database, {
            projectPath: "git:project-y",
            category: "CONSTRAINTS",
            content: "resident fact y",
        });

        const first = inTransaction(database, () =>
            moveMemoriesToProject(database, [moving.id], "git:alias-of-stable", "git:project-x"),
        );

        expect(first).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        const movedFirst = database
            .prepare(
                "SELECT id FROM memories WHERE project_path = 'git:project-x' AND content = 'shared fact'",
            )
            .get() as { id: number };
        const movedFirstLink = readMemoryClaimLink(database, movedFirst.id);
        expect(movedFirstLink?.claimId).not.toBe(sharedLink?.claimId);
        // The sibling still asserts the shared claim, so it stays live and
        // records no supersession lineage.
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(sharedLink?.claimId ?? 0),
        ).toEqual({ state: "active" });
        if (!sharedLink || !movedFirstLink) throw new Error("expected claim links after the move");
        expect(memoryClaimSupersessionExists(database, sharedLink, movedFirstLink)).toBe(false);

        const second = inTransaction(database, () =>
            moveMemoriesToProject(database, [sibling.id], "git:stable", "git:project-y"),
        );

        expect(second).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(sharedLink.claimId),
        ).toEqual({ state: "archived" });
        const movedSecond = database
            .prepare(
                "SELECT id FROM memories WHERE project_path = 'git:project-y' AND content = 'shared fact'",
            )
            .get() as { id: number };
        const movedSecondLink = readMemoryClaimLink(database, movedSecond.id);
        if (!movedSecondLink) throw new Error("expected a claim link on the second moved row");
        expect(memoryClaimSupersessionExists(database, sharedLink, movedSecondLink)).toBe(true);
    });

    test("a cross-project move translates the moved row's inherited lineage", () => {
        const database = makeDb();
        const lineageSource = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "lineage source fact",
        });
        const moving = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "lineage carrier fact",
        });
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare("UPDATE memories SET merged_from = ? WHERE id = ?")
                .run(JSON.stringify([lineageSource.id]), moving.id);
        });
        // The target numeric project must exist for the authorized move path.
        insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "resident fact",
        });

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [moving.id], "git:project-a", "git:project-b"),
        );

        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        const moved = database
            .prepare(
                "SELECT id, merged_from FROM memories WHERE project_path = 'git:project-b' AND content = 'lineage carrier fact'",
            )
            .get() as { id: number; merged_from: string };
        expect(moved.merged_from).toBe(JSON.stringify([lineageSource.id]));
        const movedLink = readMemoryClaimLink(database, moved.id);
        const lineageLink = readMemoryClaimLink(database, lineageSource.id);
        if (!movedLink || !lineageLink) throw new Error("expected claim links after the move");
        expect(
            database
                .prepare(
                    "SELECT merged_from, superseded_by_memory_id FROM claim_memory_relationship_sources WHERE memory_id = ?",
                )
                .all(moved.id),
        ).toEqual([
            {
                merged_from: JSON.stringify([lineageSource.id]),
                superseded_by_memory_id: null,
            },
        ]);
        expect(memoryClaimSupersessionExists(database, lineageLink, movedLink)).toBe(true);
        // The moved row must be mutable: the relationship guard aborts a
        // lineage-column change unless a matching relationship source exists.
        expect(() =>
            runInMemoryClaimsWriteTransaction(database, () => {
                database
                    .prepare("UPDATE memories SET merged_from = NULL WHERE id = ?")
                    .run(moved.id);
            }),
        ).not.toThrow();
    });

    test("a cross-project move repoints only snapshotted referrers and records diagnostics for unadoptable ones", () => {
        const database = makeDb();
        const source = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "moving fact",
        });
        const adoptable = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "pointing fact",
        });
        const unadoptable = insertUnlinkedMemory(database, "git:project-a", "", "empty-h1");
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare("UPDATE memories SET superseded_by_memory_id = ? WHERE id IN (?, ?)")
                .run(source.id, adoptable.id, unadoptable);
        });
        // The target numeric project must exist for the authorized move path.
        insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "resident fact",
        });

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [source.id], "git:project-a", "git:project-b"),
        );

        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        const moved = database
            .prepare(
                "SELECT id FROM memories WHERE project_path = 'git:project-b' AND content = 'moving fact'",
            )
            .get() as { id: number };
        // The adoptable referrer is repointed and its rewritten lineage is
        // snapshotted, so later lineage writes pass the relationship guard.
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(adoptable.id),
        ).toEqual({ s: moved.id });
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS c FROM claim_memory_relationship_sources
                      WHERE memory_id = ? AND superseded_by_memory_id = ?`,
                )
                .get(adoptable.id, moved.id),
        ).toEqual({ c: 1 });
        // The unadoptable referrer keeps its original pointer (visible to the
        // repair lane) and surfaces as a blocking relationships-phase
        // diagnostic instead of aborting the move on the relationship guard.
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(unadoptable),
        ).toEqual({ s: source.id });
        expect(
            database
                .prepare(
                    `SELECT phase, item_kind, reason_code, disposition
                       FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(`memory:${unadoptable}:supersession-repoint:${source.id}`),
        ).toEqual({
            phase: "relationships",
            item_kind: "supersession",
            reason_code: "empty-content",
            disposition: "blocking",
        });
    });

    test("a collision merge into an empty-content target skips with a diagnostic instead of deleting the source", () => {
        const database = makeDb();
        // The target numeric project must exist for the claims-active merge path.
        insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "resident fact",
        });
        // Whitespace-only source and empty target normalize identically, so
        // they collide on (category, normalized_hash) while the target stays
        // unadoptable (empty content) and the source raw bytes are non-empty.
        const targetId = insertUnlinkedMemory(database, "git:project-b", "", "merge-empty-h1");
        const sourceId = insertUnlinkedMemory(database, "git:project-a", "   ", "merge-empty-h1");
        // Mark the source as a v84 boundary row: deleting it without a
        // crosswalk link aborts on memories_claims_boundary_delete_guard.
        database
            .prepare(
                `INSERT OR REPLACE INTO schema_migrations_meta (key, value)
                 VALUES ('claims_backfill_boundary_memory_id', ?)`,
            )
            .run(String(sourceId));

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [sourceId], "git:project-a", "git:project-b"),
        );

        // The merge is skipped, not aborted: the source survives under its
        // original project (nothing merged), the empty target is untouched,
        // and the stalled merge surfaces as a blocking diagnostic.
        expect(result).toEqual({ relocated: 0, merged: 0, skipped: 0 });
        expect(
            database
                .prepare("SELECT project_path, content FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ project_path: "git:project-a", content: "   " });
        expect(database.prepare("SELECT content FROM memories WHERE id = ?").get(targetId)).toEqual(
            { content: "" },
        );
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
    });

    test("a collision merge from a claim-invalid source skips with a diagnostic and leaves sibling rows moving", () => {
        const database = makeDb();
        const target = insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const sourceId = insertUnlinkedMemory(
            database,
            "git:project-a",
            "shared fact",
            target.normalizedHash,
        );
        const siblingId = insertUnlinkedMemory(database, "git:project-a", "healthy fact", "cm-h2");
        // Importance outside 1..100 is schema-legal on memories but
        // claim-invalid, so the unlinked source can never acquire the
        // crosswalk link the merge-delete demands.
        runInMemoryClaimsWriteTransaction(database, () => {
            database.prepare("UPDATE memories SET importance = 0 WHERE id = ?").run(sourceId);
        });

        const result = inTransaction(database, () =>
            moveMemoriesToProject(
                database,
                [sourceId, siblingId],
                "git:project-a",
                "git:project-b",
            ),
        );

        // The invalid source is skipped fail-visible while the healthy
        // sibling still relocates in the same batch.
        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(sourceId),
        ).toEqual({ project_path: "git:project-a" });
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(siblingId),
        ).toEqual({ project_path: "git:project-b" });
        expect(
            database
                .prepare(
                    `SELECT phase, item_kind, reason_code, disposition
                       FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(`memory:${sourceId}:collision-merge:${target.id}`),
        ).toEqual({
            phase: "relationships",
            item_kind: "merge",
            reason_code: "invalid-importance",
            disposition: "blocking",
        });
    });

    test("a collision merge from an empty-content source skips with a diagnostic instead of silently deleting it", () => {
        const database = makeDb();
        const target = insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const sourceId = insertUnlinkedMemory(database, "git:project-a", "", target.normalizedHash);

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [sourceId], "git:project-a", "git:project-b"),
        );

        // A non-boundary empty source previously deleted silently with its
        // lineage record lost; the skip preserves it fail-visible.
        expect(result).toEqual({ relocated: 0, merged: 0, skipped: 0 });
        expect(
            database
                .prepare("SELECT project_path, content FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ project_path: "git:project-a", content: "" });
        expect(
            database
                .prepare(
                    `SELECT reason_code, disposition FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(`memory:${sourceId}:collision-merge:${target.id}`),
        ).toEqual({ reason_code: "empty-content", disposition: "blocking" });
    });

    test("a collision merge from an empty-content boundary source skips instead of tripping the delete guard", () => {
        const database = makeDb();
        const target = insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        const sourceId = insertUnlinkedMemory(database, "git:project-a", "", target.normalizedHash);
        // A v84 boundary row: deleting it without a crosswalk link aborts on
        // memories_claims_boundary_delete_guard.
        database
            .prepare(
                `INSERT OR REPLACE INTO schema_migrations_meta (key, value)
                 VALUES ('claims_backfill_boundary_memory_id', ?)`,
            )
            .run(String(sourceId));

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [sourceId], "git:project-a", "git:project-b"),
        );

        expect(result).toEqual({ relocated: 0, merged: 0, skipped: 0 });
        expect(
            database
                .prepare("SELECT project_path, content FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ project_path: "git:project-a", content: "" });
        expect(
            database
                .prepare(
                    `SELECT reason_code, disposition FROM claim_backfill_failures WHERE item_key = ?`,
                )
                .get(`memory:${sourceId}:collision-merge:${target.id}`),
        ).toEqual({ reason_code: "empty-content", disposition: "blocking" });
    });

    test("a collision merge onto a claims-deleted equivalent reactivates the target's adopted claim", () => {
        const database = makeDb();
        const deleted = insertMemory(database, {
            projectPath: "git:project-b",
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
        // A re-added unlinked twin of the deleted row: the merge target that
        // dedups onto the archived canonical claim.
        const targetId = insertUnlinkedMemory(
            database,
            "git:project-b",
            "revived fact",
            deleted.normalizedHash,
        );
        const source = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "revived fact",
        });

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [source.id], "git:project-a", "git:project-b"),
        );

        expect(result).toEqual({ relocated: 0, merged: 1, skipped: 0 });
        const targetClaim = getCurrentMemoryClaimByLegacyMemoryId(database, targetId);
        expect(targetClaim?.claimId).toBe(archivedLink?.claimId ?? 0);
        expect(targetClaim?.state).toBe("active");
    });

    test("a side-table-verified collision target records a verified event on its adopted claim", () => {
        const database = makeDb();
        const source = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "shared fact",
        });
        // The target numeric project must exist for the claims-active merge path.
        insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "resident fact",
        });
        const targetId = insertUnlinkedMemory(
            database,
            "git:project-b",
            "shared fact",
            source.normalizedHash,
        );
        // Pre-v84 TypeScript verification: positive verified_at lives only in
        // memory_verifications; the projection columns stay unverified.
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    `INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                     VALUES (?, 'src/compat.ts', 123, 100)`,
                )
                .run(targetId);
        });

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [source.id], "git:project-a", "git:project-b"),
        );

        expect(result).toEqual({ relocated: 0, merged: 1, skipped: 0 });
        const targetClaim = getCurrentMemoryClaimByLegacyMemoryId(database, targetId);
        expect(targetClaim?.state).toBe("active");
        expect(
            database
                .prepare(
                    `SELECT outcome, verifier FROM verification_events
                      WHERE revision_id IN (SELECT id FROM claim_revisions WHERE claim_id = ?)`,
                )
                .all(targetClaim?.claimId ?? 0),
        ).toEqual([{ outcome: "verified", verifier: "memory-relocation" }]);
    });

    test("copying creates a target claim for each fresh row and leaves the source intact", () => {
        const database = makeDb();
        const source = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "copied fact",
        });
        const ids = selectRelocatableMemoryIds(database, "git:project-a");

        const result = inTransaction(database, () =>
            copyMemoriesToProject(database, ids, "git:project-b"),
        );

        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        const copied = database
            .prepare("SELECT id FROM memories WHERE project_path = 'git:project-b'")
            .get() as { id: number };
        expect(copied).toBeDefined();
        const sourceClaim = getCurrentMemoryClaimByLegacyMemoryId(database, source.id);
        const copiedClaim = getCurrentMemoryClaimByLegacyMemoryId(database, copied.id);
        expect(sourceClaim?.state).toBe("active");
        expect(copiedClaim?.state).toBe("active");
        expect(copiedClaim?.claimId).not.toBe(sourceClaim?.claimId);
        expect(copiedClaim?.content).toBe("copied fact");
    });

    test("copying onto a deleted equivalent reactivates the adopted archived claim", () => {
        const database = makeDb();
        const deleted = insertMemory(database, {
            projectPath: "git:project-b",
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
        const source = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "revived fact",
        });

        const result = inTransaction(database, () =>
            copyMemoriesToProject(database, [source.id], "git:project-b"),
        );

        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        const copied = database
            .prepare("SELECT id FROM memories WHERE project_path = 'git:project-b'")
            .get() as { id: number };
        const copiedClaim = getCurrentMemoryClaimByLegacyMemoryId(database, copied.id);
        expect(copiedClaim?.claimId).toBe(archivedLink?.claimId ?? 0);
        expect(copiedClaim?.state).toBe("active");
    });

    test("a claim-invalid source row is skipped with a diagnostic instead of aborting the copy batch", () => {
        const database = makeDb();
        const first = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "good copy fact one",
        });
        // Schema-legal but claim-invalid: the scope value passes the memories
        // table but fails the adoption metadata gate.
        let badId = 0;
        runInMemoryClaimsWriteTransaction(database, () => {
            badId = Number(
                database
                    .prepare(
                        `INSERT INTO memories
                            (project_path, category, content, normalized_hash, scope, first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES ('git:project-a', 'CONSTRAINTS', 'claim-invalid fact', 'ci-h1', 'galaxy', 1, 1, 1, 1)`,
                    )
                    .run().lastInsertRowid,
            );
        });
        const second = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "good copy fact two",
        });

        const result = inTransaction(database, () =>
            copyMemoriesToProject(database, [first.id, badId, second.id], "git:project-b"),
        );

        expect(result).toEqual({ relocated: 2, merged: 0, skipped: 1 });
        const copied = database
            .prepare(
                "SELECT content FROM memories WHERE project_path = 'git:project-b' ORDER BY id",
            )
            .all() as Array<{ content: string }>;
        expect(copied.map((row) => row.content)).toEqual([
            "good copy fact one",
            "good copy fact two",
        ]);
        expect(
            database
                .prepare(
                    "SELECT reason_code AS reasonCode, disposition, detail FROM claim_backfill_failures WHERE item_key = ?",
                )
                .get(String(badId)),
        ).toEqual({
            reasonCode: "invalid-scope",
            disposition: "blocking",
            detail: "git:project-b",
        });
    });

    test("a cross-project move onto a deleted equivalent reactivates the adopted archived claim", () => {
        const database = makeDb();
        const deleted = insertMemory(database, {
            projectPath: "git:project-b",
            category: "CONSTRAINTS",
            content: "migrating fact",
        });
        const archivedLink = readMemoryClaimLink(database, deleted.id);
        deleteMemory(database, deleted.id);
        const source = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "migrating fact",
        });

        const result = inTransaction(database, () =>
            moveMemoriesToProject(database, [source.id], "git:project-a", "git:project-b"),
        );

        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        const moved = database
            .prepare("SELECT id FROM memories WHERE project_path = 'git:project-b'")
            .get() as { id: number };
        const movedClaim = getCurrentMemoryClaimByLegacyMemoryId(database, moved.id);
        expect(movedClaim?.claimId).toBe(archivedLink?.claimId ?? 0);
        expect(movedClaim?.state).toBe("active");
    });

    test("copying a verified memory records verified evidence on the target claim", () => {
        const database = makeDb();
        const source = insertMemory(database, {
            projectPath: "git:project-a",
            category: "CONSTRAINTS",
            content: "verified fact",
        });
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    "UPDATE memories SET verification_status = 'verified', verified_at = 123 WHERE id = ?",
                )
                .run(source.id);
        });

        const result = inTransaction(database, () =>
            copyMemoriesToProject(database, [source.id], "git:project-b"),
        );

        expect(result).toEqual({ relocated: 1, merged: 0, skipped: 0 });
        const copied = database
            .prepare("SELECT id FROM memories WHERE project_path = 'git:project-b'")
            .get() as { id: number };
        const copiedClaim = getCurrentMemoryClaimByLegacyMemoryId(database, copied.id);
        expect(copiedClaim?.state).toBe("active");
        expect(
            database
                .prepare(
                    `SELECT outcome, verifier FROM verification_events
                      WHERE revision_id IN (SELECT id FROM claim_revisions WHERE claim_id = ?)`,
                )
                .all(copiedClaim?.claimId ?? 0),
        ).toEqual([{ outcome: "verified", verifier: "memory-relocation" }]);
    });

    test("a pre-v84 database keeps the plain rekey behavior", () => {
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
                source_session_id TEXT,
                UNIQUE(project_path, category, normalized_hash)
            );
            CREATE TABLE memory_embeddings (
                memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
                embedding BLOB NOT NULL,
                model_id TEXT
            );
        `);
        database
            .prepare(
                "INSERT INTO memories (project_path, category, content, normalized_hash) VALUES ('git:old', 'CONSTRAINTS', 'legacy fact', 'lg-h1')",
            )
            .run();

        const changed = inTransaction(database, () =>
            rekeyMemoryRowWithCollisionMerge(database, 1, "git:old", "git:new"),
        );

        expect(changed).toBe(true);
        expect(database.prepare("SELECT project_path FROM memories WHERE id = 1").get()).toEqual({
            project_path: "git:new",
        });
    });

    test("a non-canonical relocation target throws instead of silently skipping claim work", () => {
        const database = makeDb();
        const memory = insertMemory(database, {
            projectPath: "git:origin",
            category: "CONSTRAINTS",
            content: "anchored fact",
        });

        expect(() =>
            inTransaction(database, () =>
                rekeyMemoryRowWithCollisionMerge(database, memory.id, "git:origin", "/raw/target"),
            ),
        ).toThrow(/does not resolve to a canonical git:\/dir: project/);
        expect(() =>
            inTransaction(database, () =>
                copyMemoriesToProject(database, [memory.id], "/raw/target"),
            ),
        ).toThrow(/does not resolve to a canonical git:\/dir: project/);

        // The rolled-back transactions leave the row where it was.
        expect(
            database.prepare("SELECT project_path FROM memories WHERE id = ?").get(memory.id),
        ).toEqual({ project_path: "git:origin" });
        expect(database.prepare("SELECT COUNT(*) AS c FROM memories").get()).toEqual({ c: 1 });
    });
});
