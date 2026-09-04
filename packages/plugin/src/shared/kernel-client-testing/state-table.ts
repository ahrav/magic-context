/**
 * Memory-surface tests use `MEMORY_STATE_TABLE` and `stubKernelClient` to
 * exercise every state without a daemon.
 */

import {
    ALL_STATE_KEYS,
    type KernelClient,
    type MemoryState,
    type ReadRow,
    type StateKey,
} from "../kernel-client";

const LAG = { lag_positions: 7, oldest_unconsumed_age_ms: 90_000 };

export function memoryStateForKey(key: StateKey): MemoryState {
    const [kind, reason] = key.split(":") as [MemoryState["kind"], string | undefined];
    switch (kind) {
        case "available":
        case "disabled":
        case "cancelled":
            return { kind };
        case "stale":
        case "abstained":
            return { kind, ...LAG };
        case "unavailable":
        case "conflict":
        case "invalid":
            return { kind, reason } as MemoryState;
    }
}

export const MEMORY_STATE_TABLE: [StateKey, MemoryState][] = ALL_STATE_KEYS.map((key) => [
    key,
    memoryStateForKey(key),
]);

/**
 * An `available` read carries `rows` at position 1; an `available` commit
 * reports one applied operation with no tokens. Only the methods the memory
 * surfaces call exist.
 */
export function stubKernelClient(state: MemoryState, rows: ReadRow[] = []): KernelClient {
    const read = async () =>
        state.kind === "available"
            ? { state, rows, known_as_of: 1, tip: 1, gated: false }
            : { state };
    const commit = async () =>
        state.kind === "available"
            ? { state, receipt: { commit_seq: 1, replayed: false }, known_as_of: 1, tokens: [] }
            : { state };
    const stub = {
        read,
        commit,
        create: commit,
        revise: commit,
        merge: commit,
        archive: commit,
    };
    return stub as unknown as KernelClient;
}
