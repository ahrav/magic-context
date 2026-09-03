import { canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { compareCodeUnits } from "../code-unit-order";
import type { InjectedClaimRecord } from "../historian-eval/claim-read";
import { normalizeContent } from "../historian-eval/contract";
import {
    FAIL_REASONS,
    type ExpectationGoldMatchPredicates,
    type FailReason,
    type ScenarioScore,
} from "../historian-eval/scorer";
import type { MetamorphicInvariantVerdict } from "./report";

export interface CanonicalInjectedClaim {
    category: string;
    content: string;
}

export type InjectionSetChange =
    | { direction: "missing-from-derivative"; claim: CanonicalInjectedClaim }
    | { direction: "added-in-derivative"; claim: CanonicalInjectedClaim };

export interface InjectionSetEqualityVerdict {
    invariant: "injection-set-equality";
    holds: boolean;
    changes: InjectionSetChange[];
}

export interface ExpectedAbsentEmptyVerdict {
    invariant: "expected-absent-empty";
    holds: boolean;
    baselineMatches: string[];
    derivativeMatches: string[];
}

export interface VerdictMonotonicityVerdict {
    invariant: "verdict-monotonicity";
    holds: boolean;
    baselineVerdict: ScenarioScore["verdict"];
    derivativeVerdict: ScenarioScore["verdict"];
    /** Fail reasons the derivative has and the baseline does not. */
    introducedFailReasons: FailReason[];
}

export type InvariantVerdict =
    | InjectionSetEqualityVerdict
    | ExpectedAbsentEmptyVerdict
    | VerdictMonotonicityVerdict;

/**
 * What the comparator needs from a scored run.
 *
 * The verdict and its reasons are part of it, not just the expected-absent
 * matches: a derivative can regress through recall, a probe, a structural
 * finding, or invalid output while both injected claim sets and both
 * expected-absent match sets stay equal. Narrowing this to
 * `falseAuthoritativeMatches` made verdict monotonicity unrepresentable rather
 * than merely unchecked.
 */
type ComparableScore = Pick<ScenarioScore, "verdict" | "failReasons" | "falseAuthoritativeMatches">;

function claimKey(claim: CanonicalInjectedClaim): string {
    return JSON.stringify([claim.category, claim.content]);
}

function canonicalizeInjectionSet(
    claims: readonly InjectedClaimRecord[],
): CanonicalInjectedClaim[] {
    const unique = new Map<string, CanonicalInjectedClaim>();
    for (const claim of claims) {
        const canonical = {
            category: claim.category,
            // `normalizeContent` is the normalizer behind `predicateMatches`:
            // set equality and expected-absent scoring use the same
            // claim-content identity.
            content: normalizeContent(claim.content),
        };
        unique.set(claimKey(canonical), canonical);
    }
    return [...unique.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([, claim]) => claim);
}

/** Sorted unique false-authoritative matches, the form both comparison sets publish. */
export function falseAuthoritativeMatchSet(score: { falseAuthoritativeMatches: readonly string[] }): string[] {
    return [...new Set(score.falseAuthoritativeMatches)].sort(compareCodeUnits);
}

/** Fail reasons present on the derivative and absent from the baseline, in `FAIL_REASONS` order. */
export function introducedFailReasons(
    baselineScore: { failReasons: readonly FailReason[] },
    derivativeScore: { failReasons: readonly FailReason[] },
): FailReason[] {
    const baselineReasons = new Set(baselineScore.failReasons);
    return FAIL_REASONS.filter(
        (reason) => derivativeScore.failReasons.includes(reason) && !baselineReasons.has(reason),
    );
}

export function compareInvariants(
    baselineClaims: readonly InjectedClaimRecord[],
    derivativeClaims: readonly InjectedClaimRecord[],
    baselineScore: ComparableScore,
    derivativeScore: ComparableScore,
): InvariantVerdict[] {
    const baseline = canonicalizeInjectionSet(baselineClaims);
    const derivative = canonicalizeInjectionSet(derivativeClaims);
    const baselineKeys = new Set(baseline.map(claimKey));
    const derivativeKeys = new Set(derivative.map(claimKey));
    const changes: InjectionSetChange[] = [
        ...baseline
            .filter((claim) => !derivativeKeys.has(claimKey(claim)))
            .map((claim): InjectionSetChange => ({ direction: "missing-from-derivative", claim })),
        ...derivative
            .filter((claim) => !baselineKeys.has(claimKey(claim)))
            .map((claim): InjectionSetChange => ({ direction: "added-in-derivative", claim })),
    ];
    const baselineMatches = falseAuthoritativeMatchSet(baselineScore);
    const derivativeMatches = falseAuthoritativeMatchSet(derivativeScore);

    return [
        withHolds({ invariant: "injection-set-equality", changes }),
        withHolds({ invariant: "expected-absent-empty", baselineMatches, derivativeMatches }),
        withHolds({
            invariant: "verdict-monotonicity",
            baselineVerdict: baselineScore.verdict,
            derivativeVerdict: derivativeScore.verdict,
            introducedFailReasons: introducedFailReasons(baselineScore, derivativeScore),
        }),
    ];
}

export function compareScoreInvariants(
    baselineScore: ScenarioScore,
    derivativeScore: ScenarioScore,
    baselineExpectations: ExpectationGoldMatchPredicates,
    derivativeExpectations: ExpectationGoldMatchPredicates,
): MetamorphicInvariantVerdict[] {
    const expectationIds = [...new Set([
        ...Object.keys(baselineExpectations),
        ...Object.keys(derivativeExpectations),
    ])].sort();
    const changedExpectationIds = expectationIds.filter(
        (id) => baselineExpectations[id] !== derivativeExpectations[id],
    );
    const baselineMatches = falseAuthoritativeMatchSet(baselineScore);
    const derivativeMatches = falseAuthoritativeMatchSet(derivativeScore);
    return [
        withHolds({ invariant: "expectation-predicate-equality", changedExpectationIds }),
        withHolds({ invariant: "false-authoritative-set-equality", baselineMatches, derivativeMatches }),
        withHolds({
            invariant: "scenario-verdict-equality",
            baselineVerdict: baselineScore.verdict,
            derivativeVerdict: derivativeScore.verdict,
        }),
    ];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An invariant verdict with `holds` removed; every `holds` is a function of the remaining evidence fields. */
export type InvariantEvidence = DistributiveOmit<MetamorphicInvariantVerdict, "holds">;

/** `holds` is recomputed when parsing archived reports to verify it matches the recorded evidence. */
export function invariantHolds(evidence: InvariantEvidence): boolean {
    switch (evidence.invariant) {
        case "injection-set-equality":
            return evidence.changes.length === 0;
        case "expected-absent-empty":
            return evidence.baselineMatches.length === 0 && evidence.derivativeMatches.length === 0;
        case "verdict-monotonicity":
            // A derivative preserves the scenario's semantics, so a baseline that
            // passed and a derivative that does not is the transform's doing.
            // Only that direction is a violation: a derivative that passes where
            // the baseline failed is not a regression to report here.
            return !(evidence.baselineVerdict === "PASS" && evidence.derivativeVerdict !== "PASS");
        case "expectation-predicate-equality":
            return evidence.changedExpectationIds.length === 0;
        case "false-authoritative-set-equality":
            return canonicalJson(evidence.baselineMatches) === canonicalJson(evidence.derivativeMatches);
        case "scenario-verdict-equality":
            return evidence.baselineVerdict === evidence.derivativeVerdict;
    }
}

function withHolds<E extends InvariantEvidence>(evidence: E): E & { holds: boolean } {
    return { ...evidence, holds: invariantHolds(evidence) };
}
