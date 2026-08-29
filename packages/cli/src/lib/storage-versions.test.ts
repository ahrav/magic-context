/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    FORK_MIGRATION_VERSION_FLOOR,
    LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage";
import { createDirectTestDatabase } from "@magic-context/core/features/magic-context/test-database";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    checkStorageVersionFence,
    formatStorageVersions,
    readStorageVersions,
    STALE_BUILD_RESTART_INSTRUCTION,
} from "./storage-versions";

describe("storage versions probe", () => {
    it("reads the live upstream migration lane and binary fence from a fully migrated DB", () => {
        const db = createDirectTestDatabase().db;
        try {
            const versions = readStorageVersions(db);

            // A fully migrated DB sits exactly at the fence: the upstream-lane query
            // and the compile-time constant must agree, and the probe reports both.
            expect(versions.context_db_schema_version).toBe(LATEST_SUPPORTED_VERSION);
            expect(versions.plugin_supported_version).toBe(LATEST_SUPPORTED_VERSION);
            expect(formatStorageVersions(versions)).toBe(
                `Storage versions: context_db_schema_version=${LATEST_SUPPORTED_VERSION}, ` +
                    `plugin_supported_version=${LATEST_SUPPORTED_VERSION}`,
            );
        } finally {
            db.close();
        }
    });

    it("reports the legacy lane of an unsupported older database", () => {
        const db = new Database(":memory:");
        try {
            // A DB last touched by an older binary: the upstream lane stops at 50.
            db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
            db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(50);

            const versions = readStorageVersions(db);

            expect(versions.context_db_schema_version).toBe(50);
            expect(versions.plugin_supported_version).toBe(LATEST_SUPPORTED_VERSION);
            expect(formatStorageVersions(versions)).toBe(
                "Storage versions: context_db_schema_version=50, " +
                    `plugin_supported_version=${LATEST_SUPPORTED_VERSION}`,
            );
        } finally {
            db.close();
        }
    });

    it("ignores fork rows when reporting the upstream lane", () => {
        const db = createDirectTestDatabase().db;
        try {
            db.prepare(
                "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?), (?, ?, ?)",
            ).run(
                FORK_MIGRATION_VERSION_FLOOR,
                "fork migration 10000",
                0,
                FORK_MIGRATION_VERSION_FLOOR + 1,
                "fork migration 10001",
                0,
            );

            const versions = readStorageVersions(db);

            expect(versions.context_db_schema_version).toBe(LATEST_SUPPORTED_VERSION);
            expect(versions.plugin_supported_version).toBe(LATEST_SUPPORTED_VERSION);
        } finally {
            db.close();
        }
    });

    it("reports 0 for a DB without a migrations table", () => {
        const db = new Database(":memory:");
        try {
            const versions = readStorageVersions(db);
            expect(versions.context_db_schema_version).toBe(0);
            expect(versions.plugin_supported_version).toBe(LATEST_SUPPORTED_VERSION);
        } finally {
            db.close();
        }
    });
});

describe("checkStorageVersionFence", () => {
    it("alarms only when the database is newer than the build", () => {
        const result = checkStorageVersionFence({
            context_db_schema_version: 73,
            plugin_supported_version: 72,
        });

        expect(result.alarm).toBe(true);
        expect(result.message).toContain(STALE_BUILD_RESTART_INSTRUCTION);
    });

    it("alarms and gives reset guidance when the database is an older retired format", () => {
        const result = checkStorageVersionFence({
            context_db_schema_version: 71,
            plugin_supported_version: 72,
        });
        expect(result.alarm).toBe(true);
        expect(result.message).toContain("Retired-format alarm");
        expect(result.message).toContain("doctor reset-db");
    });
});
