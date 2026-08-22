/**
 * Pure effective-policy evaluator (claim-trust-policy plan: U4; KTD7).
 *
 * One versioned, table-driven decision for every current agent surface
 * (R18-R23). Dependency-light on purpose: no database imports, so the U1
 * seeder, SQL projection writer, hydration/render recheck, and harness
 * renderers all share exactly this module — a second evaluator would be a
 * trust bypass (KTD10 rationale).
 */

import {
    CLAIM_POLICY_VERSION,
    type FineTaint,
    MATURITY_RANK,
    type MaturityLevel,
} from "../storage-claim-policy-schema.ts";

export { CLAIM_POLICY_VERSION };

/** Agent-facing and host-only surfaces (R18). */
export const POLICY_SURFACES = ["auto_inject", "auto_search", "explicit_search", "review"] as const;
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

export const NO_DISPOSITIONS: ActiveDispositions = {
    stale: false,
    disputed: false,
    superseded: false,
    rejected: false,
    contradicted: false,
    quarantined: false,
};

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

export type PolicyReasonCode =
    | "eligible"
    | "maturity_below_automatic"
    | "policy_state_missing"
    | "policy_version_unsupported"
    | "disposition_stale"
    | "disposition_disputed"
    | "disposition_superseded"
    | "disposition_rejected"
    | "hard_hidden_contradicted"
    | "hard_hidden_quarantined";

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

const RANK_TO_MATURITY: readonly MaturityLevel[] = [
    "CANDIDATE",
    "CORROBORATED",
    "VERIFIED",
    "APPROVED",
    "ENFORCED",
];

/** Highest rung the current support carries (R15). */
export function supportedMaturity(support: PolicySupport): MaturityLevel {
    if (support.approved && support.enforcedArtifact) return "ENFORCED";
    if (support.approved) return "APPROVED";
    if (support.verified || support.explicitUserEvidence) return "VERIFIED";
    if (support.independentGroups >= 2) return "CORROBORATED";
    return "CANDIDATE";
}

/** Effective rung: the currently supported rung, never above history (R7, R15). */
export function effectiveMaturity(support: PolicySupport): MaturityLevel {
    const historical = support.historicalMaturity ?? "CANDIDATE";
    const supported = supportedMaturity(support);
    return RANK_TO_MATURITY[Math.min(MATURITY_RANK[historical], MATURITY_RANK[supported])];
}

function activeDispositionNames(dispositions: ActiveDispositions): string[] {
    const names: string[] = [];
    if (dispositions.stale) names.push("stale");
    if (dispositions.disputed) names.push("disputed");
    if (dispositions.superseded) names.push("superseded");
    if (dispositions.rejected) names.push("rejected");
    if (dispositions.contradicted) names.push("contradicted");
    if (dispositions.quarantined) names.push("quarantined");
    return names;
}

/**
 * The visibility matrix (product contract). One pure function; every surface
 * integration consumes this decision instead of deriving policy (R18-R22).
 */
export function evaluateClaimPolicy(input: PolicyEvaluationInput): PolicyDecision {
    const { subject, support, dispositions } = input;
    const maturity = effectiveMaturity(support);
    const taint = subject.present && subject.originTaint != null ? subject.originTaint : "unknown";
    const active = activeDispositionNames(dispositions);
    const reasonCodes: PolicyReasonCode[] = [];

    const hardHidden = dispositions.contradicted || dispositions.quarantined;
    if (dispositions.contradicted) reasonCodes.push("hard_hidden_contradicted");
    if (dispositions.quarantined) reasonCodes.push("hard_hidden_quarantined");

    const policyMissing = !subject.present;
    const versionUnsupported =
        subject.present &&
        (subject.policyVersion == null || subject.policyVersion > CLAIM_POLICY_VERSION);
    if (policyMissing) reasonCodes.push("policy_state_missing");
    if (versionUnsupported) reasonCodes.push("policy_version_unsupported");

    const softHiding = dispositions.stale || dispositions.disputed || dispositions.superseded;
    if (dispositions.stale) reasonCodes.push("disposition_stale");
    if (dispositions.disputed) reasonCodes.push("disposition_disputed");
    if (dispositions.superseded) reasonCodes.push("disposition_superseded");
    if (dispositions.rejected) reasonCodes.push("disposition_rejected");

    const matureEnough = MATURITY_RANK[maturity] >= MATURITY_RANK.VERIFIED;
    if (!matureEnough) reasonCodes.push("maturity_below_automatic");

    // Automatic surfaces (R19): effective VERIFIED+ with no disposition and a
    // present, supported policy subject. Anything else fails closed.
    const autoEligible =
        !hardHidden &&
        !softHiding &&
        !dispositions.rejected &&
        !policyMissing &&
        !versionUnsupported &&
        matureEnough;

    // Explicit search (R17, R20): hard-hidden and rejected rows never appear;
    // missing/unsupported policy appears only as a labeled unknown on the
    // TypeScript compatibility path; everything else appears, labeled unless
    // it is a clean effective-VERIFIED+ row.
    const explicitEligible = !hardHidden && !dispositions.rejected;
    const explicitLabeled =
        explicitEligible && (!autoEligible || !matureEnough || softHiding || policyMissing);

    if (reasonCodes.length === 0) reasonCodes.push("eligible");

    const hiddenSurface: SurfaceDecision = { eligible: false, renderMode: "hidden" };
    const surfaces: Record<PolicySurface, SurfaceDecision> = {
        auto_inject: autoEligible ? { eligible: true, renderMode: "normal" } : hiddenSurface,
        auto_search: autoEligible ? { eligible: true, renderMode: "normal" } : hiddenSurface,
        explicit_search: explicitEligible
            ? { eligible: true, renderMode: explicitLabeled ? "labeled" : "normal" }
            : hiddenSurface,
        // Host-only review always includes the row; hard-hidden rows carry
        // audit context there and nowhere else (R16-R17).
        review: { eligible: true, renderMode: hardHidden ? "review_audit" : "normal" },
    };

    return {
        effectiveMaturity: maturity,
        originTaint: taint,
        surfaces,
        reasonCodes,
        activeDispositions: active,
        hardHidden,
        policyVersion: CLAIM_POLICY_VERSION,
    };
}

/**
 * Sanitized agent-facing label for explicit-search rendering (R18, R20).
 * Deliberately excludes locators, hashes, identities, reviewer identity, and
 * conflict details.
 */
export function agentPolicyLabel(decision: PolicyDecision): string | null {
    const explicit = decision.surfaces.explicit_search;
    if (!explicit.eligible || explicit.renderMode !== "labeled") return null;
    return explicitSearchLabelFromFields({
        effectiveMaturity: decision.effectiveMaturity,
        originTaint: decision.originTaint,
        dispositions: decision.activeDispositions,
        policyMissing: decision.reasonCodes.includes("policy_state_missing"),
        autoEligible: decision.surfaces.auto_inject.eligible,
    });
}

export function explicitSearchLabelFromFields(fields: {
    effectiveMaturity: string;
    originTaint: string;
    dispositions: readonly string[];
    policyMissing: boolean;
    autoEligible: boolean;
}): string | null {
    const soft = fields.dispositions.filter(
        (name) => name !== "contradicted" && name !== "quarantined",
    );
    const clean = fields.autoEligible && !fields.policyMissing && soft.length === 0;
    if (clean) return null;
    const parts: string[] = [fields.effectiveMaturity.toLowerCase()];
    parts.push(`taint:${fields.originTaint.toLowerCase()}`);
    for (const name of soft) parts.push(name);
    if (fields.policyMissing) parts.push("policy:unknown");
    return parts.join(" ");
}
