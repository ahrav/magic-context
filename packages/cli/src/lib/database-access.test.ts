import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_SUPPORTED_VERSION } from "../../../plugin/src/features/magic-context/storage-db";
import { createDirectTestDatabase } from "../../../plugin/src/features/magic-context/test-database";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
    CLI_SCHEMA_FLOOR_VERSION,
    openExistingContextDatabase,
    openExistingContextDatabaseForMutation,
} from "./database-access";

const tempDirs: string[] = [];

function tempDir(): string {
    const path = mkdtempSync(join(tmpdir(), "mc-cli-db-access-"));
    tempDirs.push(path);
    return path;
}

function createVersionedDatabase(path: string, version: number): void {
    const db = new Database(path);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    db.close();
}

afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("CLI context database access", () => {
    it("rejects a database newer than the shared supported schema", () => {
        const path = join(tempDir(), "context.db");
        // Derive from the live fence so a routine schema bump cannot stale this fixture.
        const newerVersion = LATEST_SUPPORTED_VERSION + 1;
        createVersionedDatabase(path, newerVersion);

        expect(() => openExistingContextDatabase(path, { readonly: false })).toThrow(
            "database is not the exact supported direct format",
        );
        expect(() => openExistingContextDatabase(path, { readonly: true })).toThrow(
            `database schema v${newerVersion} is newer than this CLI supports (max v${LATEST_SUPPORTED_VERSION})`,
        );
    });

    it("does not create a database when context.db is missing", () => {
        const path = join(tempDir(), "context.db");

        expect(openExistingContextDatabase(path, { readonly: false })).toBeNull();
        expect(existsSync(path)).toBe(false);
    });

    it("refuses mutation of a versioned database without the direct marker unchanged", () => {
        const path = join(tempDir(), "context.db");
        createVersionedDatabase(path, CLI_SCHEMA_FLOOR_VERSION - 1);
        const before = readFileSync(path);

        expect(() => openExistingContextDatabaseForMutation(path)).toThrow(
            "database is not the exact supported direct format",
        );
        expect(readFileSync(path)).toEqual(before);
    });

    it("opens the current supported schema normally for reads and mutation writes", () => {
        const path = join(tempDir(), "context.db");
        createDirectTestDatabase({ path }).db.close();

        const db = openExistingContextDatabase(path, { readonly: false });
        expect(db).not.toBeNull();
        expect(Object.values(db?.prepare("PRAGMA foreign_keys").get() ?? {})[0]).toBe(1);
        expect(Object.values(db?.prepare("PRAGMA busy_timeout").get() ?? {})[0]).toBe(5_000);
        db?.exec("CREATE TABLE migration_probe (id INTEGER PRIMARY KEY)");
        db?.close();

        const readonlyDb = openExistingContextDatabase(path, { readonly: true });
        const table = readonlyDb
            ?.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_probe'",
            )
            .get() as { name?: string } | undefined;
        expect(table?.name).toBe("migration_probe");
        readonlyDb?.close();
    });
});
