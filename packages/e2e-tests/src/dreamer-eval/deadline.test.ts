import { describe, expect, test } from "bun:test";

import { canStartDreamerEvalRun } from "../../scripts/run-dreamer-eval";

describe("dreamer eval live deadline", () => {
    test("a null deadline admits every run", () => {
        expect(canStartDreamerEvalRun(null, 1_000_000, 600_000, 5)).toBe(true);
    });

    test("always permits the first run even past the deadline", () => {
        expect(canStartDreamerEvalRun(60_000, 61_000, 0, 0)).toBe(true);
    });

    test("reserves the longest completed run before admitting the next", () => {
        expect(canStartDreamerEvalRun(120_000, 60_000, 60_000, 1)).toBe(true);
        expect(canStartDreamerEvalRun(120_000, 60_001, 60_000, 1)).toBe(false);
    });

    test("a zero reserve stops runs exactly at the deadline", () => {
        expect(canStartDreamerEvalRun(60_000, 60_000, 0, 1)).toBe(true);
        expect(canStartDreamerEvalRun(60_000, 60_001, 0, 1)).toBe(false);
    });
});
