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

    test("wrong archival mutation carries exit 2 evidence", () => {
        const result = runMutationBattery(dreamerScorerFixture).results.find(
            (entry) => entry.mutationClass === "wrong-archival",
        );
        expect(result).toMatchObject({ green: true, runFatal: true });
        const score = scoreVerifyManifest(
            `<verify>
<archive claim="mcm_true" reason="wrong"/>
<update claim="mcm_update" files="src/cache.ts">4096 entries; bounded cache</update>
<archive claim="mcm_false" reason="removed"/>
</verify>`,
            dreamerScorerFixture.pool,
            dreamerScorerFixture.verifyGold,
        );
        expect(exitCodeForScore(score)).toBe(2);
    });

    test("stage migration makes battery evidence red", () => {
        const evidence = runMutationBattery(dreamerScorerFixture, {
            "update-for-verified": "<verify>",
        });
        const result = evidence.results.find((entry) => entry.mutationClass === "update-for-verified");
        expect(result).toMatchObject({ green: false, actualStage: "validation-rejected" });
        expect(evidence.green).toBe(false);
    });

    test("missed archival stays scoreable when the archived claim carries no mapping", () => {
        // Retaining a claim requires a backing set, so the mutation needs a
        // stand-in file here; emitting an empty attribute would be rejected as
        // invalid output before the scorer could observe the missed archival.
        const fixture = {
            ...dreamerScorerFixture,
            pool: {
                ...dreamerScorerFixture.pool,
                claims: dreamerScorerFixture.pool.claims.map((claim) =>
                    claim.claimId === "claim-false" ? { ...claim, files: [] } : claim,
                ),
            },
        };
        const evidence = runMutationBattery(fixture);
        expect(evidence.results.find((entry) => entry.mutationClass === "missed-archival")).toMatchObject({
            green: true,
            actualStage: "scored",
            actualReason: "missed-archival",
        });
        expect(evidence.green).toBe(true);
    });

    test("missing gold file targets its own claim when two claims share a file set", () => {
        const shared = ["src/cache.ts", "src/config.ts"];
        const fixture = {
            ...dreamerScorerFixture,
            mapGold: {
                kind: "map" as const,
                claims: [
                    { claimId: "claim-true", files: shared, independent: false },
                    { claimId: "claim-update", files: shared, independent: false },
                    { claimId: "claim-independent", files: [], independent: true },
                ],
            },
        };
        const evidence = runMutationBattery(fixture);
        expect(evidence.results.find((entry) => entry.mutationClass === "missing-gold-file")).toMatchObject({
            green: true,
            actualStage: "scored",
            actualReason: "wrong-mapping",
        });
        expect(evidence.green).toBe(true);
    });

    test("the missing-anchor mutation omits an anchor the gold actually requires", () => {
        // A fixed replacement sentence can contain the gold's anchors by
        // accident: with `facts` required, the old sentence scored PASS, so the
        // battery reported a red case while exercising nothing.
        const fixture = {
            ...dreamerScorerFixture,
            verifyGold: {
                kind: "verify" as const,
                claims: dreamerScorerFixture.verifyGold.claims.map((claim) =>
                    claim.verdict === "update"
                        ? {
                              ...claim,
                              requiredUpdateAnchors: ["facts"],
                              forbiddenUpdateAnchors: ["2048 entries"],
                          }
                        : claim,
                ),
            },
        };
        const evidence = runMutationBattery(fixture);
        expect(evidence.results.find((entry) => entry.mutationClass === "update-missing-anchor")).toMatchObject({
            green: true,
            actualStage: "scored",
            actualReason: "wrong-update-content",
        });
        expect(evidence.green).toBe(true);
    });

    test("the passing baseline avoids a forbidden phrase spanning two anchors", () => {
        // The contract rejects a forbidden anchor inside one required anchor but
        // not one spanning their join, so the delimiter-joined baseline would
        // fail its own scorer and make the battery throw.
        const fixture = {
            ...dreamerScorerFixture,
            verifyGold: {
                kind: "verify" as const,
                claims: dreamerScorerFixture.verifyGold.claims.map((claim) =>
                    claim.verdict === "update"
                        ? {
                              ...claim,
                              requiredUpdateAnchors: ["alpha", "beta"],
                              forbiddenUpdateAnchors: ["alpha; beta"],
                          }
                        : claim,
                ),
            },
        };
        expect(runMutationBattery(fixture).green).toBe(true);
    });

    test("a single-file map gold still yields a changed manifest", () => {
        const fixture = {
            ...dreamerScorerFixture,
            mapGold: {
                kind: "map" as const,
                claims: [
                    // Exactly the stand-in path the mutation used to hard-code:
                    // reusing it produces no textual change and throws instead
                    // of producing the mutation.
                    { claimId: "claim-true", files: ["mutation/other.ts"], independent: false },
                    { claimId: "claim-independent", files: [], independent: true },
                ],
            },
        };
        const evidence = runMutationBattery(fixture);
        expect(evidence.results.find((entry) => entry.mutationClass === "missing-gold-file")).toMatchObject({
            green: true,
            actualStage: "scored",
            actualReason: "wrong-mapping",
        });
        expect(evidence.green).toBe(true);
    });
});
