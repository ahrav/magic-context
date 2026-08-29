import { describe, expect, test } from "bun:test";

import {
    DREAMER_MUTATION_CLASSES,
    EXPECTED_MUTATION_OUTCOMES,
    runMutationBattery,
} from "./mutations";
import { dreamerScorerFixture, exitCodeForScore } from "./scorer.test";
import { scoreVerifyManifest } from "./scorer";

describe("dreamer manifest mutation battery", () => {
    test("every crafted wrong manifest turns red at its expected stage", () => {
        const evidence = runMutationBattery(dreamerScorerFixture);
        expect(evidence.green).toBe(true);
        expect(evidence.results.map((result) => result.mutationClass)).toEqual([...DREAMER_MUTATION_CLASSES]);
        for (const result of evidence.results) {
            expect(result.green).toBe(true);
            expect(result.actualStage).toBe(EXPECTED_MUTATION_OUTCOMES[result.mutationClass].stage);
            expect(result.actualReason).toBe(EXPECTED_MUTATION_OUTCOMES[result.mutationClass].reason);
        }
    });

    test("wrong archival mutations for verified and update gold carry exit 2 evidence", () => {
        const evidence = runMutationBattery(dreamerScorerFixture);
        for (const mutationClass of ["wrong-archival", "wrong-archival-update"] as const) {
            expect(evidence.results.find((entry) => entry.mutationClass === mutationClass)).toMatchObject({
                green: true,
                runFatal: true,
            });
        }
        for (const claim of ["mcm_true", "mcm_update"]) {
            const score = scoreVerifyManifest(
                `<verify>
<archive claim="${claim}" reason="wrong"/>
${claim === "mcm_true" ? '<update claim="mcm_update" files="src/cache.ts">4096 entries; bounded cache</update>' : '<verified claim="mcm_true" files="src/cache.ts,src/config.ts"/>'}
<archive claim="mcm_false" reason="removed"/>
</verify>`,
                dreamerScorerFixture.pool,
                dreamerScorerFixture.verifyGold,
            );
            expect(exitCodeForScore(score)).toBe(2);
        }
    });

    test("stage migration makes battery evidence red", () => {
        const evidence = runMutationBattery(dreamerScorerFixture, {
            "update-for-verified": "<verify>",
        });
        const result = evidence.results.find((entry) => entry.mutationClass === "update-for-verified");
        expect(result).toMatchObject({ green: false, actualStage: "validation-rejected" });
        expect(evidence.green).toBe(false);
    });
});
