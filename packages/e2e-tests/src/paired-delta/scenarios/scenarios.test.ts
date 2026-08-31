import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateCheckVector } from "../contract";
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
                const answer = scenario.interventions.r3.evidence;
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
            expect(scenario.absencePrecondition.minimumBallastBytes).toBeGreaterThan(
                scenario.modelContextLimit,
            );
            const root = mkdtempSync(join(tmpdir(), "paired-delta-scenario-"));
            try {
                mkdirSync(join(root, "result"), { recursive: true });
                writeFileSync(join(root, "result", "answer.txt"), scenario.interventions.r3.evidence);
                const checks = await scenario.verifier({
                    armId: "r1",
                    workspacePath: root,
                    scriptedTurnText: scenario.interventions.r1.locatorIds.join(" "),
                });
                validateCheckVector(scenario, "r1", checks);
                expect(checks.every(({ passed }) => passed)).toBe(true);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
