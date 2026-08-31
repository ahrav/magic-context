import { defineScenario } from "./support";

export const rejectedQueue = defineScenario({
    scenarioId: "var-rejected-queue",
    familyId: "fam-rejected-alternative",
    title: "Prefer the chosen queue over a rejected alternative",
    evidence: "We rejected an unbounded in-memory queue because restart durability is required; use SQS.",
    answer: "SQS",
    answerMatch: "case-insensitive",
    locatorId: "mem-queue-choice",
});
