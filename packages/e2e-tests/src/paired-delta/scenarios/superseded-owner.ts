import { defineScenario } from "./support";

export const supersededOwner = defineScenario({
    scenarioId: "var-superseded-owner",
    familyId: "fam-superseded-current",
    title: "Prefer the current owner over a stale owner",
    evidence: "Ownership moved from RuntimeCore to StorageReliability; StorageReliability is authoritative.",
    answer: "StorageReliability",
    locatorId: "mem-current-owner",
});
