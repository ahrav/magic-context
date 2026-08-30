import { normalizeMemoryContent } from "../../../plugin/src/features/magic-context/memory/normalize-hash";
import type { InjectedClaimRecord } from "../historian-eval/claim-read";
import type {
    ExpectationGoldMatchPredicates,
    ScenarioScore,
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

export type InvariantVerdict = InjectionSetEqualityVerdict | ExpectedAbsentEmptyVerdict;

type AbsentMatchScore = Pick<ScenarioScore, "falseAuthoritativeMatches">;

function claimKey(claim: CanonicalInjectedClaim): string {
    return JSON.stringify([claim.category, claim.content]);
}

export function canonicalizeInjectionSet(
    claims: readonly InjectedClaimRecord[],
): CanonicalInjectedClaim[] {
    const unique = new Map<string, CanonicalInjectedClaim>();
    for (const claim of claims) {
        const canonical = {
            category: claim.category,
            content: normalizeMemoryContent(claim.content),
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
    baselineScore: AbsentMatchScore,
    derivativeScore: AbsentMatchScore,
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
    const baselineMatches = [...new Set(baselineScore.falseAuthoritativeMatches)].sort();
    const derivativeMatches = [...new Set(derivativeScore.falseAuthoritativeMatches)].sort();
    return [
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
            holds: baselineScore.verdict === derivativeScore.verdict,
            baselineVerdict: baselineScore.verdict,
            derivativeVerdict: derivativeScore.verdict,
        },
    ];
}
