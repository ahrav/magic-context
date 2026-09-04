/**
 * Pure effective-policy evaluator (claim-trust-policy plan: U4; KTD7).
 *
 * One versioned, table-driven decision for every current agent surface
 * (R18-R23). Dependency-light on purpose: no database imports, so the U1
 * seeder, SQL projection writer, hydration/render recheck, and harness
 * renderers all share exactly this module — a second evaluator would be a
 * trust bypass (KTD10 rationale).
 */
import { CLAIM_POLICY_VERSION, type FineTaint, type MaturityLevel } from "../storage-claim-policy-schema.ts";
export { CLAIM_POLICY_VERSION };
/**
 * Agent-facing and host-only surfaces (R18).
 *
 * `review` is evaluated but NOT yet persisted or read: the projection stores
 * only `auto_eligible`/`explicit_eligible`, and `MemoryPolicySurface` has no
 * `review` member, so no host review channel consumes it today. It stays in
 * the matrix so the evaluator remains the single place a surface decision is
 * defined; treat `review_audit` as a reserved shape, not a live audit path.
 */
export declare const POLICY_SURFACES: readonly ["auto_inject", "auto_search", "explicit_search", "review"];
export type PolicySurface = (typeof POLICY_SURFACES)[number];
/**
 * Active epistemic facts, orthogonal to maturity (R14). `contradicted` and
 * `superseded` derive from claim_conflicts; `stale`/`disputed` from
 * verification events or explicit disposition events; `rejected` and
 * `quarantined` from explicit disposition events only.
 */
export interface ActiveDispositions {
    readonly stale: boolean;
    readonly disputed: boolean;
    readonly superseded: boolean;
    readonly rejected: boolean;
    readonly contradicted: boolean;
    readonly quarantined: boolean;
}
export declare const NO_DISPOSITIONS: ActiveDispositions;
/** Current-support facts the reducer selects the effective rung from (R15). */
export interface PolicySupport {
    /** Head of the append-only maturity stream; null when never asserted. */
    readonly historicalMaturity: MaturityLevel | null;
    /** Currently effective host-recorded approve action (R10). */
    readonly approved: boolean;
    /** Currently valid passing enforcement artifact (R11). */
    readonly enforcedArtifact: boolean;
    /** Currently effective exact-revision positive verification. */
    readonly verified: boolean;
    /** Exact explicit-user origin evidence also supports VERIFIED (R25). */
    readonly explicitUserEvidence: boolean;
    /** Independently rooted evidence groups (R6). */
    readonly independentGroups: number;
}
export interface PolicySubjectState {
    /** False when the revision has no policy subject row (R26). */
    readonly present: boolean;
    readonly originTaint: FineTaint | null;
    readonly policyVersion: number | null;
}
export interface PolicyEvaluationInput {
    readonly subject: PolicySubjectState;
    readonly support: PolicySupport;
    readonly dispositions: ActiveDispositions;
}
export type PolicyReasonCode = "eligible" | "maturity_below_automatic" | "policy_state_missing" | "policy_version_unsupported" | "disposition_stale" | "disposition_disputed" | "disposition_superseded" | "disposition_rejected" | "hard_hidden_contradicted" | "hard_hidden_quarantined";
export type PolicyRenderMode = "normal" | "labeled" | "hidden" | "review_audit";
export interface SurfaceDecision {
    readonly eligible: boolean;
    readonly renderMode: PolicyRenderMode;
}
/**
 * Complete decision for one revision snapshot (R18). `agentLabel` is the only
 * text an agent surface may render: sanitized maturity/taint/disposition
 * words, never locators, hashes, identities, or conflict details.
 */
export interface PolicyDecision {
    readonly effectiveMaturity: MaturityLevel;
    readonly originTaint: FineTaint | "unknown";
    readonly surfaces: Readonly<Record<PolicySurface, SurfaceDecision>>;
    readonly reasonCodes: readonly PolicyReasonCode[];
    readonly activeDispositions: readonly string[];
    readonly hardHidden: boolean;
    readonly policyVersion: number;
}
/** Highest rung the current support carries (R15). */
export declare function supportedMaturity(support: PolicySupport): MaturityLevel;
/** Effective rung: the currently supported rung, never above history (R7, R15). */
export declare function effectiveMaturity(support: PolicySupport): MaturityLevel;
/**
 * The visibility matrix (product contract). One pure function; every surface
 * integration consumes this decision instead of deriving policy (R18-R22).
 */
export declare function evaluateClaimPolicy(input: PolicyEvaluationInput): PolicyDecision;
/**
 * Sanitized agent-facing label for explicit-search rendering (R18, R20).
 * Deliberately excludes locators, hashes, identities, reviewer identity, and
 * conflict details.
 *
 * This is the ONLY label entry point: the shipped reader
 * (`storage-claim-visibility.decideMemoryPolicy`) calls it with the projected
 * columns, so there is no second label path that could drift from it.
 */
export declare function explicitSearchLabelFromFields(fields: {
    effectiveMaturity: string;
    originTaint: string;
    dispositions: readonly string[];
    policyMissing: boolean;
    autoEligible: boolean;
}): string | null;
//# sourceMappingURL=claim-visibility-policy.d.ts.map