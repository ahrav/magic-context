import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import {
    createMemoryWithClaimsInCurrentTransaction,
    runInMemoryClaimsWriteTransaction,
} from "../../../plugin/src/features/magic-context/memory/storage-memory-claims";
import {
    initializeDatabase,
    runMigrations,
} from "../../../plugin/src/features/magic-context/storage";
import { computeLegacyRustDirIdentity } from "../../../plugin/src/features/magic-context/v22-deferred-backfill";
import { Database } from "../../../plugin/src/shared/sqlite";
import { runClaimsBackfillCommands } from "../lib/claims-backfill-commands";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import { runV22BackfillCommands } from "../lib/v22-backfill-commands";
import {
    checkUserMemoriesDreamerCompatibility,
    collectNpmReleaseAgeWarnings,
    getUserNpmrcPath,
    isPinnedOpenCodePluginSpecifier,
    migrateLegacyAgentEnabledConfigForDoctor,
} from "./doctor-opencode";
import { clearPluginCache } from "./doctor-opencode-cache";

function migrate(input: Record<string, unknown>) {
    const logs: Array<{ level: "success" | "warn"; message: string }> = [];
    const result = migrateLegacyAgentEnabledConfigForDoctor(input, {
        success: (message) => logs.push({ level: "success", message }),
        warn: (message) => logs.push({ level: "warn", message }),
    });
    return { config: input, logs, result };
}

describe("doctor OpenCode legacy agent enabled migration", () => {
    it("migrates legacy enabled fields with conflict rules and warning text", () => {
        const { config, logs, result } = migrate({
            dreamer: { enabled: false, disable: false },
            sidekick: { enabled: true, disable: true },
            historian: { enabled: true, disable: true },
        });

        expect(result).toEqual({ changed: true, fixes: 3 });
        expect(config).toEqual({
            dreamer: { disable: true },
            sidekick: { disable: true },
            historian: { disable: true },
        });
        expect(logs).toContainEqual({
            level: "warn",
            message:
                "Migrated dreamer.enabled=false → dreamer.disable=true. This now also disables manual /ctx-dream. To keep manual dreaming, remove disable=true and set schedule to empty string.",
        });
        expect(logs.map((entry) => entry.message)).toContain(
            "Removed deprecated sidekick.enabled (use sidekick.disable=true to turn off Sidekick).",
        );
        expect(logs.map((entry) => entry.message)).toContain(
            "Removed invalid historian.enabled (historian uses disable=true to turn off).",
        );
    });

    it("removes enabled=true without adding disable=false and is idempotent", () => {
        const first = migrate({ dreamer: { enabled: true }, sidekick: { enabled: false } });
        expect(first.config).toEqual({ dreamer: {}, sidekick: { disable: true } });

        const second = migrate(first.config);
        expect(second.result).toEqual({ changed: false, fixes: 0 });
        expect(second.logs).toEqual([]);
    });

    it("round-trips migrated config through JSONC serialization", () => {
        const config = parseJsonc(
            '{ "dreamer": { "enabled": false }, "sidekick": { "enabled": false } }',
        ) as Record<string, unknown>;
        migrateLegacyAgentEnabledConfigForDoctor(config, { success: () => {}, warn: () => {} });
        const serialized = stringifyJsonc(config, null, 2);

        expect(serialized).toContain('"disable": true');
        expect(serialized).not.toContain('"enabled"');
    });
});

describe("checkUserMemoriesDreamerCompatibility", () => {
    const WARNING =
        'dreamer.tasks["review-user-memories"] is scheduled but dreamer.disable=true, so new promotions will not run. Remove dreamer.disable or set dreamer.tasks["review-user-memories"].schedule="" to disable the task.';

    it("warns when review-user-memories is scheduled and dreamer.disable=true", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                tasks: { "review-user-memories": { schedule: "0 2 * * *" } },
            },
        });
        expect(result).toBe(WARNING);
    });

    it("returns null when dreamer is not disabled", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: false,
                tasks: { "review-user-memories": { schedule: "0 2 * * *" } },
            },
        });
        expect(result).toBeNull();
    });

    it("returns null when review-user-memories schedule is empty", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                tasks: { "review-user-memories": { schedule: "" } },
            },
        });
        expect(result).toBeNull();
    });

    it("returns null when review-user-memories schedule is whitespace-only", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                tasks: { "review-user-memories": { schedule: "   " } },
            },
        });
        expect(result).toBeNull();
    });

    it("returns null when review-user-memories task is absent", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: { disable: true, tasks: { verify: { schedule: "0 2 * * *" } } },
        });
        expect(result).toBeNull();
    });

    it("returns null when dreamer block is absent", () => {
        expect(checkUserMemoriesDreamerCompatibility({})).toBeNull();
    });

    it("returns null when tasks block is absent (legacy v1 shape without user_memories)", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: { disable: true },
        });
        expect(result).toBeNull();
    });

    it("does not read legacy dreamer.user_memories (v1 key, migrated away in v2)", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                user_memories: { enabled: true },
            },
        });
        expect(result).toBeNull();
    });
});

const tempDirs: string[] = [];
const dbs: Database[] = [];
let originalXdgCacheHome: string | undefined;
let originalHome: string | undefined;
let originalNpmUserConfig: string | undefined;

function makeTempDir(prefix = "mc-v22-doctor-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    dbs.push(db);
    return db;
}

function insertMemory(database: Database, projectPath: string, normalizedHash: string): number {
    return runInMemoryClaimsWriteTransaction(database, () => {
        const result = database
            .prepare(
                `INSERT INTO memories
                (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?, 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`,
            )
            .run(projectPath, `content-${normalizedHash}`, normalizedHash) as {
            lastInsertRowid: number;
        };
        return Number(result.lastInsertRowid);
    });
}

function metaValue(database: Database, key: string): string | null {
    const row = database
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

function makeHarness(database: Database, messages: string[]) {
    return {
        name: "test",
        openDatabase: () => database,
        closeDatabase: () => {},
        log: {
            info: (message: string) => messages.push(`info:${message}`),
            success: (message: string) => messages.push(`success:${message}`),
            warn: (message: string) => messages.push(`warn:${message}`),
            error: (message: string) => messages.push(`error:${message}`),
        },
    };
}

afterEach(() => {
    if (originalXdgCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
    } else {
        process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
    if (originalHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = originalHome;
    }
    if (originalNpmUserConfig === undefined) {
        delete process.env.NPM_CONFIG_USERCONFIG;
    } else {
        process.env.NPM_CONFIG_USERCONFIG = originalNpmUserConfig;
    }
    originalXdgCacheHome = undefined;
    originalHome = undefined;
    originalNpmUserConfig = undefined;
    for (const db of dbs.splice(0)) {
        db.close();
    }
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function createCachedOpenCodePlugin(
    root: string,
    version: string,
    entry = OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
): string {
    const pluginCachePath = join(root, "opencode", "packages", entry);
    const installedPackagePath = join(
        pluginCachePath,
        "node_modules",
        "@cortexkit",
        "opencode-magic-context",
        "package.json",
    );
    mkdirSync(dirname(installedPackagePath), { recursive: true });
    writeFileSync(installedPackagePath, `${JSON.stringify({ version })}\n`);
    return pluginCachePath;
}

describe("doctor OpenCode plugin cache", () => {
    it("clears stale @latest cache when cached plugin is older than npm latest", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.26.0",
            latest: "0.29.1",
            path: pluginCachePath,
        });
        expect(existsSync(pluginCachePath)).toBe(false);
    });

    it("keeps @latest cache when cached plugin matches npm latest", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "up_to_date",
            cached: "0.29.1",
            latest: "0.29.1",
            path: pluginCachePath,
        });
        expect(existsSync(pluginCachePath)).toBe(true);
    });

    it("clears stale versionless cache even when @latest cache is current", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const latestCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");
        const versionlessCachePath = createCachedOpenCodePlugin(
            cacheRoot,
            "0.26.0",
            OPENCODE_PLUGIN_NAME,
        );

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.26.0",
            latest: "0.29.1",
            path: versionlessCachePath,
            paths: [versionlessCachePath],
        });
        expect(existsSync(latestCachePath)).toBe(true);
        expect(existsSync(versionlessCachePath)).toBe(false);
    });

    it("preserves existing cache when plugin npm latest is unavailable", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ latestVersion: null });

        expect(result).toMatchObject({
            action: "check_unavailable",
            cached: "0.29.1",
            path: pluginCachePath,
            paths: [pluginCachePath],
        });
        expect(result.latest).toBeUndefined();
        expect(existsSync(pluginCachePath)).toBe(true);
    });

    it("force-clears existing cache even when plugin npm latest is unavailable", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ force: true, latestVersion: null });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.29.1",
            path: pluginCachePath,
            paths: [pluginCachePath],
        });
        expect(result.latest).toBeUndefined();
        expect(existsSync(pluginCachePath)).toBe(false);
    });

    it("reports the actually-failed root and clears the rest when one root fails", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const latestCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");
        const versionlessCachePath = createCachedOpenCodePlugin(
            cacheRoot,
            "0.26.0",
            OPENCODE_PLUGIN_NAME,
        );

        // Fail only the second root: the first must still be removed, and the
        // error must point at the failed root, not the already-removed one.
        const removed: string[] = [];
        const result = await clearPluginCache(
            { latestVersion: "0.29.1" },
            {
                remove: (path) => {
                    if (path === versionlessCachePath) {
                        throw new Error("EACCES: permission denied");
                    }
                    rmSync(path, { recursive: true, force: true });
                    removed.push(path);
                },
            },
        );

        expect(result).toMatchObject({
            action: "error",
            path: versionlessCachePath,
            paths: [versionlessCachePath],
            clearedPaths: [latestCachePath],
            failedPaths: [versionlessCachePath],
            error: "EACCES: permission denied",
        });
        expect(removed).toEqual([latestCachePath]);
        expect(existsSync(latestCachePath)).toBe(false);
    });
});

describe("doctor OpenCode helper logic", () => {
    it("treats dist-tags like @next and @beta as pinned plugin entries", () => {
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@next")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@beta")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@0.29.1")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context")).toBe(false);
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@latest")).toBe(
            false,
        );
    });

    it("honors NPM_CONFIG_USERCONFIG before HOME for npmrc release-age warnings", () => {
        const root = makeTempDir("mc-npmrc-");
        const home = join(root, "home");
        const customNpmrc = join(root, "custom.npmrc");
        originalHome = process.env.HOME;
        originalNpmUserConfig = process.env.NPM_CONFIG_USERCONFIG;
        process.env.HOME = home;
        process.env.NPM_CONFIG_USERCONFIG = customNpmrc;
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, ".npmrc"), "min-release-age=9999\n");
        writeFileSync(customNpmrc, "before=2026-01-01\n");

        expect(getUserNpmrcPath()).toBe(customNpmrc);
        expect(collectNpmReleaseAgeWarnings()).toEqual([`${customNpmrc} has 'before=2026-01-01'`]);
    });
});

describe("doctor claims backfill commands", () => {
    it("runs mixed v22 and claims commands sequentially with one combined exit", () => {
        const source = readFileSync(new URL("./doctor-opencode.ts", import.meta.url), "utf8");
        expect(source.indexOf("runV22BackfillCommands(")).toBeLessThan(
            source.indexOf("runClaimsBackfillCommands("),
        );
        expect(source).toContain(
            "if (sharedCommandExitCode !== null) return sharedCommandExitCode",
        );
        expect(
            source.match(/Math\.max\(sharedCommandExitCode \?\? 0, \w+Result\.exitCode\)/g),
        ).toHaveLength(2);
    });

    it("status is read-only and reports blocked state with exact repair command", async () => {
        const database = makeDb();
        const messages: string[] = [];
        const readonlyFlags: boolean[] = [];
        const versionBefore = database
            .prepare("SELECT MAX(version) AS version FROM schema_migrations")
            .get() as { version: number };

        const result = await runClaimsBackfillCommands(
            {
                ...makeHarness(database, messages),
                openDatabase: (readonly = false) => {
                    readonlyFlags.push(readonly);
                    return database;
                },
            },
            { checkClaimsBackfill: true },
        );

        expect(result).toEqual({ handled: true, exitCode: 0 });
        expect(readonlyFlags).toEqual([true]);
        expect(messages.join("\n")).toContain("claims backfill status: blocked");
        expect(messages.join("\n")).toContain(
            "mode decision: empty corpus; calibration digest: none",
        );
        expect(messages.join("\n")).toContain(
            "Repair with: magic-context doctor --retry-claims-backfill",
        );
        expect(
            database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
        ).toEqual(versionBefore);
    });

    it("retry resolves v22 takeover once, reports before/after counts, preserves schema version, and gives restart guidance", async () => {
        const database = makeDb();
        const messages: string[] = [];
        const versionBefore = database
            .prepare("SELECT MAX(version) AS version FROM schema_migrations")
            .get();

        const result = await runClaimsBackfillCommands(makeHarness(database, messages), {
            retryClaimsBackfill: true,
        });

        expect(result).toEqual({ handled: true, exitCode: 0 });
        const output = messages.join("\n");
        expect(output).toContain("before: phase=complete; linked=0/0");
        expect(output).toContain("after:  phase=complete; linked=0/0");
        expect(output).toContain("claims backfill complete");
        expect(output).toContain("schema: v89 → v89");
        expect(output).toContain("restart it before creating new sessions");
        expect(
            database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
        ).toEqual(versionBefore);
    });

    it("blocked retry exits 1 and malformed waiver ids are rejected exactly", async () => {
        const database = makeDb();
        // A real unlinked row under a raw project path keeps the failure
        // legitimately blocking: the resolution sweep clears diagnostics whose
        // memory row is linked or gone, so the fixture must hold a live,
        // unadoptable boundary row. The boundary meta places it inside the
        // boundary corpus: only boundary-scoped blocking failures gate
        // completion.
        const blockedId = insertMemory(database, "/raw/unresolvable", "blocked-hash");
        database.exec(`
            UPDATE schema_migrations_meta SET value = 'blocked' WHERE key = 'claims_backfill_phase';
            UPDATE schema_migrations_meta SET value = 'none' WHERE key = 'claims_backfill_v22_takeover';
            UPDATE schema_migrations_meta SET value = '${blockedId}' WHERE key = 'claims_backfill_boundary_memory_id';
            INSERT INTO claim_backfill_failures
                (phase, item_kind, item_key, reason_code, detail, disposition, created_at, updated_at)
            VALUES ('rows', 'memory', '${blockedId}', 'unresolved-project-identity', '', 'blocking', 1, 1);
        `);
        const retryMessages: string[] = [];
        const retry = await runClaimsBackfillCommands(makeHarness(database, retryMessages), {
            retryClaimsBackfill: true,
        });
        expect(retry.exitCode).toBe(1);
        // A blocked retry still mutated the database, so the epilogue must
        // print the schema delta and the restart warning despite exit 1.
        const retryOutput = retryMessages.join("\n");
        expect(retryOutput).toContain("Magic Context schema:");
        expect(retryOutput).toContain("restart it before creating new sessions");

        for (const invalid of [null, "--force", "7junk", "0", "-1"]) {
            const messages: string[] = [];
            const result = await runClaimsBackfillCommands(makeHarness(database, messages), {
                waiveClaimsBackfillFailure: invalid,
                waiveRationale: "reviewed",
            });
            expect(result.exitCode).toBe(1);
            expect(messages.join("\n")).toContain("requires a numeric failure id");
        }
    });

    it("explicit completed status reconciles and reports corruption as blocked", async () => {
        const database = makeDb();
        database
            .prepare(
                "UPDATE schema_migrations_meta SET value = 'none' WHERE key = 'claims_backfill_v22_takeover'",
            )
            .run();
        const created = runInMemoryClaimsWriteTransaction(database, () =>
            createMemoryWithClaimsInCurrentTransaction(
                database,
                {
                    producer: "doctor-test",
                    operationKey: "completed-corruption",
                    requestDigest: "a".repeat(64),
                },
                {
                    projectPath: "git:doctor-corruption",
                    category: "CONSTRAINTS",
                    content: "doctor corruption target",
                    normalizedHash: "doctor-corruption-hash",
                },
            ),
        );
        database.exec("DROP TRIGGER claim_revision_memory_metadata_append_only_delete");
        database
            .prepare("DELETE FROM claim_revision_memory_metadata WHERE revision_id = ?")
            .run(created.result.revisionId);

        const messages: string[] = [];
        await runClaimsBackfillCommands(makeHarness(database, messages), {
            checkClaimsBackfill: true,
        });
        expect(messages.join("\n")).toContain("claims backfill status: blocked");
        expect(messages.join("\n")).toContain("revision(s) missing memory metadata");
    });

    it("status distinguishes pending, completed, and completed-with-warnings", async () => {
        const database = makeDb();
        database
            .prepare(
                "UPDATE schema_migrations_meta SET value = 'none' WHERE key = 'claims_backfill_v22_takeover'",
            )
            .run();
        const cases = [
            { phase: "rows", expected: "pending" },
            { phase: "complete", expected: "complete" },
        ] as const;
        for (const item of cases) {
            database
                .prepare(
                    "UPDATE schema_migrations_meta SET value = ? WHERE key = 'claims_backfill_phase'",
                )
                .run(item.phase);
            const messages: string[] = [];
            await runClaimsBackfillCommands(makeHarness(database, messages), {
                checkClaimsBackfill: true,
            });
            expect(messages.join("\n")).toContain(`claims backfill status: ${item.expected}`);
        }
        database
            .prepare(
                `INSERT INTO claim_backfill_failures
                (phase, item_kind, item_key, reason_code, detail, disposition, rationale, created_at, updated_at)
             VALUES ('relationships', 'lineage', 'test-warning', 'operator-warning', '', 'warning', 'reviewed', 1, 1)`,
            )
            .run();
        const messages: string[] = [];
        await runClaimsBackfillCommands(makeHarness(database, messages), {
            checkClaimsBackfill: true,
        });
        expect(messages.join("\n")).toContain("claims backfill status: complete-with-warnings");
    });

    it("status lists blocking failures ahead of older warnings", async () => {
        const database = makeDb();
        const insertFailure = database.prepare(
            `INSERT INTO claim_backfill_failures
                (phase, item_kind, item_key, reason_code, detail, disposition, rationale, created_at, updated_at)
             VALUES ('relationships', 'lineage', ?, ?, '', ?, ?, 1, 1)`,
        );
        for (let index = 0; index < 12; index += 1) {
            insertFailure.run(`warning-${index}`, "operator-warning", "warning", "reviewed");
        }
        insertFailure.run("blocking-item", "dangling-lineage", "blocking", null);

        const messages: string[] = [];
        await runClaimsBackfillCommands(makeHarness(database, messages), {
            checkClaimsBackfill: true,
        });

        const failureLines = messages.filter((message) => message.includes("failure #"));
        expect(failureLines).toHaveLength(10);
        expect(failureLines[0]).toContain("[blocking]");
        expect(failureLines[0]).toContain("dangling-lineage");
    });
});

describe("doctor v22 backfill commands", () => {
    it("--check-v22-backfill reports status", async () => {
        const database = makeDb();
        const messages: string[] = [];

        const result = await runV22BackfillCommands(makeHarness(database, messages), {
            checkV22Backfill: true,
        });

        expect(result).toEqual({ handled: true, exitCode: 0 });
        expect(messages.join("\n")).toContain("v22 backfill status: pending");
    });

    it("--retry-v22-backfill with no failures is a no-op and marks completed", async () => {
        const database = makeDb();
        const messages: string[] = [];

        const result = await runV22BackfillCommands(makeHarness(database, messages), {
            retryV22Backfill: true,
        });

        expect(result.exitCode).toBe(0);
        expect(messages.join("\n")).toContain("No v22 backfill failures to retry.");
        expect(metaValue(database, "v22_legacy_memory_backfill")).toBe("completed");
    });

    it("--retry-v22-backfill clears successful retries and sets status completed", async () => {
        const database = makeDb();
        const dir = makeTempDir();
        const rowId = insertMemory(database, dir, "retry");
        database
            .prepare(
                `INSERT INTO v22_backfill_failures
                    (table_name, row_id, raw_project_path, error_class, error_message, failed_at)
                 VALUES ('memories', ?, ?, 'permission_denied', 'permission denied', 1)`,
            )
            .run(rowId, dir);
        database
            .prepare(
                "UPDATE schema_migrations_meta SET value = 'completed_with_failures' WHERE key = 'v22_legacy_memory_backfill'",
            )
            .run();
        const messages: string[] = [];

        const result = await runV22BackfillCommands(makeHarness(database, messages), {
            retryV22Backfill: true,
        });

        expect(result.exitCode).toBe(0);
        const failures = database
            .prepare("SELECT COUNT(*) AS count FROM v22_backfill_failures")
            .get() as { count: number };
        expect(failures.count).toBe(0);
        expect(metaValue(database, "v22_legacy_memory_backfill")).toBe("completed");
        const memory = database
            .prepare("SELECT project_path FROM memories WHERE id = ?")
            .get(rowId) as {
            project_path: string;
        };
        expect(memory.project_path).toMatch(/^dir:[0-9a-f]{12}$/);
    });

    it("--rekey-v22-dir-identity rekeys matching legacy dir rows", async () => {
        const database = makeDb();
        const dir = makeTempDir();
        const oldIdentity = computeLegacyRustDirIdentity(dir);
        const rowId = insertMemory(database, oldIdentity, "rekey");
        const messages: string[] = [];

        const result = await runV22BackfillCommands(makeHarness(database, messages), {
            rekeyV22DirIdentity: dir,
        });

        expect(result.exitCode).toBe(0);
        const memory = database
            .prepare("SELECT project_path FROM memories WHERE id = ?")
            .get(rowId) as {
            project_path: string;
        };
        expect(memory.project_path).toMatch(/^dir:[0-9a-f]{12}$/);
        expect(memory.project_path).not.toBe(oldIdentity);
        expect(messages.join("\n")).toContain("Re-keyed 1 row(s)");
    });
});
