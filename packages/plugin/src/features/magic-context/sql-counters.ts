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

import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";

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

function matches(sql: string, pattern: string | RegExp): boolean {
    return typeof pattern === "string" ? sql.includes(pattern) : pattern.test(sql);
}

function normalize(sql: string): string {
    return sql.replace(/\s+/g, " ").trim();
}

export function countingDatabase(target: Database): CountingDatabase {
    const executions: StatementExecution[] = [];

    const wrapStatement = (sql: string, statement: PreparedStatement): PreparedStatement => {
        const record = (
            method: StatementExecution["method"],
            bindings: unknown[],
            rows: number,
        ) => {
            executions.push({ sql: normalize(sql), method, bindings, rowCount: rows });
        };
        return {
            ...statement,
            all: (...bindings: unknown[]) => {
                const result = (statement.all as (...args: unknown[]) => unknown[])(...bindings);
                record("all", bindings, Array.isArray(result) ? result.length : 0);
                return result;
            },
            get: (...bindings: unknown[]) => {
                const result = (statement.get as (...args: unknown[]) => unknown)(...bindings);
                record("get", bindings, result == null ? 0 : 1);
                return result;
            },
            run: (...bindings: unknown[]) => {
                const result = (statement.run as (...args: unknown[]) => unknown)(...bindings);
                record("run", bindings, 0);
                return result;
            },
        } as unknown as PreparedStatement;
    };

    const db = new Proxy(target, {
        get(_ignored, prop) {
            if (prop === "prepare") {
                return (sql: string) => wrapStatement(sql, target.prepare(sql));
            }
            const value = (target as unknown as Record<string | symbol, unknown>)[prop];
            // Bind to the real database: SQLite adapter methods (transaction,
            // exec, close) break when `this` is the proxy.
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Database;

    return {
        db,
        executions,
        matching: (pattern) => executions.filter((entry) => matches(entry.sql, pattern)),
        count: (pattern) => executions.filter((entry) => matches(entry.sql, pattern)).length,
        rows: (pattern) =>
            executions
                .filter((entry) => matches(entry.sql, pattern))
                .reduce((total, entry) => total + entry.rowCount, 0),
        reset: () => {
            executions.length = 0;
        },
    };
}
