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
export type ProjectIdentityErrorClass = "not_git_repo" | "git_missing" | "git_timeout" | "dubious_ownership" | "permission_denied" | "unknown";
/**
 * Strict project identity resolution error with stable machine-readable classification.
 */
export declare class ProjectIdentityError extends Error {
    readonly errorClass: ProjectIdentityErrorClass;
    readonly rawDirectory: string;
    constructor(errorClass: ProjectIdentityErrorClass, rawDirectory: string, message: string, cause?: Error);
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
export declare function resolveProjectIdentityStrict(directory: string): string;
export declare function takeDubiousOwnershipProjectIdentityWarning(directory: string): string | null;
export declare function isUserHomeDirectory(directory: string): boolean;
export declare function resolveProjectIdentity(directory: string): string;
export declare function resolveProjectIdentityOrFallback(directory: string): string;
/**
 * The directory that owns a session's project identity: the git repository
 * root when the directory sits inside one, otherwise the canonical directory
 * itself. Command surfaces that canonicalize project-relative artifact paths
 * must resolve against THIS root, not the invoking cwd — a `/cd` into a
 * subdirectory keeps the same identity (resolved through the ancestor
 * repository), so a path elsewhere in the same repository is in-project, not
 * an escape.
 */
export declare function resolveProjectRootDirectory(directory: string): string;
export declare function resolveProjectIdentityForSession(directory: string, allowHomeProject?: boolean): string | undefined;
/**
 * Normalize a stored project path or legacy raw filesystem path.
 *
 * Already-resolved `git:` / `dir:` identities are returned byte-for-byte. Raw filesystem paths are
 * resolved through the production wrapper. This helper is intentionally best-effort for existing
 * stored data: if strict resolution cannot classify the path, it falls back to the deterministic
 * `dir:<md5-12>` identity instead of throwing.
 */
export declare function normalizeStoredProjectPath(rawOrStored: string): string;
/**
 * Ownership check for a memory row against the current session's resolved
 * project identity. A memory's stored `project_path` may be a raw filesystem
 * path (legacy) OR an already-normalized `git:`/`dir:` identity; either must
 * match the current identity after normalization. Used by ctx_memory
 * delete/update/archive/merge so a session can still manage memories stored
 * under a legacy raw path that normalizes to the same project (shared by both
 * harnesses — Pi previously used raw `===`, diverging from OpenCode).
 */
export declare function storedPathBelongsToIdentity(storedProjectPath: string, projectIdentity: string): boolean;
/**
 * Detect whether a directory belongs to a linked Git worktree. Linked worktrees
 * have a per-worktree git dir while sharing the primary checkout's common dir.
 * The probe is cached because authority recovery can be considered every pass.
 */
export declare function isLinkedGitWorktree(directory: string): boolean;
export declare function __setProjectIdentityTestHooks(hooks: {
    execFileSync?: typeof execFileSync;
    homeDirectory?: () => string;
    nowMs?: () => number;
}): void;
export declare function __clearProjectIdentityTransientCooldownForTests(directory?: string): void;
export declare function __clearProjectIdentityResolutionCacheForTests(directory?: string): void;
export declare function __resetProjectIdentityForTests(): void;
//# sourceMappingURL=project-identity.d.ts.map