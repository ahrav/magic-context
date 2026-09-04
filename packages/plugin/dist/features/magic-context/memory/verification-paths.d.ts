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
type VerificationPathsExecFile = (file: string, args: readonly string[], options: VerificationPathsExecOptions) => Promise<VerificationPathsExecResult>;
export interface NormalizedVerificationFiles {
    files: string[];
    warnings: string[];
    gitRoot: string | null;
}
/** True when `candidate` stays at or below `root` (no `..` escape). Shared
 * with the enforcement-artifact canonicalizer so the security-sensitive
 * escape predicate has exactly one implementation. */
export declare function isWithin(root: string, candidate: string): boolean;
/** Resolve symlinks, or null when the path does not exist. Shared with the
 * enforcement-artifact canonicalizer. */
export declare function safeRealpath(value: string): string | null;
/** SHA-256 hex of a file's bytes, read whole. The single implementation for
 * enforcement-artifact digests: record time and revalidation must hash
 * identically or valid artifacts read as drifted (and vice versa). Use the
 * streaming variant on paths where a large file would pin the event loop. */
export declare function sha256FileSync(absolutePath: string): string;
/** Streamed SHA-256: read and hash yield per chunk, so hashing a large
 *  artifact never pins the event loop the way a whole-buffer
 *  createHash().update() would. Digest-identical to `sha256FileSync`. */
export declare function sha256FileStreaming(absolutePath: string): Promise<string>;
export declare function resolveGitTopLevel(cwd: string): Promise<string | null>;
export declare function readGitHead(cwd: string): Promise<string | null>;
export declare function readGitChangedFilesSince(cwd: string, revision: string): Promise<Set<string> | null>;
/**
 * Map each repo file changed at/after `sinceMs` to its LATEST commit time (ms).
 * Drives the per-memory verify gate: a memory needs re-verification if any of
 * its mapped files has a change time newer than that memory's `verified_at`.
 *
 * Returns null on any git failure → caller falls back to full verification
 * (safe direction: re-check rather than skip). Output excludes the working tree;
 * a file edited but uncommitted is caught separately by `verificationFileExists`
 * (deletion) — verify reads the live file regardless, so uncommitted edits are
 * surfaced when the file is opened. The committed-history map is what lets the
 * gate cheaply SKIP unchanged memories.
 */
export declare function readGitFileChangeTimesSince(cwd: string, sinceMs: number): Promise<Map<string, number> | null>;
export declare function verificationFileExists(baseRoot: string, filePath: string): boolean;
/**
 * Normalize agent-supplied verification paths into repo-root-relative Git paths.
 * Non-git projects fall back to cwd-relative existing files; their gate full-runs.
 */
export declare function normalizeVerificationFiles(args: {
    cwd: string;
    files: readonly string[];
}): Promise<NormalizedVerificationFiles>;
export declare function __setVerificationPathsTestHooks(hooks: {
    execFile?: VerificationPathsExecFile;
}): void;
export declare function __resetVerificationPathsForTests(): void;
export {};
//# sourceMappingURL=verification-paths.d.ts.map