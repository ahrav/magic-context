import { describe, expect, it } from "bun:test";
import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import type { TagEntry } from "../../features/magic-context/types";
import { buildChannel1Reminder } from "./ctx-reduce-nudge";
import type { MessageLike } from "./tag-messages";
import {
    assertTailHygieneContentUnchanged,
    effectiveTailHygiene,
    measureTailHygiene,
    refreshTailHygieneBaseline,
} from "./tail-hygiene-walk";

function message(
    id: string,
    role: "user" | "assistant",
    parts: unknown[],
    extra: Partial<MessageLike["info"]> = {},
): MessageLike {
    return { info: { id, role, ...extra }, parts };
}

function textMessage(id: string, text: string, role: "user" | "assistant" = "user"): MessageLike {
    return message(id, role, [{ type: "text", text }]);
}

function tag(
    tagNumber: number,
    messageId: string,
    type: TagEntry["type"],
    overrides: Partial<TagEntry> = {},
): TagEntry {
    return {
        tagNumber,
        messageId,
        type,
        status: "active",
        dropMode: "full",
        toolName: type === "tool" ? "read" : null,
        inputByteSize: 0,
        byteSize: 1,
        reasoningByteSize: 0,
        sessionId: "ses-walk",
        cavemanDepth: 0,
        toolOwnerMessageId: type === "tool" ? "owner" : null,
        ...overrides,
    };
}

function nativeTool(ownerId: string, callID: string, input: unknown, output: string): MessageLike {
    return message(ownerId, "assistant", [
        { type: "tool", callID, tool: "read", state: { input, output } },
    ]);
}

describe("tail hygiene single-walk instrument", () => {
    it("reproduces the live incident from rendered-tail coordinates", () => {
        const messages = [
            textMessage("conversation", "prose ".repeat(58_000)),
            nativeTool("tool-owner", "call-live", { path: "fixture" }, "result ".repeat(81_000)),
            {
                info: { role: "user", syntheticHead: true },
                parts: [{ type: "text", text: "m0 ".repeat(131_000), synthetic: true }],
            } as MessageLike,
        ];
        const tags = [tag(2, "call-live", "tool", { toolOwnerMessageId: "tool-owner" })];

        const measured = measureTailHygiene({ messages, tags, protectedTags: 0 });
        const severity = measured.u / measured.t;
        const oldInputRelativeSeverity = measured.u / 648_000;
        const oldRebasedPressure = 0.2;
        const oldWouldFire = oldInputRelativeSeverity >= 0.2 && oldRebasedPressure >= 0.8;

        expect(measured.u).toBeGreaterThan(0);
        expect(measured.u).toBeLessThanOrEqual(measured.t);
        expect(severity).toBeGreaterThanOrEqual(0.55);
        expect(severity).toBeLessThan(0.7);
        expect(oldWouldFire).toBe(false);
    });

    it("is invariant to raw tag weights and measures only final rendered content", () => {
        const messages = [
            textMessage("m1", "kept rendered prose ".repeat(200)),
            nativeTool("m2", "call-drift", { path: "small" }, "rendered output ".repeat(150)),
        ];
        const normalTags = [
            tag(1, "m1:p0", "message", { byteSize: 100 }),
            tag(2, "call-drift", "tool", {
                byteSize: 100,
                inputByteSize: 20,
                toolOwnerMessageId: "m2",
            }),
        ];
        const driftedTags = normalTags.map((entry) => ({
            ...entry,
            byteSize: entry.byteSize + 380_000,
            inputByteSize: entry.inputByteSize + 200_000,
        }));

        expect(measureTailHygiene({ messages, tags: driftedTags, protectedTags: 0 })).toEqual(
            measureTailHygiene({ messages, tags: normalTags, protectedTags: 0 }),
        );
    });

    it("counts caveman-compressed bytes and excludes truncated tool skeletons", () => {
        const messages = [
            textMessage("compressed", "compact summary"),
            nativeTool(
                "skeleton-owner",
                "call-truncated",
                { path: "/very/large/original/path", payload: "x".repeat(50_000) },
                "[truncated §2§]",
            ),
        ];
        const tags = [
            tag(1, "compressed:p0", "message", { byteSize: 500_000, cavemanDepth: 3 }),
            tag(2, "call-truncated", "tool", {
                byteSize: 500_000,
                inputByteSize: 100_000,
                toolOwnerMessageId: "skeleton-owner",
            }),
        ];

        const measured = measureTailHygiene({ messages, tags, protectedTags: 0 });
        const compressedOnly = measureTailHygiene({
            messages: [messages[0]],
            tags: [tags[0]],
            protectedTags: 0,
        });

        expect(measured.u).toBe(compressedOnly.u);
        expect(measured.t).toBe(compressedOnly.t);
    });

    it("excludes reasoning and signatures in both directions", () => {
        const base = [textMessage("m", "visible working text ".repeat(100))];
        const withReasoning = [
            message("m", "user", [
                { type: "text", text: "visible working text ".repeat(100) },
                {
                    type: "thinking",
                    thinking: "private chain ".repeat(50_000),
                    signature: "signed ".repeat(10_000),
                },
                { type: "redacted_thinking", data: "opaque ".repeat(50_000) },
                { type: "signature", text: "signature ".repeat(50_000) },
            ]),
        ];
        const tags = [tag(1, "m:p0", "message")];

        const expected = measureTailHygiene({ messages: base, tags, protectedTags: 0 });
        const actual = measureTailHygiene({ messages: withReasoning, tags, protectedTags: 0 });
        expect({ u: actual.u, t: actual.t }).toEqual({ u: expected.u, t: expected.t });
    });

    it("excludes m0/m1, todo, Channel-2, and compaction-summary synthetics", () => {
        const syntheticMessages: MessageLike[] = [
            {
                info: { role: "user", syntheticHead: true },
                parts: [{ type: "text", text: "m0", synthetic: true }],
            },
            {
                info: { id: "__magic_context_todo_head__", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: "mc_synthetic_todo_0123456789abcdef",
                        tool: "todowrite",
                        syntheticTodoMarker: true,
                        state: { input: { todos: [] }, output: "todo" },
                    },
                ],
            },
            message("channel2", "user", [
                { type: "text", text: "<system-reminder>drop</system-reminder>", synthetic: true },
            ]),
            message("summary", "assistant", [{ type: "text", text: "compacted" }], {
                summary: true,
            }),
        ];

        expect(
            measureTailHygiene({ messages: syntheticMessages, tags: [], protectedTags: 0 }),
        ).toMatchObject({ u: 0, t: 0 });
    });

    it("excludes protected ctx_reduce exemplar arcs from U while retaining them in T", () => {
        const messages = Array.from({ length: 4 }, (_, index) =>
            nativeTool(
                `reduce-owner-${index + 1}`,
                `reduce-${index + 1}`,
                { drop: index + 1 },
                `reduced ${index + 1}`,
            ),
        );
        const tags = Array.from({ length: 4 }, (_, index) =>
            tag(index + 1, `reduce-${index + 1}`, "tool", {
                toolName: "ctx_reduce",
                toolOwnerMessageId: `reduce-owner-${index + 1}`,
            }),
        );

        const measured = measureTailHygiene({ messages, tags, protectedTags: 0 });
        const protectedTagNumbers = new Set(
            measured.parts.filter((part) => part.protected).map((part) => part.tagNumber),
        );
        const oldestArcParts = measured.parts.filter((part) => part.tagNumber === 1);
        const exemplarParts = measured.parts.filter((part) => (part.tagNumber ?? 0) >= 2);

        expect(protectedTagNumbers).toEqual(new Set([2, 3, 4]));
        expect(oldestArcParts.every((part) => part.uTokens > 0)).toBe(true);
        expect(exemplarParts.every((part) => part.uTokens === 0)).toBe(true);
        expect(measured.u).toBeGreaterThan(0);
        expect(measured.t).toBeGreaterThan(measured.u);
        expect(CTX_REDUCE_KEEP).toBe(3);
    });

    it("keeps U as a constructed subset of T, including image/file parts", () => {
        const messages = [
            message("file-owner", "user", [
                { type: "file", mime: "image/png", url: "data:image/png;base64,garbage" },
            ]),
            nativeTool("tool-owner", "call-subset", { query: "x" }, "answer"),
            textMessage("untagged", "visible but not reclaimable"),
        ];
        const tags = [
            tag(1, "file-owner:file0", "file"),
            tag(2, "call-subset", "tool", { toolOwnerMessageId: "tool-owner" }),
        ];
        const measured = measureTailHygiene({ messages, tags, protectedTags: 0 });

        expect(measured.u).toBeGreaterThan(0);
        expect(measured.u).toBeLessThan(measured.t);
        expect(measured.u).toBeLessThanOrEqual(measured.t);
    });

    it("attributes a single orphan only in its tag-number neighborhood", () => {
        const messages = [
            textMessage("before", "before"),
            nativeTool("legacy-owner", "call-reused", { n: 1 }, "legacy output"),
            textMessage("after", "after"),
            textMessage("later-before", "later before"),
            nativeTool("recycled-owner", "call-reused", { n: 2 }, "recycled output"),
            textMessage("later-after", "later after"),
        ];
        const tags = [
            tag(9, "before:p0", "message"),
            tag(10, "call-reused", "tool", { toolOwnerMessageId: null }),
            tag(11, "after:p0", "message"),
            tag(100, "later-before:p0", "message"),
            tag(102, "later-after:p0", "message"),
        ];

        const both = measureTailHygiene({ messages, tags, protectedTags: 0 });
        const legacyOnly = measureTailHygiene({
            messages: messages.slice(0, 3),
            tags,
            protectedTags: 0,
        });
        const legacyProseOnly = measureTailHygiene({
            messages: [messages[0], messages[2]],
            tags,
            protectedTags: 0,
        });
        const laterOnly = measureTailHygiene({
            messages: messages.slice(3),
            tags,
            protectedTags: 0,
        });
        const laterProseOnly = measureTailHygiene({
            messages: [messages[3], messages[5]],
            tags,
            protectedTags: 0,
        });
        const allProse = measureTailHygiene({
            messages: [messages[0], messages[2], messages[3], messages[5]],
            tags,
            protectedTags: 0,
        });
        const legacyToolU = legacyOnly.u - legacyProseOnly.u;

        expect(legacyToolU).toBeGreaterThan(0);
        expect(laterOnly.u).toBe(laterProseOnly.u);
        expect(both.u).toBe(allProse.u + legacyToolU);
        expect(both.u).toBeLessThan(both.t);
    });

    it("treats multiple NULL-owner rows for one callID as ambiguous", () => {
        const messages = [
            textMessage("before", "before"),
            nativeTool("legacy-owner", "call-ambiguous", { n: 1 }, "legacy output"),
            textMessage("after", "after"),
        ];
        const tags = [
            tag(9, "before:p0", "message"),
            tag(10, "call-ambiguous", "tool", { toolOwnerMessageId: null }),
            tag(10_000, "call-ambiguous", "tool", { toolOwnerMessageId: null }),
            tag(11, "after:p0", "message"),
        ];

        const measured = measureTailHygiene({ messages, tags, protectedTags: 0 });
        // Neighboring tagged prose contributes U even though both orphan rows are rejected.
        expect(measured.u).toBeGreaterThan(0);
        const textOnly = measureTailHygiene({
            messages: [messages[0], messages[2]],
            tags,
            protectedTags: 0,
        });
        expect(measured.u).toBe(textOnly.u);
        expect(measured.t).toBeGreaterThan(measured.u);
    });
});

describe("tail hygiene baseline and defer-window deltas", () => {
    it("keeps a bust pass and an unchanged defer pass identical", () => {
        const messages = [textMessage("m", "working tail ".repeat(10_000))];
        const tags = [tag(1, "m:p0", "message")];
        const bust = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTags: 0,
            cacheBusting: true,
        });
        const defer = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTags: 0,
            cacheBusting: false,
            previous: bust,
        });

        expect(effectiveTailHygiene(defer)).toEqual(effectiveTailHygiene(bust));
        expect(defer.baselineGeneration).toBe(bust.baselineGeneration);
        expect(defer.evaluable).toBe(true);
    });

    it("walks typed appended deltas while protected and untagged tool output is T-only", () => {
        const baseMessages = [textMessage("base", "base text ".repeat(100))];
        const baseTags = [tag(1, "base:p0", "message")];
        const baseline = refreshTailHygieneBaseline({
            messages: baseMessages,
            tags: baseTags,
            protectedTags: 1,
            cacheBusting: true,
        });
        const messages = [
            ...baseMessages,
            textMessage("user-delta", "new user prose ".repeat(100)),
            textMessage("assistant-delta", "new assistant prose ".repeat(100), "assistant"),
            message("image-delta", "user", [
                { type: "file", mime: "image/png", url: "data:image/png;base64,garbage" },
            ]),
            nativeTool("tool-delta", "call-delta", { path: "new" }, "new tool output ".repeat(100)),
            nativeTool("untagged-tool", "call-untagged", { path: "other" }, "untagged output"),
        ];
        const tags = [
            ...baseTags,
            tag(2, "user-delta:p0", "message"),
            tag(3, "assistant-delta:p0", "message"),
            tag(4, "image-delta:file0", "file"),
            tag(5, "call-delta", "tool", { toolOwnerMessageId: "tool-delta" }),
        ];
        const defer = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTags: 1,
            cacheBusting: false,
            previous: baseline,
        });

        expect(defer.evaluable).toBe(true);
        expect(defer.turnDeltaT).toBeGreaterThan(0);
        expect(defer.turnDeltaU).toBeGreaterThan(0);
        expect(defer.turnDeltaU).toBeLessThan(defer.turnDeltaT);
        expect(effectiveTailHygiene(defer).u).toBeLessThanOrEqual(effectiveTailHygiene(defer).t);
    });

    it("adds exactly persisted mass when the protection boundary advances", () => {
        const before = [
            textMessage("old", "old reclaimable mass ".repeat(100)),
            textMessage("protected", "still protected ".repeat(100)),
        ];
        const beforeTags = [tag(1, "old:p0", "message"), tag(2, "protected:p0", "message")];
        const baseline = refreshTailHygieneBaseline({
            messages: before,
            tags: beforeTags,
            protectedTags: 2,
            cacheBusting: true,
        });
        const oldMass = measureTailHygiene({
            messages: [before[0]],
            tags: [beforeTags[0]],
            protectedTags: 0,
        }).t;
        const appended = textMessage("newest", "newest protected ".repeat(100));
        const defer = refreshTailHygieneBaseline({
            messages: [...before, appended],
            tags: [...beforeTags, tag(3, "newest:p0", "message")],
            protectedTags: 2,
            cacheBusting: false,
            previous: baseline,
        });

        expect(baseline.baselineU).toBe(0);
        expect(defer.evaluable).toBe(true);
        expect(defer.turnDeltaU).toBe(oldMass);
        expect(defer.baselineGeneration).toBe(baseline.baselineGeneration);
    });

    it("ignores a Channel-1 reminder appended after the measured pass", () => {
        const original = nativeTool("owner", "call-reminder", { path: "x" }, "tool output");
        const tags = [tag(1, "call-reminder", "tool", { toolOwnerMessageId: "owner" })];
        const baseline = refreshTailHygieneBaseline({
            messages: [original],
            tags,
            protectedTags: 0,
            cacheBusting: true,
        });
        const mutated = structuredClone(original) as MessageLike;
        const toolPart = mutated.parts[0] as { state: { output: string } };
        toolPart.state.output += buildChannel1Reminder("gentle", 25_000);
        const defer = refreshTailHygieneBaseline({
            messages: [mutated],
            tags,
            protectedTags: 0,
            cacheBusting: false,
            previous: baseline,
        });

        expect(defer.evaluable).toBe(true);
        expect(defer.turnDeltaU).toBe(0);
        expect(defer.turnDeltaT).toBe(0);
        expect(effectiveTailHygiene(defer)).toEqual(effectiveTailHygiene(baseline));
    });

    it("marks non-append mutation as generation-invalidated until a bust rewalk", () => {
        const original = [textMessage("m", "original content")];
        const tags = [tag(1, "m:p0", "message")];
        const baseline = refreshTailHygieneBaseline({
            messages: original,
            tags,
            protectedTags: 0,
            cacheBusting: true,
        });
        const changed = [textMessage("m", "changed content")];
        const defer = refreshTailHygieneBaseline({
            messages: changed,
            tags,
            protectedTags: 0,
            cacheBusting: false,
            previous: baseline,
        });
        const rewalk = refreshTailHygieneBaseline({
            messages: changed,
            tags,
            protectedTags: 0,
            cacheBusting: true,
            previous: defer,
        });

        expect(defer.evaluable).toBe(false);
        expect(defer.generationInvalidated).toBe(true);
        expect(defer.baselineGeneration).toBe(baseline.baselineGeneration);
        expect(rewalk.evaluable).toBe(true);
        expect(rewalk.generationInvalidated).toBe(false);
        expect(rewalk.baselineGeneration).toBe(baseline.baselineGeneration + 1);
    });

    it("detects a byte mutation after the walk with a content-hash assertion", () => {
        const messages = [textMessage("m", "stable content")];
        const tags = [tag(1, "m:p0", "message")];
        const measured = measureTailHygiene({ messages, tags, protectedTags: 0 });
        (messages[0].parts[0] as { text: string }).text = "mutated bytes!";

        expect(() =>
            assertTailHygieneContentUnchanged({
                messages,
                tags,
                protectedTags: 0,
                expectedSignature: measured.contentSignature,
            }),
        ).toThrow(/tail hygiene walk was not the last byte-affecting operation/i);
    });
});

describe("tail hygiene walk performance", () => {
    it("stays below 15ms median on a 250k-token rendered tail", () => {
        const messages = [textMessage("perf", "token ".repeat(250_000))];
        const tags = [tag(1, "perf:p0", "message")];
        for (let warmup = 0; warmup < 5; warmup += 1) {
            measureTailHygiene({ messages, tags, protectedTags: 0 });
        }
        const durations: number[] = [];
        for (let iteration = 0; iteration < 101; iteration += 1) {
            const start = performance.now();
            measureTailHygiene({ messages, tags, protectedTags: 0 });
            durations.push(performance.now() - start);
        }
        durations.sort((left, right) => left - right);
        const median = durations[Math.floor(durations.length / 2)];
        const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
        console.log(
            `tail-hygiene-walk 250k-token median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms`,
        );
        expect(median).toBeLessThan(15);
    });
});
