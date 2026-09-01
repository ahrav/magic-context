/**
 *
 *
 *
 */

import { withReadOnlySessionDb } from "../../hooks/magic-context/read-session-db";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

interface SessionParentRow {
    parent_id: string | null;
}

/**
 *
 * Returns:
 *
 */
export function resolveIsSubagentFromOpenCodeDb(sessionId: string): boolean | null {
    try {
        return withReadOnlySessionDb((openCodeDb: Database) => {
            const row = openCodeDb
                .prepare("SELECT parent_id FROM session WHERE id = ?")
                .get(sessionId) as SessionParentRow | null;

            if (!row) return null;
            return typeof row.parent_id === "string" && row.parent_id.length > 0;
        });
    } catch (error) {
        log(`[magic-context] resolveIsSubagentFromOpenCodeDb failed for ${sessionId}:`, error);
        return null;
    }
}
