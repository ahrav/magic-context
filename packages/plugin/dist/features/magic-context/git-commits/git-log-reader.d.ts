/**
 * Read git commit history from a working directory using `git log`.
 *
 * Wraps a single `git log` invocation with controlled flags and parses the
 * delimited output. Runs synchronously with a timeout guard — indexing
 * happens on a plugin timer, not on the hot transform path, so blocking for
 * a few hundred milliseconds once per refresh is acceptable.
 *
 * Parsing contract:
 *   - We request `--format=%H%x1f%s%x1f%ae%x1f%ct%x1f%b%x1e`:
 *       %H = full 40-char SHA
 *       %s = subject (one line)
 *       %ae = author email
 *       %ct = committer time (seconds since epoch)
 *       %b = body (multi-line)
 *     Fields are separated by US (0x1f, ASCII Unit Separator), records by RS
 *     (0x1e, ASCII Record Separator). We deliberately AVOID NUL (0x00) here:
 *     Node's `child_process.execFile` validation rejects argv elements that
 *     contain embedded NUL bytes ("must be a string without null bytes"),
 *     even when the underlying program (git) would happily accept them via
 *     other entry points. Bun's execFile is more permissive, which masked
 *     this in unit tests until live OpenCode runtime exposed it. US/RS
 *     never appear naturally in commit subjects, emails, or bodies.
 *   - Subject + trimmed body combine into the searchable message.
 *   - We skip merge commits via `--no-merges` so merge "Merge branch 'x'"
 *     noise doesn't fill the index.
 */
/**
 * Why `git log` produced no commits, when it failed. `not_a_repo` and
 * `no_head` (a repo with zero commits) are structural: retrying every sweep
 * tick cannot succeed and only floods the log, so callers put the project on
 * a long re-probe cooldown instead. `transient` covers everything else
 * (timeouts, missing git binary, permission errors) and keeps the normal
 * retry cadence.
 */
export type GitLogFailureKind = "not_a_repo" | "no_head" | "transient";
export declare function classifyGitLogFailure(message: string): GitLogFailureKind;
export interface GitCommit {
    /** Full 40-char SHA. */
    sha: string;
    /** First 7 chars of SHA for display. */
    shortSha: string;
    /** Subject + body, joined with a blank line when body exists. */
    message: string;
    /** Author email, or null when unavailable. */
    author: string | null;
    /** Committer time in milliseconds since epoch. */
    committedAtMs: number;
}
export interface ReadGitCommitsOptions {
    /** Only include commits newer than this (milliseconds since epoch). */
    sinceMs?: number;
    /** Only include commits reachable from HEAD (the default). */
    branch?: string;
    /** Hard cap on returned commits. Default 5000. */
    maxCommits?: number;
    /**
     * Project identity (`git:<sha>` / `dir:<hash>`) used ONLY for log
     * correlation. We never log the absolute `directory` — it carries the
     * username + project name (privacy, and these logs flow into
     * `doctor --issue` reports). When omitted, logs fall back to a neutral
     * "<project>" placeholder.
     */
    projectIdentity?: string;
}
/**
 * Read commits reachable from HEAD (or `branch` when provided) up to
 * `maxCommits`, optionally filtered by `sinceMs`. Returns an empty array
 * when git is unavailable or the directory is not a repo. Does NOT throw
 * on non-zero git exit — logs and returns empty so indexing failures
 * never crash the plugin.
 */
export declare function readGitCommits(directory: string, options?: ReadGitCommitsOptions): Promise<GitCommit[]>;
/**
 * Like {@link readGitCommits}, but also reports WHY the read failed so the
 * sweep can distinguish structurally non-indexable directories (not a repo,
 * repo with no commits) from transient errors. `failure` is null on success —
 * including a successful read that matched zero commits.
 */
export declare function readGitCommitsResult(directory: string, options?: ReadGitCommitsOptions): Promise<{
    commits: GitCommit[];
    failure: GitLogFailureKind | null;
}>;
export declare function parseGitLogOutput(stdout: string): GitCommit[];
//# sourceMappingURL=git-log-reader.d.ts.map