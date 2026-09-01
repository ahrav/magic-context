import { describe, expect, it } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import { createDirectTestDatabase } from "../test-database";
import {
    deleteUserMemoryCandidates,
    getActiveUserMemories,
    getUserMemoryCandidateProjectIdentities,
    getUserMemoryCandidates,
    insertUserMemory,
    insertUserMemoryCandidates,
    pruneExpiredUserMemoryCandidates,
    USER_MEMORY_CANDIDATE_TTL_MS,
    updateUserMemoryContent,
} from "./storage-user-memory";

function freshDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

describe("user-memory provenance", () => {
    it("retains candidate session provenance after promotion consumes the candidate", () => {
        const db = freshDb();
        insertUserMemoryCandidates(db, [
            {
                content: "User prefers concise updates",
                sessionId: "ses_source",
                sourceCompartmentStart: 4,
                sourceCompartmentEnd: 9,
            },
        ]);
        const [candidate] = getUserMemoryCandidates(db);

        db.transaction(() => {
            insertUserMemory(db, "User prefers concise updates", [candidate.id]);
            deleteUserMemoryCandidates(db, [candidate.id]);
        })();

        expect(getUserMemoryCandidates(db)).toHaveLength(0);
        expect(getActiveUserMemories(db)[0].sourceProvenance).toEqual([
            {
                candidateId: candidate.id,
                sessionId: "ses_source",
                sourceCompartmentStart: 4,
                sourceCompartmentEnd: 9,
            },
        ]);
        db.close();
    });

    it("merges update provenance before candidates are consumed", () => {
        const db = freshDb();
        insertUserMemoryCandidates(db, [
            { content: "first", sessionId: "s1", sourceCompartmentStart: 1 },
            { content: "second", sessionId: "s2", sourceCompartmentStart: 2 },
        ]);
        const [first, second] = getUserMemoryCandidates(db);
        const memoryId = insertUserMemory(db, "Initial profile", [first.id]);

        db.transaction(() => {
            updateUserMemoryContent(db, memoryId, "Updated profile", [second.id]);
            deleteUserMemoryCandidates(db, [first.id, second.id]);
        })();

        expect(getActiveUserMemories(db)[0]).toMatchObject({
            content: "Updated profile",
            sourceCandidateIds: [first.id, second.id],
            sourceProvenance: [
                {
                    candidateId: first.id,
                    sessionId: "s1",
                    sourceCompartmentStart: 1,
                    sourceCompartmentEnd: null,
                },
                {
                    candidateId: second.id,
                    sessionId: "s2",
                    sourceCompartmentStart: 2,
                    sourceCompartmentEnd: null,
                },
            ],
        });
        db.close();
    });

    it("rolls profile promotion, merge, and dismissal back with the outer transaction", () => {
        const db = freshDb();
        insertUserMemoryCandidates(db, [{ content: "candidate", sessionId: "s1" }]);
        const [candidate] = getUserMemoryCandidates(db);
        const memoryId = insertUserMemory(db, "Initial profile", []);

        expect(() =>
            db.transaction(() => {
                insertUserMemory(db, "Promoted profile", [candidate.id]);
                updateUserMemoryContent(db, memoryId, "Updated profile", [candidate.id]);
                deleteUserMemoryCandidates(db, [candidate.id]);
                throw new Error("rollback");
            })(),
        ).toThrow("rollback");

        expect(getActiveUserMemories(db).map((memory) => memory.content)).toEqual([
            "Initial profile",
        ]);
        expect(getUserMemoryCandidates(db)).toHaveLength(1);
        db.close();
    });

    it("resolves candidate project identities without changing the candidate store", () => {
        const db = freshDb();
        insertUserMemoryCandidates(db, [{ content: "candidate", sessionId: "s1" }]);
        const [candidate] = getUserMemoryCandidates(db);
        db.prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES ('s1', 'opencode', 'git:one', 1), ('s1', 'pi', 'git:one', 1)`,
        ).run();

        expect(getUserMemoryCandidateProjectIdentities(db, [candidate.id])).toEqual(
            new Map([[candidate.id, ["git:one"]]]),
        );
        expect(getUserMemoryCandidates(db)).toHaveLength(1);
        db.close();
    });

    it("reports legacy bare candidate ids as unknown provenance", () => {
        const db = freshDb();
        db.prepare(
            `INSERT INTO user_memories
                (content, status, promoted_at, source_candidate_ids, created_at, updated_at)
             VALUES (?, 'active', ?, ?, ?, ?)`,
        ).run("Legacy observation", 1, "[41]", 1, 1);

        expect(getActiveUserMemories(db)[0].sourceCandidateIds).toEqual([41]);
        expect(getActiveUserMemories(db)[0].sourceProvenance).toBeNull();
        db.close();
    });
});

describe("user-memory candidate decay", () => {
    it("prunes candidates older than the TTL, keeps fresher ones", () => {
        const db = freshDb();
        const now = 1_000_000_000_000;
        insertUserMemoryCandidates(db, [
            { content: "stale one-off", sessionId: "s1" },
            { content: "recent observation", sessionId: "s1" },
        ]);
        const [stale, recent] = getUserMemoryCandidates(db);
        db.prepare("UPDATE user_memory_candidates SET created_at = ? WHERE id = ?").run(
            now - USER_MEMORY_CANDIDATE_TTL_MS - 1,
            stale.id,
        );
        db.prepare("UPDATE user_memory_candidates SET created_at = ? WHERE id = ?").run(
            now - 1000,
            recent.id,
        );

        const pruned = pruneExpiredUserMemoryCandidates(db, USER_MEMORY_CANDIDATE_TTL_MS, now);
        expect(pruned).toBe(1);

        const survivors = getUserMemoryCandidates(db);
        expect(survivors).toHaveLength(1);
        expect(survivors[0].content).toBe("recent observation");
        db.close();
    });

    it("prunes nothing when all candidates are within the TTL", () => {
        const db = freshDb();
        insertUserMemoryCandidates(db, [{ content: "fresh", sessionId: "s1" }]);
        const pruned = pruneExpiredUserMemoryCandidates(db, USER_MEMORY_CANDIDATE_TTL_MS);
        expect(pruned).toBe(0);
        expect(getUserMemoryCandidates(db)).toHaveLength(1);
        db.close();
    });
});
