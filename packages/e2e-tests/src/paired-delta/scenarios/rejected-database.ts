import { defineScenario } from "./support";

export const rejectedDatabase = defineScenario({
    scenarioId: "var-rejected-database",
    familyId: "fam-rejected-alternative",
    title: "Recall a rejected database alternative",
    evidence: "We rejected DynamoDB because atomic multi-row updates are required; use SQLite.",
    answer: "SQLite",
    locatorId: "mem-database-choice",
});
