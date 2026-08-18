/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";

let queryEmbedding: Float32Array | null = null;
const embeddingQueries: string[] = [];
const rawMessagesBySession = new Map<
    string,
    Array<{ ordinal: number; id: string; role: string; parts: unknown[] }>
>();

import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    chunkCanonicalText,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { appendCompartments, getCompartments, replaceSessionFacts } from "./compartment-storage";
import { upsertCommits } from "./git-commits";
import { getMemoryById, insertMemory, resetEmbeddingCacheForTests, saveEmbedding } from "./memory";
import { ensureMessagesIndexed } from "./message-index";
import { runMigrations } from "./migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    registerProjectEmbedding,
} from "./project-embedding-registry";
import {
    assignMessagesToCompartments,
    type CompartmentSearchResult,
    type MessageSearchResult,
    mergeMessageAndCompartmentResults,
    parseIdShapedQuery,
    resolveMemoriesByIdsForSearch,
    type UnifiedSearchResult,
    unifiedSearch,
} from "./search";
import { QueryBoundsError } from "./search-bounds";
import { countingDatabase } from "./sql-counters";
import { initializeDatabase } from "./storage-db";
import {
    addNote,
    countNoteFtsMatchesBatch,
    dismissNote,
    selectNoteCandidateIds,
    updateNote,
} from "./storage-notes";
import { createPrimer } from "./storage-primers";

const readMessages = (sessionId: string) => rawMessagesBySession.get(sessionId) ?? [];
const embedQuery = async (text: string) => {
    embeddingQueries.push(text);
    return queryEmbedding ? new Float32Array(queryEmbedding) : null;
};
const isEmbeddingRuntimeEnabled = () => true;

function seedCompartmentChunkEmbedding(
    db: Database,
    sessionId: string,
    projectPath: string,
    vector: Float32Array,
    modelId = "mock:model",
): number {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "u1",
            endMessageId: "a2",
            title: "Queue saturation design",
            content: "P1 content",
            p1: "P1 content",
        },
    ]);
    const compartment = getCompartments(db, sessionId)[0];
    const windows = chunkCanonicalText(
        "[1] U: queue saturation problem\n[2] A: bounded drains with backpressure",
        1,
        2,
        10_000,
    );
    replaceCompartmentChunkEmbeddings(
        db,
        windows.map((window) => ({
            compartmentId: compartment.id,
            sessionId,
            projectPath,
            window,
            modelId,
            vector,
        })),
    );
    return compartment.id;
}

function registerEmbeddingProject(db: Database, projectPath: string) {
    return registerProjectEmbedding(
        db,
        projectPath,
        { provider: "local", model: "mock-model" },
        { memoryEnabled: true, gitCommitEnabled: true },
        projectPath,
    );
}

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    // runMigrations adds the git_commits + git_commits_fts tables that the
    // dedup regression test exercises. Production code calls both functions
    // back-to-back inside openDatabase(); the test path historically only
    // called initializeDatabase() because no test needed the v4 schema.
    runMigrations(db);
    return db;
}

afterEach(() => {
    queryEmbedding = null;
    embeddingQueries.length = 0;
    rawMessagesBySession.clear();
    resetEmbeddingCacheForTests();
    _resetProjectEmbeddingRegistryForTests();
});

describe("unifiedSearch", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("returns promoted Primers through explicit recall search", async () => {
        createPrimer(db, {
            projectPath: "git:test",
            question: "How does the cache system work?",
            answer: "The prompt cache stays stable because Primers are recall-only.",
            totalSupport: 2,
            lastObservedAt: Date.UTC(2026, 0, 8),
            sourceCandidateIds: [1, 2],
        });

        const results = await unifiedSearch(db, "session-1", "git:test", "cache system primers", {
            sources: ["primer"],
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: false,
            gitCommitsEnabled: false,
        });

        expect(results).toHaveLength(1);
        expect(results[0].source).toBe("primer");
        if (results[0].source === "primer") {
            expect(results[0].question).toBe("How does the cache system work?");
            expect(results[0].support).toBe(2);
        }
    });

    it("returns ranked results across memories and messages (no facts)", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Magic context stores ranked search data in SQLite.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        // Facts are inserted but should NEVER appear in ctx_search results —
        // they're always rendered in <session-history> so returning them from
        // search is redundant.
        replaceSessionFacts(db, "ses-1", [
            {
                category: "WORKFLOW_RULES",
                content: "ranked search flow.",
            },
        ]);

        rawMessagesBySession.set("ses-1", [
            {
                ordinal: 1,
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "Can you add ranked search across the history?" }],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "assistant",
                parts: [
                    {
                        type: "text",
                        text: "I will implement message history indexing for ranked search.",
                    },
                ],
            },
        ]);
        ensureMessagesIndexed(db, "ses-1", readMessages);

        const results = await unifiedSearch(db, "ses-1", "/repo/project", "ranked search", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        });

        expect(results.length).toBeGreaterThan(0);
        const sources = results.map((r) => r.source);
        expect(sources).toContain("memory");
        expect(sources).toContain("message");
        // Facts are NOT a ctx_search source — they're always visible in message[0].
        expect(sources).not.toContain("fact");
        const messageResults = results.filter((r) => r.source === "message");
        expect(messageResults.length).toBeGreaterThan(0);
        expect(embeddingQueries).toEqual(["ranked search"]);
        expect(getMemoryById(db, memory.id)?.retrievalCount).toBe(1);
    });

    it("filters ctx_search workspace memory candidates and FTS hits by shared categories", async () => {
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', '["CONSTRAINTS"]', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const own = insertMemory(db, {
            projectPath: "git:own",
            category: "NAMING",
            content: "own naming needle",
        });
        const foreignShared = insertMemory(db, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign constraint needle",
        });
        db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(foreignShared.id);
        const foreignHidden = insertMemory(db, {
            projectPath: "git:foreign",
            category: "NAMING",
            content: "foreign naming needle",
        });

        const results = await unifiedSearch(db, "ses-1", "git:own", "needle", {
            limit: 10,
            memoryEnabled: true,
            embeddingEnabled: false,
            sources: ["memory"],
        });

        const memoryIds = results
            .filter((result) => result.source === "memory")
            .map((result) => result.memoryId)
            .sort((left, right) => left - right);
        expect(memoryIds).toEqual([own.id, foreignShared.id]);
        expect(memoryIds).not.toContain(foreignHidden.id);
    });

    it("fails closed for malformed workspace share categories during memory search", async () => {
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', 'not-json', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const own = insertMemory(db, {
            projectPath: "git:own",
            category: "CONSTRAINTS",
            content: "own malformed-policy needle",
        });
        const foreign = insertMemory(db, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign malformed-policy needle",
        });

        const results = await unifiedSearch(db, "ses-1", "git:own", "malformed-policy", {
            limit: 10,
            memoryEnabled: true,
            embeddingEnabled: false,
            sources: ["memory"],
        });

        const memoryIds = results
            .filter((result) => result.source === "memory")
            .map((result) => result.memoryId);
        expect(memoryIds).toContain(own.id);
        expect(memoryIds).not.toContain(foreign.id);
    });

    it("uses the designed CONSTRAINTS default for legacy NULL workspace share categories", async () => {
        db.exec(`
            DROP TABLE workspace_members;
            DROP TABLE workspaces;
            CREATE TABLE workspaces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                share_categories TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE workspace_members (
                workspace_id INTEGER NOT NULL,
                project_path TEXT NOT NULL,
                display_name TEXT NOT NULL,
                display_path TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (workspace_id, project_path)
            );
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', NULL, 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const foreignConstraint = insertMemory(db, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "foreign legacy-null constraint needle",
        });
        db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(foreignConstraint.id);
        const foreignNaming = insertMemory(db, {
            projectPath: "git:foreign",
            category: "NAMING",
            content: "foreign legacy-null naming needle",
        });

        const results = await unifiedSearch(db, "ses-1", "git:own", "legacy-null", {
            limit: 10,
            memoryEnabled: true,
            embeddingEnabled: false,
            sources: ["memory"],
        });

        const memoryIds = results
            .filter((result) => result.source === "memory")
            .map((result) => result.memoryId);
        expect(memoryIds).toContain(foreignConstraint.id);
        expect(memoryIds).not.toContain(foreignNaming.id);
    });

    it("ignores workspace memory vectors from inactive embedding models", async () => {
        const snapshot = registerEmbeddingProject(db, "git:own");
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', '["NAMING"]', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const own = insertMemory(db, {
            projectPath: "git:own",
            category: "NAMING",
            content: "own semantic-only memory",
        });
        const foreign = insertMemory(db, {
            projectPath: "git:foreign",
            category: "NAMING",
            content: "foreign stale-model memory",
        });
        saveEmbedding(db, own.id, new Float32Array([1, 0]), snapshot.modelId);
        saveEmbedding(db, foreign.id, new Float32Array([1, 0]), "stale:model");
        queryEmbedding = new Float32Array([1, 0]);

        const results = await unifiedSearch(db, "ses-1", "git:own", "vector-only", {
            limit: 10,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["memory"],
        });

        const memoryIds = results
            .filter((result) => result.source === "memory")
            .map((result) => result.memoryId);
        expect(memoryIds).toContain(own.id);
        expect(memoryIds).not.toContain(foreign.id);
    });

    it("maxMessageOrdinal=0 excludes every message (no compartment yet → whole tail is live)", async () => {
        // Issue #131: before the historian first runs there are no compartments,
        // so the ctx_search tool passes a cutoff of 0. Ordinals are 1-based, so a
        // 0 cutoff must exclude EVERY indexed message — none have scrolled out of
        // the live context the agent already sees (incl. the current prompt).
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Magic context stores ranked search data in SQLite.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        rawMessagesBySession.set("ses-1", [
            {
                ordinal: 1,
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "delete all entries in the ranked_search table" }],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "assistant",
                parts: [{ type: "text", text: "ranked_search table cleanup acknowledged." }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-1", readMessages);

        const results = await unifiedSearch(db, "ses-1", "/repo/project", "ranked_search", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            maxMessageOrdinal: 0,
        });

        // No message results — the current prompt must NOT come back.
        expect(results.filter((r) => r.source === "message")).toHaveLength(0);
        // Memory results are unaffected by the message-ordinal cutoff.
        expect(results.some((r) => r.source === "memory")).toBe(true);
    });

    it("returns note hits with id, status, anchor, and ready_reason text", async () => {
        const readyNote = addNote(db, "smart", {
            content: "Retry the queue benchmark after the release.",
            projectPath: "git:test",
            sessionId: "ses-note",
            surfaceCondition: "When the release ships",
            anchorOrdinal: 41,
        });
        updateNote(
            db,
            readyNote.id,
            {
                status: "ready",
                readyReason: "Release shipped with the new queue drain.",
            },
            {
                sessionId: "ses-note",
                projectPath: "git:test",
            },
        );

        const results = await unifiedSearch(db, "ses-note", "git:test", "queue drain shipped", {
            limit: 5,
            memoryEnabled: false,
            embeddingEnabled: false,
            sources: ["note"],
        });

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            source: "note",
            noteId: readyNote.id,
            status: "ready",
            anchorOrdinal: 41,
            sourceSessionId: "ses-note",
        });
        if (results[0]?.source === "note") {
            expect(results[0].content).toContain("Reason: Release shipped");
        }
    });

    it("finds dismissed and pending notes across all statuses", async () => {
        const dismissed = addNote(db, "session", {
            sessionId: "ses-note-status",
            content: "Decided to keep the fallback cache disabled because telemetry was noisy.",
            anchorOrdinal: 12,
        });
        expect(
            dismissNote(db, dismissed.id, {
                sessionId: "ses-note-status",
                projectPath: "git:test",
            }),
        ).toBe(true);

        const pending = addNote(db, "smart", {
            content: "Revisit telemetry after the deploy window closes.",
            projectPath: "git:test",
            sessionId: "ses-note-status",
            surfaceCondition: "When the deploy window closes",
            anchorOrdinal: 13,
        });

        const dismissedResults = await unifiedSearch(
            db,
            "ses-note-status",
            "git:test",
            "telemetry noisy fallback",
            {
                limit: 5,
                memoryEnabled: false,
                embeddingEnabled: false,
                sources: ["note"],
            },
        );
        const pendingResults = await unifiedSearch(
            db,
            "ses-note-status",
            "git:test",
            "deploy window closes",
            {
                limit: 5,
                memoryEnabled: false,
                embeddingEnabled: false,
                sources: ["note"],
            },
        );

        expect(dismissedResults[0]).toMatchObject({
            source: "note",
            noteId: dismissed.id,
            status: "dismissed",
        });
        expect(pendingResults[0]).toMatchObject({
            source: "note",
            noteId: pending.id,
            status: "pending",
        });
    });

    it("scopes note search to the current session and project notes", async () => {
        const ownSession = addNote(db, "session", {
            sessionId: "ses-scope",
            content: "scope marker own session",
        });
        addNote(db, "session", {
            sessionId: "ses-other",
            content: "scope marker other session",
        });
        const sameProjectSmart = addNote(db, "smart", {
            content: "scope marker same project smart",
            projectPath: "git:own",
            sessionId: "ses-foreign",
            surfaceCondition: "When project scope matters",
        });
        addNote(db, "smart", {
            content: "scope marker foreign project smart",
            projectPath: "git:other",
            sessionId: "ses-scope",
            surfaceCondition: "When project scope matters",
        });

        const results = await unifiedSearch(db, "ses-scope", "git:own", "scope marker", {
            limit: 10,
            memoryEnabled: false,
            embeddingEnabled: false,
            sources: ["note"],
        });

        const noteResults = results.filter(
            (result): result is Extract<(typeof results)[number], { source: "note" }> =>
                result.source === "note",
        );
        const noteIds = noteResults
            .map((result) => result.noteId)
            .sort((left, right) => left - right);
        expect(noteIds).toEqual([ownSession.id, sameProjectSmart.id].sort((a, b) => a - b));
        expect(noteResults.find((result) => result.noteId === ownSession.id)?.sourceSessionId).toBe(
            "ses-scope",
        );
        expect(
            noteResults.find((result) => result.noteId === sameProjectSmart.id)?.sourceSessionId,
        ).toBe("ses-foreign");
    });

    it("restricts note results to the note source and includes them in broad searches", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "broad recall marker from memory",
        });
        const note = addNote(db, "session", {
            sessionId: "ses-broad-note",
            content: "broad recall marker from note",
        });

        const noteOnly = await unifiedSearch(
            db,
            "ses-broad-note",
            "/repo/project",
            "broad recall marker",
            {
                limit: 10,
                memoryEnabled: true,
                embeddingEnabled: false,
                sources: ["note"],
            },
        );
        expect(noteOnly.every((result) => result.source === "note")).toBe(true);
        expect(noteOnly[0]).toMatchObject({ source: "note", noteId: note.id });

        const broad = await unifiedSearch(
            db,
            "ses-broad-note",
            "/repo/project",
            "broad recall marker",
            {
                limit: 10,
                memoryEnabled: true,
                embeddingEnabled: false,
            },
        );
        const broadSources = broad.map((result) => result.source);
        expect(broadSources).toContain("memory");
        expect(broadSources).toContain("note");
        expect(
            broad.some((result) => result.source === "memory" && result.memoryId === memory.id),
        ).toBe(true);
    });

    it("restricts results to the sources filter", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Historian uses a compact static system prompt.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        rawMessagesBySession.set("ses-sources", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "What prompt does the historian agent use?" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-sources", readMessages);

        // Memory-only filter — message hit must be excluded.
        const memoryOnly = await unifiedSearch(
            db,
            "ses-sources",
            "/repo/project",
            "historian prompt",
            {
                memoryEnabled: true,
                embeddingEnabled: true,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                sources: ["memory"],
            },
        );
        expect(memoryOnly.every((r) => r.source === "memory")).toBe(true);
        expect(memoryOnly.length).toBeGreaterThan(0);

        // Message-only filter — memory hit must be excluded.
        const messageOnly = await unifiedSearch(
            db,
            "ses-sources",
            "/repo/project",
            "historian prompt",
            {
                memoryEnabled: true,
                embeddingEnabled: true,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                sources: ["message"],
            },
        );
        expect(messageOnly.every((r) => r.source === "message")).toBe(true);
        expect(messageOnly.length).toBeGreaterThan(0);
    });

    it("hard-filters memories listed in visibleMemoryIds", async () => {
        const visible = insertMemory(db, {
            projectPath: "/repo/visible",
            category: "ARCHITECTURE_DECISIONS",
            content: "Keep historian subagent hidden via mode=subagent plus hidden=true.",
        });
        const hidden = insertMemory(db, {
            projectPath: "/repo/visible",
            category: "ARCHITECTURE_DECISIONS",
            content: "Historian child sessions inherit parent variant for cache stability.",
        });
        saveEmbedding(db, visible.id, new Float32Array([1, 0]), "mock:model");
        saveEmbedding(db, hidden.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        const results = await unifiedSearch(db, "ses-vis", "/repo/visible", "historian", {
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            visibleMemoryIds: new Set([visible.id]),
            sources: ["memory"],
        });

        // The already-visible memory must not be returned even though it
        // would otherwise rank identically with the other candidate.
        const ids = results
            .filter((r) => r.source === "memory")
            .map((r) => (r as { memoryId: number }).memoryId);
        expect(ids).not.toContain(visible.id);
        expect(ids).toContain(hidden.id);
    });

    it("uses linear decay for message scoring so secondary hits keep signal", async () => {
        rawMessagesBySession.set("ses-decay", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "regression regression regression one" }],
            },
            {
                ordinal: 2,
                id: "u2",
                role: "user",
                parts: [{ type: "text", text: "regression regression two" }],
            },
            {
                ordinal: 3,
                id: "u3",
                role: "user",
                parts: [{ type: "text", text: "regression three" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-decay", readMessages);

        const results = await unifiedSearch(db, "ses-decay", "/repo/decay", "regression", {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
        });

        const messages = results.filter(
            (r): r is Extract<(typeof results)[number], { source: "message" }> =>
                r.source === "message",
        );
        expect(messages.length).toBeGreaterThanOrEqual(3);
        // With 1/(rank+1), rank-2 would be 0.33. Linear decay over a
        // filtered length of 3 produces 1.0, 0.667, 0.333. Either way rank-1
        // (index 1) should still be comfortably above the old rank-2 value.
        expect(messages[0].score).toBeGreaterThan(0.9);
        expect(messages[1].score).toBeGreaterThan(0.5);
        // Rank-2 of 3 is the last hit — linear decay gives 1/3 ≈ 0.333 and
        // we don't want it to collapse to near-zero like the old formula's
        // rank-5 did.
        expect(messages[2].score).toBeGreaterThan(0.2);
    });

    it("explicitSearch recalls a literal-symbol message the AND-joined NL query misses", async () => {
        // The target message contains the symbol `/ctx-status` but NOT the
        // other words of the natural-language query. With FTS implicit-AND,
        // the full query can't match it. The literal probe must recover it.
        rawMessagesBySession.set("ses-probe", [
            {
                ordinal: 1,
                id: "m1",
                role: "assistant",
                parts: [{ type: "text", text: "Fixed the /ctx-status tool count breakdown." }],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "user",
                parts: [{ type: "text", text: "unrelated chatter about something else entirely" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-probe", readMessages);

        const nlQuery = "why did the inflated tool calls breakdown happen in ctx-status";

        // Without explicitSearch: the AND-joined query fails to surface m1
        // (it lacks "why/did/inflated/happen"). Tokenization splits ctx-status
        // → ctx + status, so the literal still doesn't rescue it under AND.
        const baseline = await unifiedSearch(db, "ses-probe", "/repo/probe", nlQuery, {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
        });
        expect(baseline.some((r) => r.source === "message" && r.messageId === "m1")).toBe(false);

        // With explicitSearch: the `ctx-status` probe runs as its own query and
        // recalls m1, and the verbatim boost ranks it first.
        const probed = await unifiedSearch(db, "ses-probe", "/repo/probe", nlQuery, {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            explicitSearch: true,
        });
        const probedMessages = probed.filter((r) => r.source === "message");
        expect(probedMessages.some((r) => r.messageId === "m1")).toBe(true);
        expect(probedMessages[0]?.messageId).toBe("m1");
    });

    it("counts probe corpus statistics only inside the message cutoff", async () => {
        rawMessagesBySession.set("ses-cutoff-probes", [
            {
                ordinal: 1,
                id: "common-1",
                role: "assistant",
                parts: [{ type: "text", text: "CommonTerm is the eligible early hit." }],
            },
            {
                ordinal: 2,
                id: "rare-2",
                role: "assistant",
                parts: [{ type: "text", text: "RareSymbolXyz is the eligible late hit." }],
            },
            ...Array.from({ length: 12 }, (_, i) => ({
                ordinal: i + 3,
                id: `tail-${i}`,
                role: "assistant" as const,
                parts: [
                    {
                        type: "text" as const,
                        text: `CommonTerm appears again in excluded live-tail row ${i}.`,
                    },
                ],
            })),
        ]);
        ensureMessagesIndexed(db, "ses-cutoff-probes", readMessages);

        const results = await unifiedSearch(
            db,
            "ses-cutoff-probes",
            "/repo/probe-cutoff",
            "RareSymbolXyz CommonTerm",
            {
                memoryEnabled: false,
                embeddingEnabled: false,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                sources: ["message"],
                explicitSearch: true,
                maxMessageOrdinal: 2,
            },
        );

        const messages = results.filter((r) => r.source === "message");
        expect(messages.map((r) => r.messageId)).toEqual(["common-1", "rare-2"]);
    });

    it("multi-probe scores decay linearly instead of flattening into a ~1.0 band", async () => {
        // Regression: the flat +0.5 verbatim bonus sat 30× above the RRF scale,
        // so after divide-by-max normalization every probe-matching message
        // scored ~1.0 and (×MESSAGE_SOURCE_BOOST) crowded memories out of the
        // unified results. Scores must now follow the linear rank band.
        const msgs = Array.from({ length: 8 }, (_, i) => ({
            ordinal: i + 1,
            id: `mm${i}`,
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: `note ${i}: the /ctx-status dialog rendering pass number ${i}`,
                },
            ],
        }));
        rawMessagesBySession.set("ses-band", msgs);
        ensureMessagesIndexed(db, "ses-band", readMessages);

        const results = await unifiedSearch(db, "ses-band", "/repo/band", "ctx-status dialog", {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            explicitSearch: true,
        });
        const messages = results.filter((r) => r.source === "message");
        expect(messages.length).toBeGreaterThanOrEqual(4);
        // Top hit caps the band; the rest must spread DOWN the linear band, not
        // cluster at ~1.0. With the old flat bonus all of these were ≥0.95.
        expect(messages[0].score).toBeGreaterThan(0.9);
        const second = messages[1].score;
        const last = messages[messages.length - 1].score;
        expect(second).toBeLessThan(0.95);
        expect(last).toBeLessThan(0.5);
    });

    it("a discriminative probe outranks a corpus-flooding probe", async () => {
        // "AFT"-class regression: a probe matching a large share of the corpus
        // carries near-zero signal and must not drown the rare probe's hit.
        const flood = Array.from({ length: 30 }, (_, i) => ({
            ordinal: i + 1,
            id: `f${i}`,
            role: "assistant",
            parts: [{ type: "text", text: `CommonTerm appears here in filler message ${i}` }],
        }));
        const rare = {
            ordinal: 31,
            id: "rare-hit",
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: "RareSymbolXyz was fixed alongside CommonTerm in the resolver",
                },
            ],
        };
        rawMessagesBySession.set("ses-idf", [...flood, rare]);
        ensureMessagesIndexed(db, "ses-idf", readMessages);

        const results = await unifiedSearch(
            db,
            "ses-idf",
            "/repo/idf",
            "where did we fix RareSymbolXyz near CommonTerm",
            {
                memoryEnabled: false,
                embeddingEnabled: false,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
                sources: ["message"],
                explicitSearch: true,
            },
        );
        const messages = results.filter((r) => r.source === "message");
        // The rare-probe message must win over the 30 flood messages that only
        // match the common probe.
        expect(messages[0]?.messageId).toBe("rare-hit");
    });

    it("returns empty message results until async indexing populates FTS", async () => {
        rawMessagesBySession.set("ses-2", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [
                    {
                        type: "text",
                        text: "<system-reminder>ignore</system-reminder> Search this ticket",
                    },
                ],
            },
            {
                ordinal: 2,
                id: "tool-1",
                role: "assistant",
                parts: [{ type: "tool-call", name: "ctx_note" }],
            },
            {
                ordinal: 3,
                id: "a1",
                role: "assistant",
                parts: [{ type: "text", text: "Ticket search is now indexed." }],
            },
        ]);

        let results = await unifiedSearch(db, "ses-2", "/repo/project", "ticket", {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        });

        expect(results.filter((result) => result.source === "message")).toHaveLength(0);

        ensureMessagesIndexed(db, "ses-2", readMessages);

        results = await unifiedSearch(db, "ses-2", "/repo/project", "ticket", {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        });

        expect(results.filter((result) => result.source === "message")).toHaveLength(2);

        rawMessagesBySession.set("ses-2", [
            ...(rawMessagesBySession.get("ses-2") ?? []),
            {
                ordinal: 4,
                id: "a2",
                role: "assistant",
                parts: [{ type: "text", text: "The indexed ticket search now supports history." }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-2", readMessages);

        results = await unifiedSearch(db, "ses-2", "/repo/project", "supports history", {
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        });

        const messageResults = results.filter(
            (result): result is Extract<(typeof results)[number], { source: "message" }> =>
                result.source === "message",
        );
        expect(messageResults).toHaveLength(1);
        expect(messageResults[0]?.messageOrdinal).toBe(4);
    });

    it("returns empty results for blank queries or missing sessions", async () => {
        expect(
            await unifiedSearch(db, "ses-empty", "/repo/project", "   ", {
                memoryEnabled: true,
                embeddingEnabled: true,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
            }),
        ).toEqual([]);

        expect(
            await unifiedSearch(db, "ses-empty", "/repo/project", "nothing", {
                memoryEnabled: false,
                embeddingEnabled: false,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
            }),
        ).toEqual([]);
    });

    it("falls back to full semantic search when FTS finds no matches", async () => {
        const snapshot = registerEmbeddingProject(db, "/repo/project");
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "alpha beta gamma",
        });
        saveEmbedding(db, memory.id, new Float32Array([0, 1]), snapshot.modelId);
        queryEmbedding = new Float32Array([0, 1]);

        const results = await unifiedSearch(
            db,
            "ses-semantic",
            "/repo/project",
            "vector-only query",
            {
                limit: 5,
                memoryEnabled: true,
                embeddingEnabled: true,
                readMessages,
                embedQuery,
                isEmbeddingRuntimeEnabled,
            },
        );

        const memoryResults = results.filter(
            (result): result is Extract<(typeof results)[number], { source: "memory" }> =>
                result.source === "memory",
        );

        expect(memoryResults).toHaveLength(1);
        expect(memoryResults[0]?.memoryId).toBe(memory.id);
        expect(memoryResults[0]?.matchType).toBe("semantic");
    });

    /**
     * Regression for the duplicate-embed bug observed in production LMStudio
     * logs: when both memory and git-commit search ran in parallel, EACH
     * branch independently called `embedQuery(trimmedQuery)`, producing two
     * identical HTTP requests for the same input text. On a single-GPU
     * embedding endpoint these serialized at the model and doubled latency.
     *
     * unifiedSearch must embed the query exactly once at the top, then pass
     * the same vector to both consumers.
     */
    it("embeds the query exactly once even when memory + git_commit both need it", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "shared embed test.",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");
        queryEmbedding = new Float32Array([1, 0]);

        await unifiedSearch(db, "ses-1", "/repo/project", "shared embed query", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            // Enable git-commits even though we have no commits indexed —
            // searchGitCommits used to call embedQuery anyway, which is the
            // exact behavior we're regressing against.
            gitCommitsEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        });

        // Even with two embed-needing branches active, the query is embedded
        // exactly once. Pre-fix this would have been 2.
        expect(embeddingQueries).toEqual(["shared embed query"]);
    });

    it("returns a semantic compartment hit for message-only conceptual search", async () => {
        rawMessagesBySession.set("ses-chunk", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "queue saturation problem" }],
            },
            {
                ordinal: 2,
                id: "a2",
                role: "assistant",
                parts: [{ type: "text", text: "bounded drains with backpressure" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-chunk", readMessages);
        const snapshot = registerEmbeddingProject(db, "/repo/chunk");
        const compartmentId = seedCompartmentChunkEmbedding(
            db,
            "ses-chunk",
            "/repo/chunk",
            new Float32Array([0, 1]),
            snapshot.chunkModelId,
        );
        queryEmbedding = new Float32Array([0, 1]);

        const results = await unifiedSearch(db, "ses-chunk", "/repo/chunk", "hydraulic flow", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 2,
        });

        expect(embeddingQueries).toEqual(["hydraulic flow"]);
        expect(results[0]).toMatchObject({
            source: "compartment",
            compartmentId,
            startOrdinal: 1,
            endOrdinal: 2,
            matchType: "semantic",
        });
    });

    it("deduplicates FTS hits inside semantic compartment ranges and keeps a snippet", async () => {
        rawMessagesBySession.set("ses-dedup", [
            {
                ordinal: 1,
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "queue saturation problem" }],
            },
            {
                ordinal: 2,
                id: "a2",
                role: "assistant",
                parts: [{ type: "text", text: "bounded drains with backpressure" }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-dedup", readMessages);
        const snapshot = registerEmbeddingProject(db, "/repo/chunk");
        seedCompartmentChunkEmbedding(
            db,
            "ses-dedup",
            "/repo/chunk",
            new Float32Array([0, 1]),
            snapshot.chunkModelId,
        );
        queryEmbedding = new Float32Array([0, 1]);

        const results = await unifiedSearch(db, "ses-dedup", "/repo/chunk", "bounded drains", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 2,
        });

        expect(results.some((result) => result.source === "message")).toBe(false);
        const compartment = results.find((result) => result.source === "compartment");
        expect(compartment).toMatchObject({ source: "compartment", matchType: "hybrid" });
        // The snippet is the marked FTS fragment, not the message body.
        expect(compartment && "snippet" in compartment ? compartment.snippet : "").toBe(
            "<<bounded>> <<drains>> with backpressure",
        );
    });

    it("respects message watermark cutoff and memory.enabled for compartment chunks", async () => {
        rawMessagesBySession.set("ses-cutoff", [
            { ordinal: 1, id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
            { ordinal: 2, id: "a2", role: "assistant", parts: [{ type: "text", text: "second" }] },
        ]);
        ensureMessagesIndexed(db, "ses-cutoff", readMessages);
        seedCompartmentChunkEmbedding(db, "ses-cutoff", "/repo/cutoff", new Float32Array([0, 1]));
        queryEmbedding = new Float32Array([0, 1]);

        const cutoffResults = await unifiedSearch(db, "ses-cutoff", "/repo/cutoff", "concept", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 1,
        });
        expect(cutoffResults.some((result) => result.source === "compartment")).toBe(false);

        embeddingQueries.length = 0;
        const memoryOffResults = await unifiedSearch(db, "ses-cutoff", "/repo/cutoff", "concept", {
            limit: 5,
            memoryEnabled: false,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
            sources: ["message"],
            maxMessageOrdinal: 2,
        });
        expect(memoryOffResults.some((result) => result.source === "compartment")).toBe(false);
        expect(embeddingQueries).toEqual([]);
    });
});

describe("unifiedSearch hard bounds (R34, R37)", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    function seedMessages(sessionId: string, count: number) {
        rawMessagesBySession.set(
            sessionId,
            Array.from({ length: count }, (_, index) => ({
                ordinal: index + 1,
                id: `m${index + 1}`,
                role: index % 2 === 0 ? "user" : "assistant",
                parts: [{ type: "text", text: `bounded topic message number ${index + 1}` }],
            })),
        );
        ensureMessagesIndexed(db, sessionId, readMessages);
    }

    it("throws QueryBoundsError before any database or provider work on an over-cap query", async () => {
        const counting = countingDatabase(db);
        const embedSpyCalls: string[] = [];
        const oversized = "a".repeat(16 * 1024 + 1);
        await expect(
            unifiedSearch(counting.db, "session-1", "git:test", oversized, {
                embedQuery: async (text) => {
                    embedSpyCalls.push(text);
                    return null;
                },
                isEmbeddingRuntimeEnabled: () => true,
            }),
        ).rejects.toBeInstanceOf(QueryBoundsError);
        expect(counting.executions).toHaveLength(0);
        expect(embedSpyCalls).toHaveLength(0);
    });

    it("rejects an over-cap atom count before database work", async () => {
        const counting = countingDatabase(db);
        const query = Array.from({ length: 65 }, (_, index) => `atom${index}`).join(" ");
        await expect(
            unifiedSearch(counting.db, "session-1", "git:test", query, {}),
        ).rejects.toBeInstanceOf(QueryBoundsError);
        expect(counting.executions).toHaveLength(0);
    });

    it("clamps limit 10_000 to at most 50 results with every SQL LIMIT binding at most 150", async () => {
        seedMessages("session-caps", 300);
        const counting = countingDatabase(db);
        const results = await unifiedSearch(
            counting.db,
            "session-caps",
            "git:test",
            'bounded topic message "bounded topic" number-1 number_2 someCamelCase probe.name',
            {
                limit: 10_000,
                memoryEnabled: true,
                embeddingEnabled: false,
                gitCommitsEnabled: true,
                sources: ["memory", "message", "git_commit", "primer", "note"],
                maxMessageOrdinal: 280,
                explicitSearch: true,
                measurementDisabled: true,
            },
        );
        expect(results.length).toBeLessThanOrEqual(50);
        const limitBindings = counting.executions
            .filter((execution) => /\bLIMIT \?/i.test(execution.sql))
            .map((execution) => execution.bindings[execution.bindings.length - 1]);
        expect(limitBindings.length).toBeGreaterThan(0);
        for (const binding of limitBindings) {
            expect(typeof binding).toBe("number");
            expect(binding as number).toBeLessThanOrEqual(150);
        }
        // Row counts catch a lane whose mutant drops the LIMIT clause and so
        // escapes the binding filter above.
        const messageFetches = counting.executions.filter((execution) =>
            execution.sql.includes("message_history_fts"),
        );
        expect(messageFetches.length).toBeGreaterThan(0);
        for (const execution of messageFetches) {
            expect(execution.rowCount).toBeLessThanOrEqual(900);
        }
    });

    it("keeps the default overfetch shape for the default limit", async () => {
        seedMessages("session-default", 20);
        const counting = countingDatabase(db);
        await unifiedSearch(counting.db, "session-default", "git:test", "bounded topic", {
            memoryEnabled: true,
            embeddingEnabled: false,
            sources: ["message"],
            maxMessageOrdinal: 15,
            measurementDisabled: true,
        });
        const messageFetch = counting.executions.find((execution) =>
            execution.sql.includes("message_history_fts"),
        );
        expect(messageFetch).toBeDefined();
        expect(messageFetch?.bindings[messageFetch.bindings.length - 1]).toBe(90);
    });

    it("caps each probe branch aggregate at 900 rows across base plus five probes", async () => {
        seedMessages("session-probes", 30);
        const counting = countingDatabase(db);
        await unifiedSearch(
            counting.db,
            "session-probes",
            "git:test",
            'bounded "topic one" probe-two probe_three probe.four probeFive probe-six',
            {
                limit: 50,
                memoryEnabled: false,
                embeddingEnabled: false,
                sources: ["message"],
                maxMessageOrdinal: 25,
                explicitSearch: true,
                measurementDisabled: true,
            },
        );
        const batched = counting.executions.filter(
            (execution) =>
                execution.sql.includes("message_history_fts") &&
                execution.sql.includes("UNION ALL") &&
                /\bLIMIT \?/i.test(execution.sql),
        );
        expect(batched.length).toBeGreaterThan(0);
        for (const execution of batched) {
            // Binding values of 100+ are branch LIMITs; the only other numeric
            // binding is the ordinal cutoff of 25.
            const limits = execution.bindings.filter(
                (binding): binding is number => typeof binding === "number" && binding >= 100,
            );
            // The query uses one base term and five probes, so six branches
            // capped at 150 return at most 900 rows.
            expect(limits).toEqual([150, 150, 150, 150, 150, 150]);
            expect(execution.rowCount).toBeLessThanOrEqual(900);
        }
    });
});

describe("parseIdShapedQuery", () => {
    it("recognizes a bare numeric id", () => {
        expect(parseIdShapedQuery("7234")).toEqual([7234]);
    });
    it("recognizes a `#id` token", () => {
        expect(parseIdShapedQuery("#7234")).toEqual([7234]);
    });
    it("recognizes a comma-separated id list (≤5 tokens)", () => {
        expect(parseIdShapedQuery("12, 34, 56")).toEqual([12, 34, 56]);
    });
    it("recognizes a space-separated id list (≤5 tokens)", () => {
        expect(parseIdShapedQuery("#12 34 56")).toEqual([12, 34, 56]);
    });
    it("rejects phrases that contain a number but are not id-shaped", () => {
        expect(parseIdShapedQuery("fix bug 1234")).toBeNull();
        expect(parseIdShapedQuery("error at line 42 in foo.ts")).toBeNull();
    });
    it("rejects id lists over the 5-token cap", () => {
        expect(parseIdShapedQuery("1 2 3 4 5 6")).toBeNull();
    });
    it("rejects empty / whitespace-only queries", () => {
        expect(parseIdShapedQuery("")).toBeNull();
        expect(parseIdShapedQuery("   ")).toBeNull();
    });
    it("rejects tokens that are not pure digits (e.g. negative or hex)", () => {
        expect(parseIdShapedQuery("-1")).toBeNull();
        expect(parseIdShapedQuery("0x10")).toBeNull();
        expect(parseIdShapedQuery("id 7234")).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// U1 — frozen ranking projection (KTD1).
//
// The hot-path fixes in this task must not move a single rank. These fixtures
// record source, stable result identity, score, match type, and order for both
// the automatic single-query path and the explicit multi-probe path over one
// fixed mixed-source corpus. Content is asserted separately because R34
// deliberately replaces full message bodies with bounded FTS fragments.
// ---------------------------------------------------------------------------

const FIXTURE_PROJECT = "git:projection-fixture";
const FIXTURE_SESSION = "ses-projection-fixture";
const FIXTURE_MODEL = "mock:model";
/** Fixed clock so note createdAt ties (and their id tie-break) are deterministic. */
const FIXTURE_NOTE_CREATED_AT = Date.UTC(2026, 1, 1);

interface ProjectionRow {
    source: string;
    id: string;
    score: number;
    matchType?: string;
}

function projectionOf(results: readonly UnifiedSearchResult[]): ProjectionRow[] {
    return results.map((result) => {
        const row: ProjectionRow = {
            source: result.source,
            id: stableResultId(result),
            score: result.score,
        };
        if ("matchType" in result && result.matchType) row.matchType = result.matchType;
        return row;
    });
}

function stableResultId(result: UnifiedSearchResult): string {
    switch (result.source) {
        case "memory":
            return `memory:${result.memoryId}`;
        case "message":
            return `message:${result.messageId}`;
        case "compartment":
            return `compartment:${result.compartmentId}`;
        case "git_commit":
            return `git_commit:${result.sha}`;
        case "primer":
            return `primer:${result.primerId}`;
        case "note":
            return `note:${result.noteId}`;
    }
}

function seedProjectionCorpus(db: Database): {
    memoryId: number;
    primerId: number;
    noteIds: number[];
    sha: string;
} {
    const memory = insertMemory(db, {
        projectPath: FIXTURE_PROJECT,
        category: "ARCHITECTURE_DECISIONS",
        content:
            "The queue drain path applies backpressure through applyBackpressure() before the retry budget resets.",
    });
    saveEmbedding(db, memory.id, new Float32Array([1, 0]), FIXTURE_MODEL);

    const primerId = createPrimer(db, {
        projectPath: FIXTURE_PROJECT,
        question: "How does the queue drain handle backpressure?",
        answer: "It applies backpressure through applyBackpressure() before the retry budget resets.",
        totalSupport: 3,
        lastObservedAt: Date.UTC(2026, 0, 8),
        sourceCandidateIds: [1, 2],
    });

    rawMessagesBySession.set(FIXTURE_SESSION, [
        {
            ordinal: 1,
            id: "fx-m1",
            role: "user",
            parts: [
                {
                    type: "text",
                    text: `${"filler prose about unrelated scheduling work. ".repeat(40)}Please make the queue drain apply backpressure before the retry budget resets, through applyBackpressure().`,
                },
            ],
        },
        {
            ordinal: 2,
            id: "fx-m2",
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: "Done: the queue drain now applies backpressure on every batch through applyBackpressure().",
                },
            ],
        },
        {
            ordinal: 3,
            id: "fx-m3",
            role: "user",
            parts: [{ type: "text", text: "Also document the queue drain retry budget." }],
        },
    ]);
    ensureMessagesIndexed(db, FIXTURE_SESSION, readMessages);

    const commits = [
        {
            sha: "a".repeat(40),
            shortSha: "aaaaaaa",
            message:
                "fix(queue): drain applies backpressure through applyBackpressure() before retry budget reset",
            author: "dev@example.com",
            committedAtMs: 1_700_000_000_000,
        },
        {
            sha: "b".repeat(40),
            shortSha: "bbbbbbb",
            message: "docs(queue): describe drain ordering",
            author: "dev@example.com",
            committedAtMs: 1_700_000_100_000,
        },
    ];
    upsertCommits(db, FIXTURE_PROJECT, commits);

    const firstNote = addNote(db, "session", {
        sessionId: FIXTURE_SESSION,
        content: "Queue drain backpressure needs a regression test.",
        anchorOrdinal: 2,
    });
    const secondNote = addNote(db, "session", {
        sessionId: FIXTURE_SESSION,
        content: "Queue drain backpressure ordering matters for the retry budget.",
        anchorOrdinal: 3,
    });
    // Force a createdAt tie so the note id tie-break is actually exercised.
    db.prepare("UPDATE notes SET created_at = ?, updated_at = ? WHERE id IN (?, ?)").run(
        FIXTURE_NOTE_CREATED_AT,
        FIXTURE_NOTE_CREATED_AT,
        firstNote.id,
        secondNote.id,
    );

    return {
        memoryId: memory.id,
        primerId,
        noteIds: [firstNote.id, secondNote.id],
        sha: commits[0].sha,
    };
}

describe("search ranking projection (KTD1 characterization)", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    const searchOptions = (explicit: boolean) => ({
        limit: 10,
        memoryEnabled: true,
        embeddingEnabled: false,
        gitCommitsEnabled: true,
        explicitSearch: explicit,
        countRetrievals: false,
        measurementDisabled: true,
        readMessages,
        embedQuery,
        isEmbeddingRuntimeEnabled,
    });

    it("freezes the automatic single-query projection across sources", async () => {
        const seeded = seedProjectionCorpus(db);

        const results = await unifiedSearch(
            db,
            FIXTURE_SESSION,
            FIXTURE_PROJECT,
            "queue drain backpressure",
            searchOptions(false),
        );

        expect(projectionOf(results)).toEqual([
            { source: "primer", id: `primer:${seeded.primerId}`, score: 1, matchType: "fts" },
            { source: "message", id: "message:fx-m2", score: 1 },
            { source: "memory", id: `memory:${seeded.memoryId}`, score: 0.8, matchType: "fts" },
            { source: "note", id: `note:${seeded.noteIds[0]}`, score: 1 },
            { source: "git_commit", id: `git_commit:${seeded.sha}`, score: 0.8, matchType: "fts" },
            { source: "message", id: "message:fx-m1", score: 0.5 },
            { source: "note", id: `note:${seeded.noteIds[1]}`, score: 0.5 },
        ]);
    });

    it("freezes the explicit multi-probe projection across sources", async () => {
        const seeded = seedProjectionCorpus(db);

        const results = await unifiedSearch(
            db,
            FIXTURE_SESSION,
            FIXTURE_PROJECT,
            "queue drain applyBackpressure()",
            searchOptions(true),
        );

        expect(projectionOf(results)).toEqual([
            { source: "primer", id: `primer:${seeded.primerId}`, score: 1, matchType: "fts" },
            { source: "message", id: "message:fx-m2", score: 1 },
            { source: "memory", id: `memory:${seeded.memoryId}`, score: 0.8, matchType: "fts" },
            { source: "note", id: `note:${seeded.noteIds[0]}`, score: 1 },
            { source: "git_commit", id: `git_commit:${seeded.sha}`, score: 0.8, matchType: "fts" },
            { source: "message", id: "message:fx-m1", score: 0.5 },
            { source: "note", id: `note:${seeded.noteIds[1]}`, score: 0.5 },
        ]);
    });

    it("is deterministic across repeated runs", async () => {
        seedProjectionCorpus(db);
        const first = await unifiedSearch(
            db,
            FIXTURE_SESSION,
            FIXTURE_PROJECT,
            "queue drain backpressure",
            searchOptions(false),
        );
        const second = await unifiedSearch(
            db,
            FIXTURE_SESSION,
            FIXTURE_PROJECT,
            "queue drain backpressure",
            searchOptions(false),
        );
        expect(projectionOf(second)).toEqual(projectionOf(first));
    });

    it("counts only the selected SQL without changing statement behavior", async () => {
        seedProjectionCorpus(db);
        const counter = countingDatabase(db);

        const counted = await unifiedSearch(
            counter.db,
            FIXTURE_SESSION,
            FIXTURE_PROJECT,
            "queue drain backpressure",
            searchOptions(false),
        );
        const direct = await unifiedSearch(
            db,
            FIXTURE_SESSION,
            FIXTURE_PROJECT,
            "queue drain backpressure",
            searchOptions(false),
        );

        expect(projectionOf(counted)).toEqual(projectionOf(direct));
        expect(counter.count("message_history_fts")).toBeGreaterThan(0);
        expect(counter.rows("message_history_fts")).toBeGreaterThan(0);
        expect(counter.count("no_such_table_anywhere")).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// U2 — bounded message fragments (R34) and the compartment interval sweep (R37).
// ---------------------------------------------------------------------------

const FRAGMENT_TOKEN_LIMIT = 32;

function fragmentTokenCount(text: string): number {
    return text
        .replace(/<<|>>/g, "")
        .split(/\s+/)
        .filter((token) => token.length > 0 && token !== "...").length;
}

describe("message search fragments (R34)", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    const longBody = (tail: string) =>
        `${"unrelated scheduling prose about caches and queues. ".repeat(60)}${tail}`;

    it("returns a marked bounded fragment for a match at the end of a long body", async () => {
        rawMessagesBySession.set("ses-frag", [
            {
                ordinal: 1,
                id: "frag-1",
                role: "user",
                parts: [
                    {
                        type: "text",
                        text: longBody("finally: the sentinel token appears right here."),
                    },
                ],
            },
        ]);
        ensureMessagesIndexed(db, "ses-frag", readMessages);

        const results = await unifiedSearch(db, "ses-frag", "git:frag", "sentinel", {
            limit: 5,
            memoryEnabled: false,
            embeddingEnabled: false,
            sources: ["message"],
        });

        expect(results).toHaveLength(1);
        const [hit] = results;
        expect(hit.content).toContain("<<sentinel>>");
        expect(hit.content).not.toContain("unrelated scheduling prose about caches and queues. un");
        expect(fragmentTokenCount(hit.content)).toBeLessThanOrEqual(FRAGMENT_TOKEN_LIMIT);
        expect(hit.content.length).toBeLessThan(400);
    });

    it("keeps the verbatim bonus for a probe that falls outside the fragment", async () => {
        // "earlyMarker" sits at the start of a long body and "sentinelToken" at
        // its end, farther apart than one fragment can span.
        const body = `earlyMarker begins the story. ${"filler words about queues and caches. ".repeat(60)} closing with sentinelToken here.`;
        rawMessagesBySession.set("ses-verbatim", [
            {
                ordinal: 1,
                id: "verbatim-1",
                role: "user",
                parts: [{ type: "text", text: body }],
            },
            {
                ordinal: 2,
                id: "verbatim-2",
                role: "assistant",
                parts: [{ type: "text", text: "sentinelToken acknowledged, earlyMarker noted." }],
            },
            {
                ordinal: 3,
                id: "verbatim-3",
                role: "user",
                parts: [
                    {
                        type: "text",
                        text: `earlyMarker only here. ${"padding text. ".repeat(40)} sentinelTokens plural stem only.`,
                    },
                ],
            },
        ]);
        ensureMessagesIndexed(db, "ses-verbatim", readMessages);

        const results = await unifiedSearch(
            db,
            "ses-verbatim",
            "git:verbatim",
            "earlyMarker and sentinelToken",
            {
                limit: 10,
                memoryEnabled: false,
                embeddingEnabled: false,
                explicitSearch: true,
                sources: ["message"],
            },
        );

        expect(projectionOf(results)).toEqual([
            { source: "message", id: "message:verbatim-1", score: 1 },
            { source: "message", id: "message:verbatim-2", score: 0.6666666666666667 },
            { source: "message", id: "message:verbatim-3", score: 0.33333333333333337 },
        ]);
        // The winner's fragment cannot span both probes, yet its full-body
        // containment of both still decides the top rank.
        const winner = results[0];
        expect(winner.content).toContain("<<sentinelToken>>");
        expect(winner.content).not.toContain("earlyMarker");
        expect(fragmentTokenCount(winner.content)).toBeLessThanOrEqual(FRAGMENT_TOKEN_LIMIT);
    });

    it("uses a bounded prefix for a role-only match and never the full body", async () => {
        rawMessagesBySession.set("ses-roleonly", [
            {
                ordinal: 1,
                id: "role-1",
                role: "assistant",
                parts: [{ type: "text", text: longBody("tail sentence with no query token.") }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-roleonly", readMessages);

        const results = await unifiedSearch(db, "ses-roleonly", "git:role", "assistant", {
            limit: 5,
            memoryEnabled: false,
            embeddingEnabled: false,
            sources: ["message"],
        });

        expect(results).toHaveLength(1);
        expect(results[0].content).not.toContain("<<");
        expect(fragmentTokenCount(results[0].content)).toBeLessThanOrEqual(FRAGMENT_TOKEN_LIMIT);
    });

    it("never projects full message content, on the single or batched path", async () => {
        rawMessagesBySession.set("ses-spy", [
            {
                ordinal: 1,
                id: "spy-1",
                role: "user",
                parts: [{ type: "text", text: longBody("spyToken lives at the end.") }],
            },
        ]);
        ensureMessagesIndexed(db, "ses-spy", readMessages);

        for (const explicitSearch of [false, true]) {
            const counter = countingDatabase(db);
            await unifiedSearch(counter.db, "ses-spy", "git:spy", "spyToken", {
                limit: 5,
                memoryEnabled: false,
                embeddingEnabled: false,
                explicitSearch,
                sources: ["message"],
            });
            const selects = counter.matching(/FROM message_history_fts/);
            expect(selects.length).toBeGreaterThan(0);
            for (const execution of selects) {
                if (!execution.sql.includes("snippet(")) continue;
                expect(execution.sql).toContain(
                    "snippet(message_history_fts, 4, '<<', '>>', ' ... ', 32)",
                );
                // No bare `content` projection survives on either path.
                expect(/,\s*content\b/.test(execution.sql)).toBe(false);
            }
        }
    });

    it("applies the ordinal cutoff before LIMIT so history is not displaced", async () => {
        const messages = Array.from({ length: 12 }, (_, index) => ({
            ordinal: index + 1,
            id: `cut-${index + 1}`,
            role: "user",
            parts: [{ type: "text", text: `cutoffToken occurrence number ${index + 1}` }],
        }));
        rawMessagesBySession.set("ses-cut", messages);
        ensureMessagesIndexed(db, "ses-cut", readMessages);

        const results = await unifiedSearch(db, "ses-cut", "git:cut", "cutoffToken", {
            limit: 2,
            memoryEnabled: false,
            embeddingEnabled: false,
            sources: ["message"],
            maxMessageOrdinal: 3,
        });

        const ordinals = results.map((result) =>
            result.source === "message" ? result.messageOrdinal : -1,
        );
        expect(ordinals.length).toBeGreaterThan(0);
        expect(Math.max(...ordinals)).toBeLessThanOrEqual(3);
    });
});

describe("compartment interval sweep (R37)", () => {
    const message = (ordinal: number, score: number): MessageSearchResult => ({
        source: "message",
        content: `fragment ${ordinal}`,
        score,
        messageOrdinal: ordinal,
        messageId: `m${ordinal}`,
        role: "user",
    });

    const compartment = (
        id: number,
        startOrdinal: number,
        endOrdinal: number,
        score: number,
    ): CompartmentSearchResult => ({
        source: "compartment",
        content: `compartment ${id}`,
        score,
        compartmentId: id,
        sessionId: "ses-sweep",
        title: `compartment ${id}`,
        startOrdinal,
        endOrdinal,
        matchType: "semantic",
    });

    /** The former per-message scan, kept as a differential reference. */
    function referenceAssignment(
        messages: readonly MessageSearchResult[],
        compartments: readonly CompartmentSearchResult[],
    ): Map<number, CompartmentSearchResult> {
        const assignment = new Map<number, CompartmentSearchResult>();
        messages.forEach((entry, index) => {
            const containing = compartments.find(
                (candidate) =>
                    entry.messageOrdinal >= candidate.startOrdinal &&
                    entry.messageOrdinal <= candidate.endOrdinal,
            );
            if (containing) assignment.set(index, containing);
        });
        return assignment;
    }

    function referenceMerge(args: {
        messages: MessageSearchResult[];
        compartments: CompartmentSearchResult[];
        limit: number;
    }): Array<MessageSearchResult | CompartmentSearchResult> {
        const reference = referenceAssignment(args.messages, args.compartments);
        const fused = new Map<
            string,
            {
                result: MessageSearchResult | CompartmentSearchResult;
                score: number;
                tieOrdinal: number;
                snippetScore: number;
            }
        >();
        const add = (
            key: string,
            result: MessageSearchResult | CompartmentSearchResult,
            score: number,
            tieOrdinal: number,
        ) => {
            const existing = fused.get(key);
            if (existing) {
                existing.score += score;
                return existing;
            }
            const entry = { result, score, tieOrdinal, snippetScore: -1 };
            fused.set(key, entry);
            return entry;
        };
        args.compartments.forEach((entry, rank) => {
            add(`compartment:${entry.compartmentId}`, entry, 1 / (60 + rank), entry.startOrdinal);
        });
        args.messages.forEach((entry, rank) => {
            const containing = reference.get(rank);
            const contribution = 1 / (60 + rank);
            if (!containing) {
                add(`message:${entry.messageId}`, entry, contribution, entry.messageOrdinal);
                return;
            }
            const fusedEntry = add(
                `compartment:${containing.compartmentId}`,
                containing,
                contribution,
                containing.startOrdinal,
            );
            if (
                entry.score > fusedEntry.snippetScore &&
                fusedEntry.result.source === "compartment"
            ) {
                fusedEntry.snippetScore = entry.score;
                fusedEntry.result = {
                    ...fusedEntry.result,
                    matchType: "hybrid",
                    snippet: entry.content,
                };
            }
        });
        const ranked = [...fused.values()]
            .sort((left, right) =>
                right.score !== left.score
                    ? right.score - left.score
                    : left.tieOrdinal - right.tieOrdinal,
            )
            .slice(0, args.limit);
        return ranked.map((entry, rank) => ({
            ...entry.result,
            score: rank >= args.limit ? 0 : Math.max(0, 1 - rank / ranked.length),
        }));
    }

    it("matches the former scan for boundaries, gaps, and outside ordinals", () => {
        const compartments = [compartment(1, 5, 10, 0.9), compartment(2, 12, 15, 0.8)];
        const messages = [
            message(5, 1), // range start
            message(10, 0.9), // range end
            message(11, 0.8), // gap
            message(12, 0.7), // next range start
            message(99, 0.6), // outside every range
        ];
        expect(assignMessagesToCompartments(messages, compartments)).toEqual(
            referenceAssignment(messages, compartments),
        );
    });

    it("prefers the earliest semantic-ranked compartment for overlaps and shared endpoints", () => {
        // Compartment 2 is ranked first (higher score) but starts later; the
        // shared endpoint 10 belongs to whichever range ranks first.
        const compartments = [
            compartment(2, 10, 20, 0.95),
            compartment(1, 1, 10, 0.9),
            compartment(3, 8, 12, 0.7),
        ];
        const messages = [message(10, 1), message(9, 0.9), message(12, 0.8), message(1, 0.7)];
        expect(assignMessagesToCompartments(messages, compartments)).toEqual(
            referenceAssignment(messages, compartments),
        );
    });

    it("is unaffected by message input order differing from ordinal order", () => {
        const compartments = [compartment(1, 1, 5, 0.9), compartment(2, 3, 9, 0.8)];
        const shuffled = [message(9, 0.5), message(3, 1), message(1, 0.7), message(6, 0.6)];
        expect(assignMessagesToCompartments(shuffled, compartments)).toEqual(
            referenceAssignment(shuffled, compartments),
        );
    });

    it("keeps fusion scores, tie ordinals, and snippet winners identical to the former merge", () => {
        const compartments = [compartment(1, 1, 10, 0.9), compartment(2, 5, 20, 0.8)];
        const messages = [
            message(7, 1),
            message(2, 0.9),
            message(15, 0.8),
            message(30, 0.7),
            message(5, 0.7),
        ];
        expect(mergeMessageAndCompartmentResults({ messages, compartments, limit: 10 })).toEqual(
            referenceMerge({ messages, compartments, limit: 10 }),
        );
    });

    it("does not scan every compartment range per message", () => {
        const compartments = Array.from({ length: 25 }, (_, index) =>
            compartment(index + 1, index * 10 + 1, index * 10 + 10, 1 - index / 100),
        );
        const messages = Array.from({ length: 40 }, (_, index) =>
            message(index * 6 + 1, 1 - index / 100),
        );

        let ordinalReads = 0;
        const watched = compartments.map(
            (entry) =>
                new Proxy(entry, {
                    get(target, prop, receiver) {
                        if (prop === "startOrdinal" || prop === "endOrdinal") ordinalReads += 1;
                        return Reflect.get(target, prop, receiver);
                    },
                }) as CompartmentSearchResult,
        );

        const swept = assignMessagesToCompartments(messages, watched);
        expect(swept.size).toBeGreaterThan(0);
        // A per-message scan costs at least one boundary read per (message, range)
        // pair; the sweep stays far below that product.
        expect(ordinalReads).toBeLessThan(messages.length * compartments.length);
    });
});

// ---------------------------------------------------------------------------
// U3 — exact memory-ID resolution through an indexed visibility query (R35).
// ---------------------------------------------------------------------------

describe("resolveMemoriesByIdsForSearch (R35)", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    function seedWorkspace() {
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', '["CONSTRAINTS"]', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const allowedForeign = insertMemory(db, {
            projectPath: "git:foreign",
            category: "CONSTRAINTS",
            content: "allowed foreign row",
        });
        const ownArchived = insertMemory(db, {
            projectPath: "git:own",
            category: "CONSTRAINTS",
            content: "own archived row",
        });
        db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(allowedForeign.id);
        db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(ownArchived.id);
        return { allowedForeign: allowedForeign.id, ownArchived: ownArchived.id };
    }

    it("returns the three visible occurrences in caller order (AE3)", () => {
        const seeded = seedWorkspace();

        const resolved = resolveMemoriesByIdsForSearch({
            db,
            projectPath: "git:own",
            ids: [seeded.allowedForeign, 999999, seeded.ownArchived, seeded.allowedForeign],
            limit: 10,
        });

        expect(resolved?.map((result) => result.memoryId)).toEqual([
            seeded.allowedForeign,
            seeded.ownArchived,
            seeded.allowedForeign,
        ]);
        expect(resolved?.map((result) => result.sourceName)).toEqual([
            "Foreign",
            undefined,
            "Foreign",
        ]);
    });

    it("returns the null fallback sentinel when every id is missing or hidden", () => {
        const seeded = seedWorkspace();
        db.prepare("UPDATE memories SET shareable = 0 WHERE id = ?").run(seeded.allowedForeign);

        expect(
            resolveMemoriesByIdsForSearch({
                db,
                projectPath: "git:own",
                ids: [999999, seeded.allowedForeign],
                limit: 10,
            }),
        ).toBeNull();
        expect(
            resolveMemoriesByIdsForSearch({ db, projectPath: "git:own", ids: [], limit: 10 }),
        ).toBeNull();
    });

    it("applies visibleMemoryIds before the limit without widening scope", () => {
        const seeded = seedWorkspace();

        const resolved = resolveMemoriesByIdsForSearch({
            db,
            projectPath: "git:own",
            ids: [seeded.allowedForeign, seeded.ownArchived],
            limit: 1,
            visibleMemoryIds: new Set([seeded.allowedForeign]),
        });

        expect(resolved?.map((result) => result.memoryId)).toEqual([seeded.ownArchived]);
    });

    it("no longer executes the broad project or workspace memory query", () => {
        const seeded = seedWorkspace();
        const counter = countingDatabase(db);

        resolveMemoriesByIdsForSearch({
            db: counter.db,
            projectPath: "git:own",
            ids: [seeded.allowedForeign, seeded.ownArchived],
            limit: 10,
        });

        const memoryReads = counter.matching(/(FROM|JOIN) memories\b/);
        expect(memoryReads.length).toBe(1);
        expect(memoryReads[0].sql).toContain("json_each");
        expect(memoryReads[0].sql).toContain(
            "CROSS JOIN memories ON memories.id = requested.value",
        );
        expect(counter.matching(/FROM memories\s+WHERE project_path/).length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// U4 — note candidate pruning through the FTS projection (R36).
// ---------------------------------------------------------------------------

const NOTE_SESSION = "ses-note-fts";
const NOTE_PROJECT = "git:note-fts";

/** Deterministic timestamps keep the createdAt tie-break stable across runs. */
function pinNoteTimestamps(db: Database): void {
    db.exec(
        "UPDATE notes SET created_at = 1700000000000 + id * 1000, updated_at = 1700000000000 + id * 1000",
    );
}

function seedNoteCorpus(db: Database) {
    const matching = addNote(db, "session", {
        sessionId: NOTE_SESSION,
        content: "Queue drain backpressure ordering matters for the retry budget.",
    });
    const ready = addNote(db, "smart", {
        content: "Retry the queue benchmark after the release.",
        projectPath: NOTE_PROJECT,
        sessionId: NOTE_SESSION,
        surfaceCondition: "When the release ships",
    });
    updateNote(
        db,
        ready.id,
        { status: "ready", readyReason: "Release shipped with the drain fix." },
        { sessionId: NOTE_SESSION, projectPath: NOTE_PROJECT },
    );
    const unrelated = Array.from({ length: 12 }, (_, index) =>
        addNote(db, "session", {
            sessionId: NOTE_SESSION,
            content: `Unrelated telemetry dashboard note number ${index}.`,
        }),
    );
    const foreignSession = addNote(db, "session", {
        sessionId: "other-session",
        content: "Foreign session note about queue drain backpressure.",
    });
    const foreignProject = addNote(db, "smart", {
        content: "Foreign project note about queue drain backpressure.",
        projectPath: "git:other",
        sessionId: "other-session",
        surfaceCondition: "cond",
    });
    pinNoteTimestamps(db);
    return { matching, ready, unrelated, foreignSession, foreignProject };
}

const noteSearchOptions = (explicit = false) => ({
    limit: 10,
    memoryEnabled: false,
    embeddingEnabled: false,
    sources: ["note" as const],
    explicitSearch: explicit,
    countRetrievals: false,
    measurementDisabled: true,
});

describe("note candidate pruning (R36)", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("surfaces matching notes without hydrating non-matching scoped notes", async () => {
        const seeded = seedNoteCorpus(db);
        const counter = countingDatabase(db);

        const results = await unifiedSearch(
            counter.db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "backpressure",
            noteSearchOptions(),
        );

        expect(results.map((result) => (result.source === "note" ? result.noteId : -1))).toEqual([
            seeded.matching.id,
        ]);
        // Candidate selection runs against the projection, and hydration asks for
        // only the candidate rowids.
        expect(counter.count("notes_fts")).toBeGreaterThan(0);
        const hydrations = counter.matching(/CROSS JOIN notes ON notes\.id = requested\.value/);
        expect(hydrations).toHaveLength(1);
        expect(hydrations[0].rowCount).toBe(1);
        // The former per-query scoped scan is gone.
        expect(counter.matching(/SELECT \* FROM notes WHERE/).length).toBe(0);
    });

    it("keeps foreign session and project notes out of scope", async () => {
        seedNoteCorpus(db);

        const results = await unifiedSearch(
            db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "queue drain backpressure",
            noteSearchOptions(),
        );

        const contents = results.map((result) => result.content);
        expect(contents.some((content) => content.includes("Foreign session"))).toBe(false);
        expect(contents.some((content) => content.includes("Foreign project"))).toBe(false);
    });

    it("finds old notes through queries carrying an unrepresentable short token", async () => {
        // "to" is below the trigram minimum. The query must still select on
        // its representable atoms instead of degrading to the recency window,
        // or any note older than the newest MAX_LANE_CANDIDATES is unfindable.
        const matching = addNote(db, "session", {
            sessionId: NOTE_SESSION,
            content: "Deploy sentinel rollout checklist for the gateway.",
        });
        for (let index = 0; index < 160; index += 1) {
            addNote(db, "session", {
                sessionId: NOTE_SESSION,
                content: `Unrelated filler telemetry entry number ${index}.`,
            });
        }
        pinNoteTimestamps(db);

        const results = await unifiedSearch(
            db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "how to deploy sentinel",
            noteSearchOptions(),
        );

        expect(
            results.some((result) => result.source === "note" && result.noteId === matching.id),
        ).toBe(true);
    });

    it("uses an indexed count for the probe-discrimination denominator", async () => {
        seedNoteCorpus(db);
        const counter = countingDatabase(db);

        await unifiedSearch(
            counter.db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "queue drain applyBackpressure()",
            noteSearchOptions(true),
        );

        const counts = counter.matching(/COUNT\(\*\) FROM notes/);
        expect(counts.length).toBeGreaterThan(0);
        expect(counts[0].sql).toContain("type = 'session'");
        expect(counts[0].sql).toContain("type = 'smart'");
    });

    it("uses an indexed corpus-wide count for the probe-discrimination numerator", async () => {
        seedNoteCorpus(db);
        const counter = countingDatabase(db);

        await unifiedSearch(
            counter.db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "queue drain applyBackpressure()",
            noteSearchOptions(true),
        );

        // Probe document frequencies count over the whole eligible corpus via
        // the projection — not the capped candidate pool.
        const probeCounts = counter.matching(/queryIndex/);
        expect(probeCounts.length).toBeGreaterThan(0);
        expect(probeCounts[0].sql).toContain("COUNT(*)");
        expect(probeCounts[0].sql).toContain("notes_fts MATCH");
    });

    it("counts probe document frequency beyond the candidate-pool cap", () => {
        const total = 180;
        for (let index = 0; index < total; index += 1) {
            addNote(db, "session", {
                sessionId: NOTE_SESSION,
                content: `Common telemetry counter note number ${index}.`,
            });
        }
        const scope = { sessionId: NOTE_SESSION, projectPath: NOTE_PROJECT };

        const pool = selectNoteCandidateIds(db, '"telemetry"', { ...scope, limit: 150 });
        expect(pool).not.toBeNull();
        expect(pool).toHaveLength(150);

        // The df numerator must not clamp at the pool cap, or a common probe
        // regains up to corpus/cap of the weight the IDF falloff removes.
        const counts = countNoteFtsMatchesBatch(db, ['"telemetry"'], scope);
        expect(counts).toEqual([total]);
    });

    it("falls back to the scoped scan for a needle shorter than a trigram", async () => {
        const short = addNote(db, "session", {
            sessionId: NOTE_SESSION,
            content: "ab tiny token note.",
        });
        seedNoteCorpus(db);
        const counter = countingDatabase(db);

        const results = await unifiedSearch(
            counter.db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "ab",
            noteSearchOptions(),
        );

        expect(results.map((result) => (result.source === "note" ? result.noteId : -1))).toContain(
            short.id,
        );
        // A two-character atom is unrepresentable, so the characterized scan runs.
        expect(counter.matching(/SELECT \* FROM notes WHERE/).length).toBeGreaterThan(0);
        expect(counter.matching(/CROSS JOIN notes ON notes\.id = requested\.value/).length).toBe(0);
    });

    it("falls back to the scoped scan when the projection is absent", async () => {
        const bare = new Database(":memory:");
        try {
            initializeDatabase(bare);
            runMigrations(bare);
            bare.exec(`
                DROP TRIGGER IF EXISTS notes_fts_ai;
                DROP TRIGGER IF EXISTS notes_fts_ad;
                DROP TRIGGER IF EXISTS notes_fts_au;
                DROP VIEW IF EXISTS notes_search_view;
                DROP TABLE IF EXISTS notes_fts;
            `);
            const note = addNote(bare, "session", {
                sessionId: NOTE_SESSION,
                content: "Projection-free note about backpressure.",
            });

            const results = await unifiedSearch(
                bare,
                NOTE_SESSION,
                NOTE_PROJECT,
                "backpressure",
                noteSearchOptions(),
            );

            expect(
                results.map((result) => (result.source === "note" ? result.noteId : -1)),
            ).toEqual([note.id]);
        } finally {
            closeQuietly(bare);
        }
    });

    it("selects candidates through the projection and hydrates notes by rowid", () => {
        seedNoteCorpus(db);

        const candidatePlan = (
            db
                .prepare(
                    "EXPLAIN QUERY PLAN SELECT rowid AS id FROM notes_fts WHERE notes_fts MATCH ?",
                )
                .all('"backpressure"') as Array<{ detail: string }>
        )
            .map((row) => row.detail)
            .join(" | ");
        expect(candidatePlan).toContain("notes_fts");

        const hydrationPlan = (
            db
                .prepare(
                    `EXPLAIN QUERY PLAN
                     SELECT notes.* FROM json_each(?) AS requested
                       CROSS JOIN notes ON notes.id = requested.value
                      WHERE notes.status IN ('active', 'pending', 'ready', 'dismissed')
                        AND ((notes.type = 'session' AND notes.session_id = ?)
                          OR (notes.type = 'smart' AND notes.project_path = ?))
                      ORDER BY notes.created_at ASC, notes.id ASC`,
                )
                .all("[1]", NOTE_SESSION, NOTE_PROJECT) as Array<{ detail: string }>
        )
            .map((row) => row.detail)
            .join(" | ");
        expect(hydrationPlan).toContain("PRIMARY KEY");
        expect(hydrationPlan).not.toContain("SCAN notes");
    });

    it("changes eligibility through the authoritative join, not the projection", async () => {
        const seeded = seedNoteCorpus(db);
        const visible = async () =>
            (
                await unifiedSearch(
                    db,
                    NOTE_SESSION,
                    NOTE_PROJECT,
                    "release shipped",
                    noteSearchOptions(),
                )
            ).map((result) => (result.source === "note" ? result.noteId : -1));

        expect(await visible()).toEqual([seeded.ready.id]);

        // Moving the note out of project scope leaves its text projected but makes
        // it ineligible.
        db.prepare("UPDATE notes SET project_path = ? WHERE id = ?").run(
            "git:elsewhere",
            seeded.ready.id,
        );
        expect(
            (
                db
                    .prepare("SELECT rowid AS id FROM notes_fts WHERE notes_fts MATCH ?")
                    .all('"reason: release shipped"') as Array<{ id: number }>
            ).map((row) => row.id),
        ).toEqual([seeded.ready.id]);
        expect(await visible()).toEqual([]);
    });

    it("freezes the note projection for automatic and explicit search", async () => {
        const seeded = seedNoteCorpus(db);

        const automatic = await unifiedSearch(
            db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "queue drain backpressure",
            noteSearchOptions(),
        );
        expect(projectionOf(automatic)).toEqual([
            { source: "note", id: `note:${seeded.matching.id}`, score: 1 },
            { source: "note", id: `note:${seeded.ready.id}`, score: 0.5 },
        ]);

        const explicit = await unifiedSearch(
            db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "queue drain applyBackpressure()",
            noteSearchOptions(true),
        );
        expect(projectionOf(explicit)).toEqual([
            { source: "note", id: `note:${seeded.ready.id}`, score: 1 },
            { source: "note", id: `note:${seeded.matching.id}`, score: 0.5 },
        ]);
    });

    it("keeps an eligible hit reachable past 150+ foreign FTS matches (AE4)", async () => {
        const eligible = addNote(db, "session", {
            sessionId: NOTE_SESSION,
            content: "Eligible saturation follow-up for the drain design.",
        });
        for (let index = 0; index < 180; index += 1) {
            addNote(db, "session", {
                sessionId: "foreign-session",
                content: `Foreign saturation chatter number ${index} for the drain design.`,
            });
        }
        pinNoteTimestamps(db);
        const counter = countingDatabase(db);

        const results = await unifiedSearch(
            counter.db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "saturation",
            noteSearchOptions(),
        );

        expect(results.map((result) => (result.source === "note" ? result.noteId : -1))).toEqual([
            eligible.id,
        ]);
        // Scope joins before the candidate statement's LIMIT.
        const candidateSelects = counter.matching(/JOIN notes ON notes\.id = notes_fts\.rowid/);
        expect(candidateSelects).toHaveLength(1);
        expect(candidateSelects[0].sql).toContain("notes.session_id");
        expect(candidateSelects[0].rowCount).toBeLessThanOrEqual(150);
    });

    it("caps the eligible pool at the deterministic best-ranked 150 rows", async () => {
        for (let index = 0; index < 180; index += 1) {
            addNote(db, "session", {
                sessionId: NOTE_SESSION,
                content: `Eligible saturation note number ${index} for the drain design.`,
            });
        }
        // Repeating the term makes this note rank above the near-identical
        // filler, so the capped pool must include it.
        const best = addNote(db, "session", {
            sessionId: NOTE_SESSION,
            content: "Saturation saturation saturation deep-dive with saturation follow-ups.",
        });
        pinNoteTimestamps(db);
        const counter = countingDatabase(db);

        const first = await unifiedSearch(
            counter.db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "saturation",
            noteSearchOptions(),
        );
        const hydrations = counter.matching(/CROSS JOIN notes ON notes\.id = requested\.value/);
        expect(hydrations).toHaveLength(1);
        expect(hydrations[0].rowCount).toBeLessThanOrEqual(150);
        expect(first.map((result) => (result.source === "note" ? result.noteId : -1))).toContain(
            best.id,
        );

        const second = await unifiedSearch(
            db,
            NOTE_SESSION,
            NOTE_PROJECT,
            "saturation",
            noteSearchOptions(),
        );
        expect(projectionOf(second)).toEqual(projectionOf(first));
    });

    it("bounds the short-needle fallback scan to 150 newest eligible rows", async () => {
        for (let index = 0; index < 180; index += 1) {
            addNote(db, "session", {
                sessionId: NOTE_SESSION,
                content: `ab short-needle note number ${index}.`,
            });
        }
        pinNoteTimestamps(db);
        const counter = countingDatabase(db);

        await unifiedSearch(counter.db, NOTE_SESSION, NOTE_PROJECT, "ab", noteSearchOptions());

        const fallbackScans = counter.matching(/SELECT \* FROM notes WHERE/);
        expect(fallbackScans.length).toBeGreaterThan(0);
        for (const scan of fallbackScans) {
            expect(scan.sql).toContain("LIMIT");
            expect(scan.rowCount).toBeLessThanOrEqual(150);
        }
    });
});
