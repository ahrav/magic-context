/**
 * This module verifies and stages trusted launchers but never executes them.
 * lifecycle reason.
 */

import { execFileSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
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
 * currentUid returns the uid required by every ownership check.
 * Hosts without process.getuid cannot verify file ownership.
 * Callers invoke currentUid before filesystem effects.
 */
function currentUid(): number {
    if (typeof process.getuid !== "function") {
        throw new BootstrapError("unsupported_platform", "cannot determine process uid");
    }
    return process.getuid();
}

// ---------------------------------------------------------------------------
// The platform gate runs before any package byte is opened.
// ---------------------------------------------------------------------------

export interface PlatformReaders {
    platform: NodeJS.Platform;
    arch: string;
    /** Kernel release, e.g. `5.10.220-x`. */
    kernelRelease: () => string;
    /** glibc runtime version, e.g. `2.34`, or null when unverifiable. */
    glibcVersion: () => string | null;
    /** True when `readlinkSync(`/proc/self/fd/${fd}`)` returns a nonempty target. */
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
    }
    return null;
}

/**
 * `detectProcSelfFd` reports whether `/proc/self/fd/<fd>` resolves for a descriptor opened by this check.
 *
 */
export function detectProcSelfFd(): boolean {
    // Probe a descriptor opened by this check because fd 0 reflects the caller's stdin state.
    let fd: number | null = null;
    try {
        fd = openSync("/", fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
        return readlinkSync(`/proc/self/fd/${fd}`).length > 0;
    } catch {
        return false;
    } finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // The probe descriptor's close is best-effort because a close error cannot change the already-decided capability answer.
            }
        }
    }
}

const MACOS_SYSTEM_VERSION_PLIST = "/System/Library/CoreServices/SystemVersion.plist";
const MACOS_PRODUCT_VERSION_SHAPE = /^\d+(?:\.\d+)*$/;

/**
 * `checkPlatform` compares the macOS `ProductVersion` against the contract's `os_min` floor.
 *
 * The system plist avoids a subprocess; an unreadable or invalid plist falls back to `sw_vers`.
 * `os.release()` reports the Darwin kernel version, not the product version used by `os_min`.
 * Any detection failure returns `null`.
 * `checkPlatform` treats a `null` version as unsupported.
 */
function detectMacosProductVersion(): string | null {
    try {
        const plist = readFileSync(MACOS_SYSTEM_VERSION_PLIST, "utf8");
        const match = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
        const version = match?.[1]?.trim();
        if (version !== undefined && MACOS_PRODUCT_VERSION_SHAPE.test(version)) return version;
    } catch {
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

// Cache the detected product version to avoid repeated plist reads and `sw_vers` spawns.
// `undefined` denotes an undetected version; `null` caches a failed detection.
// host that fails detection does not retry the spawn on every command.
let cachedMacosProductVersion: string | null | undefined;

function memoizedMacosProductVersion(): string | null {
    if (cachedMacosProductVersion === undefined) {
        cachedMacosProductVersion = detectMacosProductVersion();
    }
    return cachedMacosProductVersion;
}

export const defaultPlatformReaders: PlatformReaders = {
    platform: process.platform,
    arch: process.arch,
    kernelRelease: () => os.release(),
    glibcVersion: detectGlibcVersion,
    procSelfFdUsable: detectProcSelfFd,
    // `checkPlatform`'s darwin branch alone pays the plist read or the `sw_vers` fallback.
    macosProductVersion: memoizedMacosProductVersion,
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
// The parent owns the payload trust index.
// ---------------------------------------------------------------------------

export interface TrustIndexEntry {
    package: string;
    version: string;
    target: string;
    qualified: boolean;
    payload_manifest_digest: string | null;
    bootstrap_launcher_digest: string | null;
}

export interface TrustIndex {
    schema: "magic-context.mc-host-payload-index/v1";
    release: { id: string; version: string };
    entries: TrustIndexEntry[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The loader rejects an oversize trust index instead of truncating it. */
export const MAX_TRUST_INDEX_BYTES = 1024 * 1024;

/**
 * The descriptor read extends one byte past the cap to detect oversize content without trusting invalidatable metadata.
 * A concurrent writer can invalidate `fstat` size metadata before the descriptor read.
 */
function readTrustIndexText(fd: number, expectedBytes: number): string {
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
    // A read count different from the `fstat`-validated `expectedBytes` indicates a rewrite between `fstat` and `read`.
    // A truncating rewrite can preserve dev/ino yet decode as a shorter, parseable document.
    if (total !== expectedBytes) {
        throw new BootstrapError(
            "native_payload_invalid",
            "trust index changed size during the read",
        );
    }
    // Fatal UTF-8 decoding rejects invalid bytes; `toString("utf8")` substitutes U+FFFD.
    // `toString("utf8")` can substitute U+FFFD for invalid bytes, allowing byte-corrupt JSON to pass shape checks.
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
    } catch {
        throw new BootstrapError("native_payload_invalid", "trust index is not valid UTF-8");
    }
}

/**
 * `null` means opening `indexPath` failed with `ENOENT`.
 * a present-but-invalid index is `native_payload_invalid`, never a fallback.
 *
 * The loader reads and validates one descriptor so path replacement cannot separate the metadata checks from the bytes read.
 * The loader requires a single-link regular file owned by the current UID with no group- or other-write bit.
 * Schema validation does not establish the index's provenance.
 */
export function loadTrustIndex(indexPath: string): TrustIndex | null {
    const uid = currentUid();
    let fd: number;
    try {
        fd = openSync(
            indexPath,
            // `O_NOFOLLOW` makes opening a symlink at this path fail rather than follow it.
            // O_NONBLOCK prevents a FIFO open from blocking until a writer appears; the regular-file check rejects the descriptor afterward.
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
        text = readTrustIndexText(fd, before.size);
        // `lstatSync(indexPath)` can fail after the descriptor read if the index is unlinked or an ancestor loses search permission.
        // The loader rejects a vanished index because it cannot reconfirm the descriptor's path identity.
        let after: ReturnType<typeof lstatSync>;
        try {
            after = lstatSync(indexPath);
        } catch {
            throw new BootstrapError(
                "native_payload_invalid",
                "trust index identity could not be reconfirmed after the read",
            );
        }
        if (after.dev !== before.dev || after.ino !== before.ino) {
            throw new BootstrapError(
                "native_payload_invalid",
                "trust index identity drifted during the read",
            );
        }
        // Matching `dev` and `ino` proves that `indexPath` still names the opened file, but not that its contents are unchanged.
        //
        // A same-length rewrite within one timestamp granule evades the size-and-mtime check.
        const afterFd = fstatSync(fd);
        if (afterFd.size !== before.size || afterFd.mtimeMs !== before.mtimeMs) {
            throw new BootstrapError(
                "native_payload_invalid",
                "trust index was rewritten during the read",
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
    return parseTrustIndex(parsed);
}

export function parseTrustIndex(parsed: unknown): TrustIndex {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new BootstrapError("native_payload_invalid", "trust index is not an object");
    }
    const record = parsed as Record<string, unknown>;
    if (
        record.schema !== "magic-context.mc-host-payload-index/v1" ||
        !Array.isArray(record.entries)
    ) {
        throw new BootstrapError("native_payload_invalid", "trust index shape or release mismatch");
    }
    const release =
        typeof record.release === "object" && record.release !== null
            ? (record.release as Record<string, unknown>)
            : null;
    if (
        release?.id !== releaseContract.release.id ||
        release.version !== releaseContract.release.version
    ) {
        throw new BootstrapError("native_payload_invalid", "trust index release mismatch");
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
        const qualified = entry.qualified;
        if (typeof qualified !== "boolean") {
            throw new BootstrapError(
                "native_payload_invalid",
                "trust index qualification is invalid",
            );
        }
        const payloadDigest = entry.payload_manifest_digest;
        const launcherDigest = entry.bootstrap_launcher_digest;
        if (
            qualified &&
            (typeof payloadDigest !== "string" ||
                !SHA256_HEX.test(payloadDigest) ||
                typeof launcherDigest !== "string" ||
                !SHA256_HEX.test(launcherDigest))
        ) {
            throw new BootstrapError(
                "native_payload_invalid",
                "qualified trust-index digest is noncanonical",
            );
        }
        if (!qualified && (payloadDigest !== null || launcherDigest !== null)) {
            throw new BootstrapError(
                "native_payload_invalid",
                "unqualified trust-index entry carries a digest",
            );
        }
        return {
            package: requireString("package"),
            version: requireString("version"),
            target: requireString("target"),
            qualified,
            payload_manifest_digest: payloadDigest as string | null,
            bootstrap_launcher_digest: launcherDigest as string | null,
        };
    });
    return {
        schema: "magic-context.mc-host-payload-index/v1",
        release: {
            id: release.id as string,
            version: release.version as string,
        },
        entries,
    };
}

// ---------------------------------------------------------------------------
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
 * The classifier returns `absent` only for genuine absence.
 * Only absence permits the hoist walk to continue past a candidate.
 * `EACCES` and `ELOOP` do not establish absence.
 * Descriptor exhaustion and I/O faults mean a nearer candidate may exist but cannot be certified.
 * Classifying those faults as absence would allow a more distant ancestor package to win.
 * `ENOTDIR` is absence because a non-directory ancestor cannot contain the candidate.
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
 * The resolver derives the payload package from the lexical declaring-parent root.
 * The resolver accepts nested and hoisted `node_modules/<pkg>` paths.
 * The resolver searches at most eight lexical parent segments and accepts one Bun package-manager symlink.
 * The Bun package-manager symlink must resolve under the same install's `node_modules/.bun/.../node_modules/`.
 * The resolver also accepts an explicit external compiled-host root.
 * The resolver never consults an importer, the cwd, a global store, or an unrelated ancestor.
 * The resolver cannot trigger an auto-install.
 */
export function resolvePayloadPackageDir(options: {
    declaringParentRoot: string;
    packageName: string;
    /* */
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
            if (!containedWithin(options.explicitExternalRoot, externalCandidate)) {
                return {
                    ok: false,
                    reason: "unsupported_install_layout",
                    detail: "external payload directory resolves outside its declared root",
                };
            }
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
            // A real directory that resolves outside this install is a foreign payload reached through a symlinked ancestor.
            // A foreign payload does not permit climbing; only absence does.
            // absence does.
            if (!containedWithin(current, candidate)) {
                return {
                    ok: false,
                    reason: "unsupported_install_layout",
                    detail: "payload directory resolves outside the declaring install",
                };
            }
            return {
                ok: true,
                layout: depth === 0 ? "npm_nested" : "npm_hoisted",
                packageDir: candidate,
            };
        }
        if (kind === "symlink") {
            const bunLayout = resolveBunLink(current, nodeModules, candidate, segments);
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

/**
 * The resolver must prove that `candidate` resolves inside `root`'s tree.
 *
 * A final-component `lstat` cannot detect symlinked ancestors.
 * Before returning `"dir"`, the kernel has followed every ancestor.
 * A symlinked `node_modules`, scope directory, or `.bun` entry can redirect resolution to another install.
 * The final component can appear as a non-symlink directory after an ancestor redirects resolution.
 * Ancestor-symlink redirection bypasses the final-component symlink check.
 * The containment check prevents cross-install redirection through an ancestor symlink.
 *
 * Ancestor symlinks can make a resolved path differ from its literal path.
 * Literal-path equality would reject installs whose paths resolve through ancestor symlinks.
 * `candidate` must resolve within `root`'s realpath tree.
 *
 * A `realpathSync` failure cannot establish containment.
 * An ancestor replacement after these `realpathSync` calls can still redirect subsequent use.
 * Node lacks the `*at` syscalls required to prevent ancestor replacement between resolution and use.
 */
export function containedWithin(root: string, candidate: string): boolean {
    let realRoot: string;
    let realCandidate: string;
    try {
        realRoot = realpathSync(root);
        realCandidate = realpathSync(candidate);
    } catch {
        return false;
    }
    // `path.relative` distinguishes descendants from siblings without string-prefix edge cases.
    // Do not use a separator-appended string prefix: `/` becomes `//` and rejects descendants.
    // `path.relative` handles roots, trailing separators, and `..` uniformly.
    const relative = path.relative(realRoot, realCandidate);
    if (relative === "") return true;
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveBunLink(
    walkRoot: string,
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
    // The Bun store must resolve under the install being walked; otherwise a symlinked `node_modules` or `.bun` can certify an attacker-controlled store.
    if (!containedWithin(walkRoot, bunStoreReal)) return null;
    const withinStore = resolved.startsWith(`${bunStoreReal}${path.sep}`);
    // A bare suffix match accepts a sibling directory whose name merely ends in `node_modules`.
    const expectedSuffix = `${path.sep}${path.join("node_modules", ...segments)}`;
    if (!withinStore || !resolved.endsWith(expectedSuffix)) return null;
    return { ok: true, layout: "bun_physical_link", packageDir: resolved };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const RESERVE_FLOOR_BYTES = 256n * 1024n * 1024n;
const MAX_REASONABLE_REQUIRED = 1n << 60n;

export type CapacityVerdict =
    | { ok: true }
    | { ok: false; reason: "insufficient_storage" | "native_payload_invalid"; detail: string };

/**
 * `available` must be at least `required + max(256 MiB, ceil(required * 10%))`.
 * A negative or greater-than-2^60 `required` value yields `native_payload_invalid`.
 * A true capacity shortfall yields `insufficient_storage`.
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
// ---------------------------------------------------------------------------

export interface RetainedBootstrap {
    /** The launcher descriptor must use O_NOFOLLOW to reject a replacement symlink. */
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
 * The source must contain exactly `expectedBytes` bytes.
 *
 * A writer that continuously appends can prevent `readSync` from reaching EOF, so staging never returns.
 * never returns.
 *
 * A digest mismatch cannot distinguish concurrent source mutation from corruption because it covers only the bytes read.
 * The staging code rejects growth because hashing the copied prefix cannot detect appended bytes.
 * Early EOF indicates that the source shrank during staging.
 */
export function copyExactBytes(
    sourceFd: number,
    outFd: number,
    expectedBytes: number,
    hash: Hash,
): void {
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < expectedBytes) {
        const want = Math.min(buffer.length, expectedBytes - position);
        const read = readSync(sourceFd, buffer, 0, want, position);
        if (read === 0) throw invalid("launcher source shrank during staging");
        hash.update(buffer.subarray(0, read));
        let written = 0;
        while (written < read) {
            written += writeSync(outFd, buffer, written, read - written);
        }
        position += read;
    }
    // The staging code rejects bytes beyond `expectedBytes` because the copied bytes are only a prefix of the changed source.
    if (readSync(sourceFd, buffer, 0, 1, position) !== 0) {
        throw invalid("launcher source grew during staging");
    }
}

/**
 * Revalidation uses one retained `O_NOFOLLOW` descriptor and verifies its identity before and after hashing.
 * Revalidation uses one retained `O_NOFOLLOW` descriptor so the validated object is the object hashed.
 * Revalidation closes the retained descriptor before throwing on any revalidation failure.
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
            // `O_NONBLOCK` lets `openSync` return for a FIFO so `fstatSync` can reject it.
            // `O_NONBLOCK` does not affect regular-file reads.
            // are unaffected.
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
    } catch (error) {
        // Only `ENOENT` and `ENOTDIR` may report a retained bootstrap as missing.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new BootstrapError("native_payload_missing", "retained bootstrap is absent");
        }
        throw invalid("retained bootstrap is not openable");
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw invalid("retained bootstrap is not a regular file");
        if (stat.nlink !== 1) throw invalid("retained bootstrap is not single-link");
        if (stat.uid !== uid) throw invalid("retained bootstrap has a foreign owner");
        if ((stat.mode & 0o077) !== 0)
            throw invalid("retained bootstrap is group/world accessible");
        if ((stat.mode & 0o100) === 0) throw invalid("retained bootstrap is not owner-executable");
        // The code rejects owner-writable retained files because in-place writes can change bytes after hashing without changing inode identity.
        // An in-place overwrite can change bytes between `sha256OfFd` and execution without changing `dev` or `ino`.
        // preserves.
        //
        // The mode check does not make the retained file immutable because its owner can restore write permission after hashing.
        if ((stat.mode & 0o200) !== 0) throw invalid("retained bootstrap is owner-writable");
        const digest = sha256OfFd(fd);
        if (digest !== expectedSha256) throw invalid("retained bootstrap digest mismatch");
        // The post-hash path-addressed `stat` detects replacement or removal of the retained bootstrap path.
        // `lstatSync` failures report bootstrap identity reconfirmation failure instead of a raw errno.
        let after: ReturnType<typeof lstatSync>;
        try {
            after = lstatSync(bootstrapPath);
        } catch {
            throw invalid("retained bootstrap identity could not be reconfirmed");
        }
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
 * `O_NOFOLLOW` makes a symlink at `destDir` fail to open rather than redirecting paths beneath it.
 * `O_DIRECTORY` rejects a non-directory at `destDir`.
 * already there.
 *
 * The directory descriptor does not protect later pathname-based operations from directory replacement.
 * Staged creation and rename still address `destDir` by pathname.
 * An attacker can replace `destDir` or an ancestor between descriptor validation and pathname-based operations.
 * The post-rename identity check detects a directory swap but cannot prevent it.
 * Race-free staging requires component-wise `openat(O_DIRECTORY|O_NOFOLLOW)` and `renameat`.
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
 * The function stages a package launcher as an owner-only, digest-addressed bootstrap.
 * One `O_NOFOLLOW` source descriptor supplies both the hash and the copied bytes.
 * A hardlinked package-cache source is accepted only as a byte source.
 * The function completely revalidates the promoted object before returning its retained descriptor.
 * The function validates `destDir` as an owner-only real directory through a retained descriptor before creating output.
 * After preflight, failures remove only the owned temporary file.
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
    // The function resolves the UID before filesystem effects so hosts that cannot report one create neither the destination nor a temporary file.
    const uid = currentUid();
    let sourceFd: number;
    try {
        sourceFd = openSync(
            sourcePath,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
    } catch (error) {
        // Only `ENOENT` and `ENOTDIR` mean that the source is missing; safely unopenable sources are installed payload.
        // A source rejected by `O_NOFOLLOW` with `ELOOP` is installed payload, not missing.
        // Non-`ENOENT` and non-`ENOTDIR` source-open failures are `native_payload_invalid`.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new BootstrapError("native_payload_missing", "launcher source is absent");
        }
        throw invalid("launcher source is not openable");
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
            copyExactBytes(sourceFd, outFd, before.size, hash);
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
        // `destAfter` verifies that `destDir` still names the directory opened as `destFd`.
        const destAfter = lstatSync(destDir);
        if (destAfter.dev !== destBefore.dev || destAfter.ino !== destBefore.ino) {
            throw invalid("staging destination identity drifted during staging");
        }
        fsyncSync(destFd);
        return revalidateRetainedBootstrap(finalPath, expectedSha256);
    } catch (error) {
        // `BootstrapError` failures always carry a lifecycle reason.
        // `mkdirSync(destDir, { recursive: true })` throws `EEXIST` for a dangling `destDir` before `openStagingDir` can reject it.
        // Raw filesystem errors do not carry a lifecycle `reason`.
        if (error instanceof BootstrapError) throw error;
        const code = (error as { code?: string } | null)?.code;
        if (code === "ENOSPC" || code === "EDQUOT") {
            throw new BootstrapError("insufficient_storage", `staging failed: ${code}`);
        }
        throw invalid(`staging failed: ${code ?? "unknown filesystem error"}`);
    } finally {
        closeSync(sourceFd);
        if (destFd !== null) closeSync(destFd);
        if (tempPath !== null) {
            try {
                unlinkSync(tempPath);
            } catch {
            }
        }
    }
}
