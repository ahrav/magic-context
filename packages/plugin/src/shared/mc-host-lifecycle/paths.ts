/**
 * Lifecycle data-root resolution and filesystem admission (plan U3, KTD11).
 *
 * Root selection mirrors the Rust resolver in `crates/mc-host/src/instance.rs`
 * exactly: an absolute nonempty `XDG_DATA_HOME` wins, then an absolute
 * nonempty `HOME/.local/share`, and everything else is `no_data_dir`. Relative
 * or empty values are ignored rather than joined to cwd, and `os.homedir()` is
 * never consulted as competing authority.
 *
 * This module deliberately does NOT reuse `data-path.ts`'s `getDataDir()`:
 * that resolver serves application storage (with `os.homedir()` fallback and
 * test backstops that must keep their current behavior), while lifecycle
 * paths must agree byte-for-byte with the Rust daemon or two processes would
 * coordinate on different roots. The test-isolation guard is preserved by
 * honoring `MAGIC_CONTEXT_TEST_DATA_DIR` the same way `data-path.ts` does, and
 * by sharing its `NODE_ENV=test` backstop root so an unisolated test cannot
 * reach the user's live tree through either resolver.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { getTestBackstopDataRoot } from "../data-path";
import { releaseContract } from "./generated-contract";

/** Canonical publication filename (version-2 `subc` literal, R45). */
export const CONNECTION_FILE_NAME = "subc-connection.json";

export type DataRootResolution = { ok: true; root: string } | { ok: false; reason: "no_data_dir" };

function absoluteOrNull(value: string | undefined): string | null {
    if (!value || !path.isAbsolute(value)) return null;
    return value;
}

/**
 * Resolve the lifecycle data root from the supplied environment. The
 * `MAGIC_CONTEXT_TEST_DATA_DIR` guard (set only by test preloads) wins over
 * the HOME fallback but not over an explicit absolute `XDG_DATA_HOME`,
 * matching `data-path.ts`'s isolation contract.
 *
 * That contract includes a third layer, and this resolver honors it too: the
 * preload only runs when `bun test`'s CWD has a bunfig wiring `[test] preload`,
 * so a run from a directory without it executes every test with no preload and
 * no `MAGIC_CONTEXT_TEST_DATA_DIR`. Falling through to the real `HOME` there
 * would let a lifecycle policy probe, start, stop, or stage inside the user's
 * live `~/.local/share` tree. Bun sets `NODE_ENV=test` for every `bun test`
 * regardless of CWD and production never sets it, so that window redirects to
 * the same throwaway root the storage resolver uses.
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
    return path.join(dataRoot, "cortexkit");
}

export function runtimeDirPath(dataRoot: string): string {
    return path.join(managedSubtreePath(dataRoot), "run");
}

export function connectionFilePath(dataRoot: string): string {
    return path.join(runtimeDirPath(dataRoot), CONNECTION_FILE_NAME);
}

/**
 * The connection file a managed daemon publishes to.
 *
 * The lifecycle root is authoritative because `McHostLifecyclePolicy` launches
 * the daemon with `XDG_DATA_HOME` set to exactly this root, so the publication
 * lands here. Readers must not re-derive the path from `data-path.ts`'s
 * `getDataDir()`: that resolver accepts a relative `XDG_DATA_HOME`, prefers
 * bun's cached `os.homedir()` over `env.HOME`, and ignores
 * `MAGIC_CONTEXT_TEST_DATA_DIR`, so under any of those it names a different
 * file than the one the daemon just wrote.
 *
 * `fallbackRoot` covers only the `no_data_dir` case, where the policy cannot
 * start a daemon at all and the legacy derivation is the best remaining guess.
 */
export function defaultConnectionFilePath(
    fallbackRoot: string,
    env: Record<string, string | undefined> = process.env,
): string {
    const resolution = resolveLifecycleDataRoot(env);
    return connectionFilePath(resolution.ok ? resolution.root : fallbackRoot);
}

/**
 * Sensitive roots for diagnostic path redaction: the admitted data root and
 * the HOME it may derive from. Renderers must replace these prefixes before
 * any path reaches human or JSON output (R35).
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
 * Replace a sensitive root with a stable placeholder, matching on path
 * boundaries rather than characters: a sibling that merely starts with the
 * root's text (`<root>-backup`) is a different directory and keeps its own
 * name, so only the root itself and paths beneath it are replaced.
 */
export function redactLifecyclePath(value: string, sensitiveRoots: string[]): string {
    let redacted = value;
    for (const root of sensitiveRoots) {
        // A placeholder already stands in for the leading segments. It is not a
        // path, and re-measuring it would resolve it against cwd and can redact
        // a second time.
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
// Filesystem admission (KTD11 / R27).
// ---------------------------------------------------------------------------

/**
 * A rejection carries the reason class it actually earned. Only a host whose
 * platform the release qualifies can have its filesystem judged, so a
 * platform this function cannot judge for is reported as `unsupported_platform`
 * rather than as a filesystem verdict: telling an operator to
 * `set_data_directory` on a platform where no data directory can ever be
 * admitted names a remedy that cannot work.
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
 * Filesystem types that cannot provide the required cross-process lock,
 * no-follow, atomic-replacement, fsync, and retained-execution semantics.
 *
 * A deny-list, so unknown types pass — the practical bounded check, since full
 * semantics are release-qualified rather than runtime-probed. That trade means
 * the list has to actually enumerate the remote families, because anything
 * missing from it is admitted: the check fails open on exactly the locality
 * axis the requirement is about. Distributed and network filesystems are listed
 * alongside the classic remote ones for that reason.
 *
 * The release contract enumerates filesystem *capability* names
 * (`local_filesystem`, `cross_process_locks`, ...), never filesystem types, so
 * this set is the only implementation of the locality requirement.
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
    // Distributed and cluster filesystems.
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
    // Object-store and hypervisor passthrough mounts.
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

/** Parse `/proc/self/mounts` (Linux). Octal escapes in mount points are decoded. */
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
 * The mount whose options govern `root`: the longest containing mount point,
 * and among equal-length points the last entry in the table. Stacked mounts
 * share a mount point and `/proc/self/mounts` lists them in ascending mount
 * order, so the final equal-length match is the one currently on top and the
 * only one the kernel traverses.
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
 * The path the kernel actually traverses for `root`: lexically resolved, then
 * with its deepest existing ancestor replaced by that ancestor's realpath. A
 * `..` segment or a symlinked ancestor otherwise leaves the lookup naming a
 * mount that does not carry the effective path, so admission would describe a
 * different filesystem than the daemon writes to.
 *
 * A missing tail is expected, because the root is created on first start, and
 * is rejoined onto the resolved ancestor. `missing` collects basenames from the
 * leaf upward, so each shallower segment is unshifted ahead of the deeper ones
 * already held and the join order stays deepest-last. Every other resolution
 * failure propagates so the caller can fail closed.
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
     * Canonicalizer applied to the data root before mount lookup, defaulting
     * to `realpathSync.native`. Substituting it keeps mount selection decidable
     * against a fabricated mount table that names paths this host does not have.
     */
    realpath?: (value: string) => string;
}

// Reading the darwin mount table spawns /sbin/mount synchronously, and
// admission runs on every lifecycle command reached from request-driven
// demand-start, and spawning `/sbin/mount` per demand would block the event
// loop each time. The read is therefore cached, but only briefly: the mount
// table is not process-lifetime stable, because a volume can be mounted after
// the first read. A data root on a volume mounted later would otherwise never
// match its own mount, `longestMountFor` would fall back to `/` — apfs and
// local, so admissible — and an unsupported filesystem would be admitted. The
// window bounds that staleness while still collapsing a burst of demands onto
// one spawn. Measured on a monotonic timeline so a wall-clock step cannot
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
        // `<device> on <mount point> (<fstype>[, <option>...])`. The device is
        // matched lazily so a mount point containing " on " (volume names are
        // user-chosen) keeps its full spelling, and the option list is optional
        // so an entry carrying only a filesystem type is admitted rather than
        // silently dropped from the mount table.
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
 * Practical bounded admission of the selected data root: the root must be
 * absolute and, on Linux, sit on a local mount that is neither a known
 * remote/synthetic filesystem type nor mounted `noexec` (retained-object
 * execution). Linux classification runs against the canonicalized root, so
 * `..` segments and symlinked ancestors are judged on the mount the kernel
 * traverses rather than the one the literal string names. macOS admission is
 * release-qualified rather than runtime-probed and passes here. A platform the
 * release does not qualify is rejected as `unsupported_platform`; every other
 * rejection is `unsupported_filesystem`/`set_data_directory`. Nothing here
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
        // Not a filesystem judgment: the mount tables this function reads are
        // linux- and darwin-specific, so on any other platform there is no
        // filesystem to admit or reject. The platform itself is what fails.
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
    // The root may not exist yet on a first start; classify by the nearest
    // mount containing the would-be path, which is what the kernel will use.
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
