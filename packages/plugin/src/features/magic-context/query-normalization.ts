/**
 * Keep this module free of storage/database imports: the retrieval-benchmark
 * facade consumes it, and any SQLite import here would leak into that
 * facade's transitive import graph. commentlint: allow(JUDGE)
 */

import { createHash } from "node:crypto";

export function normalizeQueryText(query: string): string {
    return query.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizedQueryHash(query: string): string {
    return createHash("sha256").update(normalizeQueryText(query)).digest("hex");
}
