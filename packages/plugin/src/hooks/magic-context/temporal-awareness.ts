/**
 *
 * The plugin prepends markers when the gap since the previous message is at least TEMPORAL_AWARENESS_THRESHOLD_SECONDS.
 *      TEMPORAL_AWARENESS_THRESHOLD_SECONDS.
 *
 * The gap is measured from the previous message's effective end time:
 *
 */

import { peelLeadingMcTagNotation } from "./tag-content-primitives";

/* */
export const TEMPORAL_AWARENESS_THRESHOLD_SECONDS = 300;

/* */
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = 24 * 60 * 60;
const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;

/**
 *
 *
 */
export function formatGap(seconds: number): string | null {
    if (!Number.isFinite(seconds) || seconds < TEMPORAL_AWARENESS_THRESHOLD_SECONDS) {
        return null;
    }

    if (seconds < SECONDS_PER_HOUR) {
        const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
        return `+${minutes}m`;
    }

    if (seconds < SECONDS_PER_DAY) {
        const hours = Math.floor(seconds / SECONDS_PER_HOUR);
        const minutes = Math.floor((seconds - hours * SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
        return minutes === 0 ? `+${hours}h` : `+${hours}h ${minutes}m`;
    }

    if (seconds < SECONDS_PER_WEEK) {
        const days = Math.floor(seconds / SECONDS_PER_DAY);
        const hours = Math.floor((seconds - days * SECONDS_PER_DAY) / SECONDS_PER_HOUR);
        return hours === 0 ? `+${days}d` : `+${days}d ${hours}h`;
    }

    const weeks = Math.floor(seconds / SECONDS_PER_WEEK);
    const days = Math.floor((seconds - weeks * SECONDS_PER_WEEK) / SECONDS_PER_DAY);
    return days === 0 ? `+${weeks}w` : `+${weeks}w ${days}d`;
}

/**
 *
 */
export function effectiveEndMs(time: { created: number; completed?: number }): number {
    return time.completed ?? time.created;
}

/**
 * `formatDate` formats Unix ms timestamps as YYYY-MM-DD in the process local timezone.
 * Session-history headings use this format for date ranges.
 */
export function formatDate(ms: number): string {
    const d = new Date(ms);
    const yyyy = d.getFullYear().toString().padStart(4, "0");
    const mm = (d.getMonth() + 1).toString().padStart(2, "0");
    const dd = d.getDate().toString().padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * The pattern prevents duplicate markers on retried transform passes. */
export const TEMPORAL_MARKER_PATTERN = /^<!-- \+[\d]+[mhdw](?: [\d]+[mhdw])? -->\n/;

/**
 */
export function temporalMarkerPrefix(seconds: number): string | null {
    const marker = formatGap(seconds);
    if (!marker) return null;
    return `<!-- ${marker} -->\n`;
}

/**
 */
type MessageLikeWithTime = {
    info: { role?: string; time?: { created?: number; completed?: number } };
    parts: unknown[];
};

type MutableTextPart = {
    type?: string;
    text?: string;
    ignored?: boolean;
};

function isMutableTextPart(part: unknown): part is MutableTextPart {
    if (part === null || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    return p.type === "text" && typeof p.text === "string";
}

function findFirstVisibleTextPart(parts: unknown[]): MutableTextPart | null {
    for (const p of parts) {
        if (!isMutableTextPart(p)) continue;
        if (p.ignored === true) continue;
        return p;
    }
    return null;
}

/**
 *
 * Injection is idempotent when the text body already starts with a temporal marker.
 *
 */
export function injectTemporalMarkers(messages: unknown[]): number {
    let injected = 0;
    let prev: MessageLikeWithTime | null = null;

    for (const raw of messages) {
        if (!raw || typeof raw !== "object") continue;
        const msg = raw as MessageLikeWithTime;
        const role = msg.info?.role;

        if (prev !== null && role === "user") {
            const prevTime = prev.info?.time;
            const currTime = msg.info?.time;
            if (prevTime?.created !== undefined && currTime?.created !== undefined) {
                const prevEnd = prevTime.completed ?? prevTime.created;
                const gapSec = (currTime.created - prevEnd) / 1000;
                const prefix = temporalMarkerPrefix(gapSec);
                if (prefix && Array.isArray(msg.parts)) {
                    const target = findFirstVisibleTextPart(msg.parts);
                    if (target && typeof target.text === "string") {
                        const { tagPrefix, body } = peelLeadingMcTagNotation(target.text);
                        if (!TEMPORAL_MARKER_PATTERN.test(body)) {
                            target.text = tagPrefix + prefix + body;
                            injected++;
                        }
                    }
                }
            }
        }

        prev = msg;
    }

    return injected;
}
