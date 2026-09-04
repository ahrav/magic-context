import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { replaceAllCompartments } from "../../features/magic-context/compartment-storage";
import { indexMessagesAfterOrdinal } from "../../features/magic-context/message-index";
import type { UnifiedSearchResult } from "../../features/magic-context/search";
import * as searchModule from "../../features/magic-context/search";
import { ensureSessionMetaRow } from "../../features/magic-context/storage-meta-shared";
import { createClaimReaderTestDatabase } from "../../features/magic-context/test-claim-database";
import * as kernelClaimUsage from "../../hooks/magic-context/kernel-claim-usage";
import { KernelClient } from "../../shared/kernel-client";
import { FakeKernel, FakeKernelTransport } from "../../shared/kernel-client-testing/fake-kernel";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { KernelClientResolver } from "../ctx-memory/types";
import { createCtxSearchTools, executeCtxSearch } from "./tools";

const toolContext = (sessionID = "ses-search") =>
    ({ sessionID, directory: "/tmp/ctx-search" }) as never;
const EXPAND_HINT =
    "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.";
const NOTE_EXPAND_HINT =
    "Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.";

function createTestDb(): Database {
    return createClaimReaderTestDatabase();
}

const OBJECT_A = `mem_${"a".repeat(32)}`;
const OBJECT_B = `mem_${"b".repeat(32)}`;

/** A kernel client over an in-memory fake; `transport.calls` records every daemon round trip. */
function kernelHarness(kernel = new FakeKernel()): {
    kernel: FakeKernel;
    transport: FakeKernelTransport;
    kernelClient: KernelClientResolver;
} {
    const transport = new FakeKernelTransport(kernel);
    return {
        kernel,
        transport,
        kernelClient: ({ sessionId, projectRoot }) =>
            new KernelClient({ transport, enabled: true, sessionId, projectRoot }),
    };
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
            kernelClient: kernelHarness().kernelClient,
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
            kernelClient: kernelHarness().kernelClient,
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
            kernelClient: kernelHarness().kernelClient,
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
            kernelClient: kernelHarness().kernelClient,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute({ query: "missing" }, toolContext());

        expect(result).toContain("No results found");
    });

    it("preserves an explicit empty sources list as no sources", async () => {
        const tools = createCtxSearchTools({
            db,
            kernelClient: kernelHarness().kernelClient,
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
            kernelClient: kernelHarness().kernelClient,
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

    it("resolves an explicit object-id query even when the id is in the injected baseline", async () => {
        const harness = kernelHarness();
        harness.kernel.seedDecision({
            object_id: OBJECT_A,
            decision_kind: "ARCHITECTURE",
            summary: "Alpha baseline-visible memory.",
        });
        ensureSessionMetaRow(db, "ses-search");
        db.prepare("UPDATE session_meta SET memory_block_ids = ? WHERE session_id = ?").run(
            JSON.stringify([OBJECT_A]),
            "ses-search",
        );
        const searchSpy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
        try {
            const tools = createCtxSearchTools({
                db,
                kernelClient: harness.kernelClient,
                resolveProjectPath: () => "git:repo-project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            const result = await tools.ctx_search.execute({ query: OBJECT_A }, toolContext());
            expect(result).toContain("[1] [memory]");
            expect(result).toContain("Alpha baseline-visible memory.");
            // The daemon answered the id query; no fall-through to local search.
            expect(searchSpy).not.toHaveBeenCalled();
        } finally {
            searchSpy.mockRestore();
        }
    });

    it("excludes a baseline-visible memory from lexical ranking", async () => {
        const harness = kernelHarness();
        harness.kernel.seedDecision({
            object_id: OBJECT_A,
            decision_kind: "ARCHITECTURE",
            summary: "Alpha baseline-visible memory.",
        });
        ensureSessionMetaRow(db, "ses-search");
        db.prepare("UPDATE session_meta SET memory_block_ids = ? WHERE session_id = ?").run(
            JSON.stringify([OBJECT_A]),
            "ses-search",
        );
        const searchSpy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
        try {
            const tools = createCtxSearchTools({
                db,
                kernelClient: harness.kernelClient,
                resolveProjectPath: () => "git:repo-project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            const result = await tools.ctx_search.execute(
                { query: "baseline visible memory" },
                toolContext(),
            );
            expect(result).not.toContain("Alpha baseline-visible memory.");
        } finally {
            searchSpy.mockRestore();
        }
    });

    it("records delivered kernel memory hits for claim-lane retrieval telemetry", async () => {
        const harness = kernelHarness();
        harness.kernel.seedDecision({
            object_id: OBJECT_A,
            decision_kind: "ARCHITECTURE",
            summary: "Alpha memory only search result.",
        });
        const usageSpy = spyOn(kernelClaimUsage, "recordKernelMemoryRetrievals").mockImplementation(
            () => {},
        );
        try {
            const tools = createCtxSearchTools({
                db,
                kernelClient: harness.kernelClient,
                resolveProjectPath: () => "git:repo-project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            await tools.ctx_search.execute({ query: OBJECT_A, sources: ["memory"] }, toolContext());
            expect(usageSpy).toHaveBeenCalledTimes(1);
            expect(usageSpy.mock.calls[0]?.[0]?.objectIds).toEqual([OBJECT_A]);
        } finally {
            usageSpy.mockRestore();
        }
    });

    it("omits the consolidated expand hint for memory-only results", async () => {
        const harness = kernelHarness();
        harness.kernel.seedDecision({
            object_id: OBJECT_A,
            decision_kind: "ARCHITECTURE",
            summary: "Alpha memory only search result.",
        });
        const tools = createCtxSearchTools({
            db,
            kernelClient: harness.kernelClient,
            resolveProjectPath: () => "git:repo-project",
            memoryEnabled: true,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute(
            { query: OBJECT_A, sources: ["memory"] },
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
                kernelClient: kernelHarness().kernelClient,
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
                kernelClient: kernelHarness().kernelClient,
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

    it("resolves an object-id query from the daemon without calling unifiedSearch", async () => {
        const harness = kernelHarness();
        harness.kernel.seedDecision({
            object_id: OBJECT_A,
            decision_kind: "ARCHITECTURE",
            summary: "Direct id hit.",
        });
        const searchSpy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => {
            throw new Error("unifiedSearch must not run for object-id queries");
        });
        try {
            const tools = createCtxSearchTools({
                db,
                kernelClient: harness.kernelClient,
                resolveProjectPath: () => "git:repo-project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            const result = await tools.ctx_search.execute({ query: OBJECT_A }, toolContext());
            expect(result).toContain("[1] [memory]");
            expect(result).toContain(`id=${OBJECT_A}`);
            expect(result).toContain("Direct id hit.");
            const read = harness.transport.calls[0]?.body as { surface: string; gated: boolean };
            expect(read).toMatchObject({ surface: "explicit_search", gated: true });
        } finally {
            searchSpy.mockRestore();
        }
    });

    it("renders the state text when the memory source is not available", async () => {
        const harness = kernelHarness();
        harness.kernel.surfaceStates.set("explicit_search", {
            kind: "stale",
            lag_positions: 4,
            oldest_unconsumed_age_ms: 20,
        });
        const searchSpy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
        try {
            const tools = createCtxSearchTools({
                db,
                kernelClient: harness.kernelClient,
                resolveProjectPath: () => "git:repo-project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            const memoryOnly = await tools.ctx_search.execute(
                { query: "anything", sources: ["memory"] },
                toolContext(),
            );
            expect(memoryOnly).toBe(
                "Error: Memory results may lag recent changes; the projector has not caught up.",
            );
            expect(searchSpy).not.toHaveBeenCalled();

            const mixed = await tools.ctx_search.execute({ query: "anything" }, toolContext());
            expect(mixed).toStartWith(
                "Memory: Memory results may lag recent changes; the projector has not caught up.",
            );
            expect(searchSpy).toHaveBeenCalledTimes(1);
            const options = searchSpy.mock.calls[0]?.[4] as { sources?: string[] };
            expect(options.sources).not.toContain("memory");
        } finally {
            searchSpy.mockRestore();
        }
    });

    it("answers unavailable without a daemon and never reads the local claim tables", async () => {
        const harness = kernelHarness();
        harness.transport.fileExists = false;
        const prepareSpy = spyOn(db, "prepare");
        try {
            const tools = createCtxSearchTools({
                db,
                kernelClient: harness.kernelClient,
                resolveProjectPath: () => "git:repo-project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            const result = await tools.ctx_search.execute(
                { query: "anything", sources: ["memory"] },
                toolContext(),
            );
            expect(result).toBe("Error: Memory is unavailable because the daemon is not running.");
            expect(result.toLowerCase()).not.toContain("retry");
            expect(harness.transport.calls).toHaveLength(0);
            const claimReads = prepareSpy.mock.calls
                .map((call) => String(call[0]))
                .filter((sql) => /\bclaim/i.test(sql));
            expect(claimReads).toEqual([]);
        } finally {
            prepareSpy.mockRestore();
        }
    });

    it("honors the requested limit for a multi-id query", async () => {
        const harness = kernelHarness();
        harness.kernel.seedDecision({
            object_id: OBJECT_A,
            decision_kind: "ARCHITECTURE",
            summary: "First.",
        });
        harness.kernel.seedDecision({
            object_id: OBJECT_B,
            decision_kind: "ARCHITECTURE",
            summary: "Second.",
        });
        const tools = createCtxSearchTools({
            db,
            kernelClient: harness.kernelClient,
            resolveProjectPath: () => "git:repo-project",
            memoryEnabled: true,
            embeddingEnabled: false,
            readMessages: () => [],
        });
        const result = await tools.ctx_search.execute(
            { query: `${OBJECT_A} ${OBJECT_B}`, limit: 1 },
            toolContext(),
        );
        expect(result).toContain("[1] [memory]");
        expect(result).not.toContain("[2] [memory]");
    });

    it("does not consult the daemon when the source restriction excludes memory", async () => {
        const harness = kernelHarness();
        harness.kernel.seedDecision({
            object_id: OBJECT_A,
            decision_kind: "ARCHITECTURE",
            summary: "Excluded.",
        });
        const searchSpy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
        try {
            const tools = createCtxSearchTools({
                db,
                kernelClient: harness.kernelClient,
                resolveProjectPath: () => "git:repo-project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            const result = await tools.ctx_search.execute(
                { query: OBJECT_A, sources: ["note"] },
                toolContext(),
            );
            expect(result).toContain("No results found");
            expect(harness.transport.calls).toHaveLength(0);
            expect(searchSpy).toHaveBeenCalledTimes(1);
        } finally {
            searchSpy.mockRestore();
        }
    });

    it("falls through to unifiedSearch when the object-id query has no matching memory", async () => {
        const harness = kernelHarness();
        const searchSpy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
        try {
            const tools = createCtxSearchTools({
                db,
                kernelClient: harness.kernelClient,
                resolveProjectPath: () => "git:repo-project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            const result = await tools.ctx_search.execute({ query: OBJECT_A }, toolContext());
            expect(result).toContain("No results found");
            expect(searchSpy).toHaveBeenCalledTimes(1);
        } finally {
            searchSpy.mockRestore();
        }
    });

    it("ranks text queries over memory summaries and merges them with local sources", async () => {
        const harness = kernelHarness();
        harness.kernel.seedDecision({
            object_id: OBJECT_A,
            decision_kind: "CONSTRAINTS",
            summary: "The cache must stay offline.",
        });
        harness.kernel.seedDecision({
            object_id: OBJECT_B,
            decision_kind: "NAMING",
            summary: "Handlers end in Handler.",
        });
        const searchSpy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([]);
        try {
            const tools = createCtxSearchTools({
                db,
                kernelClient: harness.kernelClient,
                resolveProjectPath: () => "git:repo-project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            const result = await tools.ctx_search.execute(
                { query: "offline cache" },
                toolContext(),
            );
            expect(result).toContain(`id=${OBJECT_A}`);
            expect(result).not.toContain(`id=${OBJECT_B}`);
        } finally {
            searchSpy.mockRestore();
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
                        publicClaimId: "mcm_1",
                        revisionLocator: `mcm_1/r1/${"0".repeat(64)}`,
                        category: "USER_DIRECTIVES",
                        matchType: "exact",
                    },
                ] as UnifiedSearchResult[],
        );
        try {
            const tools = createCtxSearchTools({
                db,
                kernelClient: kernelHarness().kernelClient,
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
        kernelClient: kernelHarness().kernelClient,
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

    it("keeps direct object-id lookup byte-identical between the tool and the structured helper", async () => {
        const harness = kernelHarness();
        harness.kernel.seedDecision({
            object_id: OBJECT_A,
            decision_kind: "ARCHITECTURE",
            summary: "Direct id hit for the structured helper.",
        });
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => {
            throw new Error("unifiedSearch must not run for object-id queries");
        });
        try {
            const sharedDeps = {
                ...deps(),
                kernelClient: harness.kernelClient,
                resolveProjectPath: () => "git:repo-project",
            };
            const tools = createCtxSearchTools(sharedDeps);
            const args = { query: OBJECT_A };
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
            expect(execution.text).toContain(`id=${OBJECT_A}`);
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
                publicClaimId: "mcm_5",
                revisionLocator: `mcm_5/r1/${"0".repeat(64)}`,
                category: "USER_DIRECTIVES",
                matchType: "exact",
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
            publicClaimId: `mcm_${index + 1}`,
            revisionLocator: `mcm_${index + 1}/r1/${"0".repeat(64)}`,
            category: "USER_DIRECTIVES",
            matchType: "exact",
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
            await expect(
                executeCtxSearch(deps(), { query: "boom" }, toolContext()),
            ).rejects.toThrow("search lane exploded");
        } finally {
            spy.mockRestore();
        }
    });
});
