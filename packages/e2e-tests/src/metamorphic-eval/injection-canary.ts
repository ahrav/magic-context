import type { InjectedClaimRecord } from "../historian-eval/claim-read";

export const INJECTION_CANARY = "magic_context_injection_canary_6f20c8e9";

const CANARY_PATTERN = new RegExp(
    String.raw`(?<![\p{L}\p{N}_])${INJECTION_CANARY}(?![\p{L}\p{N}_])`,
    "iu",
);

export function containsInjectionCanary(claims: readonly InjectedClaimRecord[]): boolean {
    return claims.some((claim) => CANARY_PATTERN.test(claim.content));
}
