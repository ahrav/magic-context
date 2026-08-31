import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isValidPublicClaimId } from "../../../../plugin/src/features/magic-context/memory/claim-operation-contract";
import type { AnswerMatch, ScenarioDeclaration, VerifierContext } from "../contract";

interface ScenarioSpec {
    scenarioId: string;
    familyId: string;
    title: string;
    evidence: string;
    answer: string;
    /** `exact` only where reproducing the answer's casing is itself the thing under test. */
    answerMatch: AnswerMatch;
    locatorId: string;
}

/** A validity gate, not a scored check: `ArmedCellResult` keeps only aggregate counts, so scoring this on R1 alone would give R1 a larger denominator than the arms it is subtracted from and manufacture a retrieval delta. A runner calls this and, on false, records the R1 cell as not completed instead of letting it contribute a score. Keyed on the declaration's full handle set, because a runner that resolves only some handles would otherwise pass while R1 held less gold than R2. Matches the delivered memory-row marker (`[memory] ... id=<publicClaimId>`), not a bare id: the empty-results renderer echoes the query back, and a locator query *is* the resolved ids, so a bare substring test passes on zero retrieval. commentlint: allow(JUDGE) */
export function r1WireDelivered(
    declaration: ScenarioDeclaration,
    context: VerifierContext,
): boolean {
    const resolved = context.resolvedLocatorIds ?? [];
    if (resolved.length !== declaration.interventions.r1.locatorIds.length) return false;
    if (new Set(resolved).size !== resolved.length) return false;
    /** Shape-check each id through the production predicate before searching: an empty or malformed value makes the marker degenerate to `id=`, which every rendered memory row contains, so a broken handle-to-claim mapping would satisfy the gate against unrelated rows. commentlint: allow(JUDGE) */
    if (!resolved.every((id) => isValidPublicClaimId(id))) return false;
    const wire = context.scriptedTurnText ?? "";
    return resolved.every((id) => wire.includes(`id=${id}`));
}

/** Casing is part of the gold only for scenarios that say so. Elsewhere a strict comparison would fail an agent that recalled the fact and transcribed it differently, scoring output formatting instead of the retrieval the lane measures. commentlint: allow(JUDGE) */
function answerMatches(actual: string | null, spec: ScenarioSpec): boolean {
    if (actual === null) return false;
    return spec.answerMatch === "exact"
        ? actual === spec.answer
        : actual.toLowerCase() === spec.answer.toLowerCase();
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
            { id: "check-answer", passed: answerMatches(actual, spec) },
        ];
    };

    return {
        scenarioId: spec.scenarioId,
        familyId: spec.familyId,
        title: spec.title,
        expectedAnswer: spec.answer,
        answerMatch: spec.answerMatch,
        checks: ["check-file", "check-answer"],
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
