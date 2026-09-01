import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { guardedSmartNoteHttpGet, type SmartNoteResolver } from "./ssrf-guard";
import { SmartNoteNetworkError } from "./types";

const execFileAsync = promisify(execFile);

const DEFAULT_FILE_LIMIT_BYTES = 64 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 3_000;

export interface SmartNoteCapabilityApi {
    readFile(repoRelativePath: string): Promise<string | null>;
    gitHeadSha(): Promise<string | null>;
    gitTag(): Promise<string | null>;
    gitLog(opts?: {
        maxCount?: number;
        path?: string;
        since?: string;
    }): Promise<Array<{ sha: string; subject: string; authorDate: string }>>;
    httpGet(url: string): Promise<{ status: number; body: string }>;
}

export type SmartNoteCapabilityFactory = (signal: AbortSignal) => SmartNoteCapabilityApi;

export interface SmartNoteCapabilitiesOptions {
    projectRoot: string;
    signal: AbortSignal;
    fileLimitBytes?: number;
    resolver?: SmartNoteResolver;
}

export function createSmartNoteCapabilities(
    options: SmartNoteCapabilitiesOptions,
): SmartNoteCapabilityApi {
    const projectRoot = path.resolve(options.projectRoot);
    const fileLimitBytes = options.fileLimitBytes ?? DEFAULT_FILE_LIMIT_BYTES;
    return {
        readFile: (repoRelativePath) =>
            guardedReadFile(projectRoot, repoRelativePath, options.signal, fileLimitBytes),
        gitHeadSha: () => runGitScalar(projectRoot, ["rev-parse", "HEAD"], options.signal),
        gitTag: () =>
            runGitScalar(
                projectRoot,
                ["describe", "--tags", "--abbrev=0", "--always", "--dirty=never"],
                options.signal,
            ),
        gitLog: (opts) => guardedGitLog(projectRoot, opts, options.signal),
        httpGet: (url) =>
            guardedSmartNoteHttpGet(url, { signal: options.signal, resolver: options.resolver }),
    };
}

const SECRET_KEY_EXTENSIONS = [".p12", ".pfx", ".crt", ".key", ".pem"] as const;

export function isSecretDeniedPath(repoRelativePath: string): boolean {
    const normalized = normalizeRepoPath(repoRelativePath).toLowerCase();
    if (!normalized) return true;
    const segments = normalized.split("/");
    if (segments.includes(".git") || segments.includes("secrets")) return true;
    const basename = segments.at(-1) ?? "";

    if (basename === ".npmrc" || basename.startsWith(".env")) return true;
    if (basename === ".pgpass" || basename === ".netrc") return true;
    if (SECRET_KEY_EXTENSIONS.some((extension) => basename.endsWith(extension))) return true;
    if (
        basename === "id_rsa" ||
        basename === "id_dsa" ||
        basename === "id_ecdsa" ||
        basename === "id_ed25519" ||
        basename.startsWith("id_")
    ) {
        return true;
    }
    if (segments.includes(".aws") && basename === "credentials") return true;
    if (basename.endsWith(".json")) {
        const serviceAccountJson =
            basename.includes("service-account") || basename.includes("service_account");
        const gcloudCredentialJson =
            segments.includes("gcloud") &&
            (basename === "application_default_credentials.json" ||
                basename.includes("credential") ||
                segments.includes("legacy_credentials"));
        if (serviceAccountJson || gcloudCredentialJson) return true;
    }
    return false;
}

export function normalizeRepoPath(repoRelativePath: string): string {
    const slash = repoRelativePath.replace(/\\/g, "/").trim();
    if (!slash || slash.startsWith("/") || /^[a-zA-Z]:\//.test(slash)) return "";
    const normalized = path.posix.normalize(slash);
    if (normalized === "." || normalized.startsWith("../") || normalized === "..") return "";
    return normalized;
}

async function guardedReadFile(
    projectRoot: string,
    repoRelativePath: string,
    signal: AbortSignal,
    fileLimitBytes: number,
): Promise<string | null> {
    throwIfAborted(signal);
    const body = guardedReadFileBody(projectRoot, repoRelativePath, signal, fileLimitBytes);
    let onAbort: (() => void) | undefined;
    const abort = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError(signal));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([body, abort]);
    } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
    }
}

async function guardedReadFileBody(
    projectRoot: string,
    repoRelativePath: string,
    signal: AbortSignal,
    fileLimitBytes: number,
): Promise<string | null> {
    const normalized = normalizeRepoPath(repoRelativePath);
    if (!normalized || isSecretDeniedPath(normalized)) return null;

    const rootReal = await realpath(projectRoot).catch(() => null);
    throwIfAborted(signal);
    if (!rootReal) return null;
    const target = path.resolve(rootReal, normalized);
    if (!isPathInside(rootReal, target)) return null;

    const parentReal = await realpath(path.dirname(target)).catch(() => null);
    throwIfAborted(signal);
    if (!parentReal || !isPathInside(rootReal, parentReal)) return null;

    // A symlinked parent can move `target` outside `rootReal` or into a denied path; recheck the canonical path.
    const canonicalTarget = path.join(parentReal, path.basename(target));
    const canonicalRelative = normalizeRepoPath(path.relative(rootReal, canonicalTarget));
    if (
        !canonicalRelative ||
        !isPathInside(rootReal, canonicalTarget) ||
        isSecretDeniedPath(canonicalRelative)
    ) {
        return null;
    }

    const targetStat = await lstat(canonicalTarget).catch((error) => {
        if (isNoFollowOrMissing(error)) return null;
        throw error;
    });
    throwIfAborted(signal);
    if (!targetStat?.isFile() || targetStat.size > fileLimitBytes) return null;

    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
    const openPromise = open(canonicalTarget, fsConstants.O_RDONLY | noFollow | nonBlock).catch(
        (error) => {
            if (isNoFollowOrMissing(error)) return null;
            throw error;
        },
    );
    const handle = await closeLateOpenOnAbort(openPromise, signal);
    if (!handle) return null;
    try {
        throwIfAborted(signal);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > fileLimitBytes) return null;
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
        throwIfAborted(signal);
        return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
        await handle.close().catch(() => {});
    }
}

async function closeLateOpenOnAbort(
    openPromise: Promise<FileHandle | null>,
    signal: AbortSignal,
): Promise<FileHandle | null> {
    const handle = await openPromise;
    if (!signal.aborted) return handle;
    if (handle) void handle.close().catch(() => {});
    throw abortError(signal);
}

function abortError(signal: AbortSignal): SmartNoteNetworkError {
    return signal.reason instanceof SmartNoteNetworkError
        ? signal.reason
        : new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted");
}

function isPathInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNoFollowOrMissing(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    return code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR" || code === "EINVAL";
}

async function runGitScalar(
    projectRoot: string,
    args: string[],
    signal: AbortSignal,
): Promise<string | null> {
    const stdout = await runGit(projectRoot, args, signal).catch(() => null);
    const value = stdout?.trim();
    return value ? value.split("\n")[0] : null;
}

async function guardedGitLog(
    projectRoot: string,
    opts: { maxCount?: number; path?: string; since?: string } | undefined,
    signal: AbortSignal,
): Promise<Array<{ sha: string; subject: string; authorDate: string }>> {
    const maxCount = Math.max(1, Math.min(50, Math.floor(opts?.maxCount ?? 10)));
    const args = ["log", `-${maxCount}`, "--format=%H%x1f%aI%x1f%s", "--no-ext-diff", "--no-color"];
    if (opts?.since && /^[0-9A-Za-z: +._-]{1,64}$/.test(opts.since)) {
        args.push(`--since=${opts.since}`);
    }
    if (opts?.path) {
        const normalized = normalizeRepoPath(opts.path);
        if (!normalized || isSecretDeniedPath(normalized)) return [];
        args.push("--", normalized);
    }
    const stdout = await runGit(projectRoot, args, signal).catch(() => "");
    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [sha, authorDate, subject] = line.split("\x1f");
            return { sha: sha ?? "", authorDate: authorDate ?? "", subject: subject ?? "" };
        })
        .filter((row) => row.sha.length > 0);
}

async function runGit(projectRoot: string, args: string[], signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    try {
        const result = await execFileAsync("git", ["-C", projectRoot, ...args], {
            timeout: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 128 * 1024,
            signal,
        });
        return result.stdout;
    } catch (error) {
        if (
            signal.aborted ||
            (error as { killed?: boolean; signal?: string }).signal === "SIGTERM"
        ) {
            throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: git command timed out or aborted");
        }
        return "";
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted");
}
