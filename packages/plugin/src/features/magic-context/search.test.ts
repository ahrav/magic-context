/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "../../shared/sqlite";

let queryEmbedding: Float32Array | null = null;
const embeddingQueries: string[] = [];
const rawMessagesBySession = new Map<
    string,
    Array<{ ordinal: number; id: string; role: string; parts: unknown[] }>
>();

import { packAutoSearchHint } from "../../hooks/magic-context/auto-search-hint";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    chunkCanonicalText,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import { upsertCommits } from "./git-commits";
import {
    _resetEmbeddingConfigForTests,
    embedTextForProject,
    initializeEmbedding,
} from "./memory/embedding";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import { createAntiMemory, readAntiMemory } from "./memory/storage-anti-memory";
import * as claimCurrentState from "./memory/storage-claim-current-state";
import {
    computeProjectMemoryMutationToken,
    setProjectMemoryClaimLifecycle,
} from "./memory/storage-claim-operations";
import { retireAntiMemoryByHumanInCurrentTransaction } from "./memory/storage-claim-policy";
import { ensureProject } from "./memory/storage-claims";
import { ensureMessagesIndexed } from "./message-index";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    registerProjectEmbedding,
} from "./project-embedding-registry";
import {
    assignMessagesToCompartments,
    type CompartmentSearchResult,
    type MessageSearchResult,
    mergeMessageAndCompartmentResults,
    parseIdShapedQuery,
    parseLocatorShapedQuery,
    resolveClaimsByLocatorsForSearch,
    type UnifiedSearchResult,
    unifiedSearch,
} from "./search";
import { QueryBoundsError } from "./search-bounds";
import type { SearchTraceSpan } from "./search-trace";
import { countingDatabase } from "./sql-counters";
import {
    addNote,
    countNoteFtsMatchesBatch,
    dismissNote,
    selectNoteCandidateIds,
    updateNote,
} from "./storage-notes";
import { createPrimer } from "./storage-primers";
import {
    createClaimReaderTestDatabase,
    type SeededProjectMemoryClaim,
    seedProjectMemoryClaim,
} from "./test-claim-database";
import { createDirectTestDatabase } from "./test-database";

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
    return createClaimReaderTestDatabase();
}

function seedAntiMemory(
    db: Database,
    projectIdentity: string,
    key: string,
    nowMs = Date.now(),
    pair: { trigger: string; rejectedStrategy: string } = {
        trigger: "session caching",
        rejectedStrategy: "Redis",
    },
) {
    const result = createAntiMemory(
        db,
        { producer: "search-test", operationKey: `anti-${key}` },
        {
            projectId: ensureProject(db, projectIdentity),
            payload: {
                ...pair,
                rejectionReason: "it creates split ownership",
                saferAlternative: "use SQLite",
            },
            provenance: {
                sourceLocator: `test://search/${key}`,
                sourceContent: "Redis rejected for session caching",
                extractor: "test",
                extractorVersion: "1",
                extractorRunId: key,
                independenceKey: key,
                sourceTrustClass: "explicit_user",
            },
            actor: "user:test",
            nowMs,
        },
    );
    const publicClaimId = (result.result.payload as { claim: { publicClaimId: string } }).claim
        .publicClaimId;
    const record = readAntiMemory(db, publicClaimId);
    if (record === null) throw new Error("anti-memory seed failed");
    return record;
}

afterEach(() => {
    queryEmbedding = null;
    embeddingQueries.length = 0;
    rawMessagesBySession.clear();
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

    it("resolves exact claim locators through the provider with no legacy memory read", () => {
        const project = "git:u3-search-reader";
        const content = "u3 exact locator fact preserves UTF-8 bytes: café";
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: project,
            content,
            category: "CONSTRAINTS",
        });

        const statements: string[] = [];
        const originalPrepare = db.prepare.bind(db);
        db.prepare = ((sql: string) => {
            statements.push(sql);
            return originalPrepare(sql);
        }) as typeof db.prepare;
        let results: ReturnType<typeof resolveClaimsByLocatorsForSearch>;
        try {
            results = resolveClaimsByLocatorsForSearch({
                db,
                projectPath: project,
                locators: [claim.revisionLocator],
                limit: 10,
            });
        } finally {
            db.prepare = originalPrepare;
        }

        expect(results).not.toBeNull();
        if (results === null) throw new Error("unreachable");
        expect(results).toHaveLength(1);
        const hit = results[0];
        expect(Buffer.from(hit.content)).toEqual(Buffer.from(content));
        expect(hit.publicClaimId).toBe(claim.publicClaimId);
        expect(hit.revisionLocator).toBe(claim.revisionLocator);
        expect(hit.matchType).toBe("exact");
        expect(hit.contentDigest).toBe(claim.contentDigest);
        expect(Object.keys(hit)).not.toContain("memoryId");
        expect(
            statements.some((sql) =>
                /\bmemories(?:_fts)?\b|\bmemory_stats\b|\bmemory_verifications\b/i.test(sql),
            ),
        ).toBeFalse();
    });

    it("matches active anti-memory text and preserves warning shape for exact locators", async () => {
        const project = "git:anti-search";
        const anti = seedAntiMemory(db, project, "active");

        const matching = await unifiedSearch(db, "session-anti", project, "Redis session caching", {
            sources: ["memory"],
            memoryEnabled: true,
            embeddingEnabled: false,
            memoryPolicySurface: "explicit_search",
        });
        expect(matching).toHaveLength(1);
        expect(matching[0]).toMatchObject({
            source: "anti_memory",
            publicClaimId: anti.publicClaimId,
            rejectedStrategy: "Redis",
            rejectionReason: "it creates split ownership",
            saferAlternative: "use SQLite",
            matchType: "lexical",
        });
        expect(
            await unifiedSearch(db, "session-anti", project, "button colors", {
                sources: ["memory"],
                memoryEnabled: true,
                embeddingEnabled: false,
            }),
        ).toEqual([]);

        const exact = resolveClaimsByLocatorsForSearch({
            db,
            projectPath: project,
            locators: [anti.revisionLocator],
            limit: 10,
        });
        expect(exact?.[0]).toMatchObject({
            source: "anti_memory",
            publicClaimId: anti.publicClaimId,
            rejectedStrategy: "Redis",
            matchType: "exact",
        });

        db.transaction(() =>
            retireAntiMemoryByHumanInCurrentTransaction(db, {
                publicClaimId: anti.publicClaimId,
                authority: { kind: "human", actor: "user:test" },
                reason: "false warning",
            }),
        ).immediate();
        expect(
            await unifiedSearch(db, "session-anti", project, "Redis session caching", {
                sources: ["memory"],
                memoryEnabled: true,
                embeddingEnabled: false,
                memoryPolicySurface: "explicit_search",
            }),
        ).toEqual([]);
    });

    it("matches anti-memory through auto-search embedding without lexical token overlap", async () => {
        const project = "git:anti-semantic-search";
        const anti = seedAntiMemory(db, project, "semantic");
        const embeddedPassages: string[][] = [];
        queryEmbedding = new Float32Array([1, 0]);

        const semantic = await unifiedSearch(
            db,
            "session-anti",
            project,
            "accelerate login state with distributed key-value infrastructure",
            {
                sources: ["memory"],
                memoryEnabled: true,
                embeddingEnabled: true,
                memoryPolicySurface: "auto_search",
                embedQuery,
                embedPassages: async (texts, _signal, purpose) => {
                    expect(purpose).toBe("passage");
                    embeddedPassages.push(texts);
                    return texts.map(() => new Float32Array([1, 0]));
                },
                isEmbeddingRuntimeEnabled,
            },
        );

        expect(semantic).toHaveLength(1);
        expect(semantic[0]).toMatchObject({
            source: "anti_memory",
            publicClaimId: anti.publicClaimId,
            matchType: "semantic",
            score: 1,
        });
        expect(embeddedPassages).toHaveLength(1);
        expect(embeddedPassages[0]?.[0]).toContain("session caching");

        expect(
            await unifiedSearch(
                db,
                "session-anti",
                project,
                "accelerate login state with distributed key-value infrastructure",
                {
                    sources: ["memory"],
                    memoryEnabled: true,
                    embeddingEnabled: true,
                    memoryPolicySurface: "explicit_search",
                    embedQuery,
                    embedPassages: async () => {
                        throw new Error("explicit search must remain lexical-only");
                    },
                    isEmbeddingRuntimeEnabled,
                },
            ),
        ).toEqual([]);
    });

    it("reserves an auto-search slot for anti-memory before the global limit", async () => {
        const project = "git:anti-global-limit";
        const anti = seedAntiMemory(db, project, "global-limit");
        const query =
            "session caching alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma";
        rawMessagesBySession.set(
            "session-anti-limit",
            Array.from({ length: 12 }, (_, index) => ({
                ordinal: index + 1,
                id: `strong-${index}`,
                role: "assistant",
                parts: [{ type: "text", text: `${query} candidate ${index}` }],
            })),
        );
        ensureMessagesIndexed(db, "session-anti-limit", readMessages);
        const options = {
            limit: 3,
            sources: ["memory", "message"] as Array<"memory" | "message">,
            memoryEnabled: true,
            embeddingEnabled: false,
            readMessages,
        };

        const automatic = await unifiedSearch(db, "session-anti-limit", project, query, {
            ...options,
            memoryPolicySurface: "auto_search",
        });
        expect(automatic).toHaveLength(3);
        expect(automatic.filter((result) => result.source === "message")).toHaveLength(2);
        expect(automatic.find((result) => result.source === "anti_memory")).toMatchObject({
            publicClaimId: anti.publicClaimId,
        });

        const packed = packAutoSearchHint(automatic);
        expect(packed.delivered[0]).toMatchObject({
            source: "anti_memory",
            publicClaimId: anti.publicClaimId,
        });
        expect(packed.text).toContain("⚠ Previously rejected: Redis");

        const explicit = await unifiedSearch(db, "session-anti-limit", project, query, {
            ...options,
            limit: 4,
            memoryPolicySurface: "explicit_search",
        });
        expect(explicit).toHaveLength(4);
        expect(explicit.every((result) => result.source === "message")).toBe(true);
    });

    it("embeds anti-memory query and passages through one project provider and fails open", async () => {
        const project = "git:anti-project-lane";
        seedAntiMemory(db, project, "project-lane");
        const calls: Array<{ kind: "query" | "batch"; purpose?: EmbeddingPurpose }> = [];
        let failBatch = false;
        const provider: EmbeddingProvider = {
            modelId: "local:project-lane",
            initialize: async () => true,
            embed: async (_text, _signal, purpose) => {
                calls.push({ kind: "query", purpose });
                return new Float32Array([1, 0]);
            },
            embedBatch: async (texts, _signal, purpose) => {
                calls.push({ kind: "batch", purpose });
                if (failBatch) throw new Error("passage lane unavailable");
                return texts.map(() => new Float32Array([1, 0]));
            },
            dispose: async () => {},
            isLoaded: () => true,
        };
        _setTestProviderFactoryForProject(() => provider);
        registerEmbeddingProject(db, project);

        const options = {
            sources: ["memory"] as Array<"memory">,
            memoryEnabled: true,
            embeddingEnabled: true,
            memoryPolicySurface: "auto_search" as const,
            embedQuery: (text: string, signal?: AbortSignal, purpose?: EmbeddingPurpose) =>
                embedTextForProject(project, text, signal, purpose),
            isEmbeddingRuntimeEnabled,
        };
        const query = "distributed key-value login acceleration";
        const semantic = await unifiedSearch(db, "session-anti", project, query, options);
        expect(semantic[0]).toMatchObject({ source: "anti_memory", matchType: "semantic" });
        expect(calls).toEqual([
            { kind: "query", purpose: "query" },
            { kind: "batch", purpose: "passage" },
        ]);

        calls.length = 0;
        failBatch = true;
        expect(await unifiedSearch(db, "session-anti", project, query, options)).toEqual([]);
        expect(calls.map((call) => call.kind)).toEqual(["query", "batch"]);
    });

    it("labels stale anti-memory only in explicit search and omits expired records", async () => {
        const project = "git:anti-lifecycle";
        const stale = seedAntiMemory(db, project, "stale");
        const staleRevision = db
            .prepare(
                `SELECT revisions.id AS id FROM claim_public_ids public
                 JOIN claims ON claims.id = public.claim_id
                 JOIN claim_revisions revisions ON revisions.id = claims.current_revision_id
                 WHERE public.public_id = ?`,
            )
            .get(stale.publicClaimId) as { id: number };
        db.prepare(
            "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'stale', 'test', ?)",
        ).run(staleRevision.id, Date.now());
        const expired = seedAntiMemory(
            db,
            project,
            "expired",
            Date.now() - 91 * 24 * 60 * 60 * 1_000,
            { trigger: "session cache expiry", rejectedStrategy: "Memcached" },
        );
        expect(expired.publicClaimId).not.toBe(stale.publicClaimId);

        const explicit = await unifiedSearch(db, "session-anti", project, "Redis session caching", {
            sources: ["memory"],
            memoryEnabled: true,
            embeddingEnabled: false,
            memoryPolicySurface: "explicit_search",
        });
        expect(explicit).toHaveLength(1);
        expect(explicit[0].source).toBe("anti_memory");
        if (explicit[0].source === "anti_memory") {
            expect(explicit[0].policyLabel).toContain("stale");
        }

        const automatic = await unifiedSearch(
            db,
            "session-anti",
            project,
            "Redis session caching",
            {
                sources: ["memory"],
                memoryEnabled: true,
                embeddingEnabled: false,
                memoryPolicySurface: "auto_search",
            },
        );
        expect(automatic).toEqual([]);

        expect(
            await unifiedSearch(db, "session-anti", project, "Memcached session cache expiry", {
                sources: ["memory"],
                memoryEnabled: true,
                embeddingEnabled: false,
                memoryPolicySurface: "explicit_search",
            }),
        ).toEqual([]);
    });

    it("suppresses the project-memory lane in unified search until retrieval activates", async () => {
        seedProjectMemoryClaim(db, {
            projectIdentity: "git:repo-project",
            content: "Magic context stores ranked search data in SQLite.",
            category: "ARCHITECTURE",
        });
        queryEmbedding = new Float32Array([1, 0]);

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

        const results = await unifiedSearch(db, "ses-1", "git:repo-project", "ranked search", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            readMessages,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        });

        expect(results.length).toBeGreaterThan(0);
        const sources = results.map((r) => r.source);
        // No broad claim scan and no memory-table lane exists on this path.
        expect(sources).not.toContain("memory");
        expect(sources).toContain("message");
        expect(sources).not.toContain("fact");
    });

    it("authorizes locator lookups by workspace shared categories", () => {
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', '["CONSTRAINTS"]', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const own = seedProjectMemoryClaim(db, {
            projectIdentity: "git:own",
            content: "own naming needle",
            category: "NAMING",
        });
        const foreignShared = seedProjectMemoryClaim(db, {
            projectIdentity: "git:foreign",
            content: "foreign constraint needle",
            category: "CONSTRAINTS",
            sharing: "shareable",
        });
        const foreignHidden = seedProjectMemoryClaim(db, {
            projectIdentity: "git:foreign",
            content: "foreign naming needle",
            category: "NAMING",
            sharing: "shareable",
        });

        const results = resolveClaimsByLocatorsForSearch({
            db,
            projectPath: "git:own",
            locators: [own.publicClaimId, foreignShared.publicClaimId, foreignHidden.publicClaimId],
            limit: 10,
        });

        const ids = (results ?? []).map((result) => result.publicClaimId).sort();
        expect(ids).toEqual([own.publicClaimId, foreignShared.publicClaimId].sort());
        expect(ids).not.toContain(foreignHidden.publicClaimId);
        const foreignHit = (results ?? []).find(
            (result) => result.publicClaimId === foreignShared.publicClaimId,
        );
        expect(foreignHit?.sourceName).toBe("Foreign");
    });

    it("fails closed for malformed workspace share categories on locator lookup", () => {
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', 'not-json', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const own = seedProjectMemoryClaim(db, {
            projectIdentity: "git:own",
            content: "own malformed-policy needle",
            category: "CONSTRAINTS",
        });
        const foreign = seedProjectMemoryClaim(db, {
            projectIdentity: "git:foreign",
            content: "foreign malformed-policy needle",
            category: "CONSTRAINTS",
            sharing: "shareable",
        });

        const results = resolveClaimsByLocatorsForSearch({
            db,
            projectPath: "git:own",
            locators: [own.publicClaimId, foreign.publicClaimId],
            limit: 10,
        });

        const ids = (results ?? []).map((result) => result.publicClaimId);
        expect(ids).toContain(own.publicClaimId);
        expect(ids).not.toContain(foreign.publicClaimId);
    });

    it("uses the designed CONSTRAINTS default for legacy NULL workspace share categories", () => {
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
        const foreignConstraint = seedProjectMemoryClaim(db, {
            projectIdentity: "git:foreign",
            content: "foreign legacy-null constraint needle",
            category: "CONSTRAINTS",
            sharing: "shareable",
        });
        const foreignNaming = seedProjectMemoryClaim(db, {
            projectIdentity: "git:foreign",
            content: "foreign legacy-null naming needle",
            category: "NAMING",
            sharing: "shareable",
        });

        const results = resolveClaimsByLocatorsForSearch({
            db,
            projectPath: "git:own",
            locators: [foreignConstraint.publicClaimId, foreignNaming.publicClaimId],
            limit: 10,
        });

        const ids = (results ?? []).map((result) => result.publicClaimId);
        expect(ids).toContain(foreignConstraint.publicClaimId);
        expect(ids).not.toContain(foreignNaming.publicClaimId);
    });

    it("maxMessageOrdinal=0 excludes every message (no compartment yet → whole tail is live)", async () => {
        // Issue #131: before the historian first runs there are no compartments,
        // so the ctx_search tool passes a cutoff of 0. Ordinals are 1-based, so a
        // 0 cutoff must exclude EVERY indexed message — none have scrolled out of
        // the live context the agent already sees (incl. the current prompt).
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
        expect(broadSources).toContain("note");
        expect(broadSources).not.toContain("memory");
    });

    it("restricts results to the sources filter", async () => {
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
        // The memory source stays selectable but serves nothing until the
        // retrieval projection activates.
        expect(memoryOnly).toHaveLength(0);

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

    it("hard-filters claims whose revision locators are already visible", () => {
        const visible = seedProjectMemoryClaim(db, {
            projectIdentity: "git:repo-visible",
            content: "Keep historian subagent hidden via mode=subagent plus hidden=true.",
            category: "ARCHITECTURE",
        });
        const hidden = seedProjectMemoryClaim(db, {
            projectIdentity: "git:repo-visible",
            content: "Historian child sessions inherit parent variant for cache stability.",
            category: "ARCHITECTURE",
        });

        const results = resolveClaimsByLocatorsForSearch({
            db,
            projectPath: "git:repo-visible",
            locators: [visible.publicClaimId, hidden.publicClaimId],
            limit: 10,
            visibleRevisionLocators: new Set([visible.revisionLocator]),
        });

        const ids = (results ?? []).map((result) => result.publicClaimId);
        expect(ids).not.toContain(visible.publicClaimId);
        expect(ids).toContain(hidden.publicClaimId);
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
    it("embeds the query exactly once for the git-commit lane", async () => {
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

describe("query-purpose provider boundary (U30)", () => {
    let db: Database;
    let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

    beforeEach(() => {
        db = createTestDb();
        fetchSpy = spyOn(globalThis, "fetch");
        fetchSpy.mockImplementation(
            (async () =>
                new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
                    headers: { "content-type": "application/json" },
                })) as unknown as typeof fetch,
        );
        initializeEmbedding({
            provider: "openai-compatible",
            model: "nvidia/nv-embed",
            endpoint: "http://127.0.0.1:65535",
            input_type: "passage",
            query_input_type: "query",
        });
    });

    afterEach(() => {
        _resetEmbeddingConfigForTests();
        fetchSpy.mockRestore();
        closeQuietly(db);
    });

    function sentInputTypes(): unknown[] {
        return fetchSpy.mock.calls.map((call) => {
            const init = call[1] as RequestInit;
            return (JSON.parse(init.body as string) as Record<string, unknown>).input_type;
        });
    }

    it("sends the query input type when no embedQuery override is supplied (AE1)", async () => {
        await unifiedSearch(db, "ses-purpose", "/repo/project", "queue saturation design", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
        });

        expect(sentInputTypes()).toEqual(["query"]);
    });

    it("runs a supplied override once across semantic lanes and never the default provider (AE2)", async () => {
        const overrideQueries: string[] = [];
        await unifiedSearch(db, "ses-purpose", "/repo/project", "queue saturation design", {
            limit: 5,
            memoryEnabled: true,
            embeddingEnabled: true,
            gitCommitsEnabled: true,
            embedQuery: async (text) => {
                overrideQueries.push(text);
                return new Float32Array([1, 0]);
            },
        });

        expect(overrideQueries).toEqual(["queue saturation design"]);
        expect(fetchSpy.mock.calls).toHaveLength(0);
    });

    it("never calls the provider when embedding is off, the runtime is off, or only non-semantic lanes run (AE3)", async () => {
        await unifiedSearch(db, "ses-purpose", "/repo/project", "anything", {
            memoryEnabled: true,
            embeddingEnabled: false,
        });
        await unifiedSearch(db, "ses-purpose", "/repo/project", "anything", {
            memoryEnabled: true,
            embeddingEnabled: true,
            isEmbeddingRuntimeEnabled: () => false,
        });
        await unifiedSearch(db, "ses-purpose", "/repo/project", "anything", {
            memoryEnabled: true,
            embeddingEnabled: true,
            sources: ["note"],
        });
        await unifiedSearch(db, "ses-purpose", "/repo/project", "   ", {
            memoryEnabled: true,
            embeddingEnabled: true,
        });

        expect(fetchSpy.mock.calls).toHaveLength(0);
    });

    it("degrades semantic lanes without surfacing an exception when the provider fails", async () => {
        fetchSpy.mockImplementation((async () => {
            throw new Error("embedding endpoint down");
        }) as unknown as typeof fetch);

        const results = await unifiedSearch(
            db,
            "ses-purpose",
            "/repo/project",
            "queue saturation design",
            {
                limit: 5,
                memoryEnabled: true,
                embeddingEnabled: true,
            },
        );

        // No exception surfaced and no memory-lane hit exists on this path.
        expect(results.filter((result) => result.source === "memory")).toHaveLength(0);
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
            return `memory:${result.publicClaimId}`;
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
    primerId: number;
    noteIds: number[];
    sha: string;
} {
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

    it("keeps the frozen mixed-source projection byte-identical with tracing enabled", async () => {
        seedProjectionCorpus(db);

        const baseline = await unifiedSearch(
            db,
            FIXTURE_SESSION,
            FIXTURE_PROJECT,
            "queue drain backpressure",
            searchOptions(false),
        );
        const spans: SearchTraceSpan[] = [];
        const traced = await unifiedSearch(
            db,
            FIXTURE_SESSION,
            FIXTURE_PROJECT,
            "queue drain backpressure",
            {
                ...searchOptions(false),
                trace: { sink: { onSpan: (span) => spans.push(span) } },
            },
        );

        expect(projectionOf(traced)).toEqual(projectionOf(baseline));
        expect(spans.filter((span) => span.stage === "root")).toHaveLength(1);
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

describe("resolveClaimsByLocatorsForSearch", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    function seedWorkspace(): {
        allowedForeign: SeededProjectMemoryClaim;
        ownArchived: SeededProjectMemoryClaim;
    } {
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', '["CONSTRAINTS"]', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const allowedForeign = seedProjectMemoryClaim(db, {
            projectIdentity: "git:foreign",
            content: "allowed foreign row",
            category: "CONSTRAINTS",
            sharing: "shareable",
        });
        const ownArchived = seedProjectMemoryClaim(db, {
            projectIdentity: "git:own",
            content: "own archived row",
            category: "CONSTRAINTS",
        });
        const lifecycle = setProjectMemoryClaimLifecycle(
            db,
            { producer: "test", operationKey: `archive-${ownArchived.publicClaimId}` },
            {
                token: computeProjectMemoryMutationToken(db, ownArchived.publicClaimId),
                state: "archived",
                actor: "user:test",
            },
        );
        expect(lifecycle.outcome).toBe("applied");
        return { allowedForeign, ownArchived };
    }

    it("returns visible claims with workspace source attribution", () => {
        const seeded = seedWorkspace();

        const resolved = resolveClaimsByLocatorsForSearch({
            db,
            projectPath: "git:own",
            locators: [
                seeded.allowedForeign.publicClaimId,
                `mcm_${"9".repeat(32)}`,
                seeded.ownArchived.publicClaimId,
                seeded.allowedForeign.publicClaimId,
            ],
            limit: 10,
        });

        expect(resolved).not.toBeNull();
        const byId = new Map((resolved ?? []).map((result) => [result.publicClaimId, result]));
        expect([...byId.keys()].sort()).toEqual(
            [seeded.allowedForeign.publicClaimId, seeded.ownArchived.publicClaimId].sort(),
        );
        expect(byId.get(seeded.allowedForeign.publicClaimId)?.sourceName).toBe("Foreign");
        expect(byId.get(seeded.ownArchived.publicClaimId)?.sourceName).toBeUndefined();
    });

    it("returns the null fallback sentinel when every locator is missing or hidden", () => {
        seedProjectMemoryClaim(db, {
            projectIdentity: "git:elsewhere",
            content: "row in an unrelated project",
            category: "CONSTRAINTS",
        });
        expect(
            resolveClaimsByLocatorsForSearch({
                db,
                projectPath: "git:own-empty",
                locators: [`mcm_${"9".repeat(32)}`],
                limit: 10,
            }),
        ).toBeNull();
        expect(
            resolveClaimsByLocatorsForSearch({
                db,
                projectPath: "git:own-empty",
                locators: [],
                limit: 10,
            }),
        ).toBeNull();
    });

    it("a nonmember cannot distinguish hidden from missing by locator", () => {
        const foreign = seedProjectMemoryClaim(db, {
            projectIdentity: "git:foreign-solo",
            content: "private foreign fact",
            category: "CONSTRAINTS",
        });
        const forReal = resolveClaimsByLocatorsForSearch({
            db,
            projectPath: "git:nonmember",
            locators: [foreign.publicClaimId],
            limit: 10,
        });
        const forMissing = resolveClaimsByLocatorsForSearch({
            db,
            projectPath: "git:nonmember",
            locators: [`mcm_${"9".repeat(32)}`],
            limit: 10,
        });
        expect(forReal).toBeNull();
        expect(forMissing).toBeNull();
    });

    it("applies visibleRevisionLocators before the limit without widening scope", () => {
        const seeded = seedWorkspace();

        const resolved = resolveClaimsByLocatorsForSearch({
            db,
            projectPath: "git:own",
            locators: [seeded.allowedForeign.publicClaimId, seeded.ownArchived.publicClaimId],
            limit: 1,
            visibleRevisionLocators: new Set([seeded.allowedForeign.revisionLocator]),
        });

        expect(resolved?.map((result) => result.publicClaimId)).toEqual([
            seeded.ownArchived.publicClaimId,
        ]);
    });

    it("carries the sanitized evidence label for labeled explicit rows", () => {
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: "git:labels",
            content: "disputed fact",
            category: "CONSTRAINTS",
        });
        const ref = db
            .prepare(
                `SELECT claims.current_revision_id AS revisionId, claims.project_id AS projectId
                   FROM claim_public_ids
                   JOIN claims ON claims.id = claim_public_ids.claim_id
                  WHERE claim_public_ids.public_id = ?`,
            )
            .get(claim.publicClaimId) as { revisionId: number; projectId: number };
        db.prepare(
            `INSERT INTO claim_disposition_events
                (revision_id, project_id, disposition, action, actor, policy_version, recorded_at)
             VALUES (?, ?, 'disputed', 'assert', 'user:test', 1, ?)`,
        ).run(ref.revisionId, ref.projectId, Date.now());

        const resolved = resolveClaimsByLocatorsForSearch({
            db,
            projectPath: "git:labels",
            locators: [claim.publicClaimId],
            limit: 10,
        });
        expect(resolved).toHaveLength(1);
        expect(resolved?.[0]?.policyLabel).toContain("disputed");
    });

    /**
     * Hide a claim the way a concurrent writer would: append the quarantine
     * disposition the visibility reducer treats as uniform absence. Written
     * directly, like the neighbouring evidence-label test, so the simulated
     * transition lands at an exact point in this lane rather than depending on
     * an operations-layer schedule.
     */
    function quarantineClaim(database: Database, publicClaimId: string): void {
        const ref = database
            .prepare(
                `SELECT claims.current_revision_id AS revisionId, claims.project_id AS projectId
                   FROM claim_public_ids
                   JOIN claims ON claims.id = claim_public_ids.claim_id
                  WHERE claim_public_ids.public_id = ?`,
            )
            .get(publicClaimId) as { revisionId: number; projectId: number };
        database
            .prepare(
                `INSERT INTO claim_disposition_events
                    (revision_id, project_id, disposition, action, actor, policy_version, recorded_at)
                 VALUES (?, ?, 'quarantined', 'assert', 'user:test', 1, ?)`,
            )
            .run(ref.revisionId, ref.projectId, Date.now());
    }

    /**
     * Drive the cross-process interleave deterministically: let the provider's
     * first read complete and close its snapshot, then commit the transition
     * before this lane returns. This stands in for another process taking the
     * writer lock while this one waits on the telemetry `BEGIN IMMEDIATE`; it
     * does NOT prove anything about real lock scheduling or `busy_timeout`
     * behaviour, only that a transition committed after the provider's
     * snapshot closed cannot be published.
     */
    function hideAfterFirstProviderRead(publicClaimIds: readonly string[]): {
        restore: () => void;
        reads: () => number;
    } {
        const realRead = claimCurrentState.readProjectMemoryCurrentState;
        let reads = 0;
        const spy = spyOn(claimCurrentState, "readProjectMemoryCurrentState").mockImplementation(
            (database, request) => {
                const result = realRead(database, request);
                reads += 1;
                if (reads === 1) {
                    for (const publicClaimId of publicClaimIds) {
                        quarantineClaim(db, publicClaimId);
                    }
                }
                return result;
            },
        );
        return { restore: () => spy.mockRestore(), reads: () => reads };
    }

    it("does not publish a claim hidden after the provider snapshot closed", () => {
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: "git:recheck",
            content: "content that must not survive a mid-flight quarantine",
            category: "CONSTRAINTS",
        });
        const hook = hideAfterFirstProviderRead([claim.publicClaimId]);
        try {
            const resolved = resolveClaimsByLocatorsForSearch({
                db,
                projectPath: "git:recheck",
                locators: [claim.publicClaimId],
                limit: 10,
            });

            // Indistinguishable from "no such locator": the same null fallback
            // a missing or foreign-hidden claim returns.
            expect(resolved).toBeNull();
            // Two provider reads: the hydration read plus the pre-publication
            // recheck. One read would mean the recheck was skipped.
            expect(hook.reads()).toBe(2);
        } finally {
            hook.restore();
        }
    });

    it("rechecks visibility even when retrieval counting is disabled", () => {
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: "git:recheck-no-telemetry",
            content: "hidden mid-flight with telemetry off",
            category: "CONSTRAINTS",
        });
        const hook = hideAfterFirstProviderRead([claim.publicClaimId]);
        try {
            const resolved = resolveClaimsByLocatorsForSearch({
                db,
                projectPath: "git:recheck-no-telemetry",
                locators: [claim.publicClaimId],
                limit: 10,
                countRetrievals: false,
            });

            expect(resolved).toBeNull();
            expect(hook.reads()).toBe(2);
        } finally {
            hook.restore();
        }
    });

    it("drops only the claims that lost visibility mid-flight", () => {
        const hidden = seedProjectMemoryClaim(db, {
            projectIdentity: "git:recheck-partial",
            content: "quarantined between the read and the return",
            category: "CONSTRAINTS",
        });
        const survivor = seedProjectMemoryClaim(db, {
            projectIdentity: "git:recheck-partial",
            content: "still visible at publication time",
            category: "CONSTRAINTS",
        });
        const hook = hideAfterFirstProviderRead([hidden.publicClaimId]);
        try {
            const resolved = resolveClaimsByLocatorsForSearch({
                db,
                projectPath: "git:recheck-partial",
                locators: [hidden.publicClaimId, survivor.publicClaimId],
                limit: 10,
            });

            expect(resolved?.map((result) => result.publicClaimId)).toEqual([
                survivor.publicClaimId,
            ]);
        } finally {
            hook.restore();
        }
    });

    it("publishes unchanged claims through the recheck", () => {
        const claim = seedProjectMemoryClaim(db, {
            projectIdentity: "git:recheck-stable",
            content: "nothing moves under this lookup",
            category: "CONSTRAINTS",
        });
        const realRead = claimCurrentState.readProjectMemoryCurrentState;
        let reads = 0;
        const spy = spyOn(claimCurrentState, "readProjectMemoryCurrentState").mockImplementation(
            (database, request) => {
                reads += 1;
                return realRead(database, request);
            },
        );
        try {
            const resolved = resolveClaimsByLocatorsForSearch({
                db,
                projectPath: "git:recheck-stable",
                locators: [claim.publicClaimId],
                limit: 10,
            });

            expect(resolved?.map((result) => result.publicClaimId)).toEqual([claim.publicClaimId]);
            expect(resolved?.[0]?.content).toBe("nothing moves under this lookup");
            expect(reads).toBe(2);
        } finally {
            spy.mockRestore();
        }
    });

    it("never queries legacy memory tables", () => {
        const seeded = seedWorkspace();
        const counter = countingDatabase(db);

        resolveClaimsByLocatorsForSearch({
            db: counter.db,
            projectPath: "git:own",
            locators: [seeded.allowedForeign.publicClaimId, seeded.ownArchived.publicClaimId],
            limit: 10,
        });

        expect(counter.matching(/(FROM|JOIN) memories\b/).length).toBe(0);
        expect(counter.matching(/memory_stats|memory_verifications/).length).toBe(0);
    });
});

describe("parseLocatorShapedQuery", () => {
    const id = `mcm_${"a".repeat(32)}`;

    it("recognizes a bare public claim id", () => {
        expect(parseLocatorShapedQuery(id)).toEqual([id]);
    });

    it("recognizes a full revision locator", () => {
        expect(parseLocatorShapedQuery(`${id}/r3/${"b".repeat(64)}`)).toEqual([id]);
    });

    it("recognizes a mixed whitespace/comma-separated locator list", () => {
        const other = `mcm_${"c".repeat(32)}`;
        expect(parseLocatorShapedQuery(`${id}, ${other}/r1/${"d".repeat(64)}`)).toEqual([
            id,
            other,
        ]);
    });

    it("rejects ordinary text and numeric id queries", () => {
        expect(parseLocatorShapedQuery("fix bug 1234")).toBeNull();
        expect(parseLocatorShapedQuery("#123")).toBeNull();
        expect(parseLocatorShapedQuery("123")).toBeNull();
        expect(parseLocatorShapedQuery(`${id} plus prose`)).toBeNull();
        expect(parseLocatorShapedQuery("   ")).toBeNull();
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
        const bare = createDirectTestDatabase().db;
        try {
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
