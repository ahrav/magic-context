/**
 * Evaluates five-field cron expressions for dreamer scheduling.
 *
 *
 * Empty string `""` means "never" and is handled by the caller, not here.
 *
 * Day matching uses Vixie OR-semantics: when BOTH dom and dow are restricted
 * (not `*`), a day matches if EITHER matches; when only one is restricted, only
 * that one is consulted; when neither is restricted, every day matches.
 *
 * Timezone: all matching is in the machine's LOCAL time — the dreamer's whole
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

export type ParseCronResult = { ok: true; cron: ParsedCron } | { ok: false; error: string };

interface FieldSpec {
    name: string;
    min: number;
    max: number;
}

const FIELDS: FieldSpec[] = [
    { name: "minute", min: 0, max: 59 },
    { name: "hour", min: 0, max: 23 },
    { name: "day-of-month", min: 1, max: 31 },
    { name: "month", min: 1, max: 12 },
    { name: "day-of-week", min: 0, max: 7 }, // 7 normalized to 0 (Sunday)
];

const MINUTE_MS = 60_000;
/**
 * Search for at most 4 × 366 days; return null when no match is found.
 * Anything past the bound is treated as "never" (for example, impossible `0 0 31 2 *`).
 */
const MAX_SEARCH_MS = 4 * 366 * 24 * 60 * MINUTE_MS;

/* */
function parseField(token: string, spec: FieldSpec): Set<number> | null {
    const values = new Set<number>();
    const normalize = (n: number): number => (spec.name === "day-of-week" && n === 7 ? 0 : n);

    for (const part of token.split(",")) {
        const piece = part.trim();
        if (piece.length === 0) return null;

        const [rangePart, stepPart, ...extra] = piece.split("/");
        if (extra.length > 0) return null;
        let step = 1;
        if (stepPart !== undefined) {
            if (!/^\d+$/.test(stepPart)) return null;
            step = Number(stepPart);
            if (step < 1) return null;
        }

        let lo: number;
        let hi: number;
        if (rangePart === "*") {
            lo = spec.min;
            hi = spec.max;
        } else if (rangePart.includes("-")) {
            const [loStr, hiStr, ...rest] = rangePart.split("-");
            if (rest.length > 0) return null;
            if (!/^\d+$/.test(loStr) || !/^\d+$/.test(hiStr)) return null;
            lo = Number(loStr);
            hi = Number(hiStr);
        } else {
            if (!/^\d+$/.test(rangePart)) return null;
            lo = Number(rangePart);
            // `a/step` (no upper bound) means a..max by step.
            hi = stepPart !== undefined ? spec.max : lo;
        }

        // Validate against the field range BEFORE dow-7 normalization so `7` is
        // accepted (it's a valid Sunday alias) but `8` is rejected.
        if (lo < spec.min || lo > spec.max || hi < spec.min || hi > spec.max) return null;
        if (lo > hi) return null;

        for (let v = lo; v <= hi; v += step) {
            values.add(normalize(v));
        }
    }

    return values.size > 0 ? values : null;
}

/** Empty or whitespace-only input is rejected; callers handle `""` as "never" before calling.
 * */
export function parseCron(expression: string): ParseCronResult {
    const trimmed = expression.trim();
    if (trimmed.length === 0) {
        return { ok: false, error: "empty cron expression" };
    }
    const tokens = trimmed.split(/\s+/);
    if (tokens.length !== 5) {
        return {
            ok: false,
            error: `expected 5 fields (minute hour day-of-month month day-of-week), got ${tokens.length}`,
        };
    }

    const sets: Set<number>[] = [];
    for (let i = 0; i < FIELDS.length; i++) {
        const parsed = parseField(tokens[i], FIELDS[i]);
        if (!parsed) {
            return {
                ok: false,
                error: `invalid ${FIELDS[i].name} field "${tokens[i]}" (allowed ${FIELDS[i].min}-${FIELDS[i].max})`,
            };
        }
        sets.push(parsed);
    }

    return {
        ok: true,
        cron: {
            minute: sets[0],
            hour: sets[1],
            dom: sets[2],
            month: sets[3],
            dow: sets[4],
            domRestricted: tokens[2] !== "*",
            dowRestricted: tokens[4] !== "*",
        },
    };
}

/* */
export function isValidCron(expression: string): boolean {
    return parseCron(expression).ok;
}

function matchesDay(cron: ParsedCron, date: Date): boolean {
    const dom = cron.dom.has(date.getDate());
    const dow = cron.dow.has(date.getDay());
    if (cron.domRestricted && cron.dowRestricted) return dom || dow;
    if (cron.domRestricted) return dom;
    if (cron.dowRestricted) return dow;
    return true;
}

/* */
export function matchesCron(cron: ParsedCron, date: Date): boolean {
    return (
        cron.minute.has(date.getMinutes()) &&
        cron.hour.has(date.getHours()) &&
        cron.month.has(date.getMonth() + 1) &&
        matchesDay(cron, date)
    );
}

/** Local civil-minute key `YYYY-MM-DD HH:mm` — used to dedupe the repeated wall
 *  minute on a DST fall-back so a run isn't fired twice for the same slot. */
function civilMinuteKey(date: Date): string {
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(date.getFullYear(), 4)}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/**
 * First instant strictly after `after` whose LOCAL civil time matches `cron`.
 * Returns null if no occurrence exists within the search cap.
 *
 * @param excludeCivilMinute Skip any candidate sharing this `YYYY-MM-DD HH:mm`
 *   key. Pass the just-consumed run's scheduled civil minute when advancing
 *   `next_due_at` so a DST fall-back's repeated wall minute doesn't double-fire
 * For sub-hourly every-N schedules, only the consumed minute is skipped; other repeated-hour minutes still fire because more real time elapsed.
 */
export function nextOccurrence(
    cron: ParsedCron,
    after: Date,
    excludeCivilMinute?: string,
    maxSearchMs = MAX_SEARCH_MS,
): Date | null {
    const afterMs = after.getTime();
    let cursorMs = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    const capMs = afterMs + Math.max(0, Math.min(MAX_SEARCH_MS, maxSearchMs));

    while (cursorMs <= capMs) {
        const candidate = new Date(cursorMs);
        if (matchesCron(cron, candidate)) {
            if (!excludeCivilMinute || civilMinuteKey(candidate) !== excludeCivilMinute) {
                return candidate;
            }
        }
        cursorMs += MINUTE_MS;
    }
    return null;
}

/**
 * Returns `null` for empty, invalid, or schedules with no occurrence within the search cap.
 *
 * @param consumedScheduledAtMs When advancing after a run, pass the epoch of the
 *   slot just satisfied (the prior `next_due_at`); its civil minute is excluded
 * The exclusion prevents a DST repeated minute from firing twice.
 */
export function nextDueAtMs(
    expression: string,
    afterMs: number,
    consumedScheduledAtMs?: number,
    maxSearchMs = MAX_SEARCH_MS,
): number | null {
    if (expression.trim().length === 0) return null;
    const parsed = parseCron(expression);
    if (!parsed.ok) return null;
    const exclude =
        consumedScheduledAtMs !== undefined
            ? civilMinuteKey(new Date(consumedScheduledAtMs))
            : undefined;
    const next = nextOccurrence(parsed.cron, new Date(afterMs), exclude, maxSearchMs);
    return next ? next.getTime() : null;
}
