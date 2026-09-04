import { afterEach, describe, expect, test } from "bun:test";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import {
    type ReadRow,
    renderMemoryStateMarker,
    renderToolStateText,
} from "../../shared/kernel-client";
import {
    MEMORY_STATE_TABLE,
    stubKernelClient,
} from "../../shared/kernel-client-testing/state-table";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxMemoryTools } from "../../tools/ctx-memory/tools";
import { executeCtxSearch } from "../../tools/ctx-search/tools";
import { prepareCompartmentInjection } from "./inject-compartments";

const SESSION = "ses-state-table";
const PROJECT = "git:state-table";

/**
 * Every member of the state vocabulary drives the injector and both tools. The
 * injector shows the marker line; a tool shows the tool sentence for every
 * non-available state and a plain result for `available`.
 */
describe("memory state table over the OpenCode surfaces", () => {
    const databases: Database[] = [];
    afterEach(() => {
        for (const db of databases.splice(0)) closeQuietly(db);
    });

    function makeDb(): Database {
        const db = createDirectTestDatabase().db;
        getOrCreateSessionMeta(db, SESSION);
        databases.push(db);
        return db;
    }

    test.each(MEMORY_STATE_TABLE)("injector renders the marker for %s", (_key, state) => {
        const db = makeDb();
        const prepared = prepareCompartmentInjection({
            db,
            sessionId: SESSION,
            messages: [],
            isCacheBusting: true,
            memory: { state, rows: [], knownAsOf: null },
            projectPath: PROJECT,
        });
        expect(prepared?.block ?? "").toContain(renderMemoryStateMarker(state, 0));
    });

    const row: ReadRow = {
        object: {
            object_id: "mem_state_table_row",
            object_kind: "decision",
            domain_id: "memory",
            source_kind: "assistant",
            source_id: "ctx_memory",
            source_revision: 1,
            created_commit_seq: 1,
            invalidated_commit_seq: null,
            superseded_by: null,
            sensitivity: "normal",
        },
        visibility: "labeled",
        labeled: true,
        scope_id: "project:state-table",
        token: { object_id: "mem_state_table_row", known_as_of: 1 },
        decision: {
            decision_kind: "ARCHITECTURE",
            payload: { summary: "Rows render under their category.", rationale: "" },
        },
    };

    test("an available snapshot with rows renders the rows and no marker line", () => {
        const db = makeDb();
        const prepared = prepareCompartmentInjection({
            db,
            sessionId: SESSION,
            messages: [],
            isCacheBusting: true,
            memory: { state: { kind: "available" }, rows: [row], knownAsOf: 1 },
            projectPath: PROJECT,
        });
        const block = prepared?.block ?? "";
        expect(block).toContain("<ARCHITECTURE>");
        expect(block).toContain("mem_state_table_row [labeled]: Rows render under their category.");
        expect(renderMemoryStateMarker({ kind: "available" }, 1)).toBe("");
        expect(block).not.toContain(renderMemoryStateMarker({ kind: "available" }, 0));
    });

    test("a stale snapshot renders the marker alone even when rows are attached", () => {
        // The route answers a lagging gated read with the state alone, so the
        // client never carries rows for `stale`; a renderer handed rows anyway
        // must still show only the marker.
        const db = makeDb();
        const state = {
            kind: "stale",
            lag_positions: 7,
            oldest_unconsumed_age_ms: 90_000,
        } as const;
        const prepared = prepareCompartmentInjection({
            db,
            sessionId: SESSION,
            messages: [],
            isCacheBusting: true,
            memory: { state, rows: [row], knownAsOf: 1 },
            projectPath: PROJECT,
        });
        const block = prepared?.block ?? "";
        const marker = renderMemoryStateMarker(state, 0);
        expect(marker.length).toBeGreaterThan(0);
        expect(block).toContain(marker);
        expect(block).not.toContain("mem_state_table_row");
    });

    test.each(MEMORY_STATE_TABLE)("ctx_memory list answers %s", async (_key, state) => {
        const tool = createCtxMemoryTools({
            kernelClient: () => stubKernelClient(state),
            resolveProjectPath: () => PROJECT,
            allowedActions: ["list"],
        }).ctx_memory;
        const text = (await tool.execute(
            { action: "list" } as never,
            {
                sessionID: SESSION,
                directory: "/tmp/state-table",
                callID: "c1",
                agent: "primary",
            } as never,
        )) as string;
        if (state.kind === "available") {
            expect(JSON.parse(text)).toMatchObject({ action: "list", memories: [] });
        } else {
            expect(text).toBe(`Error: ${renderToolStateText(state)}`);
        }
    });

    test.each(MEMORY_STATE_TABLE)("ctx_search memory source answers %s", async (_key, state) => {
        const db = makeDb();
        const execution = await executeCtxSearch(
            {
                db,
                kernelClient: () => stubKernelClient(state),
                resolveProjectPath: () => PROJECT,
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            },
            { query: "anything at all", sources: ["memory"] },
            { sessionID: SESSION, directory: "/tmp/state-table" },
        );
        if (state.kind === "available") {
            expect(execution.status).toBe("complete");
        } else {
            expect(execution).toEqual({
                status: "invalid",
                text: `Error: ${renderToolStateText(state)}`,
            });
        }
    });
});
