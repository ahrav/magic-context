/**
 *
 * Strategy:
 * `resolveProjectIdentity()` uses the root commit hash for Git repositories with commits; repositories that retain the same root commit share it.
 * `resolveProjectIdentity()` uses a directory hash for empty Git repositories.
 * `resolveProjectIdentity()` uses a directory hash for non-Git directories.
 *
 * The root commit hash is independent of remotes and URLs; repositories that retain the same root commit share it.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { log } from "../../../shared/logger";

// The resolver caches successful Git identities to avoid repeated synchronous probes.
// The cooldown prevents repeated failed Git probes.
const GIT_TIMEOUT_MS = 5_000;
const TRANSIENT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const identityCache = new Map<string, string>();
const linkedGitWorktreeCache = new Map<string, boolean>();
const lastKnownGitIdentityCache = new Map<string, string>();
// `directoryFallbackCache` stores `dir:` fallbacks only when no ancestor has a `.git` entry.
// Resolution bypasses `directoryFallbackCache` when an ancestor has a `.git` entry.
// A `.git` entry bypasses cached directory identities so Git resolution can replace them.
// Re-resolving prevents project state from splitting when the first commit is created.
// Git repositories use `identityCache` or the transient-failure cooldown instead of `directoryFallbackCache`.
const directoryFallbackCache = new Map<string, string>();
// The cooldown suppresses repeated Git probes after transient failures.
// During `transientFailureCooldown`, resolution reuses a process-local successful `git:` identity when available.
// Cold-start `git_missing`, `git_timeout`, `dubious_ownership`, and `unknown` failures use the deterministic `dir:` fallback.
// After cooldown expiry, the next call re-probes Git.
// Cooldown expiry allows recovery after Git or disk failures.
const transientFailureCooldown = new Map<string, number>();
const dubiousOwnershipFallbackDirectories = new Set<string>();
const dubiousOwnershipLoggedDirectories = new Set<string>();
const dubiousOwnershipWarnedDirectories = new Set<string>();
const transientGitIdentityReuseLoggedDirectories = new Set<string>();
let execFileSyncForIdentity: typeof execFileSync = execFileSync;
let userHomeDirectoryForIdentity = (): string => homedir();
let nowMs = (): number => Date.now();

/**
 * Project identity failures use stable machine-readable classifications.
 *
 * Caller policy:
 * `not_git_repo` permits a `dir:<md5-12>` fallback for an accessible directory without a Git root commit.
 * `git_missing`, `git_timeout`, `dubious_ownership`, and `unknown` failures use a directory fallback with a five-minute retry cooldown.
 * Git recovery replaces the temporary directory identity.
 *   recovers.
 * `permission_denied` does not fall back during normal resolution because an unreadable directory may not be the intended path.
 */
export type ProjectIdentityErrorClass =
    | "not_git_repo"
    | "git_missing"
    | "git_timeout"
    | "dubious_ownership"
    | "permission_denied"
    | "unknown";

/**
 * ProjectIdentityError exposes a stable, machine-readable errorClass.
 */
export class ProjectIdentityError extends Error {
    readonly errorClass: ProjectIdentityErrorClass;
    readonly rawDirectory: string;

    constructor(
        errorClass: ProjectIdentityErrorClass,
        rawDirectory: string,
        message: string,
        cause?: Error,
    ) {
        super(message);
        this.name = "ProjectIdentityError";
        this.errorClass = errorClass;
        this.rawDirectory = rawDirectory;
        if (cause) {
            this.cause = cause;
        }
    }
}

function asError(error: unknown): Error | undefined {
    return error instanceof Error ? error : undefined;
}

function getErrorCode(error: unknown): string | undefined {
    if (error === null || typeof error !== "object" || !("code" in error)) {
        return undefined;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}

function getErrorSignal(error: unknown): string | undefined {
    if (error === null || typeof error !== "object" || !("signal" in error)) {
        return undefined;
    }
    const signal = (error as { signal?: unknown }).signal;
    return typeof signal === "string" ? signal : undefined;
}

function getErrorKilled(error: unknown): boolean {
    if (error === null || typeof error !== "object" || !("killed" in error)) {
        return false;
    }
    return (error as { killed?: unknown }).killed === true;
}

function getErrorStderr(error: unknown): string {
    if (error === null || typeof error !== "object" || !("stderr" in error)) {
        return "";
    }
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") {
        return stderr;
    }
    if (Buffer.isBuffer(stderr)) {
        return stderr.toString("utf8");
    }
    return "";
}

function directoryFallback(directory: string): string {
    // The fallback hashes the full canonical path to distinguish directories with identical basenames.
    const canonical = path.resolve(directory);
    const hash = createHash("md5").update(canonical, "utf8").digest("hex").slice(0, 12);
    return `dir:${hash}`;
}

function assertDirectoryUsable(canonicalDirectory: string, rawDirectory: string): void {
    try {
        const stat = statSync(canonicalDirectory);
        if (!stat.isDirectory()) {
            throw new ProjectIdentityError(
                "unknown",
                rawDirectory,
                `Project path is not a directory: ${canonicalDirectory}`,
            );
        }
    } catch (error) {
        if (error instanceof ProjectIdentityError) {
            throw error;
        }

        const code = getErrorCode(error);
        if (code === "EACCES" || code === "EPERM") {
            throw new ProjectIdentityError(
                "permission_denied",
                rawDirectory,
                `Permission denied while accessing project directory: ${canonicalDirectory}`,
                asError(error),
            );
        }

        throw new ProjectIdentityError(
            "unknown",
            rawDirectory,
            `Unable to access project directory: ${canonicalDirectory}`,
            asError(error),
        );
    }
}

function isGitTimeoutError(error: unknown): boolean {
    const code = getErrorCode(error);
    const signal = getErrorSignal(error);
    return (
        code === "ETIMEDOUT" ||
        signal === "SIGTERM" ||
        signal === "SIGKILL" ||
        getErrorKilled(error)
    );
}

function classifyGitError(error: unknown, rawDirectory: string): ProjectIdentityError {
    if (isGitTimeoutError(error)) {
        return new ProjectIdentityError(
            "git_timeout",
            rawDirectory,
            `git rev-list timed out after ${GIT_TIMEOUT_MS}ms`,
            asError(error),
        );
    }

    const code = getErrorCode(error);
    if (code === "ENOENT") {
        return new ProjectIdentityError(
            "git_missing",
            rawDirectory,
            "git binary is not available in PATH",
            asError(error),
        );
    }
    if (code === "EACCES" || code === "EPERM") {
        return new ProjectIdentityError(
            "permission_denied",
            rawDirectory,
            "Permission denied while spawning git",
            asError(error),
        );
    }

    const stderr = getErrorStderr(error).toLowerCase();
    if (stderr.includes("detected dubious ownership")) {
        return new ProjectIdentityError(
            "dubious_ownership",
            rawDirectory,
            "git refused to read the repository because it detected dubious ownership",
            asError(error),
        );
    }
    if (
        stderr.includes("not a git repository") ||
        stderr.includes("does not have any commits yet") ||
        stderr.includes("ambiguous argument 'head'") ||
        stderr.includes("unknown revision or path")
    ) {
        return new ProjectIdentityError(
            "not_git_repo",
            rawDirectory,
            "Directory has no git root commit; caller may use directory fallback",
            asError(error),
        );
    }

    return new ProjectIdentityError(
        "unknown",
        rawDirectory,
        "git rev-list failed while resolving project identity",
        asError(error),
    );
}

/**
 *
 * `resolveProjectIdentity()` returns `git:<root-commit-sha>` or `dir:<md5-12>`, or throws `ProjectIdentityError`.
 * ProjectIdentityError exposes errorClass so callers can distinguish non-git directories from transient git or runtime failures.
 *
 * `identityCache` never stores transient failures.
 */
export function resolveProjectIdentityStrict(directory: string): string {
    const canonical = path.resolve(directory);
    const cached = identityCache.get(canonical);
    if (cached !== undefined) {
        return cached;
    }

    assertDirectoryUsable(canonical, directory);

    if (!hasGitDir(canonical)) {
        throw new ProjectIdentityError(
            "not_git_repo",
            directory,
            "Directory has no git metadata; caller may use directory fallback",
        );
    }

    let output: string;
    try {
        output = execFileSyncForIdentity("git", ["rev-list", "--max-parents=0", "HEAD"], {
            cwd: canonical,
            encoding: "utf8",
            env: { ...process.env, LC_ALL: "C", LANG: "C" },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: GIT_TIMEOUT_MS,
        }) as string;
    } catch (error) {
        throw classifyGitError(error, directory);
    }

    // Repositories with multiple root commits require deterministic root selection.
    const rootCommit = output
        .split("\n")
        .map((line) => line.trim().slice(0, 64))
        .filter((line) => /^[0-9a-f]{7,64}$/.test(line))
        .sort()[0];
    if (!rootCommit) {
        throw new ProjectIdentityError(
            "unknown",
            directory,
            "git rev-list returned no valid root commit hash",
        );
    }

    const identity = `git:${rootCommit}`;
    identityCache.set(canonical, identity);
    lastKnownGitIdentityCache.set(canonical, identity);
    transientFailureCooldown.delete(canonical);
    dubiousOwnershipFallbackDirectories.delete(canonical);
    transientGitIdentityReuseLoggedDirectories.delete(canonical);
    return identity;
}

/**
 *
 * `resolveProjectIdentity()` returns `git:<sha>` for Git repositories with at least one commit.
 * `resolveProjectIdentity()` returns `dir:<md5-12>` for accessible non-Git directories, empty repositories, and cold-start `git_missing`, `git_timeout`, `dubious_ownership`, or `unknown` failures.
 *
 * A cold-start `dir:` fallback can split project-scoped rows until Git recovers.
 * During transient failures, resolution reuses the last known `git:` identity so mid-session rows stay under one key.
 */
function shouldUseDirectoryFallback(error: ProjectIdentityError): boolean {
    return error.errorClass !== "permission_denied";
}

function getActiveCooldown(canonical: string): number | undefined {
    const until = transientFailureCooldown.get(canonical);
    if (until === undefined) return undefined;
    if (nowMs() < until) return until;
    transientFailureCooldown.delete(canonical);
    return undefined;
}

function lastKnownGitIdentity(canonical: string): string | undefined {
    return lastKnownGitIdentityCache.get(canonical) ?? identityCache.get(canonical);
}

function nearestLastKnownGitIdentity(
    canonical: string,
): { identity: string; source: string } | undefined {
    const visited = new Set<string>();
    const walk = (start: string): { identity: string; source: string } | undefined => {
        let current = start;
        while (!visited.has(current)) {
            visited.add(current);
            const cached = lastKnownGitIdentity(current);
            if (cached !== undefined) return { identity: cached, source: current };
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return undefined;
    };

    const exactOrAncestor = walk(canonical);
    if (exactOrAncestor) return exactOrAncestor;

    try {
        const realCanonical = realpathSync.native(canonical);
        if (realCanonical !== canonical) return walk(realCanonical);
    } catch {}
    return undefined;
}

function reuseLastKnownGitIdentity(canonical: string): string | undefined {
    const cached = nearestLastKnownGitIdentity(canonical);
    if (cached === undefined) return undefined;
    if (!transientGitIdentityReuseLoggedDirectories.has(canonical)) {
        transientGitIdentityReuseLoggedDirectories.add(canonical);
        const sourceNote = cached.source === canonical ? "" : ` from ancestor ${cached.source}`;
        log(
            `[magic-context] git identity resolution is temporarily unavailable for ${canonical}; reusing the last successful project identity${sourceNote} to avoid splitting project-scoped memory`,
        );
    }
    return cached.identity;
}

function formatDubiousOwnershipWarning(canonical: string): string {
    return `Magic Context: git refused to read ${canonical} (dubious ownership — the repo is owned by a different user). Using a directory-based project identity for now, which keeps memory separate from this repo's normal identity. Fix: git config --global --add safe.directory ${canonical}`;
}

function recordDubiousOwnershipFallback(canonical: string): void {
    dubiousOwnershipFallbackDirectories.add(canonical);
    if (dubiousOwnershipLoggedDirectories.has(canonical)) return;
    dubiousOwnershipLoggedDirectories.add(canonical);
    log(`[magic-context] ${formatDubiousOwnershipWarning(canonical)}`);
}

export function takeDubiousOwnershipProjectIdentityWarning(directory: string): string | null {
    const canonical = path.resolve(directory);
    if (!dubiousOwnershipFallbackDirectories.has(canonical)) return null;
    if (dubiousOwnershipWarnedDirectories.has(canonical)) return null;
    dubiousOwnershipWarnedDirectories.add(canonical);
    return formatDubiousOwnershipWarning(canonical);
}

/**
 * Filesystem-canonical paths prevent symlink aliases from creating separate directory identities.
 */
function canonicalUserHomeDirectory(): string {
    const homeDirectory = userHomeDirectoryForIdentity();
    try {
        return realpathSync.native(homeDirectory);
    } catch {
        // The fallback returns the original path so later checks can recognize projects under `$HOME`.
        return homeDirectory;
    }
}

export function isUserHomeDirectory(directory: string): boolean {
    try {
        return realpathSync.native(path.resolve(directory)) === canonicalUserHomeDirectory();
    } catch {
        return false;
    }
}

export function resolveProjectIdentity(directory: string): string {
    const canonical = path.resolve(directory);
    const cachedFallback = directoryFallbackCache.get(canonical);
    if (cachedFallback !== undefined) {
        // Fallback deletion forces re-resolution so the identity can become `git:<root>`.
        if (!hasGitDir(canonical)) {
            return cachedFallback;
        }
        directoryFallbackCache.delete(canonical);
    }

    if (getActiveCooldown(canonical) !== undefined) {
        if (hasGitDir(canonical)) {
            const cachedGitIdentity = reuseLastKnownGitIdentity(canonical);
            if (cachedGitIdentity !== undefined) {
                return cachedGitIdentity;
            }
        }
        return directoryFallback(canonical);
    }

    try {
        return resolveProjectIdentityStrict(directory);
    } catch (error) {
        if (error instanceof ProjectIdentityError && shouldUseDirectoryFallback(error)) {
            const fallback = directoryFallback(canonical);
            const hasGitMetadata = hasGitDir(canonical);
            if (!hasGitMetadata) {
                directoryFallbackCache.set(canonical, fallback);
                transientFailureCooldown.delete(canonical);
            } else {
                transientFailureCooldown.set(canonical, nowMs() + TRANSIENT_FAILURE_COOLDOWN_MS);
                const cachedGitIdentity = reuseLastKnownGitIdentity(canonical);
                if (cachedGitIdentity !== undefined) {
                    return cachedGitIdentity;
                }
            }
            if (error.errorClass === "dubious_ownership") {
                recordDubiousOwnershipFallback(canonical);
            }
            return fallback;
        }
        throw error;
    }
}

export function resolveProjectIdentityOrFallback(directory: string): string {
    try {
        return resolveProjectIdentity(directory);
    } catch (error) {
        const canonical = path.resolve(directory);
        const fallback = directoryFallback(canonical);
        const message = error instanceof Error ? error.message : String(error);
        log(
            `[magic-context] project identity resolution failed for ${canonical}; using directory fallback ${fallback}: ${message}`,
        );
        return fallback;
    }
}

/** The probe treats `.git` in `canonical` or any ancestor as Git metadata.
 * The probe treats a `.git` file as Git metadata for worktrees and submodules.
 * Filesystem misses do not prove that no ancestor contains `.git`. */
function hasGitDir(canonical: string): boolean {
    if (hasGitDirInAncestorChain(canonical)) {
        return true;
    }

    try {
        const realCanonical = realpathSync.native(canonical);
        return realCanonical !== canonical && hasGitDirInAncestorChain(realCanonical);
    } catch {
        return false;
    }
}

function gitRootInAncestorChain(startDirectory: string): string | null {
    let current = startDirectory;
    while (true) {
        if (existsSync(path.join(current, ".git"))) {
            try {
                return realpathSync.native(current);
            } catch {
                return path.resolve(current);
            }
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}

function hasGitDirInAncestorChain(startDirectory: string): boolean {
    return gitRootInAncestorChain(startDirectory) !== null;
}

function gitRootDirectory(canonical: string): string | null {
    const direct = gitRootInAncestorChain(canonical);
    if (direct) return direct;
    try {
        const realCanonical = realpathSync.native(canonical);
        return realCanonical === canonical ? null : gitRootInAncestorChain(realCanonical);
    } catch {
        return null;
    }
}

/**
 * an escape.
 */
export function resolveProjectRootDirectory(directory: string): string {
    const canonical = path.resolve(directory);
    return gitRootDirectory(canonical) ?? canonical;
}

export function resolveProjectIdentityForSession(
    directory: string,
    allowHomeProject = false,
): string | undefined {
    const canonicalHome = canonicalUserHomeDirectory();
    const canonicalDirectory = (() => {
        try {
            return realpathSync.native(path.resolve(directory));
        } catch {
            return path.resolve(directory);
        }
    })();
    const inheritsHomeRepository = gitRootDirectory(canonicalDirectory) === canonicalHome;
    if (canonicalDirectory === canonicalHome || inheritsHomeRepository) {
        if (!allowHomeProject) return undefined;
        // Sessions whose effective Git root is `$HOME` use the home identity.
        // Treating a session whose effective Git root is `$HOME` as the home identity prevents child directories from bypassing the home opt-in through `$HOME/.git`.
        return directoryFallback(canonicalHome);
    }
    return resolveProjectIdentityOrFallback(directory);
}

/**
 *
 */
export function normalizeStoredProjectPath(rawOrStored: string): string {
    if (rawOrStored.startsWith("git:") || rawOrStored.startsWith("dir:")) {
        return rawOrStored;
    }

    try {
        return resolveProjectIdentity(rawOrStored);
    } catch {
        return directoryFallback(rawOrStored);
    }
}

/**
 * A memory row may store `project_path` as a raw filesystem path or a normalized identity.
 * Normalization lets ownership checks accept both raw filesystem paths and `git:` or `dir:` identities.
 */
export function storedPathBelongsToIdentity(
    storedProjectPath: string,
    projectIdentity: string,
): boolean {
    return (
        storedProjectPath === projectIdentity ||
        normalizeStoredProjectPath(storedProjectPath) === projectIdentity
    );
}

/**
 * Worktree detection uses each linked worktree's per-worktree Git directory.
 * Linked worktrees use a per-worktree Git directory and share the primary checkout's common directory.
 * The cache uses resolved paths to avoid rerunning Git.
 */
export function isLinkedGitWorktree(directory: string): boolean {
    const resolvedDirectory = path.resolve(directory);
    const cached = linkedGitWorktreeCache.get(resolvedDirectory);
    if (cached !== undefined) return cached;

    let linked = false;
    try {
        const output = execFileSyncForIdentity(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
            {
                cwd: resolvedDirectory,
                encoding: "utf8",
                timeout: GIT_TIMEOUT_MS,
                windowsHide: true,
            },
        );
        const [gitDir, commonDir] = String(output)
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean);
        linked = Boolean(gitDir && commonDir && path.resolve(gitDir) !== path.resolve(commonDir));
    } catch {
        // The probe treats Git probe failures as linked when a Git directory exists.
        linked = hasGitDir(resolvedDirectory);
    }
    linkedGitWorktreeCache.set(resolvedDirectory, linked);
    return linked;
}

export function __setProjectIdentityTestHooks(hooks: {
    execFileSync?: typeof execFileSync;
    homeDirectory?: () => string;
    nowMs?: () => number;
}): void {
    execFileSyncForIdentity = hooks.execFileSync ?? execFileSync;
    userHomeDirectoryForIdentity = hooks.homeDirectory ?? (() => homedir());
    nowMs = hooks.nowMs ?? (() => Date.now());
}

export function __clearProjectIdentityTransientCooldownForTests(directory?: string): void {
    if (directory === undefined) {
        transientFailureCooldown.clear();
        return;
    }
    transientFailureCooldown.delete(path.resolve(directory));
}

export function __clearProjectIdentityResolutionCacheForTests(directory?: string): void {
    if (directory === undefined) {
        identityCache.clear();
        return;
    }
    identityCache.delete(path.resolve(directory));
}

export function __resetProjectIdentityForTests(): void {
    identityCache.clear();
    linkedGitWorktreeCache.clear();
    lastKnownGitIdentityCache.clear();
    directoryFallbackCache.clear();
    transientFailureCooldown.clear();
    dubiousOwnershipFallbackDirectories.clear();
    dubiousOwnershipLoggedDirectories.clear();
    dubiousOwnershipWarnedDirectories.clear();
    transientGitIdentityReuseLoggedDirectories.clear();
    execFileSyncForIdentity = execFileSync;
    userHomeDirectoryForIdentity = (): string => homedir();
    nowMs = (): number => Date.now();
}
