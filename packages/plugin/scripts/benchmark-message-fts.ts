#!/usr/bin/env bun
/**
 * Benchmark message FTS path against the live production DB.
 *
 * Measures every step of `searchMessages` independently so we can tell whether
 * the 3-second auto-search slowdown lives in:
 *   1. readRawSessionMessages (reading raw OpenCode session history)
 *   2. getLastIndexedOrdinal (cheap SQL lookup)
 *   3. messagesToInsert.map (CPU work building insert rows)
 *   4. FTS5 INSERT loop (the actual indexing)
 *   5. FTS5 SELECT (the search itself, post-index)
 *   6. unifiedSearch with message source only against already-populated FTS
 *
 * Usage:
 *   bun packages/plugin/scripts/benchmark-message-fts.ts <session_id> "<query>"
 *   bun packages/plugin/scripts/benchmark-message-fts.ts ses_331acff95fferWZOYF1pG0cjOn "auto search"
 */

import { getMagicContextStorageDir } from "../src/shared/data-path";
import { Database } from "../src/shared/sqlite";
import { readRawSessionMessagesFromDb } from "../src/hooks/magic-context/read-session-raw";
import { join } from "node:path";
import { unifiedSearch } from "../src/features/magic-context/search";

const sessionId = process.argv[2];
const query = process.argv[3] ?? "test query";

if (!sessionId) {
    console.error("Usage: bun benchmark-message-fts.ts <session_id> [query]");
    process.exit(1);
}

const dbPath = join(getMagicContextStorageDir(), "context.db");
console.log(`DB: ${dbPath}`);
console.log(`Session: ${sessionId}`);
console.log(`Query: "${query}"`);
console.log();

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode=WAL");

const originalFtsRows = db
    .prepare(
        "SELECT rowid, session_id, message_ordinal, message_id, role, content FROM message_history_fts WHERE session_id = ?",
    )
    .all(sessionId) as Array<{
    rowid: number;
    session_id: string;
    message_ordinal: number;
    message_id: string;
    role: string;
    content: string;
}>;
const originalIndexRow = db
    .prepare(
        "SELECT session_id, last_indexed_ordinal, updated_at, harness FROM message_history_index WHERE session_id = ?",
    )
    .get(sessionId) as
    | { session_id: string; last_indexed_ordinal: number; updated_at: number; harness: string }
    | null;

function restoreOriginalIndexState(): void {
    const deleteFts = db.prepare("DELETE FROM message_history_fts WHERE session_id = ?");
    const restoreFts = db.prepare(
        "INSERT INTO message_history_fts (rowid, session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const deleteIndex = db.prepare("DELETE FROM message_history_index WHERE session_id = ?");
    const restoreIndex = db.prepare(
        "INSERT INTO message_history_index (session_id, last_indexed_ordinal, updated_at, harness) VALUES (?, ?, ?, ?)",
    );

    db.transaction(() => {
        deleteFts.run(sessionId);
        for (const row of originalFtsRows) {
            restoreFts.run(
                row.rowid,
                row.session_id,
                row.message_ordinal,
                row.message_id,
                row.role,
                row.content,
            );
        }
        deleteIndex.run(sessionId);
        if (originalIndexRow) {
            restoreIndex.run(
                originalIndexRow.session_id,
                originalIndexRow.last_indexed_ordinal,
                originalIndexRow.updated_at,
                originalIndexRow.harness,
            );
        }
    })();
}

// === Step 1: readRawSessionMessages ===
// We open OpenCode's DB read-only to mirror what the plugin does at runtime.
const opencodeDbPath = `${process.env.HOME}/.local/share/opencode/opencode.db`;
const opencodeDb = new Database(opencodeDbPath, { readonly: true });

const t1 = performance.now();
const messages = readRawSessionMessagesFromDb(opencodeDb, sessionId);
const t2 = performance.now();
console.log(
    `[1] readRawSessionMessagesFromDb: ${(t2 - t1).toFixed(1)}ms (count=${messages.length})`,
);

if (messages.length === 0) {
    console.log("No messages found — exiting.");
    process.exit(0);
}

// === Step 2: getLastIndexedOrdinal ===
const t3 = performance.now();
const lastIndexedRow = db
    .prepare("SELECT last_indexed_ordinal FROM message_history_index WHERE session_id = ?")
    .get(sessionId) as { last_indexed_ordinal?: number } | null;
const lastIndexedOrdinal = lastIndexedRow?.last_indexed_ordinal ?? 0;
const t4 = performance.now();
console.log(
    `[2] getLastIndexedOrdinal: ${(t4 - t3).toFixed(1)}ms (lastIndexed=${lastIndexedOrdinal} messages.length=${messages.length})`,
);

// === Step 3: count indexed FTS rows for this session right now ===
const t5 = performance.now();
const ftsCount = db
    .prepare("SELECT COUNT(*) AS c FROM message_history_fts WHERE session_id = ?")
    .get(sessionId) as { c: number };
const t6 = performance.now();
console.log(
    `[3] message_history_fts row count: ${(t6 - t5).toFixed(1)}ms (rows=${ftsCount.c})`,
);

// === Step 4: only-if-needed indexing path (mimic searchMessages) ===
if (lastIndexedOrdinal < messages.length) {
    console.log(`\n  --> Index is stale, would insert ${messages.length - lastIndexedOrdinal} rows`);

    // Build insert rows (CPU only, no DB writes)
    const t7 = performance.now();
    const messagesToInsert = messages
        .filter((m) => m.ordinal > lastIndexedOrdinal)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
            // Mirror getIndexableContent's text extraction
            const texts: string[] = [];
            for (const part of m.parts as Array<{ type?: string; text?: string }>) {
                if (part?.type === "text" && typeof part.text === "string") {
                    texts.push(part.text.replace(/\s+/g, " ").trim());
                }
            }
            return {
                ordinal: m.ordinal,
                id: m.id,
                role: m.role,
                content: texts.filter((t) => t.length > 0).join(" / "),
            };
        })
        .filter((m) => m.content.length > 0);
    const t8 = performance.now();
    console.log(
        `[4] build insert rows (CPU only): ${(t8 - t7).toFixed(1)}ms (rows=${messagesToInsert.length})`,
    );

    // Total content size (proxy for how heavy the FTS work is)
    const totalChars = messagesToInsert.reduce((sum, m) => sum + m.content.length, 0);
    console.log(`    total content chars across ${messagesToInsert.length} rows: ${totalChars} (${(totalChars / 1024).toFixed(1)} KB)`);

    // === Step 5: actually do the FTS inserts in a transaction ===
    // This is the hot path that's blocking auto-search.
    const insertStmt = db.prepare(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
    );

    const t9 = performance.now();
    db.transaction(() => {
        for (const m of messagesToInsert) {
            insertStmt.run(sessionId, m.ordinal, m.id, m.role, m.content);
        }
    })();
    const t10 = performance.now();
    console.log(
        `[5] FTS5 INSERT transaction: ${(t10 - t9).toFixed(1)}ms (${messagesToInsert.length} rows = ${((t10 - t9) / messagesToInsert.length).toFixed(2)}ms/row)`,
    );

    // Roll it back so we can rerun the script idempotently
    const t11 = performance.now();
    db.prepare("DELETE FROM message_history_fts WHERE session_id = ?").run(sessionId);
    const t12 = performance.now();
    console.log(
        `[6] cleanup DELETE: ${(t12 - t11).toFixed(1)}ms`,
    );
} else {
    console.log(`[4-6] SKIPPED — already fully indexed`);
}

// === Step 7: actual search query (assuming index exists) ===
// Pre-populate the index for this benchmark run since we just deleted it
const insertStmt = db.prepare(
    "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
);
const messagesToInsert = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
        const texts: string[] = [];
        for (const part of m.parts as Array<{ type?: string; text?: string }>) {
            if (part?.type === "text" && typeof part.text === "string") {
                texts.push(part.text.replace(/\s+/g, " ").trim());
            }
        }
        return {
            ordinal: m.ordinal,
            id: m.id,
            role: m.role,
            content: texts.filter((t) => t.length > 0).join(" / "),
        };
    })
    .filter((m) => m.content.length > 0);

const t13 = performance.now();
db.transaction(() => {
    for (const m of messagesToInsert) {
        insertStmt.run(sessionId, m.ordinal, m.id, m.role, m.content);
    }
})();
const t14 = performance.now();
console.log(
    `\n[7] re-populate FTS for query benchmark: ${(t14 - t13).toFixed(1)}ms`,
);

const sanitizedQuery = query.split(/\s+/).filter((t) => t.length > 0).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
const searchStmt = db.prepare(
    "SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?",
);

// First query (cold cache)
const t15 = performance.now();
const rows1 = searchStmt.all(sessionId, sanitizedQuery, 30);
const t16 = performance.now();
console.log(
    `[8] FTS SELECT (cold cache, sanitized="${sanitizedQuery}"): ${(t16 - t15).toFixed(1)}ms (rows=${rows1.length})`,
);

// Second query (warm cache)
const t17 = performance.now();
const rows2 = searchStmt.all(sessionId, sanitizedQuery, 30);
const t18 = performance.now();
console.log(
    `[9] FTS SELECT (warm cache): ${(t18 - t17).toFixed(1)}ms (rows=${rows2.length})`,
);

const t19 = performance.now();
const searchOnlyResults = await unifiedSearch(db, sessionId, process.cwd(), query, {
    memoryEnabled: false,
    embeddingEnabled: false,
    embedQuery: async () => null,
    isEmbeddingRuntimeEnabled: () => true,
    sources: ["message"],
    limit: 10,
});
const t20 = performance.now();
console.log(
    `[10] unifiedSearch message-only hot path: ${(t20 - t19).toFixed(1)}ms (rows=${searchOnlyResults.length})`,
);

// Cleanup
restoreOriginalIndexState();
db.close();
opencodeDb.close();

console.log("\nDone.");
