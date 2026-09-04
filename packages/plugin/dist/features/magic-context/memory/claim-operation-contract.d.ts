/**
 * Shared claim-operation request/result encoding contract (KTD3, KTD5; R2,
 * R5-R6, R20). TypeScript twin of `crates/mc-core/src/claim_operation.rs`;
 * both runtimes are proven against
 * `memory/fixtures/claim-operation-contract-v1.json`.
 *
 * Canonical encoding rules (pinned by CLAIM_REQUEST_ENCODING_VERSION /
 * CLAIM_RESULT_ENCODING_VERSION = 1):
 *   - values: null, booleans, safe integers, well-formed Unicode strings,
 *     arrays, and plain objects. Floats, non-finite numbers, integers
 *     outside +/-(2^53 - 1), lone surrogates, and non-plain values are
 *     rejected.
 *   - objects: keys sorted by Unicode code point (== UTF-8 byte order).
 *   - strings: '"', '\\', and U+0000-U+001F escaped ('\u00xx' with lowercase
 *     hex, no short escapes); every other code point emitted literally.
 *   - numbers: base-10 integers with no exponent, no fraction, no '-0'.
 *   - no insignificant whitespace.
 *   - byte values (digests, incarnation IDs) travel as lowercase hex strings.
 *
 * Digests are SHA-256 hex over `<protocol>\n<canonical JSON>` UTF-8 bytes.
 *
 * Dependency-light on purpose: `node:` imports only.
 */
export declare const CLAIM_REQUEST_ENCODING_VERSION = 1;
export declare const CLAIM_RESULT_ENCODING_VERSION = 1;
export declare const CLAIM_REQUEST_DIGEST_PROTOCOL = "mc-claim-request-v1";
export declare const CLAIM_MUTATION_TOKEN_DIGEST_PROTOCOL = "mc-claim-mutation-token-v1";
export declare const SNAPSHOT_VECTOR_DIGEST_PROTOCOL = "mc-claim-snapshot-vector-v1";
export declare const APPLICABILITY_HEADS_DIGEST_PROTOCOL = "mc-claim-applicability-heads-v1";
export declare const POLICY_HEADS_DIGEST_PROTOCOL = "mc-claim-policy-heads-v1";
export type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | {
    [key: string]: CanonicalJsonValue;
};
export declare class CanonicalEncodingError extends Error {
    constructor(message: string);
}
/** Unicode code-point comparison (== UTF-8 byte order, unlike JS `<` which
 * compares UTF-16 code units and misorders astral-plane keys). */
export declare function compareCodePoints(left: string, right: string): number;
/** Canonicalize a JSON-shaped value into the pinned byte form. */
export declare function canonicalJsonEncode(value: unknown): string;
export declare function sha256HexUtf8(text: string): string;
/** Canonical request digest for the operation identity (R6, KTD5). The
 * request must contain only the semantic fields — never clocks. */
export declare function computeClaimOperationRequestDigest(request: unknown): string;
export declare const PUBLIC_CLAIM_ID_PREFIX = "mcm_";
export declare function generatePublicClaimId(random?: (byteCount: number) => Uint8Array): string;
export declare function isValidPublicClaimId(candidate: string): boolean;
/** Canonical revision identity: public claim ID + revision number + exact
 * content digest (KTD3). */
export interface RevisionLocator {
    readonly publicClaimId: string;
    readonly revision: number;
    readonly contentDigest: string;
}
export declare function formatRevisionLocator(locator: RevisionLocator): string;
/** Parse and validate a revision locator string; null when malformed. */
export declare function parseRevisionLocator(raw: string): RevisionLocator | null;
/**
 * Claim-local fencing state (R5): revision identity plus the lifecycle,
 * applicability, and policy heads of the CURRENT revision. Writes for an
 * unrelated claim never move any field.
 */
export interface ClaimMutationToken {
    readonly tokenVersion: number;
    readonly publicClaimId: string;
    readonly revision: number;
    readonly contentDigest: string;
    readonly lifecycleSeq: number;
    /** Digest over the sorted (streamKey, seq) head pairs. */
    readonly applicabilityHeadsDigest: string;
    /** Digest over the append-only policy ledger counts. */
    readonly policyHeadsDigest: string;
}
export declare function canonicalClaimMutationToken(token: ClaimMutationToken): string;
export declare function computeClaimMutationTokenDigest(token: ClaimMutationToken): string;
/** Digest over applicability stream heads: array of {seq, streamKey} sorted
 * by stream key. */
export declare function computeApplicabilityHeadsDigest(heads: ReadonlyArray<{
    streamKey: string;
    seq: number;
}>): string;
/** Append-only policy ledger counts for the current revision: any policy
 * append moves one count, so the digest fences every policy head. */
export interface PolicyHeadCounts {
    readonly maturitySeq: number;
    readonly approvalCount: number;
    readonly dispositionCount: number;
    readonly artifactCount: number;
    readonly artifactEventCount: number;
    readonly verificationCount: number;
}
export declare function computePolicyHeadsDigest(counts: PolicyHeadCounts): string;
/**
 * Publication-freshness state, separate from mutation fencing (KTD3):
 * database incarnation, workspace epoch, and per-project claim/policy
 * generations, rechecked from a fresh snapshot before publication (R10).
 * Generation maps are keyed by decimal project ID strings.
 */
export interface SnapshotVector {
    readonly vectorVersion: number;
    readonly databaseIncarnationId: string;
    readonly workspaceEpoch: string;
    readonly projectGenerations: Readonly<Record<string, number>>;
    readonly policyGenerations: Readonly<Record<string, number>>;
}
export declare function canonicalSnapshotVector(vector: SnapshotVector): string;
export declare function computeSnapshotVectorDigest(vector: SnapshotVector): string;
export declare const CLAIM_RESULT_OUTCOMES: readonly ["applied", "stale", "noop"];
export type ClaimResultOutcome = (typeof CLAIM_RESULT_OUTCOMES)[number];
export interface ClaimOperationResultEffect {
    readonly effectKey: string;
    readonly changeKind: string;
    readonly projectId: number;
    readonly generation: number;
    readonly revisionLocator: string | null;
}
/** The durable, replay-returned result envelope. Stored as canonical bytes;
 * replay returns those bytes verbatim (R6). */
export interface ClaimOperationResult {
    readonly resultEncodingVersion: number;
    readonly outcome: ClaimResultOutcome;
    readonly staleReason: string | null;
    readonly payload: CanonicalJsonValue | null;
    readonly effects: readonly ClaimOperationResultEffect[];
    readonly generations: Readonly<Record<string, number>>;
}
export declare function encodeClaimOperationResult(result: ClaimOperationResult): string;
export declare class ClaimResultDecodingError extends Error {
    constructor(message: string);
}
/** Strict decoder for a stored result envelope. Fails closed on an unknown
 * encoding version, outcome, or malformed effect rows. */
export declare function decodeClaimOperationResult(resultJson: string): ClaimOperationResult;
//# sourceMappingURL=claim-operation-contract.d.ts.map