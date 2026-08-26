/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    analyzePasses,
    buildSegments,
    findBusts,
    isInternalAgentRequest,
    mainAgentRequests,
} from "./cache-analysis";

/**
 * Unit coverage for the cache-bust oracle itself.
 *
 * The oracle is the assertion engine the live cache-invariant e2e suite leans
 * on, so it must be proven against hand-crafted wire shapes first — especially
 * the exact "mid-prefix message vanishes + tail shifts" shape that the stale
 * ctx_reduce regression produced (a real bust that the old prefix-equality
 * loops would also have caught, but only by luck of message alignment).
 */

const MC_SYSTEM = "## Magic Context\nyou are a long-term partner.";

function req(messages: Array<{ role: string; content: unknown; bp?: boolean }>) {
    return {
        body: {
            system: MC_SYSTEM,
            messages: messages.map((m) => ({
                role: m.role,
                // Real OpenCode wire keeps a message's content shape stable across
                // turns; only the cache_control marker moves. Render every message
                // in the identical block-array form so a message looks the same
                // whether it sits in the tail (with breakpoint) or the prefix
                // (breakpoint moved on). The oracle strips cache_control before
                // hashing, so the only difference between tail and prefix is the
                // (stripped) marker — never the content shape.
                content: m.bp
                    ? [{ type: "text", text: String(m.content), cache_control: { type: "ephemeral" } }]
                    : Array.isArray(m.content)
                      ? m.content
                      : [{ type: "text", text: String(m.content) }],
            })),
        },
    };
}

/** A user turn whose final message carries the moving cache_control breakpoint. */
function turn(prefix: Array<{ role: string; content: string }>, tail: string) {
    return req([...prefix.map((m) => ({ ...m })), { role: "user", content: tail, bp: true }]);
}

describe("cache-bust oracle", () => {
    describe("#given a stable growing conversation", () => {
        describe("#when each request extends the tail past the moving breakpoint", () => {
            it("#then every pass after the base is STABLE with zero busts", () => {
                //#given — model how adjacent real requests grow: the prior tail
                // message keeps its exact bytes (its breakpoint moves on, which the
                // oracle strips) and the new request appends one fresh tail message
                // carrying the breakpoint. The cached prefix only extends forward.
                const prefix: Array<{ role: string; content: string }> = [];
                const requests = [];
                for (let i = 1; i <= 4; i++) {
                    requests.push(turn(prefix, `turn ${i}`));
                    // The just-sent tail becomes part of the unchanging prefix.
                    prefix.push({ role: "user", content: `turn ${i}` });
                }

                //#when
                const passes = analyzePasses(requests);

                //#then
                expect(passes[0].verdict).toBe("BASE");
                expect(passes.slice(1).every((c) => c.verdict === "STABLE")).toBe(true);
                expect(findBusts(requests)).toHaveLength(0);
            });
        });
    });

    describe("#given two byte-identical requests", () => {
        describe("#when nothing changed at all", () => {
            it("#then the verdict is SAME (not a bust)", () => {
                const r = turn([{ role: "user", content: "a" }], "b");
                const passes = analyzePasses([r, structuredClone(r)]);
                expect(passes[1].verdict).toBe("SAME");
                expect(findBusts([r, structuredClone(r)])).toHaveLength(0);
            });
        });
    });

    describe("#given a mid-prefix message mutating in place", () => {
        describe("#when an earlier message's content changes between passes", () => {
            it("#then it is flagged BUST at that message, before the final breakpoint", () => {
                //#given — message[1] content drifts while the tail breakpoint moves on
                const before = turn(
                    [
                        { role: "user", content: "u1" },
                        { role: "assistant", content: "ORIGINAL" },
                    ],
                    "u-tail-a",
                );
                const after = turn(
                    [
                        { role: "user", content: "u1" },
                        { role: "assistant", content: "MUTATED" },
                    ],
                    "u-tail-b",
                );

                //#when
                const busts = findBusts([before, after]);

                //#then
                expect(busts).toHaveLength(1);
                expect(busts[0].divergeSegmentId).toContain("message[1]");
                expect(busts[0].diff?.cur).toContain("MUTATED");
            });
        });
    });

    describe("#given the stale-ctx_reduce regression shape", () => {
        describe("#when a mid-prefix message is removed and the tail shifts up", () => {
            it("#then the oracle flags a BUST at the vanished position", () => {
                //#given — pass 1 has the ctx_reduce tool_use at message[1]; pass 2 has
                // it spliced out (sentinel filtered before wire), so message[1] becomes
                // what used to be message[2] and the array is one shorter in the middle.
                const withReduce = turn(
                    [
                        { role: "user", content: "keep me 0" },
                        { role: "assistant", content: "CTX_REDUCE_TOOL_USE_BLOCK" },
                        { role: "user", content: "keep me 2" },
                        { role: "assistant", content: "keep me 3" },
                    ],
                    "tail-a",
                );
                const reduceGone = turn(
                    [
                        { role: "user", content: "keep me 0" },
                        // message[1] (the ctx_reduce) vanished; everything shifts up
                        { role: "user", content: "keep me 2" },
                        { role: "assistant", content: "keep me 3" },
                    ],
                    "tail-b",
                );

                //#when
                const busts = findBusts([withReduce, reduceGone]);

                //#then — first divergence at message[1] (the shift), well before the
                // final breakpoint → real bust.
                expect(busts).toHaveLength(1);
                expect(busts[0].divergeSegmentId).toContain("message[1]");
            });
        });
    });

    describe("#given a system-prompt drift", () => {
        describe("#when the Magic Context system block changes between passes", () => {
            it("#then it is flagged BUST at system[0]", () => {
                const a = {
                    body: {
                        system: `${MC_SYSTEM}\nToday's date: 2026-06-06`,
                        messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
                    },
                };
                const b = {
                    body: {
                        system: `${MC_SYSTEM}\nToday's date: 2026-06-07`,
                        messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
                    },
                };
                const busts = findBusts([a, b]);
                expect(busts).toHaveLength(1);
                expect(busts[0].divergeSegmentId).toBe("system[0]");
            });
        });
    });

    describe("#given only the cache_control marker moves", () => {
        describe("#when content is identical but the breakpoint walks forward", () => {
            it("#then it is NOT a bust (marker movement is normalized out)", () => {
                //#given — same two messages; breakpoint on msg[0] in pass 1, msg[1] in pass 2
                const a = {
                    body: {
                        system: MC_SYSTEM,
                        messages: [
                            { role: "user", content: [{ type: "text", text: "m0", cache_control: { type: "ephemeral" } }] },
                            { role: "assistant", content: [{ type: "text", text: "m1" }] },
                        ],
                    },
                };
                const b = {
                    body: {
                        system: MC_SYSTEM,
                        messages: [
                            { role: "user", content: [{ type: "text", text: "m0" }] },
                            { role: "assistant", content: [{ type: "text", text: "m1", cache_control: { type: "ephemeral" } }] },
                        ],
                    },
                };

                //#when / #then — marker movement stripped before hashing → SAME
                expect(findBusts([a, b])).toHaveLength(0);
                expect(analyzePasses([a, b])[1].verdict).toBe("SAME");
            });
        });
    });

    describe("#given the cch billing nonce changes", () => {
        describe("#when only the per-request nonce in the system block differs", () => {
            it("#then it is normalized out and not a bust", () => {
                const mk = (nonce: string) => ({
                    body: {
                        system: `${MC_SYSTEM}\nx-anthropic-billing-header: cch=${nonce};`,
                        messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
                    },
                });
                expect(findBusts([mk("00000"), mk("ab12f")])).toHaveLength(0);
            });
        });
    });

    describe("#given a changed §N§ tag prefix", () => {
        describe("#when an earlier message's tag number changes", () => {
            it("#then it IS a bust (tag text is real on-wire content)", () => {
                const a = turn([{ role: "user", content: "§5§ hello" }], "tail");
                const b = turn([{ role: "user", content: "§7§ hello" }], "tail");
                const busts = findBusts([a, b]);
                expect(busts).toHaveLength(1);
                expect(busts[0].divergeSegmentId).toContain("message[0]");
            });
        });
    });

    describe("#given mainAgentRequests filtering", () => {
        describe("#when some requests lack the Magic Context system block", () => {
            it("#then only MC-carrying requests are kept", () => {
                const mc = turn([{ role: "user", content: "a" }], "b");
                const subagent = { body: { system: "You are Historian", messages: [] } };
                const filtered = mainAgentRequests([mc, subagent]);
                expect(filtered).toHaveLength(1);
                expect(filtered[0]).toBe(mc);
            });
        });
    });

    describe("#given internal agent request signatures", () => {
        it("rejects title, summary, compaction, and MC-child requests from body.system only", () => {
            const signatures = [
                "You are a title generator. You output ONLY a thread title.",
                "Summarize what was done in this conversation. Write like a pull request description.",
                "You are an anchored context summarization assistant for coding sessions.",
                "You are Historian — the hippocampus of a long-running coding agent.",
                "You are a dreamer curate agent for the magic-context system.",
                "You are Sidekick, a focused memory-retrieval subagent for an AI coding assistant.",
            ];
            for (const signature of signatures) {
                expect(
                    isInternalAgentRequest({
                        body: { system: signature, messages: [MC_SYSTEM] },
                    }),
                ).toBe(true);
            }
            expect(
                isInternalAgentRequest({
                    body: {
                        system: MC_SYSTEM,
                        messages: signatures,
                    },
                }),
            ).toBe(false);
        });

        it("accepts a main-agent request", () => {
            expect(
                isInternalAgentRequest({
                    body: { system: MC_SYSTEM, messages: [] },
                }),
            ).toBe(false);
        });
    });

    describe("#given buildSegments over a request", () => {
        describe("#when the body has system + messages", () => {
            it("#then it emits one segment per system block then per message in wire order", () => {
                const segs = buildSegments(
                    turn([{ role: "user", content: "a" }, { role: "assistant", content: "b" }], "c").body,
                );
                expect(segs[0].id).toBe("system[0]");
                expect(segs[1].id).toContain("message[0]");
                expect(segs[2].id).toContain("message[1]");
                expect(segs[3].id).toContain("message[2]");
                expect(segs[segs.length - 1].breakpoint).toBe(true);
            });
        });
    });
});
