import { defineScenario } from "./support";

export const compactionFeatureState = defineScenario({
    scenarioId: "var-compaction-feature-state",
    familyId: "fam-compaction-evidence",
    title: "Recover a feature state buried by compaction",
    evidence: "The release decision is feature ledger_sync disabled until the replay audit passes.",
    answer: "disabled",
    locatorId: "mem-feature-state",
});
