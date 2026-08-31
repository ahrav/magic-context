/**
 *
 * The script backfills the oldest assistant message ID for each tool tag's callID.
 *
 * Usage:
 *   bun packages/plugin/scripts/playground-migrate-tag-owners.ts \
 *     --mc /tmp/mc-tag-migration-playground/context.db \
 *     --oc /tmp/mc-tag-migration-playground/opencode.db \
 *     [--dry-run]
 *
 * The script is read-only on the OpenCode DB. The MC DB is mutated
 * unless --dry-run is passed.
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";

interface Args {
    mcPath: string;
    ocPath: string;
    dryRun: boolean;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    const args: Args = {
        mcPath: "",
        ocPath: "",
        dryRun: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--mc") args.mcPath = argv[++i];
        else if (a === "--oc") args.ocPath = argv[++i];
        else if (a === "--dry-run") args.dryRun = true;
    }
    if (!args.mcPath || !args.ocPath) {
        console.error("usage: --mc <context.db> --oc <opencode.db> [--dry-run]");
        process.exit(1);
    }
    if (!existsSync(args.mcPath)) {
        console.error(`MC DB not found: ${args.mcPath}`);
        process.exit(1);
    }
    if (!existsSync(args.ocPath)) {
        console.error(`OpenCode DB not found: ${args.ocPath}`);
        process.exit(1);
    }
    return args;
}

function fmtMs(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60_000).toFixed(2)}min`;
}

function fmtCount(n: number): string {
    return n.toLocaleString("en-US");
}

function main() {
    const args = parseArgs();
    console.log("=== tag-owner migration playground ===");
    console.log(`MC DB:       ${args.mcPath} (${(statSync(args.mcPath).size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`OpenCode DB: ${args.ocPath} (${(statSync(args.ocPath).size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`Mode:        ${args.dryRun ? "DRY RUN (no writes)" : "APPLYING CHANGES"}`);
    console.log("");

    const mc = new Database(args.mcPath);
    mc.exec("PRAGMA journal_mode=WAL");
    mc.exec("PRAGMA synchronous=NORMAL");
    mc.exec(`ATTACH '${args.ocPath}' AS oc`);

    const t0 = performance.now();
    const cols = mc
        .prepare("PRAGMA table_info(tags)")
        .all() as Array<{ name: string }>;
    const hasOwnerCol = cols.some((c) => c.name === "tool_owner_message_id");
    if (!hasOwnerCol) {
        console.log("Step 1: ALTER TABLE tags ADD tool_owner_message_id");
        if (args.dryRun) {
            console.log("  DRY RUN: would ADD COLUMN. Adding to in-memory schema for measurement,");
            console.log("           will ROLLBACK at end so no on-disk change.");
            mc.exec("BEGIN");
            mc.exec("ALTER TABLE tags ADD COLUMN tool_owner_message_id TEXT DEFAULT NULL");
            // UPDATE statements execute before ROLLBACK.
            // ROLLBACK removes the added column and all dry-run updates.
        } else {
            mc.exec("ALTER TABLE tags ADD COLUMN tool_owner_message_id TEXT DEFAULT NULL");
        }
        console.log(`  done in ${fmtMs(performance.now() - t0)}`);
    } else {
        console.log("Step 1: column already exists (skipping ALTER TABLE)");
    }
    console.log("");

    // Query each session once instead of issuing one point query per tool tag.
    console.log("Step 2: backfill tool_owner_message_id");
    const t1 = performance.now();

    const sessionsWithToolTagsRow = mc
        .prepare(
            `SELECT DISTINCT session_id FROM tags WHERE type='tool' AND tool_owner_message_id IS NULL`,
        )
        .all() as Array<{ session_id: string }>;
    const totalSessions = sessionsWithToolTagsRow.length;
    console.log(`  Sessions to process: ${fmtCount(totalSessions)}`);

    // Prepared statements.
    // Mirror packages/plugin/src/hooks/magic-context/tool-drop-target.ts
    //   - type='tool' or type='tool-invocation' → callID lives in $.callID
    //   - type='tool_use' (Anthropic shape) → callID lives in $.id
    // We only want assistant-side parts (invocations or OpenCode's combined
    // type='tool' which is also stored on the assistant message).
    const findOwnerStmt = mc.prepare(`
        SELECT
            COALESCE(
                CASE WHEN json_extract(p.data, '$.type') = 'tool_use'
                    THEN json_extract(p.data, '$.id')
                END,
                json_extract(p.data, '$.callID')
            ) AS callid,
            m.id AS owner_id,
            m.time_created AS t_created
        FROM oc.message m
        INNER JOIN oc.part p ON p.message_id = m.id
        WHERE m.session_id = ?
          AND json_extract(m.data, '$.role') = 'assistant'
          AND (
              json_extract(p.data, '$.type') IN ('tool', 'tool-invocation')
                  AND json_extract(p.data, '$.callID') IS NOT NULL
              OR json_extract(p.data, '$.type') = 'tool_use'
                  AND json_extract(p.data, '$.id') IS NOT NULL
          )
    `);

    const updateStmt = mc.prepare(`
        UPDATE tags
        SET tool_owner_message_id = ?
        WHERE session_id = ? AND message_id = ? AND type = 'tool'
          AND tool_owner_message_id IS NULL
    `);

    let totalUpdated = 0;
    let totalUnknown = 0;
    let totalCallIds = 0;
    let sessionsWithNoOwners = 0;
    let sessionsWithSomeUnknown = 0;
    let sessionsProcessed = 0;
    let largestSessionTime = 0;
    let largestSessionId = "";

    // A single transaction avoids per-update commit overhead.
    const updateAll = mc.transaction(
        (
            updates: Array<{ sessionId: string; callId: string; ownerId: string }>,
        ) => {
            for (const u of updates) {
                updateStmt.run(u.ownerId, u.sessionId, u.callId);
            }
        },
    );

    for (const { session_id: sessionId } of sessionsWithToolTagsRow) {
        const sessionStart = performance.now();
        // OpenCode parts map each callID to its oldest assistant message.
        const rows = findOwnerStmt.all(sessionId) as Array<{
            callid: string;
            owner_id: string;
            t_created: number;
        }>;

        const oldestByCallId = new Map<string, { ownerId: string; tCreated: number }>();
        for (const r of rows) {
            const existing = oldestByCallId.get(r.callid);
            if (!existing || r.t_created < existing.tCreated) {
                oldestByCallId.set(r.callid, {
                    ownerId: r.owner_id,
                    tCreated: r.t_created,
                });
            }
        }

        const toolTagRows = mc
            .prepare(
                `SELECT message_id FROM tags WHERE session_id=? AND type='tool' AND tool_owner_message_id IS NULL`,
            )
            .all(sessionId) as Array<{ message_id: string }>;

        const updates: Array<{ sessionId: string; callId: string; ownerId: string }> = [];
        let unknownInSession = 0;
        for (const t of toolTagRows) {
            const callId = t.message_id;
            const owner = oldestByCallId.get(callId);
            totalCallIds++;
            if (owner) {
                updates.push({ sessionId, callId, ownerId: owner.ownerId });
                totalUpdated++;
            } else {
                totalUnknown++;
                unknownInSession++;
            }
        }

        if (updates.length === 0) {
            sessionsWithNoOwners++;
        } else if (unknownInSession > 0) {
            sessionsWithSomeUnknown++;
        }

        if (!args.dryRun && updates.length > 0) {
            updateAll(updates);
        }

        const sessionElapsed = performance.now() - sessionStart;
        if (sessionElapsed > largestSessionTime) {
            largestSessionTime = sessionElapsed;
            largestSessionId = sessionId;
        }

        sessionsProcessed++;
        if (sessionsProcessed % 200 === 0) {
            const elapsed = performance.now() - t1;
            const rate = sessionsProcessed / (elapsed / 1000);
            const eta = (totalSessions - sessionsProcessed) / rate;
            console.log(
                `  ${sessionsProcessed}/${totalSessions} sessions  ` +
                    `elapsed=${fmtMs(elapsed)}  rate=${rate.toFixed(0)}/s  eta=${fmtMs(eta * 1000)}`,
            );
        }
    }

    const t2 = performance.now();
    const totalDuration = t2 - t1;

    console.log("");
    console.log("=== Step 2 complete ===");
    console.log(`  Total time:                    ${fmtMs(totalDuration)}`);
    console.log(`  Sessions processed:            ${fmtCount(sessionsProcessed)}`);
    console.log(`  Tool tag rows examined:        ${fmtCount(totalCallIds)}`);
    console.log(`  Owners resolved (updated):     ${fmtCount(totalUpdated)}`);
    console.log(`  Unknown owners (NULL kept):    ${fmtCount(totalUnknown)}`);
    console.log(`  Coverage:                      ${((totalUpdated / Math.max(totalCallIds, 1)) * 100).toFixed(2)}%`);
    console.log(`  Sessions with no owners found: ${fmtCount(sessionsWithNoOwners)}`);
    console.log(`  Sessions with partial unknown: ${fmtCount(sessionsWithSomeUnknown)}`);
    console.log(`  Slowest session:               ${largestSessionId} took ${fmtMs(largestSessionTime)}`);
    console.log("");

    console.log("Step 3: validate post-migration invariants");
    const t3 = performance.now();

    // Invariant 1: every tool tag has either NULL owner OR owner exists in OpenCode session
    const orphanCount = mc
        .prepare(
            `SELECT COUNT(*) AS n FROM tags t
              WHERE t.type='tool' AND t.tool_owner_message_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM oc.message m
                  WHERE m.id = t.tool_owner_message_id AND m.session_id = t.session_id
                )`,
        )
        .get() as { n: number };
    console.log(
        `  Tool tags with non-NULL owner that DOESN'T exist in OpenCode: ${orphanCount.n}`,
    );

    // tool_owner_message_id distinguishes tool tags that share a (session, callID) but have different owners.
    const collisions = mc
        .prepare(
            `SELECT session_id, message_id AS callid,
                    COUNT(DISTINCT tool_owner_message_id) AS distinct_owners,
                    COUNT(*) AS total_rows,
                    GROUP_CONCAT(tag_number || ':' || COALESCE(tool_owner_message_id, 'NULL') || ':' || status) AS detail
               FROM tags
               WHERE type='tool'
               GROUP BY session_id, message_id
               HAVING distinct_owners > 1 OR total_rows > 1`,
        )
        .all() as Array<{
            session_id: string;
            callid: string;
            distinct_owners: number;
            total_rows: number;
            detail: string;
        }>;
    console.log(`  Collision groups (multiple tags for same session+callID): ${collisions.length}`);
    if (collisions.length > 0) {
        console.log("    Example collisions:");
        for (const c of collisions.slice(0, 5)) {
            console.log(`      session=${c.session_id} callid=${c.callid} owners=${c.distinct_owners} rows=${c.total_rows}`);
            console.log(`        detail: ${c.detail.slice(0, 200)}`);
        }
    }

    const nullStats = mc
        .prepare(
            `SELECT COUNT(*) AS total_null,
                    SUM(CASE WHEN status='dropped' THEN 1 ELSE 0 END) AS null_dropped,
                    SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS null_active
               FROM tags WHERE type='tool' AND tool_owner_message_id IS NULL`,
        )
        .get() as { total_null: number; null_dropped: number; null_active: number };
    console.log(`  NULL-owner tool tags (orphaned legacy):`);
    console.log(`    total: ${fmtCount(nullStats.total_null)} (active=${fmtCount(nullStats.null_active)} dropped=${fmtCount(nullStats.null_dropped)})`);

    const failedSessions = mc
        .prepare(
            `SELECT t.session_id, COUNT(*) AS unmapped_tags,
                    EXISTS(SELECT 1 FROM oc.session s WHERE s.id = t.session_id) AS oc_session_exists
               FROM tags t
               WHERE t.type='tool' AND t.tool_owner_message_id IS NULL
               GROUP BY t.session_id
               ORDER BY unmapped_tags DESC LIMIT 10`,
        )
        .all() as Array<{ session_id: string; unmapped_tags: number; oc_session_exists: number }>;
    if (failedSessions.length > 0) {
        console.log(`  Top sessions with unmapped tags:`);
        for (const f of failedSessions) {
            console.log(`    ${f.session_id}: ${f.unmapped_tags} unmapped, oc_session_exists=${f.oc_session_exists ? "yes" : "NO"}`);
        }
    }

    const bug = mc
        .prepare(
            `SELECT tag_number, status, message_id, tool_owner_message_id
               FROM tags
               WHERE session_id='ses_2071b0b2bffeNaYhnUUWZsCUvX'
                 AND message_id IN ('read:32', 'grep:30', 'glob:31')
               ORDER BY tag_number`,
        )
        .all();
    console.log(`  User's session ses_2071b0b2bffeNaYhnUUWZsCUvX collision-callIDs:`);
    for (const r of bug as Array<Record<string, unknown>>) {
        console.log(`    ${JSON.stringify(r)}`);
    }

    console.log(`  Validation took ${fmtMs(performance.now() - t3)}`);
    console.log("");

    if (args.dryRun && !hasOwnerCol) {
        console.log("\nDRY RUN: rolling back schema change…");
        mc.exec("ROLLBACK");
    }

    console.log("=== Total wall time:", fmtMs(performance.now() - t0), "===");

    mc.close();
}

main();
