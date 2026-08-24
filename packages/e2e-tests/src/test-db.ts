import { Database } from "bun:sqlite";
import { updateMemoryVerification } from "../../plugin/src/features/magic-context/memory";
import { Database as PluginDatabase } from "../../plugin/src/shared/sqlite";

/**
 * Open a SQLite handle for an e2e test with a non-zero `busy_timeout` always set.
 *
 * The e2e suite runs many files in parallel against a per-test shared
 * `context.db` while the plugin under test writes to the same file. A handle
 * opened with the default `busy_timeout = 0` fails immediately with SQLITE_BUSY
 * the instant any other connection holds the write lock, which surfaces as
 * flaky "database is locked" failures under load rather than a real regression.
 * Setting a timeout makes the handle WAIT for the lock instead of failing.
 *
 * Every test that opens the context DB directly (reader or writer) must go
 * through this helper so the timeout can never be forgotten — a bare
 * `new Database(...)` in a test reintroduces the flake.
 */
export function openTestDb(
	path: string,
	options?: { readonly?: boolean; readwrite?: boolean },
): Database {
	const db = new Database(path, options);
	db.exec("PRAGMA busy_timeout=5000");
	return db;
}

/**
 * Promote a tool-written memory to policy-eligible (VERIFIED) through the
 * real verification API — exactly what the dreamer's verify task does in
 * production. Under the v86 trust policy an agent `ctx_memory` write starts
 * CANDIDATE and is hidden from every automatic surface; injection and cache
 * tests exercise the render machinery, not the promotion ladder, so they
 * verify the row before asserting on injected bytes.
 */
export function promoteMemoryToVerified(dbPath: string, contentLike: string): number {
	const db = new PluginDatabase(dbPath);
	db.exec("PRAGMA busy_timeout=5000");
	try {
		const row = db
			.prepare("SELECT id FROM memories WHERE content LIKE ? ORDER BY id DESC LIMIT 1")
			.get(`%${contentLike}%`) as { id: number } | null;
		if (!row) {
			throw new Error(`no memory matching "${contentLike}" found for promotion`);
		}
		updateMemoryVerification(db, row.id, "verified");
		return row.id;
	} finally {
		db.close();
	}
}
