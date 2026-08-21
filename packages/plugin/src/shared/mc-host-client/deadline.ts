/**
 * One immutable absolute deadline per operation.
 *
 * The deadline is fixed on the injected monotonic timeline at creation.
 * Derived stage budgets may shorten a wait but can never extend or reset the
 * operation's absolute end, so a retry loop cannot multiply its own budget.
 *
 * Leaf module: no imports from connection or facade code.
 */

/** Milliseconds on a monotonic timeline. Injectable for deterministic tests. */
export type MonotonicClock = () => number;

const defaultClock: MonotonicClock = () => performance.now();

/** Immutable absolute deadline over an injectable monotonic clock. */
export class Deadline {
    /** Absolute end on the deadline's monotonic timeline, in milliseconds. */
    readonly endMs: number;
    private readonly clock: MonotonicClock;

    private constructor(endMs: number, clock: MonotonicClock) {
        this.endMs = endMs;
        this.clock = clock;
        Object.freeze(this);
    }

    /** Start an operation deadline `timeoutMs` from now on `clock`. */
    static start(timeoutMs: number, clock: MonotonicClock = defaultClock): Deadline {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
            throw new RangeError(
                `deadline timeout must be a finite non-negative number of ms, got ${timeoutMs}`,
            );
        }
        return new Deadline(clock() + timeoutMs, clock);
    }

    /** Milliseconds until the absolute end, clamped at 0 once expired. */
    remainingMs(): number {
        return Math.max(0, this.endMs - this.clock());
    }

    /** True exactly when the clock has reached or passed the absolute end. */
    isExpired(): boolean {
        return this.clock() >= this.endMs;
    }

    /**
     * Bounded budget for one stage: `min(capMs, remaining)`. A stage cap may
     * shorten a wait but never grants time past the operation deadline.
     */
    stageBudgetMs(capMs: number): number {
        if (!Number.isFinite(capMs) || capMs < 0) {
            throw new RangeError(
                `stage cap must be a finite non-negative number of ms, got ${capMs}`,
            );
        }
        return Math.min(capMs, this.remainingMs());
    }

    /**
     * Derived deadline for one stage, ending at
     * `min(now + capMs, operation end)` on the same clock.
     */
    stage(capMs: number): Deadline {
        const budgetMs = this.stageBudgetMs(capMs);
        // Clamp to the operation end: the clock advances between the budget
        // sample and this sample, and that drift must never extend the stage
        // past the operation's absolute end.
        return new Deadline(Math.min(this.clock() + budgetMs, this.endMs), this.clock);
    }
}

/**
 * Timer hooks for {@link armExpiryTimer}. Callers with tracked timers (a
 * connection's retirement-gated timer set) plug in their own schedule/cancel
 * pair; the default is a plain `setTimeout`/`clearTimeout`.
 */
export interface ExpiryTimerScheduler {
    schedule(fn: () => void, ms: number): unknown;
    cancel(handle: unknown): void;
}

const defaultScheduler: ExpiryTimerScheduler = {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Run `onExpired` only once `deadline.isExpired()` is provably true.
 *
 * `setTimeout` truncates fractional delays and its clock is sampled
 * independently of the deadline's, so a single-shot timer armed with
 * `remainingMs()` can fire a sub-millisecond slice before the monotonic end.
 * Callers that consult `isExpired()` after receiving a deadline rejection —
 * the one-shot replay-token gates — need the two to agree: an early-fired
 * deadline error while `isExpired()` still reads false lets the replay token
 * spend a spurious extra connect and route open. This re-arms until the
 * deadline is provably expired, so `onExpired` implies `isExpired()`.
 *
 * Returns a cancel function that stays valid across re-arms.
 */
export function armExpiryTimer(
    deadline: Deadline,
    onExpired: () => void,
    scheduler: ExpiryTimerScheduler = defaultScheduler,
): () => void {
    let handle: unknown;
    const fire = (): void => {
        if (!deadline.isExpired()) {
            // Re-arms floor at 1ms: near expiry remainingMs() is fractional,
            // and a 0ms reschedule loop would spin the event loop until the
            // clock crosses the end. The initial arm floors at 0 so an
            // already-expired deadline still fires (and rejects) immediately.
            handle = scheduler.schedule(fire, Math.max(1, deadline.remainingMs()));
            return;
        }
        onExpired();
    };
    handle = scheduler.schedule(fire, Math.max(0, deadline.remainingMs()));
    return () => scheduler.cancel(handle);
}
