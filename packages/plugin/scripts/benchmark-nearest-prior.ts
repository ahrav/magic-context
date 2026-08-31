/* eslint-disable no-console */
/**
 *
 *
 *
 * Run:
 *
 * Requires:
 *     XDG_DATA_HOME equivalent)
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/shared/sqlite";

const sessionId = process.argv[2];
if (!sessionId) {
    console.error(
        "usage: bun packages/plugin/scripts/benchmark-nearest-prior.ts <sessionId>",
    );
    process.exit(1);
}

const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const mcDbPath = join(dataHome, "cortexkit", "magic-context", "db.sqlite");
const ocDbPath = join(dataHome, "opencode", "storage", "sqlite", "db.sqlite");

if (!existsSync(mcDbPath)) {
    console.error(`magic-context DB not found at ${mcDbPath}`);
    process.exit(1);
}
if (!existsSync(ocDbPath)) {
    console.error(`opencode DB not found at ${ocDbPath}`);
    process.exit(1);
}

const db = new Database(mcDbPath, { readonly: true });
db.exec(`ATTACH '${ocDbPath}' AS oc`);

const candidateRows = db
    .prepare(
        `SELECT t.message_id AS callId, m.id AS currentMessageId
         FROM tags t
         JOIN oc.message m ON m.session_id = t.session_id
         WHERE t.session_id = ?
           AND t.type = 'tool'
           AND t.tool_owner_message_id IS NOT NULL
         ORDER BY RANDOM()
         LIMIT 10000`,
    )
    .all(sessionId) as Array<{ callId: string; currentMessageId: string }>;

if (candidateRows.length === 0) {
    console.error(
        `No tool tags found for session ${sessionId}. Backfill may not have run.`,
    );
    process.exit(1);
}

console.log(`Benchmarking with ${candidateRows.length} samples...`);

const stmt = db.prepare(
    `WITH current_msg AS (
         SELECT time_created, id
         FROM oc.message
         WHERE session_id = :sessionId AND id = :currentMessageId
     )
     SELECT t.tool_owner_message_id
     FROM tags t
     INNER JOIN oc.message m
         ON m.id = t.tool_owner_message_id
        AND m.session_id = t.session_id
     WHERE t.session_id = :sessionId
       AND t.message_id = :callId
       AND t.type = 'tool'
       AND t.tool_owner_message_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM current_msg)
       AND (
           m.time_created < (SELECT time_created FROM current_msg)
           OR (m.time_created = (SELECT time_created FROM current_msg)
               AND m.id < (SELECT id FROM current_msg))
       )
     ORDER BY m.time_created DESC, m.id DESC
     LIMIT 1`,
);

// The benchmark excludes 1,000 warm-up queries from timed samples.
for (let i = 0; i < 1000; i += 1) {
    const row = candidateRows[i % candidateRows.length];
    stmt.get({
        sessionId,
        callId: row.callId,
        currentMessageId: row.currentMessageId,
    });
}

const samples: number[] = [];
for (const row of candidateRows) {
    const start = performance.now();
    stmt.get({
        sessionId,
        callId: row.callId,
        currentMessageId: row.currentMessageId,
    });
    samples.push(performance.now() - start);
}

samples.sort((a, b) => a - b);
const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
const p50 = samples[Math.floor(samples.length * 0.5)];
const p95 = samples[Math.floor(samples.length * 0.95)];
const p99 = samples[Math.floor(samples.length * 0.99)];

console.log(`Session: ${sessionId}`);
console.log(`Samples: ${samples.length}`);
console.log(`avg:  ${avg.toFixed(4)} ms`);
console.log(`p50:  ${(p50 ?? 0).toFixed(4)} ms`);
console.log(`p95:  ${(p95 ?? 0).toFixed(4)} ms`);
console.log(`p99:  ${(p99 ?? 0).toFixed(4)} ms`);
console.log("");
console.log("Plan §Layer C budget: avg ≤ 0.5 ms");
if (avg <= 0.5) {
    console.log(`✅ Under budget by ${(0.5 / avg).toFixed(1)}× — JOIN-only stays.`);
} else {
    console.log(
        `⚠️  Over budget by ${(avg / 0.5).toFixed(1)}× — consider migration v11 (denormalized tool_owner_time_created).`,
    );
}
