/// <reference types="bun-types" />

/**
 * Incident regression #3 (the P0): OpenCode mutated a queued user message in
 * place — same message id, changed content (the reminder-wrapper shape) — the
 * module rejected the identity drift, and the adapter parked permanently while
 * the session climbed past its threshold with zero folds and every dashboard
 * read green.
 *
 * The fix (now MERGED into this branch's base) is a module-side tail re-adopt:
 * when the newest message mutates in place after the module has already observed
 * it, the module re-adopts the new tail identity ("identity re-adopted for tail
 * mid …") and keeps transforming instead of rejecting, and the adapter no longer
 * parks. This scenario asserts that shipped OUTCOME — after the mutation the
 * transform keeps serving and the session never permanently parks — not the
 * re-adopt mechanism, so it stays valid across future refactors.
 *
 * The mutation is applied the production way: the newest user message's text part
 * is edited in place in opencode.db (same message id, appended content),
 * mirroring the reminder-wrapper mutation OpenCode performs on a queued message.
 *
 * Drives the FULL production path: opencode → plugin → direct mc-host → McHandler.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { driveToSteadyState, rustPrereqs } from "../src/rust-scenario-support";

/**
 * Mutate the newest user message's text part IN PLACE in opencode.db — same
 * message id, appended content — the reminder-wrapper shape OpenCode applies to
 * a queued user message. Returns the mutated message id.
 */
function mutateNewestUserTailInPlace(h: RustTestHarness, sessionId: string): string {
    const ocPath = join(h.env.dataDir, "opencode", "opencode.db");
    const db = new Database(ocPath);
    try {
        const newestUser = db
            .prepare(
                "SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY id DESC LIMIT 1",
            )
            .get(sessionId) as { id: string } | undefined;
        if (!newestUser) throw new Error("no user message to mutate");
        const part = db
            .prepare(
                "SELECT id, data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY id ASC LIMIT 1",
            )
            .get(newestUser.id) as { id: string; data: string } | undefined;
        if (!part) throw new Error("no text part to mutate");
        const parsed = JSON.parse(part.data) as { text?: string };
        parsed.text = `${parsed.text ?? ""} [REMINDER: injected wrapper content, same message id, changed content]`;
        db.prepare("UPDATE part SET data = ? WHERE id = ?").run(JSON.stringify(parsed), part.id);
        return newestUser.id;
    } finally {
        db.close();
    }
}

describe.skipIf(!rustPrereqs.ok)("rust incident regression: tail mutation re-adopt", () => {
    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: { execute_threshold_percentage: 40, protected_tags: 1 },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it("keeps transforming after the newest user message is mutated in place (no permanent park)", async () => {
        const sessionId = await h.createSession();
        // Steady state ensures the module has OBSERVED the tail at least once
        // before it is mutated — the precondition the incident required.
        await driveToSteadyState(h, sessionId, 3);

        const beforeCount = h.readRustPasses().length;
        mutateNewestUserTailInPlace(h, sessionId);
        await Bun.sleep(500);

        // Drive fresh turns after the in-place mutation.
        for (let i = 5; i <= 10; i += 1) {
            h.mock.setDefault({
                text: `post-mutation assistant ${i}`,
                usage: {
                    input_tokens: 2_000 * i,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                },
            });
            await h.sendPrompt(sessionId, `post-mutation turn ${i}: ${h.ballast(400)}`);
            await Bun.sleep(300);
        }

        const all = await h.waitForRustPasses(beforeCount + 4);
        const after = all.slice(beforeCount);

        // Outcome invariants (re-adopt, not park):
        //  - the module resumed real transforms after the mutation, and
        //  - the session is not left permanently parked.
        expect(after.some((p) => p.servedFrom === "transform")).toBe(true);
        expect(after.at(-1)!.decision).not.toBe("parked");
    }, 300_000);
});
