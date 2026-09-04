import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
export declare function getIncrementDepthStatement(db: Database): PreparedStatement;
export declare function incrementCompressionDepth(db: Database, sessionId: string, startOrdinal: number, endOrdinal: number): void;
export declare function getAverageCompressionDepth(db: Database, sessionId: string, startOrdinal: number, endOrdinal: number): number;
export declare function getMaxCompressionDepth(db: Database, sessionId: string): number;
export declare function clearCompressionDepth(db: Database, sessionId: string): void;
/**
 * Clear compression depth counters for a specific message range.
 * Used by partial recomp: rebuilt compartments start fresh at depth 0, so
 * depth rows for the rebuilt ordinals must be removed. Existing depth for
 * ordinals outside the range (prior and tail compartments) is preserved.
 */
export declare function clearCompressionDepthRange(db: Database, sessionId: string, startOrdinal: number, endOrdinal: number): void;
//# sourceMappingURL=compression-depth-storage.d.ts.map