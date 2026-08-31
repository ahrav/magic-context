import { defineScenario } from "./support";

export const exactPath = defineScenario({
    scenarioId: "var-exact-path",
    familyId: "fam-exact-identifier",
    title: "Recall an exact migration path",
    evidence: "The generated migration must be written at db/migrations/20260831_add_lease_epoch.sql.",
    answer: "db/migrations/20260831_add_lease_epoch.sql",
    locatorId: "mem-exact-path",
});
