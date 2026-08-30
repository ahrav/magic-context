import type { InjectedClaimRecord } from "../historian-eval/claim-read";
import { normalizeContent } from "../historian-eval/contract";
import type { ScenarioScore } from "../historian-eval/scorer";

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
