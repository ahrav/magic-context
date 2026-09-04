/**
 * Minimal 5-field cron evaluator for per-task dreamer scheduling.
 *
 * Why vendored (no dependency): we only need "next occurrence after time T", the
 * 3-day package-release-age floor makes pulling a dep awkward, and the surface is
 * small. Shared core — both OpenCode and Pi import this via @magic-context/core.
 *
 * Fields: `minute hour day-of-month month day-of-week`
 *   minute 0-59 · hour 0-23 · dom 1-31 · month 1-12 · dow 0-6 (0 or 7 = Sunday)
 * Each field supports: a star wildcard, a star-with-step (every-N), a single
 * value `a`, a range `a-b`, a range-with-step `a-b/step`, an open step `a/step`
 * (a..max), and comma-lists of any of those. Numeric only — month and weekday
 * NAMES are intentionally unsupported (smaller surface; add later if asked).
 * Empty string `""` means "never" and is handled by the caller, not here.
 *
 * Day matching uses Vixie OR-semantics: when BOTH dom and dow are restricted
 * (not `*`), a day matches if EITHER matches; when only one is restricted, only
 * that one is consulted; when neither is restricted, every day matches.
 *
 * Timezone: all matching is in the machine's LOCAL time — the dreamer's whole
 * purpose is "run while the user is asleep", which is a wall-clock concept.
 * nextOccurrence steps by real (epoch) minutes and reads LOCAL civil fields off
 * each candidate, so DST transitions are handled correctly by construction (no
 * setHours/local-constructor normalization, which is DST-ambiguous).
 */
export interface ParsedCron {
    minute: Set<number>;
    hour: Set<number>;
    dom: Set<number>;
    month: Set<number>;
    dow: Set<number>;
    /** Original field token was not `*` — drives Vixie dom/dow OR-semantics. */
    domRestricted: boolean;
    dowRestricted: boolean;
}
export type ParseCronResult = {
    ok: true;
    cron: ParsedCron;
} | {
    ok: false;
    error: string;
};
/** Parse a 5-field cron expression. Empty/whitespace is rejected here — callers
 *  treat `""` as "never" before calling. */
export declare function parseCron(expression: string): ParseCronResult;
/** True if the expression parses; thin wrapper for config validation. */
export declare function isValidCron(expression: string): boolean;
/** True if `date`'s local civil fields match the cron. */
export declare function matchesCron(cron: ParsedCron, date: Date): boolean;
/**
 * First instant strictly after `after` whose LOCAL civil time matches `cron`.
 * Returns null if none within the ~4-year cap (effectively-never schedules).
 *
 * @param excludeCivilMinute Skip any candidate sharing this `YYYY-MM-DD HH:mm`
 *   key. Pass the just-consumed run's scheduled civil minute when advancing
 *   `next_due_at` so a DST fall-back's repeated wall minute doesn't double-fire
 *   the same daily slot. (For sub-hourly every-N schedules, only the exact
 *   consumed minute is skipped; the other repeated-hour minutes still fire, which
 *   is correct — more real time elapsed.)
 */
export declare function nextOccurrence(cron: ParsedCron, after: Date, excludeCivilMinute?: string, maxSearchMs?: number): Date | null;
/**
 * Convenience: parse + compute next-due epoch (ms) for a schedule string.
 * Returns null for `""` / invalid / effectively-never schedules — the caller
 * persists `next_due_at = NULL` in all of those cases.
 *
 * @param consumedScheduledAtMs When advancing after a run, pass the epoch of the
 *   slot just satisfied (the prior `next_due_at`); its civil minute is excluded
 *   to prevent the DST repeated-minute double-fire.
 */
export declare function nextDueAtMs(expression: string, afterMs: number, consumedScheduledAtMs?: number, maxSearchMs?: number): number | null;
//# sourceMappingURL=cron.d.ts.map