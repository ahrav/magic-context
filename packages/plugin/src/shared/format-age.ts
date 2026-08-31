/**
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
    // Use `days < 365`: at 360–364 days, `months` is 12, while `months < 12` produces `0y ago`.
    // Use `days < 365`: at 360–364 days, `months` is 12, while `months < 12` produces `0y ago`.
    if (days < 365) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? "1y ago" : `${years}y ago`;
}
