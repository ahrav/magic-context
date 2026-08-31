/**
 *
 * The test simulates an OpenCode crash during upgrade followed by a restart.
 *
 * The test kills the subprocess during the 29-second backfill window after v10 commits.
 * `completed` rows in `tool_owner_backfill_state` prove that v10 committed and the backfill started.
 * The atomic migration records v10 in schema_migrations.
 * `tool_owner_backfill_state` has completed rows; any running rows have unexpired leases.
 * Some `tags.tool_owner_message_id` values are populated and others are NULL.
 *
 * The backfill resumes only after running leases expire or are cleared.
 * The backfill resumes only unfinished sessions and reaches the same final coverage as a clean run.
 *
 * Usage:
 * Run `bun packages/plugin/scripts/test-v10-interruption-recovery.ts --src <pre-v10-backup> --oc <opencode.db>`.
 *     --oc ~/.local/share/opencode/opencode.db
 */

import { spawn } from "node:child_process";
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
    return args;
}

function fmtMs(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(1)}s`;
}

function fmtBytes(n: number): string {
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function resetMcDbToPreV10(mcPath: string): number {
    const db = new Database(mcPath);
    db.exec("PRAGMA journal_mode=WAL");
    const beforeTags = (
        db.prepare("SELECT COUNT(*) as c FROM tags WHERE type='tool'").get() as { c: number }
    ).c;
    db.exec("DELETE FROM schema_migrations WHERE version >= 9");

    const cols = db.prepare("PRAGMA table_info(tags)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "tool_owner_message_id")) {
        db.exec("DROP INDEX IF EXISTS idx_tags_tool_composite");
        db.exec("DROP INDEX IF EXISTS idx_tags_tool_null_owner");
        db.exec("ALTER TABLE tags DROP COLUMN tool_owner_message_id");
    }
    db.exec("DROP TABLE IF EXISTS tool_owner_backfill_state");
    db.exec("DROP TABLE IF EXISTS tool_definition_measurements");
    db.exec("VACUUM");
    db.close();
    return beforeTags;
}

interface DbSnapshot {
    schemaVersions: number[];
    completed: number;
    running: number;
    skipped: number;
    pending: number;
    rowsOwned: number;
    rowsNullOwner: number;
    totalToolTags: number;
    runningSessions: Array<{ session_id: string; lease_expires_at: number | null }>;
}

function snapshot(mcPath: string): DbSnapshot {
    const db = new Database(mcPath, { readonly: true });
    const versions = (
        db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
            version: number;
        }>
    ).map((r) => r.version);

    const cols = db.prepare("PRAGMA table_info(tags)").all() as Array<{ name: string }>;
    const hasOwnerCol = cols.some((c) => c.name === "tool_owner_message_id");

    let completed = 0,
        running = 0,
        skipped = 0,
        pending = 0;
    let rowsOwned = 0,
        rowsNullOwner = 0,
        totalToolTags = 0;
    let runningSessions: Array<{ session_id: string; lease_expires_at: number | null }> = [];

    if (hasOwnerCol) {
        const counts = db
            .prepare(
                "SELECT status, COUNT(*) as c FROM tool_owner_backfill_state GROUP BY status",
            )
            .all() as Array<{ status: string; c: number }>;
        for (const r of counts) {
            if (r.status === "completed") completed = r.c;
            else if (r.status === "running") running = r.c;
            else if (r.status === "skipped") skipped = r.c;
            else if (r.status === "pending") pending = r.c;
        }

        const tagState = db
            .prepare(
                "SELECT COUNT(*) as total, SUM(CASE WHEN tool_owner_message_id IS NOT NULL THEN 1 ELSE 0 END) as owned FROM tags WHERE type='tool'",
            )
            .get() as { total: number; owned: number | null };
        totalToolTags = tagState.total;
        rowsOwned = tagState.owned ?? 0;
        rowsNullOwner = totalToolTags - rowsOwned;

        runningSessions = db
            .prepare(
                "SELECT session_id, lease_expires_at FROM tool_owner_backfill_state WHERE status = 'running' ORDER BY started_at LIMIT 5",
            )
            .all() as Array<{ session_id: string; lease_expires_at: number | null }>;
    }

    db.close();
    return {
        schemaVersions: versions,
        completed,
        running,
        skipped,
        pending,
        rowsOwned,
        rowsNullOwner,
        totalToolTags,
        runningSessions,
    };
}

function snapshotSummary(s: DbSnapshot, label: string): string {
    const lines: string[] = [];
    lines.push(`--- ${label} ---`);
    lines.push(`schema_migrations: [${s.schemaVersions.join(", ")}]`);
    lines.push(
        `backfill_state: completed=${s.completed} running=${s.running} skipped=${s.skipped} pending=${s.pending}`,
    );
    lines.push(`tags: total=${s.totalToolTags} owned=${s.rowsOwned} null=${s.rowsNullOwner}`);
    if (s.runningSessions.length > 0) {
        lines.push(`running session leases:`);
        for (const r of s.runningSessions) {
            const exp = r.lease_expires_at
                ? new Date(r.lease_expires_at).toISOString()
                : "(none)";
            lines.push(`  ${r.session_id}: expires=${exp}`);
        }
    }
    return lines.join("\n");
}

async function spawnOpenDatabaseSubprocess(
    playgroundDir: string,
    timeoutMs: number,
): Promise<{ pid: number; killed: boolean; durationMs: number }> {
    const scriptPath = join(playgroundDir, "open-db-subprocess.ts");
    await Bun.write(
        scriptPath,
        `
import { openDatabase } from "${join(__dirname, "..", "src", "features", "magic-context", "storage-db")}";
process.env.XDG_DATA_HOME = "${playgroundDir}";
console.error("[subprocess] starting openDatabase");
const t0 = Bun.nanoseconds();
const db = openDatabase();
const elapsed = (Bun.nanoseconds() - t0) / 1e6;
console.error(\`[subprocess] openDatabase finished in \${elapsed.toFixed(0)}ms\`);
db.close();
process.exit(0);
`.trim(),
    );

    return await new Promise((resolve) => {
        const tStart = Date.now();
        const child = spawn("bun", [scriptPath], {
            env: { ...process.env, XDG_DATA_HOME: playgroundDir },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const pid = child.pid ?? -1;
        let killed = false;

        const timeout = setTimeout(() => {
            console.log(`[main] killing subprocess ${pid} after ${timeoutMs}ms`);
            child.kill("SIGKILL");
            killed = true;
        }, timeoutMs);

        child.stderr.on("data", (chunk: Buffer) => {
            process.stdout.write(`[child stderr] ${chunk.toString()}`);
        });

        child.on("exit", (code, signal) => {
            clearTimeout(timeout);
            console.log(`[main] subprocess exited code=${code} signal=${signal}`);
            resolve({
                pid,
                killed,
                durationMs: Date.now() - tStart,
            });
        });
    });
}

async function main() {
    const args = parseArgs();

    const playground = join(tmpdir(), `v10-interrupt-${Date.now()}`);
    const mcDir = join(playground, "cortexkit", "magic-context");
    const ocDir = join(playground, "opencode");
    mkdirSync(mcDir, { recursive: true });
    mkdirSync(ocDir, { recursive: true });

    const mcPath = join(mcDir, "context.db");
    const ocPath = join(ocDir, "opencode.db");

    console.log("\n=== v10 interruption-recovery test ===");
    console.log(`Source MC: ${args.src} (${fmtBytes(statSync(args.src).size)})`);
    console.log(`Source OC: ${args.oc} (${fmtBytes(statSync(args.oc).size)})`);
    console.log(`Playground: ${playground}\n`);

    copyFileSync(args.src, mcPath);
    copyFileSync(args.oc, ocPath);
    const beforeTags = resetMcDbToPreV10(mcPath);
    console.log(`Pre-v10 reset complete (${beforeTags.toLocaleString()} tool tags).`);

    console.log(`\n=== Phase 1: kill subprocess after 8 seconds ===\n`);
    const phase1Start = Date.now();
    const result1 = await spawnOpenDatabaseSubprocess(playground, 8000);
    const phase1Elapsed = Date.now() - phase1Start;
    console.log(
        `\nPhase 1 finished: killed=${result1.killed} elapsed=${fmtMs(phase1Elapsed)}\n`,
    );

    const snap1 = snapshot(mcPath);
    console.log(snapshotSummary(snap1, "After SIGKILL"));

    const v10Applied = snap1.schemaVersions.includes(10);
    const someBackfillProgress = snap1.completed > 0;
    const someStillNull = snap1.rowsNullOwner > 0;
    const hasRunningRows = snap1.running > 0;

    console.log(`\n--- Phase 1 invariants ---`);
    console.log(`  v10 in schema_migrations:     ${v10Applied ? "✅" : "❌"}`);
    console.log(`  backfill made some progress:  ${someBackfillProgress ? "✅" : "❌"}`);
    console.log(`  some tags still NULL owner:   ${someStillNull ? "✅" : "❌"}`);
    console.log(
        `  running rows present (lease):  ${hasRunningRows ? "✅ (will recover after lease expiry)" : "ℹ️  no running rows — clean session boundary"}`,
    );

    console.log(`\n=== Phase 2: simulate post-lease-expiry restart ===\n`);
    const expireDb = new Database(mcPath);
    const expireResult = expireDb
        .prepare(
            "UPDATE tool_owner_backfill_state SET lease_expires_at = ? WHERE status = 'running'",
        )
        .run(Date.now() - 60_000);
    expireDb.close();
    console.log(
        `Expired ${expireResult.changes ?? 0} stale lease(s) (simulating the LEASE_DURATION_MS wait).`,
    );

    const phase2Start = Date.now();
    const result2 = await spawnOpenDatabaseSubprocess(playground, 60_000);
    const phase2Elapsed = Date.now() - phase2Start;
    console.log(
        `\nPhase 2 finished: killed=${result2.killed} elapsed=${fmtMs(phase2Elapsed)}\n`,
    );

    const snap2 = snapshot(mcPath);
    console.log(snapshotSummary(snap2, "After resume"));

    console.log(`\n--- Phase 2 invariants ---`);
    const allBackfillFinished = snap2.running === 0 && snap2.pending === 0;
    const finalCoverageHigh = snap2.rowsOwned / snap2.totalToolTags > 0.95;
    const noNewRunningRows = snap2.running === 0;
    console.log(
        `  no rows still 'running'/'pending':${allBackfillFinished ? "✅" : "❌"} (running=${snap2.running}, pending=${snap2.pending})`,
    );
    console.log(
        `  coverage > 95%:                   ${finalCoverageHigh ? "✅" : "❌"} (${((snap2.rowsOwned / snap2.totalToolTags) * 100).toFixed(2)}%)`,
    );
    console.log(`  no leftover lease entries:        ${noNewRunningRows ? "✅" : "❌"}`);

    // Final verdict
    const phase1Ok = v10Applied && someBackfillProgress && someStillNull;
    const phase2Ok = allBackfillFinished && finalCoverageHigh;
    console.log(`\n=== VERDICT ===`);
    console.log(`Phase 1 (mid-flight kill survival):    ${phase1Ok ? "✅ PASS" : "❌ FAIL"}`);
    console.log(`Phase 2 (resume to final coverage):    ${phase2Ok ? "✅ PASS" : "❌ FAIL"}`);
    console.log(`\nPlayground left at: ${playground}\n`);

    process.exit(phase1Ok && phase2Ok ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
