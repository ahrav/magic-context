/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
    type ActiveDispositions,
    effectiveMaturity,
    evaluateClaimPolicy,
    explicitSearchLabelFromFields,
    NO_DISPOSITIONS,
    type PolicyDecision,
    type PolicyEvaluationInput,
    type PolicySupport,
} from "./claim-visibility-policy";

/**
 */
function labelFor(decision: PolicyDecision): string | null {
    const explicit = decision.surfaces.explicit_search;
    if (!explicit.eligible || explicit.renderMode !== "labeled") return null;
    return explicitSearchLabelFromFields({
        effectiveMaturity: decision.effectiveMaturity,
        originTaint: decision.originTaint,
        dispositions: decision.activeDispositions,
        policyMissing:
            decision.reasonCodes.includes("policy_state_missing") ||
            decision.reasonCodes.includes("policy_version_unsupported"),
        autoEligible: decision.surfaces.auto_inject.eligible,
    });
}

const BASE_SUPPORT: PolicySupport = {
    historicalMaturity: null,
    approved: false,
    enforcedArtifact: false,
    verified: false,
    explicitUserEvidence: false,
    independentGroups: 1,
};

function input(overrides: {
    support?: Partial<PolicySupport>;
    dispositions?: Partial<ActiveDispositions>;
    subjectPresent?: boolean;
    policyVersion?: number | null;
}): PolicyEvaluationInput {
    return {
        subject: {
            present: overrides.subjectPresent ?? true,
            originTaint: "ASSISTANT_INFERENCE",
            policyVersion: overrides.policyVersion === undefined ? 1 : overrides.policyVersion,
        },
        support: { ...BASE_SUPPORT, ...overrides.support },
        dispositions: { ...NO_DISPOSITIONS, ...overrides.dispositions },
    };
}

describe("effective maturity reducer", () => {
    test("selects the highest currently supported rung, never above history", () => {
        expect(effectiveMaturity(BASE_SUPPORT)).toBe("CANDIDATE");
        expect(
            effectiveMaturity({ ...BASE_SUPPORT, historicalMaturity: "VERIFIED", verified: true }),
        ).toBe("VERIFIED");
        expect(effectiveMaturity({ ...BASE_SUPPORT, verified: true })).toBe("CANDIDATE");
        expect(
            effectiveMaturity({
                ...BASE_SUPPORT,
                historicalMaturity: "ENFORCED",
                approved: true,
                verified: true,
            }),
        ).toBe("APPROVED");
        expect(
            effectiveMaturity({
                ...BASE_SUPPORT,
                historicalMaturity: "ENFORCED",
                approved: true,
                enforcedArtifact: true,
            }),
        ).toBe("ENFORCED");
    });
});

describe("visibility matrix", () => {
    test("effective VERIFIED+ with no disposition is eligible everywhere", () => {
        const decision = evaluateClaimPolicy(
            input({ support: { historicalMaturity: "VERIFIED", verified: true } }),
        );
        expect(decision.surfaces.auto_inject).toEqual({ eligible: true, renderMode: "normal" });
        expect(decision.surfaces.auto_search).toEqual({ eligible: true, renderMode: "normal" });
        expect(decision.surfaces.explicit_search).toEqual({
            eligible: true,
            renderMode: "normal",
        });
        expect(decision.surfaces.review).toEqual({ eligible: true, renderMode: "normal" });
        expect(decision.reasonCodes).toEqual(["eligible"]);
        expect(labelFor(decision)).toBeNull();
    });

    test("CANDIDATE and CORROBORATED are explicit-search-only with labels", () => {
        for (const support of [
            {},
            { historicalMaturity: "CORROBORATED" as const, independentGroups: 2 },
        ]) {
            const decision = evaluateClaimPolicy(input({ support }));
            expect(decision.surfaces.auto_inject.eligible).toBeFalse();
            expect(decision.surfaces.auto_search.eligible).toBeFalse();
            expect(decision.surfaces.explicit_search).toEqual({
                eligible: true,
                renderMode: "labeled",
            });
            expect(decision.reasonCodes).toContain("maturity_below_automatic");
            const label = labelFor(decision);
            expect(label).toContain("taint:assistant_inference");
        }
    });

    test("stale, disputed, and superseded hide automatically and label explicit search", () => {
        for (const disposition of ["stale", "disputed", "superseded"] as const) {
            const decision = evaluateClaimPolicy(
                input({
                    support: { historicalMaturity: "VERIFIED", verified: true },
                    dispositions: { [disposition]: true },
                }),
            );
            expect(decision.surfaces.auto_inject.eligible).toBeFalse();
            expect(decision.surfaces.explicit_search).toEqual({
                eligible: true,
                renderMode: "labeled",
            });
            expect(labelFor(decision)).toContain(disposition);
        }
    });

    test("rejected is review-only", () => {
        const decision = evaluateClaimPolicy(input({ dispositions: { rejected: true } }));
        expect(decision.surfaces.auto_inject.eligible).toBeFalse();
        expect(decision.surfaces.explicit_search.eligible).toBeFalse();
        expect(decision.surfaces.review.eligible).toBeTrue();
    });

    test("contradicted and quarantined are hard-hidden from every agent surface", () => {
        for (const disposition of ["contradicted", "quarantined"] as const) {
            const decision = evaluateClaimPolicy(
                input({
                    support: { historicalMaturity: "VERIFIED", verified: true },
                    dispositions: { [disposition]: true },
                }),
            );
            expect(decision.hardHidden).toBeTrue();
            expect(decision.surfaces.auto_inject.eligible).toBeFalse();
            expect(decision.surfaces.auto_search.eligible).toBeFalse();
            expect(decision.surfaces.explicit_search.eligible).toBeFalse();
            expect(decision.surfaces.review).toEqual({
                eligible: true,
                renderMode: "review_audit",
            });
        }
    });

    test("missing or version-unsupported policy fails closed on automatic surfaces", () => {
        const missing = evaluateClaimPolicy(
            input({ subjectPresent: false, support: { verified: true } }),
        );
        expect(missing.surfaces.auto_inject.eligible).toBeFalse();
        expect(missing.surfaces.explicit_search.renderMode).toBe("labeled");
        expect(missing.reasonCodes).toContain("policy_state_missing");
        expect(missing.originTaint).toBe("unknown");
        expect(labelFor(missing)).toContain("policy:unknown");

        const future = evaluateClaimPolicy(
            input({
                policyVersion: 999,
                support: { historicalMaturity: "VERIFIED", verified: true },
            }),
        );
        expect(future.surfaces.auto_inject.eligible).toBeFalse();
        expect(future.reasonCodes).toContain("policy_version_unsupported");
        // in storage-claim-visibility.ts.
        expect(future.originTaint).toBe("unknown");
        expect(labelFor(future)).toContain("taint:unknown");
        expect(labelFor(future)).toContain("policy:unknown");
    });

    test("agent labels never carry locators, hashes, or conflict details", () => {
        const decision = evaluateClaimPolicy(input({ dispositions: { stale: true }, support: {} }));
        const label = labelFor(decision) ?? "";
        expect(label).not.toMatch(/[0-9a-f]{32}/);
        expect(label).not.toContain("/");
        expect(label).not.toContain("contradict");
    });
});
