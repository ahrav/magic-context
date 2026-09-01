/**
 *
 * This module derives taint, kind, and transition verdicts from host-observed provenance facts.
 * The inputs include a coarse trust class, extractor lineage, host-validated artifact kind, and user-inference status.
 * This module never accepts extracted content.
 */

import type { SourceTrustClass } from "../storage-claim-applicability-schema.ts";
import {
    type ClaimKind,
    type FineTaint,
    MATURITY_RANK,
    type MaturityLevel,
} from "../storage-claim-policy-schema.ts";

/* */
export const TAINT_CLASSIFIER_METHOD = "mc-taint-classifier-v1";

/**
 */
export type HostValidatedArtifactKind = "code" | "test" | "config";

export interface TaintClassifierInput {
    /* */
    readonly sourceTrustClass: SourceTrustClass;
    /* */
    readonly extractor?: string | null;
    /**
     * */
    readonly hostValidatedArtifact?: HostValidatedArtifactKind | null;
    /**
     * */
    readonly userInferred?: boolean;
}

const HOST_VALIDATED_TAINT: Readonly<Record<HostValidatedArtifactKind, FineTaint>> = {
    code: "CURRENT_CODE",
    test: "CURRENT_TEST",
    config: "CURRENT_CONFIG",
};

function inferenceTaint(extractor: string | null | undefined): FineTaint {
    return typeof extractor === "string" && extractor.toLowerCase().includes("dreamer")
        ? "DREAMER_INFERENCE"
        : "ASSISTANT_INFERENCE";
}

/**
 * Locally trusted channels without host validation remain untrusted; trusted taints require host-validated evidence.
 */
export function classifyFineTaint(input: TaintClassifierInput): FineTaint {
    switch (input.sourceTrustClass) {
        case "explicit_user":
            return input.userInferred ? "USER_INFERRED" : "USER_EXPLICIT";
        case "trusted_local_code":
        case "trusted_tool_result": {
            const validated = input.hostValidatedArtifact;
            if (validated) return HOST_VALIDATED_TAINT[validated];
            return input.sourceTrustClass === "trusted_local_code"
                ? "REPO_UNTRUSTED_TEXT"
                : "TOOL_UNTRUSTED_OUTPUT";
        }
        case "untrusted_repo_text":
            return "REPO_UNTRUSTED_TEXT";
        case "untrusted_web":
            return "TOOL_UNTRUSTED_OUTPUT";
        case "model_inference":
            return input.userInferred ? "USER_INFERRED" : inferenceTaint(input.extractor);
    }
}

const DIRECTIVE_ORIGIN_BLOCKED_TAINTS: ReadonlySet<FineTaint> = new Set([
    "REPO_UNTRUSTED_TEXT",
    "TOOL_UNTRUSTED_OUTPUT",
]);

export function taintMayOriginateDirective(taint: FineTaint): boolean {
    return !DIRECTIVE_ORIGIN_BLOCKED_TAINTS.has(taint);
}

/* */
export function kindIsDirectiveStrength(kind: ClaimKind): boolean {
    return kind !== "descriptive";
}

/* */
export const AUTOMATIC_MATURITY_CEILING: MaturityLevel = "VERIFIED";

export interface MaturityTransitionInput {
    readonly kind: ClaimKind;
    readonly originTaint: FineTaint;
    readonly independentGroups: number;
    readonly verified: boolean;
    readonly explicitUserEvidence: boolean;
}

/**
 * A directive-strength claim whose origin cannot originate a directive remains `CANDIDATE` unless explicit-user evidence backs it.
 * Repository or tool content may corroborate or verify a directive-strength claim backed by explicit-user evidence.
 */
export function automaticMaturityTarget(input: MaturityTransitionInput): MaturityLevel {
    if (
        kindIsDirectiveStrength(input.kind) &&
        !taintMayOriginateDirective(input.originTaint) &&
        !input.explicitUserEvidence
    ) {
        return "CANDIDATE";
    }
    if (input.verified || input.explicitUserEvidence) return AUTOMATIC_MATURITY_CEILING;
    if (input.independentGroups >= 2) return "CORROBORATED";
    return "CANDIDATE";
}

/** Automatic transitions omit CORROBORATED when independentGroups < 2. */
export function automaticLadderSteps(
    from: MaturityLevel | null,
    input: MaturityTransitionInput,
): MaturityLevel[] {
    const fromRank = from == null ? -1 : MATURITY_RANK[from];
    const toRank = MATURITY_RANK[automaticMaturityTarget(input)];
    const supported: MaturityLevel[] = ["CANDIDATE"];
    if (input.independentGroups >= 2) supported.push("CORROBORATED");
    if (input.verified || input.explicitUserEvidence) supported.push("VERIFIED");
    return supported.filter(
        (level) => MATURITY_RANK[level] > fromRank && MATURITY_RANK[level] <= toRank,
    );
}
