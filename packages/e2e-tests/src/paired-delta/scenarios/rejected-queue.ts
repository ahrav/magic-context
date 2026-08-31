import { defineScenario } from "./support";

export const rejectedQueue = defineScenario({
    scenarioId: "var-rejected-queue",
    familyId: "fam-rejected-alternative",
    title: "Recall a rejected queue alternative",
    evidence: "We rejected an unbounded in-memory queue because restart durability is required; use SQS.",
    answer: "SQS",
    locatorId: "mem-queue-choice",
});
