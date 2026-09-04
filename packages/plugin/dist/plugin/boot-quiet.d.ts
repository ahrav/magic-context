/**
 * Background maintenance waits after the first plugin construction so a
 * sibling process can finish its startup reads and migrations before writers
 * begin. This is intentionally fixed rather than user-configurable.
 */
export declare const BOOT_QUIET_MS = 120000;
export declare function beginBootQuietPeriod(now?: number): void;
export declare function bootQuietRemainingMs(now?: number): number;
export declare function scheduleAfterBootQuiet(task: () => void, additionalDelayMs?: number): ReturnType<typeof setTimeout>;
/** Test seam for deterministic fake-timer coverage. */
export declare function setBootQuietPeriodForTests(startAtMs: number | null): void;
//# sourceMappingURL=boot-quiet.d.ts.map