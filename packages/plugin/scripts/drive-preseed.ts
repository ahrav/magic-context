#!/usr/bin/env bun
/**
 * D5 drive round-2 pre-seed: imports 4 synthetic compartments under the drive
 * session's BARE key via the module's state_import op, so the first
 * compaction's descent has real inheritance to demonstrate (drive-card
 * prerequisite for legs 1/4/5/6). Module-mediated — never raw SQLite against
 * a live module's store.
 *
 * Usage: bun run-preseed.ts <bare-session-key> [--conn <connection-file>]
 * Defaults to the ckdev-rig connection file.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { SubcClient } from "../src/shared/mc-host-client";

const args = process.argv.slice(2);
const session = args[0];
if (!session) {
    console.error("usage: run-preseed.ts <bare-session-key> [--conn <file>]");
    process.exit(1);
}
const connIdx = args.indexOf("--conn");
const connectionFile =
    connIdx >= 0
        ? args[connIdx + 1]
        : join(homedir(), ".local", "share", "cortexkit", "ckdev-rig", "runtime", "subc-connection.json");
const payloadPath = join(dirname(new URL(import.meta.url).pathname), "drive-preseed-payload.json");
let payload: { compartments: unknown[] };
try {
    payload = JSON.parse(readFileSync(payloadPath, "utf8")) as { compartments: unknown[] };
} catch (error) {
    console.error(`failed to read preseed payload ${payloadPath}:`, error);
    process.exit(1);
}

const client = await SubcClient.connect({ connectionFile, handshakeTimeoutMs: 10_000 });
try {
    const route = await client.routeOpen(
        { kind: "tool_provider", module_id: "magic-context" },
        { project_root: process.cwd(), harness: "opencode", session },
    );
    try {
        const body = {
            kind: "state_import",
            v: 1,
            session_id: session,
            import_id: `drive-preseed-${Date.now()}`,
            batch_seq: 0,
            batch_count: 1,
            compartments: payload.compartments,
        };
        console.log(`preseed inputs: session=${session} conn=${connectionFile} payload=${payloadPath} compartments=${payload.compartments.length}`);
        const response = await client.request(route, body, { timeoutMs: 30_000 });
        console.log("state_import response:", JSON.stringify(response, null, 2));
    } finally {
        await client.closeRoute(route).catch(() => undefined);
    }
} finally {
    await client.closeAsync().catch(() => undefined);
}
console.log(`
acceptance checks (run read-only, between beats):
  sqlite3 -readonly ~/.local/share/cortexkit/ckdev-rig/data/cortexkit/magic-context/store.db \\
    "SELECT sequence, start_message, end_message FROM mc_compartments WHERE session_id='${session}' ORDER BY sequence"
  expect 4 rows (1-6 / 7-11 / 12-17 / 18-22), then session.status boundary present,
  and the first m0 render carrying the 4 compartments.`);
