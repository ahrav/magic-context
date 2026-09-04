/**
 * Temporal awareness utilities.
 *
 * When enabled via experimental.temporal_awareness, the plugin:
 *   1. Prepends <!-- +Xm --> / <!-- +2h 15m --> / <!-- +3d 4h --> HTML comments
 *      to user messages where the gap since the previous message exceeds
 *      TEMPORAL_AWARENESS_THRESHOLD_SECONDS.
 *   2. Adds a compact date range to each `## start-end · date · title` heading
 *      in the injected <session-history> block.
 *
 * The gap is measured from the previous message's effective end time:
 *   - Assistant (completed): prev.time.completed
 *   - Assistant (in-flight/aborted): prev.time.created (best available)
 *   - User: prev.time.created (user messages have no completed field)
 *
 * All values are derived deterministically from immutable message timestamps,
 * so injection is stable across transform passes and cache-safe.
 */
/** User message gaps below this threshold get no marker. 5 minutes. */
export declare const TEMPORAL_AWARENESS_THRESHOLD_SECONDS = 300;
/**
 * Format a gap in seconds as a compact adaptive string.
 * Returns null for gaps below the threshold (no marker should be injected).
 *
 *   < 5 min   → null
 *   5 min - 1 hour    → "+Xm"          (e.g. "+12m")
 *   1 hour - 1 day    → "+Xh Ym" / "+Xh" when Y == 0
 *   1 day - 1 week    → "+Xd Yh" / "+Xd" when Y == 0
 *   >= 1 week         → "+Xw Yd" / "+Xw" when Y == 0
 *
 * Non-finite, negative, or zero deltas return null.
 */
export declare function formatGap(seconds: number): string | null;
/**
 * Compute the effective end time for a raw OpenCode message given its
 * time.created and optional time.completed fields.
 *
 * For completed assistants use `completed`; for everything else (user messages,
 * in-flight/aborted assistants) use `created`.
 */
export declare function effectiveEndMs(time: {
    created: number;
    completed?: number;
}): number;
/**
 * Format a Unix ms timestamp as YYYY-MM-DD in the process local timezone.
 * Used for compartment heading date ranges.
 */
export declare function formatDate(ms: number): string;
/** Regex matching the injected HTML comment so we can recognize / avoid
 *  double-injecting on retried transform passes. */
export declare const TEMPORAL_MARKER_PATTERN: RegExp;
/**
 * Produce the HTML comment prefix line for a given gap marker, or null if the
 * gap is below threshold.
 */
export declare function temporalMarkerPrefix(seconds: number): string | null;
/**
 * Inject HTML-comment gap markers into user-message text parts when
 * temporal awareness is enabled and the gap since the previous message's
 * effective end time exceeds TEMPORAL_AWARENESS_THRESHOLD_SECONDS.
 *
 * Idempotent: if a text already starts with a temporal marker (e.g. from a
 * previous transform pass), injection is skipped. Returns the number of
 * messages that received a new marker.
 *
 * The marker is prepended BEFORE any §N§ tag added by tagMessages runs after
 * this function, since tagging happens in the normal transform flow and
 * stripTagPrefix re-strips `§N§` on re-tagging — leaving the marker intact
 * between the tag and the user's text on subsequent passes.
 */
export declare function injectTemporalMarkers(messages: unknown[]): number;
//# sourceMappingURL=temporal-awareness.d.ts.map