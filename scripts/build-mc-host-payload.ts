/**
 * U6 native payload builder and post-build trust generator (KTD7, KTD9, KTD10,
 * KTD23, R20-R26, R30, R48, R50).
 *
 * Modes:
 *
 *   bun scripts/build-mc-host-payload.ts              # production payload build.
 *       Requires production-qualified U9 evidence (requireQualificationEvidence);
 *       fails closed today because release inputs are not production-qualified.
 *
 *   bun scripts/build-mc-host-payload.ts --check      # repo validation, no writes.
 *       Validates payload package metadata against the U8 contract, the canonical
 *       payload-manifest / trust-index / stop-provenance schemas, U8/U9 digest
 *       citations, parent optional dependencies, payload-before-parent publication
 *       ordering, and size budgets. Performs no publish and no parent pack.
 *
 *   bun scripts/build-mc-host-payload.ts --write-trust # regenerate the committed
 *       trust artifacts (release/mc-host-payload-index.json and
 *       release/mc-host-n-minus-one-stop.json) deterministically.
 *
 *   bun scripts/build-mc-host-payload.ts --dev [--out <dir>]
 *       Dev payload from the locally compiled ck-mc-host binary into an output
 *       directory (default tmp/mc-host-dev-payload), generating a real canonical
 *       payload manifest whose digest names the generation. Never a release input.
 *
 * Because production inputs are unqualified (U9 production_qualified: false), the
 * committed trust index is in a schema-valid but fail-closed state: every entry is
 * unpublished/unqualified with null digests, which consumers must reject before
 * executing any native byte. This is the first payload-bearing release, so the
 * committed stop-provenance record is the non-authorizing `genesis` tag (R48).
 */

import { createHash } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildContract,
    canonicalJson,
    type ReleaseContract,
    sha256Hex,
    validateStopProvenance,
} from "./generate-mc-host-release-manifest";
import {
    OUTPUT_PATHS as U9_OUTPUT_PATHS,
    requireQualificationEvidence,
} from "./qualify-mc-host-production-inputs";

function fail(message: string): never {
    throw new Error(`mc-host payload: ${message}`);
}

// ---------------------------------------------------------------------------
// Paths and target table.
// ---------------------------------------------------------------------------

export const OUTPUT_PATHS = {
    index: "release/mc-host-payload-index.json",
    stop: "release/mc-host-n-minus-one-stop.json",
} as const;

const RELEASE_CONTRACT_PATH = "release/mc-host-release.json";
const REGISTRY_GATE_PATH = "release/mc-host-registry-gate.json";
const PARENT_DIRS: Record<string, string> = {
    "@cortexkit/opencode-magic-context": "packages/plugin",
    "@cortexkit/pi-magic-context": "packages/pi-plugin",
    "@cortexkit/magic-context": "packages/cli",
};

export const LAUNCHER_PATH = "payload/bin/ck-mc-host";

/** Linux-only U9-gated production slots (R25). Corpus is a certification input,
 *  not a shipped file. Populated only from qualified locked bytes; never committed. */
export const LINUX_PRODUCTION_PAYLOAD_SLOTS: Record<string, string> = {
    ort_runtime: "payload/ort/libonnxruntime.so",
    model_onnx: "payload/model/gte-modernbert-base-f16/model.onnx",
    tokenizer: "payload/model/gte-modernbert-base-f16/tokenizer.json",
    tokenizer_config:
        "payload/model/gte-modernbert-base-f16/tokenizer_config.json",
    special_tokens_map:
        "payload/model/gte-modernbert-base-f16/special_tokens_map.json",
    config: "payload/model/gte-modernbert-base-f16/config.json",
};

export interface PayloadTarget {
    package: string;
    dir: string;
    target: string;
    os: string[];
    cpu: string[];
    libc?: string[];
    synapse: "certified_cpu" | "unsupported";
}

export const PAYLOAD_TARGETS: readonly PayloadTarget[] = [
    {
        package: "@cortexkit/mc-host-darwin-arm64",
        dir: "packages/mc-host-darwin-arm64",
        target: "darwin-arm64",
        os: ["darwin"],
        cpu: ["arm64"],
        synapse: "unsupported",
    },
    {
        package: "@cortexkit/mc-host-darwin-x64",
        dir: "packages/mc-host-darwin-x64",
        target: "darwin-x64",
        os: ["darwin"],
        cpu: ["x64"],
        synapse: "unsupported",
    },
    {
        package: "@cortexkit/mc-host-linux-x64-gnu",
        dir: "packages/mc-host-linux-x64-gnu",
        target: "linux-x64-gnu",
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
        synapse: "certified_cpu",
    },
] as const;

const SHA256_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"];

function isPlaceholderSha256(hash: string): boolean {
    return /^(.)\1{63}$/.test(hash);
}

// ---------------------------------------------------------------------------
// Release context: U8 contract + U9 citations + registry-gate reservations.
// ---------------------------------------------------------------------------

export interface ReleaseContext {
    contract: ReleaseContract;
    u8Digest: string;
    /** sha256 of the committed U9 lock file bytes. */
    lockSha256: string;
    lock: {
        production_qualified: boolean;
        package_size_limits_bytes: Record<
            string,
            { compressed_max: number; unpacked_max: number }
        >;
    };
    productionQualified: boolean;
    /** Inert non-GA reservation versions that can never be release ancestry (R50). */
    reservationVersions: string[];
}

function readJson(rootDir: string, relative: string): Record<string, unknown> {
    const path = join(rootDir, relative);
    if (!existsSync(path)) fail(`missing ${relative}`);
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        fail(
            `unreadable or malformed ${relative}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail(`${relative} must be a JSON object`);
    }
    // SAFETY: guarded above — parsed is a non-null, non-array object.
    return parsed as Record<string, unknown>;
}

/** Load and cross-verify the U8/U9 artifacts every U6 output cites (KTD7). */
export function loadReleaseContext(rootDir: string): ReleaseContext {
    const contract = buildContract();
    const canonicalContract = canonicalJson(contract);
    const u8Digest = sha256Hex(canonicalContract);
    const contractPath = join(rootDir, RELEASE_CONTRACT_PATH);
    if (!existsSync(contractPath))
        fail(`missing U8 release contract at ${RELEASE_CONTRACT_PATH}`);
    if (readFileSync(contractPath, "utf8") !== `${canonicalContract}\n`) {
        fail(
            `stale or edited U8 release contract at ${RELEASE_CONTRACT_PATH}; regenerate U8 first`,
        );
    }

    // U9 evidence citation check (digest citations, not qualification): the
    // evidence must cite the current U8 digest and the actual lock/credential
    // file bytes.
    const evidence = readJson(rootDir, U9_OUTPUT_PATHS.evidence) as Record<
        string,
        unknown
    >;
    if (
        evidence.schema !== "magic-context.mc-host-release-qualification/v1" ||
        evidence.release_contract_sha256 !== u8Digest
    ) {
        fail(
            `stale or unknown U9 qualification evidence at ${U9_OUTPUT_PATHS.evidence}`,
        );
    }
    const artifacts = evidence.artifacts as Record<
        string,
        { path?: unknown; sha256?: unknown }
    >;
    for (const [key, relative] of [
        ["production_inputs_lock", U9_OUTPUT_PATHS.lock],
        ["provider_credentials", U9_OUTPUT_PATHS.credentials],
    ] as const) {
        const cited = artifacts?.[key];
        if (cited?.path !== relative || typeof cited.sha256 !== "string") {
            fail(`malformed U9 artifact citation for ${key}`);
        }
        const actual = sha256Hex(readFileSync(join(rootDir, relative), "utf8"));
        if (actual !== cited.sha256)
            fail(`stale U9 artifact digest for ${relative}`);
    }
    const lockSha256 = artifacts.production_inputs_lock.sha256 as string;

    const lock = readJson(rootDir, U9_OUTPUT_PATHS.lock) as ReleaseContext["lock"] &
        Record<string, unknown>;
    if (
        lock.release_contract_sha256 !== u8Digest ||
        typeof lock.production_qualified !== "boolean"
    ) {
        fail(`stale U9 production-input lock at ${U9_OUTPUT_PATHS.lock}`);
    }
    if (lock.production_qualified !== evidence.production_qualified) {
        fail("U9 lock and evidence disagree on production qualification");
    }
    const limits = lock.package_size_limits_bytes;
    for (const target of PAYLOAD_TARGETS) {
        const limit = limits?.[target.package];
        if (
            !Number.isSafeInteger(limit?.compressed_max) ||
            !Number.isSafeInteger(limit?.unpacked_max) ||
            limit.compressed_max <= 0 ||
            limit.unpacked_max < limit.compressed_max
        ) {
            fail(`U9 lock lacks coherent size limits for ${target.package}`);
        }
    }

    const gate = readJson(rootDir, REGISTRY_GATE_PATH) as {
        packages?: { kind?: string; reservation_version?: string }[];
    };
    const reservationVersions = (gate.packages ?? [])
        .map((entry) => entry.reservation_version)
        .filter((version): version is string => typeof version === "string");
    if (reservationVersions.includes(contract.release.version)) {
        fail("release version collides with a reservation version (R50)");
    }

    return {
        contract,
        u8Digest,
        lockSha256,
        lock,
        productionQualified: lock.production_qualified === true,
        reservationVersions,
    };
}

// ---------------------------------------------------------------------------
// Canonical per-target payload manifest.
// ---------------------------------------------------------------------------

export interface PayloadFileEntry {
    path: string;
    type: "file";
    size: number;
    /** Octal permission string; launcher is "755", everything else "644". */
    mode: "644" | "755";
    sha256: string;
}

export interface PayloadManifest {
    schema: "magic-context.mc-host-payload-manifest/v1";
    release: { id: string; version: string };
    release_contract_sha256: string;
    production_inputs_lock_sha256: string;
    mode: "production" | "dev";
    package: { name: string; version: string; target: string };
    platform_floor: Record<string, unknown>;
    synapse: "certified_cpu" | "unsupported";
    launcher: string;
    files: PayloadFileEntry[];
}

/** The manifest digest that names a staged generation (KTD9). */
export function payloadManifestDigest(manifest: PayloadManifest): string {
    return sha256Hex(canonicalJson(manifest));
}

export function platformFloorFor(
    contract: ReleaseContract,
    target: string,
): Record<string, unknown> {
    const platform = contract.platforms.supported.find(
        (p) => p.target === target,
    );
    if (platform === undefined) fail(`unknown target ${target}`);
    if ("kernel_min" in platform) {
        return {
            kernel_min: platform.kernel_min,
            glibc_min: platform.glibc_min,
            procfs_self_fd_exec: platform.capabilities.procfs_self_fd_exec,
        };
    }
    return {
        os_min: platform.os_min,
        dev_fd_exec: platform.capabilities.dev_fd_exec,
    };
}

function assertExactKeys(
    obj: unknown,
    keys: string[],
    where: string,
): asserts obj is Record<string, unknown> {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        fail(`${where} must be an object`);
    }
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (!keys.includes(key)) fail(`${where}: unknown key ${key}`);
    }
    for (const key of keys) {
        if (!(key in record)) fail(`${where}: missing key ${key}`);
    }
}

const PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Relative, payload-rooted, traversal-free file path (R29/R30). */
export function assertSafePayloadPath(path: string): void {
    if (typeof path !== "string" || path.length === 0 || path.length > 512) {
        fail(`unsafe payload path ${JSON.stringify(path)}`);
    }
    if (path.includes("\\") || path.includes("\0")) {
        fail(`unsafe payload path ${JSON.stringify(path)}`);
    }
    const segments = path.split("/");
    if (segments[0] !== "payload" || segments.length < 2) {
        fail(`payload path must be payload-rooted: ${JSON.stringify(path)}`);
    }
    for (const segment of segments) {
        if (
            segment === "" ||
            segment === "." ||
            segment === ".." ||
            !PATH_SEGMENT_RE.test(segment)
        ) {
            fail(`unsafe payload path segment in ${JSON.stringify(path)}`);
        }
    }
}

/**
 * Validate one canonical per-target payload manifest against the release
 * context: schema, target identity, floor, launcher, file entries (sorted,
 * unique, traversal-free, real digests), Synapse byte rules, and the unpacked
 * size budget from the U9 lock.
 */
export function validatePayloadManifest(
    manifest: unknown,
    context: ReleaseContext,
): asserts manifest is PayloadManifest {
    assertExactKeys(
        manifest,
        [
            "schema",
            "release",
            "release_contract_sha256",
            "production_inputs_lock_sha256",
            "mode",
            "package",
            "platform_floor",
            "synapse",
            "launcher",
            "files",
        ],
        "payload manifest",
    );
    // SAFETY: assertExactKeys proved the exact PayloadManifest key set; every
    // field's type is validated below before use.
    const m = manifest as unknown as PayloadManifest;
    if (m.schema !== "magic-context.mc-host-payload-manifest/v1") {
        fail("unknown payload-manifest schema");
    }
    const { contract } = context;
    if (
        m.release?.id !== contract.release.id ||
        m.release?.version !== contract.release.version
    ) {
        fail("payload manifest must bind the current release identity");
    }
    if (m.release_contract_sha256 !== context.u8Digest) {
        fail("payload manifest cites a stale U8 contract digest");
    }
    if (m.production_inputs_lock_sha256 !== context.lockSha256) {
        fail("payload manifest cites a stale U9 input-lock digest");
    }
    if (m.mode !== "production" && m.mode !== "dev") {
        fail("payload manifest mode must be production or dev");
    }
    if (m.mode === "production" && !context.productionQualified) {
        fail(
            "production payload manifest requires production-qualified inputs (R26)",
        );
    }
    const target = PAYLOAD_TARGETS.find((t) => t.package === m.package?.name);
    if (target === undefined) {
        fail(`unknown payload package ${JSON.stringify(m.package?.name)}`);
    }
    if (
        m.package.version !== contract.release.version ||
        m.package.target !== target.target
    ) {
        fail(`payload manifest package identity mismatch for ${target.package}`);
    }
    if (
        canonicalJson(m.platform_floor) !==
        canonicalJson(platformFloorFor(contract, target.target))
    ) {
        fail(`payload manifest platform floor drift for ${target.target}`);
    }
    if (m.synapse !== target.synapse) {
        fail(`payload manifest Synapse claim mismatch for ${target.target}`);
    }
    if (m.launcher !== LAUNCHER_PATH) {
        fail(`payload manifest launcher must be ${LAUNCHER_PATH}`);
    }
    if (!Array.isArray(m.files) || m.files.length === 0) {
        fail("payload manifest must list at least the launcher");
    }
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const [index, entry] of m.files.entries()) {
        assertExactKeys(
            entry,
            ["path", "type", "size", "mode", "sha256"],
            `files[${index}]`,
        );
        assertSafePayloadPath(entry.path);
        if (seen.has(entry.path))
            fail(`duplicate payload file entry ${entry.path}`);
        seen.add(entry.path);
        if (index > 0 && m.files[index - 1].path >= entry.path) {
            fail("payload files must be sorted by path");
        }
        if (entry.type !== "file")
            fail(`files[${index}]: only regular files are allowed`);
        if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
            fail(`files[${index}]: size must be a positive integer`);
        }
        totalBytes += entry.size;
        const expectedMode = entry.path === LAUNCHER_PATH ? "755" : "644";
        if (entry.mode !== expectedMode) {
            fail(`files[${index}]: mode must be ${expectedMode}`);
        }
        if (
            typeof entry.sha256 !== "string" ||
            !SHA256_RE.test(entry.sha256) ||
            isPlaceholderSha256(entry.sha256)
        ) {
            fail(`files[${index}]: sha256 must be a real 64-hex digest`);
        }
    }
    // Exact allowed file set per target/mode (R25, plan scenario 8): dev payloads
    // and macOS payloads carry only the launcher; a Linux production payload
    // carries the launcher plus exactly the U9-gated ORT/model slots.
    const expectedPaths =
        m.mode === "production" && target.synapse === "certified_cpu"
            ? [
                  LAUNCHER_PATH,
                  ...Object.values(LINUX_PRODUCTION_PAYLOAD_SLOTS),
              ].sort()
            : [LAUNCHER_PATH];
    if (
        JSON.stringify([...seen].sort()) !== JSON.stringify(expectedPaths)
    ) {
        fail(
            `payload file set for ${target.target} (${m.mode}) must be exactly: ${expectedPaths.join(", ")}`,
        );
    }
    const limit = context.lock.package_size_limits_bytes[target.package];
    if (totalBytes > limit.unpacked_max) {
        fail(
            `payload for ${target.package} exceeds its unpacked size budget: ` +
                `${totalBytes} > ${limit.unpacked_max} bytes (R47 headroom exhausted; a channel failure stops the release)`,
        );
    }
}

/**
 * Verify staged payload bytes against a validated manifest: every listed file
 * exists with exact size/sha256, no symlink appears anywhere, and no unlisted
 * file exists under payload/. One-byte mutation anywhere fails.
 */
export function verifyPayloadDir(
    packageRoot: string,
    manifest: PayloadManifest,
): void {
    const listed = new Map(manifest.files.map((f) => [f.path, f]));
    for (const entry of manifest.files) {
        const path = join(packageRoot, entry.path);
        let stat: ReturnType<typeof lstatSync>;
        try {
            stat = lstatSync(path);
        } catch {
            fail(`missing payload file ${entry.path}`);
        }
        if (!stat.isFile()) fail(`${entry.path} is not a regular file`);
        const bytes = readFileSync(path);
        if (bytes.length !== entry.size) {
            fail(`${entry.path}: size drift (${bytes.length} != ${entry.size})`);
        }
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== entry.sha256) fail(`${entry.path}: digest drift`);
    }
    const walk = (relative: string): void => {
        for (const name of readdirSync(join(packageRoot, relative))) {
            const rel = `${relative}/${name}`;
            const stat = lstatSync(join(packageRoot, rel));
            if (stat.isSymbolicLink())
                fail(`symlink ${rel} is rejected in a payload`);
            if (stat.isDirectory()) {
                walk(rel);
            } else if (!listed.has(rel)) {
                fail(`unlisted payload file ${rel}`);
            }
        }
    };
    if (existsSync(join(packageRoot, "payload"))) walk("payload");
}

// ---------------------------------------------------------------------------
// Platform package metadata (KTD10, R20, R23, plan scenario 2/9).
// ---------------------------------------------------------------------------

export function validatePayloadPackageDir(
    rootDir: string,
    target: PayloadTarget,
    contract: ReleaseContract,
): void {
    const where = `${target.dir}/package.json`;
    const pkg = readJson(rootDir, where) as Record<string, unknown>;
    if (pkg.name !== target.package)
        fail(`${where}: name must be ${target.package}`);
    if (
        !(contract.packages.payloads as readonly string[]).includes(
            target.package,
        )
    ) {
        fail(`${where}: ${target.package} is not a contract payload package`);
    }
    if (pkg.version !== contract.release.version) {
        fail(
            `${where}: version must be the synchronized release version ${contract.release.version}`,
        );
    }
    if (pkg.private === true)
        fail(`${where}: payload packages must be publishable`);
    if (canonicalJson(pkg.os) !== canonicalJson(target.os)) {
        fail(`${where}: os must be ${JSON.stringify(target.os)}`);
    }
    if (canonicalJson(pkg.cpu) !== canonicalJson(target.cpu)) {
        fail(`${where}: cpu must be ${JSON.stringify(target.cpu)}`);
    }
    if (target.libc !== undefined) {
        if (canonicalJson(pkg.libc) !== canonicalJson(target.libc)) {
            fail(`${where}: libc must be ${JSON.stringify(target.libc)}`);
        }
    } else if ("libc" in pkg) {
        fail(`${where}: libc is Linux-only metadata`);
    }
    // No lifecycle scripts of any kind: install filtering only (R23).
    if ("scripts" in pkg) {
        const scripts = Object.keys(pkg.scripts as Record<string, unknown>);
        const lifecycle = scripts.filter((name) =>
            FORBIDDEN_LIFECYCLE_SCRIPTS.includes(name),
        );
        fail(
            `${where}: payload packages must declare no scripts` +
                (lifecycle.length > 0
                    ? ` (forbidden lifecycle scripts: ${lifecycle.join(", ")})`
                    : ""),
        );
    }
    for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
        "bin",
    ]) {
        if (field in pkg) fail(`${where}: ${field} is not allowed`);
    }
    if (pkg.license !== "MIT") fail(`${where}: license must be MIT`);
    const files = pkg.files;
    if (!Array.isArray(files) || !files.includes("payload")) {
        fail(`${where}: files must ship the payload directory`);
    }
    for (const doc of ["LICENSE", "NOTICE", "README.md"]) {
        const path = join(rootDir, target.dir, doc);
        if (!existsSync(path) || readFileSync(path, "utf8").trim().length === 0) {
            fail(`${target.dir}: missing or empty ${doc}`);
        }
    }
    // No tarball and no committed payload bytes: production bytes exist only
    // after qualification, and U6 never packs parents (R50).
    for (const name of readdirSync(join(rootDir, target.dir))) {
        if (name.endsWith(".tgz")) fail(`${target.dir}: unexpected tarball ${name}`);
    }
    const payloadDir = join(rootDir, target.dir, "payload");
    if (existsSync(payloadDir)) {
        const stray: string[] = [];
        const walk = (dir: string): void => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (lstatSync(path).isDirectory()) walk(path);
                else stray.push(name);
            }
        };
        walk(payloadDir);
        if (stray.length > 0) {
            fail(
                `${target.dir}/payload: committed payload bytes are forbidden ` +
                    `(inputs are not production-qualified): ${stray.join(", ")}`,
            );
        }
    }
}

/** Each parent must declare all three payload packages at the exact
 *  synchronized version — no ranges, tags, or workspace specifiers (R20). */
export function validateParentManifests(
    rootDir: string,
    contract: ReleaseContract,
): void {
    for (const parent of contract.packages.parents) {
        const dir = PARENT_DIRS[parent];
        if (dir === undefined) fail(`no source directory for parent ${parent}`);
        const where = `${dir}/package.json`;
        const pkg = readJson(rootDir, where) as Record<string, unknown>;
        if (pkg.name !== parent) fail(`${where}: name must be ${parent}`);
        const optional = pkg.optionalDependencies as
            | Record<string, unknown>
            | undefined;
        if (optional === undefined || typeof optional !== "object") {
            fail(`${where}: optionalDependencies must declare the payload packages`);
        }
        for (const payload of contract.packages.payloads) {
            const spec = optional[payload];
            if (spec !== contract.release.version) {
                fail(
                    `${where}: optionalDependencies[${payload}] must be the exact ` +
                        `version ${contract.release.version}, got ${JSON.stringify(spec)}`,
                );
            }
        }
        for (const name of Object.keys(optional)) {
            if (
                name.startsWith("@cortexkit/mc-host-") &&
                !(contract.packages.payloads as readonly string[]).includes(
                    name,
                )
            ) {
                fail(`${where}: unknown payload optional dependency ${name}`);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Current-release trust index (R30) and tagged stop-provenance record (R48).
// ---------------------------------------------------------------------------

export function buildTrustArtifacts(context: ReleaseContext): {
    index: Record<string, unknown>;
    stop: Record<string, unknown>;
    indexText: string;
    stopText: string;
} {
    const { contract } = context;
    const entries = PAYLOAD_TARGETS.map((target) => ({
        package: target.package,
        version: contract.release.version,
        target: target.target,
        platform_floor: platformFloorFor(contract, target.target),
        synapse: target.synapse,
        size_budget_bytes:
            context.lock.package_size_limits_bytes[target.package],
        // Fail-closed unpublished state (KTD23): no production payload exists,
        // so no digest exists. Consumers must reject entries that are not
        // qualified+published with real digests before executing native bytes.
        qualified: false,
        published: false,
        payload_manifest_digest: null,
        bootstrap_launcher_digest: null,
        unqualified_reason:
            "production payload not built: release inputs are not production-qualified " +
            "(docs/evidence/mc-host-release-qualification.json production_qualified: false)",
    }));
    const index = {
        schema: "magic-context.mc-host-payload-index/v1",
        release: { id: contract.release.id, version: contract.release.version },
        release_contract_sha256: context.u8Digest,
        production_inputs_lock_sha256: context.lockSha256,
        production_qualified: context.productionQualified,
        publication: {
            // U6 publishes nothing; U7 must publish every payload before any parent.
            payloads_before_parents: true,
            published: false,
            order: [
                ...[...contract.packages.payloads].sort(),
                ...[...contract.packages.parents].sort(),
            ],
        },
        entries,
    };
    // First payload-bearing release: non-authorizing genesis record binding the
    // current U8 release identity and nothing else (R48).
    const stop = {
        release_version: contract.release.version,
        tag: "genesis",
    };
    return {
        index,
        stop,
        indexText: `${canonicalJson(index)}\n`,
        stopText: `${canonicalJson(stop)}\n`,
    };
}

export function validateTrustIndex(
    index: unknown,
    context: ReleaseContext,
): void {
    assertExactKeys(
        index,
        [
            "schema",
            "release",
            "release_contract_sha256",
            "production_inputs_lock_sha256",
            "production_qualified",
            "publication",
            "entries",
        ],
        "trust index",
    );
    const { contract } = context;
    if (index.schema !== "magic-context.mc-host-payload-index/v1") {
        fail("unknown trust-index schema");
    }
    const release = index.release as { id?: unknown; version?: unknown };
    if (
        release?.id !== contract.release.id ||
        release?.version !== contract.release.version
    ) {
        fail("trust index must bind the current release identity");
    }
    if (index.release_contract_sha256 !== context.u8Digest) {
        fail("trust index cites a stale U8 contract digest");
    }
    if (index.production_inputs_lock_sha256 !== context.lockSha256) {
        fail("trust index cites a stale U9 input-lock digest");
    }
    if (index.production_qualified !== context.productionQualified) {
        fail("trust index disagrees with U9 qualification state");
    }
    const publication = index.publication as Record<string, unknown>;
    assertExactKeys(
        publication,
        ["payloads_before_parents", "published", "order"],
        "trust index publication",
    );
    if (publication.payloads_before_parents !== true) {
        fail("payloads must publish before parents (R50)");
    }
    if (publication.published !== false) {
        fail("U6 performs no publication; published must be false");
    }
    const order = publication.order as string[];
    const expectedOrder = [
        ...[...contract.packages.payloads].sort(),
        ...[...contract.packages.parents].sort(),
    ];
    if (canonicalJson(order) !== canonicalJson(expectedOrder)) {
        fail(
            "publication order must list every payload package before every parent package",
        );
    }
    const entries = index.entries as unknown[];
    if (!Array.isArray(entries) || entries.length !== PAYLOAD_TARGETS.length) {
        fail("trust index must carry exactly one entry per payload package");
    }
    for (const [i, raw] of entries.entries()) {
        const target = PAYLOAD_TARGETS[i];
        assertExactKeys(
            raw,
            [
                "package",
                "version",
                "target",
                "platform_floor",
                "synapse",
                "size_budget_bytes",
                "qualified",
                "published",
                "payload_manifest_digest",
                "bootstrap_launcher_digest",
                ...(raw !== null &&
                typeof raw === "object" &&
                (raw as Record<string, unknown>).qualified !== true
                    ? ["unqualified_reason"]
                    : []),
            ],
            `entries[${i}]`,
        );
        const entry = raw as Record<string, unknown>;
        if (
            entry.package !== target.package ||
            entry.version !== contract.release.version ||
            entry.target !== target.target
        ) {
            fail(`entries[${i}]: package identity drift`);
        }
        if (
            canonicalJson(entry.platform_floor) !==
            canonicalJson(platformFloorFor(contract, target.target))
        ) {
            fail(`entries[${i}]: platform floor drift`);
        }
        if (entry.synapse !== target.synapse)
            fail(`entries[${i}]: Synapse claim drift`);
        if (
            canonicalJson(entry.size_budget_bytes) !==
            canonicalJson(context.lock.package_size_limits_bytes[target.package])
        ) {
            fail(`entries[${i}]: size budget drift against the U9 lock`);
        }
        if (entry.qualified === true) {
            if (!context.productionQualified) {
                fail(
                    `entries[${i}]: cannot be qualified while release inputs are unqualified`,
                );
            }
            for (const field of [
                "payload_manifest_digest",
                "bootstrap_launcher_digest",
            ]) {
                const digest = entry[field];
                if (
                    typeof digest !== "string" ||
                    !SHA256_RE.test(digest) ||
                    isPlaceholderSha256(digest)
                ) {
                    fail(`entries[${i}]: ${field} must be a real 64-hex digest`);
                }
            }
        } else if (entry.qualified === false) {
            // Fail-closed unpublished state: no digest may exist, publication is
            // impossible, and a machine-readable reason is required.
            if (
                entry.published !== false ||
                entry.payload_manifest_digest !== null ||
                entry.bootstrap_launcher_digest !== null ||
                typeof entry.unqualified_reason !== "string" ||
                entry.unqualified_reason.length === 0
            ) {
                fail(
                    `entries[${i}]: unqualified entries must be unpublished with null digests and a reason`,
                );
            }
        } else {
            fail(`entries[${i}]: qualified must be true or false`);
        }
    }
}

/**
 * Validate the tagged `genesis | predecessor` stop-provenance record beyond the
 * U8 schema: reservation versions can never be ancestry, a predecessor can
 * never be self-authored, must name a supported target and the exact expected
 * adjacent N-1 release (N-2/skipped rejected), must use the pinned legacy proof
 * version, and its embedded manifest must hash to the cited digest (modified
 * N-1 rejected).
 */
export function validateStopRecord(
    record: unknown,
    context: ReleaseContext,
    expectedPredecessorVersion: string | null,
): { legacyStopAuthority: boolean } {
    const { contract } = context;
    const base = validateStopProvenance(contract, record);
    if (!base.valid) fail(`stop-provenance record invalid: ${base.error}`);
    const rec = record as Record<string, unknown>;
    if (rec.tag === "genesis") {
        if (expectedPredecessorVersion !== null) {
            fail(
                "only the first payload-bearing release may emit genesis (R48)",
            );
        }
        if (context.reservationVersions.includes(rec.release_version as string)) {
            fail("a reservation version can never satisfy genesis (R50)");
        }
        return { legacyStopAuthority: false };
    }
    const predecessorVersion = rec.predecessor_release_version as string;
    if (expectedPredecessorVersion === null) {
        fail(
            "the first payload-bearing release has no predecessor; genesis is required",
        );
    }
    if (context.reservationVersions.includes(predecessorVersion)) {
        fail(
            "a reservation version is not a payload release and can never be ancestry (R50)",
        );
    }
    if (predecessorVersion === rec.release_version) {
        fail("a stop-provenance record can never cite itself as predecessor");
    }
    if (predecessorVersion !== expectedPredecessorVersion) {
        fail(
            `predecessor must be the exact adjacent N-1 release ${expectedPredecessorVersion}; ` +
                `${predecessorVersion} is skipped or N-2 (R48)`,
        );
    }
    if (
        !contract.platforms.supported.some((p) => p.target === rec.target)
    ) {
        fail(`predecessor record names unsupported target ${rec.target}`);
    }
    if (rec.legacy_proof_version !== contract.proof.legacy_stop_only.version) {
        fail(
            `predecessor legacy proof version must be ${contract.proof.legacy_stop_only.version}`,
        );
    }
    const digest = rec.payload_manifest_digest;
    if (
        typeof digest !== "string" ||
        !SHA256_RE.test(digest) ||
        isPlaceholderSha256(digest)
    ) {
        fail("predecessor payload_manifest_digest must be a real 64-hex digest");
    }
    if (sha256Hex(canonicalJson(rec.predecessor_manifest)) !== digest) {
        fail(
            "predecessor manifest does not hash to its cited digest (modified N-1 fails closed)",
        );
    }
    return { legacyStopAuthority: true };
}

// ---------------------------------------------------------------------------
// Dev payload build (U7-style local smokes and TS bootstrap tests consume this).
// ---------------------------------------------------------------------------

export function hostTarget(): PayloadTarget {
    const key = `${process.platform}-${process.arch}`;
    const target = PAYLOAD_TARGETS.find((t) =>
        key === "linux-x64"
            ? t.target === "linux-x64-gnu"
            : t.target === key,
    );
    if (target === undefined)
        fail(`no payload target for host ${key} (R24 matrix)`);
    return target;
}

export interface DevPayloadResult {
    target: string;
    outDir: string;
    manifestPath: string;
    manifest: PayloadManifest;
    digest: string;
    launcherDigest: string;
}

/**
 * Stage a dev payload from a locally compiled ck-mc-host binary and emit a real
 * canonical payload manifest whose digest names the generation. Dev payloads
 * are never release inputs and never contain ORT/model bytes.
 */
export function buildDevPayload(
    rootDir: string,
    options: { outDir: string; binaryPath?: string; target?: PayloadTarget },
): DevPayloadResult {
    const context = loadReleaseContext(rootDir);
    const target = options.target ?? hostTarget();
    let binaryPath = options.binaryPath;
    if (binaryPath === undefined) {
        for (const profile of ["release", "debug"]) {
            const candidate = join(rootDir, "target", profile, "ck-mc-host");
            if (existsSync(candidate)) {
                binaryPath = candidate;
                break;
            }
        }
    }
    if (binaryPath === undefined || !existsSync(binaryPath)) {
        fail(
            "no locally compiled ck-mc-host binary found; run " +
                "`cargo build -p mc-module --bin ck-mc-host` first",
        );
    }
    if (lstatSync(binaryPath).isSymbolicLink()) {
        fail("dev payload source binary must not be a symlink");
    }
    const bytes = readFileSync(binaryPath);
    if (bytes.length === 0) fail("dev payload source binary is empty");
    const launcherDigest = createHash("sha256").update(bytes).digest("hex");

    const generationRoot = join(options.outDir, target.target);
    const launcherDest = join(generationRoot, LAUNCHER_PATH);
    mkdirSync(dirname(launcherDest), { recursive: true });
    copyFileSync(binaryPath, launcherDest);
    chmodSync(launcherDest, 0o755);

    const manifest: PayloadManifest = {
        schema: "magic-context.mc-host-payload-manifest/v1",
        release: {
            id: context.contract.release.id,
            version: context.contract.release.version,
        },
        release_contract_sha256: context.u8Digest,
        production_inputs_lock_sha256: context.lockSha256,
        mode: "dev",
        package: {
            name: target.package,
            version: context.contract.release.version,
            target: target.target,
        },
        platform_floor: platformFloorFor(context.contract, target.target),
        synapse: target.synapse,
        launcher: LAUNCHER_PATH,
        files: [
            {
                path: LAUNCHER_PATH,
                type: "file",
                size: bytes.length,
                mode: "755",
                sha256: launcherDigest,
            },
        ],
    };
    validatePayloadManifest(manifest, context);
    verifyPayloadDir(generationRoot, manifest);
    const digest = payloadManifestDigest(manifest);
    const manifestPath = join(generationRoot, "payload-manifest.json");
    writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`);
    return {
        target: target.target,
        outDir: generationRoot,
        manifestPath,
        manifest,
        digest,
        launcherDigest,
    };
}

// ---------------------------------------------------------------------------
// Check / trust-write drivers.
// ---------------------------------------------------------------------------

export interface CheckResult {
    u8Digest: string;
    lockSha256: string;
    drift: string[];
}

export function runCheck(
    rootDir: string,
    options: { write: boolean },
): CheckResult {
    const context = loadReleaseContext(rootDir);
    for (const target of PAYLOAD_TARGETS) {
        validatePayloadPackageDir(rootDir, target, context.contract);
    }
    validateParentManifests(rootDir, context.contract);

    const { index, stop, indexText, stopText } = buildTrustArtifacts(context);
    validateTrustIndex(index, context);
    // First payload-bearing release: only genesis is acceptable ancestry.
    validateStopRecord(stop, context, null);

    const expected = { index: indexText, stop: stopText } as const;
    const drift: string[] = [];
    for (const [key, relative] of Object.entries(OUTPUT_PATHS) as [
        keyof typeof OUTPUT_PATHS,
        string,
    ][]) {
        const path = join(rootDir, relative);
        if (options.write) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, expected[key]);
            continue;
        }
        if (!existsSync(path)) {
            drift.push(`${relative}: missing`);
        } else if (readFileSync(path, "utf8") !== expected[key]) {
            drift.push(
                `${relative}: content drift (regenerate with bun scripts/build-mc-host-payload.ts --write-trust)`,
            );
        }
    }
    // Re-validate the committed artifacts as parsed JSON so a hand-edited but
    // byte-diverging file reports schema problems, not only drift.
    if (drift.length === 0 && !options.write) {
        validateTrustIndex(
            readJson(rootDir, OUTPUT_PATHS.index),
            context,
        );
        validateStopRecord(readJson(rootDir, OUTPUT_PATHS.stop), context, null);
    }
    return { u8Digest: context.u8Digest, lockSha256: context.lockSha256, drift };
}

/** Production build gate: fails closed until U9 qualifies production inputs. */
export function buildProductionPayloads(rootDir: string): never {
    // Throws with the exact unqualified reason today (R26, KTD23).
    requireQualificationEvidence(rootDir);
    fail(
        "production payload assembly requires qualified ORT/model bytes staged by " +
            "release engineering; qualified inputs are locked but no assembly path is qualified yet",
    );
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function main(): void {
    const args = process.argv.slice(2);
    const flags = new Set<string>();
    let outDir: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--out") {
            outDir = args[i + 1];
            if (outDir === undefined) {
                console.error("--out requires a directory");
                process.exit(2);
            }
            i += 1;
        } else if (["--check", "--write-trust", "--dev"].includes(arg)) {
            flags.add(arg);
        } else {
            console.error(`unknown argument: ${arg}`);
            process.exit(2);
        }
    }
    if (flags.size > 1) {
        console.error("--check, --write-trust, and --dev are mutually exclusive");
        process.exit(2);
    }
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    try {
        if (flags.has("--check") || flags.has("--write-trust")) {
            const write = flags.has("--write-trust");
            const result = runCheck(rootDir, { write });
            if (!write && result.drift.length > 0) {
                console.error("mc-host payload trust drift:");
                for (const line of result.drift) console.error(`  - ${line}`);
                process.exit(1);
            }
            console.log(
                `${write ? "generated" : "checked"} mc-host payload packages and trust artifacts ` +
                    `(U8 sha256 ${result.u8Digest}, U9 lock sha256 ${result.lockSha256}; no publish, no parent pack)`,
            );
            return;
        }
        if (flags.has("--dev")) {
            const result = buildDevPayload(rootDir, {
                outDir: outDir ?? join(rootDir, "tmp", "mc-host-dev-payload"),
            });
            console.log(
                `built dev payload for ${result.target} at ${result.outDir} ` +
                    `(payload-manifest digest ${result.digest}, launcher sha256 ${result.launcherDigest}; dev payloads are never release inputs)`,
            );
            return;
        }
        buildProductionPayloads(rootDir);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

if (import.meta.main) main();
