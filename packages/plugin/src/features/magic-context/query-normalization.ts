/**
 * This module must not import storage or database modules.
 */

import { createHash } from "node:crypto";

export function normalizeQueryText(query: string): string {
    return query.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizedQueryHash(query: string): string {
    return createHash("sha256").update(normalizeQueryText(query)).digest("hex");
}
