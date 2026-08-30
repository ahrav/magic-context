import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import { getErrorMessage } from "../../../plugin/src/shared/error-message";
import { buildMockHistorianOutput } from "../mock-historian";
import { type ExpectedClaim, type HistorianEvalScenario } from "../historian-eval/contract";
import { batteryScoringOptions } from "../historian-eval/mutations";
import {
    scoreRawOutputWithInjectedClaims,
    type RawOutputScoringRead,
    type RawOutputScoringOptions,
} from "../historian-eval/scorer";
import { containsInjectionCanary } from "./injection-canary";
import { compareInvariants } from "./invariants";
import { admitPair, pairKey } from "./pairs";
import {
    buildMetamorphicReport,
    type InjectionCanaryHit,
    type MetamorphicReport,
    type MetamorphicReportEntry,
    type PairKey,
    type ScenarioCoverage,
} from "./report";
import { TRANSFORMS, type Transform } from "./transforms";

export const DETERMINISTIC_SEEDS = [20_260_830] as const;
const FIXED_NOW_MS = 1_787_520_000_000;
const MAX_DISTINCT_IMPORTANCE_VALUES = 100;

type OutputBuilder = (
    scenario: HistorianEvalScenario,
    seed: number,
) => string;
type RawOutputScorer = (
    rawOutput: string,
    scenario: HistorianEvalScenario,
    options: RawOutputScoringOptions,
) => RawOutputScoringRead;

export interface DeterministicRunnerOptions {
    transforms?: readonly Transform[];
    seeds?: readonly number[];
    buildOutput?: OutputBuilder;
    scoreOutput?: RawOutputScorer;
}

function shuffledImportances(count: number, seed: number): number[] {
    if (count > MAX_DISTINCT_IMPORTANCE_VALUES) {
        throw new Error(`scripted output supports at most ${MAX_DISTINCT_IMPORTANCE_VALUES} transcript turns`);
    }
    const values = Array.from({ length: MAX_DISTINCT_IMPORTANCE_VALUES }, (_, index) => index + 1);
    const next = splitmix32(seed);
    for (let index = values.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        [values[index], values[other]] = [values[other]!, values[index]!];
    }
    return values.slice(0, count);
}

export function buildScriptedOutput(
    scenario: HistorianEvalScenario,
    seed: number,
    expectedClaims: readonly ExpectedClaim[] = scenario.gold.expectedClaims,
): string {
    const importances = shuffledImportances(scenario.transcript.turns.length, seed);
    return buildMockHistorianOutput({
        compartments: scenario.transcript.turns.map((_, index) => ({
            start: index * 2 + 1,
            end: index * 2 + 2,
            title: `Authored turn ${index + 1}`,
            body: `Summary for authored turn ${index + 1}.`,
            importance: importances[index],
        })),
        facts: expectedClaims.map((claim) => ({
            category: claim.category,
            content: claim.predicate.value,
        })),
    });
}

function scoringOptions(scenario: HistorianEvalScenario): RawOutputScoringOptions {
    return {
        ...batteryScoringOptions(scenario),
        nowMs: FIXED_NOW_MS,
    };
}

function canaryHit(
    key: PairKey,
    role: "baseline" | "derivative",
): InjectionCanaryHit {
    return {
        scenarioId: key.scenarioId,
        role,
        transformId: role === "baseline" ? null : key.transformId,
        transformVersion: role === "baseline" ? null : key.transformVersion,
        seed: role === "baseline" ? null : key.seed,
    };
}

export function runDeterministicMetamorphicEval(
    scenarios: readonly HistorianEvalScenario[],
    options: DeterministicRunnerOptions = {},
): MetamorphicReport {
    if (scenarios.length === 0) throw new Error("deterministic metamorphic eval needs at least one scenario");
    const transforms = options.transforms ?? TRANSFORMS;
    const seeds = options.seeds ?? DETERMINISTIC_SEEDS;
    const output = options.buildOutput ?? buildScriptedOutput;
    const score = options.scoreOutput ?? scoreRawOutputWithInjectedClaims;
    const entries: MetamorphicReportEntry[] = [];
    const coverage: ScenarioCoverage[] = [];
    const injectionCanaryHits: InjectionCanaryHit[] = [];

    for (const scenario of scenarios) {
        let baseline: RawOutputScoringRead;
        try {
            baseline = score(output(scenario, seeds[0] ?? 0), scenario, scoringOptions(scenario));
        } catch (error) {
            for (const transform of transforms) {
                for (const seed of seeds) {
                    entries.push({ ...pairKey(scenario, transform, seed), kind: "error", error: getErrorMessage(error) });
                }
            }
            coverage.push({ scenarioId: scenario.id, applied: 0, inapplicable: [], violations: ["baseline scoring failed"] });
            continue;
        }
        if (containsInjectionCanary(baseline.injectedClaims)) {
            injectionCanaryHits.push({
                scenarioId: scenario.id,
                role: "baseline",
                transformId: null,
                transformVersion: null,
                seed: null,
            });
        }

        let applied = 0;
        const inapplicable: ScenarioCoverage["inapplicable"] = [];
        const coverageViolations: string[] = [];
        for (const transform of transforms) {
            for (const seed of seeds) {
                const key = pairKey(scenario, transform, seed);
                const admission = admitPair(scenario, transform, seed);
                if (admission.kind === "inapplicable") {
                    inapplicable.push({ ...admission.key, reason: admission.reason });
                    if (admission.violation !== null) coverageViolations.push(admission.violation);
                    continue;
                }
                applied += 1;
                if (admission.kind === "rejected") {
                    entries.push(admission.entry);
                    continue;
                }
                try {
                    if (baseline.result.stage !== "scored") {
                        entries.push({ ...key, kind: "stage-not-scored", role: "baseline", ...baseline.result });
                        continue;
                    }
                    const derivative = score(
                        output(admission.derivative.scenario, seed),
                        admission.derivative.scenario,
                        scoringOptions(admission.derivative.scenario),
                    );
                    if (containsInjectionCanary(derivative.injectedClaims)) {
                        injectionCanaryHits.push(canaryHit(key, "derivative"));
                    }
                    if (derivative.result.stage !== "scored") {
                        entries.push({ ...key, kind: "stage-not-scored", role: "derivative", ...derivative.result });
                        continue;
                    }
                    entries.push({
                        ...key,
                        kind: "scored",
                        baselineScore: baseline.result.score,
                        derivativeScore: derivative.result.score,
                        invariants: compareInvariants(
                            baseline.injectedClaims,
                            derivative.injectedClaims,
                            baseline.result.score,
                            derivative.result.score,
                        ),
                    });
                } catch (error) {
                    entries.push({ ...key, kind: "error", error: getErrorMessage(error) });
                }
            }
        }
        if (applied === 0) coverageViolations.push("no transforms applied");
        coverage.push({
            scenarioId: scenario.id,
            applied,
            inapplicable,
            violations: [...new Set(coverageViolations)].sort(),
        });
    }

    return buildMetamorphicReport({ entries, coverage, injectionCanaryHits });
}
