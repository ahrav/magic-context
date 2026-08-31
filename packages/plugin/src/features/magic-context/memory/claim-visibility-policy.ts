/**
 *
 */

import {
    CLAIM_POLICY_VERSION,
    type FineTaint,
    MATURITY_LEVELS,
    MATURITY_RANK,
    type MaturityLevel,
} from "../storage-claim-policy-schema.ts";

export { CLAIM_POLICY_VERSION };

/**
 *
 */
export const POLICY_SURFACES = ["auto_inject", "auto_search", "explicit_search", "review"] as const;
export type PolicySurface = (typeof POLICY_SURFACES)[number];

/**
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

/* */
export interface PolicySupport {
    /** Head of the append-only maturity stream; null when never asserted. */
    readonly historicalMaturity: MaturityLevel | null;
    /** Whether an effective host-recorded approval exists. */
    readonly approved: boolean;
    /** Whether a valid passing enforcement artifact exists. */
    readonly enforcedArtifact: boolean;
    /** Currently effective exact-revision positive verification. */
    readonly verified: boolean;
    /** Exact explicit-user origin evidence supports `VERIFIED`. */
    readonly explicitUserEvidence: boolean;
    /** Number of independently rooted evidence groups. */
    readonly independentGroups: number;
}

export interface PolicySubjectState {
    /** False when the revision has no policy-subject row. */
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

/* */
export function supportedMaturity(support: PolicySupport): MaturityLevel {
    if (support.approved && support.enforcedArtifact) return "ENFORCED";
    if (support.approved) return "APPROVED";
    if (support.verified || support.explicitUserEvidence) return "VERIFIED";
    if (support.independentGroups >= 2) return "CORROBORATED";
    return "CANDIDATE";
}

/** The effective rung never exceeds historical maturity. */
export function effectiveMaturity(support: PolicySupport): MaturityLevel {
    const historical = support.historicalMaturity ?? "CANDIDATE";
    const supported = supportedMaturity(support);
    // visibility).
    return MATURITY_LEVELS[Math.min(MATURITY_RANK[historical], MATURITY_RANK[supported])];
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
 */
export function evaluateClaimPolicy(input: PolicyEvaluationInput): PolicyDecision {
    const { subject, support, dispositions } = input;
    const maturity = effectiveMaturity(support);
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
    const taint =
        subject.present && !versionUnsupported && subject.originTaint != null
            ? subject.originTaint
            : "unknown";

    const softHiding = dispositions.stale || dispositions.disputed || dispositions.superseded;
    if (dispositions.stale) reasonCodes.push("disposition_stale");
    if (dispositions.disputed) reasonCodes.push("disposition_disputed");
    if (dispositions.superseded) reasonCodes.push("disposition_superseded");
    if (dispositions.rejected) reasonCodes.push("disposition_rejected");

    const matureEnough = MATURITY_RANK[maturity] >= MATURITY_RANK.VERIFIED;
    if (!matureEnough) reasonCodes.push("maturity_below_automatic");

    // Automatic surfaces require effective `VERIFIED` maturity, a supported policy subject, and no dispositions.
    // Automatic surfaces are hidden unless maturity is `VERIFIED` or higher, the policy subject is present and supported, and no disposition is set.
    const autoEligible =
        !hardHidden &&
        !softHiding &&
        !dispositions.rejected &&
        !policyMissing &&
        !versionUnsupported &&
        matureEnough;

    // `explicit_search` excludes hard-hidden and rejected rows.
    // `explicit_search` labels eligible rows that are not auto-eligible.
    // `explicit_search` labels every eligible row that is not auto-eligible.
    // `explicit_search` renders normal only for auto-eligible rows.
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
        // `review` is eligible for every row.
        // `review` uses `review_audit` for hard-hidden rows.
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
 * conflict details.
 *
 */
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
