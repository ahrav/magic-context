/**
 *
 *
 * Parsing contract:
 *       %H = full 40-char SHA
 *       %s = subject (one line)
 *       %ae = author email
 *       %ct = committer time (seconds since epoch)
 *       %b = body (multi-line)
 * Fields use US (0x1f); records use RS (0x1e).
 * Avoid NUL separators because `execFile` rejects argv elements containing embedded NUL bytes.
 * Reject commits whose fields contain US or RS.
 *   - Subject + trimmed body combine into the searchable message.
 * Skip merge commits with `--no-merges` so merge-subject noise does not fill the index.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../../../shared/logger";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
/** Cap each invocation at 5000 commits.
 * */
const DEFAULT_MAX_COMMITS = 5000;
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

/**
 * retry cadence.
 */
export type GitLogFailureKind = "not_a_repo" | "no_head" | "transient";

export function classifyGitLogFailure(message: string): GitLogFailureKind {
    if (message.includes("not a git repository")) return "not_a_repo";
    if (
        message.includes("unknown revision or path not in the working tree") ||
        message.includes("does not have any commits yet") ||
        message.includes("bad revision")
    ) {
        return "no_head";
    }
    return "transient";
}

export interface GitCommit {
    /** `sha` is the full 40-character SHA. */
    sha: string;
    /** `shortSha` contains the first seven SHA characters for display. */
    shortSha: string;
    /** `message` joins the subject and body with a blank line when the body exists. */
    message: string;
    /** `author` is null when Git does not provide an author email. */
    author: string | null;
    /** `committedAtMs` is the committer time in milliseconds since the epoch. */
    committedAtMs: number;
}

export interface ReadGitCommitsOptions {
    /** `sinceMs` excludes commits at or before its millisecond epoch value. */
    sinceMs?: number;
    /** `branch` defaults to `HEAD` and includes only commits reachable from it. */
    branch?: string;
    /** `maxCommits` defaults to 5000 and caps returned commits. */
    maxCommits?: number;
    /**
     * Use `projectIdentity` only for log correlation; never log the absolute `directory` path because it exposes usernames and project names in `doctor --issue` reports.
     * When `projectIdentity` is omitted, logs use `<project>`.
     * "<project>" placeholder.
     */
    projectIdentity?: string;
}

/**
 * `readGitCommits` logs and returns an empty array when Git is unavailable or `directory` is not a repository.
 * `readGitCommits` logs and returns an empty array when Git exits nonzero.
 * `readGitCommits` never throws, so indexing failures do not crash the plugin.
 */
export async function readGitCommits(
    directory: string,
    options: ReadGitCommitsOptions = {},
): Promise<GitCommit[]> {
    return (await readGitCommitsResult(directory, options)).commits;
}

/**
 * `failure` distinguishes non-indexable directories from transient errors.
 * `failure` is null when the read succeeds, including when no commits match.
 */
export async function readGitCommitsResult(
    directory: string,
    options: ReadGitCommitsOptions = {},
): Promise<{ commits: GitCommit[]; failure: GitLogFailureKind | null }> {
    // `branch` values beginning with `-` are parsed as Git options rather than revisions.
    // `execFile` does not invoke a shell, so only Git option injection is possible.
    // `--` cannot separate revisions because Git treats every following argument as a pathspec.
    const revision = options.branch ?? "HEAD";
    if (revision.startsWith("-")) {
        throw new Error(
            `readGitCommits: refusing revision that looks like an option: "${revision}"`,
        );
    }
    const projectLabel = options.projectIdentity ?? "<project>";
    const args = [
        "log",
        revision,
        "--no-merges",
        `--max-count=${options.maxCommits ?? DEFAULT_MAX_COMMITS}`,
        `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%ct${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`,
    ];
    if (options.sinceMs !== undefined && options.sinceMs > 0) {
        // git accepts ISO 8601 to --since
        const iso = new Date(options.sinceMs).toISOString();
        args.push(`--since=${iso}`);
    }

    let stdout: string;
    try {
        const result = await execFileAsync("git", args, {
            cwd: directory,
            timeout: GIT_TIMEOUT_MS,
            // Large repositories can produce log output above the 1 MB default.
            maxBuffer: 32 * 1024 * 1024,
            encoding: "utf8",
        });
        stdout = result.stdout;
    } catch (error) {
        // Git may be unavailable, and `directory` may not be a repository.
        // A Git timeout returns an empty commit list.
        // Failure logs distinguish Git command failures from an empty history.
        const message = error instanceof Error ? error.message : String(error);
        const failure = classifyGitLogFailure(message);
        if (failure === "transient") {
            log(
                `[git-commits] readGitCommits failed for ${projectLabel}: ${message.slice(0, 500)}`,
            );
        } else {
            // Non-transient failures log their classification instead of Git's error message.
            log(`[git-commits] ${projectLabel} is not indexable (${failure})`);
        }
        return { commits: [], failure };
    }

    if (stdout.trim().length === 0) {
        log(
            `[git-commits] readGitCommits returned empty stdout for ${projectLabel} (sinceMs=${options.sinceMs ?? "none"} args=${args.slice(0, 4).join(" ")})`,
        );
    }

    return { commits: parseGitLogOutput(stdout), failure: null };
}

export function parseGitLogOutput(stdout: string): GitCommit[] {
    const commits: GitCommit[] = [];
    const records = stdout.split(RECORD_SEPARATOR);

    for (const rawRecord of records) {
        const record = rawRecord.replace(/^\s+/, "");
        if (!record) continue;

        // The parser splits only the first four `FIELD_SEPARATOR` occurrences to preserve separators in the commit body.
        const fields: string[] = [];
        let remaining = record;
        for (let i = 0; i < 4; i++) {
            const idx = remaining.indexOf(FIELD_SEPARATOR);
            if (idx < 0) break;
            fields.push(remaining.slice(0, idx));
            remaining = remaining.slice(idx + FIELD_SEPARATOR.length);
        }
        fields.push(remaining); // the body (may contain further \x1f bytes)
        if (fields.length < 5) continue;

        const sha = fields[0].trim();
        const subject = fields[1].trim();
        const author = fields[2].trim();
        const timeSec = Number.parseInt(fields[3].trim(), 10);
        const body = fields[4].trim();

        if (sha.length !== 40 || !Number.isFinite(timeSec) || timeSec <= 0) {
            continue;
        }

        const message = body.length > 0 ? `${subject}\n\n${body}` : subject;

        commits.push({
            sha,
            shortSha: sha.slice(0, 7),
            message,
            author: author.length > 0 ? author : null,
            committedAtMs: timeSec * 1000,
        });
    }

    return commits;
}
