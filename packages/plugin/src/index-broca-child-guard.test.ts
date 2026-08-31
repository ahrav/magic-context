import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as storageDb from "./features/magic-context/storage-db";
import * as bootQuiet from "./plugin/boot-quiet";
import * as dreamTimer from "./plugin/dream-timer";
import * as rpcServer from "./shared/rpc-server";

// MAGIC_CONTEXT_BROCA_CHILD="1" returns before config migration.
const MIGRATION_SENTINEL = "MIGRATION-SIDE-EFFECT";
const migrationSpy = mock((): string[] => {
    throw new Error(MIGRATION_SENTINEL);
});
mock.module("./config/migrate-config-location", () => ({
    migrateMagicContextConfigLocations: migrationSpy,
}));

let importCounter = 0;

async function freshPluginServer() {
    const module = (await import(`./index.ts?broca-guard=${importCounter++}`)) as {
        default: { id: string; server: (ctx: unknown) => Promise<unknown> };
    };
    return module.default.server;
}

function minimalCtx() {
    return { directory: "/tmp/broca-guard-test", client: {} };
}

describe("Broca-child guard in the plugin entry", () => {
    let openDatabaseSpy: ReturnType<typeof spyOn>;
    let bootQuietSpy: ReturnType<typeof spyOn>;
    let dreamTimerSpy: ReturnType<typeof spyOn>;
    let rpcStartSpy: ReturnType<typeof spyOn>;
    let previousGuard: string | undefined;

    beforeEach(() => {
        previousGuard = process.env.MAGIC_CONTEXT_BROCA_CHILD;
        migrationSpy.mockClear();
        openDatabaseSpy = spyOn(storageDb, "openDatabase");
        bootQuietSpy = spyOn(bootQuiet, "beginBootQuietPeriod");
        dreamTimerSpy = spyOn(dreamTimer, "startDreamScheduleTimer");
        rpcStartSpy = spyOn(rpcServer.MagicContextRpcServer.prototype, "start");
    });

    afterEach(() => {
        if (previousGuard === undefined) delete process.env.MAGIC_CONTEXT_BROCA_CHILD;
        else process.env.MAGIC_CONTEXT_BROCA_CHILD = previousGuard;
        openDatabaseSpy.mockRestore();
        bootQuietSpy.mockRestore();
        dreamTimerSpy.mockRestore();
        rpcStartSpy.mockRestore();
    });

    test("MAGIC_CONTEXT_BROCA_CHILD=1 returns before config migration, database, hooks, timers, and RPC", async () => {
        process.env.MAGIC_CONTEXT_BROCA_CHILD = "1";
        const server = await freshPluginServer();

        const timerSpy = spyOn(globalThis, "setTimeout");
        try {
            const hooks = await server(minimalCtx());
            expect(hooks).toEqual({});
            expect(migrationSpy).not.toHaveBeenCalled();
            expect(openDatabaseSpy).not.toHaveBeenCalled();
            expect(bootQuietSpy).not.toHaveBeenCalled();
            expect(dreamTimerSpy).not.toHaveBeenCalled();
            expect(rpcStartSpy).not.toHaveBeenCalled();
            expect(timerSpy).not.toHaveBeenCalled();
        } finally {
            timerSpy.mockRestore();
        }
    });

    test('guard values other than "1" do not trip the guard', async () => {
        for (const value of ["0", "true", ""]) {
            process.env.MAGIC_CONTEXT_BROCA_CHILD = value;
            migrationSpy.mockClear();
            const server = await freshPluginServer();
            await expect(server(minimalCtx())).rejects.toThrow(MIGRATION_SENTINEL);
            expect(migrationSpy).toHaveBeenCalledTimes(1);
        }
    });

    test("without the guard, ordinary startup proceeds into registration", async () => {
        delete process.env.MAGIC_CONTEXT_BROCA_CHILD;
        const server = await freshPluginServer();

        // Unguarded startup reaches migration rather than returning at the child guard.
        await expect(server(minimalCtx())).rejects.toThrow(MIGRATION_SENTINEL);
        expect(bootQuietSpy).toHaveBeenCalledTimes(1);
        expect(migrationSpy).toHaveBeenCalledTimes(1);
    });
});
