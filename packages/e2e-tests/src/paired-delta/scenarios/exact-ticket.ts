import { defineScenario } from "./support";

export const exactTicket = defineScenario({
    scenarioId: "var-exact-ticket",
    familyId: "fam-exact-identifier",
    title: "Recall an exact incident identifier",
    evidence: "The rollback evidence belongs to incident MCX-74219, not the adjacent MCX-74291.",
    answer: "MCX-74219",
    answerMatch: "exact",
    locatorId: "mem-exact-ticket",
});
