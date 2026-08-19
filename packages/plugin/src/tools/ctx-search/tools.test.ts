import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { replaceAllCompartments } from "../../features/magic-context/compartment-storage";
import { insertMemory } from "../../features/magic-context/memory";
import { indexMessagesAfterOrdinal } from "../../features/magic-context/message-index";
import { runMigrations } from "../../features/magic-context/migrations";
import type { UnifiedSearchResult } from "../../features/magic-context/search";
import * as searchModule from "../../features/magic-context/search";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxSearchTools, executeCtxSearch } from "./tools";

const toolContext = (sessionID = "ses-search") => ({ sessionID }) as never;
const EXPAND_HINT =
    "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.";
const NOTE_EXPAND_HINT =
    "Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("createCtxSearchTools", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("validates required query", async () => {
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute({ query: "   " }, toolContext());

        expect(result).toBe("Error: 'query' is required.");
    });

    it("rejects an over-cap query with the native string error before any work (AE1)", async () => {
        const searchSpy = spyOn(searchModule, "unifiedSearch");
        const resolveCalls: string[] = [];
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: (directory) => {
                resolveCalls.push(directory);
                return "/repo/project";
            },
            memoryEnabled: true,
            embeddingEnabled: false,
            readMessages: () => [],
        });
        try {
            const byteResult = await tools.ctx_search.execute(
                { query: "a".repeat(16 * 1024 + 1) },
                toolContext(),
            );
            expect(byteResult).toStartWith("Error: query is too large:");

            const atomResult = await tools.ctx_search.execute(
                { query: Array.from({ length: 65 }, (_, index) => `a${index}`).join(" ") },
                toolContext(),
            );
            expect(atomResult).toStartWith("Error: query is too complex:");

            expect(searchSpy).not.toHaveBeenCalled();
            expect(resolveCalls).toHaveLength(0);
        } finally {
            searchSpy.mockRestore();
        }
    });

    it("clamps an over-cap limit to 50 instead of rejecting", async () => {
        const searchSpy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [],
        });
        try {
            await tools.ctx_search.execute({ query: "clamped", limit: 10_000 }, toolContext());
            expect(searchSpy).toHaveBeenCalledTimes(1);
            const options = searchSpy.mock.calls[0]?.[4] as { limit?: number };
            expect(options.limit).toBe(50);
        } finally {
            searchSpy.mockRestore();
        }
    });

    it("formats empty search results", async () => {
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute({ query: "missing" }, toolContext());

        expect(result).toContain("No results found");
    });

    it("preserves an explicit empty sources list as no sources", async () => {
        insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "This should not appear when sources is empty.",
        });
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: true,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute(
            { query: "appear", sources: [] },
            toolContext(),
        );

        expect(result).toContain("No results found");
    });

    it("formats message results with inline ranges and one trailing expand hint", async () => {
        replaceAllCompartments(db, "ses-message", [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "m1",
                endMessageId: "m10",
                title: "Compartment",
                content: "Summary",
            },
        ]);
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [
                {
                    ordinal: 5,
                    id: "m5",
                    role: "assistant",
                    parts: [{ type: "text", text: "Alpha migration details are here." }],
                },
                {
                    ordinal: 6,
                    id: "m6",
                    role: "user",
                    parts: [{ type: "text", text: "More alpha migration context." }],
                },
            ],
        });
        indexMessagesAfterOrdinal(
            db,
            "ses-message",
            [
                ...Array.from({ length: 4 }, (_, index) => ({
                    ordinal: index + 1,
                    id: `covered-${index + 1}`,
                    role: "system",
                    parts: [],
                })),
                {
                    ordinal: 5,
                    id: "m5",
                    role: "assistant",
                    parts: [{ type: "text", text: "Alpha migration details are here." }],
                },
                {
                    ordinal: 6,
                    id: "m6",
                    role: "user",
                    parts: [{ type: "text", text: "More alpha migration context." }],
                },
            ],
            0,
            6,
        );

        const result = await tools.ctx_search.execute(
            { query: "alpha migration", sources: ["message"] },
            toolContext("ses-message"),
        );

        expect(result).toContain("[1] [message] score=1.00 ordinal=6 range=3-9 role=user");
        expect(result).toContain("[2] [message] score=0.50 ordinal=5 range=2-8 role=assistant");
        const messageText = String(result);
        expect(messageText.split(EXPAND_HINT).length - 1).toBe(1);
        expect(messageText.endsWith(EXPAND_HINT)).toBe(true);
        expect(result).not.toContain("Expand with ctx_expand(start=");
    });

    it("omits the consolidated expand hint for memory-only results", async () => {
        insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Alpha memory only search result.",
        });
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: true,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute(
            { query: "alpha", sources: ["memory"] },
            toolContext(),
        );

        expect(result).toContain("[1] [memory]");
        expect(result).not.toContain(EXPAND_HINT);
        expect(result).not.toContain("ctx_expand");
    });

    it("formats note results with note ids, status labels, and anchor expand hints", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [
                    {
                        source: "note",
                        content: "Keep the dry-run fallback until telemetry stabilizes.",
                        score: 0.88,
                        noteId: 7,
                        status: "dismissed",
                        createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
                        anchorOrdinal: 44,
                        sourceSessionId: "ses-search",
                    },
                ] as UnifiedSearchResult[],
        );
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: false,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute(
                { query: "telemetry fallback", sources: ["note"] },
                toolContext(),
            );

            expect(result).toContain("[1] [note]");
            expect(result).toContain("id=#7 status=dismissed");
            expect(result).toContain("@msg 44");
            expect(result).toContain(NOTE_EXPAND_HINT);
        } finally {
            spy.mockRestore();
        }
    });

    it("omits note anchors and footer hints for foreign-session smart notes", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [
                    {
                        source: "note",
                        content: "Foreign session note should not expose an expandable anchor.",
                        score: 0.73,
                        noteId: 8,
                        status: "ready",
                        createdAt: Date.now(),
                        anchorOrdinal: 45,
                        sourceSessionId: "ses-other",
                    },
                ] as UnifiedSearchResult[],
        );
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: false,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute(
                { query: "foreign anchor", sources: ["note"] },
                toolContext("ses-search"),
            );

            expect(result).toContain("[1] [note]");
            expect(result).not.toContain("@msg 45");
            expect(result).not.toContain(NOTE_EXPAND_HINT);
        } finally {
            spy.mockRestore();
        }
    });

    it("resolves a `#1234` query directly to the matching memory without calling unifiedSearch", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Direct id hit for the short-circuit.",
        });
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => {
            throw new Error("unifiedSearch must not run for ID-shaped queries");
        });
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute(
                { query: `#${memory.id}` },
                toolContext(),
            );

            expect(result).toContain("[1] [memory]");
            expect(result).toContain(`id=${memory.id}`);
            expect(result).toContain("Direct id hit for the short-circuit.");
        } finally {
            spy.mockRestore();
        }
    });

    it("falls through to unifiedSearch when the bare-id query has no matching memory", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [
                    {
                        source: "memory",
                        content: "Numeric query that survived into text search.",
                        score: 0.5,
                        memoryId: 1,
                        category: "USER_DIRECTIVES",
                        matchType: "fts",
                    },
                ] as UnifiedSearchResult[],
        );
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute({ query: "7234" }, toolContext());

            // The id short-circuit found nothing for 7234, so the call must
            // reach the normal text lanes (which we mocked here).
            expect(result).toContain("[1] [memory]");
            expect(result).toContain("Numeric query that survived into text search.");
        } finally {
            spy.mockRestore();
        }
    });

    it("invokes normal search exactly once when every requested id is missing or hidden", async () => {
        const hidden = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Hidden because it is already rendered.",
        });
        let calls = 0;
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => {
            calls += 1;
            return [
                {
                    source: "memory",
                    content: "Fallback text search hit.",
                    score: 0.5,
                    memoryId: 1,
                    category: "USER_DIRECTIVES",
                    matchType: "fts",
                },
            ] as UnifiedSearchResult[];
        });
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const missing = await tools.ctx_search.execute(
                { query: "999999 888888" },
                toolContext(),
            );
            expect(missing).toContain("Fallback text search hit.");
            expect(calls).toBe(1);

            // A row outside the project scope is as invisible as a missing one.
            db.prepare("UPDATE memories SET project_path = ? WHERE id = ?").run(
                "/repo/other",
                hidden.id,
            );
            const hiddenResult = await tools.ctx_search.execute(
                { query: `#${hidden.id}` },
                toolContext(),
            );
            expect(hiddenResult).toContain("Fallback text search hit.");
            expect(calls).toBe(2);
        } finally {
            spy.mockRestore();
        }
    });

    it("does NOT treat a phrase containing a number as an id lookup", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [
                    {
                        source: "memory",
                        content: "Text search hit, not an id lookup.",
                        score: 0.6,
                        memoryId: 1,
                        category: "USER_DIRECTIVES",
                        matchType: "fts",
                    },
                ] as UnifiedSearchResult[],
        );
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute({ query: "fix bug 1234" }, toolContext());

            expect(result).toContain("Text search hit, not an id lookup.");
        } finally {
            spy.mockRestore();
        }
    });
});

describe("executeCtxSearch", () => {
    let db: Database;
    const deps = () => ({
        db,
        resolveProjectPath: () => "/repo/project",
        memoryEnabled: true,
        embeddingEnabled: false,
        readMessages: () => [],
    });

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("returns invalid outcomes with the same error text the tool returns", async () => {
        const tools = createCtxSearchTools(deps());
        const execution = await executeCtxSearch(deps(), { query: "   " }, toolContext());
        expect(execution.status).toBe("invalid");
        expect(execution.text).toBe(
            String(await tools.ctx_search.execute({ query: "   " }, toolContext())),
        );
    });

    it("keeps direct-ID lookup byte-identical between the tool and the structured helper", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Direct id hit for the structured helper.",
        });
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => {
            throw new Error("unifiedSearch must not run for ID-shaped queries");
        });
        try {
            const sharedDeps = deps();
            const tools = createCtxSearchTools(sharedDeps);
            const args = { query: `#${memory.id}` };
            const execution = await executeCtxSearch(sharedDeps, args, toolContext());
            expect(execution.status).toBe("complete");
            if (execution.status !== "complete") return;
            expect(execution.text).toBe(
                String(await tools.ctx_search.execute(args, toolContext())),
            );
            expect(execution.reason).toBe("delivered");
            expect(execution.prePack).toHaveLength(1);
            expect(execution.delivered).toEqual(execution.prePack);
            expect(execution.omittedCount).toBe(0);
            expect(execution.text).toContain(`id=${memory.id}`);
        } finally {
            spy.mockRestore();
        }
    });

    it("keeps the multi-probe explicit path byte-identical between tool and helper", async () => {
        const results: UnifiedSearchResult[] = [
            {
                source: "memory",
                content: "multi-probe explicit search hit",
                score: 0.7,
                memoryId: 5,
                category: "USER_DIRECTIVES",
                matchType: "fts",
            },
        ];
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => results);
        try {
            const sharedDeps = deps();
            const tools = createCtxSearchTools(sharedDeps);
            const args = { query: "multi probe lookup" };
            const execution = await executeCtxSearch(sharedDeps, args, toolContext());
            expect(execution.status).toBe("complete");
            if (execution.status !== "complete") return;
            expect(execution.text).toBe(
                String(await tools.ctx_search.execute(args, toolContext())),
            );
            // Both calls run through the same explicit-search options.
            expect(spy).toHaveBeenCalledTimes(2);
            for (const call of spy.mock.calls) {
                const options = call[4] as { explicitSearch?: boolean };
                expect(options.explicitSearch).toBe(true);
            }
            expect(execution.prePack).toEqual(results);
            expect(execution.delivered).toEqual(results);
        } finally {
            spy.mockRestore();
        }
    });

    it("keeps a packing-omitted result in prePack but out of delivered", async () => {
        const filler = Array.from({ length: 300 }, (_, index) =>
            ((index * 2654435761) % 36).toString(36),
        ).join(" ");
        const results: UnifiedSearchResult[] = Array.from({ length: 50 }, (_, index) => ({
            source: "memory",
            content: `${filler} tail-${index}`,
            score: 0.9,
            memoryId: index + 1,
            category: "USER_DIRECTIVES",
            matchType: "fts",
        }));
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => results);
        try {
            const execution = await executeCtxSearch(deps(), { query: "big" }, toolContext());
            expect(execution.status).toBe("complete");
            if (execution.status !== "complete") return;
            expect(execution.reason).toBe("delivered");
            expect(execution.prePack).toEqual(results);
            expect(execution.delivered.length).toBeLessThan(results.length);
            expect(execution.delivered).toEqual(results.slice(0, execution.delivered.length));
            expect(execution.omittedCount).toBe(results.length - execution.delivered.length);
            const omitted = results[results.length - 1];
            expect(execution.prePack).toContain(omitted);
            expect(execution.delivered).not.toContain(omitted);
            expect(execution.text).not.toContain(`tail-${results.length - 1}`);
        } finally {
            spy.mockRestore();
        }
    });

    it("returns an empty-results completed delivery, not a failure, for zero results", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => []);
        try {
            const execution = await executeCtxSearch(deps(), { query: "missing" }, toolContext());
            expect(execution.status).toBe("complete");
            if (execution.status !== "complete") return;
            expect(execution.reason).toBe("empty-results");
            expect(execution.prePack).toEqual([]);
            expect(execution.delivered).toEqual([]);
            expect(execution.text).toContain("No results found");
        } finally {
            spy.mockRestore();
        }
    });

    it("propagates a search failure instead of returning an empty delivery", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => {
            throw new Error("search lane exploded");
        });
        try {
            expect(executeCtxSearch(deps(), { query: "boom" }, toolContext())).rejects.toThrow(
                "search lane exploded",
            );
        } finally {
            spy.mockRestore();
        }
    });
});
