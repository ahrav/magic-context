import { getErrorMessage } from "../../../plugin/src/shared/error-message";
import { canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    lintScenario,
    scenarioFingerprint,
    type HistorianEvalScenario,
} from "../historian-eval/contract";
import type { MetamorphicReportEntry, PairKey } from "./report";
import type { Transform, TurnTransform } from "./transforms";
import { remapGold } from "./transforms";

type PairRejection = Extract<MetamorphicReportEntry, { kind: "lint-red" | "error" }>;

export type PairAdmission =
    | { kind: "admitted"; key: PairKey; derivative: TurnTransform }
    | { kind: "inapplicable"; key: PairKey; reason: string; violation: string | null }
    | { kind: "rejected"; entry: PairRejection };

export function pairKey(
    scenario: HistorianEvalScenario,
    transform: Transform,
    seed: number,
): PairKey {
    return {
        scenarioId: scenario.id,
        transformId: transform.id,
        transformVersion: transform.version,
        seed,
    };
}

export function admitPair(
    base: HistorianEvalScenario,
    transform: Transform,
    seed: number,
): PairAdmission {
    const key = pairKey(base, transform, seed);
    try {
        const derivative = transform.apply(base, seed);
        if (!derivative.applicable) {
            return {
                kind: "inapplicable",
                key,
                reason: derivative.reason,
                violation: transform.alwaysApplicable
                    ? `${transform.id} declared always applicable but did not apply`
                    : null,
            };
        }
        const diagnostics = lintScenario(derivative.scenario);
        const turnMapValid = derivative.turnMap.length === base.transcript.turns.length &&
            new Set(derivative.turnMap).size === derivative.turnMap.length &&
            derivative.turnMap.every(
                (index) => Number.isInteger(index) && index >= 0 && index < derivative.scenario.transcript.turns.length,
            );
        if (!turnMapValid) {
            diagnostics.push("derivative turn map is not a complete one-to-one mapping of baseline turns");
        } else if (canonicalJson(remapGold(base.gold, derivative.turnMap)) !== canonicalJson(derivative.scenario.gold)) {
            diagnostics.push("derivative gold does not match its declared turn map");
        }
        const contentFingerprint = scenarioFingerprint({
            ...derivative.scenario,
            id: base.id,
            title: base.title,
        });
        if (contentFingerprint === scenarioFingerprint(base)) {
            diagnostics.push("derivative semantic fingerprint equals baseline");
        }
        if (diagnostics.length > 0) {
            return {
                kind: "rejected",
                entry: { ...key, kind: "lint-red", diagnostics: diagnostics.sort() },
            };
        }
        return { kind: "admitted", key, derivative };
    } catch (error) {
        return {
            kind: "rejected",
            entry: { ...key, kind: "error", error: getErrorMessage(error) },
        };
    }
}
