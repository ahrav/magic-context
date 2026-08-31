import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateCheckVector } from "../contract";
import { CHARS_PER_TOKEN } from "../../ballast";
import { pairedDeltaScenarios } from "./index";
import { r1WireDelivered } from "./support";

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
                validateCheckVector(scenario, "mc-on", passing);
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

        it(`${scenario.scenarioId} scores identical denominators on every compared arm`, () => {
            const perArm = ["mc-on", "mc-off", "compaction", "r1", "r2", "r3"].map((arm) =>
                scenario.checks.filter(({ appliesToArms }) =>
                    appliesToArms.includes(arm as never)).length);
            expect(new Set(perArm).size).toBe(1);
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
                const deliveredRows = resolvedLocatorIds
                    .map((id, index) =>
                        `[${index + 1}] [memory] score=0.91 id=${id} category=decision match=exact`)
                    .join("\n");
                const checks = await scenario.verifier({
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: `Found ${resolvedLocatorIds.length} results:\n${deliveredRows}`,
                    resolvedLocatorIds,
                });
                validateCheckVector(scenario, "r1", checks);
                expect(checks.every(({ passed }) => passed)).toBe(true);
                expect(checks.some(({ id }) => id === "check-r1-wire")).toBe(false);

                expect(r1WireDelivered(scenario, {
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: `Found 1 results:\n${deliveredRows}`,
                    resolvedLocatorIds,
                })).toBe(true);
                /** A runner that resolves only some handles would otherwise pass while R1 held less gold than R2. commentlint: allow(JUDGE) */
                expect(r1WireDelivered(scenario, {
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: `Found 1 results:\n${deliveredRows}`,
                    resolvedLocatorIds: resolvedLocatorIds.slice(0, -1),
                })).toBe(false);
                /** The empty-results renderer echoes the query, and a locator query is the resolved ids, so a bare substring test would treat zero retrieval as delivery. commentlint: allow(JUDGE) */
                expect(r1WireDelivered(scenario, {
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: `No results found for "${resolvedLocatorIds.join(" ")}" `
                        + "across notes, memories, primers, git commits, or message history.",
                    resolvedLocatorIds,
                })).toBe(false);
                expect(r1WireDelivered(scenario, {
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: scenario.interventions.r1.locatorIds.join(" "),
                })).toBe(false);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
