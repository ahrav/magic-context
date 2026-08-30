import type { InjectedClaimRecord } from "../historian-eval/claim-read";
import { normalizeContent } from "../historian-eval/contract";
import { FAIL_REASONS, type FailReason, type ScenarioScore } from "../historian-eval/scorer";

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
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, claim]) => claim);
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
    const baselineMatches = [...new Set(baselineScore.falseAuthoritativeMatches)].sort();
    const derivativeMatches = [...new Set(derivativeScore.falseAuthoritativeMatches)].sort();

    const baselineReasons = new Set(baselineScore.failReasons);
    const introducedFailReasons = FAIL_REASONS.filter(
        (reason) => derivativeScore.failReasons.includes(reason) && !baselineReasons.has(reason),
    );

    return [
        {
            invariant: "injection-set-equality",
            holds: changes.length === 0,
            changes,
        },
        {
            invariant: "expected-absent-empty",
            holds: baselineMatches.length === 0 && derivativeMatches.length === 0,
            baselineMatches,
            derivativeMatches,
        },
        {
            invariant: "verdict-monotonicity",
            // A derivative preserves the scenario's semantics, so a baseline that
            // passed and a derivative that does not is the transform's doing.
            // Only that direction is a violation: a derivative that passes where
            // the baseline failed is not a regression to report here.
            holds: !(
                baselineScore.verdict === "PASS" && derivativeScore.verdict !== "PASS"
            ),
            baselineVerdict: baselineScore.verdict,
            derivativeVerdict: derivativeScore.verdict,
            introducedFailReasons,
        },
    ];
}
