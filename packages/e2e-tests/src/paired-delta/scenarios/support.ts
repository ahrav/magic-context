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
                    passed: context.scriptedTurnText?.includes(spec.answer) ?? false,
                }]
                : []),
        ];
    };

    return {
        scenarioId: spec.scenarioId,
        familyId: spec.familyId,
        title: spec.title,
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
                query: spec.answer,
                locatorIds: [spec.locatorId],
            },
            r2: {
                memories: [{ claim: spec.answer, evidence: spec.evidence }],
            },
            r3: { evidence: spec.answer },
        },
        absencePrecondition: {
            evidenceTurnId: "turn-evidence",
            minimumBallastBytes: 16_384,
        },
        modelContextLimit: 8_192,
        restartArms: [],
        verifier,
    };
}
