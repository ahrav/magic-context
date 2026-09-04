/**
 * Storage and resolution over `git_anchors` / `git_anchor_representations`
 * (migration v85). Transaction-local writers: every `InCurrentTransaction`
 * function requires a caller-held write transaction
 * (`db.transaction(fn).immediate()`), matching the storage-claims convention.
 *
 * Resolution is strength-ordered and ambiguity-preserving: full commit OID,
 * then tree OID, then stable patch ID. Multiple candidates at a level return
 * `ambiguous` immediately without consulting weaker evidence; anchors are
 * never merged. No level beyond `patch_id` exists.
 */
import type { Database } from "../../../shared/sqlite";
import { type GitAnchorRepresentationKind } from "../storage-claim-applicability-schema.ts";
import type { GitAnchorCapture } from "./git-anchor-reader.ts";
/** Versioned protocol tag for raw git OID and path representations. */
export declare const GIT_OID_PROTOCOL = "git-oid-v1";
export interface GitAnchorRepresentationInput {
    kind: GitAnchorRepresentationKind;
    objectFormat?: "sha1" | "sha256";
    protocol: string;
    namespace?: string;
    value: string;
}
export interface CreateGitAnchorInput {
    projectId: number;
    representations: GitAnchorRepresentationInput[];
}
/** Requires a caller-held write transaction. Returns the new anchor id. */
export declare function createGitAnchorInCurrentTransaction(db: Database, input: CreateGitAnchorInput): number;
/**
 * Requires a caller-held write transaction. Appends representations to an
 * existing anchor, skipping rows that already exist (idempotent); the
 * project id derives from the anchor row.
 */
export declare function appendGitAnchorRepresentationsInCurrentTransaction(db: Database, anchorId: number, representations: GitAnchorRepresentationInput[]): void;
/**
 * Map a reader capture to representation rows: commit OID, tree OID, patch
 * ID (when present), and one `path` row per changed path. Abbreviated OIDs
 * throw — abbreviations are rejected as persisted identities.
 */
export declare function anchorRepresentationsFromCapture(capture: GitAnchorCapture): GitAnchorRepresentationInput[];
export type GitAnchorResolution = {
    status: "resolved";
    anchorId: number;
} | {
    status: "ambiguous";
    kind: GitAnchorRepresentationKind;
    candidates: number[];
} | {
    status: "unresolved";
};
export interface ResolveGitAnchorInput {
    projectId: number;
    capture?: GitAnchorCapture;
    representations?: GitAnchorRepresentationInput[];
}
export declare function resolveGitAnchor(db: Database, input: ResolveGitAnchorInput): GitAnchorResolution;
//# sourceMappingURL=storage-git-anchors.d.ts.map