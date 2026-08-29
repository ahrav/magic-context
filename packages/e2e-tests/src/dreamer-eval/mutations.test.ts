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

    test("forbidden anchors naming many punctuation characters still yield evidence", () => {
        // The filler domain must outlast a fixture that forbids the obvious
        // separator characters one by one.
        const fixture = {
            ...dreamerScorerFixture,
            verifyGold: {
                kind: "verify" as const,
                claims: dreamerScorerFixture.verifyGold.claims.map((claim) =>
                    claim.verdict === "update"
                        ? {
                              ...claim,
                              requiredUpdateAnchors: ["alpha", "beta"],
                              forbiddenUpdateAnchors: [
                                  "alpha; beta",
                                  "#",
                                  "@",
                                  "%",
                                  "~",
                                  "^",
                                  "+",
                                  "=",
                                  "!",
                                  "?",
                              ],
                          }
                        : claim,
                ),
            },
        };
        expect(runMutationBattery(fixture).green).toBe(true);
    });

    test("an anchor holding a replacement token stays literal in the mutation", () => {
        // `$&` in a string replacement expands to the matched entry, which would
        // drop the forbidden phrase from the mutation and let it score PASS.
        const fixture = {
            ...dreamerScorerFixture,
            verifyGold: {
                kind: "verify" as const,
                claims: dreamerScorerFixture.verifyGold.claims.map((claim) =>
                    claim.verdict === "update" ? { ...claim, forbiddenUpdateAnchors: ["$&"] } : claim,
                ),
            },
        };
        const evidence = runMutationBattery(fixture);
        expect(evidence.results.find((entry) => entry.mutationClass === "update-forbidden-anchor")).toMatchObject({
            green: true,
            actualStage: "scored",
            actualReason: "wrong-update-content",
        });
        expect(evidence.green).toBe(true);
    });

    test("the shareability mutation avoids a claim the override would rescue", () => {
        // Sensitive content forces a reported `true` back to false, so flipping a
        // `false` gold there is invisible and the mutation would score PASS.
        const fixture = {
            ...dreamerScorerFixture,
            pool: {
                ...dreamerScorerFixture.pool,
                claims: dreamerScorerFixture.pool.claims.map((claim) =>
                    claim.claimId === "claim-true"
                        ? { ...claim, content: "The box answers on 127.0.0.1:8080 for local runs." }
                        : claim,
                ),
            },
            classifyGold: {
                kind: "classify" as const,
                claims: dreamerScorerFixture.classifyGold.claims.map((claim) =>
                    claim.claimId === "claim-true" ? { ...claim, shareable: false } : claim,
                ),
            },
        };
        const evidence = runMutationBattery(fixture);
        expect(evidence.results.find((entry) => entry.mutationClass === "wrong-shareable")).toMatchObject({
            green: true,
            actualStage: "scored",
            actualReason: "wrong-classification",
        });
        expect(evidence.green).toBe(true);
    });

    test("an anchor's edge whitespace survives the parser's trim", () => {
        // The parser trims the body, so an anchor with meaningful edge spaces at
        // the outer edge of the baseline would be destroyed before scoring.
        const fixture = {
            ...dreamerScorerFixture,
            verifyGold: {
                kind: "verify" as const,
                claims: dreamerScorerFixture.verifyGold.claims.map((claim) =>
                    claim.verdict === "update"
                        ? { ...claim, requiredUpdateAnchors: [" alpha "], forbiddenUpdateAnchors: ["2048 entries"] }
                        : claim,
                ),
            },
        };
        expect(runMutationBattery(fixture).green).toBe(true);
    });

    test("the forbidden-anchor mutation finds a later update that has one", () => {
        // The first update gold carries no forbidden anchor while a second does,
        // so reading only the first would abort the whole battery.
        const first = { ...dreamerScorerFixture.verifyGold.claims[1]!, forbiddenUpdateAnchors: [] };
        const fixture = {
            ...dreamerScorerFixture,
            pool: {
                ...dreamerScorerFixture.pool,
                claims: [
                    ...dreamerScorerFixture.pool.claims,
                    {
                        ...dreamerScorerFixture.pool.claims[1]!,
                        claimId: "claim-second-update",
                        publicClaimId: "mcm_second",
                        revisionLocator: "mcm_second@1",
                        content: "The retry budget is three attempts.",
                    },
                ],
            },
            verifyGold: {
                kind: "verify" as const,
                claims: [
                    dreamerScorerFixture.verifyGold.claims[0]!,
                    first,
                    {
                        ...first,
                        claimId: "claim-second-update",
                        requiredUpdateAnchors: ["retry budget"],
                        forbiddenUpdateAnchors: ["three attempts"],
                    },
                    dreamerScorerFixture.verifyGold.claims[2]!,
                ],
            },
        };
        const evidence = runMutationBattery(fixture);
        expect(evidence.results.find((entry) => entry.mutationClass === "update-forbidden-anchor")).toMatchObject({
            green: true,
            actualStage: "scored",
            actualReason: "wrong-update-content",
        });
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

describe("dreamer mutation battery fixture tolerance", () => {
    test("a baseline whose anchor spells a sibling's content is padded, not rejected", () => {
        // claim-false is active and same-category, so the unpadded join would land
        // on its identity and the scorer would refuse the battery's own baseline.
        const fixture = {
            ...dreamerScorerFixture,
            verifyGold: {
                kind: "verify" as const,
                claims: dreamerScorerFixture.verifyGold.claims.map((claim) =>
                    claim.verdict === "update"
                        ? {
                              ...claim,
                              requiredUpdateAnchors: ["The removed queue still exists."],
                              forbiddenUpdateAnchors: ["2048 entries"],
                          }
                        : claim,
                ),
            },
        };
        expect(runMutationBattery(fixture).green).toBe(true);
    });

    test("a parser-active forbidden anchor is embedded in a spelling that survives", () => {
        // `</update>` would end the entry before the scorer saw it. The entry
        // regexes are case-sensitive and the forbidden check is not, so a raised
        // spelling stays matchable while the parser ignores it.
        const fixture = {
            ...dreamerScorerFixture,
            verifyGold: {
                kind: "verify" as const,
                claims: dreamerScorerFixture.verifyGold.claims.map((claim) =>
                    claim.verdict === "update" ? { ...claim, forbiddenUpdateAnchors: ["</update>"] } : claim,
                ),
            },
        };
        const evidence = runMutationBattery(fixture);
        expect(evidence.results.find((entry) => entry.mutationClass === "update-forbidden-anchor")).toMatchObject({
            green: true,
            actualStage: "scored",
            actualReason: "wrong-update-content",
        });
    });
});

describe("dreamer mutation battery baseline planning", () => {
    test("two updates generating the same body do not converge on one identity", () => {
        // Both updates carry the same anchors, so their generated bodies come out
        // identical. Checking each against the pool in isolation leaves both
        // unpadded, and the scorer then rejects the second as unappliable —
        // aborting the battery on a fixture that is satisfiable by padding.
        const anchors = {
            requiredUpdateAnchors: ["shared body"],
            forbiddenUpdateAnchors: ["2048 entries"],
        };
        const fixture = {
            ...dreamerScorerFixture,
            pool: {
                ...dreamerScorerFixture.pool,
                claims: dreamerScorerFixture.pool.claims.map((claim) =>
                    // Same category as claim-update, so the two identities can collide.
                    claim.claimId === "claim-independent" ? { ...claim, category: "PROJECT_FACT" } : claim,
                ),
            },
            verifyGold: {
                kind: "verify" as const,
                claims: [
                    dreamerScorerFixture.verifyGold.claims[0]!,
                    { ...dreamerScorerFixture.verifyGold.claims[1]!, ...anchors },
                    {
                        claimId: "claim-independent",
                        verdict: "update" as const,
                        expectedFiles: ["src/cache.ts"],
                        ...anchors,
                    },
                    dreamerScorerFixture.verifyGold.claims[2]!,
                ],
            },
        };
        expect(runMutationBattery(fixture).green).toBe(true);
    });
});

describe("dreamer mutation battery classify baseline", () => {
    test("shareability is omitted when the stored value must be preserved", () => {
        // Sensitive content already stored shareable: gold expects it to stay
        // shareable, and reporting `true` is forced back to false, so the only
        // passing baseline omits the attribute.
        const fixture = {
            ...dreamerScorerFixture,
            pool: {
                ...dreamerScorerFixture.pool,
                claims: dreamerScorerFixture.pool.claims.map((claim) =>
                    claim.claimId === "claim-true"
                        ? {
                              ...claim,
                              content: "The box answers on 127.0.0.1:8080 for local runs.",
                              sharing: "shareable" as const,
                          }
                        : claim,
                ),
            },
        };
        const evidence = runMutationBattery(fixture);
        expect(evidence.green).toBe(true);
        // The wrong-shareable class still has a claim whose flip is observable.
        expect(evidence.results.find((entry) => entry.mutationClass === "wrong-shareable")).toMatchObject({
            green: true,
            actualReason: "wrong-classification",
        });
    });
});

describe("dreamer mutation battery preserved shareability", () => {
    test("a preserved sensitive claim is mutated by inserting the attribute", () => {
        // Every classify claim is sensitive with `true` gold, so the baseline omits
        // shareability everywhere and there is no attribute to flip — the mutation
        // has to insert one.
        const sensitive = "The box answers on 127.0.0.1:8080 for local runs.";
        const fixture = {
            ...dreamerScorerFixture,
            pool: {
                ...dreamerScorerFixture.pool,
                claims: dreamerScorerFixture.pool.claims.map((claim, index) => ({
                    ...claim,
                    content: `${sensitive} Row ${index}.`,
                    sharing: "shareable" as const,
                })),
            },
        };
        const evidence = runMutationBattery(fixture);
        expect(evidence.results.find((entry) => entry.mutationClass === "wrong-shareable")).toMatchObject({
            green: true,
            actualStage: "scored",
            actualReason: "wrong-classification",
        });
    });
});
