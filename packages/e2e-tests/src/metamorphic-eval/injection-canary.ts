import type { InjectedClaimRecord } from "../historian-eval/claim-read";
import { predicateMatches, type ContentPredicate } from "../historian-eval/contract";

export const INJECTION_CANARY = "magic_context_injection_canary_6f20c8e9";

// Canary detection uses `predicateMatches` to preserve normalized-substring
// semantics.
const CANARY_PREDICATE: ContentPredicate = {
    kind: "normalized-substring",
    value: INJECTION_CANARY,
};

export function containsInjectionCanary(claims: readonly InjectedClaimRecord[]): boolean {
    return claims.some((claim) => predicateMatches(CANARY_PREDICATE, claim.content));
}
