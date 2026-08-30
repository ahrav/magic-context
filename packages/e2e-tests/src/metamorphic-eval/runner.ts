import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import { getErrorMessage } from "../../../plugin/src/shared/error-message";
import { normalizeMemoryContent } from "../../../plugin/src/features/magic-context/memory/normalize-hash";
import { buildMockHistorianOutput } from "../mock-historian";
import { type ExpectedClaim, type HistorianEvalScenario } from "../historian-eval/contract";
import { baselineCompartments, batteryScoringOptions } from "../historian-eval/mutations";
import {
    expectationGoldMatchPredicates,
    scoreRawOutputWithInjectedClaims,
    type RawOutputScoringRead,
    type RawOutputScoringOptions,
} from "../historian-eval/scorer";
import { containsInjectionCanary } from "./injection-canary";
import { compareInvariants, compareScoreInvariants } from "./invariants";
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
    const compartments = baselineCompartments({
        ...scenario,
        gold: {
            ...scenario.gold,
            compartments: {
                minCount: Math.max(scenario.gold.compartments.minCount, scenario.transcript.turns.length),
            },
        },
    });
    const importances = shuffledImportances(compartments.length, seed);
    return buildMockHistorianOutput({
        compartments: compartments.map((compartment, index) => ({
            start: compartment.start,
            end: compartment.end,
            title: `Authored turn ${index + 1}`,
            body: `Summary for authored turn ${index + 1}.`,
            importance: importances[index],
        })),
        facts: expectedClaims.map((claim) => ({
            category: claim.category,
            content: normalizeMemoryContent(claim.predicate.value),
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
        const baselines = new Map<number, RawOutputScoringRead | Error>();
        for (const seed of seeds) {
            try {
                baselines.set(seed, score(output(scenario, seed), scenario, scoringOptions(scenario)));
            } catch (error) {
                baselines.set(seed, error instanceof Error ? error : new Error(getErrorMessage(error)));
            }
        }
        if ([...baselines.values()].some(
            (baseline) => !(baseline instanceof Error) && containsInjectionCanary(baseline.injectedClaims),
        )) {
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
                if (admission.kind === "rejected") {
                    entries.push(admission.entry);
                    continue;
                }
                applied += 1;
                try {
                    const baseline = baselines.get(seed);
                    if (baseline === undefined || baseline instanceof Error) {
                        coverageViolations.push("baseline scoring failed");
                        entries.push({
                            ...key,
                            kind: "error",
                            error: baseline?.message ?? "baseline scoring failed",
                        });
                        continue;
                    }
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
                        invariants: [
                            ...compareInvariants(
                                baseline.injectedClaims,
                                derivative.injectedClaims,
                                baseline.result.score,
                                derivative.result.score,
                            ),
                            ...compareScoreInvariants(
                                baseline.result.score,
                                derivative.result.score,
                                expectationGoldMatchPredicates(scenario, baseline.injectedClaims),
                                expectationGoldMatchPredicates(
                                    admission.derivative.scenario,
                                    derivative.injectedClaims,
                                ),
                            ),
                        ],
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
