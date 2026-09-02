import { describe, expect, test } from "bun:test";
import { EMPTY_PROJECT_MARKER, renderMemoryStateMarker, renderToolStateText } from "./render";

describe("render", () => {
    test("available with zero rows renders the empty-project marker", () => {
        expect(renderMemoryStateMarker({ kind: "available" }, 0)).toBe(EMPTY_PROJECT_MARKER);
    });

    test("available with rows renders nothing; the rows are the marker", () => {
        expect(renderMemoryStateMarker({ kind: "available" }, 3)).toBe("");
    });

    test("lagging states carry their lag facts", () => {
        const marker = renderMemoryStateMarker(
            { kind: "stale", lag_positions: 42, oldest_unconsumed_age_ms: 7000 },
            5,
        );
        expect(marker).toContain("42 behind");
        expect(marker).toContain("7000 ms");
    });

    test("tool text is one sentence keyed by state", () => {
        expect(renderToolStateText({ kind: "unavailable", reason: "daemon_absent" })).toContain(
            "daemon is not running",
        );
        expect(renderToolStateText({ kind: "disabled" })).toContain("memory.enabled");
    });
});
