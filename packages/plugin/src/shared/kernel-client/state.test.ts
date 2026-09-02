import { describe, expect, test } from "bun:test";
import { renderMemoryStateMarker, renderToolStateText } from "./render";
import {
    ALL_STATE_KEYS,
    CONFLICT_REASONS,
    INVALID_REASONS,
    MEMORY_STATE_GUIDANCE,
    type MemoryState,
    type StateKey,
    stateKey,
    UNAVAILABLE_REASONS,
} from "./state";
import { parseKernelState } from "./wire";

/**
 * Source of truth: `crates/mc-module/src/kernel_routes/state.rs`. Each entry is
 * the serde output of one `KernelOutcome` variant; the two vocabularies must
 * match one to one.
 */
const DAEMON_STATES: Record<string, unknown>[] = [
    { kind: "available" },
    { kind: "stale", lag_positions: 10_000, oldest_unconsumed_age_ms: 5 },
    { kind: "abstained", lag_positions: 3, oldest_unconsumed_age_ms: 120_000 },
    ...[
        "store_starting",
        "store_unavailable",
        "store_unsupported",
        "store_busy",
        "no_required_consumer",
        "snapshot_diverged",
        "queue_full",
    ].map((reason) => ({ kind: "unavailable", reason })),
    ...["known_as_of_advanced", "retracted", "superseded"].map((reason) => ({
        kind: "conflict",
        reason,
    })),
    ...[
        "project_mismatch",
        "operation_key_reused",
        "class_over_declared",
        "invalid_input",
        "admission_policy",
        "payload_too_large",
        "page_digest",
        "page_index",
        "page_too_large",
        "payload_digest",
        "upload_not_found",
        "ingestion_fail_closed",
        "artifact_unusable",
        "internal",
    ].map((reason) => ({ kind: "invalid", reason })),
];

const CLIENT_ONLY_KEYS: StateKey[] = [
    "disabled",
    "cancelled",
    "unavailable:daemon_absent",
    "invalid:unrecognized_state",
];

function stateFor(key: StateKey): MemoryState {
    const [kind, reason] = key.split(":");
    if (kind === "stale" || kind === "abstained") {
        return { kind, lag_positions: 1, oldest_unconsumed_age_ms: 1 };
    }
    return (reason === undefined ? { kind } : { kind, reason }) as MemoryState;
}

describe("state vocabulary", () => {
    test("the daemon literal sets match state.rs exactly", () => {
        expect([...UNAVAILABLE_REASONS]).toEqual(
            DAEMON_STATES.filter((s) => s.kind === "unavailable").map((s) => s.reason),
        );
        expect([...CONFLICT_REASONS]).toEqual(
            DAEMON_STATES.filter((s) => s.kind === "conflict").map((s) => s.reason),
        );
        expect([...INVALID_REASONS]).toEqual(
            DAEMON_STATES.filter((s) => s.kind === "invalid").map((s) => s.reason),
        );
    });

    test("every daemon-shaped state round-trips through the parser", () => {
        for (const raw of DAEMON_STATES) {
            const parsed = parseKernelState(raw);
            expect(parsed).toEqual(raw as MemoryState);
            expect(ALL_STATE_KEYS).toContain(stateKey(parsed));
        }
    });

    test("the guidance map covers exactly the daemon states plus the client-only members", () => {
        const expected = new Set<string>([
            ...DAEMON_STATES.map((raw) => stateKey(parseKernelState(raw))),
            ...CLIENT_ONLY_KEYS,
        ]);
        expect(new Set(ALL_STATE_KEYS)).toEqual(expected);
    });

    test.each(ALL_STATE_KEYS)("%s renders a non-empty marker and tool text", (key) => {
        const state = stateFor(key);
        expect(MEMORY_STATE_GUIDANCE[key].marker.length).toBeGreaterThan(0);
        expect(MEMORY_STATE_GUIDANCE[key].tool.length).toBeGreaterThan(0);
        expect(renderMemoryStateMarker(state, 0).length).toBeGreaterThan(0);
        expect(renderToolStateText(state).length).toBeGreaterThan(0);
    });

    test("unavailable and stale guidance never tells the caller to retry", () => {
        for (const key of ALL_STATE_KEYS) {
            if (!key.startsWith("unavailable") && key !== "stale") continue;
            const { marker, tool } = MEMORY_STATE_GUIDANCE[key];
            expect(`${marker} ${tool}`.toLowerCase()).not.toContain("retry");
            expect(renderMemoryStateMarker(stateFor(key), 0).toLowerCase()).not.toContain("retry");
        }
    });
});
