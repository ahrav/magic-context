import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { BOOT_QUIET_MS, scheduleAfterBootQuiet, setBootQuietPeriodForTests } from "./boot-quiet";

describe("boot quiet period", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        setBootQuietPeriodForTests(0);
    });

    afterEach(() => {
        setBootQuietPeriodForTests(null);
        jest.useRealTimers();
    });

    test("holds background work until quiet ends without gating the transform path", () => {
        let backgroundRuns = 0;
        let transformRuns = 0;

        scheduleAfterBootQuiet(() => {
            backgroundRuns += 1;
        });
        transformRuns += 1;

        jest.advanceTimersByTime(BOOT_QUIET_MS - 1);
        expect(backgroundRuns).toBe(0);
        expect(transformRuns).toBe(1);

        jest.advanceTimersByTime(1);
        expect(backgroundRuns).toBe(1);
    });

    test("keeps first project passes in separate jitter slots", () => {
        const runs: number[] = [];
        scheduleAfterBootQuiet(() => runs.push(Date.now()), 0);
        scheduleAfterBootQuiet(() => runs.push(Date.now()), 1_000);

        jest.advanceTimersByTime(BOOT_QUIET_MS);
        expect(runs).toHaveLength(1);
        jest.advanceTimersByTime(999);
        expect(runs).toHaveLength(1);
        jest.advanceTimersByTime(1);
        expect(runs).toHaveLength(2);
    });
});
