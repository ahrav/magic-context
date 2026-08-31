/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    analyzePasses,
    buildSegments,
    findBusts,
    isInternalAgentRequest,
    mainAgentRequests,
} from "./cache-analysis";
import { MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES } from "../../plugin/src/hooks/magic-context/internal-agent-signatures";
import { HISTORIAN_SYSTEM_MARKER_FOR_DRIFT_TEST } from "./incident-pool/support/tool-loop";

/**
 *
 */

const MC_SYSTEM = "## Magic Context\nyou are a long-term partner.";

function req(messages: Array<{ role: string; content: unknown; bp?: boolean }>) {
    return {
        body: {
            system: MC_SYSTEM,
            messages: messages.map((m) => ({
                role: m.role,
                // The fixture preserves content representations across requests.
                content: m.bp
                    ? [{ type: "text", text: String(m.content), cache_control: { type: "ephemeral" } }]
                    : Array.isArray(m.content)
                      ? m.content
                      : [{ type: "text", text: String(m.content) }],
            })),
        },
    };
}

/* */
function turn(prefix: Array<{ role: string; content: string }>, tail: string) {
    return req([...prefix.map((m) => ({ ...m })), { role: "user", content: tail, bp: true }]);
}

describe("cache-bust oracle", () => {
    describe("#given a stable growing conversation", () => {
        describe("#when each request extends the tail past the moving breakpoint", () => {
            it("#then every pass after the base is STABLE with zero busts", () => {
                const prefix: Array<{ role: string; content: string }> = [];
                const requests = [];
                for (let i = 1; i <= 4; i++) {
                    requests.push(turn(prefix, `turn ${i}`));
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
                        { role: "user", content: "keep me 2" },
                        { role: "assistant", content: "keep me 3" },
                    ],
                    "tail-b",
                );

                //#when
                const busts = findBusts([withReduce, reduceGone]);

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
                // Pass 1 places the breakpoint on message[0]; pass 2 places it on message[1].
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

                // Hashing strips breakpoint-marker movement, so the requests are SAME.
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

    describe("#given the historian selector in the incident-pool tool loop", () => {
        describe("#when the shared production signature changes", () => {
            it("#then the narrower selector marker must still be contained by it", () => {
                // The hidden-agent filter excludes non-main-agent requests; the tool-loop selector matches only historian requests.
                // Collapsing the broad hidden-agent filter and the tool-loop selector would make historian matchers reply to the dreamer, sidekick, and OpenCode's title, summary, and compaction agents.
                // The assertion fails when selector drift removes `HISTORIAN_SYSTEM_MARKER_FOR_DRIFT_TEST` from the production signature.
                const historianSignature = MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES.find(
                    (signature) => signature.includes("Historian"),
                );
                expect(historianSignature).toBeDefined();
                expect(historianSignature).toContain(HISTORIAN_SYSTEM_MARKER_FOR_DRIFT_TEST);
            });
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
