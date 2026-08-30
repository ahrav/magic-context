/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
    __resetChildSpawnFenceProbeForTests,
    type ChildSpawnFenceFailure,
} from "../../features/magic-context/schema-fence-probe";
import { LATEST_SUPPORTED_VERSION } from "../../features/magic-context/storage-db";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import {
    __resetNotificationStateForTests,
    drainNotifications,
} from "../../shared/rpc-notifications";
import { Database } from "../../shared/sqlite";
import {
    childSessionMessagesFetcher,
    createChildSessionWithFence,
    SCHEMA_PROBE_FAILURE_NOTICE,
    STALE_PLUGIN_RESTART_NOTICE,
} from "./child-session-spawn";

const dbs: Database[] = [];

function staleDatabase(): Database {
    const db = createDirectTestDatabase().db;
    db.prepare(
        "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)",
    ).run(LATEST_SUPPORTED_VERSION + 1, "future schema", Date.now());
    dbs.push(db);
    return db;
}

afterEach(() => {
    __resetChildSpawnFenceProbeForTests();
    __resetNotificationStateForTests();
    for (const db of dbs.splice(0)) db.close();
});

describe("createChildSessionWithFence", () => {
    it("does not attempt session.create when the live schema is newer", async () => {
        const create = mock(async () => ({ id: "child" }));
        const client = { session: { create } } as never;
        const latchedFailures: ChildSpawnFenceFailure[] = [];
        const args = {
            client,
            db: staleDatabase(),
            parentSessionId: "ses_parent",
            title: "magic-context-sidekick",
            directory: "/project",
            onFenceLatched: (failure: ChildSpawnFenceFailure) => latchedFailures.push(failure),
        };

        await createChildSessionWithFence(args);
        await createChildSessionWithFence(args);

        // Removing the fence call makes this mock run twice, so the spawn guard
        // is observed directly rather than inferred from a matching return value.
        expect(create).not.toHaveBeenCalled();
        expect(latchedFailures).toHaveLength(1);
        expect(latchedFailures[0]).toMatchObject({
            persistedVersion: LATEST_SUPPORTED_VERSION + 1,
            supportedVersion: LATEST_SUPPORTED_VERSION,
            consecutiveFailures: 2,
        });
    });

    it("refuses an unreadable probe and surfaces the doctor recovery message", async () => {
        const db = new Database(":memory:");
        db.close();
        const create = mock(async () => ({ id: "child" }));
        const prompt = mock(async () => undefined);
        const client = { session: { create, prompt } } as never;
        const args = {
            client,
            db,
            parentSessionId: "ses_parent",
            title: "magic-context-sidekick",
            directory: "/project",
        };

        await createChildSessionWithFence(args);
        await createChildSessionWithFence(args);

        expect(create).not.toHaveBeenCalled();
        expect(drainNotifications(0, "ses_parent")).toContainEqual(
            expect.objectContaining({
                type: "toast",
                payload: expect.objectContaining({ message: SCHEMA_PROBE_FAILURE_NOTICE }),
            }),
        );
        expect(prompt).toHaveBeenCalledTimes(1);
    });

    it("surfaces the latched failure through the TUI toast and parent warning paths", async () => {
        const db = staleDatabase();
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses_parent");
        const create = mock(async () => ({ id: "child" }));
        const prompt = mock(async () => undefined);
        const client = { session: { create, prompt } } as never;
        const args = {
            client,
            db,
            parentSessionId: "ses_parent",
            title: "magic-context-sidekick",
            directory: "/project",
        };

        await createChildSessionWithFence(args);
        await createChildSessionWithFence(args);

        const notifications = drainNotifications(0, "ses_parent");
        expect(notifications).toContainEqual(
            expect.objectContaining({
                type: "toast",
                payload: expect.objectContaining({
                    message: STALE_PLUGIN_RESTART_NOTICE,
                    variant: "error",
                }),
            }),
        );
        expect(notifications).toContainEqual(
            expect.objectContaining({ type: "action", payload: { action: "refresh-sidebar" } }),
        );
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(
            db
                .prepare("SELECT last_transform_error FROM session_meta WHERE session_id = ?")
                .get("ses_parent"),
        ).toEqual({ last_transform_error: STALE_PLUGIN_RESTART_NOTICE });
    });
});

describe("childSessionMessagesFetcher", () => {
    it("reads the child session messages with the bound id, directory, and limit", async () => {
        const messages = mock(async (input: unknown) => [{ info: { role: "assistant" } }]);
        const fetcher = childSessionMessagesFetcher(
            { session: { messages } } as never,
            "ses_child",
            "/work/dir",
            50,
        );
        const output = await fetcher();
        expect(messages).toHaveBeenCalledTimes(1);
        expect(messages.mock.calls[0]?.[0]).toEqual({
            path: { id: "ses_child" },
            query: { directory: "/work/dir", limit: 50 },
        });
        expect(output).toEqual([{ info: { role: "assistant" } }]);
    });

    it("unwraps a data-envelope response and falls back to an empty array", async () => {
        const enveloped = childSessionMessagesFetcher(
            { session: { messages: async () => ({ data: [{ id: 1 }] }) } } as never,
            "ses_child",
            undefined,
            20,
        );
        expect(await enveloped()).toEqual([{ id: 1 }]);

        // preferResponseOnMissingData keeps the bare wrapper when `data` is null,
        // matching every prompt-run call site this helper replaced.
        const bareWrapper = childSessionMessagesFetcher(
            { session: { messages: async () => ({ data: null }) } } as never,
            "ses_child",
            undefined,
            20,
        );
        expect(await bareWrapper()).toEqual({ data: null } as never);

        const missing = childSessionMessagesFetcher(
            { session: { messages: async () => null } } as never,
            "ses_child",
            undefined,
            20,
        );
        expect(await missing()).toEqual([]);
    });
});
