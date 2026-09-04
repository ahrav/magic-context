import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
 * `daemon-states.fixture.json` is written by the Rust test
 * `daemon_states_fixture_matches_the_serialized_outcome_vocabulary` from an
 * exhaustive match over `KernelOutcome`, so a vocabulary change on either
 * side fails one of the two suites.
 */
const DAEMON_STATES = JSON.parse(
    readFileSync(join(import.meta.dir, "daemon-states.fixture.json"), "utf8"),
) as Record<string, unknown>[];

const CLIENT_ONLY_KEYS: StateKey[] = [
    "disabled",
    "cancelled",
    "unavailable:daemon_absent",
    "unavailable:outcome_unknown",
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
