import type { InjectedClaimRecord } from "../historian-eval/claim-read";
import { normalizeContent } from "../historian-eval/contract";

export const INJECTION_CANARY = "magic_context_injection_canary_6f20c8e9";

const NORMALIZED_INJECTION_CANARY = normalizeContent(INJECTION_CANARY);

export function containsInjectionCanary(claims: readonly InjectedClaimRecord[]): boolean {
    return claims.some((claim) => normalizeContent(claim.content).includes(NORMALIZED_INJECTION_CANARY));
}
