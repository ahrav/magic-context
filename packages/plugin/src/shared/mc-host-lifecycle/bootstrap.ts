/**
 * Pre-native trust pipeline: platform gate, retained-bootstrap revalidation,
 * certified physical install-layout resolution, trust-index verification, and
 * capacity-preflighted no-follow staging. Nothing in this module executes a
 * byte — it only decides whether a trusted launcher object exists and stages
 * one when the certified package path allows it. Every failure is one closed
 * lifecycle reason.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    closeSync,
    fchmodSync,
    constants as fsConstants,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readlinkSync,
    readSync,
    realpathSync,
    renameSync,
    statfsSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { releaseContract } from "./generated-contract";

export type LifecycleFailureReason =
    | "unsupported_platform"
    | "unsupported_install_layout"
    | "native_payload_missing"
    | "native_payload_invalid"
    | "insufficient_storage"
    | "internal_error";

export class BootstrapError extends Error {
    constructor(
        readonly reason: LifecycleFailureReason,
        message: string,
    ) {
        super(message);
        this.name = "BootstrapError";
    }
}

/**
 * The uid every ownership check in this module compares against. A host
 * without `process.getuid` cannot express file ownership, which is an
 * unsupported platform and not a property of any inspected file: comparing a
 * numeric `stat.uid` against a missing function yields `undefined` and would
 * misreport every correctly-owned object as foreign. Callers resolve the uid
 * before their first filesystem effect so such a host fails without leaving
 * a directory or a temp object behind.
 */
function currentUid(): number {
    if (typeof process.getuid !== "function") {
        throw new BootstrapError("unsupported_platform", "cannot determine process uid");
    }
    return process.getuid();
}

// ---------------------------------------------------------------------------
// Platform gate (R24). Runs before any package byte is opened.
// ---------------------------------------------------------------------------

export interface PlatformReaders {
    platform: NodeJS.Platform;
    arch: string;
    /** Kernel release, e.g. `5.10.220-x`. */
    kernelRelease: () => string;
    /** glibc runtime version, e.g. `2.34`, or null when unverifiable. */
    glibcVersion: () => string | null;
    /** True only when `/proc/self/fd` resolves on a real procfs. */
    procSelfFdUsable: () => boolean;
    /** macOS product version, e.g. `14.2`, or null when unverifiable. */
    macosProductVersion: () => string | null;
}

function detectGlibcVersion(): string | null {
    try {
        const report: unknown = process.report?.getReport?.();
        if (typeof report === "object" && report !== null) {
            const header = (report as { header?: { glibcVersionRuntime?: unknown } }).header;
            const version = header?.glibcVersionRuntime;
            if (typeof version === "string" && version.length > 0) return version;
        }
    } catch {
        // fall through to the conservative null below
    }
    return null;
}

function detectProcSelfFd(): boolean {
    try {
        // A real procfs resolves an open descriptor's link target; a masked
        // or absent /proc throws here and the gate fails closed.
        readlinkSync("/proc/self/fd/0");
        return true;
    } catch {
        return false;
    }
}

const MACOS_SYSTEM_VERSION_PLIST = "/System/Library/CoreServices/SystemVersion.plist";
const MACOS_PRODUCT_VERSION_SHAPE = /^\d+(?:\.\d+)*$/;

/**
 * Read the macOS `ProductVersion` (for example `14.5`) that the darwin arm of
 * {@link checkPlatform} compares against the contract's `os_min` floor.
 *
 * The system plist is tried first because it is a plain file read with no
 * subprocess; `sw_vers` is the fallback for a host whose plist is unreadable
 * or in a shape this parser does not recognize. `os.release()` is deliberately
 * not consulted: it reports the Darwin kernel version (24.x), not the product
 * version the contract floor is expressed in. Any failure returns `null`,
 * which the caller treats as unverifiable and therefore unsupported, so an
 * unreadable system fails closed instead of assuming it meets the floor.
 */
function detectMacosProductVersion(): string | null {
    try {
        const plist = readFileSync(MACOS_SYSTEM_VERSION_PLIST, "utf8");
        const match = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
        const version = match?.[1]?.trim();
        if (version !== undefined && MACOS_PRODUCT_VERSION_SHAPE.test(version)) return version;
    } catch {
        // fall through to the sw_vers fallback below
    }
    try {
        const reported = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
            encoding: "utf8",
            timeout: 2_000,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return MACOS_PRODUCT_VERSION_SHAPE.test(reported) ? reported : null;
    } catch {
        return null;
    }
}

export const defaultPlatformReaders: PlatformReaders = {
    platform: process.platform,
    arch: process.arch,
    kernelRelease: () => os.release(),
    glibcVersion: detectGlibcVersion,
    procSelfFdUsable: detectProcSelfFd,
    // Only the darwin arm of `checkPlatform` calls this, so no non-macOS host
    // ever pays the plist read or the `sw_vers` fallback.
    macosProductVersion: detectMacosProductVersion,
};

function parseVersionPair(value: string): [number, number] | null {
    const match = /^(\d+)\.(\d+)/.exec(value);
    if (!match) return null;
    return [Number.parseInt(match[1] as string, 10), Number.parseInt(match[2] as string, 10)];
}

function meetsFloor(value: string, floor: string): boolean {
    const parsed = parseVersionPair(value);
    const min = parseVersionPair(floor);
    if (!parsed || !min) return false;
    if (parsed[0] !== min[0]) return parsed[0] > min[0];
    return parsed[1] >= min[1];
}

export type PlatformGate =
    | { ok: true; target: "linux-x64-gnu" | "darwin-arm64" | "darwin-x64" }
    | { ok: false; reason: "unsupported_platform"; detail: string };

/**
 * Enforce the exact release-contract target table: Linux x64 with kernel and
 * glibc at or above their floors plus usable procfs self-fd execution, or
 * macOS at or above its floor. Unknown, below-floor, and UNVERIFIABLE hosts
 * (a null glibc or macOS version) are all `unsupported_platform` — the gate
 * never guesses in favor of execution.
 */
export function checkPlatform(readers: PlatformReaders = defaultPlatformReaders): PlatformGate {
    const rejected = (detail: string): PlatformGate => ({
        ok: false,
        reason: "unsupported_platform",
        detail,
    });
    const platforms = releaseContract.platforms.supported;
    if (readers.platform === "linux") {
        if (readers.arch !== "x64") return rejected("unsupported architecture");
        const linux = platforms.find((entry) => entry.target === "linux-x64-gnu");
        if (!linux || !("kernel_min" in linux) || !("glibc_min" in linux)) {
            return rejected("no linux target in the release contract");
        }
        if (!meetsFloor(readers.kernelRelease(), linux.kernel_min)) {
            return rejected("kernel below the supported floor");
        }
        const glibc = readers.glibcVersion();
        if (glibc === null) return rejected("glibc version is unverifiable");
        if (!meetsFloor(glibc, linux.glibc_min)) {
            return rejected("glibc below the supported floor");
        }
        if (!readers.procSelfFdUsable()) {
            return rejected("procfs self-fd execution is unavailable");
        }
        return { ok: true, target: "linux-x64-gnu" };
    }
    if (readers.platform === "darwin") {
        const target =
            readers.arch === "arm64"
                ? "darwin-arm64"
                : readers.arch === "x64"
                  ? "darwin-x64"
                  : null;
        if (!target) return rejected("unsupported architecture");
        const mac = platforms.find((entry) => entry.target === target);
        if (!mac || !("os_min" in mac))
            return rejected("no matching target in the release contract");
        const version = readers.macosProductVersion();
        if (version === null) return rejected("macOS version is unverifiable");
        if (!meetsFloor(version, mac.os_min)) return rejected("macOS below the supported floor");
        return { ok: true, target };
    }
    return rejected("unsupported operating system");
}

// ---------------------------------------------------------------------------
// Parent-owned payload trust index (KTD7/KTD18; real values arrive with U6).
// ---------------------------------------------------------------------------

export interface TrustIndexEntry {
    package: string;
    version: string;
    target: string;
    payload_manifest_digest: string;
    launcher_digest: string;
    launcher_rel_path: string;
}

export interface TrustIndex {
    schema: "magic-context.mc-host-payload-index/v1";
    release_version: string;
    entries: TrustIndexEntry[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Byte cap for the trust index; an oversize file is invalid, not truncated. */
export const MAX_TRUST_INDEX_BYTES = 1024 * 1024;

/**
 * Read at most one byte past the cap through the descriptor, so an oversize
 * file is caught from the bytes actually read rather than from metadata a
 * concurrent writer can have already invalidated.
 */
function readTrustIndexText(fd: number): string {
    const buffer = Buffer.alloc(MAX_TRUST_INDEX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
        const read = readSync(fd, buffer, total, buffer.length - total, total);
        if (read === 0) break;
        total += read;
    }
    if (total > MAX_TRUST_INDEX_BYTES) {
        throw new BootstrapError("native_payload_invalid", "trust index exceeds the byte cap");
    }
    return buffer.subarray(0, total).toString("utf8");
}

/**
 * Strict decode of `release/mc-host-payload-index.json`. `null` means the
 * file is absent (payload staging then fails `native_payload_missing`);
 * a present-but-invalid index is `native_payload_invalid`, never a fallback.
 *
 * Provenance is established from file shape before any byte is parsed: one
 * retained O_NOFOLLOW descriptor supplies the bytes, its metadata must show a
 * single-link regular file owned by this process with no group or other write
 * bit and within the byte cap, and the path identity is re-checked against
 * that descriptor after the read. A schema-valid document proves only that
 * someone wrote well-formed JSON, so a symlinked, foreign-owned, shared-link,
 * or group-writable index is rejected on shape and never reaches the parser.
 */
export function loadTrustIndex(indexPath: string): TrustIndex | null {
    const uid = currentUid();
    let fd: number;
    try {
        fd = openSync(
            indexPath,
            // O_NOFOLLOW so a symlink at this name fails the open instead of
            // redirecting the read; O_NONBLOCK so a FIFO fails fstat instead
            // of blocking the open until a writer appears.
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new BootstrapError("native_payload_invalid", "trust index is unreadable");
    }
    let text: string;
    try {
        const before = fstatSync(fd);
        if (!before.isFile()) {
            throw new BootstrapError("native_payload_invalid", "trust index is not a regular file");
        }
        if (before.nlink !== 1) {
            throw new BootstrapError("native_payload_invalid", "trust index is not single-link");
        }
        if (before.uid !== uid) {
            throw new BootstrapError("native_payload_invalid", "trust index has a foreign owner");
        }
        if ((before.mode & 0o022) !== 0) {
            throw new BootstrapError(
                "native_payload_invalid",
                "trust index is group/world writable",
            );
        }
        if (before.size > MAX_TRUST_INDEX_BYTES) {
            throw new BootstrapError("native_payload_invalid", "trust index exceeds the byte cap");
        }
        text = readTrustIndexText(fd);
        const after = lstatSync(indexPath);
        if (after.dev !== before.dev || after.ino !== before.ino) {
            throw new BootstrapError(
                "native_payload_invalid",
                "trust index identity drifted during the read",
            );
        }
    } finally {
        closeSync(fd);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new BootstrapError("native_payload_invalid", "trust index is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new BootstrapError("native_payload_invalid", "trust index is not an object");
    }
    const record = parsed as Record<string, unknown>;
    if (
        record.schema !== "magic-context.mc-host-payload-index/v1" ||
        record.release_version !== releaseContract.release.version ||
        !Array.isArray(record.entries)
    ) {
        throw new BootstrapError("native_payload_invalid", "trust index shape or release mismatch");
    }
    const entries: TrustIndexEntry[] = record.entries.map((raw) => {
        if (typeof raw !== "object" || raw === null) {
            throw new BootstrapError(
                "native_payload_invalid",
                "trust index entry is not an object",
            );
        }
        const entry = raw as Record<string, unknown>;
        const requireString = (field: string): string => {
            const value = entry[field];
            if (typeof value !== "string" || value.length === 0 || value.length > 512) {
                throw new BootstrapError(
                    "native_payload_invalid",
                    `trust index entry field ${field} is invalid`,
                );
            }
            return value;
        };
        const payloadDigest = requireString("payload_manifest_digest");
        const launcherDigest = requireString("launcher_digest");
        if (!SHA256_HEX.test(payloadDigest) || !SHA256_HEX.test(launcherDigest)) {
            throw new BootstrapError(
                "native_payload_invalid",
                "trust index digest is noncanonical",
            );
        }
        return {
            package: requireString("package"),
            version: requireString("version"),
            target: requireString("target"),
            payload_manifest_digest: payloadDigest,
            launcher_digest: launcherDigest,
            launcher_rel_path: requireString("launcher_rel_path"),
        };
    });
    return {
        schema: "magic-context.mc-host-payload-index/v1",
        release_version: record.release_version as string,
        entries,
    };
}

// ---------------------------------------------------------------------------
// Certified physical install layouts (KTD10).
// ---------------------------------------------------------------------------

const MAX_HOIST_PARENT_SEGMENTS = 8;

export type LayoutResolution =
    | {
          ok: true;
          layout: (typeof releaseContract.install_layouts)[number];
          packageDir: string;
      }
    | {
          ok: false;
          reason: "unsupported_install_layout" | "native_payload_missing";
          detail: string;
      };

type EntryKind = "dir" | "symlink" | "absent" | "other" | "inaccessible";

/**
 * Classify one candidate path by its own metadata. Only a genuine absence is
 * `absent`, because absence is the single kind that lets the hoist walk climb
 * past a candidate: EACCES on a parent directory, ELOOP on an intermediate
 * component, descriptor exhaustion, and I/O faults all mean a nearer candidate
 * may exist but cannot be certified, so reporting them as absence would let a
 * more distant ancestor package win. ENOTDIR is absence because a
 * non-directory ancestor cannot contain the candidate at all.
 */
function classifyEntry(entryPath: string): EntryKind {
    try {
        const stat = lstatSync(entryPath);
        if (stat.isSymbolicLink()) return "symlink";
        if (stat.isDirectory()) return "dir";
        return "other";
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "inaccessible";
    }
}

/**
 * Resolve the exact payload package from the lexical declaring-parent root:
 * the nested `node_modules/<pkg>` path, a hoisted sibling `node_modules`
 * within eight lexical parent segments, one Bun package-manager symlink that
 * resolves under the SAME install's `node_modules/.bun/.../node_modules/`,
 * or an explicit external compiled-host root. No importer, cwd, global
 * store, or unrelated ancestor is ever consulted, so nothing here can
 * trigger an auto-install.
 */
export function resolvePayloadPackageDir(options: {
    declaringParentRoot: string;
    packageName: string;
    /** Compiled-Bun external root; checked before lexical walking. */
    explicitExternalRoot?: string;
}): LayoutResolution {
    const { declaringParentRoot, packageName } = options;
    if (options.explicitExternalRoot !== undefined) {
        const externalCandidate = path.join(
            options.explicitExternalRoot,
            "node_modules",
            ...packageName.split("/"),
        );
        if (classifyEntry(externalCandidate) === "dir") {
            return { ok: true, layout: "compiled_bun_external", packageDir: externalCandidate };
        }
        return {
            ok: false,
            reason: "unsupported_install_layout",
            detail: "explicit external root has no physical payload directory",
        };
    }
    const segments = packageName.split("/");
    let current = declaringParentRoot;
    for (let depth = 0; depth <= MAX_HOIST_PARENT_SEGMENTS; depth++) {
        const nodeModules = path.join(current, "node_modules");
        const candidate = path.join(nodeModules, ...segments);
        const kind = classifyEntry(candidate);
        if (kind === "dir") {
            return {
                ok: true,
                layout: depth === 0 ? "npm_nested" : "npm_hoisted",
                packageDir: candidate,
            };
        }
        if (kind === "symlink") {
            const bunLayout = resolveBunLink(nodeModules, candidate, segments);
            if (bunLayout) return bunLayout;
            return {
                ok: false,
                reason: "unsupported_install_layout",
                detail: "payload entry is a non-certified symlink",
            };
        }
        if (kind === "other") {
            return {
                ok: false,
                reason: "unsupported_install_layout",
                detail: "payload entry is not a directory",
            };
        }
        if (kind === "inaccessible") {
            return {
                ok: false,
                reason: "unsupported_install_layout",
                detail: "payload entry is not inspectable",
            };
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return {
        ok: false,
        reason: "native_payload_missing",
        detail: "no certified physical layout carries the payload package",
    };
}

function resolveBunLink(
    nodeModules: string,
    candidate: string,
    segments: string[],
): LayoutResolution | null {
    let resolved: string;
    try {
        resolved = realpathSync(candidate);
    } catch {
        return null;
    }
    if (classifyEntry(resolved) !== "dir") return null;
    const bunStore = path.join(nodeModules, ".bun");
    let bunStoreReal: string;
    try {
        bunStoreReal = realpathSync(bunStore);
    } catch {
        return null;
    }
    const withinStore = resolved.startsWith(`${bunStoreReal}${path.sep}`);
    // The suffix is anchored on a separator so only a real `node_modules`
    // path component certifies: a bare suffix match also accepts a sibling
    // directory whose name merely ends in `node_modules`.
    const expectedSuffix = `${path.sep}${path.join("node_modules", ...segments)}`;
    if (!withinStore || !resolved.endsWith(expectedSuffix)) return null;
    return { ok: true, layout: "bun_physical_link", packageDir: resolved };
}

// ---------------------------------------------------------------------------
// Capacity preflight (KTD22 / R46). Checked arithmetic via BigInt.
// ---------------------------------------------------------------------------

const RESERVE_FLOOR_BYTES = 256n * 1024n * 1024n;
const MAX_REASONABLE_REQUIRED = 1n << 60n;

export type CapacityVerdict =
    | { ok: true }
    | { ok: false; reason: "insufficient_storage" | "native_payload_invalid"; detail: string };

/**
 * `available >= required + max(256 MiB, ceil(required * 10%))` with checked
 * arithmetic: a negative, non-integral, or implausibly large requirement is
 * `native_payload_invalid`, and a true shortfall is `insufficient_storage`.
 */
export function checkCapacity(requiredBytes: bigint, availableBytes: bigint): CapacityVerdict {
    if (requiredBytes < 0n || requiredBytes > MAX_REASONABLE_REQUIRED) {
        return {
            ok: false,
            reason: "native_payload_invalid",
            detail: "required byte count is impossible",
        };
    }
    if (availableBytes < 0n) {
        return {
            ok: false,
            reason: "native_payload_invalid",
            detail: "available bytes is negative",
        };
    }
    const tenPercent = (requiredBytes + 9n) / 10n;
    const reserve = tenPercent > RESERVE_FLOOR_BYTES ? tenPercent : RESERVE_FLOOR_BYTES;
    if (availableBytes < requiredBytes + reserve) {
        return {
            ok: false,
            reason: "insufficient_storage",
            detail: "destination filesystem lacks the required reserve",
        };
    }
    return { ok: true };
}

export function availableBytesFor(dirPath: string): bigint {
    const stats = statfsSync(dirPath, { bigint: true });
    return stats.bavail * stats.bsize;
}

// ---------------------------------------------------------------------------
// Retained-bootstrap revalidation and no-follow staging (KTD18 / R29-R31).
// ---------------------------------------------------------------------------

export interface RetainedBootstrap {
    /** Open O_NOFOLLOW read descriptor for the verified launcher object. */
    fd: number;
    path: string;
    sha256: string;
}

function sha256OfFd(fd: number): string {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, position);
        if (read === 0) break;
        hash.update(buffer.subarray(0, read));
        position += read;
    }
    return hash.digest("hex");
}

function invalid(detail: string): BootstrapError {
    return new BootstrapError("native_payload_invalid", detail);
}

/**
 * Complete revalidation of a retained digest-addressed bootstrap: owner-only
 * regular file, single link, owner-executable, and byte-for-byte digest
 * match through one retained O_NOFOLLOW descriptor whose identity is checked
 * against the path before AND after hashing. Any failure closes the
 * descriptor and throws; a failed retained object is never executed and
 * never causes fallback to a different generation.
 */
export function revalidateRetainedBootstrap(
    bootstrapPath: string,
    expectedSha256: string,
): RetainedBootstrap {
    if (!SHA256_HEX.test(expectedSha256)) throw invalid("expected digest is noncanonical");
    const uid = currentUid();
    let fd: number;
    try {
        fd = openSync(
            bootstrapPath,
            // O_NONBLOCK so a FIFO at this name fails fstat instead of
            // blocking the open until a writer appears; regular-file reads
            // are unaffected.
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
    } catch {
        throw new BootstrapError("native_payload_missing", "retained bootstrap is not openable");
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw invalid("retained bootstrap is not a regular file");
        if (stat.nlink !== 1) throw invalid("retained bootstrap is not single-link");
        if (stat.uid !== uid) throw invalid("retained bootstrap has a foreign owner");
        if ((stat.mode & 0o077) !== 0)
            throw invalid("retained bootstrap is group/world accessible");
        if ((stat.mode & 0o100) === 0) throw invalid("retained bootstrap is not owner-executable");
        const digest = sha256OfFd(fd);
        if (digest !== expectedSha256) throw invalid("retained bootstrap digest mismatch");
        const after = lstatSync(bootstrapPath);
        if (after.ino !== stat.ino || after.dev !== stat.dev || after.nlink !== 1) {
            throw invalid("retained bootstrap identity drifted during revalidation");
        }
        return { fd, path: bootstrapPath, sha256: digest };
    } catch (error) {
        closeSync(fd);
        throw error;
    }
}

/**
 * Open the staging destination through one retained descriptor and prove it is
 * an owner-only real directory. `O_NOFOLLOW` makes a symlink at `destDir` fail
 * the open instead of redirecting every path built beneath it, `O_DIRECTORY`
 * rejects a non-directory at the same name, and the owner and write-bit checks
 * reject an existing insecure directory — `mkdirSync` with a mode applies that
 * mode only when it creates the directory and never chmods one that is
 * already there.
 *
 * The proof binds to this descriptor. What it does NOT establish: Node exposes
 * no `openat`/`renameat`, so the temp create and the rename below still address
 * the destination by pathname and an attacker who can replace `destDir` or any
 * of its ancestors between this check and those operations is not excluded.
 * The identity re-check after the rename detects such a swap after the fact
 * rather than preventing it. Race-free staging requires component-wise
 * `openat(O_DIRECTORY|O_NOFOLLOW)` plus `renameat`, which lives in the native
 * layer.
 */
function openStagingDir(destDir: string, uid: number): number {
    let fd: number;
    try {
        fd = openSync(
            destDir,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        );
    } catch {
        throw invalid("staging destination is not an openable real directory");
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isDirectory()) throw invalid("staging destination is not a directory");
        if (stat.uid !== uid) throw invalid("staging destination has a foreign owner");
        if ((stat.mode & 0o022) !== 0) {
            throw invalid("staging destination is group/world writable");
        }
        return fd;
    } catch (error) {
        closeSync(fd);
        throw error;
    }
}

/**
 * Stage a package launcher into an owner-only digest-addressed bootstrap:
 * one O_NOFOLLOW source descriptor supplies both the hash and the copied
 * bytes (a hardlinked package-cache source is acceptable as bytes only),
 * output goes through an exclusive owner-only temp plus fsync plus atomic
 * rename, and the promoted object is completely revalidated before its
 * retained descriptor is returned. The destination is proved to be an
 * owner-only real directory through a retained descriptor before any output
 * exists, with the residual pathname race documented on
 * {@link openStagingDir}. Capacity is preflighted with the checked reserve
 * before the temp is created; post-preflight failures remove only the owned
 * temp.
 */
export function stageBootstrap(options: {
    sourcePath: string;
    destDir: string;
    expectedSha256: string;
    availableBytesOverride?: bigint;
}): RetainedBootstrap {
    const { sourcePath, destDir, expectedSha256 } = options;
    if (!SHA256_HEX.test(expectedSha256)) throw invalid("expected digest is noncanonical");
    // The uid is resolved before the first filesystem effect so a host that
    // cannot report one fails without creating the destination or a temp.
    const uid = currentUid();
    let sourceFd: number;
    try {
        sourceFd = openSync(
            sourcePath,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
    } catch {
        throw new BootstrapError("native_payload_missing", "launcher source is not openable");
    }
    let tempPath: string | null = null;
    let destFd: number | null = null;
    try {
        const before = fstatSync(sourceFd);
        if (!before.isFile()) throw invalid("launcher source is not a regular file");
        mkdirSync(destDir, { recursive: true, mode: 0o700 });
        destFd = openStagingDir(destDir, uid);
        const destBefore = fstatSync(destFd);
        const capacity = checkCapacity(
            BigInt(before.size),
            options.availableBytesOverride ?? availableBytesFor(destDir),
        );
        if (!capacity.ok) throw new BootstrapError(capacity.reason, capacity.detail);
        tempPath = path.join(
            destDir,
            `.staging-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
        );
        const outFd = openSync(
            tempPath,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
            0o700,
        );
        const hash = createHash("sha256");
        try {
            const buffer = Buffer.alloc(64 * 1024);
            let position = 0;
            for (;;) {
                const read = readSync(sourceFd, buffer, 0, buffer.length, position);
                if (read === 0) break;
                hash.update(buffer.subarray(0, read));
                let written = 0;
                while (written < read) {
                    written += writeSync(outFd, buffer, written, read - written);
                }
                position += read;
            }
            const digest = hash.digest("hex");
            if (digest !== expectedSha256) throw invalid("launcher source digest mismatch");
            const after = fstatSync(sourceFd);
            if (
                after.ino !== before.ino ||
                after.dev !== before.dev ||
                after.size !== before.size ||
                after.mtimeMs !== before.mtimeMs
            ) {
                throw invalid("launcher source mutated during staging");
            }
            fchmodSync(outFd, 0o500);
            fsyncSync(outFd);
        } finally {
            closeSync(outFd);
        }
        const finalPath = path.join(destDir, expectedSha256);
        renameSync(tempPath, finalPath);
        tempPath = null;
        // The retained descriptor is the identity the checks above certified,
        // so comparing it against the path now reports a destination that was
        // swapped while the pathname-addressed temp and rename ran.
        const destAfter = lstatSync(destDir);
        if (destAfter.dev !== destBefore.dev || destAfter.ino !== destBefore.ino) {
            throw invalid("staging destination identity drifted during staging");
        }
        fsyncSync(destFd);
        return revalidateRetainedBootstrap(finalPath, expectedSha256);
    } finally {
        closeSync(sourceFd);
        if (destFd !== null) closeSync(destFd);
        if (tempPath !== null) {
            try {
                unlinkSync(tempPath);
            } catch {
                // temp removal is best-effort; the exclusive name is unreachable
            }
        }
    }
}
