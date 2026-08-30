/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

/**
 * Pi port of session-isolation.test.ts.
 *
 * Pi has no RPC/API equivalent of OpenCode's `client.session.delete()` and the
 * production extension has no `session.deleted` event. Pi stores sessions as
 * JSONL files; switching sessions fires `session_before_switch`, while process
 * teardown fires `session_shutdown`. Those lifecycle hooks clear in-memory
 * per-session caches, not durable DB rows. Therefore the deletion-cleanup half
 * of the OpenCode test is documented as skipped below until Pi exposes a
 * deletion event/RPC surface that can be asserted end-to-end.
 */

let h: PiTestHarness;

beforeAll(async () => {
  h = await PiTestHarness.create({
    magicContextConfig: {
      execute_threshold_percentage: 80,
    },
  });
});

afterAll(async () => {
  await h.dispose();
});

describe("pi session lifecycle", () => {
  it("tags and session_meta are scoped per Pi session", async () => {
    h.mock.reset();
    h.mock.setDefault({
      text: "ok",
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 50,
      },
    });

    const a1 = await h.sendPrompt("pi session A turn 1", { timeoutMs: 60_000 });
    expect(a1.exitCode).toBeNull();
    expect(a1.sessionId).toBeTruthy();
    const a = a1.sessionId!;

    const a2 = await h.sendPrompt("pi session A turn 2", {
      timeoutMs: 60_000,
      continueSession: true,
    });
    expect(a2.sessionId).toBe(a);

    await h.newSession();
    const b1 = await h.sendPrompt("pi session B turn 1", { timeoutMs: 60_000 });
    expect(b1.exitCode).toBeNull();
    expect(b1.sessionId).toBeTruthy();
    const b = b1.sessionId!;
    expect(b).not.toBe(a);

    await h.waitFor(() => h.countTags(a) > 0, { label: "session A tags" });
    await h.waitFor(() => h.countTags(b) > 0, { label: "session B tags" });

    const tagsA = h.countTags(a);
    const tagsB = h.countTags(b);
    expect(tagsA).toBeGreaterThan(0);
    expect(tagsB).toBeGreaterThan(0);
    expect(tagsA).toBeGreaterThan(tagsB);

    const metaRows = h
      .contextDb()
      .prepare("SELECT session_id, harness FROM session_meta WHERE session_id IN (?, ?)")
      .all(a, b) as Array<{ session_id: string; harness: string }>;
    const seen = new Map(metaRows.map((r) => [r.session_id, r.harness]));
    expect(seen.get(a)).toBe("pi");
    expect(seen.get(b)).toBe("pi");

    const nonPiTags = h
      .contextDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM tags WHERE session_id IN (?, ?) AND harness != 'pi'",
      )
      .get(a, b) as { n: number };
    expect(nonPiTags.n).toBe(0);
  }, 120_000);

  it.skip("session deletion clears tags and session_meta (FIXME: Pi exposes no deletion RPC/event)", () => {
    // TODO: OpenCode emits `session.deleted` from
    // client.session.delete(), and the OpenCode e2e verifies durable tags +
    // session_meta rows are removed. Pi currently exposes `new_session`
    // (session_before_switch) and process teardown (session_shutdown), but no
    // RPC/API that deletes the JSONL session file and notifies extensions. Once
    // Pi adds a deletion command/event, port the OpenCode deletion assertion
    // here instead of silently treating switch/shutdown cache cleanup as durable
    // delete cleanup.
  });
});
