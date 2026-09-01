import { afterEach, describe, expect, it } from "bun:test";
import {
    copyFileSync,
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

/** Checkpointing stores the schema in the main file before the sidecars are removed. */
function seedCheckpointedUnsupportedDirect(dbPath: string): string {
    const { db, marker } = createDirectTestDatabase({
        path: dbPath,
        components: [CURRENT_SCHEMA_COMPONENTS[0]],
        nowMs: 42,
    });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    for (const suffix of ["-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
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

    it("classifies a current family whose rollback journal is still hot", () => {
        // A hot journal requires SQLite recovery before the main database reflects the rolled-back transaction.
        // Without recovery, classification can misreport a recoverable family as corrupt.
        // quarantine.
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "hot-journal.db");
        const created = createDirectTestDatabase({ path: dbPath });
        const incarnation = created.marker.databaseIncarnationId;
        created.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        created.db.exec("PRAGMA journal_mode=DELETE");
        // A tiny page cache spills transaction pages into the main file, creating a hot journal that exercises rollback recovery.
        // merely present.
        created.db.exec("PRAGMA cache_size=2");
        created.db.exec("BEGIN IMMEDIATE");
        // The transaction creates an unregistered schema object; before rollback classification reports `unsupported`, but recovery yields the current family.
        created.db.exec("CREATE TABLE hot_journal_probe(a, b)");
        const insert = created.db.prepare("INSERT INTO hot_journal_probe VALUES (?, ?)");
        for (let index = 0; index < 20_000; index += 1) insert.run(index, "x".repeat(200));
        // The test abandons the connection without commit or close, leaving the journal on disk as a killed process would.
        expect(existsSync(`${dbPath}-journal`)).toBe(true);

        const before = readFileSync(dbPath);
        expect(inspectDirectDatabaseFamilyState(dbPath)).toEqual({
            state: "current",
            databaseIncarnationId: incarnation,
        });
        // The probe recovers on its private copy, never the real family.
        expect(readFileSync(dbPath)).toEqual(before);
        expect(existsSync(`${dbPath}-journal`)).toBe(true);
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
                        // The reset stages the replacement beside the original, then renames it so open holders retain the original inode while the replacement has a distinct identity.
                        const staged = `${dbPath}-shm.replacement`;
                        writeFileSync(staged, replacement);
                        renameSync(staged, `${dbPath}-shm`);
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

    it("refuses when the family becomes current during the confirmation prompt", async () => {
        // The reset re-reads the family after confirmation because another process can upgrade it while the prompt is open.
        // quarantined.
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedUnsupportedDirect(dbPath);
        let reads = 0;

        const code = await runResetDb({
            dbPath,
            storageDir,
            prompts: new MockPrompts(),
            yes: true,
            deps: {
                inspectFamilyState: (path: string) => {
                    reads += 1;
                    // Read 1 classifies the family, read 2 rechecks exclusivity before the prompt, and the post-confirmation read observes upgrades made while the prompt was open.
                    if (reads >= 3) {
                        return {
                            state: "current",
                            databaseIncarnationId: "upgraded-incarnation",
                        } as ReturnType<typeof inspectDirectDatabaseFamilyState>;
                    }
                    return inspectDirectDatabaseFamilyState(path);
                },
            },
        });

        expect(code).toBe(RESET_DB_EXIT.refused);
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

    it("scenario 10: a family that only looks unsupported before exclusivity is preserved", async () => {
        // If no holders remain, the reset moves no files and leaves no marker that could block the next open.
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        const stash = tempStorage();
        const seeded = createDirectTestDatabase({ path: dbPath });
        const incarnation = seeded.marker.databaseIncarnationId;
        seeded.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        seeded.db.close();
        const familyBytes = new Map<string, Buffer>();
        for (const suffix of ["", "-wal", "-shm"]) {
            if (existsSync(`${dbPath}${suffix}`)) {
                familyBytes.set(suffix, readFileSync(`${dbPath}${suffix}`));
                copyFileSync(`${dbPath}${suffix}`, join(stash, `context.db${suffix}`));
            }
        }
        writeFileSync(dbPath, Buffer.alloc(0));
        writeFileSync(`${dbPath}-wal`, Buffer.alloc(0));
        expect(inspectDirectDatabaseFamilyState(dbPath)).toMatchObject({ state: "unsupported" });

        let holderInspections = 0;
        const prompts = new MockPrompts([true]);
        const code = await runResetDb({
            dbPath,
            storageDir,
            prompts,
            deps: {
                inspectHolders: () => {
                    holderInspections += 1;
                    if (holderInspections === 1) {
                        for (const suffix of ["", "-wal", "-shm"]) {
                            const source = join(stash, `context.db${suffix}`);
                            if (existsSync(source)) copyFileSync(source, `${dbPath}${suffix}`);
                        }
                    }
                    return safeHolders();
                },
            },
        });

        expect(code).toBe(RESET_DB_EXIT.refused);
        expect(inspectDirectDatabaseFamilyState(dbPath)).toEqual({
            state: "current",
            databaseIncarnationId: incarnation,
        });
        for (const [suffix, bytes] of familyBytes) {
            expect(readFileSync(`${dbPath}${suffix}`)).toEqual(bytes);
        }
        // The no-holder path leaves no reset marker and moves no files.
        expect(existsSync(databaseResetMarkerPath(dbPath))).toBe(false);
        expect(readdirSync(storageDir).some((name) => name.includes(".mc-quarantine-"))).toBe(
            false,
        );
        const output = prompts.messages.join("\n");
        expect(output).toContain("current supported format");
        expect(output).toContain("no reset marker was published");
        expect(output).not.toContain("confirm:");
        expect(holderInspections).toBe(1);
    });

    it("scenario 11: the confirmation describes the re-checked classification", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedFullCorruptFamily(dbPath);
        const incarnation = seedCheckpointedUnsupportedDirect(join(storageDir, "swapped.db"));
        const prompts = new MockPrompts([true]);
        let holderInspections = 0;
        let swapped = { dev: 0, ino: 0 };

        const code = await runResetDb({
            dbPath,
            storageDir,
            prompts,
            deps: {
                inspectHolders: () => {
                    holderInspections += 1;
                    if (holderInspections === 1) {
                        for (const suffix of ["-wal", "-shm", "-journal"]) {
                            rmSync(`${dbPath}${suffix}`, { force: true });
                        }
                        renameSync(join(storageDir, "swapped.db"), dbPath);
                        swapped = statSync(dbPath);
                    }
                    return safeHolders();
                },
            },
        });

        expect(code).toBe(RESET_DB_EXIT.ok);
        const output = prompts.messages.join("\n");
        const confirmAt = output.indexOf("confirm:");
        expect(confirmAt).toBeGreaterThan(-1);
        const beforeConfirmation = output.slice(0, confirmAt);
        expect(beforeConfirmation).toContain("State: corrupt unknown format");
        const supersededAt = beforeConfirmation.indexOf(
            "Re-checked with no database holder present: unsupported (unsupported). Acting on this reading, not the earlier one.",
        );
        const planAt = beforeConfirmation.indexOf("Database family:");
        expect(supersededAt).toBeGreaterThan(beforeConfirmation.indexOf("State: corrupt"));
        expect(planAt).toBeGreaterThan(supersededAt);
        expect(beforeConfirmation.split("Database family:").length - 1).toBe(1);
        expect(beforeConfirmation).toContain("Database family: unsupported (unsupported)");
        expect(beforeConfirmation).toContain(`Database incarnation: ${incarnation}`);
        expect(beforeConfirmation).toContain(
            `main: ${dbPath} (dev=${swapped.dev} inode=${swapped.ino}`,
        );
        // Quarantine moves only files in the confirmed plan.
        const quarantined = readdirSync(quarantineDir(storageDir)).sort();
        expect(quarantined).toEqual(["context.db", "context.db.mc-reset"]);
    });

    it("scenario 12: a reset marker published by a rival reset is never disturbed", async () => {
        const storageDir = tempStorage();
        const dbPath = join(storageDir, "context.db");
        seedUnsupportedDirect(dbPath);
        const rivalQuarantine = `${dbPath}.mc-quarantine-rival`;

        // A rival publishes its marker between the first reading and exclusivity.
        const beforeExclusivity = await runResetDb({
            dbPath,
            storageDir,
            prompts: new MockPrompts([true]),
            deps: {
                inspectHolders: () => {
                    if (!existsSync(databaseResetMarkerPath(dbPath))) {
                        writeDatabaseResetMarker(
                            buildDatabaseResetMarker({
                                dbPath,
                                createdAtMs: 5,
                                databaseIncarnationId: null,
                                quarantineDirPath: rivalQuarantine,
                                fileIdentities: [],
                            }),
                        );
                    }
                    return safeHolders();
                },
            },
        });
        expect(beforeExclusivity).toBe(RESET_DB_EXIT.refused);
        const rivalBytes = readFileSync(databaseResetMarkerPath(dbPath));
        rmSync(databaseResetMarkerPath(dbPath));

        // A rival publishes after exclusivity, while this run builds its marker:
        // `wx` fails, so publication touches nothing it did not create.
        let clocks = 0;
        const prompts = new MockPrompts([true]);
        const afterExclusivity = await runResetDb({
            dbPath,
            storageDir,
            prompts,
            deps: {
                inspectHolders: safeHolders,
                now: () => {
                    clocks += 1;
                    if (clocks === 2) {
                        writeDatabaseResetMarker(
                            buildDatabaseResetMarker({
                                dbPath,
                                createdAtMs: 5,
                                databaseIncarnationId: null,
                                quarantineDirPath: rivalQuarantine,
                                fileIdentities: [],
                            }),
                        );
                    }
                    return new Date("2026-08-23T07:40:00.000Z");
                },
            },
        });
        expect(afterExclusivity).toBe(RESET_DB_EXIT.failed);
        expect(prompts.messages.join("\n")).toContain("Could not publish the reset marker");
        expect(readFileSync(databaseResetMarkerPath(dbPath))).toEqual(rivalBytes);
        expect(readdirSync(storageDir).some((name) => name.includes(".mc-quarantine-2026"))).toBe(
            false,
        );
    });
});
