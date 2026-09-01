import { describe, expect, test } from "bun:test";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import type { Database } from "../../shared/sqlite";
import { computeM0BlockTokens } from "./m0-token-breakdown";
import { estimateTokens } from "./read-session-formatting";

/**
 */

const SESSION_ID = "ses_m0_breakdown";

function makeDb(): Database {
    const d = createDirectTestDatabase().db;
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

describe("computeM0BlockTokens", () => {
    test("measures each m[0] slice from the rendered bytes and retires Facts", () => {
        const db = makeDb();
        const m0Text = [
            "<project-docs>\nARCHITECTURE: lorem ipsum docs body here for tokens\n</project-docs>",
            "<user-profile>\n- user prefers concise replies\n</user-profile>",
            "<project-memory>\n<PROJECT_RULES>\n#1: use the release script\n</PROJECT_RULES>\n</project-memory>",
            "<session-history>\n## 1-9 · Did a thing\nbody text\n</session-history>",
        ].join("\n");

        const b = computeM0BlockTokens(db, SESSION_ID, {
            m0Text,
            projectIdentity: "/tmp/proj",
            injectionBudgetTokens: 10_000,
            memoryBlockCount: 1,
        });

        expect(b.docsTokens).toBeGreaterThan(0);
        expect(b.profileTokens).toBeGreaterThan(0);
        expect(b.memoryTokens).toBeGreaterThan(0);
        expect(b.compartmentTokens).toBe(
            estimateTokens(
                "<session-history>\n## 1-9 · Did a thing\nbody text\n</session-history>",
            ),
        );
        expect(b.factTokens).toBe(0);
        db.close();
    });

    test("missing slices read as 0 (no docs/profile/memory present)", () => {
        const db = makeDb();
        const m0Text = "<session-history>\n## 1-2 · x\ny\n</session-history>";
        const b = computeM0BlockTokens(db, SESSION_ID, {
            m0Text,
            projectIdentity: undefined,
            injectionBudgetTokens: undefined,
            memoryBlockCount: 0,
        });
        expect(b.docsTokens).toBe(0);
        expect(b.profileTokens).toBe(0);
        expect(b.memoryTokens).toBe(0);
        expect(b.factTokens).toBe(0);
        expect(b.compartmentTokens).toBeGreaterThan(0);
    });

    test("uses module history cost when Rust owns the materialized m[0]", () => {
        const db = makeDb();
        db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(SESSION_ID, 1, 1, 9, "m1", "m9", "Mirrored compartment", "p1 content", Date.now());
        const b = computeM0BlockTokens(db, SESSION_ID, {
            m0Text: "",
            projectIdentity: undefined,
            injectionBudgetTokens: undefined,
            memoryBlockCount: 0,
            compartmentTokensOverride: 17,
        });
        expect(b.compartmentTokens).toBe(17);
        db.close();
    });

    test("cold start (no materialized m[0]) falls back to Σp1 from compartments", () => {
        const db = makeDb();
        db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(SESSION_ID, 1, 1, 9, "m1", "m9", "Cold compartment", "some content body", Date.now());
        const b = computeM0BlockTokens(db, SESSION_ID, {
            m0Text: "", // no materialized m[0] yet
            projectIdentity: undefined,
            injectionBudgetTokens: undefined,
            memoryBlockCount: 0,
        });
        expect(b.compartmentTokens).toBe(
            estimateTokens("## 1-9 · Cold compartment\nsome content body\n"),
        );
        db.close();
    });
});
