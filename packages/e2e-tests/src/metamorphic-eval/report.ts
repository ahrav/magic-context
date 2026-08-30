import type { SystemVersionTuple } from "../historian-eval/runner";
import type { ScenarioScore } from "../historian-eval/scorer";
import type { InvariantVerdict } from "./invariants";

export const METAMORPHIC_REPORT_SCHEMA = "metamorphic-eval-report/v1";

export interface PairKey {
    scenarioId: string;
    transformId: string;
    transformVersion: number;
    seed: number;
}

export interface ExpectationPredicateEqualityVerdict {
    invariant: "expectation-predicate-equality";
    holds: boolean;
    changedExpectationIds: string[];
}

export interface FalseAuthoritativeSetEqualityVerdict {
    invariant: "false-authoritative-set-equality";
    holds: boolean;
    baselineMatches: string[];
    derivativeMatches: string[];
}

export interface ScenarioVerdictEqualityVerdict {
    invariant: "scenario-verdict-equality";
    holds: boolean;
    baselineVerdict: ScenarioScore["verdict"];
    derivativeVerdict: ScenarioScore["verdict"];
}

export type MetamorphicInvariantVerdict =
    | InvariantVerdict
    | ExpectationPredicateEqualityVerdict
    | FalseAuthoritativeSetEqualityVerdict
    | ScenarioVerdictEqualityVerdict;

export type MetamorphicReportEntry =
    | (PairKey & { kind: "lint-red"; diagnostics: string[] })
    | (PairKey & {
          kind: "stage-not-scored";
          role: "baseline" | "derivative";
          stage: "validation-rejected" | "authored-evidence-unprocessed";
          error: string;
      })
    | (PairKey & {
          kind: "scored";
          baselineScore: ScenarioScore;
          derivativeScore: ScenarioScore;
          invariants: MetamorphicInvariantVerdict[];
      })
    | (PairKey & { kind: "error"; error: string });

export interface InapplicableTransformEntry extends PairKey {
    reason: string;
}

export interface ScenarioCoverage {
    scenarioId: string;
    applied: number;
    inapplicable: InapplicableTransformEntry[];
    violations: string[];
}

export interface InjectionCanaryHit {
    scenarioId: string;
    role: "baseline" | "derivative" | "control-a" | "control-b";
    transformId: string | null;
    transformVersion: number | null;
    seed: number | null;
}

export interface MetamorphicReport {
    schema: typeof METAMORPHIC_REPORT_SCHEMA;
    /** Resolved pre-run, because a partial report can hold no scored entry to carry it; null for the deterministic runner. commentlint: allow(JUDGE) */
    system: SystemVersionTuple | null;
    entries: MetamorphicReportEntry[];
    coverage: ScenarioCoverage[];
    injectionCanaryHits: InjectionCanaryHit[];
    tierInvalidReason: TierInvalidReason | null;
}

export type TierInvalidReason =
    | { kind: "incomplete" }
    | {
          kind: "control-disagreement";
          systemMismatch: boolean;
          failedInvariants: MetamorphicInvariantVerdict["invariant"][];
      }
    | {
          /** Two ERROR controls satisfy every equality invariant trivially, so agreement proves nothing here. commentlint: allow(JUDGE) */
          kind: "control-error";
          controlAErrorReason: string | null;
          controlBErrorReason: string | null;
      }
    | { kind: "selection-empty"; reason: string }
    | { kind: "deadline-exhausted"; nextRole: "control-a" | "control-b" | "baseline" | "derivative" };

function key(entry: PairKey): string {
    return `${entry.scenarioId}\u0000${entry.transformId}\u0000${entry.transformVersion}\u0000${entry.seed}`;
}

export function buildMetamorphicReport(args: {
    entries: MetamorphicReportEntry[];
    coverage: ScenarioCoverage[];
    injectionCanaryHits: InjectionCanaryHit[];
    tierInvalidReason?: TierInvalidReason | null;
    system?: SystemVersionTuple | null;
}): MetamorphicReport {
    return {
        schema: METAMORPHIC_REPORT_SCHEMA,
        system: args.system ?? null,
        entries: [...args.entries].sort((left, right) => key(left).localeCompare(key(right))),
        coverage: [...args.coverage].sort((left, right) => left.scenarioId.localeCompare(right.scenarioId)),
        injectionCanaryHits: [...args.injectionCanaryHits].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
        tierInvalidReason: args.tierInvalidReason ?? null,
    };
}

export function metamorphicExitCode(report: MetamorphicReport): 0 | 1 | 2 {
    if (report.injectionCanaryHits.length > 0) return 2;
    if (report.tierInvalidReason !== null) return 1;
    if (report.entries.length === 0) return 1;
    if (report.coverage.some((coverage) => coverage.violations.length > 0)) return 1;
    for (const entry of report.entries) {
        if (entry.kind !== "scored") return 1;
        if (entry.baselineScore.verdict !== "PASS" || entry.derivativeScore.verdict !== "PASS") return 1;
        if (entry.invariants.some((invariant) => !invariant.holds)) return 1;
    }
    return 0;
}
