/**
 * Cross-runtime helpers that smooth over the small bun:sqlite ↔ node:sqlite
 * API differences without leaking either backend into call sites.
 */
import type { Database } from "./sqlite";
/**
 * Close a database, ignoring errors.
 *
 * bun:sqlite supports `db.close(throwOnError = false)`. node:sqlite has only
 * `db.close()` and throws ("database is not open") on an already-closed
 * handle. This helper mirrors the bun "swallow errors" semantics for both
 * runtimes — useful in test teardown and `finally` blocks where the caller
 * doesn't care whether the close succeeded.
 */
export declare function closeQuietly(db: Database | null | undefined): void;
//# sourceMappingURL=sqlite-helpers.d.ts.map