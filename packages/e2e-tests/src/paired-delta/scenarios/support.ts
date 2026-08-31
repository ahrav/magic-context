import { readFileSync, statSync } from "node:fs";
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

/** Matches the delivered memory-row marker (`[memory] ... id=<publicClaimId>`), not a bare id: the empty-results renderer echoes the query back, and a locator query *is* the resolved ids, so a bare substring test passes on zero retrieval. Absent or empty resolved ids fail rather than falling back to a symbolic match, so a runner that skips the handle-to-publicClaimId mapping cannot score a retrieval it never performed. commentlint: allow(JUDGE) */
function r1WirePassed(context: VerifierContext): boolean {
    const resolved = context.resolvedLocatorIds ?? [];
    if (resolved.length === 0) return false;
    const wire = context.scriptedTurnText ?? "";
    return resolved.every((id) => wire.includes(`id=${id}`));
}

export function defineScenario(spec: ScenarioSpec): ScenarioDeclaration {
    const verifier = (context: VerifierContext) => {
        const answerPath = join(context.workspacePath, "result", "answer.txt");
        /** A model can leave a directory or an unreadable file at the answer path; reading it unguarded throws EISDIR or EACCES, which a runner records as a harness failure and excludes from scoring instead of the ordinary scenario failure it is. commentlint: allow(JUDGE) */
        let actual: string | null = null;
        try {
            if (statSync(answerPath).isFile()) {
                actual = readFileSync(answerPath, "utf8").trim();
            }
        } catch {
            actual = null;
        }
        return [
            { id: "check-file", passed: actual !== null },
            { id: "check-answer", passed: actual === spec.answer },
            ...(context.armId === "r1"
                ? [{ id: "check-r1-wire", passed: r1WirePassed(context) }]
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
