import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function dirIdentity(directory: string): string {
    return `dir:${createHash("md5").update(realpathSync.native(directory), "utf8").digest("hex").slice(0, 12)}`;
}

test("export-project-identities excludes an opted-in home identity from registry seeds", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-project-export-"));
    const home = mkdtempSync(join(tmpdir(), "mc-project-export-home-"));
    const other = mkdtempSync(join(tmpdir(), "mc-project-export-other-"));
    const contextDbPath = join(root, "context.db");
    const openCodeDbPath = join(root, "opencode.db");

    try {
        const homeIdentity = dirIdentity(home);
        const otherIdentity = dirIdentity(other);
        const contextDb = new Database(contextDbPath);
        contextDb.exec(`
            CREATE TABLE session_projects (session_id TEXT, project_path TEXT);
            CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, canonical_identity TEXT NOT NULL UNIQUE);
            CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id));
        `);
        contextDb
            .prepare("INSERT INTO session_projects (session_id, project_path) VALUES (?, ?)")
            .run("home-session", homeIdentity);
        contextDb
            .prepare("INSERT INTO session_projects (session_id, project_path) VALUES (?, ?)")
            .run("other-session", otherIdentity);
        const insertProject = contextDb.prepare(
            "INSERT INTO projects (canonical_identity) VALUES (?) RETURNING id",
        );
        const insertClaim = contextDb.prepare("INSERT INTO claims (project_id) VALUES (?)");
        for (const identity of [homeIdentity, otherIdentity]) {
            const { id } = insertProject.get(identity) as { id: number };
            insertClaim.run(id);
        }
        contextDb.close();

        const openCodeDb = new Database(openCodeDbPath);
        openCodeDb.exec("CREATE TABLE session (id TEXT, directory TEXT)");
        openCodeDb.prepare("INSERT INTO session (id, directory) VALUES (?, ?)").run("home-session", home);
        openCodeDb.prepare("INSERT INTO session (id, directory) VALUES (?, ?)").run("other-session", other);
        openCodeDb.close();

        const script = join(import.meta.dir, "export-project-identities.ts");
        const output = execFileSync(process.execPath, [script], {
            encoding: "utf8",
            env: {
                ...process.env,
                HOME: home,
                MAGIC_CONTEXT_DB: contextDbPath,
                OPENCODE_DB: openCodeDbPath,
            },
        });
        const records = output
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { identity: string; roots: string[] });

        expect(records).toEqual([
            expect.objectContaining({ identity: otherIdentity, roots: [other] }),
        ]);
        expect(records.some((record) => record.identity === homeIdentity)).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
        rmSync(other, { recursive: true, force: true });
    }
});
