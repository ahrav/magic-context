/**
 * Test-support statement counters.
 *
 * Work claims in the search hot path ("this no longer scans every note",
 * "exactly K rich rows hydrate") must be provable without timing assertions,
 * which are flaky on shared CI. `countingDatabase` wraps a real `Database` in a
 * transparent proxy that records the SQL text, bindings, and returned row count
 * of every executed statement, so a test can assert on structural work instead
 * of elapsed milliseconds.
 *
 * Lives in `src/` (not a `*.test.ts` file) for the same reason as
 * `mock-database.ts`: several suites share it.
 */
import type { Database } from "../../shared/sqlite";
export interface StatementExecution {
    sql: string;
    /** `all`, `get`, or `run` — which accessor executed the statement. */
    method: "all" | "get" | "run";
    bindings: unknown[];
    /** Rows handed back to the caller (0 or 1 for `get`, 0 for `run`). */
    rowCount: number;
}
export interface CountingDatabase {
    /** Pass this to production code instead of the raw database. */
    db: Database;
    executions: StatementExecution[];
    /** Executions whose SQL matches `pattern`. */
    matching(pattern: string | RegExp): StatementExecution[];
    /** Number of executions whose SQL matches `pattern`. */
    count(pattern: string | RegExp): number;
    /** Total rows returned by executions whose SQL matches `pattern`. */
    rows(pattern: string | RegExp): number;
    reset(): void;
}
export declare function countingDatabase(target: Database): CountingDatabase;
//# sourceMappingURL=sql-counters.d.ts.map