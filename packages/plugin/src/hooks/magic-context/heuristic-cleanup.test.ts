/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getTagsBySession, insertTag } from "../../features/magic-context/storage";
import {
    clearEmergencyDropSample,
    getEmergencyInputSample,
} from "../../features/magic-context/storage-meta-persisted";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import type { Database } from "../../shared/sqlite";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import type { MessageLike, TagTarget } from "./tag-messages";

function makeMemoryDatabase(): Database {
    return createDirectTestDatabase().db;
}

function makeTarget(message: { parts: unknown[] }): TagTarget {
    return {
        message: message as TagTarget["message"],
        setContent: (content: string) => {
            const textPart = message.parts.find((p: any) => p.type === "text") as any;
            if (!textPart) return false;
            if (textPart.text === content) return false;
            textPart.text = content;
            return true;
        },
        drop: () => {
            const idx = message.parts.findIndex((p: any) => p.type === "tool");
            if (idx >= 0) {
                message.parts.splice(idx, 1);
                return "removed" as const;
            }
            return "absent" as const;
        },
        canDrop: () => message.parts.some((p: any) => p.type === "tool"),
        truncate: () => {
            const toolPart = message.parts.find((p: any) => p.type === "tool") as
                | {
                      state?: {
                          input?: Record<string, unknown>;
                          output?: unknown;
                      };
                  }
                | undefined;
            if (!toolPart?.state) return "absent" as const;

            toolPart.state.output = "[truncated]";
            const inputSize = toolPart.state.input
                ? JSON.stringify(toolPart.state.input).length
                : 0;
            if (toolPart.state.input && inputSize > 500) {
                for (const key of Object.keys(toolPart.state.input)) {
                    const value = toolPart.state.input[key];
                    if (typeof value === "string") {
                        toolPart.state.input[key] =
                            value.length > 5 ? `${value.slice(0, 5)}...[truncated]` : value;
                    } else if (Array.isArray(value)) {
                        toolPart.state.input[key] = `[${value.length} items]`;
                    } else if (value !== null && typeof value === "object") {
                        toolPart.state.input[key] = "[object]";
                    }
                }
            }

            return "truncated" as const;
        },
    };
}

function buildMessageTagNumbers(
    entries: [number, { parts: unknown[] }][],
): Map<MessageLike, number> {
    const map = new Map<MessageLike, number>();
    for (const [tagNumber, msg] of entries) {
        map.set({ info: { role: "assistant" }, parts: msg.parts } as MessageLike, tagNumber);
    }
    return map;
}

describe("applyHeuristicCleanup", () => {
    const SESSION = "ses_test";
    let db: Database;

    beforeEach(() => {
        db = makeMemoryDatabase();
    });

    afterEach(() => {
        db.close();
    });

    describe("#given reasoning with actual content", () => {
        describe("#when executing heuristic cleanup", () => {
            it("#then preserves non-cleared reasoning", () => {
                //#given
                insertTag(db, SESSION, "msg-1", "message", 500, 1);
                const msg = {
                    parts: [
                        { type: "reasoning", text: "I need to think about this carefully..." },
                        { type: "text", text: "my response" },
                    ],
                };
                const targets = new Map<number, TagTarget>();
                targets.set(1, makeTarget(msg));

                //#when
                applyHeuristicCleanup(SESSION, db, targets, buildMessageTagNumbers([[1, msg]]), {
                    protectedTags: 0,
                });

                expect(msg.parts).toHaveLength(2);
            });
        });
    });

    describe("#given the tiered emergency drop config (>=85% pass)", () => {
        it("#then drops oldest tool outputs down to the reclaim target, full-drop", () => {
            // With only tool tags, fixedFloor is 0 and the target is 30% of the ceiling.
            for (let i = 1; i <= 10; i++) {
                insertTag(db, SESSION, `call-${i}`, "tool", 4000, i, 0, "bash");
            }
            const targets = new Map<number, TagTarget>();
            for (let i = 1; i <= 10; i++) {
                targets.set(
                    i,
                    makeTarget({
                        parts: [
                            {
                                type: "tool",
                                tool: "bash",
                                state: { output: "x".repeat(4000), status: "completed" },
                            },
                        ],
                    }),
                );
            }

            // Ten 4,000-byte tags contribute 10,000 tail tokens at 0.25 tokens per byte.
            // With 10,000 tokens of usage and a 6,000-token ceiling, the target is 1,800 tokens and cleanup reclaims 8,200 tokens.
            const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTags: 2,
                emergency: { currentTotalInputTokens: 10_000, ceilingTokens: 6_000 },
            });

            // Cleanup drops the oldest tags, including the bash tool at tag 3, while the protected newest window retains its persisted skeleton.
            expect(result.droppedTools).toBeGreaterThan(0);
            const tags = getTagsBySession(db, SESSION);
            const dropped = tags
                .filter((t) => t.status === "dropped")
                .map((t) => t.tagNumber)
                .sort((a, b) => a - b);
            expect(dropped).not.toContain(9);
            expect(dropped).not.toContain(10);
            expect(dropped[0]).toBe(1);
            expect(
                tags.filter((t) => t.status === "dropped").every((t) => t.dropMode === "truncated"),
            ).toBe(true);
        });

        it("#then clears the sample latch after abort so the retry drops more", () => {
            for (let i = 1; i <= 10; i++) {
                insertTag(db, SESSION, `abort-call-${i}`, "tool", 4000, i, 0, "bash");
            }
            const targets = new Map<number, TagTarget>();
            for (let i = 1; i <= 10; i++) {
                targets.set(
                    i,
                    makeTarget({
                        parts: [
                            {
                                type: "tool",
                                tool: "bash",
                                state: { output: "x".repeat(4000), status: "completed" },
                            },
                        ],
                    }),
                );
            }
            const emergency = { currentTotalInputTokens: 10_000, ceilingTokens: 10_000 };

            const first = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTags: 0,
                emergency,
            });
            expect(first.emergencyDroppedTools).toBeGreaterThan(0);
            expect(getEmergencyInputSample(db, SESSION)).toBe(10_000);

            const latched = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTags: 0,
                emergency,
            });
            expect(latched.emergencyDroppedTools).toBe(0);

            // A confirmed fail-closed abort retains the latch until a fresh provider sample arrives.
            // A confirmed fail-closed abort retains the latch until a fresh provider sample arrives.
            clearEmergencyDropSample(db, SESSION);
            const retry = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTags: 0,
                emergency,
            });
            expect(retry.emergencyDroppedTools).toBeGreaterThan(0);
        });

        it("#then is a no-op when already under target (reclaim <= 0)", () => {
            insertTag(db, SESSION, "call-1", "tool", 4000, 1, 0, "bash");
            insertTag(db, SESSION, "m-2", "message", 500, 2);
            const targets = new Map<number, TagTarget>([
                [
                    1,
                    makeTarget({
                        parts: [{ type: "tool", tool: "bash", state: { output: "x" } }],
                    }),
                ],
            ]);
            const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTags: 0,
                emergency: { currentTotalInputTokens: 1_000, ceilingTokens: 100_000 },
            });
            expect(result.droppedTools).toBe(0);
        });

        it("#then does nothing when no emergency config is supplied (routine pass)", () => {
            for (let i = 1; i <= 5; i++) {
                insertTag(db, SESSION, `call-${i}`, "tool", 4000, i, 0, "bash");
            }
            const targets = new Map<number, TagTarget>();
            for (let i = 1; i <= 5; i++) {
                targets.set(
                    i,
                    makeTarget({ parts: [{ type: "tool", tool: "bash", state: { output: "x" } }] }),
                );
            }
            const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTags: 0,
            });
            // Routine processing runs only deduplication and injection stripping; it does not drop tools.
            expect(result.droppedTools).toBe(0);
        });
    });

    /**
     * Deduplication keys include ownerMsgId, preventing cross-owner calls from merging.
     *
     */
    describe("#given composite-key dedup (v3.3.1 Layer C)", () => {
        function buildMessageWithId(
            id: string,
            parts: unknown[],
        ): MessageLike & { info: { id: string; role: string } } {
            return { info: { id, role: "assistant" }, parts };
        }

        it("does NOT merge cross-owner pairs with same (toolName, args, callId)", () => {
            // merge them.
            insertTag(db, SESSION, "read:32", "tool", 1000, 50, 0, "mcp_grep", 0, "m-asst-1");
            insertTag(db, SESSION, "read:32", "tool", 2000, 60, 0, "mcp_grep", 0, "m-asst-2");

            const msgA = buildMessageWithId("m-asst-1", [
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "read:32",
                    state: { input: { pattern: "x" }, output: "result-1", status: "completed" },
                },
            ]);
            const msgB = buildMessageWithId("m-asst-2", [
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "read:32",
                    state: { input: { pattern: "x" }, output: "result-2", status: "completed" },
                },
            ]);

            const targets = new Map<number, TagTarget>([
                [50, makeTarget(msgA)],
                [60, makeTarget(msgB)],
            ]);
            const messageTagNumbers = new Map<MessageLike, number>();
            messageTagNumbers.set(msgA, 50);
            messageTagNumbers.set(msgB, 60);

            const result = applyHeuristicCleanup(SESSION, db, targets, messageTagNumbers, {
                protectedTags: 0,
            });

            expect(result.deduplicatedTools).toBe(0);
            const tags = getTagsBySession(db, SESSION);
            expect(tags.find((t) => t.tagNumber === 50)?.status).toBe("active");
            expect(tags.find((t) => t.tagNumber === 60)?.status).toBe("active");
        });

        it("DOES merge same-owner duplicates with different callIds (Pi parallel-tool-calls shape)", () => {
            // The fingerprint matches because the calls have the same owner, toolName, and args.
            // The deduplication pass merges the calls and drops the older tag.
            // newer kept.
            insertTag(db, SESSION, "call-A", "tool", 1000, 70, 0, "mcp_grep", 0, "m-asst");
            insertTag(db, SESSION, "call-B", "tool", 2000, 80, 0, "mcp_grep", 0, "m-asst");

            const msg = buildMessageWithId("m-asst", [
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "call-A",
                    state: { input: { pattern: "y" }, output: "r1", status: "completed" },
                },
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "call-B",
                    state: { input: { pattern: "y" }, output: "r2", status: "completed" },
                },
            ]);

            const targets = new Map<number, TagTarget>([
                [70, makeTarget(msg)],
                [80, makeTarget(msg)],
            ]);
            const messageTagNumbers = new Map<MessageLike, number>();
            messageTagNumbers.set(msg, 80); // newest

            const result = applyHeuristicCleanup(SESSION, db, targets, messageTagNumbers, {
                protectedTags: 0,
            });

            expect(result.deduplicatedTools).toBe(1);
            const tags = getTagsBySession(db, SESSION);
            expect(tags.find((t) => t.tagNumber === 70)?.status).toBe("dropped");
            expect(tags.find((t) => t.tagNumber === 80)?.status).toBe("active");
        });

        it("does not count an absent dedup target as a confirmed mutation", () => {
            insertTag(db, SESSION, "call-A", "tool", 1000, 90, 0, "mcp_grep", 0, "m-asst");
            insertTag(db, SESSION, "call-B", "tool", 2000, 100, 0, "mcp_grep", 0, "m-asst");

            const msg = buildMessageWithId("m-asst", [
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "call-A",
                    state: { input: { pattern: "z" }, output: "r1", status: "completed" },
                },
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "call-B",
                    state: { input: { pattern: "z" }, output: "r2", status: "completed" },
                },
            ]);

            const targets = new Map<number, TagTarget>([[100, makeTarget(msg)]]);
            const messageTagNumbers = new Map<MessageLike, number>();
            messageTagNumbers.set(msg, 100);

            const result = applyHeuristicCleanup(SESSION, db, targets, messageTagNumbers, {
                protectedTags: 0,
            });

            expect(result.deduplicatedTools).toBe(0);
            expect(getTagsBySession(db, SESSION).find((t) => t.tagNumber === 90)?.status).toBe(
                "dropped",
            );
        });
    });
});
