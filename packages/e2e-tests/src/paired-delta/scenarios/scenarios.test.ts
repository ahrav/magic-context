import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateCheckVector } from "../contract";
import { CHARS_PER_TOKEN } from "../../ballast";
import { pairedDeltaScenarios } from "./index";

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

        it(`${scenario.scenarioId} enforces structural pressure and R1 wire checks`, async () => {
            expect(
                scenario.absencePrecondition.minimumBallastBytes / CHARS_PER_TOKEN,
            ).toBeGreaterThan(scenario.modelContextLimit);
            const root = mkdtempSync(join(tmpdir(), "paired-delta-scenario-"));
            try {
                mkdirSync(join(root, "result"), { recursive: true });
                writeFileSync(join(root, "result", "answer.txt"), scenario.expectedAnswer);
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

                /** The empty-results renderer echoes the query, and a locator query is the resolved ids, so a bare substring test would score zero retrieval as a pass. commentlint: allow(JUDGE) */
                const emptyRender = await scenario.verifier({
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: `No results found for "${resolvedLocatorIds.join(" ")}" `
                        + "across notes, memories, primers, git commits, or message history.",
                    resolvedLocatorIds,
                });
                expect(emptyRender.find(({ id }) => id === "check-r1-wire")?.passed).toBe(false);

                const unmapped = await scenario.verifier({
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: scenario.interventions.r1.locatorIds.join(" "),
                });
                expect(unmapped.find(({ id }) => id === "check-r1-wire")?.passed).toBe(false);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
