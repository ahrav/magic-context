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

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
// Bounded metadata output (OIDs, changed paths); patch bytes never buffer here.
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
// `git patch-id` emits one "<patch-id> <commit-id>" line per patch.
const PATCH_ID_OUTPUT_MAX_BYTES = 64 * 1024;

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
 * `git diff-tree -p --root <oid> | git patch-id --stable` with the patch
 * bytes piped child-to-child: the full patch never enters this process (no
 * O(patch-size) buffering and no lossy UTF-8 round-trip that could perturb
 * the derived identity); only the one-line patch-id output is collected.
 * Resolves to that output — empty when the commit has an empty diff.
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
        // patch-id can exit before diff-tree finishes writing; EPIPE on the
        // pipe must not crash the process.
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
        // Success requires BOTH clean exits: patch-id output derived from a
        // truncated diff-tree stream must not be trusted.
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
            // An empty diff (e.g. an empty commit) produces no patch-id
            // output; stablePatchId stays null by contract.
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
