import { join } from "node:path";

import { canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { getErrorMessage } from "../../../plugin/src/shared/error-message";
import { lintScenario, type HistorianEvalScenario } from "../historian-eval/contract";
import { runMutationBattery } from "../historian-eval/mutations";
import { runScenario, type LiveHistorianMode, type SystemVersionTuple } from "../historian-eval/runner";
import {
    expectationGoldMatchPredicates,
    scoreRunRecord,
    type ExpectationGoldMatchPredicates,
    type ScenarioScore,
} from "../historian-eval/scorer";
import type { InjectedClaimRecord } from "../historian-eval/claim-read";
import { containsInjectionCanary } from "./injection-canary";
import { compareInvariants } from "./invariants";
import { admitPair } from "./pairs";
import {
    buildMetamorphicReport,
    type InjectionCanaryHit,
    type MetamorphicInvariantVerdict,
    type MetamorphicReport,
    type MetamorphicReportEntry,
    type PairKey,
    type ScenarioCoverage,
} from "./report";
import { DETERMINISTIC_SEEDS } from "./runner";
import { TRANSFORMS, type Transform, type TurnTransform } from "./transforms";

export type LiveRole = "baseline" | "derivative" | "control-a" | "control-b";

export interface LiveObservation {
    score: ScenarioScore;
    expectationMatches: ExpectationGoldMatchPredicates;
    injectedClaims: InjectedClaimRecord[];
}

export type LiveScenarioExecutor = (
    scenario: HistorianEvalScenario,
    role: LiveRole,
    artifactDir: string,
) => Promise<LiveObservation>;

export interface LiveMetamorphicOptions {
    mode: LiveHistorianMode;
    artifactRoot: string;
    opencodeVersion: string;
    system?: SystemVersionTuple | null;
    transforms?: readonly Transform[];
    seeds?: readonly number[];
    admit?: (derivatives: readonly HistorianEvalScenario[]) => string[];
    execute?: LiveScenarioExecutor;
    deadlineAtMs?: number | null;
    /** Headroom one role may consume, reserved before starting it so the deadline is not overshot mid-call. commentlint: allow(JUDGE) */
    roleBudgetMs?: number;
    nowMs?: () => number;
    onProgress?: (report: MetamorphicReport) => void;
}

interface ApplicablePair {
    key: PairKey;
    base: HistorianEvalScenario;
    derivative: TurnTransform;
}

const CONTROL_TRANSFORM_ID = "baseline-control";

function sortedUnique(values: readonly string[]): string[] {
    return [...new Set(values)].sort();
}

export function compareLivePair(
    baseline: LiveObservation,
    derivative: LiveObservation,
): MetamorphicInvariantVerdict[] {
    const expectationIds = sortedUnique([
        ...Object.keys(baseline.expectationMatches),
        ...Object.keys(derivative.expectationMatches),
    ]);
    const changedExpectationIds = expectationIds.filter(
        (id) => baseline.expectationMatches[id] !== derivative.expectationMatches[id],
    );
    const baselineMatches = sortedUnique(baseline.score.falseAuthoritativeMatches);
    const derivativeMatches = sortedUnique(derivative.score.falseAuthoritativeMatches);

    return [
        compareInvariants(
            baseline.injectedClaims,
            derivative.injectedClaims,
            baseline.score,
            derivative.score,
        )[0]!,
        {
            invariant: "expectation-predicate-equality",
            holds: changedExpectationIds.length === 0,
            changedExpectationIds,
        },
        {
            invariant: "false-authoritative-set-equality",
            holds: JSON.stringify(baselineMatches) === JSON.stringify(derivativeMatches),
            baselineMatches,
            derivativeMatches,
        },
        {
            invariant: "scenario-verdict-equality",
            holds: baseline.score.verdict === derivative.score.verdict,
            baselineVerdict: baseline.score.verdict,
            derivativeVerdict: derivative.score.verdict,
        },
    ];
}

export function liveArtifactDir(root: string, scenarioId: string, role: LiveRole): string {
    return join(root, scenarioId, role);
}

export function liveDerivativeAdmissionDiagnostics(
    derivatives: readonly HistorianEvalScenario[],
): string[] {
    const diagnostics = derivatives.flatMap((scenario) =>
        lintScenario(scenario).map((diagnostic) => `${scenario.id}: ${diagnostic}`),
    );
    if (diagnostics.length > 0 || derivatives.length === 0) {
        return diagnostics.length > 0 ? diagnostics.sort() : ["no applicable derivatives selected"];
    }
    const evidence = runMutationBattery(derivatives);
    for (const scenario of evidence.scenarios) {
        for (const result of scenario.results) {
            if (!result.green) {
                diagnostics.push(`${scenario.scenarioId} ${result.mutationClass}: ${result.detail}`);
            }
        }
    }
    return diagnostics.sort();
}

function sameSystem(left: ScenarioScore, right: ScenarioScore): boolean {
    return left.system !== null && right.system !== null && canonicalJson(left.system) === canonicalJson(right.system);
}

function canaryHit(
    scenarioId: string,
    role: LiveRole,
    key: PairKey | null,
): InjectionCanaryHit {
    /** Only the derivative ran a transform, so any other role's coordinates would name a transform that never touched it. commentlint: allow(JUDGE) */
    const coordinates = role === "derivative" ? key : null;
    return {
        scenarioId,
        role,
        transformId: coordinates?.transformId ?? null,
        transformVersion: coordinates?.transformVersion ?? null,
        seed: coordinates?.seed ?? null,
    };
}

function collectCanary(
    hits: InjectionCanaryHit[],
    scenarioId: string,
    role: LiveRole,
    observation: LiveObservation,
    key: PairKey | null,
): void {
    if (containsInjectionCanary(observation.injectedClaims)) hits.push(canaryHit(scenarioId, role, key));
}

function buildPairs(
    scenarios: readonly HistorianEvalScenario[],
    transforms: readonly Transform[],
    seeds: readonly number[],
): { pairs: ApplicablePair[]; entries: MetamorphicReportEntry[]; coverage: ScenarioCoverage[] } {
    const pairs: ApplicablePair[] = [];
    const entries: MetamorphicReportEntry[] = [];
    const coverage: ScenarioCoverage[] = [];
    for (const base of scenarios) {
        let applied = 0;
        const inapplicable: ScenarioCoverage["inapplicable"] = [];
        const violations: string[] = [];
        for (const transform of transforms) {
            for (const seed of seeds) {
                const admission = admitPair(base, transform, seed);
                if (admission.kind === "inapplicable") {
                    inapplicable.push({ ...admission.key, reason: admission.reason });
                    if (admission.violation !== null) violations.push(admission.violation);
                    continue;
                }
                if (admission.kind === "rejected") {
                    entries.push(admission.entry);
                    continue;
                }
                applied += 1;
                pairs.push({ key: admission.key, base, derivative: admission.derivative });
            }
        }
        if (applied === 0) violations.push("no transforms applied");
        coverage.push({
            scenarioId: base.id,
            applied,
            inapplicable,
            violations: sortedUnique(violations),
        });
    }
    return { pairs, entries, coverage };
}

export async function runLiveMetamorphicEval(
    scenarios: readonly HistorianEvalScenario[],
    options: LiveMetamorphicOptions,
): Promise<MetamorphicReport> {
    if (scenarios.length === 0) throw new Error("live metamorphic eval needs at least one scenario");
    const transforms = options.transforms ?? TRANSFORMS;
    const seeds = options.seeds ?? DETERMINISTIC_SEEDS;
    const prepared = buildPairs(scenarios, transforms, seeds);
    const entries = [...prepared.entries];
    const injectionCanaryHits: InjectionCanaryHit[] = [];
    const finish = (tierInvalidReason?: MetamorphicReport["tierInvalidReason"]): MetamorphicReport =>
        buildMetamorphicReport({
            entries,
            coverage: prepared.coverage,
            injectionCanaryHits,
            system: options.system ?? null,
            ...(tierInvalidReason === undefined ? {} : { tierInvalidReason }),
        });
    const observe = (
        tierInvalidReason: MetamorphicReport["tierInvalidReason"] = { kind: "incomplete" },
    ): MetamorphicReport => {
        const current = finish(tierInvalidReason);
        options.onProgress?.(current);
        return current;
    };
    if (prepared.pairs.length === 0 && entries.length === 0) {
        return finish({
            kind: "selection-empty",
            reason: "no applicable product pairs selected; choose a scenario and transform that apply",
        });
    }
    const admissionDiagnostics = (options.admit ?? liveDerivativeAdmissionDiagnostics)(
        prepared.pairs.map((pair) => pair.derivative.scenario),
    );
    if (admissionDiagnostics.length > 0) {
        const detail = `live admission failed: ${admissionDiagnostics.join("; ")}`;
        for (const pair of prepared.pairs) entries.push({ ...pair.key, kind: "error", error: detail });
        return finish();
    }
    if (prepared.pairs.length === 0) return finish();

    observe();

    const execute: LiveScenarioExecutor = options.execute ?? (async (scenario, _role, artifactDir) => {
        const record = await runScenario(scenario, {
            mode: options.mode,
            artifactDir,
            opencodeVersion: options.opencodeVersion,
        });
        return {
            score: scoreRunRecord(record, scenario),
            expectationMatches: expectationGoldMatchPredicates(scenario, record.injectedClaims),
            injectedClaims: record.injectedClaims,
        };
    });

    const controlScenario = scenarios[0]!;
    const controlKey: PairKey = {
        scenarioId: controlScenario.id,
        transformId: CONTROL_TRANSFORM_ID,
        transformVersion: 1,
        seed: 0,
    };
    const deadlineAtMs = options.deadlineAtMs ?? null;
    const nowMs = options.nowMs ?? Date.now;
    const roleBudgetMs = options.roleBudgetMs ?? 0;
    /** Reserves the role's budget rather than asking whether the deadline passed, because a role started just under it runs past it. commentlint: allow(JUDGE) */
    const deadlineReached = (): boolean => deadlineAtMs !== null && nowMs() + roleBudgetMs >= deadlineAtMs;
    const deadlineReport = (nextRole: LiveRole): MetamorphicReport =>
        observe({ kind: "deadline-exhausted", nextRole });
    let controlA: LiveObservation | null = null;
    let controlB: LiveObservation | null = null;
    try {
        if (deadlineReached()) return deadlineReport("control-a");
        controlA = await execute(
            controlScenario,
            "control-a",
            liveArtifactDir(options.artifactRoot, controlScenario.id, "control-a"),
        );
        collectCanary(injectionCanaryHits, controlScenario.id, "control-a", controlA, null);
        if (injectionCanaryHits.length > 0) {
            return observe();
        }
        if (deadlineReached()) return deadlineReport("control-b");
        controlB = await execute(
            controlScenario,
            "control-b",
            liveArtifactDir(options.artifactRoot, controlScenario.id, "control-b"),
        );
        collectCanary(injectionCanaryHits, controlScenario.id, "control-b", controlB, null);
        if (injectionCanaryHits.length > 0) {
            return observe();
        }
        if (controlA.score.verdict === "ERROR" || controlB.score.verdict === "ERROR") {
            entries.push({
                ...controlKey,
                kind: "error",
                error: "tier-invalid: a baseline control run errored; product pairs skipped",
            });
            return observe({
                kind: "control-error",
                controlAErrorReason: controlA.score.errorReason,
                controlBErrorReason: controlB.score.errorReason,
            });
        }
        const controlInvariants = compareLivePair(controlA, controlB);
        const systemMismatch = !sameSystem(controlA.score, controlB.score);
        const failedInvariants = controlInvariants
            .filter((verdict) => !verdict.holds)
            .map((verdict) => verdict.invariant);
        if (systemMismatch || failedInvariants.length > 0) {
            entries.push({
                ...controlKey,
                kind: "error",
                error: "tier-invalid: baseline control pair disagreed; product pairs skipped",
            });
            return observe({ kind: "control-disagreement", systemMismatch, failedInvariants });
        }
        entries.push({
            ...controlKey,
            kind: "scored",
            baselineScore: controlA.score,
            derivativeScore: controlB.score,
            invariants: controlInvariants,
        });
        observe();
    } catch (error) {
        const reason = getErrorMessage(error);
        entries.push({ ...controlKey, kind: "error", error: reason });
        /** Attributed to the control that produced no observation; a throw after both ran is a runner fault, not a control-tier outcome. commentlint: allow(JUDGE) */
        if (controlA === null || controlB === null) {
            return observe({
                kind: "control-error",
                controlAErrorReason: controlA === null ? reason : null,
                controlBErrorReason: controlA === null ? null : reason,
            });
        }
        return observe();
    }

    /** Keyed by base scenario alone: the executor takes no seed, so every pair sharing a base would re-run identical paid traffic. commentlint: allow(JUDGE) */
    const baselines = new Map<string, LiveObservation | Error>();

    for (const pair of prepared.pairs) {
        try {
            const canaryScenarioId = pair.base.id;
            let baseline = baselines.get(pair.base.id);
            if (baseline === undefined) {
                if (deadlineReached()) return deadlineReport("baseline");
                try {
                    baseline = await execute(
                        pair.base,
                        "baseline",
                        liveArtifactDir(options.artifactRoot, pair.base.id, "baseline"),
                    );
                } catch (error) {
                    baseline = error instanceof Error ? error : new Error(getErrorMessage(error));
                }
                baselines.set(pair.base.id, baseline);
                if (!(baseline instanceof Error)) {
                    collectCanary(injectionCanaryHits, canaryScenarioId, "baseline", baseline, pair.key);
                    if (injectionCanaryHits.length > 0) {
                        return observe();
                    }
                }
            }
            if (baseline instanceof Error) {
                entries.push({ ...pair.key, kind: "error", error: getErrorMessage(baseline) });
                observe();
                continue;
            }
            /** An ERROR score already forces exit 1 through the baseline verdict, so its derivatives would be paid-for and unusable. commentlint: allow(JUDGE) */
            if (baseline.score.verdict === "ERROR") {
                entries.push({
                    ...pair.key,
                    kind: "error",
                    error: `baseline run errored: ${baseline.score.errorReason ?? "unknown"}`,
                });
                observe();
                continue;
            }
            if (deadlineReached()) return deadlineReport("derivative");
            const derivative = await execute(
                pair.derivative.scenario,
                "derivative",
                liveArtifactDir(options.artifactRoot, pair.derivative.scenario.id, "derivative"),
            );
            collectCanary(injectionCanaryHits, canaryScenarioId, "derivative", derivative, pair.key);
            if (injectionCanaryHits.length > 0) {
                return observe();
            }
            if (!sameSystem(baseline.score, derivative.score)) {
                entries.push({ ...pair.key, kind: "error", error: "pair system tuple mismatch" });
            } else {
                entries.push({
                    ...pair.key,
                    kind: "scored",
                    baselineScore: baseline.score,
                    derivativeScore: derivative.score,
                    invariants: compareLivePair(baseline, derivative),
                });
            }
        } catch (error) {
            entries.push({ ...pair.key, kind: "error", error: getErrorMessage(error) });
        }
        observe();
    }

    return observe(null);
}
