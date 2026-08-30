import { describe, expect, test } from "bun:test";

import {
    DREAMER_EVAL_COVERAGE_SCHEMA,
    canStartDreamerEvalRun,
    dreamerEvalOutputDirConflict,
    dreamerEvalRunCoverage,
    type DreamerEvalGroupCoverage,
} from "../../scripts/run-dreamer-eval";

function group(overrides: Partial<DreamerEvalGroupCoverage> = {}): DreamerEvalGroupCoverage {
    return {
        scenarioId: "dme-core-pool",
        task: "verify",
        requestedRuns: 3,
        archivedRuns: 3,
        varianceArchived: true,
        ...overrides,
    };
}

const intact = { deadlineReached: false, runFailed: false, aggregationFailed: false };

describe("dreamer eval live deadline", () => {
    test("a null deadline admits every run", () => {
        expect(canStartDreamerEvalRun(null, 1_000_000, 600_000, 5)).toBe(true);
    });

    test("always permits the first run even past the deadline", () => {
        expect(canStartDreamerEvalRun(60_000, 61_000, 0, 0)).toBe(true);
    });

    test("reserves the longest completed run before admitting the next", () => {
        expect(canStartDreamerEvalRun(120_000, 60_000, 60_000, 1)).toBe(true);
        expect(canStartDreamerEvalRun(120_000, 60_001, 60_000, 1)).toBe(false);
    });

    test("a zero reserve stops runs exactly at the deadline", () => {
        expect(canStartDreamerEvalRun(60_000, 60_000, 0, 1)).toBe(true);
        expect(canStartDreamerEvalRun(60_000, 60_001, 0, 1)).toBe(false);
    });
});

describe("dreamer eval run coverage", () => {
    test("a fully archived run is complete", () => {
        const coverage = dreamerEvalRunCoverage([group(), group({ task: "map-memories" })], intact);
        expect(coverage.schema).toBe(DREAMER_EVAL_COVERAGE_SCHEMA);
        expect(coverage.requestedRuns).toBe(6);
        expect(coverage.archivedRuns).toBe(6);
        expect(coverage.complete).toBe(true);
    });

    // The gap finding #3 named: without the requested count beside it, one report
    // aggregates into a `variance.json` reading `repeatCount: 1` — a complete
    // one-repeat experiment rather than a curtailed three-repeat one.
    test("a truncated group keeps the repeats it never ran", () => {
        const coverage = dreamerEvalRunCoverage([group({ archivedRuns: 1 })], {
            ...intact,
            deadlineReached: true,
        });
        expect(coverage.groups[0]).toMatchObject({ requestedRuns: 3, archivedRuns: 1 });
        expect(coverage.archivedRuns).toBe(1);
        expect(coverage.complete).toBe(false);
        expect(coverage.deadlineReached).toBe(true);
    });

    // The gap finding #1 named: a wholly skipped group writes no directory, so
    // only an explicit entry separates it from one a CLI filter excluded.
    test("a wholly skipped group is still listed", () => {
        const coverage = dreamerEvalRunCoverage(
            [group(), group({ task: "classify-memories", archivedRuns: 0, varianceArchived: false })],
            { ...intact, deadlineReached: true },
        );
        expect(coverage.groups.map((entry) => entry.task)).toEqual(["verify", "classify-memories"]);
        expect(coverage.groups[1]).toMatchObject({ requestedRuns: 3, archivedRuns: 0 });
        expect(coverage.complete).toBe(false);
    });

    // An unfiltered group is absent rather than present with a zero count, which
    // is what makes "selected but skipped" readable as distinct from "excluded".
    test("only selected groups appear", () => {
        const coverage = dreamerEvalRunCoverage([group()], intact);
        expect(coverage.groups).toHaveLength(1);
    });

    test("every requested run archived but no variance is incomplete", () => {
        const coverage = dreamerEvalRunCoverage([group({ varianceArchived: false })], {
            ...intact,
            aggregationFailed: true,
        });
        expect(coverage.archivedRuns).toBe(coverage.requestedRuns);
        expect(coverage.complete).toBe(false);
        expect(coverage.aggregationFailed).toBe(true);
    });

    test("the artifact does not alias the caller's mutable group state", () => {
        const groups = [group({ archivedRuns: 1 })];
        const coverage = dreamerEvalRunCoverage(groups, intact);
        groups[0]!.archivedRuns = 3;
        expect(coverage.groups[0]?.archivedRuns).toBe(1);
    });
});

describe("dreamer eval output directory", () => {
    test("an empty or absent directory is accepted", () => {
        expect(dreamerEvalOutputDirConflict([])).toBeNull();
    });

    // Run ids are per-run UUIDs, so reports accumulate instead of replacing each
    // other: without this guard `archivedRuns` counts one invocation's reports
    // while the directory holds another's, and counting files disproves it.
    test("a directory holding previous evidence is refused", () => {
        const conflict = dreamerEvalOutputDirConflict(["coverage.json", "dme-core-pool"]);
        expect(conflict).not.toBeNull();
        expect(conflict).toContain("coverage.json");
        expect(conflict).toContain("dme-core-pool");
    });

    test("the reason names entries in a stable order and elides a long tail", () => {
        const conflict = dreamerEvalOutputDirConflict(["g", "f", "e", "d", "c", "b", "a"]);
        expect(conflict).toContain("a, b, c, d, e");
        expect(conflict).not.toContain(", f");
        expect(conflict).toContain("2 more");
    });

    test("exactly five entries are all named", () => {
        const conflict = dreamerEvalOutputDirConflict(["a", "b", "c", "d", "e"]);
        expect(conflict).toContain("a, b, c, d, e");
        expect(conflict).not.toContain("more");
    });
});
