/**
 *
 *
 * Lifecycle paths must not use `getDataDir()` because it can resolve a different root than the daemon.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { getTestBackstopDataRoot } from "../data-path";
import { releaseContract } from "./generated-contract";

/** Canonical publication filename (version-2 `subc` literal, R45). */
export const CONNECTION_FILE_NAME = releaseContract.layout.connection_file;

export type DataRootResolution = { ok: true; root: string } | { ok: false; reason: "no_data_dir" };

function absoluteOrNull(value: string | undefined): string | null {
    if (!value || !path.isAbsolute(value)) return null;
    return value;
}

/**
 *
 */
export function resolveLifecycleDataRoot(
    env: Record<string, string | undefined> = process.env,
): DataRootResolution {
    const xdg = absoluteOrNull(env.XDG_DATA_HOME);
    if (xdg) return { ok: true, root: xdg };
    const testDataDir = absoluteOrNull(env.MAGIC_CONTEXT_TEST_DATA_DIR);
    if (testDataDir) return { ok: true, root: testDataDir };
    if (env.NODE_ENV === "test") return { ok: true, root: getTestBackstopDataRoot() };
    const home = absoluteOrNull(env.HOME);
    if (home) return { ok: true, root: path.join(home, ".local", "share") };
    return { ok: false, reason: "no_data_dir" };
}

export function coordinationDirPath(dataRoot: string): string {
    return path.join(dataRoot, releaseContract.coordination.directory);
}

export function managedSubtreePath(dataRoot: string): string {
    return path.join(dataRoot, releaseContract.layout.managed_subtree);
}

export function runtimeDirPath(dataRoot: string): string {
    return path.join(managedSubtreePath(dataRoot), releaseContract.layout.runtime_directory);
}

export function connectionFilePath(dataRoot: string): string {
    return path.join(runtimeDirPath(dataRoot), CONNECTION_FILE_NAME);
}

/**
 * The connection file a managed daemon publishes to.
 *
 *
 * Use `fallbackRoot` only when resolution returns `no_data_dir`.
 */
export function defaultConnectionFilePath(
    fallbackRoot: string,
    env: Record<string, string | undefined> = process.env,
): string {
    const resolution = resolveLifecycleDataRoot(env);
    return connectionFilePath(resolution.ok ? resolution.root : fallbackRoot);
}

/**
 */
export function sensitiveRootsFor(
    dataRoot: string,
    env: Record<string, string | undefined> = process.env,
): string[] {
    const roots = [dataRoot];
    const home = absoluteOrNull(env.HOME);
    if (home) roots.push(home);
    return roots;
}

/**
 * A path matches a sensitive root only when it is the root or lies beneath it.
 * A sibling whose name starts with a root's text is not beneath that root.
 */
export function redactLifecyclePath(value: string, sensitiveRoots: string[]): string {
    let redacted = value;
    for (const root of sensitiveRoots) {
        // A `<data-root>` placeholder is not an absolute path.
        // Resolving a placeholder against cwd could redact it twice.
        if (!path.isAbsolute(redacted)) break;
        const relative = path.relative(root, redacted);
        const beneathRoot =
            relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative);
        if (!beneathRoot) continue;
        redacted = relative === "" ? "<data-root>" : `<data-root>${path.sep}${relative}`;
    }
    return redacted;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Only release-qualified platforms undergo filesystem admission.
 * Report an unqualified platform as `unsupported_platform`.
 * Do not return a filesystem verdict for an unsupported platform.
 * Do not recommend `set_data_directory` when the platform cannot admit a data directory.
 */
export type FilesystemAdmission =
    | { ok: true }
    | {
          ok: false;
          reason: "unsupported_filesystem";
          remediation: "set_data_directory";
          detail: string;
      }
    | {
          ok: false;
          reason: "unsupported_platform";
          remediation: "use_supported_platform";
          detail: string;
      };

/**
 * The deny-list excludes filesystems that lack required locking, no-follow, atomic replacement, fsync, or retained execution semantics.
 *
 * Unknown filesystem types pass because required semantics are release-qualified rather than runtime-probed.
 * The deny-list must enumerate remote filesystem families because omitted types are admitted.
 * The deny-list includes distributed and network filesystems because omitted types are admitted.
 *
 */
const UNSUPPORTED_FS_TYPES = new Set([
    // Classic remote/network.
    "nfs",
    "nfs4",
    "cifs",
    "smb",
    "smb2",
    "smb3",
    "smbfs",
    "sshfs",
    "fuse.sshfs",
    "9p",
    "afs",
    "ncpfs",
    "curlftpfs",
    "davfs",
    "fuse.davfs2",
    "ceph",
    "cephfs",
    "fuse.ceph",
    "glusterfs",
    "fuse.glusterfs",
    "lustre",
    "beegfs",
    "gpfs",
    "orangefs",
    "moosefs",
    "fuse.moosefs",
    "gfs2",
    "ocfs2",
    "fuse.s3fs",
    "fuse.rclone",
    "fuse.gcsfuse",
    "vboxsf",
    "virtiofs",
]);

export interface MountEntry {
    mountPoint: string;
    fsType: string;
    options: string[];
}

/* */
export function parseMounts(text: string): MountEntry[] {
    const entries: MountEntry[] = [];
    for (const line of text.split("\n")) {
        const fields = line.split(" ");
        if (fields.length < 4) continue;
        const mountPoint = (fields[1] as string).replace(/\\(\d{3})/g, (_, oct: string) =>
            String.fromCharCode(Number.parseInt(oct, 8)),
        );
        entries.push({
            mountPoint,
            fsType: fields[2] as string,
            options: (fields[3] as string).split(","),
        });
    }
    return entries;
}

/**
 * The longest containing mount point governs `root`.
 * Among equal-length mount points, the parser selects the last entry in the table.
 * When mounts share a mount point, ascending mount-table order makes the final equal-length match the topmost mount.
 * The kernel traverses only the topmost mount.
 */
function longestMountFor(root: string, mounts: MountEntry[]): MountEntry | null {
    let best: MountEntry | null = null;
    for (const entry of mounts) {
        const point = entry.mountPoint;
        const contains =
            point === "/" ||
            root === point ||
            root.startsWith(point.endsWith("/") ? point : `${point}/`);
        if (contains && (best === null || point.length >= best.mountPoint.length)) {
            best = entry;
        }
    }
    return best;
}

/**
 * The kernel traverses `root` after lexical resolution and after replacing its deepest existing ancestor with that ancestor's realpath.
 * Otherwise, admission would describe a filesystem different from the one the daemon writes to.
 *
 */
function mountLookupPath(root: string, realpath: (value: string) => string): string {
    let cursor = path.resolve(root);
    const missing: string[] = [];
    for (;;) {
        try {
            return path.join(realpath(cursor), ...missing);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
            const parent = path.dirname(cursor);
            if (parent === cursor) throw error;
            missing.unshift(path.basename(cursor));
            cursor = parent;
        }
    }
}

const nativeRealpath = (value: string): string => realpathSync.native(value);

export interface AdmissionIo {
    platform: NodeJS.Platform;
    readMounts: () => string;
    /**
     * A custom canonicalizer supports fabricated mount-table paths that do not exist on the host.
     */
    realpath?: (value: string) => string;
}

// Caching avoids spawning synchronous `/sbin/mount` for every admission.
// Caching avoids blocking the event loop by spawning `/sbin/mount` for each demand-start.
// The cache expires after 1,000 ms because the mount table can change.
// Without expiry, a later-mounted unsupported filesystem could be admitted through the `/` fallback.
// The 1,000 ms cache bounds mount-table staleness while coalescing bursts into one read.
// A monotonic clock prevents wall-clock adjustments from changing cache expiry.
// stretch it.
const DARWIN_MOUNTS_CACHE_TTL_MS = 1_000;

let cachedDarwinMounts: string | undefined;
let cachedDarwinMountsAt = 0;

const defaultAdmissionIo: AdmissionIo = {
    platform: process.platform,
    readMounts: () => {
        if (process.platform !== "darwin") return readFileSync("/proc/self/mounts", "utf8");
        const now = performance.now();
        if (
            cachedDarwinMounts === undefined ||
            now - cachedDarwinMountsAt >= DARWIN_MOUNTS_CACHE_TTL_MS
        ) {
            cachedDarwinMounts = execFileSync("/sbin/mount", [], {
                encoding: "utf8",
                timeout: 2_000,
                maxBuffer: 1024 * 1024,
            });
            cachedDarwinMountsAt = now;
        }
        return cachedDarwinMounts;
    },
    realpath: nativeRealpath,
};

function parseDarwinMounts(text: string): MountEntry[] {
    const entries: MountEntry[] = [];
    for (const line of text.split("\n")) {
        // The lazy device capture preserves mount points containing ` on `.
        // An entry carrying only a filesystem type is admitted.
        const match = /^(.+?) on (.+) \(([^,()]+)(?:,\s*([^)]*))?\)$/.exec(line);
        if (!match) continue;
        entries.push({
            mountPoint: match[2] as string,
            fsType: (match[3] as string).trim(),
            options: (match[4] ?? "")
                .split(",")
                .map((option) => option.trim())
                .filter(Boolean),
        });
    }
    return entries;
}

/**
 * Linux rejects known remote or synthetic filesystem types and `noexec` mounts.
 * Linux classifies the canonicalized root, so `..` segments and symlinked ancestors are judged on the mount the kernel uses.
 * mutates anything.
 */
export function admitLifecycleFilesystem(
    dataRoot: string,
    io: AdmissionIo = defaultAdmissionIo,
): FilesystemAdmission {
    const rejected = (detail: string): FilesystemAdmission => ({
        ok: false,
        reason: "unsupported_filesystem",
        remediation: "set_data_directory",
        detail,
    });
    if (!path.isAbsolute(dataRoot)) return rejected("data root is not absolute");
    if (io.platform !== "linux" && io.platform !== "darwin") {
        return {
            ok: false,
            reason: "unsupported_platform",
            remediation: "use_supported_platform",
            detail: "platform is outside the release's qualified set",
        };
    }
    let mounts: MountEntry[];
    try {
        mounts =
            io.platform === "darwin"
                ? parseDarwinMounts(io.readMounts())
                : parseMounts(io.readMounts());
    } catch {
        return rejected("mount table is unreadable");
    }
    // Linux classifies a nonexistent root by the mount containing its would-be path because the kernel will use that mount.
    let lookupRoot: string;
    try {
        lookupRoot = mountLookupPath(dataRoot, io.realpath ?? nativeRealpath);
    } catch {
        return rejected("data root cannot be resolved");
    }
    const mount = longestMountFor(lookupRoot, mounts);
    if (!mount) return rejected("no mount contains the data root");
    const baseType = mount.fsType.toLowerCase();
    if (
        UNSUPPORTED_FS_TYPES.has(baseType) ||
        baseType.startsWith("nfs") ||
        baseType.startsWith("fuse") ||
        baseType.includes("osxfuse")
    ) {
        return rejected(`unsupported filesystem type ${baseType}`);
    }
    if (io.platform === "darwin" && (baseType !== "apfs" || !mount.options.includes("local"))) {
        return rejected(`unsupported filesystem type ${baseType}`);
    }
    if (mount.options.includes("noexec")) {
        return rejected("data root mount is noexec");
    }
    return { ok: true };
}
