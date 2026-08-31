import { defineScenario } from "./support";

export const compactionDeployRegion = defineScenario({
    scenarioId: "var-compaction-deploy-region",
    familyId: "fam-compaction-evidence",
    title: "Recover a deployment region buried by compaction",
    evidence: "The approved deployment region is eu-west-1; do not use the old us-east-1 default.",
    answer: "eu-west-1",
    locatorId: "mem-deploy-region",
});
