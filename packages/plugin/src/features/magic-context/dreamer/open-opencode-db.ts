import { existsSync } from "node:fs";
import { getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { getOpenCodeDbPath } from "../compaction-marker";

/**
 */
export function openOpenCodeDb(): Database | null {
    const dbPath = getOpenCodeDbPath();
    if (!existsSync(dbPath)) {
        log(`[dreamer] OpenCode DB not found at ${dbPath} — skipping OpenCode history scan`);
        return null;
    }
    try {
        const db = new Database(dbPath, { readonly: true });
        db.exec("PRAGMA busy_timeout = 5000");
        return db;
    } catch (error) {
        log(`[dreamer] failed to open OpenCode DB at ${dbPath}: ${getErrorMessage(error)}`);
        return null;
    }
}
