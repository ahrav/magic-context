import { Database } from "../../../shared/sqlite";
/**
 * Open OpenCode's DB read-only (used by dreamer tasks that scan raw OpenCode
 * history, e.g. the retrospective scanner and the orphaned-child sweep).
 * Returns null when absent or unopenable — callers degrade gracefully.
 * Absence is normal on Pi-only installs, so it is not logged as an error.
 */
export declare function openOpenCodeDb(): Database | null;
//# sourceMappingURL=open-opencode-db.d.ts.map