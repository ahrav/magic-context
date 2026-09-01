import { defineScenario } from "./support";

export const exactSymbol = defineScenario({
    scenarioId: "var-exact-symbol",
    familyId: "fam-exact-identifier",
    title: "Recall an exact symbol name",
    evidence: "The compatibility entry point is reconcilePendingLeaseV3 with that exact casing.",
    answer: "reconcilePendingLeaseV3",
    answerMatch: "exact",
    locatorId: "mem-exact-symbol",
});
