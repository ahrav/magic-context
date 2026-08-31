import { describe, expect, it } from "bun:test";
import { dropStaleReduceCalls } from "./drop-stale-reduce-calls";
import { isSentinel } from "./sentinel";
import type { MessageLike } from "./tag-messages";

let idCounter = 0;
function makeMessage(role: string, parts: unknown[], id?: string): MessageLike {
    return { info: { role, id: id ?? `msg-${idCounter++}` }, parts };
}

function makeToolPart(toolName: string, output: string, callId = "call-1") {
    return { type: "tool", tool: toolName, callID: callId, state: { output, status: "completed" } };
}

function makeTextPart(text: string) {
    return { type: "text", text };
}

const NO_FROZEN = new Set<string>();

describe("dropStaleReduceCalls (frozen-set replay)", () => {
    describe("#given a detect pass over aged ctx_reduce messages", () => {
        describe("#when detect=true and the call is past the protected window", () => {
            it("#then sentinels the ctx_reduce part, preserves length, and reports the id", () => {
                //#given
                const reduceMsg = makeMessage(
                    "tool",
                    [makeToolPart("ctx_reduce", "Queued: drop §1§")],
                    "reduce-1",
                );
                const messages = [
                    makeMessage("user", [makeTextPart("hello")]),
                    makeMessage("assistant", [makeTextPart("thinking...")]),
                    reduceMsg,
                    makeMessage("user", [makeTextPart("continue")]),
                ];

                const result = dropStaleReduceCalls(messages, NO_FROZEN, { detect: true });

                //#then
                expect(result.didDrop).toBe(true);
                expect(result.newlyStrippedIds).toEqual(["reduce-1"]);
                expect(messages).toHaveLength(4);
                expect(messages[0].parts[0]).toEqual(makeTextPart("hello"));
                expect(messages[1].parts[0]).toEqual(makeTextPart("thinking..."));
                expect(messages[3].parts[0]).toEqual(makeTextPart("continue"));
                expect(messages[2].parts).toHaveLength(1);
                expect(isSentinel(messages[2].parts[0])).toBe(true);
            });
        });
    });

    describe("#given non-reduce tool results", () => {
        describe("#when detect=true", () => {
            it("#then leaves other tool results untouched and reports nothing", () => {
                //#given
                const messages = [
                    makeMessage("tool", [makeToolPart("grep", "found 3 matches")], "g1"),
                    makeMessage("tool", [makeToolPart("bash", "exit code 0")], "b1"),
                ];

                //#when
                const result = dropStaleReduceCalls(messages, NO_FROZEN, { detect: true });

                //#then
                expect(result.didDrop).toBe(false);
                expect(result.newlyStrippedIds).toEqual([]);
                expect(messages).toHaveLength(2);
                expect((messages[0].parts[0] as { tool: string }).tool).toBe("grep");
                expect((messages[1].parts[0] as { tool: string }).tool).toBe("bash");
            });
        });
    });

    describe("#given no messages", () => {
        describe("#when detecting", () => {
            it("#then returns a clean empty result", () => {
                const result = dropStaleReduceCalls([], NO_FROZEN, { detect: true });
                expect(result.didDrop).toBe(false);
                expect(result.newlyStrippedIds).toEqual([]);
            });
        });
    });

    describe("#given a message with mixed tool parts including ctx_reduce", () => {
        describe("#when one part is ctx_reduce and another is a different tool", () => {
            it("#then sentinels only the ctx_reduce part and preserves parts.length", () => {
                //#given
                const messages = [
                    makeMessage(
                        "tool",
                        [
                            makeToolPart("bash", "exit code 0", "call-a"),
                            makeToolPart("ctx_reduce", "Queued: drop §5§", "call-b"),
                        ],
                        "mixed-1",
                    ),
                ];

                //#when
                const result = dropStaleReduceCalls(messages, NO_FROZEN, { detect: true });

                //#then
                expect(result.didDrop).toBe(true);
                expect(result.newlyStrippedIds).toEqual(["mixed-1"]);
                expect(messages[0].parts).toHaveLength(2);
                expect((messages[0].parts[0] as { tool: string }).tool).toBe("bash");
                expect(isSentinel(messages[0].parts[1])).toBe(true);
            });
        });
    });

    describe("#given messages within the protected range on a detect pass", () => {
        describe("#when protectedCount covers the recent reduce call", () => {
            it("#then detects only the aged call, never the protected one", () => {
                //#given
                const messages = [
                    makeMessage("user", [makeTextPart("old message")], "u-old"),
                    makeMessage("tool", [makeToolPart("ctx_reduce", "Queued: drop §1§")], "r-old"),
                    makeMessage("user", [makeTextPart("recent message")], "u-new"),
                    makeMessage("tool", [makeToolPart("ctx_reduce", "Queued: drop §5§")], "r-new"),
                ];

                const result = dropStaleReduceCalls(messages, NO_FROZEN, {
                    detect: true,
                    protectedCount: 2,
                });

                expect(result.didDrop).toBe(true);
                expect(result.newlyStrippedIds).toEqual(["r-old"]);
                expect(messages[1].parts).toHaveLength(1);
                expect(isSentinel(messages[1].parts[0])).toBe(true);
                expect((messages[3].parts[0] as { tool: string }).tool).toBe("ctx_reduce");
            });
        });
    });

    describe("#given a ctx_reduce call frozen on a prior cache-busting pass", () => {
        describe("#when a later DEFER pass replays with tail growth (detect=false)", () => {
            it("#then re-strips the SAME frozen id and never newly strips a grown-past call", () => {
                // Two additional turns place `reduce-2` outside the live protection window.
                const reduce1 = makeMessage(
                    "tool",
                    [makeToolPart("ctx_reduce", "Queued: drop §1§")],
                    "reduce-1",
                );
                const reduce2 = makeMessage(
                    "tool",
                    [makeToolPart("ctx_reduce", "Queued: drop §9§")],
                    "reduce-2",
                );
                const messages = [
                    makeMessage("user", [makeTextPart("a")], "u-a"),
                    reduce1,
                    makeMessage("assistant", [makeTextPart("b")], "a-b"),
                    reduce2,
                    makeMessage("user", [makeTextPart("c")], "u-c"),
                    makeMessage("assistant", [makeTextPart("d")], "a-d"),
                ];
                const frozen = new Set<string>(["reduce-1"]);

                // With detect: false, only frozen IDs replay.
                const result = dropStaleReduceCalls(messages, frozen, {
                    detect: false,
                    protectedCount: 2,
                });

                // Defer passes strip only ids in the frozen set.
                // Defer passes do not strip newly aged unfrozen calls.
                expect(result.didDrop).toBe(true);
                expect(result.newlyStrippedIds).toEqual([]);
                expect(messages[1].parts).toHaveLength(1);
                expect(isSentinel(messages[1].parts[0])).toBe(true);
                expect((messages[3].parts[0] as { tool: string }).tool).toBe("ctx_reduce");
            });
        });
    });

    describe("#given execute→defer replay", () => {
        describe("#when the execute pass detects and the defer pass replays the frozen id", () => {
            it("#then both passes produce the identical stripped shape", () => {
                //#given
                const buildMessages = () => [
                    makeMessage("user", [makeTextPart("x")], "u-x"),
                    makeMessage("tool", [makeToolPart("ctx_reduce", "Queued: drop §1§")], "r-1"),
                    makeMessage("user", [makeTextPart("y")], "u-y"),
                    makeMessage("user", [makeTextPart("z")], "u-z"),
                ];

                const executeMsgs = buildMessages();
                const exec = dropStaleReduceCalls(executeMsgs, NO_FROZEN, {
                    detect: true,
                    protectedCount: 2,
                });
                const frozen = new Set<string>(exec.newlyStrippedIds);
                const deferMsgs = buildMessages();
                const defer = dropStaleReduceCalls(deferMsgs, frozen, {
                    detect: false,
                    protectedCount: 2,
                });

                expect(exec.newlyStrippedIds).toEqual(["r-1"]);
                expect(exec.didDrop).toBe(true);
                expect(defer.didDrop).toBe(true);
                expect(defer.newlyStrippedIds).toEqual([]);
                expect(isSentinel(executeMsgs[1].parts[0])).toBe(true);
                expect(isSentinel(deferMsgs[1].parts[0])).toBe(true);
                expect(executeMsgs[1].parts).toHaveLength(1);
                expect(deferMsgs[1].parts).toHaveLength(1);
            });
        });
    });

    describe("#given a frozen id no longer present (compaction trimmed it)", () => {
        describe("#when replaying on a defer pass", () => {
            it("#then it is a safe no-op", () => {
                const messages = [
                    makeMessage("user", [makeTextPart("hello")], "u-1"),
                    makeMessage("assistant", [makeTextPart("world")], "a-1"),
                ];
                const frozen = new Set<string>(["reduce-gone"]);

                //#when
                const result = dropStaleReduceCalls(messages, frozen, { detect: false });

                //#then
                expect(result.didDrop).toBe(false);
                expect(result.newlyStrippedIds).toEqual([]);
                expect(messages[0].parts[0]).toEqual(makeTextPart("hello"));
                expect(messages[1].parts[0]).toEqual(makeTextPart("world"));
            });
        });
    });

    describe("#given a message without a stable info.id", () => {
        describe("#when detect=true and it holds an aged ctx_reduce call", () => {
            it("#then it is left intact (cannot be frozen for deterministic replay)", () => {
                //#given
                const noId: MessageLike = {
                    info: { role: "tool" },
                    parts: [makeToolPart("ctx_reduce", "Queued: drop §1§")],
                };
                const messages = [
                    noId,
                    makeMessage("user", [makeTextPart("a")], "u-a"),
                    makeMessage("user", [makeTextPart("b")], "u-b"),
                ];

                //#when
                const result = dropStaleReduceCalls(messages, NO_FROZEN, {
                    detect: true,
                    protectedCount: 1,
                });

                expect(result.didDrop).toBe(false);
                expect(result.newlyStrippedIds).toEqual([]);
                expect((noId.parts[0] as { tool: string }).tool).toBe("ctx_reduce");
            });
        });
    });

    describe("#given an already-sentineled message in the frozen set", () => {
        describe("#when replayed again", () => {
            it("#then it is idempotent (no new mutation)", () => {
                const messages = [
                    makeMessage("tool", [{ type: "text", text: "" }], "r-1"),
                    makeMessage("user", [makeTextPart("hello")], "u-1"),
                ];
                const frozen = new Set<string>(["r-1"]);

                //#when
                const result = dropStaleReduceCalls(messages, frozen, { detect: false });

                //#then
                expect(result.didDrop).toBe(false);
                expect(messages[0].parts).toHaveLength(1);
                expect(isSentinel(messages[0].parts[0])).toBe(true);
            });
        });
    });
});
