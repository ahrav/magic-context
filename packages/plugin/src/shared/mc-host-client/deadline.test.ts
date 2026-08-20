import { describe, expect, test } from "bun:test";
import { Deadline, type MonotonicClock } from "./deadline";

function fakeClock(startMs = 0): { clock: MonotonicClock; advance: (ms: number) => void } {
    let now = startMs;
    return {
        clock: () => now,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

describe("Deadline", () => {
    test("remaining time counts down on the injected clock", () => {
        const { clock, advance } = fakeClock(1_000);
        const deadline = Deadline.start(500, clock);
        expect(deadline.endMs).toBe(1_500);
        expect(deadline.remainingMs()).toBe(500);
        advance(200);
        expect(deadline.remainingMs()).toBe(300);
    });

    test("expiry is deterministic exactly at the boundary", () => {
        const { clock, advance } = fakeClock();
        const deadline = Deadline.start(100, clock);
        advance(99);
        expect(deadline.isExpired()).toBe(false);
        expect(deadline.remainingMs()).toBe(1);
        advance(1);
        expect(deadline.isExpired()).toBe(true);
        expect(deadline.remainingMs()).toBe(0);
        advance(1_000);
        expect(deadline.isExpired()).toBe(true);
        expect(deadline.remainingMs()).toBe(0);
    });

    test("stage budget takes the cap when the cap is shorter", () => {
        const { clock } = fakeClock();
        const deadline = Deadline.start(10_000, clock);
        expect(deadline.stageBudgetMs(2_000)).toBe(2_000);
    });

    test("stage budget takes the remaining time when the cap is longer", () => {
        const { clock, advance } = fakeClock();
        const deadline = Deadline.start(1_000, clock);
        advance(800);
        expect(deadline.stageBudgetMs(30_000)).toBe(200);
    });

    test("a derived stage deadline never extends the operation end", () => {
        const { clock, advance } = fakeClock();
        const operation = Deadline.start(1_000, clock);
        advance(900);
        const stage = operation.stage(30_000);
        expect(stage.endMs).toBe(operation.endMs);
        advance(100);
        expect(stage.isExpired()).toBe(true);
        expect(operation.isExpired()).toBe(true);
    });

    test("a stage deadline cannot pass the operation end when the clock advances between samples", () => {
        let now = 0;
        // Every read advances the clock, as a real clock does between the
        // budget sample and the end-computation sample inside stage().
        const clock: MonotonicClock = () => (now += 50);
        const operation = Deadline.start(1_000, clock);
        const stage = operation.stage(30_000);
        expect(stage.endMs).toBeLessThanOrEqual(operation.endMs);
    });

    test("repeated stage derivation across retries cannot reset the deadline", () => {
        const { clock, advance } = fakeClock();
        const operation = Deadline.start(1_000, clock);
        for (let attempt = 0; attempt < 10; attempt++) {
            const stage = operation.stage(400);
            expect(stage.endMs).toBeLessThanOrEqual(operation.endMs);
            advance(stage.stageBudgetMs(400));
            if (operation.isExpired()) break;
        }
        expect(clock()).toBe(operation.endMs);
        expect(operation.isExpired()).toBe(true);
        expect(operation.stage(400).stageBudgetMs(400)).toBe(0);
    });

    test("the absolute end is immutable", () => {
        const { clock } = fakeClock();
        const deadline = Deadline.start(100, clock);
        expect(Object.isFrozen(deadline)).toBe(true);
        expect(() => {
            (deadline as unknown as { endMs: number }).endMs = 999_999;
        }).toThrow();
        expect(deadline.endMs).toBe(100);
    });

    test("an expired deadline yields zero stage budget, never a negative one", () => {
        const { clock, advance } = fakeClock();
        const deadline = Deadline.start(50, clock);
        advance(500);
        expect(deadline.stageBudgetMs(1_000)).toBe(0);
        expect(deadline.stage(1_000).remainingMs()).toBe(0);
    });

    test("rejects non-finite and negative timeouts and caps", () => {
        const { clock } = fakeClock();
        expect(() => Deadline.start(-1, clock)).toThrow(RangeError);
        expect(() => Deadline.start(Number.NaN, clock)).toThrow(RangeError);
        expect(() => Deadline.start(Number.POSITIVE_INFINITY, clock)).toThrow(RangeError);
        const deadline = Deadline.start(100, clock);
        expect(() => deadline.stageBudgetMs(-1)).toThrow(RangeError);
        expect(() => deadline.stageBudgetMs(Number.NaN)).toThrow(RangeError);
    });

    test("uses a real monotonic clock by default", () => {
        const deadline = Deadline.start(60_000);
        expect(deadline.isExpired()).toBe(false);
        expect(deadline.remainingMs()).toBeGreaterThan(0);
        expect(deadline.remainingMs()).toBeLessThanOrEqual(60_000);
    });
});
