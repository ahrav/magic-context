import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectTestDatabase } from "@magic-context/core/features/magic-context/test-database";
import { Database } from "@magic-context/core/shared/sqlite";
import { CLI_SCHEMA_FLOOR_VERSION } from "../lib/database-access";
import { runMergeIdentityCli } from "./doctor-merge-identity";

const tempDirs: string[] = [];

function tempDir(): string {
    const path = mkdtempSync(join(tmpdir(), "mc-cli-merge-identity-"));
    tempDirs.push(path);
    return path;
}

function createVersionedDatabase(path: string, version: number): void {
    const db = new Database(path);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    db.close();
}

function createCurrentDatabase(path: string): void {
    createDirectTestDatabase({ path }).db.close();
}

function fileHash(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("doctor merge-identity schema guard", () => {
    it("refuses a database one fence below the checkout without changing its bytes", () => {
        const path = join(tempDir(), "context.db");
        createVersionedDatabase(path, CLI_SCHEMA_FLOOR_VERSION - 1);
        const before = fileHash(path);

        expect(() =>
            runMergeIdentityCli([
                "--from",
                "dir:source",
                "--to",
                "dir:target",
                "--db",
                path,
                "--yes",
            ]),
        ).toThrow("database is not the exact supported direct format");
        expect(() =>
            runMergeIdentityCli([
                "--from",
                "dir:source",
                "--to",
                "dir:target",
                "--db",
                path,
                "--yes",
            ]),
        ).toThrow("doctor reset-db");
        expect(fileHash(path)).toBe(before);
    });

    it("works against the current checkout schema without running migrations", () => {
        const path = join(tempDir(), "context.db");
        createCurrentDatabase(path);

        expect(
            runMergeIdentityCli([
                "--from",
                "dir:source",
                "--to",
                "dir:target",
                "--db",
                path,
                "--yes",
            ]),
        ).toBe(0);

        const db = new Database(path);
        const version = db
            .prepare("SELECT MAX(version) AS version FROM schema_migrations")
            .get() as { version: number };
        const target = db
            .prepare("SELECT project_path FROM project_state WHERE project_path = ?")
            .get("dir:target");
        db.close();
        expect(version.version).toBe(CLI_SCHEMA_FLOOR_VERSION);
        expect(target).toBeDefined();
    }, 30_000);
});
