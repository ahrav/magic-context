/// <reference types="bun-types" />

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    closeSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_COMPONENTS } from "@magic-context/core/features/magic-context/storage-current-schema";
import {
    inspectRpcServerDiscovery,
    LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage-db";
import { createDirectTestDatabase } from "@magic-context/core/features/magic-context/test-database";
import { rpcPortFilePath } from "@magic-context/core/shared/rpc-utils";
import { Database } from "@magic-context/core/shared/sqlite";

import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import { defaultSqliteExecutable, REPAIR_DB_EXIT, runRepairDb } from "./doctor-repair-db";

setDefaultTimeout(60_000);

const tempDirs: string[] = [];

class MockPrompts implements PromptIO {
    readonly messages: string[] = [];
    private readonly confirmations: boolean[];

    constructor(confirmations: boolean[] = []) {
        this.confirmations = [...confirmations];
    }

    readonly log = {
        info: (message: string) => this.messages.push(`info:${message}`),
        success: (message: string) => this.messages.push(`success:${message}`),
        warn: (message: string) => this.messages.push(`warn:${message}`),
        error: (message: string) => this.messages.push(`error:${message}`),
        message: (message: string) => this.messages.push(`message:${message}`),
        step: (message: string) => this.messages.push(`step:${message}`),
    };

    intro(message: string): void {
        this.messages.push(`intro:${message}`);
    }

    outro(message: string): void {
        this.messages.push(`outro:${message}`);
    }

    note(message: string, title?: string): void {
        this.messages.push(`note:${title ?? ""}:${message}`);
    }

    spinner(): PromptSpinner {
        return {
            start: () => {},
            stop: () => {},
            message: () => {},
        };
    }

    async confirm(message: string): Promise<boolean> {
        this.messages.push(`confirm:${message}`);
        return this.confirmations.shift() ?? false;
    }

    async text(): Promise<string> {
        throw new Error("unexpected text prompt");
    }

    async selectOne(_message: string, _options: SelectOption[]): Promise<string> {
        throw new Error("unexpected select prompt");
    }

    async selectMany(): Promise<string[]> {
        throw new Error("unexpected multiselect prompt");
    }

    async selectAutocomplete(): Promise<string> {
        throw new Error("unexpected autocomplete prompt");
    }
}

function tempStorage(): string {
    const root = mkdtempSync(join(tmpdir(), "mc-repair-db-"));
    tempDirs.push(root);
    return root;
}

function digest(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function seedCurrentDatabase(dbPath: string): void {
    const db = createDirectTestDatabase({ path: dbPath }).db;
    const insertTag = db.prepare(
        "INSERT INTO tags (session_id, type, status, byte_size, tag_number, harness) VALUES (?, 'message', 'active', ?, ?, 'opencode')",
    );
    const insertCompartment = db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, title, content, created_at, harness)
         VALUES ('session-main', ?, ?, ?, ?, ?, ?, 'opencode')`,
    );
    const insertNote = db.prepare(
        `INSERT INTO notes
            (type, status, content, session_id, created_at, updated_at, harness)
         VALUES ('session', 'active', ?, 'session-main', ?, ?, 'opencode')`,
    );
    const insertDreamRun = db.prepare(
        `INSERT INTO dream_runs
            (project_path, started_at, finished_at, holder_id, tasks_json)
         VALUES ('/project', ?, ?, 'test-holder', '[]')`,
    );
    db.transaction(() => {
        for (let index = 1; index <= 300; index++) {
            const content = `tag-${index}-${"t".repeat(700)}`;
            insertTag.run("session-main", Buffer.byteLength(content), index);
            db.prepare(
                "INSERT INTO source_contents (tag_id, session_id, content, created_at, harness) VALUES (?, 'session-main', ?, ?, 'opencode')",
            ).run(index, content, index);
        }
        for (let index = 1; index <= 23; index++) {
            insertCompartment.run(
                index,
                index,
                index,
                `compartment-${index}`,
                `knowledge-${index}-${"c".repeat(200)}`,
                index,
            );
        }
        for (let index = 1; index <= 4; index++) insertNote.run(`note-${index}`, index, index);
        for (let index = 1; index <= 3; index++) insertDreamRun.run(index, index);
    }).immediate();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode=DELETE");
    db.close();
}

function corruptLastTagLeaf(dbPath: string): void {
    // The fixture corrupts one leaf-page `tags` cell while preserving its header and cell pointer array.
    // Preserving the header and cell pointer array lets `.recover` walk the tree and salvage cells.
    // The fixture avoids three toolchain-dependent strategies:
    // `dbstat` requires `SQLITE_ENABLE_DBSTAT_VTAB`, which some SQLite builds omit.
    // Scanning row text can select different pages because SQLite builds pack cells differently.
    // Zeroing the whole page destroys its header.
    // Walking the documented format makes page selection deterministic.
    // Damaging only the cell area makes recovery deterministic.
    const db = new Database(dbPath, { readonly: true });
    const { page_size: pageSize } = db.prepare("PRAGMA page_size").get() as { page_size: number };
    const { rootpage } = db
        .prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'tags'")
        .get() as { rootpage: number };
    db.close();

    const fd = openSync(dbPath, "r+");
    try {
        const buffer = Buffer.alloc(pageSize);
        let pageno = rootpage;
        // Page 1 carries the 100-byte database header before its b-tree header.
        for (let depth = 0; depth < 32; depth++) {
            readSync(fd, buffer, 0, pageSize, (pageno - 1) * pageSize);
            const headerAt = pageno === 1 ? 100 : 0;
            const pageType = buffer[headerAt];
            if (pageType === 0x0d) break; // leaf table page
            if (pageType !== 0x05)
                throw new Error(`unexpected page type 0x${pageType.toString(16)}`);
            // Interior table page: the rightmost child pointer lives at header offset 8.
            pageno = buffer.readUInt32BE(headerAt + 8);
        }
        const headerAt = pageno === 1 ? 100 : 0;
        readSync(fd, buffer, 0, pageSize, (pageno - 1) * pageSize);
        if (buffer[headerAt] !== 0x0d) throw new Error("no tags leaf page found");
        // Header bytes 5–6 store the cell-content-area offset.
        // The cell-content area extends from its offset to the end of the page.
        const cellContentStart = buffer.readUInt16BE(headerAt + 5) || pageSize;
        const damage = Buffer.alloc(pageSize - cellContentStart, 0xff);
        writeSync(fd, damage, 0, damage.length, (pageno - 1) * pageSize + cellContentStart);
    } finally {
        closeSync(fd);
    }
}

function rowCount(db: Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function integrity(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
        return (
            db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>
        ).map((row) => row.integrity_check);
    } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
    } finally {
        db.close();
    }
}

// `runRepairDb` requires a sqlite3 shell whose `.recover` supports `sqlite_dbpage`.
// `.recover` requires `SQLITE_ENABLE_DBPAGE_VTAB` to read raw pages through `sqlite_dbpage`.
// The probe reports unavailable only when `.recover` is unavailable.
// The probe throws unless sqlite3 gives an unambiguous answer.
// Anything else throws; a skip must never hide a broken probe.
function probeRecoverCapability(sqliteExecutable: string): {
    available: boolean;
    reason: string;
} {
    const result = spawnSync(
        sqliteExecutable,
        [":memory:", "SELECT 1 FROM sqlite_dbpage LIMIT 1"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    if (result.error) {
        return { available: false, reason: `sqlite3 could not start (${result.error.message})` };
    }
    if (result.status === 0) return { available: true, reason: "sqlite_dbpage is available" };
    const stderr = String(result.stderr ?? "").trim();
    if (/no such table: sqlite_dbpage|no such module: sqlite_dbpage/i.test(stderr)) {
        return {
            available: false,
            reason: `this sqlite3 build lacks SQLITE_ENABLE_DBPAGE_VTAB (${stderr})`,
        };
    }
    throw new Error(
        `recover capability probe got an unrecognized answer from sqlite3 (exit ${String(result.status)}): ${stderr || "no stderr"}`,
    );
}

const salvageCapability = probeRecoverCapability(defaultSqliteExecutable());
const salvageIt = salvageCapability.available ? it : it.skip;
const salvageTestName =
    "backs up and salvages readable rows from a genuinely corrupted SQLite page";
const unsalvageableTestName =
    "reports an unsalvageable database distinctly and preserves every source sidecar";

afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("doctor repair-db", () => {
    if (!salvageCapability.available) {
        it(`salvage test skipped: ${salvageCapability.reason}`, () => {
            expect(salvageCapability.reason).toMatch(/SQLITE_ENABLE_DBPAGE_VTAB|could not start/);
        });
    }

    salvageIt(salvageTestName, async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedCurrentDatabase(dbPath);
        corruptLastTagLeaf(dbPath);
        expect(integrity(dbPath)).not.toEqual(["ok"]);
        const corruptDigest = digest(dbPath);
        const prompts = new MockPrompts();

        const code = await runRepairDb({
            dbPath,
            storageDir,
            prompts,
            deps: { now: () => new Date("2026-08-11T12:34:56.789Z") },
        });

        expect({ code, why: prompts.messages.filter((m) => m.startsWith("error:")) }).toEqual({
            code: REPAIR_DB_EXIT.salvaged,
            why: [],
        });
        expect(integrity(dbPath)).toEqual(["ok"]);
        const recovered = new Database(dbPath, { readonly: true });
        const recoveredTags = rowCount(recovered, "tags");
        expect(recoveredTags).toBeGreaterThan(0);
        expect(recoveredTags).toBeLessThan(300);
        expect(rowCount(recovered, "compartments")).toBe(23);
        expect(rowCount(recovered, "memories")).toBe(26);
        expect(rowCount(recovered, "notes")).toBe(4);
        expect(rowCount(recovered, "dream_runs")).toBe(3);
        const version = recovered
            .prepare(
                "SELECT MAX(version) AS version FROM schema_migrations WHERE version < 1000000",
            )
            .get() as { version: number };
        const applicationId = Object.values(
            recovered.prepare("PRAGMA application_id").get() as Record<string, unknown>,
        )[0];
        const userVersion = Object.values(
            recovered.prepare("PRAGMA user_version").get() as Record<string, unknown>,
        )[0];
        const directMarker = recovered
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mc_format_marker'",
            )
            .get();
        recovered.close();
        expect(version.version).toBe(LATEST_SUPPORTED_VERSION);
        expect({ applicationId, userVersion, directMarker }).toEqual({
            applicationId: 0,
            userVersion: 0,
            directMarker: null,
        });

        const files = readdirSync(storageDir);
        const backup = files.find((name) => name.startsWith("context.db.corrupt-backup-"));
        const original = files.find((name) => name.startsWith("context.db.corrupt-original-"));
        expect(backup).toBeDefined();
        expect(original).toBeDefined();
        expect(digest(join(storageDir, backup as string))).toBe(corruptDigest);
        expect(digest(join(storageDir, original as string))).toBe(corruptDigest);
        const output = prompts.messages.join("\n");
        expect(output).toContain(`Database: ${dbPath}`);
        expect(output).toContain("Attempting SQLite .recover");
        expect(output).toContain("Row counts BEFORE recovery");
        expect(output).toContain(
            `Schema migration: v${LATEST_SUPPORTED_VERSION} → v${LATEST_SUPPORTED_VERSION}`,
        );
        expect(output).toContain("Row counts AFTER recovery");
        expect(output).toContain("Salvage rates");
        for (const table of ["tags", "compartments", "memories", "notes", "dream_runs"]) {
            expect(output).toContain(`${table}=`);
        }
        expect(output).toContain("Backup:");
    });

    salvageIt(unsalvageableTestName, async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        writeFileSync(dbPath, Buffer.alloc(8192, 0x7f));
        writeFileSync(`${dbPath}-wal`, "synthetic corrupt wal");
        writeFileSync(`${dbPath}-shm`, "synthetic corrupt shm");
        const sourceDigests = Object.fromEntries(
            [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((path) => [path, digest(path)]),
        );
        const prompts = new MockPrompts([false]);

        const code = await runRepairDb({
            dbPath,
            storageDir,
            prompts,
            deps: { now: () => new Date("2026-08-11T12:35:56.789Z") },
        });

        expect(code).toBe(REPAIR_DB_EXIT.unsalvageable);
        for (const [path, hash] of Object.entries(sourceDigests)) expect(digest(path)).toBe(hash);
        const backups = readdirSync(storageDir).filter((name) =>
            name.startsWith("context.db.corrupt-backup-"),
        );
        expect(backups).toHaveLength(3);
        expect(backups.some((path) => path.endsWith("-wal"))).toBe(true);
        expect(backups.some((path) => path.endsWith("-shm"))).toBe(true);
        const output = prompts.messages.join("\n");
        expect(output).toContain("SQLite salvage was unsuccessful");
        expect(output).toContain("Row counts BEFORE recovery");
        expect(output).toContain("Row counts AFTER recovery");
        expect(output).toContain("Reset declined");
        expect(output).toContain(`Database remains unchanged: ${dbPath}`);
    });

    it("refuses an unsupported direct-format family and offers reset only", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        const direct = createDirectTestDatabase({
            path: dbPath,
            components: [CURRENT_SCHEMA_COMPONENTS[0]],
        });
        direct.db.close();
        const original = readFileSync(dbPath);
        const prompts = new MockPrompts([true]);

        const code = await runRepairDb({
            dbPath,
            storageDir,
            prompts,
            deps: { inspectHolders: () => ({ safe: true, blockers: [] }) },
        });

        expect(code).toBe(REPAIR_DB_EXIT.refused);
        expect(readFileSync(dbPath)).toEqual(original);
        expect(prompts.messages.join("\n")).toContain("only supported action is an explicit reset");
        expect(prompts.messages.join("\n")).toContain("doctor reset-db");
        expect(prompts.messages.join("\n")).not.toContain("Attempting SQLite .recover");
        expect(prompts.messages.join("\n")).not.toContain("confirm:");
        expect(readdirSync(storageDir).some((name) => name.includes("corrupt-backup"))).toBe(false);
    });

    it("refuses repair while a reset marker is pending", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        writeFileSync(dbPath, "database");
        writeFileSync(`${dbPath}.mc-reset`, "pending");
        const original = readFileSync(dbPath);
        const prompts = new MockPrompts();

        const code = await runRepairDb({ dbPath, storageDir, prompts });

        expect(code).toBe(REPAIR_DB_EXIT.refused);
        expect(readFileSync(dbPath)).toEqual(original);
        expect(prompts.messages.join("\n")).toContain("reset is pending");
        expect(prompts.messages.join("\n")).not.toContain("Attempting SQLite .recover");
    });

    it("does not offer destructive reset when the .recover shell could not start", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        writeFileSync(dbPath, Buffer.alloc(8192, 0x55));
        const originalDigest = digest(dbPath);
        const prompts = new MockPrompts([true]);

        const code = await runRepairDb({
            dbPath,
            storageDir,
            prompts,
            deps: {
                now: () => new Date("2026-08-11T12:36:56.789Z"),
                sqliteExecutable: join(storageDir, "missing-sqlite3"),
            },
        });

        expect(code).toBe(REPAIR_DB_EXIT.failed);
        expect(digest(dbPath)).toBe(originalDigest);
        const output = prompts.messages.join("\n");
        expect(output).toContain("SQLite .recover could not be started");
        expect(output).toContain("Reset was not offered because salvage did not run");
        expect(output).not.toContain("confirm:");
    });

    it("does not offer destructive reset when sqlite3 lacks the capability .recover needs", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        // A database that `.recover` can salvage must not be reported as unsalvageable when the shell lacks the required feature.
        seedCurrentDatabase(dbPath);
        const originalDigest = digest(dbPath);
        // The fake shell fails when `.recover` queries `sqlite_dbpage`, simulating sqlite3 without `SQLITE_ENABLE_DBPAGE_VTAB`.
        // The fake shell invokes no real sqlite3.
        const stubSqlite = join(storageDir, "sqlite3-without-dbpage");
        writeFileSync(
            stubSqlite,
            "#!/bin/sh\necho 'sql error: no such table: sqlite_dbpage (1)' >&2\nexit 1\n",
            { mode: 0o755 },
        );
        // `MockPrompts([true])` accepts a destructive-reset confirmation.
        const prompts = new MockPrompts([true]);

        const code = await runRepairDb({
            dbPath,
            storageDir,
            prompts,
            deps: {
                now: () => new Date("2026-08-12T09:00:00.000Z"),
                sqliteExecutable: stubSqlite,
            },
        });

        expect({ code, why: prompts.messages.filter((m) => m.startsWith("error:")) }).toEqual({
            code: REPAIR_DB_EXIT.failed,
            why: [expect.stringContaining("no such table: sqlite_dbpage")],
        });
        expect(code).not.toBe(REPAIR_DB_EXIT.salvaged);
        expect(code).not.toBe(REPAIR_DB_EXIT.unsalvageable);
        const output = prompts.messages.join("\n");
        expect(output).not.toContain("confirm:");
        expect(output).toContain("Reset was not offered because salvage did not run");
        expect(output).toContain("SQLITE_ENABLE_DBPAGE_VTAB");
        expect(output).toContain("Database remains unchanged");
        expect(output).toContain("Backup base:");
        expect(digest(dbPath)).toBe(originalDigest);
    });

    it("refuses a live RPC holder without changing any file", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        writeFileSync(dbPath, "do not touch");
        writeFileSync(`${dbPath}-wal`, "wal do not touch");
        writeFileSync(`${dbPath}-shm`, "shm do not touch");
        const rpcPath = rpcPortFilePath(storageDir, "/project", process.pid, "repair-test");
        mkdirSync(join(rpcPath, ".."), { recursive: true });
        writeFileSync(
            rpcPath,
            JSON.stringify({
                port: 43123,
                pid: process.pid,
                started_at: 0,
                instance_id: "repair-test",
            }),
        );
        const beforeFiles = readdirSync(storageDir, { recursive: true }).map(String).sort();
        const snapshots = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, rpcPath].map((path) => ({
            path,
            digest: digest(path),
            mtimeMs: statSync(path).mtimeMs,
        }));
        const prompts = new MockPrompts();
        expect(inspectRpcServerDiscovery(storageDir)).toMatchObject({
            state: "live",
            serverPids: [process.pid],
        });

        const code = await runRepairDb({ dbPath, storageDir, prompts });

        expect(code).toBe(REPAIR_DB_EXIT.refused);
        expect(readdirSync(storageDir, { recursive: true }).map(String).sort()).toEqual(
            beforeFiles,
        );
        for (const snapshot of snapshots) {
            expect(digest(snapshot.path)).toBe(snapshot.digest);
            expect(statSync(snapshot.path).mtimeMs).toBe(snapshot.mtimeMs);
        }
        const output = prompts.messages.join("\n");
        expect(output).toContain(`Refusing to repair the live database: ${dbPath}`);
        expect(output).toContain(`OpenCode server (PID ${process.pid})`);
        expect(output).toContain("Backup: not created");
    });
});
