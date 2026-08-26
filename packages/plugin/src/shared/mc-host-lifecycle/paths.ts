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
 * honoring `MAGIC_CONTEXT_TEST_DATA_DIR` the same way `data-path.ts` does.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
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
 */
export function resolveLifecycleDataRoot(
    env: Record<string, string | undefined> = process.env,
): DataRootResolution {
    const xdg = absoluteOrNull(env.XDG_DATA_HOME);
    if (xdg) return { ok: true, root: xdg };
    const testDataDir = absoluteOrNull(env.MAGIC_CONTEXT_TEST_DATA_DIR);
    if (testDataDir) return { ok: true, root: testDataDir };
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
    return path.join(dataRoot, "cortexkit", "run");
}

export function connectionFilePath(dataRoot: string): string {
    return path.join(runtimeDirPath(dataRoot), CONNECTION_FILE_NAME);
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

/** Replace any sensitive-root prefix with a stable placeholder. */
export function redactLifecyclePath(value: string, sensitiveRoots: string[]): string {
    let redacted = value;
    for (const root of sensitiveRoots) {
        if (redacted.startsWith(root)) {
            redacted = `<data-root>${redacted.slice(root.length)}`;
        }
    }
    return redacted;
}

// ---------------------------------------------------------------------------
// Filesystem admission (KTD11 / R27).
// ---------------------------------------------------------------------------

export type FilesystemAdmission =
    | { ok: true }
    | {
          ok: false;
          reason: "unsupported_filesystem";
          remediation: "set_data_directory";
          detail: string;
      };

/**
 * Filesystem types that cannot provide the required cross-process lock,
 * no-follow, atomic-replacement, fsync, and retained-execution semantics.
 * Remote and synthetic filesystems fail admission; unknown local types pass
 * (the practical bounded check — full semantics are release-qualified, not
 * runtime-probed).
 */
const UNSUPPORTED_FS_TYPES = new Set([
    "nfs",
    "nfs4",
    "cifs",
    "smb",
    "smb2",
    "smbfs",
    "sshfs",
    "fuse.sshfs",
    "9p",
    "afs",
    "ncpfs",
    "curlftpfs",
    "davfs",
    "fuse.davfs2",
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

function longestMountFor(root: string, mounts: MountEntry[]): MountEntry | null {
    let best: MountEntry | null = null;
    for (const entry of mounts) {
        const point = entry.mountPoint;
        const contains =
            point === "/" ||
            root === point ||
            root.startsWith(point.endsWith("/") ? point : `${point}/`);
        if (contains && (best === null || point.length > best.mountPoint.length)) {
            best = entry;
        }
    }
    return best;
}

export interface AdmissionIo {
    platform: NodeJS.Platform;
    readMounts: () => string;
}

const defaultAdmissionIo: AdmissionIo = {
    platform: process.platform,
    readMounts: () => readFileSync("/proc/self/mounts", "utf8"),
};

/**
 * Practical bounded admission of the selected data root: the root must be
 * absolute and, on Linux, sit on a local mount that is neither a known
 * remote/synthetic filesystem type nor mounted `noexec` (retained-object
 * execution). macOS admission is release-qualified rather than runtime-probed
 * and passes here. Admission failure is exactly
 * `unsupported_filesystem`/`set_data_directory` and never mutates anything.
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
    if (io.platform === "darwin") return { ok: true };
    if (io.platform !== "linux") return rejected("unqualified platform for lifecycle filesystems");
    let mounts: MountEntry[];
    try {
        mounts = parseMounts(io.readMounts());
    } catch {
        return rejected("mount table is unreadable");
    }
    // The root may not exist yet on a first start; classify by the nearest
    // mount containing the would-be path, which is what the kernel will use.
    const mount = longestMountFor(dataRoot, mounts);
    if (!mount) return rejected("no mount contains the data root");
    const baseType = mount.fsType.toLowerCase();
    if (UNSUPPORTED_FS_TYPES.has(baseType) || baseType.startsWith("nfs")) {
        return rejected(`unsupported filesystem type ${baseType}`);
    }
    if (mount.options.includes("noexec")) {
        return rejected("data root mount is noexec");
    }
    return { ok: true };
}
