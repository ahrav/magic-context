/**
 * Transaction-local writers and readers for the v85 claim applicability
 * ledger: first-class immutable streams, gapless append-only assertions,
 * path/symbol selectors, and the derived interval view.
 *
 * Type-only, `node:`, and explicit-`.ts` sibling imports keep this module
 * loadable by the Node SQLite smoke script, whose loader cannot resolve
 * extensionless runtime imports.
 *
 * Write protocol: every writer assumes the caller holds a write transaction
 * (the storage-claims.ts `...InCurrentTransaction` convention). Appends go
 * through the current stream head only; a fork, sequence gap, reused
 * predecessor, or regressing recorded/knowledge time fails before any row is
 * written, with the database triggers as the cross-process backstop.
 */
import type { Database } from "../../../shared/sqlite.ts";
import type { ApplicabilityOwnerKind, ApplicabilityPathKind, ApplicabilityPathsState, ApplicabilityState } from "../storage-claim-applicability-schema.ts";
export declare class ApplicabilityWriteError extends Error {
    constructor(message: string);
}
/** Whether this database migrated to v85. */
export declare function hasClaimApplicabilitySchema(db: Database): boolean;
/** Canonical SHA-256 digest over a JSON-serializable source description. */
export declare function computeApplicabilitySourceDigest(source: unknown): string;
export interface EnsureApplicabilityStreamInput {
    revisionId: number;
    projectId: number;
    ownerKind: ApplicabilityOwnerKind;
    streamKey: string;
    keyProtocol: string;
    sourceDigest: string;
    branchSelector?: string | null;
    contextFingerprint?: string | null;
}
export interface ApplicabilityStreamHandle {
    streamId: number;
    created: boolean;
}
/**
 * Idempotent stream resolution (KTD3): replay with the stored key verifies
 * the source digest and lineage fields instead of allocating a duplicate
 * stream; a mismatch is a defect, not a new stream.
 */
export declare function ensureApplicabilityStreamInCurrentTransaction(db: Database, input: EnsureApplicabilityStreamInput): ApplicabilityStreamHandle;
export type ApplicabilityPathsInput = {
    state: Extract<ApplicabilityPathsState, "unknown">;
} | {
    state: Extract<ApplicabilityPathsState, "known">;
    exact?: readonly string[];
    glob?: readonly string[];
};
export interface ApplicabilitySymbolInput {
    protocol: string;
    value: string;
}
export interface AppendApplicabilityAssertionInput {
    streamId: number;
    state: ApplicabilityState;
    paths: ApplicabilityPathsInput;
    symbols?: readonly ApplicabilitySymbolInput[];
    validFromAnchorId?: number | null;
    validUntilAnchorId?: number | null;
    evaluatedAgainstAnchorId?: number | null;
    knownFrom?: number | null;
    recordedAt?: number;
    dependencyFingerprint?: string | null;
    dependencyProtocol?: string | null;
    verifierSpec?: string | null;
}
export interface ApplicabilityAssertionHandle {
    assertionId: number;
    seq: number;
}
/**
 * Append the next assertion at the stream head. Recorded time is clamped
 * forward to the head's recorded time (SQLite wall clocks can regress across
 * processes); an explicitly supplied regressing recorded or knowledge time
 * fails instead. Knowledge time compares against the stream-wide maximum so
 * a NULL known_from gap cannot reopen an older knowledge time.
 */
export declare function appendApplicabilityAssertionInCurrentTransaction(db: Database, input: AppendApplicabilityAssertionInput): ApplicabilityAssertionHandle;
export interface RevisionApplicabilityInput {
    ownerKind: ApplicabilityOwnerKind;
    streamKey: string;
    keyProtocol: string;
    sourceDigest: string;
    branchSelector?: string | null;
    contextFingerprint?: string | null;
    assertion: Omit<AppendApplicabilityAssertionInput, "streamId">;
}
/**
 * One stream plus its opening (or successor) assertion for a just-inserted
 * revision. Claim writers call this between the revision insert and the
 * final pointer CAS so revision, evidence, stream, assertion, and selectors
 * commit or roll back together.
 */
export declare function writeRevisionApplicabilityInCurrentTransaction(db: Database, args: {
    revisionId: number;
    projectId: number;
    applicability: RevisionApplicabilityInput;
}): ApplicabilityAssertionHandle;
export interface ApplicabilityPathRecord {
    kind: ApplicabilityPathKind;
    value: string;
}
export interface ApplicabilitySymbolRecord {
    protocol: string;
    value: string;
}
export interface ApplicabilityAssertionRecord {
    assertionId: number;
    streamId: number;
    streamKey: string;
    ownerKind: ApplicabilityOwnerKind;
    branchSelector: string | null;
    contextFingerprint: string | null;
    seq: number;
    state: ApplicabilityState;
    validFromAnchorId: number | null;
    validUntilAnchorId: number | null;
    evaluatedAgainstAnchorId: number | null;
    knownFrom: number | null;
    recordedAt: number;
    pathsState: ApplicabilityPathsState;
    dependencyFingerprint: string | null;
    dependencyProtocol: string | null;
    verifierSpec: string | null;
    paths: ApplicabilityPathRecord[];
    symbols: ApplicabilitySymbolRecord[];
}
/**
 * Current head assertion per stream for one revision. An empty result means
 * the revision has no recorded applicability: readers treat it as `unknown`
 * (R13) rather than failing.
 */
export declare function readCurrentApplicabilityAssertions(db: Database, revisionId: number): ApplicabilityAssertionRecord[];
export interface ApplicabilityIntervalRecord {
    assertionId: number;
    revisionId: number;
    streamId: number;
    seq: number;
    state: ApplicabilityState;
    validFromAnchorId: number | null;
    validUntilAnchorId: number | null;
    evaluatedAgainstAnchorId: number | null;
    knownFrom: number | null;
    knownUntil: number | null;
    recordedAt: number;
    recordedUntil: number | null;
    pathsState: ApplicabilityPathsState;
}
export declare function readApplicabilityIntervals(db: Database, revisionId: number): ApplicabilityIntervalRecord[];
/**
 * Append a successor assertion carrying new path knowledge onto one of a
 * revision's source streams — only when that knowledge differs from the
 * stream head, so a replayed or no-op mapping write appends nothing. Every
 * non-path head field carries into the successor unchanged: readers treat
 * the head as the whole current snapshot, so a path-only update must not
 * erase anchors, dependency or verifier metadata, or symbol selectors.
 * Callers supply the desired path state and knowledge time explicitly; a
 * regressing knowledge time is clamped forward to the stream maximum.
 */
export declare function syncRevisionApplicabilityPathsInCurrentTransaction(db: Database, args: {
    revisionId: number;
    projectId: number;
    streamKey: string;
    keyProtocol: string;
    sourceDigest: string;
    paths: ApplicabilityPathsInput;
    knownFrom: number;
}): {
    appended: boolean;
};
//# sourceMappingURL=storage-claim-applicability.d.ts.map