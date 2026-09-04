import { afterEach, describe, expect, test } from "bun:test";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import { renderMemoryStateMarker, renderToolStateText } from "../../shared/kernel-client";
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
