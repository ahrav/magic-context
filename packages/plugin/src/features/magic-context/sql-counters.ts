/**
 *
 * Tests can assert structural work instead of elapsed time.
 *
 */

import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";

export interface StatementExecution {
    sql: string;
    /* */
    method: "all" | "get" | "run";
    bindings: unknown[];
    /* */
    rowCount: number;
}

export interface CountingDatabase {
    /** Callers use `db` instead of `target` to record prepared-statement executions. */
    db: Database;
    executions: StatementExecution[];
    /* */
    matching(pattern: string | RegExp): StatementExecution[];
    /* */
    count(pattern: string | RegExp): number;
    /* */
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
            // Database methods are bound to `target` because they fail when the proxy is their `this` value.
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
