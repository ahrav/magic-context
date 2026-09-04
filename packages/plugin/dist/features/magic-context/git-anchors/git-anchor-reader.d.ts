/**
 * Capture durable multi-representation Git anchors from a repository.
 *
 * One capture resolves a commitish to its full commit OID, tree OID, stable
 * patch ID, and changed-path list — the raw evidence forms persisted by
 * `storage-git-anchors.ts`. All git invocations run without a shell with
 * explicit argument arrays and timeouts, following the
 * `git-commits/git-log-reader.ts` process-safety conventions; metadata
 * commands buffer bounded output via `execFile`, and the patch-id derivation
 * pipes `diff-tree` into `patch-id` child-to-child so patch bytes never
 * enter this process.
 *
 * Merge commits deliberately get no patch ID: `git patch-id` over a merge
 * diff is not a stable equivalence class, so merge patch equivalence is
 * deferred by contract. Merge changed paths come from the first-parent diff.
 */
/** Versioned protocol tag for `git patch-id --stable` derived identities. */
export declare const GIT_PATCH_ID_STABLE_PROTOCOL = "git-patch-id-stable-v1";
export interface GitAnchorCapture {
    commitOid: string;
    objectFormat: "sha1" | "sha256";
    treeOid: string;
    /** Null for merge commits (and empty diffs), never abbreviated. */
    stablePatchId: string | null;
    patchIdProtocol: string;
    changedPaths: string[];
    isMerge: boolean;
}
export type GitAnchorCaptureResult = {
    status: "captured";
    capture: GitAnchorCapture;
} | {
    status: "unavailable";
    reason: string;
};
/**
 * Capture anchor representations for `commitish` (default `HEAD`) in
 * `repoRoot`. Never throws for environmental failures: a missing git binary,
 * a non-repo directory, an invalid revision, a timeout, or malformed output
 * all return `{ status: "unavailable", reason }`.
 */
export declare function captureGitAnchor(repoRoot: string, commitish?: string): Promise<GitAnchorCaptureResult>;
//# sourceMappingURL=git-anchor-reader.d.ts.map