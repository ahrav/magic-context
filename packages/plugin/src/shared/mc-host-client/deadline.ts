/**
 * Each `Deadline` instance is immutable and has an absolute end time.
 *
 * The deadline is fixed on the injected monotonic timeline at creation.
 * A stage budget never extends or resets the operation deadline.
 *
 */

/** Milliseconds on a monotonic timeline. Injectable for deterministic tests. */
export type MonotonicClock = () => number;

const defaultClock: MonotonicClock = () => performance.now();

/* */
export class Deadline {
    /** Absolute end on the deadline's monotonic timeline, in milliseconds. */
    readonly endMs: number;
    private readonly clock: MonotonicClock;

    private constructor(endMs: number, clock: MonotonicClock) {
        this.endMs = endMs;
        this.clock = clock;
        Object.freeze(this);
    }

    /* */
    static start(timeoutMs: number, clock: MonotonicClock = defaultClock): Deadline {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
            throw new RangeError(
                `deadline timeout must be a finite non-negative number of ms, got ${timeoutMs}`,
            );
        }
        return new Deadline(clock() + timeoutMs, clock);
    }

    /* */
    remainingMs(): number {
        return Math.max(0, this.endMs - this.clock());
    }

    /* */
    isExpired(): boolean {
        return this.clock() >= this.endMs;
    }

    /**
     * A stage cap never grants time past the operation deadline.
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
     * A stage deadline never exceeds the operation deadline.
     */
    stage(capMs: number): Deadline {
        const budgetMs = this.stageBudgetMs(capMs);
        // Clamp the stage end to `endMs` because the clock can advance between samples.
        return new Deadline(Math.min(this.clock() + budgetMs, this.endMs), this.clock);
    }
}

/**
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
 * The timer re-arms until `deadline.isExpired()` is true.
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
            // Use a 1 ms minimum delay when less than 1 ms remains to avoid a 0 ms rearm loop.
            // A 0 ms reschedule can repeatedly invoke `fire` before the deadline passes.
            // The initial arm uses a 0 ms delay for an already expired deadline.
            handle = scheduler.schedule(fire, Math.max(1, deadline.remainingMs()));
            return;
        }
        onExpired();
    };
    handle = scheduler.schedule(fire, Math.max(0, deadline.remainingMs()));
    return () => scheduler.cancel(handle);
}
