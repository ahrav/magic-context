/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { isValidCron, matchesCron, nextDueAtMs, nextOccurrence, parseCron } from "./cron";

function parsed(expr: string) {
    const r = parseCron(expr);
    if (!r.ok) throw new Error(`expected "${expr}" to parse: ${r.error}`);
    return r.cron;
}

// All tests use the LOCAL Date constructor + local getters so they are
// timezone-independent (construction and assertion share the machine's tz).
function local(y: number, mo1: number, d: number, h = 0, mi = 0): Date {
    return new Date(y, mo1 - 1, d, h, mi, 0, 0);
}

describe("parseCron — valid forms", () => {
    it("accepts wildcards", () => {
        expect(isValidCron("* * * * *")).toBe(true);
    });
    it("accepts nightly", () => {
        const c = parsed("0 3 * * *");
        expect([...c.minute]).toEqual([0]);
        expect([...c.hour]).toEqual([3]);
        expect(c.domRestricted).toBe(false);
        expect(c.dowRestricted).toBe(false);
    });
    it("accepts lists", () => {
        expect([...parsed("0,15,30,45 * * * *").minute].sort((a, b) => a - b)).toEqual([
            0, 15, 30, 45,
        ]);
    });
    it("accepts ranges", () => {
        expect([...parsed("0 9-17 * * *").hour].sort((a, b) => a - b)).toEqual([
            9, 10, 11, 12, 13, 14, 15, 16, 17,
        ]);
    });
    it("accepts */step", () => {
        expect([...parsed("*/15 * * * *").minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    });
    it("accepts a-b/step", () => {
        expect([...parsed("1-30/10 * * * *").minute].sort((a, b) => a - b)).toEqual([1, 11, 21]);
    });
    it("accepts a/step (open upper bound = a..max)", () => {
        expect([...parsed("50/5 * * * *").minute].sort((a, b) => a - b)).toEqual([50, 55]);
    });
    it("accepts dow 7 as Sunday alias (normalized to 0)", () => {
        expect([...parsed("0 0 * * 7").dow]).toEqual([0]);
        expect([...parsed("0 0 * * 0").dow]).toEqual([0]);
    });
    it("accepts combined list+range+step", () => {
        expect([...parsed("0 0,6-8,*/12 * * *").hour].sort((a, b) => a - b)).toEqual([
            0, 6, 7, 8, 12,
        ]);
    });
});

describe("parseCron — rejections", () => {
    it.each([
        ["", "empty"],
        ["* * * *", "4 fields"],
        ["* * * * * *", "6 fields"],
        ["60 * * * *", "minute out of range"],
        ["* 24 * * *", "hour out of range"],
        ["* * 0 * *", "dom below min"],
        ["* * 32 * *", "dom above max"],
        ["* * * 13 *", "month out of range"],
        ["* * * * 8", "dow above max"],
        ["*/0 * * * *", "zero step"],
        ["5-1 * * * *", "inverted range"],
        ["a * * * *", "non-numeric"],
        ["1//2 * * * *", "double slash"],
        ["1-2-3 * * * *", "double dash"],
        [", * * * *", "empty list element"],
    ])("rejects %p (%s)", (expr) => {
        expect(isValidCron(expr)).toBe(false);
    });
});

describe("matchesCron — dom/dow OR semantics", () => {
    it("neither restricted → every day matches", () => {
        const c = parsed("0 0 * * *");
        expect(matchesCron(c, local(2026, 6, 1, 0, 0))).toBe(true); // any date
    });
    it("only dom restricted → only that dom", () => {
        const c = parsed("0 0 15 * *");
        expect(matchesCron(c, local(2026, 6, 15, 0, 0))).toBe(true);
        expect(matchesCron(c, local(2026, 6, 16, 0, 0))).toBe(false);
    });
    it("only dow restricted → only that weekday", () => {
        // The first fixture date is a Sunday.
        const c = parsed("0 0 * * 0");
        expect(local(2026, 6, 7).getDay()).toBe(0);
        expect(matchesCron(c, local(2026, 6, 7, 0, 0))).toBe(true);
        expect(matchesCron(c, local(2026, 6, 8, 0, 0))).toBe(false);
    });
    it("both restricted → OR (either matches)", () => {
        // dom=15 OR dow=0(Sun). The day-15 fixture is a Monday (dom hit, dow miss).
        const c = parsed("0 0 15 * 0");
        expect(local(2026, 6, 15).getDay()).toBe(1); // Monday
        expect(matchesCron(c, local(2026, 6, 15, 0, 0))).toBe(true); // dom matches
        expect(matchesCron(c, local(2026, 6, 7, 0, 0))).toBe(true); // dow (Sun) matches
        expect(matchesCron(c, local(2026, 6, 8, 0, 0))).toBe(false); // neither
    });
});

describe("nextOccurrence", () => {
    it("is strictly after, even when `after` sits exactly on a match", () => {
        const c = parsed("0 3 * * *");
        const next = nextOccurrence(c, local(2026, 1, 1, 3, 0));
        expect(next).not.toBeNull();
        // not the same instant — must advance to the next day's 03:00
        expect(next?.getTime()).toBe(local(2026, 1, 2, 3, 0).getTime());
    });
    it("nightly from midday → same-or-next day 03:00", () => {
        const c = parsed("0 3 * * *");
        const next = nextOccurrence(c, local(2026, 1, 1, 12, 0));
        expect(next?.getTime()).toBe(local(2026, 1, 2, 3, 0).getTime());
    });
    it("hourly */15", () => {
        const c = parsed("*/15 * * * *");
        const next = nextOccurrence(c, local(2026, 1, 1, 3, 7));
        expect(next?.getTime()).toBe(local(2026, 1, 1, 3, 15).getTime());
    });
    it("weekly Sunday 03:00", () => {
        const c = parsed("0 3 * * 0");
        // From the Monday fixture, the next match is the following Sunday.
        const next = nextOccurrence(c, local(2026, 6, 8, 12, 0));
        expect(next?.getDay()).toBe(0);
        expect(next?.getTime()).toBe(local(2026, 6, 14, 3, 0).getTime());
    });
    it("leap-year Feb 29 resolves", () => {
        // 2028 is a leap year.
        const c = parsed("0 0 29 2 *");
        const next = nextOccurrence(c, local(2026, 3, 1, 0, 0));
        expect(next?.getTime()).toBe(local(2028, 2, 29, 0, 0).getTime());
    });
    it("impossible cron (Feb 31) → null", () => {
        const c = parsed("0 0 31 2 *");
        expect(nextOccurrence(c, local(2026, 1, 1, 0, 0))).toBeNull();
    });
    it("excludeCivilMinute skips a matching candidate (DST double-fire guard)", () => {
        const c = parsed("30 1 * * *"); // 01:30 daily
        const day1 = local(2026, 1, 1, 1, 30);
        // Without exclusion, from 01:00 we'd get 01:30 same day.
        expect(nextOccurrence(c, local(2026, 1, 1, 1, 0))?.getTime()).toBe(day1.getTime());
        // Excluding that exact civil minute pushes to the next day's 01:30.
        const key = "2026-01-01 01:30";
        const next = nextOccurrence(c, local(2026, 1, 1, 1, 0), key);
        expect(next?.getTime()).toBe(local(2026, 1, 2, 1, 30).getTime());
    });
});

describe("nextDueAtMs", () => {
    it("empty string → null (never)", () => {
        expect(nextDueAtMs("", Date.now())).toBeNull();
    });
    it("invalid expression → null", () => {
        expect(nextDueAtMs("not a cron", Date.now())).toBeNull();
    });
    it("impossible cron → null", () => {
        expect(nextDueAtMs("0 0 31 2 *", local(2026, 1, 1).getTime())).toBeNull();
    });
    it("coalesces from finish time (a long run that overran its slot)", () => {
        const c = "*/15 * * * *";
        // Task due 03:00, finished 03:20 → next must be 03:30, NOT 03:15-in-the-past.
        const finishedAt = local(2026, 1, 1, 3, 20).getTime();
        const next = nextDueAtMs(c, finishedAt);
        expect(next).toBe(local(2026, 1, 1, 3, 30).getTime());
    });
    it("excludes the consumed scheduled minute", () => {
        const c = "30 1 * * *";
        const consumed = local(2026, 1, 1, 1, 30).getTime();
        // Finishing at 01:31 the same civil minute would otherwise still be 'after';
        // exclusion guarantees we jump to the next day.
        const next = nextDueAtMs(c, local(2026, 1, 1, 1, 31).getTime(), consumed);
        expect(next).toBe(local(2026, 1, 2, 1, 30).getTime());
    });
});
