/**
 * Agent-facing age vocabulary shared by the explicit `ctx_search` renderer and
 * the auto-search hint, so the two surfaces always describe the same record
 * with the same age wording.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function formatAge(timestampMs: number, nowMs: number = Date.now()): string {
    const ageMs = nowMs - timestampMs;
    if (ageMs < 0) return "future";
    const days = Math.floor(ageMs / MS_PER_DAY);
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months === 1) return "1mo ago";
    // Guard on days, not months: 360-364 days is months === 12 but not yet a
    // year, and `months < 12` would fall through to a `0y ago` answer.
    if (days < 365) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? "1y ago" : `${years}y ago`;
}
