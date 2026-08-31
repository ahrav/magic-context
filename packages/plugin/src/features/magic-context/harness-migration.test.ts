
import { describe, expect, it } from "bun:test";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createDirectTestDatabase } from "./test-database";

/**
 */

const SESSION_SCOPED_TABLES = [
    "session_meta",
    "compartments",
    "compression_depth",
    "session_facts",
    "tags",
    "source_contents",
    "pending_ops",
    "recomp_compartments",
    "recomp_facts",
    "message_history_index",
    "message_history_source",
    "pending_session_cleanup",
    "session_projects",
    "notes",
] as const;

describe("harness column", () => {
    it("every session-scoped table has a harness column", () => {
        const db = createDirectTestDatabase().db;

        for (const table of SESSION_SCOPED_TABLES) {
            const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                name: string;
                dflt_value: string | null;
                notnull: number;
            }>;
            const harness = cols.find((c) => c.name === "harness");
            expect(harness, `${table} should have harness column`).toBeDefined();
            // PRAGMA table_info returns quoted string defaults.
            expect(harness?.dflt_value).toBe("'opencode'");
            expect(harness?.notnull).toBe(1);
        }

        closeQuietly(db);
    });
});
