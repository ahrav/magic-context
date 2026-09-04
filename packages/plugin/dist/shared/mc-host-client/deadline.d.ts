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
/** Immutable absolute deadline over an injectable monotonic clock. */
export declare class Deadline {
    /** Absolute end on the deadline's monotonic timeline, in milliseconds. */
    readonly endMs: number;
    private readonly clock;
    private constructor();
    /** Start an operation deadline `timeoutMs` from now on `clock`. */
    static start(timeoutMs: number, clock?: MonotonicClock): Deadline;
    /** Milliseconds until the absolute end, clamped at 0 once expired. */
    remainingMs(): number;
    /** True exactly when the clock has reached or passed the absolute end. */
    isExpired(): boolean;
    /**
     * Bounded budget for one stage: `min(capMs, remaining)`. A stage cap may
     * shorten a wait but never grants time past the operation deadline.
     */
    stageBudgetMs(capMs: number): number;
    /**
     * Derived deadline for one stage, ending at
     * `min(now + capMs, operation end)` on the same clock.
     */
    stage(capMs: number): Deadline;
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
export declare function armExpiryTimer(deadline: Deadline, onExpired: () => void, scheduler?: ExpiryTimerScheduler): () => void;
//# sourceMappingURL=deadline.d.ts.map