import { createHash } from "node:crypto";
import {
    closeSync,
    constants as fsConstants,
    fstatSync,
    openSync,
    readFileSync,
    readSync,
} from "node:fs";
import { join } from "node:path";
import {
    BootstrapError,
    type RetainedBootstrap,
    resolvePayloadPackageDir,
    revalidateRetainedBootstrap,
    stageBootstrap,
    type TrustIndex,
    type TrustIndexEntry,
} from "./bootstrap";
import { releaseContract } from "./generated-contract";
import { managedSubtreePath } from "./paths";

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_METADATA_BYTES = 1024 * 1024;
const LAUNCHER_REL_PATH = "payload/bin/ck-mc-host";

export type PayloadTarget = "linux-x64-gnu";

export type PayloadTrustIndexEntry = TrustIndexEntry;
export type PayloadTrustIndex = TrustIndex;

export interface PreparedManagedLaunchTarget {
    kind: "retained-fd";
    fd: number;
    retained: RetainedBootstrap;
    payloadManifestDigest: string;
    payloadDir?: string;
}

export interface PrepareManagedLaunchTargetOptions {
    dataRoot: string;
    declaringParentRoot: string;
    target: PayloadTarget;
    trustIndex: PayloadTrustIndex;
    allowPackageLookup: boolean;
    explicitExternalRoot?: string;
}

export type ResolveManagedPayloadDirOptions = Omit<
    PrepareManagedLaunchTargetOptions,
    "dataRoot" | "allowPackageLookup"
>;

function fail(message: string): never {
    throw new BootstrapError("native_payload_invalid", message);
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        // Code-point sort: deterministic across runtimes/locales.
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            out[key] = sortKeys((value as Record<string, unknown>)[key]);
        }
        return out;
    }
    return value;
}

/**
 * Byte-identical to `canonicalJson` in
 * `scripts/generate-mc-host-release-manifest.ts`: recursively key-sorted with
 * code-point ordering, 2-space indentation, arrays keeping their order. The
 * `payload_manifest_digest` in the parent trust index is produced by the build
 * over exactly these bytes (`scripts/build-mc-host-payload.ts`), so any
 * divergence here fails every qualified package closed. `owner.test.ts`
 * asserts agreement against the producer implementation.
 */
export function canonicalPayloadManifestJson(value: unknown): string {
    return JSON.stringify(sortKeys(value), null, 2);
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function verifyManifestFile(packageDir: string, raw: unknown, previous: string | null): string {
    const entry = record(raw, "payload manifest file");
    const path = entry.path;
    if (
        typeof path !== "string" ||
        !path.startsWith("payload/") ||
        path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
        (previous !== null && previous >= path) ||
        entry.type !== "file" ||
        !Number.isSafeInteger(entry.size) ||
        (entry.size as number) <= 0 ||
        (entry.mode !== "644" && entry.mode !== "755") ||
        typeof entry.sha256 !== "string" ||
        !SHA256_RE.test(entry.sha256)
    ) {
        fail("payload manifest file entry is invalid");
    }
    let fd: number;
    try {
        fd = openSync(
            join(packageDir, path),
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
    } catch {
        fail("payload file is not openable without following links");
    }
    try {
        const before = fstatSync(fd);
        if (
            !before.isFile() ||
            before.size !== entry.size ||
            (before.mode & 0o777) !== Number.parseInt(entry.mode, 8)
        ) {
            fail("payload file metadata does not match its manifest");
        }
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(128 * 1024);
        let position = 0;
        for (;;) {
            const count = readSync(fd, buffer, 0, buffer.length, position);
            if (count === 0) break;
            position += count;
            if (position > before.size) fail("payload file grew during verification");
            hash.update(buffer.subarray(0, count));
        }
        const after = fstatSync(fd);
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            position !== before.size ||
            hash.digest("hex") !== entry.sha256
        ) {
            fail("payload file bytes do not match its manifest");
        }
    } finally {
        closeSync(fd);
    }
    return path;
}

function readNoFollowJson(path: string, label: string): unknown {
    let fd: number;
    try {
        fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch {
        fail(`${label} is not an openable regular file`);
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_METADATA_BYTES) {
            fail(`${label} size or type is invalid`);
        }
        const text = readFileSync(fd, "utf8");
        return JSON.parse(text) as unknown;
    } catch (error) {
        if (error instanceof BootstrapError) throw error;
        fail(`${label} is malformed`);
    } finally {
        closeSync(fd);
    }
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function selectEntry(
    index: PayloadTrustIndex,
    target: PayloadTarget,
): PayloadTrustIndexEntry | null {
    if (
        index.schema !== "magic-context.mc-host-payload-index/v1" ||
        index.release.id !== releaseContract.release.id ||
        index.release.version !== releaseContract.release.version
    ) {
        fail("parent trust index release identity is invalid");
    }
    const matches = index.entries.filter((entry) => entry.target === target);
    if (matches.length !== 1) fail("parent trust index must contain one target entry");
    const entry = matches[0];
    if (entry === undefined) fail("parent trust index target entry disappeared");
    if (!entry.qualified) return null;
    if (
        entry.version !== releaseContract.release.version ||
        !releaseContract.packages.payloads.includes(
            entry.package as (typeof releaseContract.packages.payloads)[number],
        ) ||
        typeof entry.payload_manifest_digest !== "string" ||
        !SHA256_RE.test(entry.payload_manifest_digest) ||
        typeof entry.bootstrap_launcher_digest !== "string" ||
        !SHA256_RE.test(entry.bootstrap_launcher_digest)
    ) {
        fail("qualified parent trust entry is invalid");
    }
    return entry;
}

function bootstrapDir(dataRoot: string): string {
    return join(managedSubtreePath(dataRoot), "mc-host-bootstrap", releaseContract.release.version);
}

function retainedTarget(
    retained: RetainedBootstrap,
    payloadManifestDigest: string,
    payloadDir?: string,
): PreparedManagedLaunchTarget {
    return {
        kind: "retained-fd",
        fd: retained.fd,
        retained,
        payloadManifestDigest,
        ...(payloadDir === undefined ? {} : { payloadDir }),
    };
}

function verifyPackage(
    packageDir: string,
    entry: PayloadTrustIndexEntry & {
        payload_manifest_digest: string;
        bootstrap_launcher_digest: string;
    },
): string {
    const packageJson = record(
        readNoFollowJson(join(packageDir, "package.json"), "package.json"),
        "package.json",
    );
    if (packageJson.name !== entry.package || packageJson.version !== entry.version) {
        fail("payload package identity does not match parent trust");
    }
    const manifest = record(
        readNoFollowJson(join(packageDir, "payload-manifest.json"), "payload manifest"),
        "payload manifest",
    );
    if (
        manifest.schema !== "magic-context.mc-host-payload-manifest/v1" ||
        sha256(canonicalPayloadManifestJson(manifest)) !== entry.payload_manifest_digest
    ) {
        fail("payload manifest digest does not match parent trust");
    }
    const identity = record(manifest.package, "payload manifest package");
    if (
        identity.name !== entry.package ||
        identity.version !== entry.version ||
        identity.target !== entry.target ||
        manifest.launcher !== LAUNCHER_REL_PATH
    ) {
        fail("payload manifest identity does not match parent trust");
    }
    if (!Array.isArray(manifest.files)) fail("payload manifest files must be an array");
    let previous: string | null = null;
    for (const raw of manifest.files) {
        previous = verifyManifestFile(packageDir, raw, previous);
    }
    const launcher = manifest.files.find(
        (raw) =>
            raw !== null &&
            typeof raw === "object" &&
            (raw as Record<string, unknown>).path === LAUNCHER_REL_PATH,
    ) as Record<string, unknown> | undefined;
    if (launcher?.sha256 !== entry.bootstrap_launcher_digest) {
        fail("payload launcher digest does not match parent trust");
    }
    return join(packageDir, LAUNCHER_REL_PATH);
}

/**
 * Resolve one current-release launcher. Retained bootstrap validation always
 * runs first. Observational callers pass `allowPackageLookup:false`, making a
 * missing retained object a side-effect-free `null`; mutating callers may then
 * resolve one certified physical package and stage independent bytes.
 */
export function prepareManagedLaunchTarget(
    options: PrepareManagedLaunchTargetOptions,
): PreparedManagedLaunchTarget | null {
    const selected = selectEntry(options.trustIndex, options.target);
    if (selected === null) return null;
    const entry = selected as PayloadTrustIndexEntry & {
        payload_manifest_digest: string;
        bootstrap_launcher_digest: string;
    };
    const retainedPath = join(bootstrapDir(options.dataRoot), entry.bootstrap_launcher_digest);
    try {
        return retainedTarget(
            revalidateRetainedBootstrap(retainedPath, entry.bootstrap_launcher_digest),
            entry.payload_manifest_digest,
        );
    } catch (error) {
        if (!(error instanceof BootstrapError)) throw error;
        if (!options.allowPackageLookup) return null;
    }

    const payloadDir = resolveManagedPayloadDir({
        declaringParentRoot: options.declaringParentRoot,
        target: options.target,
        trustIndex: options.trustIndex,
        ...(options.explicitExternalRoot === undefined
            ? {}
            : { explicitExternalRoot: options.explicitExternalRoot }),
    });
    if (payloadDir === null) return null;
    const launcherPath = join(payloadDir, LAUNCHER_REL_PATH);
    return retainedTarget(
        stageBootstrap({
            sourcePath: launcherPath,
            destDir: bootstrapDir(options.dataRoot),
            expectedSha256: entry.bootstrap_launcher_digest,
        }),
        entry.payload_manifest_digest,
        payloadDir,
    );
}

export function resolveManagedPayloadDir(options: ResolveManagedPayloadDirOptions): string | null {
    const selected = selectEntry(options.trustIndex, options.target);
    if (selected === null) return null;
    const entry = selected as PayloadTrustIndexEntry & {
        payload_manifest_digest: string;
        bootstrap_launcher_digest: string;
    };
    const resolution = resolvePayloadPackageDir({
        declaringParentRoot: options.declaringParentRoot,
        packageName: entry.package,
        ...(options.explicitExternalRoot === undefined
            ? {}
            : { explicitExternalRoot: options.explicitExternalRoot }),
    });
    if (!resolution.ok) throw new BootstrapError(resolution.reason, resolution.detail);
    verifyPackage(resolution.packageDir, entry);
    return resolution.packageDir;
}
