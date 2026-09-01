import { describe, expect, test } from "bun:test";
import {
    armExpiryTimer,
    Deadline,
    type ExpiryTimerScheduler,
    type MonotonicClock,
} from "./deadline";

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
        // Each clock read advances 50 ms to simulate elapsed time between stage() samples.
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

/* */
function fakeScheduler(): {
    scheduler: ExpiryTimerScheduler;
    fireNext: () => void;
    scheduledCount: () => number;
    cancelledCount: () => number;
} {
    let nextHandle = 0;
    const armed = new Map<number, () => void>();
    let scheduled = 0;
    let cancelled = 0;
    return {
        scheduler: {
            schedule: (fn: () => void) => {
                scheduled += 1;
                nextHandle += 1;
                armed.set(nextHandle, fn);
                return nextHandle;
            },
            cancel: (handle: unknown) => {
                if (armed.delete(handle as number)) cancelled += 1;
            },
        },
        fireNext: () => {
            const [handle, fn] = [...armed.entries()][0] ?? [];
            if (handle === undefined || !fn) throw new Error("no timer armed");
            armed.delete(handle);
            fn();
        },
        scheduledCount: () => scheduled,
        cancelledCount: () => cancelled,
    };
}

describe("armExpiryTimer", () => {
    test("an early-fired timer re-arms instead of reporting expiry", () => {
        const { clock, advance } = fakeClock();
        const { scheduler, fireNext, scheduledCount } = fakeScheduler();
        const deadline = Deadline.start(30, clock);
        let expired = 0;
        armExpiryTimer(deadline, () => (expired += 1), scheduler);

        // setTimeout can fire before endMs when its delay is truncated.
        // The expiry callback must not run before isExpired() returns true.
        advance(29);
        fireNext();
        expect(expired).toBe(0);
        expect(scheduledCount()).toBe(2);

        // After re-arming the expiry timer, the expiry callback runs only after isExpired() returns true.
        advance(1);
        expect(deadline.isExpired()).toBe(true);
        fireNext();
        expect(expired).toBe(1);
    });

    test("re-arms repeatedly until the deadline is provably expired", () => {
        const { clock, advance } = fakeClock();
        const { scheduler, fireNext } = fakeScheduler();
        const deadline = Deadline.start(10, clock);
        let expired = 0;
        armExpiryTimer(deadline, () => (expired += 1), scheduler);

        for (let elapsed = 0; elapsed < 10; elapsed += 2) {
            fireNext();
            expect(expired).toBe(0);
            advance(2);
        }
        fireNext();
        expect(expired).toBe(1);
    });

    test("cancel stays valid across re-arms", () => {
        const { clock, advance } = fakeClock();
        const { scheduler, fireNext, cancelledCount } = fakeScheduler();
        const deadline = Deadline.start(30, clock);
        let expired = 0;
        const cancel = armExpiryTimer(deadline, () => (expired += 1), scheduler);

        advance(15);
        fireNext(); // early fire → re-arm replaces the original handle
        cancel(); // must cancel the re-armed timer, not the stale handle
        expect(cancelledCount()).toBe(1);
        advance(1_000);
        expect(deadline.isExpired()).toBe(true);
        expect(expired).toBe(0);
        expect(() => fireNext()).toThrow("no timer armed");
    });

    test("an already-expired deadline reports on the first fire", () => {
        const { clock, advance } = fakeClock();
        const { scheduler, fireNext } = fakeScheduler();
        const deadline = Deadline.start(5, clock);
        advance(10);
        let expired = 0;
        armExpiryTimer(deadline, () => (expired += 1), scheduler);
        fireNext();
        expect(expired).toBe(1);
    });
});
