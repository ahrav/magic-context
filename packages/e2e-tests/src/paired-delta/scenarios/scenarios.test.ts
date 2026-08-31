import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateCheckVector } from "../contract";
import { CHARS_PER_TOKEN } from "../../ballast";
import { pairedDeltaScenarios } from "./index";
import { r1WireDelivered } from "./support";
import { packSearchResults } from "../../../../plugin/src/tools/ctx-search/render";
import type { MemorySearchResult } from "../../../../plugin/src/features/magic-context/search";

/** Renders through the real `ctx_search` packer rather than a hand-written string, so a change to the memory-row format breaks this test instead of silently making `r1WireDelivered` reject every genuine retrieval. commentlint: allow(JUDGE) */
function realWireText(resolvedIds: readonly string[]): string {
    const results: MemorySearchResult[] = resolvedIds.map((publicClaimId, index) => ({
        source: "memory",
        content: `Gold row ${index}.`,
        score: 0.91,
        publicClaimId,
        revisionLocator: `${publicClaimId}/r1/${"a".repeat(64)}`,
        category: "decision",
        matchType: "exact",
    }));
    return packSearchResults("query", results, "session-under-test", 0).text;
}

describe("paired-delta authored scenarios", () => {
    it("contains ten information-absence scenarios across four families", () => {
        expect(pairedDeltaScenarios).toHaveLength(10);
        expect(new Set(pairedDeltaScenarios.map(({ familyId }) => familyId)).size).toBe(4);
        expect(new Set(pairedDeltaScenarios.map(({ scenarioId }) => scenarioId)).size).toBe(10);
    });

    for (const scenario of pairedDeltaScenarios) {
        it(`${scenario.scenarioId} verifies passing and failing independent state`, async () => {
            const root = mkdtempSync(join(tmpdir(), "paired-delta-scenario-"));
            try {
                mkdirSync(join(root, "result"), { recursive: true });
                const answer = scenario.expectedAnswer;
                writeFileSync(join(root, "result", "answer.txt"), answer);
                const passing = await scenario.verifier({
                    armId: "mc-on",
                    workspacePath: root,
                });
                validateCheckVector(scenario, passing);
                expect(passing.every(({ passed }) => passed)).toBe(true);

                writeFileSync(join(root, "result", "answer.txt"), "wrong");
                const failing = await scenario.verifier({
                    armId: "mc-on",
                    workspacePath: root,
                });
                expect(failing.find(({ id }) => id === "check-answer")?.passed).toBe(false);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        it(`${scenario.scenarioId} applies its declared answer-casing policy`, async () => {
            const answer = scenario.expectedAnswer;
            const swapped = answer.toUpperCase() === answer
                ? answer.toLowerCase()
                : answer.toUpperCase();
            /** An all-digit answer cannot be case-swapped, so asserting a policy against it would pass under either mode. Assert the vacuity instead, so this branch is taken only for genuinely caseless answers and a future answer that gains letters lands in the real check below. commentlint: allow(JUDGE) */
            if (swapped === answer) {
                expect(answer).not.toMatch(/\p{L}/u);
                return;
            }
            const root = mkdtempSync(join(tmpdir(), "paired-delta-scenario-"));
            try {
                mkdirSync(join(root, "result"), { recursive: true });
                writeFileSync(join(root, "result", "answer.txt"), swapped);
                const checks = await scenario.verifier({ armId: "mc-on", workspacePath: root });
                const passed = checks.find(({ id }) => id === "check-answer")?.passed;
                expect(passed).toBe(scenario.answerMatch === "case-insensitive");
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        it(`${scenario.scenarioId} gates R1 wire delivery outside the scored checks`, async () => {
            const root = mkdtempSync(join(tmpdir(), "paired-delta-scenario-"));
            try {
                mkdirSync(join(root, "result"), { recursive: true });
                writeFileSync(join(root, "result", "answer.txt"), scenario.expectedAnswer);
                expect(
                    scenario.absencePrecondition.minimumBallastBytes / CHARS_PER_TOKEN,
                ).toBeGreaterThan(scenario.modelContextLimit);
                /** Stand in for the runner's handle-to-publicClaimId mapping: the search turn is served resolved ids, so the declared `mem-*` handles never reach the wire text. commentlint: allow(JUDGE) */
                const resolvedLocatorIds = scenario.interventions.r1.locatorIds.map(
                    (_handle, index) => `mcm_${String(index).padStart(32, "0")}`,
                );
                const deliveredWire = realWireText(resolvedLocatorIds);
                const checks = await scenario.verifier({
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: deliveredWire,
                    resolvedLocatorIds,
                });
                validateCheckVector(scenario, checks);
                expect(checks.every(({ passed }) => passed)).toBe(true);
                expect(checks.some(({ id }) => id === "check-r1-wire")).toBe(false);

                expect(r1WireDelivered(scenario, {
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: deliveredWire,
                    resolvedLocatorIds,
                })).toBe(true);
                /** A runner that resolves only some handles would otherwise pass while R1 held less gold than R2. commentlint: allow(JUDGE) */
                expect(r1WireDelivered(scenario, {
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: deliveredWire,
                    resolvedLocatorIds: resolvedLocatorIds.slice(0, -1),
                })).toBe(false);
                /** The empty-results renderer echoes the query, and a locator query is the resolved ids, so a bare substring test would treat zero retrieval as delivery. commentlint: allow(JUDGE) */
                expect(r1WireDelivered(scenario, {
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: packSearchResults(
                        resolvedLocatorIds.join(" "), [], "session-under-test", 0,
                    ).text,
                    resolvedLocatorIds,
                })).toBe(false);
                expect(r1WireDelivered(scenario, {
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: scenario.interventions.r1.locatorIds.join(" "),
                })).toBe(false);
                /** An empty id degenerates the marker to `id=`, which every rendered memory row contains. commentlint: allow(JUDGE) */
                expect(r1WireDelivered(scenario, {
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: deliveredWire,
                    resolvedLocatorIds: resolvedLocatorIds.map(() => ""),
                })).toBe(false);
                expect(r1WireDelivered(scenario, {
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: deliveredWire,
                    resolvedLocatorIds: scenario.interventions.r1.locatorIds,
                })).toBe(false);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
