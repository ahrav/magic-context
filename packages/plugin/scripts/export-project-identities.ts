#!/usr/bin/env bun
/**
 * Export the project-identity inventory as a ck-projects seed_import corpus.
 *
 * One JSONL line per identity:
 * Each line is a JSON object with identity, roots, and session_bindings and memory_rows source counts.
 *
 * The dump retains dir:-transient aliases and dead worktree roots.
 *
 * Usage: bun packages/plugin/scripts/export-project-identities.ts [out.jsonl]
 * read-only; writes to stdout when no path is given.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const canonicalHome = realpathSync.native(homedir());
const homeIdentity = `dir:${createHash("md5").update(canonicalHome, "utf8").digest("hex").slice(0, 12)}`;

function isCanonicalHomeRoot(root: string): boolean {
    try {
        return realpathSync.native(resolve(root)) === canonicalHome;
    } catch {
        return false;
    }
}

const dbPath =
    process.env.MAGIC_CONTEXT_DB ??
    join(homedir(), ".local", "share", "cortexkit", "magic-context", "context.db");
const db = new Database(dbPath, { readonly: true });
const openCodePath =
    process.env.OPENCODE_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
const opencodeDb = new Database(openCodePath, { readonly: true });

interface Row {
    identity: string;
    root: string | null;
    source: "session_bindings" | "memory_rows";
}

const rows: Row[] = [];

const directoryBySession = new Map<string, string>();
for (const r of opencodeDb
    .prepare("SELECT id, directory FROM session WHERE directory IS NOT NULL")
    .all() as Array<{ id: string; directory: string }>) {
    directoryBySession.set(r.id, r.directory);
}
for (const r of db
    .prepare("SELECT session_id, project_path AS identity FROM session_projects")
    .all() as Array<{ session_id: string; identity: string }>) {
    const root = directoryBySession.get(r.session_id) ?? null;
    // A canonical-home root must never seed the fleet registry because it contains unrelated directories below $HOME.
    if (r.identity === homeIdentity || (root !== null && isCanonicalHomeRoot(root))) continue;
    rows.push({
        identity: r.identity,
        root,
        source: "session_bindings",
    });
}

// Claim rows contribute source counts and can surface identities without session bindings.
// imported pools).
for (const r of db
    .prepare(
        "SELECT DISTINCT projects.canonical_identity AS identity FROM claims JOIN projects ON projects.id = claims.project_id WHERE projects.canonical_identity LIKE 'git:%' OR projects.canonical_identity LIKE 'dir:%'",
    )
    .all() as Array<{ identity: string }>) {
    if (r.identity === homeIdentity) continue;
    rows.push({ identity: r.identity, root: null, source: "memory_rows" });
}

const byIdentity = new Map<string, { roots: Set<string>; session_bindings: number; memory_rows: number }>();
for (const row of rows) {
    let entry = byIdentity.get(row.identity);
    if (!entry) {
        entry = { roots: new Set(), session_bindings: 0, memory_rows: 0 };
        byIdentity.set(row.identity, entry);
    }
    if (row.root) entry.roots.add(row.root);
    entry[row.source] += 1;
}

const memoryCounts = new Map<string, number>();
for (const r of db
    .prepare(
        "SELECT projects.canonical_identity AS identity, COUNT(*) AS n FROM claims JOIN projects ON projects.id = claims.project_id WHERE projects.canonical_identity LIKE 'git:%' OR projects.canonical_identity LIKE 'dir:%' GROUP BY projects.canonical_identity",
    )
    .all() as Array<{ identity: string; n: number }>) {
    memoryCounts.set(r.identity, r.n);
}

const lines: string[] = [];
for (const [identity, entry] of [...byIdentity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
        JSON.stringify({
            identity,
            roots: [...entry.roots].sort(),
            sources: {
                session_bindings: entry.session_bindings,
                memory_rows: memoryCounts.get(identity) ?? 0,
            },
        }),
    );
}

const out = lines.join("\n") + "\n";
const target = process.argv[2];
if (target) {
    await Bun.write(target, out);
    console.error(`wrote ${lines.length} identities to ${target}`);
} else {
    process.stdout.write(out);
}
