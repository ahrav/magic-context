/**
 * Capture durable multi-representation Git anchors from a repository.
 *
 * One capture resolves a commitish to its full commit OID, tree OID, stable
 * patch ID, and changed-path list — the raw evidence forms persisted by
 * `storage-git-anchors.ts`. All git invocations use `execFile` (no shell)
 * with explicit argument arrays, timeouts, and bounded buffers, following
 * the `git-commits/git-log-reader.ts` process-safety conventions.
 *
 * Merge commits deliberately get no patch ID: `git patch-id` over a merge
 * diff is not a stable equivalence class, so merge patch equivalence is
 * deferred by contract. Merge changed paths come from the first-parent diff.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
// Patch text for a single commit can be large; cap it rather than stream.
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Versioned protocol tag for `git patch-id --stable` derived identities. */
export const GIT_PATCH_ID_STABLE_PROTOCOL = "git-patch-id-stable-v1";

const FULL_OID_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

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

export type GitAnchorCaptureResult =
    | { status: "captured"; capture: GitAnchorCapture }
    | { status: "unavailable"; reason: string };

async function runGit(repoRoot: string, args: string[], input?: string): Promise<string> {
    const promise = execFileAsync("git", args, {
        cwd: repoRoot,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
    });
    if (input !== undefined) {
        promise.child.stdin?.on("error", () => {});
        promise.child.stdin?.end(input);
    }
    const { stdout } = await promise;
    return stdout;
}

/**
 * Capture anchor representations for `commitish` (default `HEAD`) in
 * `repoRoot`. Never throws for environmental failures: a missing git binary,
 * a non-repo directory, an invalid revision, a timeout, or malformed output
 * all return `{ status: "unavailable", reason }`.
 */
export async function captureGitAnchor(
    repoRoot: string,
    commitish = "HEAD",
): Promise<GitAnchorCaptureResult> {
    // A leading "-" would be parsed as a git OPTION, not a revision; refuse
    // before spawning (same argument-injection guard as git-log-reader).
    if (commitish.startsWith("-")) {
        return {
            status: "unavailable",
            reason: `refusing commitish that looks like an option: "${commitish}"`,
        };
    }
    try {
        const revParseOut = await runGit(repoRoot, [
            "rev-parse",
            "--verify",
            `${commitish}^{commit}`,
        ]);
        const commitOid = revParseOut.trim();
        if (!FULL_OID_PATTERN.test(commitOid)) {
            return {
                status: "unavailable",
                reason: `rev-parse returned a non-OID: "${commitOid.slice(0, 80)}"`,
            };
        }
        const objectFormat = commitOid.length === 64 ? "sha256" : "sha1";

        const metaOut = await runGit(repoRoot, ["log", "-1", "--format=%T%x1f%P", commitOid]);
        const metaLine = metaOut.trim();
        const [treeOid = "", parentField = ""] = metaLine.split("\x1f");
        if (!FULL_OID_PATTERN.test(treeOid)) {
            return {
                status: "unavailable",
                reason: `malformed tree OID for ${commitOid.slice(0, 12)}`,
            };
        }
        const parents = parentField.split(" ").filter((parent) => parent.length > 0);
        const isMerge = parents.length >= 2;

        // NUL-delimited so paths containing spaces, tabs, or newlines
        // round-trip without delimiter ambiguity. Merges diff against the
        // first parent; diff-tree would otherwise print nothing for them.
        const diffTreeArgs = isMerge
            ? ["diff-tree", "-r", "--no-commit-id", "-z", "--name-only", parents[0], commitOid]
            : ["diff-tree", "-r", "--root", "--no-commit-id", "-z", "--name-only", commitOid];
        const pathsRaw = await runGit(repoRoot, diffTreeArgs);
        const changedPaths = pathsRaw.split("\0").filter((path) => path.length > 0);

        let stablePatchId: string | null = null;
        if (!isMerge) {
            const patchText = await runGit(repoRoot, ["diff-tree", "-p", "--root", commitOid]);
            if (patchText.length > 0) {
                const patchIdOut = await runGit(repoRoot, ["patch-id", "--stable"], patchText);
                const firstField = patchIdOut.trim().split(/\s+/)[0] ?? "";
                if (firstField.length > 0) {
                    if (!/^[0-9a-f]+$/.test(firstField)) {
                        return {
                            status: "unavailable",
                            reason: `malformed patch-id output: "${firstField.slice(0, 80)}"`,
                        };
                    }
                    stablePatchId = firstField;
                }
            }
        }

        return {
            status: "captured",
            capture: {
                commitOid,
                objectFormat,
                treeOid,
                stablePatchId,
                patchIdProtocol: GIT_PATCH_ID_STABLE_PROTOCOL,
                changedPaths,
                isMerge,
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: "unavailable", reason: message.slice(0, 500) };
    }
}
