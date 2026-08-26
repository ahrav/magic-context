import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { HoldoutContractError, array, exact, fail, hex64, record, staticId } from "./contract";

export const RELEASE_ROOT_SCHEMA = "prospective-release-root/v1";
export const RELEASE_FILE_KINDS = ["source", "lockfile", "artifact", "runtime", "harness"] as const;
export type ReleaseFileKind = (typeof RELEASE_FILE_KINDS)[number];

export interface ReleaseRootFile {
    path: string;
    digest: string;
    kind: ReleaseFileKind;
}

export interface ReleaseRootManifest {
    schema: typeof RELEASE_ROOT_SCHEMA;
    releaseId: string;
    channel: string;
    platform: string;
    immutableReference: string;
    files: ReleaseRootFile[];
    sourceFingerprint: string;
    lockfileFingerprint: string;
    artifactFingerprint: string;
    runtimeFingerprint: string;
    harnessFingerprint: string;
    rootFingerprint: string;
    entrypoints: {
        opencodePlugin: string;
        piPlugin: string;
        rustHost: string;
        databaseTemplate: string;
    };
}

export interface VerifiedReleaseRoot {
    readonly root: string;
    readonly manifest: ReleaseRootManifest;
    readonly observedRootFingerprint: string;
}

const ROOT_PATH_RE = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

function releasePath(value: unknown, label: string): string {
    const path = staticId(value, label, ROOT_PATH_RE);
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) fail(`${label}: path-invalid`);
    return path;
}

function fileDigest(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function kindFingerprint(files: readonly ReleaseRootFile[], kind: ReleaseFileKind): string {
    return canonicalFingerprint(
        files.filter((file) => file.kind === kind).map(({ path, digest }) => ({ path, digest })),
    );
}

export function parseReleaseRootManifest(raw: unknown): ReleaseRootManifest {
    const value = record(raw, "release-root");
    exact(value, [
        "schema",
        "releaseId",
        "channel",
        "platform",
        "immutableReference",
        "files",
        "sourceFingerprint",
        "lockfileFingerprint",
        "artifactFingerprint",
        "runtimeFingerprint",
        "harnessFingerprint",
        "rootFingerprint",
        "entrypoints",
    ], "release-root");
    if (value.schema !== RELEASE_ROOT_SCHEMA) fail("release-root.schema: version-invalid");
    const files = array(value.files, "release-root.files").map((entry, index) => {
        const label = `release-root.files[${index}]`;
        const file = record(entry, label);
        exact(file, ["path", "digest", "kind"], label);
        if (!RELEASE_FILE_KINDS.includes(file.kind as ReleaseFileKind)) fail(`${label}.kind: enum-invalid`);
        return {
            path: releasePath(file.path, `${label}.path`),
            digest: hex64(file.digest, `${label}.digest`),
            kind: file.kind as ReleaseFileKind,
        };
    });
    if (files.length === 0) fail("release-root.files: empty");
    if (new Set(files.map((file) => file.path)).size !== files.length) fail("release-root.files: duplicate-path");
    for (const kind of RELEASE_FILE_KINDS) {
        if (!files.some((file) => file.kind === kind)) fail(`release-root.files: missing-${kind}`);
    }
    const entrypoints = record(value.entrypoints, "release-root.entrypoints");
    exact(entrypoints, ["opencodePlugin", "piPlugin", "rustHost", "databaseTemplate"], "release-root.entrypoints");
    const parsed: ReleaseRootManifest = {
        schema: RELEASE_ROOT_SCHEMA,
        releaseId: staticId(value.releaseId, "release-root.releaseId", /^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
        channel: staticId(value.channel, "release-root.channel"),
        platform: staticId(value.platform, "release-root.platform"),
        immutableReference: staticId(value.immutableReference, "release-root.immutableReference", /^[a-z0-9]+:[0-9a-f]{40,64}$/),
        files,
        sourceFingerprint: hex64(value.sourceFingerprint, "release-root.sourceFingerprint"),
        lockfileFingerprint: hex64(value.lockfileFingerprint, "release-root.lockfileFingerprint"),
        artifactFingerprint: hex64(value.artifactFingerprint, "release-root.artifactFingerprint"),
        runtimeFingerprint: hex64(value.runtimeFingerprint, "release-root.runtimeFingerprint"),
        harnessFingerprint: hex64(value.harnessFingerprint, "release-root.harnessFingerprint"),
        rootFingerprint: hex64(value.rootFingerprint, "release-root.rootFingerprint"),
        entrypoints: {
            opencodePlugin: releasePath(entrypoints.opencodePlugin, "release-root.entrypoints.opencodePlugin"),
            piPlugin: releasePath(entrypoints.piPlugin, "release-root.entrypoints.piPlugin"),
            rustHost: releasePath(entrypoints.rustHost, "release-root.entrypoints.rustHost"),
            databaseTemplate: releasePath(entrypoints.databaseTemplate, "release-root.entrypoints.databaseTemplate"),
        },
    };
    const declared = new Set(files.map((file) => file.path));
    for (const [name, path] of Object.entries(parsed.entrypoints)) {
        if (!declared.has(path)) fail(`release-root.entrypoints.${name}: undeclared`);
    }
    for (const kind of RELEASE_FILE_KINDS) {
        const key = `${kind}Fingerprint` as keyof Pick<
            ReleaseRootManifest,
            "sourceFingerprint" | "lockfileFingerprint" | "artifactFingerprint" | "runtimeFingerprint" | "harnessFingerprint"
        >;
        if (parsed[key] !== kindFingerprint(files, kind)) fail(`release-root.${key}: mismatch`);
    }
    if (parsed.rootFingerprint !== canonicalFingerprint(files.map(({ path, digest, kind }) => ({ path, digest, kind })))) {
        fail("release-root.rootFingerprint: mismatch");
    }
    return parsed;
}

function listFiles(root: string, current = root): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
        const absolute = resolve(current, entry.name);
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new HoldoutContractError(["release-root: symlink-rejected"]);
        if (stat.isDirectory()) found.push(...listFiles(root, absolute));
        else if (stat.isFile()) found.push(relative(root, absolute).split(sep).join("/"));
        else throw new HoldoutContractError(["release-root: irregular-entry"]);
    }
    return found.sort();
}

function inside(candidate: string, parent: string): boolean {
    const relation = relative(parent, candidate);
    return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function verifyReleaseRoot(
    rootPath: string,
    rawManifest: unknown,
    options: { expectedRootFingerprint: string; activeCheckout: string },
): VerifiedReleaseRoot {
    const root = realpathSync(rootPath);
    const activeCheckout = realpathSync(options.activeCheckout);
    if (inside(root, activeCheckout)) throw new HoldoutContractError(["release-root: active-checkout-forbidden"]);
    const manifest = parseReleaseRootManifest(rawManifest);
    if (manifest.rootFingerprint !== options.expectedRootFingerprint) {
        throw new HoldoutContractError(["release-root: untrusted-root-fingerprint"]);
    }
    const actualPaths = listFiles(root);
    const expectedPaths = manifest.files.map((file) => file.path).sort();
    if (canonicalFingerprint(actualPaths) !== canonicalFingerprint(expectedPaths)) {
        throw new HoldoutContractError(["release-root: file-set-mismatch"]);
    }
    for (const file of manifest.files) {
        const absolute = resolve(root, file.path);
        if (!inside(absolute, root) || fileDigest(absolute) !== file.digest) {
            throw new HoldoutContractError(["release-root: byte-mismatch"]);
        }
    }
    return { root, manifest, observedRootFingerprint: manifest.rootFingerprint };
}

export function releaseRootPath(root: VerifiedReleaseRoot, entrypoint: keyof ReleaseRootManifest["entrypoints"]): string {
    verifyReleaseRoot(root.root, root.manifest, {
        expectedRootFingerprint: root.observedRootFingerprint,
        activeCheckout: resolve(import.meta.dir, "../../../.."),
    });
    return resolve(root.root, root.manifest.entrypoints[entrypoint]);
}

export function assertDistinctReleaseRoots(left: VerifiedReleaseRoot, right: VerifiedReleaseRoot): void {
    if (left.manifest.releaseId === right.manifest.releaseId && left.observedRootFingerprint !== right.observedRootFingerprint) {
        throw new HoldoutContractError(["release-root-pair: release-id-byte-mismatch"]);
    }
    if (left.root === right.root) throw new HoldoutContractError(["release-root-pair: mixed-root"]);
    const leftDigests = [...new Set(left.manifest.files.map((file) => file.digest))].sort();
    const rightDigests = [...new Set(right.manifest.files.map((file) => file.digest))].sort();
    if (canonicalFingerprint(leftDigests) === canonicalFingerprint(rightDigests)) {
        throw new HoldoutContractError(["release-root-pair: identical-file-digests"]);
    }
}
