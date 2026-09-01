/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createProjectMemoryClaim } from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import { createDirectTestDatabase } from "../test-database";
import { dreamerManifestIdentity, readDreamerProjectClaims } from "./claim-manifest";
import { acquireLease, runLeaseGuardedWrite } from "./lease";
import { claimEffectMemoryChanges, getDreamRuns, insertDreamRun } from "./storage-dream-runs";
import { applyCurateManifest } from "./task-executor";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const d = createDirectTestDatabase().db;
    return d;
}

describe("dream_runs memory-change id arrays (#221)", () => {
    it("round-trips exact changed-id arrays through memory_changes_json", () => {
        db = freshDb();
        insertDreamRun(db, {
            projectPath: "dir:proj",
            startedAt: 1000,
            finishedAt: 2000,
            holderId: "h",
            tasks: [{ name: "improve", durationMs: 10, resultChars: 0 }],
            tasksSucceeded: 1,
            tasksFailed: 0,
            smartNotesSurfaced: 0,
            smartNotesPending: 0,
            memoryChanges: {
                written: 2,
                deleted: 0,
                archived: 1,
                merged: 0,
                writtenIds: [10, 11],
                deletedIds: [],
                archivedIds: [42],
                mergedIds: [],
            },
        });

        const [row] = getDreamRuns(db, "dir:proj", 10);
        expect(row).toBeDefined();
        const parsed = JSON.parse(row.memory_changes_json as string);
        // Counts stay === their array lengths (the persisted-blob contract).
        expect(parsed.written).toBe(2);
        expect(parsed.writtenIds).toEqual([10, 11]);
        expect(parsed.archived).toBe(1);
        expect(parsed.archivedIds).toEqual([42]);
        expect(parsed.mergedIds).toEqual([]);
    });

    it("stores null memory_changes_json when there were no changes", () => {
        db = freshDb();
        insertDreamRun(db, {
            projectPath: "dir:proj",
            startedAt: 1000,
            finishedAt: 2000,
            holderId: "h",
            tasks: [{ name: "verify", durationMs: 5, resultChars: 0 }],
            tasksSucceeded: 1,
            tasksFailed: 0,
            smartNotesSurfaced: 0,
            smartNotesPending: 0,
            memoryChanges: null,
        });
        const [row] = getDreamRuns(db, "dir:proj", 10);
        expect(row.memory_changes_json).toBeNull();
    });
});

function freshClaimDb(): Database {
    return createDirectTestDatabase().db;
}

function seedClaim(db: Database, projectIdentity: string, index: number): string {
    const content = `Curated fact ${index}.`;
    const result = createProjectMemoryClaim(
        db,
        { producer: "dream-runs-test", operationKey: `seed-${projectIdentity}-${index}` },
        {
            projectId: ensureProject(db, projectIdentity),
            content,
            category: "ARCHITECTURE",
            provenance: {
                sourceLocator: `test://curate/${index}`,
                sourceContent: content,
                extractor: "test",
                extractorVersion: "1",
                extractorRunId: "seed",
                independenceKey: `seed-${index}`,
                sourceTrustClass: "explicit_user",
            },
            actor: "user:test",
        },
    );
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

describe("dream_runs claim-native change ids", () => {
    it("records the public claim ids a real curate run revised, archived, and merged", () => {
        db = freshClaimDb();
        const projectIdentity = "git:curate-telemetry";
        const [updated, archived, mergeTarget, mergeSource] = [1, 2, 3, 4].map((index) =>
            seedClaim(db as Database, projectIdentity, index),
        );
        const claims = readDreamerProjectClaims(db, projectIdentity, "curate");
        expect(claims).toHaveLength(4);
        const holderId = "curate-holder";
        const leaseKey = "curate-lease";
        expect(acquireLease(db, holderId, leaseKey)).toBe(true);
        const identity = dreamerManifestIdentity({
            db,
            holderId,
            leaseKey,
            task: "curate",
            publicClaimIds: claims.map((claim) => claim.publicClaimId),
        });

        const applied = runLeaseGuardedWrite(db, holderId, leaseKey, () =>
            applyCurateManifest({
                db: db as Database,
                projectIdentity,
                claims,
                identity,
                manifestText:
                    "<curate>" +
                    `<update claim="${updated}">Revised curated fact.</update>` +
                    `<archive claim="${archived}" reason="superseded by newer evidence"/>` +
                    `<merge target="${mergeTarget}" sources="${mergeSource}">Merged curated fact.</merge>` +
                    "</curate>",
            }),
        );
        expect(applied.operation.outcome).toBe("applied");

        const changes = claimEffectMemoryChanges(applied.operation.result.effects);
        if (!changes) throw new Error("curate effects produced no memory changes");
        insertDreamRun(db, {
            projectPath: projectIdentity,
            startedAt: 1000,
            finishedAt: 2000,
            holderId,
            tasks: [{ name: "curate", durationMs: 10, resultChars: 0 }],
            tasksSucceeded: 1,
            tasksFailed: 0,
            smartNotesSurfaced: 0,
            smartNotesPending: 0,
            memoryChanges: changes,
        });

        const [row] = getDreamRuns(db, projectIdentity, 10);
        const parsed = JSON.parse(row.memory_changes_json as string);
        // The update and merge target each have a new revision.
        expect(new Set(parsed.claimUpsertedIds)).toEqual(new Set([updated, mergeTarget]));
        // The archived claim and the retired merge source only changed lifecycle.
        expect(new Set(parsed.claimLifecycleIds)).toEqual(new Set([archived, mergeSource]));
        expect(parsed.claimOtherIds).toBeUndefined();
    });

    it("leaves the legacy numeric fields empty so blob readers keep their fallback", () => {
        // Consumers treat absent legacy ID arrays as a request to reconstruct changes from the run window.
        // Consumers treat empty legacy ID arrays as an exact empty change set rather than reconstructing changes from the run window.
        const changes = claimEffectMemoryChanges([
            {
                effectKey: "upsert:a:r2",
                changeKind: "upsert",
                projectId: 1,
                generation: 1,
                revisionLocator: `mcm_${"a".repeat(32)}/r2/${"1".repeat(64)}`,
            },
        ]);
        if (!changes) throw new Error("expected memory changes");
        expect(changes.writtenIds).toBeUndefined();
        expect(changes.archivedIds).toBeUndefined();
        expect(changes.mergedIds).toBeUndefined();
        expect(changes.deletedIds).toBeUndefined();
        // Legacy counts remain 0 because the change-presence gate ORs every blob value; nonzero counts render a block without drill-down.
        expect({ ...changes, claimUpsertedIds: undefined }).toEqual({
            written: 0,
            deleted: 0,
            archived: 0,
            merged: 0,
            claimUpsertedIds: undefined,
        });
        expect(JSON.parse(JSON.stringify(changes)).writtenIds).toBeUndefined();
    });

    it("buckets an unrecognized change kind instead of dropping it", () => {
        const changes = claimEffectMemoryChanges([
            {
                effectKey: "verification:b:1",
                changeKind: "verification",
                projectId: 1,
                generation: 1,
                revisionLocator: `mcm_${"b".repeat(32)}/r1/${"2".repeat(64)}`,
            },
        ]);
        expect(changes?.claimOtherIds).toEqual([`mcm_${"b".repeat(32)}`]);
    });

    it("returns null when no effect carries a resolvable claim id", () => {
        expect(
            claimEffectMemoryChanges([
                {
                    effectKey: "upsert:gone:r1",
                    changeKind: "upsert",
                    projectId: 1,
                    generation: 1,
                    revisionLocator: null,
                },
            ]),
        ).toBeNull();
        expect(claimEffectMemoryChanges([])).toBeNull();
    });
});
