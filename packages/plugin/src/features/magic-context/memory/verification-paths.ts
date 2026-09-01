import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

interface VerificationPathsExecOptions {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    encoding: BufferEncoding;
}

type VerificationPathsExecResult = {
    stdout: string | Buffer;
    stderr: string | Buffer;
};

type VerificationPathsExecFile = (
    file: string,
    args: readonly string[],
    options: VerificationPathsExecOptions,
) => Promise<VerificationPathsExecResult>;

const defaultExecFileForVerificationPaths: VerificationPathsExecFile = async (
    file,
    args,
    options,
) => (await execFileAsync(file, [...args], options)) as VerificationPathsExecResult;

let execFileForVerificationPaths = defaultExecFileForVerificationPaths;

export interface NormalizedVerificationFiles {
    files: string[];
    warnings: string[];
    gitRoot: string | null;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string | null> {
    try {
        const result = await execFileForVerificationPaths("git", args, {
            cwd,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            encoding: "utf8",
        });
        return String(result.stdout);
    } catch {
        return null;
    }
}

function toPosixPath(value: string): string {
    return value.split(path.sep).join("/");
}

/**
 * */
export function isWithin(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * enforcement-artifact canonicalizer. */
export function safeRealpath(value: string): string | null {
    try {
        return realpathSync.native(value);
    } catch {
        return null;
    }
}

/**
 * Use `sha256FileStreaming` when synchronous whole-file reads would block the event loop. */
export function sha256FileSync(absolutePath: string): string {
    return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

/** Streaming yields between chunks instead of retaining the entire file in one buffer.
 * `sha256FileStreaming` produces the same digest as `sha256FileSync`. */
export async function sha256FileStreaming(absolutePath: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) {
        hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
}

export async function resolveGitTopLevel(cwd: string): Promise<string | null> {
    const stdout = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const root = stdout?.trim();
    return root ? (safeRealpath(root) ?? path.resolve(root)) : null;
}

export async function readGitHead(cwd: string): Promise<string | null> {
    const stdout = await runGit(cwd, ["rev-parse", "HEAD"]);
    const head = stdout?.trim();
    return head && /^[0-9a-f]{40}$/i.test(head) ? head : null;
}

export async function readGitChangedFilesSince(
    cwd: string,
    revision: string,
): Promise<Set<string> | null> {
    if (!/^[0-9a-f]{7,40}$/i.test(revision)) return null;
    const gitRoot = await resolveGitTopLevel(cwd);
    if (!gitRoot) return null;
    const stdout = await runGit(gitRoot, ["diff", "--name-only", "-z", revision]);
    if (stdout === null) return null;
    return new Set(stdout.split("\0").filter(Boolean));
}

/**
 * Maps files in commits newer than `sinceSec` to their newest commit timestamp in milliseconds.
 *
 * Returns `null` when Git resolution or history lookup fails.
 * Git history excludes working-tree changes.
 */
export async function readGitFileChangeTimesSince(
    cwd: string,
    sinceMs: number,
): Promise<Map<string, number> | null> {
    const gitRoot = await resolveGitTopLevel(cwd);
    if (!gitRoot) return null;
    const sinceSec = Math.max(0, Math.floor(sinceMs / 1000));
    // The git-log output encodes each commit as its committer timestamp followed by its changed files.
    // `--name-only` lists each commit's changed files.
    // The map retains the first timestamp seen for each file because git log returns commits newest first.
    const stdout = await runGit(gitRoot, [
        "log",
        `--since=@${sinceSec}`,
        "--name-only",
        "--format=%ct",
    ]);
    if (stdout === null) return null;
    const times = new Map<string, number>();
    let currentMs = 0;
    for (const rawLine of stdout.split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        if (/^\d+$/.test(line)) {
            currentMs = Number.parseInt(line, 10) * 1000;
            continue;
        }
        // Each path belongs to the current commit.
        if (currentMs > 0 && !times.has(line)) {
            times.set(line, currentMs);
        }
    }
    return times;
}

async function gitTrackedPath(gitRoot: string, repoRelativePath: string): Promise<string | null> {
    const stdout = await runGit(gitRoot, [
        "ls-files",
        "-z",
        "--full-name",
        "--error-unmatch",
        "--",
        repoRelativePath,
    ]);
    const fallbackStdout =
        stdout === null ? await runGit(gitRoot, ["ls-files", "-z", "--full-name"]) : null;
    if (stdout === null && fallbackStdout === null) return null;
    const matches = (stdout ?? fallbackStdout ?? "").split("\0").filter(Boolean);
    if (matches.length === 0) return null;
    return (
        matches.find((match) => match === repoRelativePath) ??
        matches.find((match) => match.toLowerCase() === repoRelativePath.toLowerCase()) ??
        (matches.length === 1 ? matches[0] : null)
    );
}

export function verificationFileExists(baseRoot: string, filePath: string): boolean {
    if (!filePath || filePath === ".") return false;
    const root = path.resolve(baseRoot);
    const candidate = path.resolve(root, filePath);
    return isWithin(root, candidate) && existsSync(candidate);
}

/**
 */
export async function normalizeVerificationFiles(args: {
    cwd: string;
    files: readonly string[];
}): Promise<NormalizedVerificationFiles> {
    const cwd = path.resolve(args.cwd);
    const gitRoot = await resolveGitTopLevel(cwd);
    const root = gitRoot ?? cwd;
    const rootReal = safeRealpath(root) ?? root;
    const warnings: string[] = [];
    const normalized: string[] = [];

    for (const raw of args.files) {
        const value = typeof raw === "string" ? raw.trim() : "";
        if (!value) {
            warnings.push("Skipped blank verification path.");
            continue;
        }
        if (value === ".") {
            warnings.push('Skipped verification path "." (repo/project root is not a file).');
            continue;
        }

        const candidate = path.resolve(cwd, value);
        const candidateReal = safeRealpath(candidate);
        if (candidateReal && !isWithin(rootReal, candidateReal)) {
            warnings.push(
                `Skipped verification path "${value}" because it resolves outside the project.`,
            );
            continue;
        }
        if (!candidateReal && !isWithin(path.resolve(root), candidate)) {
            warnings.push(`Skipped verification path "${value}" because it escapes the project.`);
            continue;
        }
        if (path.resolve(root) === candidate) {
            warnings.push(
                `Skipped verification path "${value}" because it is the repo/project root.`,
            );
            continue;
        }
        if (existsSync(candidate)) {
            try {
                if (statSync(candidate).isDirectory()) {
                    warnings.push(
                        `Skipped verification path "${value}" because it is a directory.`,
                    );
                    continue;
                }
            } catch {
                warnings.push(
                    `Skipped verification path "${value}" because it could not be inspected.`,
                );
                continue;
            }
        }

        if (gitRoot) {
            const repoRelative = toPosixPath(path.relative(gitRoot, candidateReal ?? candidate));
            if (!repoRelative || repoRelative === "." || repoRelative.startsWith("../")) {
                warnings.push(
                    `Skipped verification path "${value}" because it is not inside the git repo.`,
                );
                continue;
            }
            const tracked = await gitTrackedPath(gitRoot, repoRelative);
            if (!tracked) {
                warnings.push(
                    `Skipped verification path "${value}" because it is not a tracked git file.`,
                );
                continue;
            }
            if (candidateReal && tracked !== repoRelative) {
                const realRelative = toPosixPath(path.relative(gitRoot, candidateReal));
                if (realRelative !== tracked) {
                    warnings.push(
                        `Skipped verification path "${value}" because it is not a tracked git file.`,
                    );
                    continue;
                }
            }
            normalized.push(tracked);
        } else {
            if (!existsSync(candidate)) {
                warnings.push(`Skipped verification path "${value}" because it does not exist.`);
                continue;
            }
            const projectRelative = toPosixPath(path.relative(cwd, candidate));
            if (!projectRelative || projectRelative === "." || projectRelative.startsWith("../")) {
                warnings.push(
                    `Skipped verification path "${value}" because it is not inside the project.`,
                );
                continue;
            }
            normalized.push(projectRelative);
        }
    }

    return {
        files: Array.from(new Set(normalized)).sort(),
        warnings,
        gitRoot,
    };
}

export function __setVerificationPathsTestHooks(hooks: {
    execFile?: VerificationPathsExecFile;
}): void {
    execFileForVerificationPaths = hooks.execFile ?? defaultExecFileForVerificationPaths;
}

export function __resetVerificationPathsForTests(): void {
    execFileForVerificationPaths = defaultExecFileForVerificationPaths;
}
