/**
 * Pre-native trust pipeline: platform gate, retained-bootstrap revalidation,
 * certified physical install-layout resolution, trust-index verification, and
 * capacity-preflighted no-follow staging. Nothing in this module executes a
 * byte — it only decides whether a trusted launcher object exists and stages
 * one when the certified package path allows it. Every failure is one closed
 * lifecycle reason.
 */
import { type Hash } from "node:crypto";
import { releaseContract } from "./generated-contract";
export type LifecycleFailureReason = "unsupported_platform" | "unsupported_install_layout" | "native_payload_missing" | "native_payload_invalid" | "insufficient_storage" | "internal_error";
export declare class BootstrapError extends Error {
    readonly reason: LifecycleFailureReason;
    constructor(reason: LifecycleFailureReason, message: string);
}
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
/**
 * Whether this host can execute a retained payload through `/proc/self/fd`,
 * the Linux `procfs_self_fd_exec` capability the certified lane requires.
 *
 * Exported so qualification evidence records the same fact this gate decides:
 * a smoke report that omits it, or derives it some other way, describes a host
 * the platform gate never evaluated.
 */
export declare function detectProcSelfFd(): boolean;
export declare const defaultPlatformReaders: PlatformReaders;
export type PlatformGate = {
    ok: true;
    target: "linux-x64-gnu" | "darwin-arm64" | "darwin-x64";
} | {
    ok: false;
    reason: "unsupported_platform";
    detail: string;
};
/**
 * Enforce the exact release-contract target table: Linux x64 with kernel and
 * glibc at or above their floors plus usable procfs self-fd execution, or
 * macOS at or above its floor. Unknown, below-floor, and UNVERIFIABLE hosts
 * (a null glibc or macOS version) are all `unsupported_platform` — the gate
 * never guesses in favor of execution.
 */
export declare function checkPlatform(readers?: PlatformReaders): PlatformGate;
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
    release: {
        id: string;
        version: string;
    };
    entries: TrustIndexEntry[];
}
/** Byte cap for the trust index; an oversize file is invalid, not truncated. */
export declare const MAX_TRUST_INDEX_BYTES: number;
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
export declare function loadTrustIndex(indexPath: string): TrustIndex | null;
export declare function parseTrustIndex(parsed: unknown): TrustIndex;
export type LayoutResolution = {
    ok: true;
    layout: (typeof releaseContract.install_layouts)[number];
    packageDir: string;
} | {
    ok: false;
    reason: "unsupported_install_layout" | "native_payload_missing";
    detail: string;
};
/**
 * Resolve the exact payload package from the lexical declaring-parent root:
 * the nested `node_modules/<pkg>` path, a hoisted sibling `node_modules`
 * within eight lexical parent segments, one Bun package-manager symlink that
 * resolves under the SAME install's `node_modules/.bun/.../node_modules/`,
 * or an explicit external compiled-host root. No importer, cwd, global
 * store, or unrelated ancestor is ever consulted, so nothing here can
 * trigger an auto-install.
 */
export declare function resolvePayloadPackageDir(options: {
    declaringParentRoot: string;
    packageName: string;
    /** Compiled-Bun external root; checked before lexical walking. */
    explicitExternalRoot?: string;
}): LayoutResolution;
/**
 * Prove `candidate` still resolves to somewhere inside `root`'s own tree.
 *
 * {@link classifyEntry} lstats only the final component, so by the time it
 * answers `"dir"` the kernel has already followed every ancestor: a
 * `node_modules`, scope directory, or `.bun` entry replaced by a symlink to a
 * different install yields a final component that looks like a real directory
 * belonging to this one. That defeats one level up the same cross-install
 * redirection the symlink branch rejects at the final component.
 *
 * Canonical *equality* would be the wrong test. macOS resolves `/var` to
 * `/private/var` and symlinked home directories are common, so requiring the
 * resolved path to equal the literal one would reject benign installs.
 * Containment is the property actually needed: wherever the declaring parent's
 * tree really lives, the payload must be inside it.
 *
 * A resolution failure is not containment. This is a check-then-use, so an
 * ancestor swapped afterwards is still not excluded — that needs the `*at`
 * syscalls Node does not expose, and belongs to the native layer.
 */
export declare function containedWithin(root: string, candidate: string): boolean;
export type CapacityVerdict = {
    ok: true;
} | {
    ok: false;
    reason: "insufficient_storage" | "native_payload_invalid";
    detail: string;
};
/**
 * `available >= required + max(256 MiB, ceil(required * 10%))` with checked
 * arithmetic: a negative, non-integral, or implausibly large requirement is
 * `native_payload_invalid`, and a true shortfall is `insufficient_storage`.
 */
export declare function checkCapacity(requiredBytes: bigint, availableBytes: bigint): CapacityVerdict;
export declare function availableBytesFor(dirPath: string): bigint;
export interface RetainedBootstrap {
    /** Open O_NOFOLLOW read descriptor for the verified launcher object. */
    fd: number;
    path: string;
    sha256: string;
}
/**
 * Copy exactly `expectedBytes` from `sourceFd` to `outFd`, hashing as it goes,
 * and prove the source was neither longer nor shorter than that.
 *
 * The byte count is the one capacity was preflighted against. Following the
 * live EOF instead would let a source still being appended to drag the copy
 * past the reserve `checkCapacity` approved — without bound, since a writer
 * that never stops appending means `readSync` never returns 0 and staging
 * never returns.
 *
 * The digest cannot stand in for either check: it is computed over whatever was
 * actually read, so a grown source yields a mismatch that reads as corruption
 * rather than as the concurrent mutation it is. Reaching EOF early is the same
 * event seen from the other side.
 */
export declare function copyExactBytes(sourceFd: number, outFd: number, expectedBytes: number, hash: Hash): void;
/**
 * Complete revalidation of a retained digest-addressed bootstrap: owner-only
 * regular file, single link, owner-executable, and byte-for-byte digest
 * match through one retained O_NOFOLLOW descriptor whose identity is checked
 * against the path before AND after hashing. Any failure closes the
 * descriptor and throws; a failed retained object is never executed and
 * never causes fallback to a different generation.
 */
export declare function revalidateRetainedBootstrap(bootstrapPath: string, expectedSha256: string): RetainedBootstrap;
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
export declare function stageBootstrap(options: {
    sourcePath: string;
    destDir: string;
    expectedSha256: string;
    availableBytesOverride?: bigint;
}): RetainedBootstrap;
//# sourceMappingURL=bootstrap.d.ts.map