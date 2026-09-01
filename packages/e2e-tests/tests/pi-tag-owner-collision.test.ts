/// <reference types="bun-types" />

/**
 *
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";
import { openTestDb } from "../src/test-db";

let h: PiTestHarness;

beforeAll(async () => {
  h = await PiTestHarness.create({
    magicContextConfig: { protected_tags: 1 },
  });
});

afterAll(async () => {
  await h.dispose();
});

describe("pi tag-owner collision repro (v3.3.1 Layer C)", () => {
  it("creates a Pi session and applies migration v10", async () => {
    h.mock.reset();
    h.mock.setDefault({
      text: "first response",
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 100,
      },
    });

    const turn = await h.sendPrompt("create pi session for collision test", {
      timeoutMs: 60_000,
    });
    expect(turn.exitCode).toBeNull();
    expect(turn.sessionId).toBeTruthy();

    await h.waitFor(() => h.hasContextDb(), { label: "context.db created" });

    const db = h.contextDb();
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number;
    };
    expect(row.v).toBeGreaterThanOrEqual(10);

    const cols = db.prepare("PRAGMA table_info(tags)").all() as Array<{
      name: string;
      dflt_value: string | null;
      type: string;
    }>;
    const owner = cols.find((c) => c.name === "tool_owner_message_id");
    expect(owner).toBeDefined();
    expect(owner?.type).toBe("TEXT");

    const idxComposite = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
      .get("idx_tags_tool_composite") as { sql: string } | undefined;
    expect(idxComposite).toBeDefined();
    expect(idxComposite?.sql).toContain("UNIQUE");

    const idxNullOwner = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
      .get("idx_tags_tool_null_owner") as { sql: string } | undefined;
    expect(idxNullOwner).toBeDefined();

    const tagHarness = db
      .prepare("SELECT harness FROM tags WHERE session_id = ? LIMIT 1")
      .get(turn.sessionId!) as { harness: string } | null;
    expect(tagHarness?.harness).toBe("pi");

    const metaHarness = db
      .prepare("SELECT harness FROM session_meta WHERE session_id = ?")
      .get(turn.sessionId!) as { harness: string } | null;
    expect(metaHarness?.harness).toBe("pi");
  }, 60_000);

  it("two Pi tool rows with same callId + different owners coexist via composite UNIQUE", async () => {
    const sessionId = "pi-ses-collision-repro";
    const writable = openTestDb(h.contextDbPath());
    try {
      const insert = writable.prepare(
        "INSERT INTO tags (session_id, message_id, type, tag_number, byte_size, tool_name, tool_owner_message_id, harness) VALUES (?, ?, 'tool', ?, ?, 'read', ?, 'pi')",
      );
      insert.run(sessionId, "read:32", 100, 200, "pi-asst-1");
      insert.run(sessionId, "read:32", 200, 200, "pi-asst-2");

      const tags = writable
        .prepare(
          "SELECT tag_number, tool_owner_message_id, harness FROM tags WHERE session_id = ? ORDER BY tag_number",
        )
        .all(sessionId) as Array<{
        tag_number: number;
        tool_owner_message_id: string;
        harness: string;
      }>;
      expect(tags).toHaveLength(2);
      expect(tags.map((t) => t.tag_number)).toEqual([100, 200]);
      expect(tags.map((t) => t.tool_owner_message_id)).toEqual(["pi-asst-1", "pi-asst-2"]);
      expect(tags.every((t) => t.harness === "pi")).toBe(true);

      expect(() => insert.run(sessionId, "read:32", 999, 200, "pi-asst-1")).toThrow(/UNIQUE/i);

      insert.run(sessionId, "read:32", 300, 200, "pi-asst-3");
      const after = writable
        .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = 'pi'")
        .get(sessionId) as { n: number };
      expect(after.n).toBe(3);
    } finally {
      writable.close();
    }
  }, 30_000);

  it("legacy NULL-owner Pi rows for the same callId still coexist", async () => {
    const sessionId = "pi-ses-legacy-null";
    const writable = openTestDb(h.contextDbPath());
    try {
      const insert = writable.prepare(
        "INSERT INTO tags (session_id, message_id, type, tag_number, byte_size, tool_name, tool_owner_message_id, harness) VALUES (?, ?, 'tool', ?, ?, 'read', NULL, 'pi')",
      );
      insert.run(sessionId, "legacy:1", 1, 100);
      insert.run(sessionId, "legacy:1", 2, 100);

      const tags = writable
        .prepare(
          "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND tool_owner_message_id IS NULL AND harness = 'pi'",
        )
        .get(sessionId) as { n: number };
      expect(tags.n).toBe(2);
    } finally {
      writable.close();
    }
  }, 30_000);

  it("dropping one Pi owner leaves the colliding owner active", async () => {
    const sessionId = "pi-ses-drop-isolation";
    const writable = openTestDb(h.contextDbPath());
    try {
      const insert = writable.prepare(
        "INSERT INTO tags (session_id, message_id, type, tag_number, byte_size, tool_name, tool_owner_message_id, status, harness) VALUES (?, ?, 'tool', ?, ?, 'read', ?, 'active', 'pi')",
      );
      insert.run(sessionId, "read:32", 1, 200, "pi-asst-1");
      insert.run(sessionId, "read:32", 2, 200, "pi-asst-2");

      writable
        .prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?")
        .run(sessionId, 1);

      const rows = writable
        .prepare(
          "SELECT tag_number, status, tool_owner_message_id, harness FROM tags WHERE session_id = ? ORDER BY tag_number",
        )
        .all(sessionId) as Array<{
        tag_number: number;
        status: string;
        tool_owner_message_id: string;
        harness: string;
      }>;
      expect(rows).toEqual([
        {
          tag_number: 1,
          status: "dropped",
          tool_owner_message_id: "pi-asst-1",
          harness: "pi",
        },
        {
          tag_number: 2,
          status: "active",
          tool_owner_message_id: "pi-asst-2",
          harness: "pi",
        },
      ]);
    } finally {
      writable.close();
    }
  }, 30_000);
});
