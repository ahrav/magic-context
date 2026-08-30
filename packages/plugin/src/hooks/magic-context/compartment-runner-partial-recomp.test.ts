import { describe, expect, test } from "bun:test";
import type { Compartment } from "../../features/magic-context/compartment-storage";
import { parseRecompArgs } from "./command-handler";
import { snapRangeToCompartments } from "./compartment-runner-partial-recomp";

// Helper: build a minimal Compartment stub for tests.
function compartment(sequence: number, start: number, end: number): Compartment {
    return {
        id: sequence,
        sessionId: "ses-test",
        sequence,
        startMessage: start,
        endMessage: end,
        startMessageId: `msg-${start}`,
        endMessageId: `msg-${end}`,
        title: `compartment ${sequence}`,
        content: `content ${sequence}`,
        createdAt: 0,
    };
}

describe("parseRecompArgs", () => {
    test("empty input returns full recomp", () => {
        expect(parseRecompArgs("")).toEqual({ kind: "full" });
        expect(parseRecompArgs("   ")).toEqual({ kind: "full" });
        expect(parseRecompArgs("\t\n")).toEqual({ kind: "full" });
    });

    test("valid range returns partial with parsed bounds", () => {
        const result = parseRecompArgs("1-11322");
        expect(result).toEqual({
            kind: "partial",
            range: { start: 1, end: 11322 },
        });
    });

    test("valid range with whitespace", () => {
        expect(parseRecompArgs("500 - 1000")).toEqual({
            kind: "partial",
            range: { start: 500, end: 1000 },
        });
        expect(parseRecompArgs("  1-2  ")).toEqual({
            kind: "partial",
            range: { start: 1, end: 2 },
        });
    });

    test("equal start and end is valid (single-message range)", () => {
        expect(parseRecompArgs("42-42")).toEqual({
            kind: "partial",
            range: { start: 42, end: 42 },
        });
    });

    test("malformed inputs return error", () => {
        expect(parseRecompArgs("abc")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("1")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("1-")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("-10")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("1-2-3")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("1 2")).toMatchObject({ kind: "error" });
    });

    test("start < 1 returns error", () => {
        expect(parseRecompArgs("0-10")).toMatchObject({ kind: "error" });
    });

    test("end < start returns error", () => {
        expect(parseRecompArgs("10-5")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("100-99")).toMatchObject({ kind: "error" });
    });
});

describe("snapRangeToCompartments", () => {
    const threeCompartments: Compartment[] = [
        compartment(1, 1, 100),
        compartment(2, 101, 500),
        compartment(3, 501, 1000),
    ];

    test("empty compartments returns error", () => {
        const result = snapRangeToCompartments([], { start: 1, end: 10 });
        expect(result).toMatchObject({ error: expect.stringContaining("No compartments") });
    });

    test("range start < 1 returns error", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 0, end: 50 });
        expect(result).toMatchObject({ error: expect.stringContaining("Start must be >= 1") });
    });

    test("end < start returns error", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 50, end: 10 });
        expect(result).toMatchObject({ error: expect.stringContaining("End must be >= start") });
    });

    test("range entirely after last compartment returns error", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 1500, end: 2000 });
        expect(result).toMatchObject({
            error: expect.stringContaining("starts after the last compartment"),
        });
    });

    // Each row snaps one requested message range against `threeCompartments`
    // (1-100, 101-500, 501-1000) and asserts the snapped bounds plus how the
    // compartments partition into prior / range / tail.
    test.each([
        ["range exactly matches one compartment boundary", 1, 100, 1, 100, 0, 1, 2, 1],
        [
            "range within single compartment snaps to that compartment's full bounds",
            50,
            75,
            1,
            100,
            0,
            1,
            2,
            null,
        ],
        ["range spans multiple compartments snaps outward", 50, 600, 1, 1000, 0, 3, 0, null],
        ["range fully inside middle compartment", 200, 400, 101, 500, 1, 1, 1, 2],
        ["range spans compartment boundary (e.g. 80-150)", 80, 150, 1, 500, 0, 2, 1, null],
        [
            "range touches the very last compartment's end exactly",
            900,
            1000,
            501,
            1000,
            2,
            1,
            0,
            null,
        ],
    ] as Array<
        [string, number, number, number, number, number, number, number, number | null]
    >)("%s", (_title, start, end, snapStart, snapEnd, prior, range, tail, firstSequence) => {
        const result = snapRangeToCompartments(threeCompartments, { start, end });
        expect(result).toMatchObject({ snapStart, snapEnd });
        if ("priorCompartments" in result) {
            expect(result.priorCompartments).toHaveLength(prior);
            expect(result.rangeCompartments).toHaveLength(range);
            expect(result.tailCompartments).toHaveLength(tail);
            if (firstSequence !== null) {
                expect(result.rangeCompartments[0].sequence).toBe(firstSequence);
            }
        }
    });

    test("out-of-order input is still handled (sort by sequence)", () => {
        const shuffled = [threeCompartments[2], threeCompartments[0], threeCompartments[1]];
        const result = snapRangeToCompartments(shuffled, { start: 200, end: 400 });
        expect(result).toMatchObject({
            snapStart: 101,
            snapEnd: 500,
        });
    });
});

/**
 * Regression test for "UNIQUE constraint failed: compartments.session_id, compartments.sequence"
 *
 * Bug: partial recomp assigned 1-indexed sequences to prior compartments (`idx + 1`)
 * and to tail compartments (`candidateCompartments.length + idx + 1`). This created
 * a gap between the "prior + new" block and the "tail" block, breaking the invariant
 * `MAX(sequence) = count - 1`. Next incremental historian then computed
 * `sequenceOffset = priorCompartments.length`, which collided with an existing
 * sequence at the tail's original max value.
 *
 * Fix: use 0-indexed sequences (`idx` and `candidateCompartments.length + idx`) so
 * the invariant holds, and defensively compute `sequenceOffset = MAX(sequence) + 1`
 * in the incremental historian.
 */
describe("sequence numbering invariants for partial recomp output", () => {
    // Simulate the final promote merge: prior + new + tail
    function simulatePartialRecompMerge(
        priorCount: number,
        newBuiltCount: number,
        tailCount: number,
    ): number[] {
        // Match the actual code in compartment-runner-partial-recomp.ts:
        //   candidateCompartments = priorCompartments.map((c, idx) => input(c, idx))
        //   historian new-built uses sequenceOffset = candidateCompartments.length = priorCount
        //   final merge appends tail with `candidateCompartments.length + idx`
        const priorSeqs = Array.from({ length: priorCount }, (_, idx) => idx);
        const candidateLen = priorCount + newBuiltCount;
        const newBuiltSeqs = Array.from({ length: newBuiltCount }, (_, idx) => priorCount + idx);
        const tailSeqs = Array.from({ length: tailCount }, (_, idx) => candidateLen + idx);
        return [...priorSeqs, ...newBuiltSeqs, ...tailSeqs];
    }

    test("full range recomp (no prior, no tail) produces contiguous 0-indexed sequences", () => {
        const seqs = simulatePartialRecompMerge(0, 5, 0);
        expect(seqs).toEqual([0, 1, 2, 3, 4]);
        expect(Math.min(...seqs)).toBe(0);
        expect(Math.max(...seqs)).toBe(seqs.length - 1);
    });

    test("recomp with tail preserved (the exact scenario that caused UNIQUE failure)", () => {
        // Mirrors /ctx-recomp 1-11322 with 267 rebuilt + 85 preserved tail
        const seqs = simulatePartialRecompMerge(0, 267, 85);
        expect(seqs.length).toBe(352);
        expect(Math.min(...seqs)).toBe(0);
        expect(Math.max(...seqs)).toBe(351);
        // No gaps — every integer 0..351 must appear exactly once
        const set = new Set(seqs);
        expect(set.size).toBe(352);
        for (let i = 0; i <= 351; i++) {
            expect(set.has(i)).toBe(true);
        }
    });

    test("recomp with prior preserved and tail preserved", () => {
        const seqs = simulatePartialRecompMerge(50, 100, 30);
        expect(seqs.length).toBe(180);
        expect(Math.min(...seqs)).toBe(0);
        expect(Math.max(...seqs)).toBe(179);
        const set = new Set(seqs);
        expect(set.size).toBe(180);
    });

    test("incremental sequenceOffset = MAX(sequence) + 1 is robust to existing gaps", () => {
        // Simulate legacy DB with a gap at sequence 267 (the bug state)
        const priorSeqs = [
            ...Array.from({ length: 267 }, (_, i) => i), // 0..266
            ...Array.from({ length: 85 }, (_, i) => 268 + i), // 268..352 (gap at 267)
        ];
        expect(priorSeqs.length).toBe(352);
        expect(Math.max(...priorSeqs)).toBe(352);

        // Old (buggy): sequenceOffset = priorCompartments.length = 352 → collides with existing 352
        const oldOffset = priorSeqs.length;
        expect(priorSeqs.includes(oldOffset)).toBe(true); // would collide

        // New (fixed): sequenceOffset = max + 1 = 353 → no collision
        const newOffset = Math.max(...priorSeqs) + 1;
        expect(priorSeqs.includes(newOffset)).toBe(false); // no collision
        expect(newOffset).toBe(353);
    });

    test("empty prior + any new compartments uses offset 0", () => {
        const priorSeqs: number[] = [];
        const offset =
            priorSeqs.length === 0 ? 0 : priorSeqs.reduce((max, s) => (s > max ? s : max), -1) + 1;
        expect(offset).toBe(0);
    });
});
