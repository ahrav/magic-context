/**
 * Versioned fine-taint classification and maturity transition predicates
 * (claim-trust-policy plan: U2; KTD3-KTD4; R2-R9).
 *
 * Pure module: provenance facts in, taint/kind/transition verdicts out. The
 * inputs are host-observed facts (coarse trust class, extractor lineage,
 * host-validated structured-reader evidence) — never extracted content or
 * self-asserted metadata (R4).
 */

import type { SourceTrustClass } from "../storage-claim-applicability-schema.ts";
import {
    type ClaimKind,
    type FineTaint,
    MATURITY_RANK,
    type MaturityLevel,
} from "../storage-claim-policy-schema.ts";

/** Version stamp recorded as the subject classification method (R1). */
export const TAINT_CLASSIFIER_METHOD = "mc-taint-classifier-v1";

/**
 * Host-validated structured-reader evidence (R9, KTD3): only a host-controlled
 * reader that itself resolved the local artifact may assert one of these.
 * Extracted content claiming to be code/test/config never reaches here.
 */
export type HostValidatedArtifactKind = "code" | "test" | "config";

export interface TaintClassifierInput {
    /** Coarse immutable trust class recorded on the observation (v85). */
    readonly sourceTrustClass: SourceTrustClass;
    /** Extractor identity from the observation row (host-written lineage). */
    readonly extractor?: string | null;
    /** Present only when a host-controlled structured reader validated the
     * local artifact this observation was read from (KTD3). */
    readonly hostValidatedArtifact?: HostValidatedArtifactKind | null;
    /** Writer-declared user-inferred channel: content the assistant inferred
     * FROM user statements rather than a verbatim user instruction. */
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
 * Versioned coarse-to-fine derivation (R3-R4). Conservative on every unknown:
 * web and tool channels fall to `TOOL_UNTRUSTED_OUTPUT`, repository text to
 * `REPO_UNTRUSTED_TEXT`, and locally-trusted channels WITHOUT host validation
 * stay untrusted — a more trusted class requires host-validated evidence.
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

/** Whether a claim kind receives directive-strength origin restrictions (R2). */
export function kindIsDirectiveStrength(kind: ClaimKind): boolean {
    return kind !== "descriptive";
}

/** Automated reducers may advance no further than VERIFIED (R8). */
export const AUTOMATIC_MATURITY_CEILING: MaturityLevel = "VERIFIED";

export interface MaturityTransitionInput {
    readonly kind: ClaimKind;
    readonly originTaint: FineTaint;
    readonly independentGroups: number;
    readonly verified: boolean;
    readonly explicitUserEvidence: boolean;
}

/**
 * The highest rung the automated reducer may assert for a revision (R6-R9):
 * a directive-strength claim whose origin cannot originate a directive stays
 * at CANDIDATE regardless of support unless exact explicit-user evidence
 * backs it — repository or tool content may then still corroborate/verify.
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
