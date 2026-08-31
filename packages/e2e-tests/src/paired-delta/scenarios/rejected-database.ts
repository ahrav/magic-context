import { defineScenario } from "./support";

export const rejectedDatabase = defineScenario({
    scenarioId: "var-rejected-database",
    familyId: "fam-rejected-alternative",
    title: "Prefer the chosen database over a rejected alternative",
    evidence: "We rejected DynamoDB because atomic multi-row updates are required; use SQLite.",
    answer: "SQLite",
    answerMatch: "case-insensitive",
    locatorId: "mem-database-choice",
});
