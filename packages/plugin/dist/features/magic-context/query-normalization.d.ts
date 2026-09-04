/**
 * Keep this module free of storage/database imports: the retrieval-benchmark
 * facade consumes it, and any SQLite import here would leak into that
 * facade's transitive import graph. commentlint: allow(JUDGE)
 */
export declare function normalizeQueryText(query: string): string;
export declare function normalizedQueryHash(query: string): string;
//# sourceMappingURL=query-normalization.d.ts.map