import { afterEach, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CURRENT_SCHEMA_COMPONENTS } from "@magic-context/core/features/magic-context/storage-current-schema";
import {
    buildDatabaseResetMarker,
    DATABASE_FAMILY_MOVE_ORDER,
    databaseResetMarkerPath,
    writeDatabaseResetMarker,
} from "@magic-context/core/features/magic-context/storage-format-epoch";
import { createDirectTestDatabase } from "@magic-context/core/features/magic-context/test-database";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    type DirectDatabaseFamilyState,
    inspectDirectDatabaseFamilyState,
} from "../lib/database-access";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import { RESET_DB_EXIT, runResetDb } from "./doctor-reset-db";

const tempDirs: string[] = [];

class MockPrompts implements PromptIO {
    readonly messages: string[] = [];
    private readonly confirmations: Array<boolean | (() => boolean)>;

    constructor(confirmations: Array<boolean | (() => boolean)> = []) {
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
        return { start: () => {}, stop: () => {}, message: () => {} };
    }

    async confirm(message: string): Promise<boolean> {
        this.messages.push(`confirm:${message}`);
        const answer = this.confirmations.shift() ?? false;
        return typeof answer === "function" ? answer() : answer;
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
    const path = mkdtempSync(join(tmpdir(), "mc-reset-db-"));
    tempDirs.push(path);
    return path;
}

function seedUnsupportedDirect(dbPath: string): string {
    const { db, marker } = createDirectTestDatabase({
        path: dbPath,
        components: [CURRENT_SCHEMA_COMPONENTS[0]],
        nowMs: 42,
    });
    db.close();
    return marker.databaseIncarnationId;
}

function seedFullCorruptFamily(dbPath: string): void {
    writeFileSync(dbPath, Buffer.alloc(512, 0x5a), { mode: 0o644 });
    writeFileSync(`${dbPath}-wal`, "wal", { mode: 0o644 });
    writeFileSync(`${dbPath}-shm`, "shm", { mode: 0o644 });
    writeFileSync(`${dbPath}-journal`, "journal", { mode: 0o644 });
}

function safeHolders() {
    return { safe: true, blockers: [] };
}

function quarantineDir(storageDir: string): string {
    const name = readdirSync(storageDir).find((entry) => entry.includes(".mc-quarantine-"));
    if (!name) throw new Error("quarantine directory not found");
    return join(storageDir, name);
}

function expectPending(state: DirectDatabaseFamilyState): void {
    expect(state.state).toBe("reset-pending");
}

afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("doctor reset-db U11 scenarios", () => {
    it("scenario 1: read-only inspection distinguishes every family without changing bytes", () => {
        const storageDir = tempStorage();
        const pristinePath = join(storageDir, "pristine.db");
        expect(inspectDirectDatabaseFamilyState(pristinePath)).toEqual({ state: "pristine" });

        const currentPath = join(storageDir, "current.db");
        const current = createDirectTestDatabase({ path: currentPath });
        const currentIncarnation = current.marker.databaseIncarnationId;
        current.db.close();
        const currentBytes = readFileSync(currentPath);
        expect(inspectDirectDatabaseFamilyState(currentPath)).toEqual({
            state: "current",
            databaseIncarnationId: currentIncarnation,
        });
        expect(readFileSync(currentPath)).toEqual(currentBytes);

        const legacyPath = join(storageDir, "legacy-v89.db");
        const legacy = new Database(legacyPath);
        legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
        legacy.exec("INSERT INTO schema_migrations(version) VALUES (89)");
        legacy.close();
        expect(inspectDirectDatabaseFamilyState(legacyPath)).toMatchObject({
            state: "unsupported",
            family: "unsupported",
            databaseIncarnationId: null,
        });

        const pendingPath = join(storageDir, "pending.db");
        const pendingMarker = buildDatabaseResetMarker({
            dbPath: pendingPath,
            createdAtMs: 1,
            databaseIncarnationId: null,
            quarantineDirPath: `${pendingPath}.mc-quarantine-test`,
            fileIdentities: [],
        });
        writeDatabaseResetMarker(pendingMarker);
        expectPending(inspectDirectDatabaseFamilyState(pendingPath));

        const corruptPath = join(storageDir, "corrupt-direct.db");
        const corrupt = createDirectTestDatabase({ path: corruptPath });
        corrupt.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        corrupt.db.exec("PRAGMA journal_mode=DELETE");
        corrupt.db.close();
        truncateSync(corruptPath, 100);
        const corruptBytes = readFileSync(corruptPath);
        corruptBytes.writeUInt16BE(0, 16);
        writeFileSync(corruptPath, corruptBytes);
        expect(inspectDirectDatabaseFamilyState(corruptPath)).toMatchObject({
            state: "corrupt",
            format: "direct",
        });
        expect(readFileSync(corruptPath)).toEqual(corruptBytes);
    });

    it("scenario 2: dry-run reports exact family, identities, incarnation, path, and abandonment", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        const incarnation = seedUnsupportedDirect(dbPath);
        const identity = statSync(dbPath);
        const before = readFileSync(dbPath);
        const prompts = new MockPrompts();

        const code = await runResetDb({
            dbPath,
            storageDir,
            prompts,
            dryRun: true,
            deps: {
                now: () => new Date("2026-08-23T07:40:00.000Z"),
                inspectHolders: safeHolders,
            },
        });

        expect(code).toBe(RESET_DB_EXIT.ok);
        expect(readFileSync(dbPath)).toEqual(before);
        expect(existsSync(databaseResetMarkerPath(dbPath))).toBe(false);
        const output = prompts.messages.join("\n");
        expect(output).toContain("Database family: unsupported (unsupported)");
        expect(output).toContain(`Database incarnation: ${incarnation}`);
        expect(output).toContain(`dev=${identity.dev} inode=${identity.ino}`);
        expect(output).toContain(`${dbPath}.mc-quarantine-20260823T074000000Z`);
        expect(output).toContain("logical abandonment, not secure erasure");
        expect(output).toContain("retained at that path");
        expect(output).toContain("Nothing is migrated or salvaged");
    });

    it("scenario 3: explicit confirmation decline preserves unsupported family", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedUnsupportedDirect(dbPath);
        const before = readFileSync(dbPath);
        const prompts = new MockPrompts([false]);

        const code = await runResetDb({
            dbPath,
            storageDir,
            prompts,
            deps: { inspectHolders: safeHolders },
        });

        expect(code).toBe(RESET_DB_EXIT.declined);
        expect(readFileSync(dbPath)).toEqual(before);
        expect(existsSync(databaseResetMarkerPath(dbPath))).toBe(false);
        expect(prompts.messages.join("\n")).toContain("All of its logical data will be lost");
    });

    it("scenario 4: rename failure immediately after marker publication stays resumable", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedFullCorruptFamily(dbPath);
        const prompts = new MockPrompts();

        const interrupted = await runResetDb({
            dbPath,
            storageDir,
            prompts,
            yes: true,
            deps: {
                inspectHolders: safeHolders,
                renameFile: () => {
                    throw new Error("injected crash before first rename");
                },
            },
        });

        expect(interrupted).toBe(RESET_DB_EXIT.failed);
        expectPending(inspectDirectDatabaseFamilyState(dbPath));
        expect(existsSync(dbPath)).toBe(true);
        const resumed = await runResetDb({
            dbPath,
            storageDir,
            prompts: new MockPrompts(),
            yes: true,
            deps: { inspectHolders: safeHolders },
        });
        expect(resumed).toBe(RESET_DB_EXIT.ok);
        expect(inspectDirectDatabaseFamilyState(dbPath)).toEqual({ state: "pristine" });
    });

    it("scenario 5: crash after each family move resumes idempotently", async () => {
        for (let crashAfter = 1; crashAfter <= DATABASE_FAMILY_MOVE_ORDER.length; crashAfter++) {
            const storageDir = tempStorage();
            const dbPath = join(storageDir, "context.db");
            seedFullCorruptFamily(dbPath);
            let renameCount = 0;
            const interrupted = await runResetDb({
                dbPath,
                storageDir,
                prompts: new MockPrompts(),
                yes: true,
                deps: {
                    inspectHolders: safeHolders,
                    renameFile: (source, destination) => {
                        renameSync(source, destination);
                        renameCount += 1;
                        if (renameCount === crashAfter) {
                            throw new Error(`crash after move ${crashAfter}`);
                        }
                    },
                },
            });
            expect(interrupted).toBe(RESET_DB_EXIT.failed);
            expectPending(inspectDirectDatabaseFamilyState(dbPath));

            const resumed = await runResetDb({
                dbPath,
                storageDir,
                prompts: new MockPrompts(),
                yes: true,
                deps: { inspectHolders: safeHolders },
            });
            expect(resumed).toBe(RESET_DB_EXIT.ok);
            expect(inspectDirectDatabaseFamilyState(dbPath)).toEqual({ state: "pristine" });
            const quarantined = quarantineDir(storageDir);
            expect(readdirSync(quarantined).sort()).toEqual(
                [
                    "context.db",
                    "context.db-journal",
                    "context.db-shm",
                    "context.db-wal",
                    "context.db.mc-reset",
                ].sort(),
            );
        }
    });

    it("scenario 5b: a sidecar replaced between moves is preserved and aborts quarantine", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedFullCorruptFamily(dbPath);
        const replacement = Buffer.from("replacement shm after reset began");
        let replaced = false;

        const code = await runResetDb({
            dbPath,
            storageDir,
            prompts: new MockPrompts(),
            yes: true,
            deps: {
                inspectHolders: safeHolders,
                renameFile: (source, destination) => {
                    renameSync(source, destination);
                    if (!replaced && source.endsWith("-journal")) {
                        replaced = true;
                        rmSync(`${dbPath}-shm`, { force: true });
                        writeFileSync(`${dbPath}-shm`, replacement);
                    }
                },
            },
        });

        expect(code).toBe(RESET_DB_EXIT.refused);
        expect(readFileSync(`${dbPath}-shm`)).toEqual(replacement);
        expect(existsSync(dbPath)).toBe(true);
    });

    it("scenario 6: holder appearing after initial inspection refuses before first move", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedUnsupportedDirect(dbPath);
        const before = readFileSync(dbPath);
        let inspections = 0;
        const prompts = new MockPrompts();

        const code = await runResetDb({
            dbPath,
            storageDir,
            prompts,
            yes: true,
            deps: {
                inspectHolders: () => {
                    inspections += 1;
                    return inspections === 1
                        ? safeHolders()
                        : { safe: false, blockers: ["OpenCode server (PID 42)"] };
                },
            },
        });

        expect(code).toBe(RESET_DB_EXIT.refused);
        expect(inspections).toBe(2);
        expect(readFileSync(dbPath)).toEqual(before);
        expect(existsSync(databaseResetMarkerPath(dbPath))).toBe(false);
        expect(prompts.messages.join("\n")).toContain("OpenCode server (PID 42)");

        const uncertainPath = join(storageDir, "uncertain.db");
        seedUnsupportedDirect(uncertainPath);
        let uncertainInspections = 0;
        const uncertainPrompts = new MockPrompts();
        const uncertainCode = await runResetDb({
            dbPath: uncertainPath,
            storageDir,
            prompts: uncertainPrompts,
            yes: true,
            deps: {
                inspectHolders: () => {
                    uncertainInspections += 1;
                    return uncertainInspections === 1
                        ? safeHolders()
                        : {
                              safe: false,
                              blockers: [],
                              uncertainty: "process list unavailable",
                          };
                },
            },
        });
        expect(uncertainCode).toBe(RESET_DB_EXIT.refused);
        expect(existsSync(databaseResetMarkerPath(uncertainPath))).toBe(false);
        expect(uncertainPrompts.messages.join("\n")).toContain("process list unavailable");
    });

    it("scenario 7: family identity replacement after confirmation is preserved and refused", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedUnsupportedDirect(dbPath);
        const replacementPath = join(storageDir, "replacement.db");
        writeFileSync(replacementPath, "replacement family");
        let inspections = 0;

        const code = await runResetDb({
            dbPath,
            storageDir,
            prompts: new MockPrompts(),
            yes: true,
            deps: {
                inspectHolders: () => {
                    inspections += 1;
                    if (inspections === 2) renameSync(replacementPath, dbPath);
                    return safeHolders();
                },
            },
        });

        expect(code).toBe(RESET_DB_EXIT.refused);
        expect(readFileSync(dbPath, "utf8")).toBe("replacement family");
        expect(existsSync(databaseResetMarkerPath(dbPath))).toBe(false);
        expect(readdirSync(storageDir).some((name) => name.includes(".mc-quarantine-"))).toBe(
            false,
        );
    });

    it("scenario 8: quarantine uses sidecar-first order and private permissions", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedFullCorruptFamily(dbPath);
        const moves: string[] = [];
        let holderInspections = 0;

        const code = await runResetDb({
            dbPath,
            storageDir,
            prompts: new MockPrompts(),
            yes: true,
            deps: {
                inspectHolders: () => {
                    holderInspections += 1;
                    return safeHolders();
                },
                renameFile: (source, destination) => {
                    moves.push(basename(String(source)));
                    renameSync(source, destination);
                },
            },
        });

        expect(code).toBe(RESET_DB_EXIT.ok);
        expect(holderInspections).toBe(1 + DATABASE_FAMILY_MOVE_ORDER.length + 1);
        expect(moves).toEqual([
            "context.db-journal",
            "context.db-wal",
            "context.db-shm",
            "context.db",
            "context.db.mc-reset",
        ]);
        const quarantined = quarantineDir(storageDir);
        if (process.platform !== "win32") {
            expect(statSync(quarantined).mode & 0o777).toBe(0o700);
            for (const entry of readdirSync(quarantined)) {
                expect(statSync(join(quarantined, entry)).mode & 0o777).toBe(0o600);
            }
        }
    });

    it("scenario 9: reset allows fresh bootstrap only with a distinct incarnation", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        const oldIncarnation = seedUnsupportedDirect(dbPath);

        expect(
            await runResetDb({
                dbPath,
                storageDir,
                prompts: new MockPrompts(),
                yes: true,
                deps: { inspectHolders: safeHolders },
            }),
        ).toBe(RESET_DB_EXIT.ok);
        expect(inspectDirectDatabaseFamilyState(dbPath)).toEqual({ state: "pristine" });

        const fresh = createDirectTestDatabase({ path: dbPath });
        try {
            expect(fresh.marker.databaseIncarnationId).not.toBe(oldIncarnation);
        } finally {
            fresh.db.close();
        }
    });
});
