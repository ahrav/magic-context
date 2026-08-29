/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { FORK_MIGRATION_VERSION_FLOOR } from "./migrations";
import {
    __resetChildSpawnFenceProbeForTests,
    getChildSpawnFenceFailure,
    probeChildSpawnFence,
    STALE_CHILD_SPAWN_FAILURE,
} from "./schema-fence-probe";
import { LATEST_SUPPORTED_VERSION } from "./storage-db";
import { createDirectTestDatabase } from "./test-database";

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
    for (const db of dbs.splice(0)) db.close();
});

describe("child spawn schema-fence probe", () => {
    it("skips stale child spawns and latches after two consecutive probes", () => {
        const db = staleDatabase();

        const first = probeChildSpawnFence(db);
        const second = probeChildSpawnFence(db);

        expect(first).toMatchObject({
            allowSpawn: false,
            shouldSurface: false,
            failure: {
                failureClass: STALE_CHILD_SPAWN_FAILURE,
                consecutiveFailures: 1,
                totalFailures: 1,
                latched: false,
            },
        });
        expect(second).toMatchObject({
            allowSpawn: false,
            shouldSurface: true,
            failure: {
                failureClass: STALE_CHILD_SPAWN_FAILURE,
                persistedVersion: LATEST_SUPPORTED_VERSION + 1,
                supportedVersion: LATEST_SUPPORTED_VERSION,
                consecutiveFailures: 2,
                totalFailures: 2,
                latched: true,
            },
        });
        expect(getChildSpawnFenceFailure()).toMatchObject({
            failureClass: STALE_CHILD_SPAWN_FAILURE,
            consecutiveFailures: 2,
            totalFailures: 2,
            latched: true,
        });
    });

    it("refuses a child spawn when the live schema probe cannot be read", () => {
        const db = new Database(":memory:");
        db.close();

        const verdict = probeChildSpawnFence(db);

        expect(verdict).toMatchObject({
            allowSpawn: false,
            shouldSurface: false,
            failure: {
                failureClass: STALE_CHILD_SPAWN_FAILURE,
                reason: "read_error",
                supportedVersion: LATEST_SUPPORTED_VERSION,
            },
        });
    });

    it("ignores downstream rows when probing the current direct-format fence", () => {
        const db = createDirectTestDatabase().db;
        db.prepare(
            "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)",
        ).run(FORK_MIGRATION_VERSION_FLOOR, "fork row", Date.now());
        dbs.push(db);

        expect(probeChildSpawnFence(db)).toEqual({ allowSpawn: true });
    });

    it("surfaces a latched stale-build failure only once", () => {
        const db = staleDatabase();

        probeChildSpawnFence(db);
        const latched = probeChildSpawnFence(db);
        const repeated = probeChildSpawnFence(db);

        expect(latched).toMatchObject({ allowSpawn: false, shouldSurface: true });
        expect(repeated).toMatchObject({ allowSpawn: false, shouldSurface: false });
    });
});
