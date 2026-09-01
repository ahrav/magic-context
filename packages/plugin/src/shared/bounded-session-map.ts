/**
 *
 * plugin process.
 *
 *
 * Implementation notes:
 * `Map` preserves insertion order.
 * `get` refreshes keys whose stored value is not `undefined`; `set` refreshes existing keys by deleting and reinserting them.
 * - Eviction drops the oldest entry (first in iteration order).
 */
export class BoundedSessionMap<V> {
    private readonly maxEntries: number;
    private readonly store = new Map<string, V>();

    constructor(maxEntries: number) {
        if (!Number.isFinite(maxEntries) || maxEntries < 1) {
            throw new Error(`BoundedSessionMap: maxEntries must be >= 1, got ${maxEntries}`);
        }
        this.maxEntries = maxEntries;
    }

    get(sessionId: string): V | undefined {
        const value = this.store.get(sessionId);
        if (value === undefined) return undefined;
        // Deleting and reinserting `sessionId` refreshes its recency when its stored value is not `undefined`.
        this.store.delete(sessionId);
        this.store.set(sessionId, value);
        return value;
    }

    /**
     * `peek` reads `sessionId` without changing its LRU recency.
     * access path.
     */
    peek(sessionId: string): V | undefined {
        return this.store.get(sessionId);
    }

    has(sessionId: string): boolean {
        return this.store.has(sessionId);
    }

    set(sessionId: string, value: V): void {
        if (this.store.has(sessionId)) {
            // Refresh recency.
            this.store.delete(sessionId);
        } else if (this.store.size >= this.maxEntries) {
            // `set` evicts the least recently used entry when adding a new key to a full `store`; `Map` iterates in insertion order.
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined) this.store.delete(oldest);
        }
        this.store.set(sessionId, value);
    }

    delete(sessionId: string): boolean {
        return this.store.delete(sessionId);
    }

    clear(): void {
        this.store.clear();
    }

    get size(): number {
        return this.store.size;
    }
}
