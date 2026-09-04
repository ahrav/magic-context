import { describe, expect, test } from "bun:test";
import { parseCommitResponse, parseKernelResponse, parseReadResponse } from "./wire";

const UNRECOGNIZED = { kind: "invalid", reason: "unrecognized_state" };

function readRow(objectId: string, knownAsOf: number, extra: Record<string, unknown> = {}) {
    return {
        object: {
            object_id: objectId,
            object_kind: "decision",
            domain_id: "memory",
            source_kind: "assistant",
            source_id: "memory-lineage",
            source_revision: 1,
            created_commit_seq: 1,
            invalidated_commit_seq: null,
            superseded_by: null,
            sensitivity: "normal",
            ...extra,
        },
        visibility: "labeled",
        labeled: true,
        scope_id: "project:x",
        token: { object_id: objectId, known_as_of: knownAsOf },
        decision: { decision_kind: "memory", payload: { summary: objectId, rationale: "" } },
    };
}

describe("parseKernelResponse", () => {
    test.each([
        ["null", null],
        ["string", "available"],
        ["array", [{ kind: "available" }]],
        ["missing state", { known_as_of: 1 }],
        ["state not an object", { state: "available" }],
        ["unknown kind", { state: { kind: "degraded" } }],
        ["unknown unavailable reason", { state: { kind: "unavailable", reason: "rebooting" } }],
        ["unknown conflict reason", { state: { kind: "conflict", reason: "locked" } }],
        ["unknown invalid reason", { state: { kind: "invalid", reason: "nope" } }],
        ["reason of wrong type", { state: { kind: "unavailable", reason: 7 } }],
        ["stale without lag", { state: { kind: "stale" } }],
        [
            "stale with negative lag",
            { state: { kind: "stale", lag_positions: -1, oldest_unconsumed_age_ms: 0 } },
        ],
        [
            "stale with fractional age",
            { state: { kind: "stale", lag_positions: 1, oldest_unconsumed_age_ms: 1.5 } },
        ],
        [
            "stale with infinite lag",
            {
                state: {
                    kind: "stale",
                    lag_positions: Number.POSITIVE_INFINITY,
                    oldest_unconsumed_age_ms: 0,
                },
            },
        ],
    ])("%s parses to unrecognized_state without throwing", (_label, raw) => {
        expect(parseKernelResponse(raw).state).toEqual(UNRECOGNIZED);
    });

    test("extra fields on the state are ignored", () => {
        expect(parseKernelResponse({ state: { kind: "available", extra: 1 } }).state).toEqual({
            kind: "available",
        });
    });

    test("an available response splits state from payload", () => {
        const parsed = parseKernelResponse({ state: { kind: "available" }, known_as_of: 4 });
        expect(parsed.state).toEqual({ kind: "available" });
        expect(parsed.payload).toEqual({ known_as_of: 4 });
    });

    test("a result-wrapped body is unwrapped", () => {
        const parsed = parseKernelResponse({ result: { state: { kind: "available" }, tip: 2 } });
        expect(parsed.payload).toEqual({ tip: 2 });
    });
});

describe("parseReadResponse", () => {
    const good = {
        state: { kind: "available" },
        known_as_of: 7,
        tip: 7,
        gated: false,
        rows: [readRow("o1", 7)],
    };

    test("a well-formed read yields typed rows", () => {
        const parsed = parseReadResponse(good);
        expect(parsed.state.kind).toBe("available");
        expect(parsed.payload?.rows[0]?.token).toEqual({ object_id: "o1", known_as_of: 7 });
    });

    test("a read without the truncated field parses as not truncated", () => {
        expect(parseReadResponse(good).payload?.truncated).toBe(false);
    });

    test("a truncated read carries the flag through", () => {
        const parsed = parseReadResponse({ ...good, truncated: true });
        expect(parsed.payload?.truncated).toBe(true);
    });

    test("a decision row is typed and a non-decision object carries no decision", () => {
        const decision = {
            decision_kind: "memory",
            payload: { summary: "s", rationale: "r" },
        };
        const parsed = parseReadResponse({
            ...good,
            rows: [
                { ...readRow("o1", 7), decision },
                { ...readRow("o2", 7, { object_kind: "observation" }), decision: null },
            ],
        });
        expect(parsed.payload?.rows[0]?.decision).toEqual(decision);
        expect(parsed.payload?.rows[1]).not.toHaveProperty("decision");
    });

    test("a non-available state carries no payload", () => {
        const parsed = parseReadResponse({
            state: { kind: "abstained", lag_positions: 9, oldest_unconsumed_age_ms: 1 },
        });
        expect(parsed.state).toEqual({
            kind: "abstained",
            lag_positions: 9,
            oldest_unconsumed_age_ms: 1,
        });
        expect(parsed.payload).toBeNull();
    });

    test.each([
        ["known_as_of as string", { ...good, known_as_of: "7" }],
        ["negative tip", { ...good, tip: -1 }],
        ["rows not an array", { ...good, rows: {} }],
        ["truncated as string", { ...good, truncated: "yes" }],
        ["row token disagrees with known_as_of", { ...good, rows: [readRow("o1", 6)] }],
        [
            "row with unknown sensitivity",
            { ...good, rows: [readRow("o1", 7, { sensitivity: "x" })] },
        ],
        ["row missing object field", { ...good, rows: [readRow("o1", 7, { domain_id: 3 })] }],
        [
            "row with bad visibility",
            { ...good, rows: [{ ...readRow("o1", 7), visibility: "shown" }] },
        ],
        [
            "decision object without its decision row",
            { ...good, rows: [{ ...readRow("o1", 7), decision: undefined }] },
        ],
        [
            "row with a decision missing its rationale",
            {
                ...good,
                rows: [
                    {
                        ...readRow("o1", 7),
                        decision: { decision_kind: "memory", payload: { summary: "s" } },
                    },
                ],
            },
        ],
    ])("%s parses to unrecognized_state", (_label, raw) => {
        const parsed = parseReadResponse(raw);
        expect(parsed.state).toEqual(UNRECOGNIZED);
        expect(parsed.payload).toBeNull();
    });
});

describe("parseCommitResponse", () => {
    test("a receipt is typed", () => {
        const parsed = parseCommitResponse({
            state: { kind: "available" },
            receipt: { commit_seq: 3, replayed: true },
            known_as_of: 3,
            tokens: [{ object_id: "o1", known_as_of: 3 }],
        });
        expect(parsed.payload).toEqual({
            receipt: { commit_seq: 3, replayed: true },
            known_as_of: 3,
            tokens: [{ object_id: "o1", known_as_of: 3 }],
        });
    });

    test.each([
        ["fractional commit_seq", { commit_seq: 1.5, replayed: false }],
        ["replayed not boolean", { commit_seq: 1, replayed: "no" }],
        ["receipt missing", undefined],
    ])("%s parses to unrecognized_state", (_label, receipt) => {
        const parsed = parseCommitResponse({
            state: { kind: "available" },
            receipt,
            known_as_of: 1,
            tokens: [],
        });
        expect(parsed.state).toEqual(UNRECOGNIZED);
    });

    test("a conflict passes through untouched", () => {
        const parsed = parseCommitResponse({ state: { kind: "conflict", reason: "retracted" } });
        expect(parsed.state).toEqual({ kind: "conflict", reason: "retracted" });
        expect(parsed.payload).toBeNull();
    });
});
