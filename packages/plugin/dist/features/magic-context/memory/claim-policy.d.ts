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
import { type ClaimKind, type FineTaint, type MaturityLevel } from "../storage-claim-policy-schema.ts";
/** Version stamp recorded as the subject classification method (R1). */
export declare const TAINT_CLASSIFIER_METHOD = "mc-taint-classifier-v1";
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
/**
 * Versioned coarse-to-fine derivation (R3-R4). Conservative on every unknown:
 * web and tool channels fall to `TOOL_UNTRUSTED_OUTPUT`, repository text to
 * `REPO_UNTRUSTED_TEXT`, and locally-trusted channels WITHOUT host validation
 * stay untrusted — a more trusted class requires host-validated evidence.
 */
export declare function classifyFineTaint(input: TaintClassifierInput): FineTaint;
export declare function taintMayOriginateDirective(taint: FineTaint): boolean;
/** Whether a claim kind receives directive-strength origin restrictions (R2). */
export declare function kindIsDirectiveStrength(kind: ClaimKind): boolean;
/** Automated reducers may advance no further than VERIFIED (R8). */
export declare const AUTOMATIC_MATURITY_CEILING: MaturityLevel;
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
export declare function automaticMaturityTarget(input: MaturityTransitionInput): MaturityLevel;
/** Automatic transitions omit CORROBORATED when independentGroups < 2. */
export declare function automaticLadderSteps(from: MaturityLevel | null, input: MaturityTransitionInput): MaturityLevel[];
//# sourceMappingURL=claim-policy.d.ts.map