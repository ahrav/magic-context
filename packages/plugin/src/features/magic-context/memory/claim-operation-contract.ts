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

import { createHash, randomBytes } from "node:crypto";

export const CLAIM_REQUEST_ENCODING_VERSION = 1;
export const CLAIM_RESULT_ENCODING_VERSION = 1;

export const CLAIM_REQUEST_DIGEST_PROTOCOL = "mc-claim-request-v1";
export const CLAIM_MUTATION_TOKEN_DIGEST_PROTOCOL = "mc-claim-mutation-token-v1";
export const SNAPSHOT_VECTOR_DIGEST_PROTOCOL = "mc-claim-snapshot-vector-v1";
export const APPLICABILITY_HEADS_DIGEST_PROTOCOL = "mc-claim-applicability-heads-v1";
export const POLICY_HEADS_DIGEST_PROTOCOL = "mc-claim-policy-heads-v1";

export type CanonicalJsonValue =
    | null
    | boolean
    | number
    | string
    | CanonicalJsonValue[]
    | { [key: string]: CanonicalJsonValue };

export class CanonicalEncodingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CanonicalEncodingError";
    }
}

/** Unicode code-point comparison (== UTF-8 byte order, unlike JS `<` which
 * compares UTF-16 code units and misorders astral-plane keys). */
export function compareCodePoints(left: string, right: string): number {
    const leftPoints = [...left];
    const rightPoints = [...right];
    const shared = Math.min(leftPoints.length, rightPoints.length);
    for (let index = 0; index < shared; index++) {
        const a = leftPoints[index].codePointAt(0) as number;
        const b = rightPoints[index].codePointAt(0) as number;
        if (a !== b) return a - b;
    }
    return leftPoints.length - rightPoints.length;
}

// The repo's TS lib target lacks String.prototype.isWellFormed, so isWellFormedUnicode scans UTF-16 code units directly. commentlint: allow(JUDGE)
function isWellFormedUnicode(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
            if (next < 0xdc00 || next > 0xdfff) return false;
            index++;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return false;
        }
    }
    return true;
}

function encodeCanonicalString(value: string): string {
    if (!isWellFormedUnicode(value)) {
        throw new CanonicalEncodingError("canonical strings must be well-formed Unicode");
    }
    let out = '"';
    for (const char of value) {
        const code = char.codePointAt(0) as number;
        if (char === '"') out += '\\"';
        else if (char === "\\") out += "\\\\";
        else if (code < 0x20) out += `\\u00${code.toString(16).padStart(2, "0")}`;
        else out += char;
    }
    return `${out}"`;
}

/** Canonicalize a JSON-shaped value into the pinned byte form. */
export function canonicalJsonEncode(value: unknown): string {
    if (value === null) return "null";
    switch (typeof value) {
        case "boolean":
            return value ? "true" : "false";
        case "number":
            if (!Number.isSafeInteger(value)) {
                throw new CanonicalEncodingError(
                    `canonical numbers must be safe integers: ${String(value)}`,
                );
            }
            // String(-0) === "0", so negative zero already normalizes.
            return String(value);
        case "string":
            return encodeCanonicalString(value);
        case "object": {
            if (Array.isArray(value)) {
                return `[${value.map((item) => canonicalJsonEncode(item)).join(",")}]`;
            }
            const prototype = Object.getPrototypeOf(value);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new CanonicalEncodingError("canonical objects must be plain objects");
            }
            const record = value as Record<string, unknown>;
            const keys = Object.keys(record).sort(compareCodePoints);
            const parts = keys.map(
                (key) => `${encodeCanonicalString(key)}:${canonicalJsonEncode(record[key])}`,
            );
            return `{${parts.join(",")}}`;
        }
        default:
            throw new CanonicalEncodingError(`value of type ${typeof value} is not canonical`);
    }
}

export function sha256HexUtf8(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function protocolDigest(protocol: string, value: unknown): string {
    return sha256HexUtf8(`${protocol}\n${canonicalJsonEncode(value)}`);
}

/** Canonical request digest for the operation identity (R6, KTD5). The
 * request must contain only the semantic fields — never clocks. */
export function computeClaimOperationRequestDigest(request: unknown): string {
    return protocolDigest(CLAIM_REQUEST_DIGEST_PROTOCOL, request);
}

// ---------------------------------------------------------------------------
// Public claim identity and revision locators (R2, KTD3)
// ---------------------------------------------------------------------------

export const PUBLIC_CLAIM_ID_PREFIX = "mcm_";
const PUBLIC_CLAIM_ID_PATTERN = /^mcm_[0-9a-f]{32}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function generatePublicClaimId(
    random: (byteCount: number) => Uint8Array = randomBytes,
): string {
    return `${PUBLIC_CLAIM_ID_PREFIX}${Buffer.from(random(16)).toString("hex")}`;
}

export function isValidPublicClaimId(candidate: string): boolean {
    return PUBLIC_CLAIM_ID_PATTERN.test(candidate);
}

/** Canonical revision identity: public claim ID + revision number + exact
 * content digest (KTD3). */
export interface RevisionLocator {
    readonly publicClaimId: string;
    readonly revision: number;
    readonly contentDigest: string;
}

export function formatRevisionLocator(locator: RevisionLocator): string {
    if (!isValidPublicClaimId(locator.publicClaimId)) {
        throw new CanonicalEncodingError(`invalid public claim ID: ${locator.publicClaimId}`);
    }
    if (!Number.isSafeInteger(locator.revision) || locator.revision < 1) {
        throw new CanonicalEncodingError(`invalid revision number: ${String(locator.revision)}`);
    }
    if (!SHA256_HEX_PATTERN.test(locator.contentDigest)) {
        throw new CanonicalEncodingError(`invalid content digest: ${locator.contentDigest}`);
    }
    return `${locator.publicClaimId}/r${locator.revision}/${locator.contentDigest}`;
}

/** Parse and validate a revision locator string; null when malformed. */
export function parseRevisionLocator(raw: string): RevisionLocator | null {
    const parts = raw.split("/");
    if (parts.length !== 3) return null;
    const [publicClaimId, revisionPart, contentDigest] = parts;
    if (!isValidPublicClaimId(publicClaimId)) return null;
    if (!/^r[1-9][0-9]*$/.test(revisionPart)) return null;
    const revision = Number(revisionPart.slice(1));
    if (!Number.isSafeInteger(revision)) return null;
    if (!SHA256_HEX_PATTERN.test(contentDigest)) return null;
    return { publicClaimId, revision, contentDigest };
}

// ---------------------------------------------------------------------------
// Claim-local mutation token and snapshot vector (KTD3)
// ---------------------------------------------------------------------------

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

function tokenShape(token: ClaimMutationToken): CanonicalJsonValue {
    return {
        applicabilityHeadsDigest: token.applicabilityHeadsDigest,
        contentDigest: token.contentDigest,
        lifecycleSeq: token.lifecycleSeq,
        policyHeadsDigest: token.policyHeadsDigest,
        publicClaimId: token.publicClaimId,
        revision: token.revision,
        tokenVersion: token.tokenVersion,
    };
}

export function canonicalClaimMutationToken(token: ClaimMutationToken): string {
    return canonicalJsonEncode(tokenShape(token));
}

export function computeClaimMutationTokenDigest(token: ClaimMutationToken): string {
    return protocolDigest(CLAIM_MUTATION_TOKEN_DIGEST_PROTOCOL, tokenShape(token));
}

/** Digest over applicability stream heads: array of {seq, streamKey} sorted
 * by stream key. */
export function computeApplicabilityHeadsDigest(
    heads: ReadonlyArray<{ streamKey: string; seq: number }>,
): string {
    const sorted = [...heads]
        .sort((left, right) => compareCodePoints(left.streamKey, right.streamKey))
        .map((head) => ({ seq: head.seq, streamKey: head.streamKey }));
    return protocolDigest(APPLICABILITY_HEADS_DIGEST_PROTOCOL, sorted);
}

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

export function computePolicyHeadsDigest(counts: PolicyHeadCounts): string {
    return protocolDigest(POLICY_HEADS_DIGEST_PROTOCOL, {
        approvalCount: counts.approvalCount,
        artifactCount: counts.artifactCount,
        artifactEventCount: counts.artifactEventCount,
        dispositionCount: counts.dispositionCount,
        maturitySeq: counts.maturitySeq,
        verificationCount: counts.verificationCount,
    });
}

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

function snapshotVectorShape(vector: SnapshotVector): CanonicalJsonValue {
    return {
        databaseIncarnationId: vector.databaseIncarnationId,
        policyGenerations: { ...vector.policyGenerations },
        projectGenerations: { ...vector.projectGenerations },
        vectorVersion: vector.vectorVersion,
        workspaceEpoch: vector.workspaceEpoch,
    };
}

export function canonicalSnapshotVector(vector: SnapshotVector): string {
    return canonicalJsonEncode(snapshotVectorShape(vector));
}

export function computeSnapshotVectorDigest(vector: SnapshotVector): string {
    return protocolDigest(SNAPSHOT_VECTOR_DIGEST_PROTOCOL, snapshotVectorShape(vector));
}

// ---------------------------------------------------------------------------
// Stored operation results (KTD5, R6, R20)
// ---------------------------------------------------------------------------

export const CLAIM_RESULT_OUTCOMES = ["applied", "stale", "noop"] as const;
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

export function encodeClaimOperationResult(result: ClaimOperationResult): string {
    return canonicalJsonEncode({
        effects: result.effects.map((effect) => ({
            changeKind: effect.changeKind,
            effectKey: effect.effectKey,
            generation: effect.generation,
            projectId: effect.projectId,
            revisionLocator: effect.revisionLocator,
        })),
        generations: { ...result.generations },
        outcome: result.outcome,
        payload: result.payload,
        resultEncodingVersion: result.resultEncodingVersion,
        staleReason: result.staleReason,
    });
}

export class ClaimResultDecodingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ClaimResultDecodingError";
    }
}

function isIntegerRecord(value: unknown): value is Record<string, number> {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value as Record<string, unknown>).every((entry) =>
            Number.isSafeInteger(entry),
        )
    );
}

/** Strict decoder for a stored result envelope. Fails closed on an unknown
 * encoding version, outcome, or malformed effect rows. */
export function decodeClaimOperationResult(resultJson: string): ClaimOperationResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(resultJson);
    } catch (error) {
        throw new ClaimResultDecodingError(
            `stored claim operation result is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ClaimResultDecodingError("stored claim operation result must be an object");
    }
    const record = parsed as Record<string, unknown>;
    if (record.resultEncodingVersion !== CLAIM_RESULT_ENCODING_VERSION) {
        throw new ClaimResultDecodingError(
            `unsupported result encoding version: ${String(record.resultEncodingVersion)}`,
        );
    }
    const outcome = record.outcome;
    if (
        typeof outcome !== "string" ||
        !CLAIM_RESULT_OUTCOMES.includes(outcome as ClaimResultOutcome)
    ) {
        throw new ClaimResultDecodingError(`unsupported result outcome: ${String(outcome)}`);
    }
    if (record.staleReason !== null && typeof record.staleReason !== "string") {
        throw new ClaimResultDecodingError("result staleReason must be a string or null");
    }
    if (!Array.isArray(record.effects)) {
        throw new ClaimResultDecodingError("result effects must be an array");
    }
    const effects: ClaimOperationResultEffect[] = record.effects.map((entry, index) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            throw new ClaimResultDecodingError(`result effect ${index} must be an object`);
        }
        const effect = entry as Record<string, unknown>;
        if (
            typeof effect.effectKey !== "string" ||
            typeof effect.changeKind !== "string" ||
            !Number.isSafeInteger(effect.projectId) ||
            !Number.isSafeInteger(effect.generation) ||
            (effect.revisionLocator !== null && typeof effect.revisionLocator !== "string")
        ) {
            throw new ClaimResultDecodingError(`result effect ${index} is malformed`);
        }
        if (
            typeof effect.revisionLocator === "string" &&
            parseRevisionLocator(effect.revisionLocator) === null
        ) {
            throw new ClaimResultDecodingError(
                `result effect ${index} carries an invalid revision locator`,
            );
        }
        return {
            effectKey: effect.effectKey,
            changeKind: effect.changeKind,
            projectId: effect.projectId as number,
            generation: effect.generation as number,
            revisionLocator: (effect.revisionLocator ?? null) as string | null,
        };
    });
    if (!isIntegerRecord(record.generations)) {
        throw new ClaimResultDecodingError("result generations must map project IDs to integers");
    }
    return {
        resultEncodingVersion: CLAIM_RESULT_ENCODING_VERSION,
        outcome: outcome as ClaimResultOutcome,
        staleReason: (record.staleReason ?? null) as string | null,
        payload: (record.payload ?? null) as CanonicalJsonValue | null,
        effects,
        generations: record.generations,
    };
}
