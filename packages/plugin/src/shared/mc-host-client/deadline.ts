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
