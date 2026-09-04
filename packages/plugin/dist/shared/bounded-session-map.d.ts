/**
 * Bounded LRU map keyed by session id.
 *
 * Rationale: magic-context maintains several module-scope Maps that track
 * per-session state (prepared injection cache, per-message token cache, etc.).
 * These are cleared on the `session.deleted` event, but sessions that are
 * never explicitly deleted — because OpenCode crashed, the user force-quit,
 * the session was archived rather than deleted, or the session simply outlived
 * the plugin process's interest in it — leak entries for the lifetime of the
 * plugin process.
 *
 * In long-running OpenCode instances with thousands of sessions over time,
 * an unbounded `Map<sessionId, LargeObject>` can retain tens of megabytes
 * indefinitely. A session-scoped LRU with a generous cap (e.g. 100) covers
 * any realistic working-set of active sessions a user actually cares about,
 * while evicting cold session ids that will either never return or be
 * rebuilt from durable SQLite state on their next transform pass.
 *
 * Implementation notes:
 * - Built on `Map` which preserves insertion order. On every `set`/`get`
 *   touch we delete+reinsert to move the key to the tail (most-recent).
 * - Eviction drops the oldest entry (first in iteration order).
 * - The cached value type is generic — callers decide what per-session state
 *   to store. For injection/token state, all three properties of the cached
 *   object are safe to throw away: they are either recomputable from the
 *   messages array on the next pass, or reloadable from SQLite.
 */
export declare class BoundedSessionMap<V> {
    private readonly maxEntries;
    private readonly store;
    constructor(maxEntries: number);
    get(sessionId: string): V | undefined;
    /**
     * Peek without touching recency — useful for `has`-style checks that
     * should not rearrange LRU order. Use sparingly; `get` is the normal
     * access path.
     */
    peek(sessionId: string): V | undefined;
    has(sessionId: string): boolean;
    set(sessionId: string, value: V): void;
    delete(sessionId: string): boolean;
    clear(): void;
    get size(): number;
}
//# sourceMappingURL=bounded-session-map.d.ts.map