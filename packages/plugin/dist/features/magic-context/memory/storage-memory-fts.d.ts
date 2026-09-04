import type { Database } from "../../../shared/sqlite";
import type { Memory } from "./types";
export declare function sanitizeFtsQuery(query: string): string;
export declare function searchMemoriesFTS(db: Database, projectPath: string, query: string, limit?: number): Memory[];
/**
 * Rank FTS matches WITHIN an explicit id set. The id set is authoritative —
 * callers pass ids that already passed status, expiry, workspace, and policy
 * filtering — so the query needs no other predicates and returns the
 * top-ranked members of the set in one bounded fetch. Restricting inside SQL
 * is what keeps a hidden-heavy corpus cheap: ranking globally and filtering
 * afterwards must either widen without bound or truncate eligible matches.
 */
export declare function searchMemoriesFTSWithinIds(db: Database, memoryIds: readonly number[], query: string, limit: number): Memory[];
export declare function searchMemoriesFTSUnion(db: Database, projectPaths: readonly string[], query: string, limit?: number, ownIdentities?: readonly string[], shareCategories?: readonly string[] | null): Memory[];
//# sourceMappingURL=storage-memory-fts.d.ts.map