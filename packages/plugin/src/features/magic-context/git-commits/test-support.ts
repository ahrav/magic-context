/**
 * Shared fixtures for git-commit indexing tests.
 */

import type { GitCommit } from "./git-log-reader";

/** Deterministic commit whose sha is the seed repeated to 40 chars. */
export function makeSeededGitCommit(shaSeed: string, committedAtMs: number): GitCommit {
    const sha = shaSeed.padEnd(40, shaSeed);
    return {
        sha,
        shortSha: sha.slice(0, 7),
        message: `commit ${shaSeed}`,
        author: "dev@example.com",
        committedAtMs,
    };
}
