/**
 * These helpers isolate bun:sqlite and node:sqlite API differences from call sites.
 */

import type { Database } from "./sqlite";

/**
 *
 * bun:sqlite suppresses close errors when `throwOnError` is `false`.
 * node:sqlite throws when `db.close()` receives an already-closed handle.
 * closeQuietly suppresses `db.close()` errors to match bun:sqlite's `throwOnError = false` behavior.
 */
export function closeQuietly(db: Database | null | undefined): void {
    if (!db) return;
    try {
        db.close();
    } catch {
    }
}
