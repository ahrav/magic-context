/**
 * This script measures v10 migration and backfill timing on a production-size database.
 * The measurement uses production code paths instead of the playground script.
 *
 * Steps:
 *
 * Usage:
 *   bun packages/plugin/scripts/measure-v10-migration.ts \
 * --src <pre-v10-backup> \
 *     --oc ~/.local/share/opencode/opencode.db
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

interface Args {
    src: string;
    oc: string;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    const args: Args = { src: "", oc: "" };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--src") args.src = argv[++i] ?? "";
        else if (a === "--oc") args.oc = argv[++i] ?? "";
    }
    if (!args.src || !args.oc) {
        console.error("usage: --src <pre-v10-backup> --oc <opencode.db>");
        process.exit(1);
    }
    if (!existsSync(args.src)) {
        console.error(`source DB not found: ${args.src}`);
        process.exit(1);
    }
    if (!existsSync(args.oc)) {
        console.error(`OpenCode DB not found: ${args.oc}`);
        process.exit(1);
    }
    return args;
}

function fmtMs(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(1)}s`;
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

async function main() {
    const args = parseArgs();

    // The storage layer expects this directory layout under XDG_DATA_HOME.
    const playground = join(tmpdir(), `v10-measure-${Date.now()}`);
    const mcDir = join(playground, "cortexkit", "magic-context");
    const ocDir = join(playground, "opencode");
    mkdirSync(mcDir, { recursive: true });
    mkdirSync(ocDir, { recursive: true });

    const mcPath = join(mcDir, "context.db");
    // ocPath is implicit — storage layer reads via getDataDir() + "opencode/opencode.db"
    const ocPath = join(ocDir, "opencode.db");
    void ocPath;

    console.log("\n=== v10 migration + backfill timing measurement ===");
    console.log(`Source MC DB:  ${args.src}`);
    console.log(`Source MC size: ${fmtBytes(statSync(args.src).size)}`);
    console.log(`Source OC DB:  ${args.oc}`);
    console.log(`Source OC size: ${fmtBytes(statSync(args.oc).size)}`);
    console.log(`Playground:    ${playground}\n`);

    let t0 = Bun.nanoseconds();
    copyFileSync(args.src, mcPath);
    console.log(`Copy MC DB:  ${fmtMs((Bun.nanoseconds() - t0) / 1e6)}`);

    t0 = Bun.nanoseconds();
    copyFileSync(args.oc, ocPath);
    console.log(`Copy OC DB:  ${fmtMs((Bun.nanoseconds() - t0) / 1e6)}`);

    console.log("\n--- Resetting MC copy to pre-v10 state ---");
    const resetDb = new Database(mcPath);
    resetDb.exec("PRAGMA journal_mode=WAL");

    const beforeTags = (
        resetDb
            .prepare("SELECT COUNT(*) as c FROM tags WHERE type='tool'")
            .get() as { c: number }
    ).c;
    console.log(`Tool tags:   ${beforeTags.toLocaleString()}`);

    resetDb.exec("DELETE FROM schema_migrations WHERE version >= 9");

    const cols = resetDb.prepare("PRAGMA table_info(tags)").all() as Array<{
        name: string;
    }>;
    if (cols.some((c) => c.name === "tool_owner_message_id")) {
        resetDb.exec("DROP INDEX IF EXISTS idx_tags_tool_composite");
        resetDb.exec("DROP INDEX IF EXISTS idx_tags_tool_null_owner");
        resetDb.exec("ALTER TABLE tags DROP COLUMN tool_owner_message_id");
    }

    resetDb.exec("DROP TABLE IF EXISTS tool_owner_backfill_state");
    resetDb.exec("DROP TABLE IF EXISTS tool_definition_measurements");

    resetDb.exec("VACUUM");
    resetDb.close();

    const sizeAfterReset = statSync(mcPath).size;
    console.log(`MC size after reset: ${fmtBytes(sizeAfterReset)}`);

    console.log("\n--- Production openDatabase() ---");
    process.env.XDG_DATA_HOME = playground;

    const tStart = Bun.nanoseconds();
    const { openDatabase } = await import(
        "../src/features/magic-context/storage-db"
    );
    const db = openDatabase();
    const tEnd = Bun.nanoseconds();
    const totalMs = (tEnd - tStart) / 1e6;

    console.log(`openDatabase() total: ${fmtMs(totalMs)}`);
    if (!db) throw new Error("openDatabase() returned null (schema fence / storage unavailable)");

    console.log("\n--- Post-migration state ---");
    const versions = db
        .prepare(
            "SELECT version, datetime(applied_at/1000, 'unixepoch', 'localtime') as ts FROM schema_migrations WHERE version >= 9 ORDER BY version",
        )
        .all() as Array<{ version: number; ts: string }>;
    for (const v of versions) {
        console.log(`  v${v.version} applied at ${v.ts}`);
    }

    const tagState = db
        .prepare(
            "SELECT COUNT(*) as total, SUM(CASE WHEN tool_owner_message_id IS NOT NULL THEN 1 ELSE 0 END) as owned FROM tags WHERE type='tool'",
        )
        .get() as { total: number; owned: number };
    const coverage = ((tagState.owned * 100) / tagState.total).toFixed(2);
    console.log(`Tool tags: ${tagState.total.toLocaleString()}`);
    console.log(`Owned:     ${tagState.owned.toLocaleString()} (${coverage}%)`);

    const backfillRows = db
        .prepare(
            "SELECT status, COUNT(*) as c FROM tool_owner_backfill_state GROUP BY status",
        )
        .all() as Array<{ status: string; c: number }>;
    console.log("Backfill outcomes:");
    for (const r of backfillRows) {
        console.log(`  ${r.status}: ${r.c.toLocaleString()}`);
    }

    const finalSize = statSync(mcPath).size;
    console.log(`\nFinal MC DB size: ${fmtBytes(finalSize)}`);
    console.log(`Net total time: ${fmtMs(totalMs)}`);
    console.log(`Playground left at: ${playground}\n`);

    db.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
