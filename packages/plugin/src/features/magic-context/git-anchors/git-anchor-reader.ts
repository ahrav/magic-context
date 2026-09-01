/**
 *
 *
 * Merge commits have no patch ID because merge diffs lack a stable patch-id equivalence class; changed paths use the first-parent diff.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
// GIT_MAX_BUFFER bounds OID and changed-path output; patch bytes stream directly between child processes.
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
// `git patch-id` emits one "<patch-id> <commit-id>" line per patch.
const PATCH_ID_OUTPUT_MAX_BYTES = 64 * 1024;

/** GIT_PATCH_ID_STABLE_PROTOCOL versions identities derived by `git patch-id --stable`. */
export const GIT_PATCH_ID_STABLE_PROTOCOL = "git-patch-id-stable-v1";

const FULL_OID_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export interface GitAnchorCapture {
    commitOid: string;
    objectFormat: "sha1" | "sha256";
    treeOid: string;
    /** stablePatchId is null for merge commits and empty diffs and is never abbreviated. */
    stablePatchId: string | null;
    patchIdProtocol: string;
    changedPaths: string[];
    isMerge: boolean;
}

export type GitAnchorCaptureResult =
    | { status: "captured"; capture: GitAnchorCapture }
    | { status: "unavailable"; reason: string };

async function runGit(repoRoot: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
        cwd: repoRoot,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
    });
    return stdout;
}

/**
 * runPatchIdPipeline pipes `diff-tree` directly to `patch-id` so patch bytes neither buffer nor undergo UTF-8 conversion.
 * runPatchIdPipeline resolves to an empty string when the commit has an empty diff.
 */
function runPatchIdPipeline(repoRoot: string, commitOid: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const options = {
            cwd: repoRoot,
            timeout: GIT_TIMEOUT_MS,
        };
        const diffTree = spawn("git", ["diff-tree", "-p", "--root", commitOid], {
            ...options,
            stdio: ["ignore", "pipe", "ignore"],
        });
        const patchId = spawn("git", ["patch-id", "--stable"], {
            ...options,
            stdio: ["pipe", "pipe", "ignore"],
        });
        let settled = false;
        const fail = (reason: string): void => {
            if (settled) return;
            settled = true;
            diffTree.kill();
            patchId.kill();
            reject(new Error(reason));
        };
        // patchId.stdin ignores EPIPE because `patch-id` can exit before `diff-tree` finishes writing.
        patchId.stdin.on("error", () => {});
        diffTree.stdout.pipe(patchId.stdin);
        diffTree.on("error", (error) => fail(`git diff-tree failed to spawn: ${error.message}`));
        patchId.on("error", (error) => fail(`git patch-id failed to spawn: ${error.message}`));
        let out = "";
        patchId.stdout.setEncoding("utf8");
        patchId.stdout.on("data", (chunk: string) => {
            out += chunk;
            if (out.length > PATCH_ID_OUTPUT_MAX_BYTES) {
                fail("git patch-id output exceeded bound");
            }
        });
        // runPatchIdPipeline succeeds only when both child processes exit cleanly; output from a truncated `diff-tree` stream is invalid.
        let pendingCloses = 2;
        const onClose =
            (name: string) =>
            (code: number | null, signal: NodeJS.Signals | null): void => {
                if (code !== 0) {
                    fail(`git ${name} exited with ${signal ?? code}`);
                    return;
                }
                pendingCloses -= 1;
                if (pendingCloses === 0 && !settled) {
                    settled = true;
                    resolve(out);
                }
            };
        diffTree.on("close", onClose("diff-tree"));
        patchId.on("close", onClose("patch-id"));
    });
}

/**
 * The capture returns `{ status: "unavailable", reason }` instead of throwing when Git is unavailable, the repository or revision is invalid, execution times out, or output is malformed.
 */
export async function captureGitAnchor(
    repoRoot: string,
    commitish = "HEAD",
): Promise<GitAnchorCaptureResult> {
    // A leading "-" is parsed as a Git option rather than a revision, so reject it before spawning.
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

        // The code disables `log.showSignature` because signature text breaks the `\x1f` metadata split.
        // The code disables `log.showSignature` because signature text breaks the `\x1f` metadata split.
        const metaOut = await runGit(repoRoot, [
            "log",
            "-1",
            "--no-show-signature",
            "--format=%T%x1f%P",
            commitOid,
        ]);
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

        // NUL delimiters preserve paths containing spaces, tabs, or newlines.
        // NUL delimiters preserve paths containing spaces, tabs, or newlines.
        // Merge commits use the first parent because `diff-tree` would otherwise print no paths.
        const diffTreeArgs = isMerge
            ? ["diff-tree", "-r", "--no-commit-id", "-z", "--name-only", parents[0], commitOid]
            : ["diff-tree", "-r", "--root", "--no-commit-id", "-z", "--name-only", commitOid];
        const pathsRaw = await runGit(repoRoot, diffTreeArgs);
        const changedPaths = pathsRaw.split("\0").filter((path) => path.length > 0);

        let stablePatchId: string | null = null;
        if (!isMerge) {
            // An empty diff (e.g. an empty commit) produces no patch-id
            // stablePatchId stays null for empty diffs.
            const patchIdOut = await runPatchIdPipeline(repoRoot, commitOid);
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
