import { describe, expect, test } from "bun:test";

import { canStartDreamerEvalRun } from "../../scripts/run-dreamer-eval";

describe("dreamer eval live deadline", () => {
    test("always permits the first run and stops later runs at the deadline", () => {
        expect(canStartDreamerEvalRun(1_000, 1, 61_000, 0)).toBe(true);
        expect(canStartDreamerEvalRun(1_000, 1, 60_999, 1)).toBe(true);
        expect(canStartDreamerEvalRun(1_000, 1, 61_000, 1)).toBe(false);
    });
});
