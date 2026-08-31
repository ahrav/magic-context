import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioDeclaration, VerifierContext } from "../contract";

interface ScenarioSpec {
    scenarioId: string;
    familyId: string;
    title: string;
    evidence: string;
    answer: string;
    locatorId: string;
}

export function defineScenario(spec: ScenarioSpec): ScenarioDeclaration {
    const verifier = (context: VerifierContext) => {
        const answerPath = join(context.workspacePath, "result", "answer.txt");
        const exists = existsSync(answerPath);
        const actual = exists ? readFileSync(answerPath, "utf8").trim() : "";
        return [
            { id: "check-file", passed: exists },
            { id: "check-answer", passed: actual === spec.answer },
            ...(context.armId === "r1"
                ? [{
                    id: "check-r1-wire",
                    passed: context.scriptedTurnText?.includes(spec.locatorId) ?? false,
                }]
                : []),
        ];
    };

    return {
        scenarioId: spec.scenarioId,
        familyId: spec.familyId,
        title: spec.title,
        expectedAnswer: spec.answer,
        checks: [
            {
                id: "check-file",
                appliesToArms: ["mc-on", "mc-off", "compaction", "r1", "r2", "r3"],
            },
            {
                id: "check-answer",
                appliesToArms: ["mc-on", "mc-off", "compaction", "r1", "r2", "r3"],
            },
            { id: "check-r1-wire", appliesToArms: ["r1"] },
        ],
        criticalCheckIds: ["check-answer"],
        turnScript: [
            { id: "turn-evidence", role: "user", content: spec.evidence },
            {
                id: "turn-burial",
                role: "user",
                content: "Continue the task after the supplied compaction ballast.",
            },
            {
                id: "turn-probe",
                role: "user",
                content: "Write only the final answer to result/answer.txt.",
            },
        ],
        interventions: {
            r1: {
                insertAfterTurnId: "turn-burial",
                /** The locator id, not the answer: R1 is "search result only; no injection", and the scripted-search prompt carries the query verbatim, so an answer-bearing query would leak the gold value into the transcript. commentlint: allow(JUDGE) */
                query: spec.locatorId,
                locatorIds: [spec.locatorId],
            },
            r2: {
                memories: [{ claim: spec.answer, evidence: spec.evidence }],
            },
            /** Gold evidence verbatim, matching the R3 arm contract; injecting the bare answer would make the critical check trivially satisfiable and collapse the representation regret rung. commentlint: allow(JUDGE) */
            r3: { evidence: spec.evidence },
        },
        absencePrecondition: {
            evidenceTurnId: "turn-evidence",
            /** 16,384 tokens at CHARS_PER_TOKEN — twice the 8,192-token window, so honoring the minimum genuinely evicts the evidence turn. commentlint: allow(JUDGE) */
            minimumBallastBytes: 65_536,
        },
        modelContextLimit: 8_192,
        restartArms: [],
        verifier,
    };
}
