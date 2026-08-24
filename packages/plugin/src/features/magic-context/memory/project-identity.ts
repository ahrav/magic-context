/**
 * Resolve a stable project identity from the working directory.
 *
 * Strategy:
 *   1. Git repo with commits → root commit hash (same across worktrees, clones, forks)
 *   2. Git repo with no commits → fallback to directory hash via resolveProjectIdentity()
 *   3. No git repo → fallback to directory hash via resolveProjectIdentity()
 *
 * The root commit hash is immutable and survives remote renames, host
 * migrations, and SSH/HTTPS URL changes. It is the same across all
 * worktrees and clones of the same repository.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { log } from "../../../shared/logger";

// execFileSync is intentional here (audit #19): this runs once per unique directory per process
// lifetime when git is healthy, and successful git identities are cached in identityCache. The
// ~10-50ms block on first call is acceptable vs threading async through all callers of
// resolveProjectIdentity. Transient git failures are cooled down below so a slow/broken git probe
// cannot stall every transform pass.
const GIT_TIMEOUT_MS = 5_000;
const TRANSIENT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const identityCache = new Map<string, string>();
const linkedGitWorktreeCache = new Map<string, boolean>();
const lastKnownGitIdentityCache = new Map<string, string>();
// Cached `dir:` fallbacks for directories that have NO `.git` entry in their
// ancestor chain. We only cache the no-`.git` case: once a `.git` appears we
// must re-resolve every call so the identity flips to the stable `git:<root>`
// the moment git becomes available (otherwise project memories/state split
// across the first-commit boundary). Real git repos never reach this cache —
// they hit `identityCache` or the transient cooldown.
const directoryFallbackCache = new Map<string, string>();
// Cool down git-backed directories whose git probe failed transiently. During
// the window we reuse the last successful `git:` identity when this process has
// one; true cold-start failures still use the deterministic `dir:` fallback.
// After the cooldown expires, the next call re-probes so the cache refreshes
// when the user fixes git or the slow disk recovers.
const transientFailureCooldown = new Map<string, number>();
const dubiousOwnershipFallbackDirectories = new Set<string>();
const dubiousOwnershipLoggedDirectories = new Set<string>();
const dubiousOwnershipWarnedDirectories = new Set<string>();
const transientGitIdentityReuseLoggedDirectories = new Set<string>();
let execFileSyncForIdentity: typeof execFileSync = execFileSync;
let userHomeDirectoryForIdentity = (): string => homedir();
let nowMs = (): number => Date.now();

/**
 * Type-checked project identity failure classes (Finding #16).
 *
 * Caller policy:
 * - `not_git_repo` is deterministic: the directory is accessible but has no git root commit, so
 *   callers that preserve the production contract may fall back to `dir:<md5-12>`.
 * - `git_missing`, `git_timeout`, `dubious_ownership`, and `unknown` git failures fall back in
 *   resolveProjectIdentity() with a short retry cooldown: staying enabled with a temporary
 *   directory identity is safer than disabling Magic Context, and the identity self-heals when git
 *   recovers.
 * - `permission_denied` is not safe to silently coerce during normal resolution: an unreadable
 *   directory may not be the path the user intended. Plugin-load call sites use
 *   resolveProjectIdentityOrFallback() as a final belt so identity resolution never disables load.
 */
export type ProjectIdentityErrorClass =
    | "not_git_repo"
    | "git_missing"
    | "git_timeout"
    | "dubious_ownership"
    | "permission_denied"
    | "unknown";

/**
 * Strict project identity resolution error with stable machine-readable classification.
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
    // Use a hash of the full canonical path to avoid collisions between
    // directories with the same basename (e.g. /tmp/api vs /work/api).
    // Switched from Bun.hash to MD5 prefix when the storage layer moved off
    // bun:sqlite — see commit d03e148. This is a one-time prefix change for
    // non-git project memories: existing `dir:<wyhash>` rows become orphaned
    // and any new memories use `dir:<md5-prefix>`. Most users are git-backed
    // (unaffected). Doctor can be extended to re-key if needed.
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
 * Strictly resolve the project identity for a filesystem directory.
 *
 * Returns only `git:<root-commit-sha>` and never silently falls back. Failures are thrown as
 * `ProjectIdentityError` with a stable `errorClass` so callers can distinguish deterministic
 * non-git directories from transient git/runtime failures.
 *
 * The cache is process-local, keyed by `path.resolve(directory)`, and stores only successful git
 * identities. Transient failures are never cached.
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

    // Repos with grafted histories (merged with --allow-unrelated-histories) have
    // MULTIPLE root commits, and git's enumeration order varies by traversal. Taking
    // whichever line comes first samples nondeterministically from that set, flapping
    // the project identity between sessions and splitting the memory pool. Pin the
    // derivation to the lexicographic minimum so it is a pure function of the set.
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
 * Resolve the project identity for the given directory.
 *
 * Returns a stable string suitable for use as a database key:
 *   - `"git:<sha>"` for git repositories with at least one commit
 *   - `"dir:<md5-12>"` for accessible non-git directories, empty repos, or cold-start git-backed
 *     directories whose git probe is temporarily unavailable before any `git:` identity is known
 *
 * A cold-start `dir:` fallback can split project-scoped rows until git recovers, but that split is
 * bounded and self-heals through the backfill/reconciliation paths. After a successful git resolve,
 * transient failures reuse the last known `git:` identity so mid-session rows stay under one key.
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
    } catch {
        // If realpath fails, the path-based ancestor walk above is the only safe cache lookup.
    }
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
 * Compare filesystem-canonical paths so a symlink spelling of $HOME cannot
 * accidentally create a second directory identity. The session resolver also
 * checks descendants whose nearest git root is the home directory.
 */
function canonicalUserHomeDirectory(): string {
    const homeDirectory = userHomeDirectoryForIdentity();
    try {
        return realpathSync.native(homeDirectory);
    } catch {
        // Sandboxed OpenCode processes may know $HOME but be denied access to its
        // metadata. Returning the original path lets later checks still recognize
        // projects under the user's home directory without aborting plugin startup.
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
        // Serve the cached `dir:` fallback only while the directory still has no
        // `.git` in itself or any ancestor. If a repo appeared above a nested
        // session since we cached, drop it and re-resolve so the identity can
        // flip to the stable `git:<root>`.
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

/** Cheap probe: does `<dir>/.git` or any ancestor `.git` exist (a repo may have
 *  appeared since we cached a `dir:` fallback)? A plain file counts for worktrees
 *  and submodules. Any filesystem miss just means "keep walking". */
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
 * The directory that owns a session's project identity: the git repository
 * root when the directory sits inside one, otherwise the canonical directory
 * itself. Command surfaces that canonicalize project-relative artifact paths
 * must resolve against THIS root, not the invoking cwd — a `/cd` into a
 * subdirectory keeps the same identity (resolved through the ancestor
 * repository), so a path elsewhere in the same repository is in-project, not
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
        // A session whose effective git root is $HOME belongs to the same protected
        // home identity as an exact-home session. This prevents a child directory
        // from bypassing the opt-in by inheriting $HOME/.git.
        return directoryFallback(canonicalHome);
    }
    return resolveProjectIdentityOrFallback(directory);
}

/**
 * Normalize a stored project path or legacy raw filesystem path.
 *
 * Already-resolved `git:` / `dir:` identities are returned byte-for-byte. Raw filesystem paths are
 * resolved through the production wrapper. This helper is intentionally best-effort for existing
 * stored data: if strict resolution cannot classify the path, it falls back to the deterministic
 * `dir:<md5-12>` identity instead of throwing.
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
 * Ownership check for a memory row against the current session's resolved
 * project identity. A memory's stored `project_path` may be a raw filesystem
 * path (legacy) OR an already-normalized `git:`/`dir:` identity; either must
 * match the current identity after normalization. Used by ctx_memory
 * delete/update/archive/merge so a session can still manage memories stored
 * under a legacy raw path that normalizes to the same project (shared by both
 * harnesses — Pi previously used raw `===`, diverging from OpenCode).
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
 * Detect whether a directory belongs to a linked Git worktree. Linked worktrees
 * have a per-worktree git dir while sharing the primary checkout's common dir.
 * The probe is cached because authority recovery can be considered every pass.
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
        // If Git metadata exists but its topology cannot be resolved, fail closed:
        // the checkout may be linked and must not be allowed to drain shared authority.
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
