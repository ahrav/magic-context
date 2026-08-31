import { defineScenario } from "./support";

export const supersededTimeout = defineScenario({
    scenarioId: "var-superseded-timeout",
    familyId: "fam-superseded-current",
    title: "Prefer the current timeout over a stale value",
    evidence: "The final timeout in seconds is 75; the earlier 30-second proposal was superseded.",
    answer: "75",
    locatorId: "mem-current-timeout",
});
