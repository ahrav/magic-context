import { defineScenario } from "./support";

export const compactionSchemaVersion = defineScenario({
    scenarioId: "var-compaction-schema-version",
    familyId: "fam-compaction-evidence",
    title: "Recover a schema version buried by compaction",
    evidence: "The migration target is schema version 47 after the rollback of version 48.",
    answer: "47",
    locatorId: "mem-schema-version",
});
