import { afterEach, describe, expect, test } from "bun:test";
import {
    chmodSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { completeRegistryGate } from "./__fixtures__/registry-gate";
import {
    buildContract,
    canonicalJson,
    sha256Hex,
} from "./generate-mc-host-release-manifest";
import {
    assembleProductionPayload,
    buildDevPayload,
    buildTrustArtifacts,
    hostTarget,
    LAUNCHER_PATH,
    LINUX_PRODUCTION_PAYLOAD_SLOTS,
    loadReleaseContext,
    OUTPUT_PATHS,
    PAYLOAD_TARGETS,
    type PayloadManifest,
    packProductionPayload,
    type ReleaseContext,
    payloadManifestDigest,
    runCheck,
    validateParentManifests,
    validatePayloadManifest,
    validatePayloadPackageDir,
    validateStopRecord,
    validateTrustIndex,
    verifyProductionBinaryIdentity,
    verifyPayloadDir,
} from "./build-mc-host-payload";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const CONTEXT_FILES = [
    "release/mc-host-release.json",
    "release/mc-host-production-inputs.lock.json",
    "release/mc-host-provider-credentials.json",
    "release/mc-host-registry-gate.json",
    "docs/evidence/mc-host-release-qualification.json",
];
const PACKAGE_DIRS = [
    "packages/mc-host-darwin-arm64",
    "packages/mc-host-darwin-x64",
    "packages/mc-host-linux-x64-gnu",
];
const PARENT_MANIFESTS = [
    "packages/plugin/package.json",
    "packages/pi-plugin/package.json",
    "packages/cli/package.json",
];

const tempRoots: string[] = [];

afterEach(() => {
    while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        if (root !== undefined) rmSync(root, { recursive: true, force: true });
    }
});

function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "mc-host-payload-"));
    tempRoots.push(root);
    for (const relative of [
        ...CONTEXT_FILES,
        ...PARENT_MANIFESTS,
        OUTPUT_PATHS.index,
        OUTPUT_PATHS.stop,
    ]) {
        mkdirSync(join(root, dirname(relative)), { recursive: true });
        cpSync(join(repoRoot, relative), join(root, relative));
    }
    for (const dir of PACKAGE_DIRS) {
        cpSync(join(repoRoot, dir), join(root, dir), { recursive: true });
    }
    return root;
}

// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies
function readMutable(root: string, relative: string): any {
    return JSON.parse(readFileSync(join(root, relative), "utf8"));
}

function writeJson(root: string, relative: string, value: unknown): void {
    writeFileSync(join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
}

function markRegistryGatePassing(root: string): void {
    writeJson(
        root,
        "release/mc-host-registry-gate.json",
        completeRegistryGate(readMutable(root, "release/mc-host-registry-gate.json")),
    );
}

function context() {
    return loadReleaseContext(repoRoot);
}

function unqualifiedContext(): ReleaseContext {
    const unqualified = structuredClone(context());
    unqualified.productionQualified = false;
    unqualified.lock.production_qualified = false;
    return unqualified;
}

function qualifiedContext(): ReleaseContext {
    const qualified = structuredClone(context());
    qualified.productionQualified = true;
    qualified.lock.production_qualified = true;
    return qualified;
}

function successorContext() {
    const ctx = structuredClone(context());
    (ctx.contract.release as { version: string }).version = "0.39.0";
    return ctx;
}

function targetFor(name: string) {
    const target = PAYLOAD_TARGETS.find((t) => t.target === name);
    if (target === undefined) throw new Error(`missing target ${name}`);
    return target;
}

function devManifest(): PayloadManifest {
    const ctx = context();
    const contract = buildContract();
    const target = targetFor("darwin-arm64");
    return {
        schema: "magic-context.mc-host-payload-manifest/v1",
        release: { id: contract.release.id, version: contract.release.version },
        release_contract_sha256: ctx.u8Digest,
        production_inputs_lock_sha256: ctx.lockSha256,
        mode: "dev",
        package: {
            name: target.package,
            version: contract.release.version,
            target: target.target,
        },
        platform_floor: { os_min: "13.5", dev_fd_exec: true },
        synapse: "unsupported",
        launcher: LAUNCHER_PATH,
        files: [
            {
                path: LAUNCHER_PATH,
                type: "file",
                size: 8,
                mode: "755",
                sha256: sha256Hex("mc-host\n"),
            },
        ],
    };
}

describe("payload package metadata", () => {
    test("committed release check fails closed on the live registry contradiction", () => {
        expect(() => runCheck(repoRoot, { write: false })).toThrow(
            /synchronized version 0\.38\.0 is not unpublished/,
        );
    });

    test("version drift from the contract fails", () => {
        const root = freshRoot();
        const relative = "packages/mc-host-linux-x64-gnu/package.json";
        const pkg = readMutable(root, relative);
        pkg.version = "0.37.0";
        writeJson(root, relative, pkg);
        expect(() =>
            validatePayloadPackageDir(
                root,
                targetFor("linux-x64-gnu"),
                buildContract(),
            ),
        ).toThrow(/synchronized release version/);
    });

    test("os/cpu/libc drift fails", () => {
        const root = freshRoot();
        for (const [field, value, pattern] of [
            ["os", ["win32"], /os must be/],
            ["cpu", ["arm64"], /cpu must be/],
            ["libc", ["musl"], /libc must be/],
        ] as const) {
            const relative = "packages/mc-host-linux-x64-gnu/package.json";
            const pkg = readMutable(root, relative);
            const original = pkg[field];
            pkg[field] = value;
            writeJson(root, relative, pkg);
            expect(() =>
                validatePayloadPackageDir(
                    root,
                    targetFor("linux-x64-gnu"),
                    buildContract(),
                ),
            ).toThrow(pattern);
            pkg[field] = original;
            writeJson(root, relative, pkg);
        }
    });

    test("libc on a darwin package fails", () => {
        const root = freshRoot();
        const relative = "packages/mc-host-darwin-arm64/package.json";
        const pkg = readMutable(root, relative);
        pkg.libc = ["glibc"];
        writeJson(root, relative, pkg);
        expect(() =>
            validatePayloadPackageDir(
                root,
                targetFor("darwin-arm64"),
                buildContract(),
            ),
        ).toThrow(/libc is Linux-only/);
    });

    test("any lifecycle script fails the no-lifecycle scan", () => {
        for (const script of [
            "preinstall",
            "install",
            "postinstall",
            "build",
        ]) {
            const root = freshRoot();
            const relative = "packages/mc-host-darwin-x64/package.json";
            const pkg = readMutable(root, relative);
            pkg.scripts = { [script]: "node evil.js" };
            writeJson(root, relative, pkg);
            expect(() =>
                validatePayloadPackageDir(
                    root,
                    targetFor("darwin-x64"),
                    buildContract(),
                ),
            ).toThrow(/no scripts/);
        }
    });

    test("missing license/notice/readme fails", () => {
        for (const doc of ["LICENSE", "NOTICE", "README.md"]) {
            const root = freshRoot();
            rmSync(join(root, "packages/mc-host-darwin-arm64", doc));
            expect(() =>
                validatePayloadPackageDir(
                    root,
                    targetFor("darwin-arm64"),
                    buildContract(),
                ),
            ).toThrow(new RegExp(`missing or empty ${doc}`));
        }
    });

    test("committed payload bytes are rejected while unqualified", () => {
        const root = freshRoot();
        const dir = join(root, "packages/mc-host-linux-x64-gnu/payload/bin");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "ck-mc-host"), "bytes");
        expect(() =>
            validatePayloadPackageDir(
                root,
                targetFor("linux-x64-gnu"),
                buildContract(),
            ),
        ).toThrow(/committed payload bytes are forbidden/);
    });
});

describe("parent optional dependencies", () => {
    test("committed parents declare all three exact versions", () => {
        expect(() =>
            validateParentManifests(repoRoot, buildContract()),
        ).not.toThrow();
    });

    test("range, tag, workspace, and missing specs fail", () => {
        for (const spec of ["^0.38.0", "latest", "workspace:*", undefined]) {
            const root = freshRoot();
            const relative = "packages/cli/package.json";
            const pkg = readMutable(root, relative);
            if (spec === undefined) {
                delete pkg.optionalDependencies[
                    "@cortexkit/mc-host-darwin-x64"
                ];
            } else {
                pkg.optionalDependencies["@cortexkit/mc-host-darwin-x64"] =
                    spec;
            }
            writeJson(root, relative, pkg);
            expect(() =>
                validateParentManifests(root, buildContract()),
            ).toThrow(/exact version/);
        }
    });
});

describe("payload manifest schema", () => {
    test("round-trip: canonical serialization revalidates with the same digest", () => {
        const manifest = devManifest();
        const ctx = context();
        validatePayloadManifest(manifest, ctx);
        const digest = payloadManifestDigest(manifest);
        const reparsed = JSON.parse(canonicalJson(manifest));
        validatePayloadManifest(reparsed, ctx);
        expect(payloadManifestDigest(reparsed)).toBe(digest);
    });

    test("digest names the generation: any field change renames it", () => {
        const manifest = devManifest();
        const digest = payloadManifestDigest(manifest);
        const mutated = structuredClone(manifest);
        mutated.files[0].sha256 = sha256Hex("one byte different");
        expect(payloadManifestDigest(mutated)).not.toBe(digest);
    });

    test("placeholder digest, unknown key, and unsorted files fail", () => {
        const ctx = context();
        const placeholder = structuredClone(devManifest());
        placeholder.files[0].sha256 = "a".repeat(64);
        expect(() => validatePayloadManifest(placeholder, ctx)).toThrow(
            /real 64-hex digest/,
        );

        const extraKey = structuredClone(devManifest()) as Record<
            string,
            unknown
        >;
        extraKey.forged = true;
        expect(() => validatePayloadManifest(extraKey, ctx)).toThrow(
            /unknown key forged/,
        );

        const unsorted = structuredClone(devManifest());
        unsorted.files = [
            {
                path: "payload/bin/zz",
                type: "file",
                size: 1,
                mode: "644",
                sha256: sha256Hex("zz"),
            },
            ...unsorted.files,
        ];
        expect(() => validatePayloadManifest(unsorted, ctx)).toThrow(
            /sorted by path/,
        );
    });

    test("path traversal, absolute, and non-payload-rooted names fail", () => {
        const ctx = context();
        for (const path of [
            "payload/../escape",
            "payload/bin/../../escape",
            "/etc/passwd",
            "bin/ck-mc-host",
            "payload\\bin\\ck-mc-host",
            "payload//bin",
            "payload/./bin",
        ]) {
            const manifest = structuredClone(devManifest());
            manifest.files.push({
                path,
                type: "file",
                size: 1,
                mode: "644",
                sha256: "b".repeat(64),
            });
            manifest.files.sort((left, right) => left.path.localeCompare(right.path));
            expect(() => validatePayloadManifest(manifest, ctx)).toThrow(
                /safe relative path|payload path|payload\//,
            );
        }
    });

    test("duplicate file paths fail", () => {
        const ctx = context();
        const manifest = structuredClone(devManifest());
        manifest.files = [manifest.files[0], { ...manifest.files[0] }];
        expect(() => validatePayloadManifest(manifest, ctx)).toThrow(
            /duplicate payload file entry|sorted by path/,
        );
    });

    test("macOS manifests cannot claim Synapse or carry model bytes", () => {
        const ctx = context();
        const claims = structuredClone(devManifest());
        claims.synapse = "certified_cpu";
        expect(() => validatePayloadManifest(claims, ctx)).toThrow(
            /Synapse claim mismatch/,
        );

        const withModel = structuredClone(devManifest());
        withModel.files = [
            withModel.files[0],
            {
                path: "payload/model/gte-modernbert-base-f16/model.onnx",
                type: "file",
                size: 4,
                mode: "644",
                sha256: sha256Hex("onnx"),
            },
        ].sort((a, b) => (a.path < b.path ? -1 : 1));
        expect(() => validatePayloadManifest(withModel, ctx)).toThrow(
            /must be exactly/,
        );
    });

    test("size budget overflow fails with the budget in the message", () => {
        const ctx = context();
        const manifest = structuredClone(devManifest());
        manifest.files[0].size =
            ctx.lock.package_size_limits_bytes[manifest.package.name]
                .unpacked_max + 1;
        expect(() => validatePayloadManifest(manifest, ctx)).toThrow(
            /exceeds its unpacked size budget/,
        );
    });

    test("production manifest fails closed while inputs are unqualified", () => {
        const ctx = unqualifiedContext();
        const manifest = structuredClone(devManifest());
        manifest.mode = "production";
        expect(() => validatePayloadManifest(manifest, ctx)).toThrow(
            /production-qualified inputs/,
        );
    });
});

describe("staged payload verification", () => {
    function stage(manifest: PayloadManifest, bytes: string): string {
        const root = mkdtempSync(join(tmpdir(), "mc-host-stage-"));
        tempRoots.push(root);
        const launcher = join(root, LAUNCHER_PATH);
        mkdirSync(dirname(launcher), { recursive: true });
        writeFileSync(launcher, bytes);
        manifest.files[0].size = Buffer.byteLength(bytes);
        manifest.files[0].sha256 = sha256Hex(bytes);
        // A staged tree that contradicts its own manifest's declared mode is
        // not a valid starting point for the drift cases below: the mode check
        // would fire first and mask the mutation each one targets.
        chmodSync(launcher, Number.parseInt(manifest.files[0].mode, 8));
        return root;
    }

    test("exact bytes verify; one-byte mutation fails", () => {
        const manifest = devManifest();
        const root = stage(manifest, "mc-host\n");
        expect(() => verifyPayloadDir(root, manifest)).not.toThrow();
        writeFileSync(join(root, LAUNCHER_PATH), "mc-hosT\n");
        expect(() => verifyPayloadDir(root, manifest)).toThrow(/digest drift/);
    });

    test("declared mode is enforced, not just the bytes", () => {
        const manifest = devManifest();
        const root = stage(manifest, "mc-host\n");
        const launcher = join(root, LAUNCHER_PATH);
        expect(() => verifyPayloadDir(root, manifest)).not.toThrow();
        // Right bytes, wrong permissions: a launcher staged non-executable
        // still carries the manifest digest that certifies the tree.
        chmodSync(launcher, 0o644);
        expect(() => verifyPayloadDir(root, manifest)).toThrow(
            /mode drift \(644 != 755\)/,
        );
        // Over-permissive fails the same way; the manifest names one mode.
        chmodSync(launcher, 0o777);
        expect(() => verifyPayloadDir(root, manifest)).toThrow(
            /mode drift \(777 != 755\)/,
        );
        chmodSync(launcher, 0o755);
        expect(() => verifyPayloadDir(root, manifest)).not.toThrow();
    });

    test("unlisted extra file fails", () => {
        const manifest = devManifest();
        const root = stage(manifest, "mc-host\n");
        writeFileSync(join(root, "payload/bin/extra"), "x");
        expect(() => verifyPayloadDir(root, manifest)).toThrow(
            /unlisted payload file payload\/bin\/extra/,
        );
    });

    test("missing file and symlink fail", () => {
        const manifest = devManifest();
        const root = stage(manifest, "mc-host\n");
        rmSync(join(root, LAUNCHER_PATH));
        expect(() => verifyPayloadDir(root, manifest)).toThrow(
            /missing payload file/,
        );
        symlinkSync("/etc/hostname", join(root, LAUNCHER_PATH));
        expect(() => verifyPayloadDir(root, manifest)).toThrow(
            /not a regular file|symlink/,
        );
    });
});

describe("stop-provenance record", () => {
    function predecessorRecord() {
        const manifest = devManifest();
        return {
            tag: "predecessor",
            release_version: "0.39.0",
            target: "darwin-arm64",
            predecessor_release_version: "0.38.0",
            predecessor_daemon_version: "mc-host/0.1.0",
            legacy_proof_version: 1,
            payload_manifest_digest: payloadManifestDigest(manifest),
            predecessor_manifest: manifest,
        };
    }

    test("committed genesis record validates with no legacy authority", () => {
        const ctx = context();
        const record = JSON.parse(
            readFileSync(join(repoRoot, OUTPUT_PATHS.stop), "utf8"),
        );
        const result = validateStopRecord(record, ctx, null);
        expect(result.legacyStopAuthority).toBe(false);
    });

    test("genesis with any predecessor/proof/manifest field fails", () => {
        const ctx = context();
        for (const field of [
            "predecessor_release_version",
            "predecessor_daemon_version",
            "predecessor_manifest",
            "payload_manifest_digest",
            "legacy_proof_version",
        ]) {
            const record: Record<string, unknown> = {
                tag: "genesis",
                release_version: "0.38.0",
                [field]: "anything",
            };
            expect(() => validateStopRecord(record, ctx, null)).toThrow(
                /forbidden field/,
            );
        }
    });

    test("genesis must bind the current release identity", () => {
        const ctx = context();
        expect(() =>
            validateStopRecord(
                { tag: "genesis", release_version: "0.37.0" },
                ctx,
                null,
            ),
        ).toThrow(/current release identity/);
    });

    test("a predecessor record on the genesis release fails", () => {
        const ctx = successorContext();
        expect(() =>
            validateStopRecord(predecessorRecord(), ctx, "0.38.0"),
        ).not.toThrow();
        expect(() =>
            validateStopRecord(predecessorRecord(), ctx, null),
        ).toThrow(/genesis is required/);
    });

    test("reservation versions can never be ancestry", () => {
        const ctx = successorContext();
        ctx.reservationVersions.push("0.0.1-reserved.0");
        const record = predecessorRecord();
        record.predecessor_release_version = "0.0.1-reserved.0";
        expect(() =>
            validateStopRecord(record, ctx, "0.0.1-reserved.0"),
        ).toThrow(/exact semver/);
    });

    test("self-authored, N-2, unknown-target, and modified-manifest records fail", () => {
        const ctx = successorContext();

        const selfAuthored = predecessorRecord();
        selfAuthored.predecessor_release_version = "0.39.0";
        expect(() =>
            validateStopRecord(
                selfAuthored,
                ctx,
                "0.39.0",
            ),
        ).toThrow(/older than the current release/);

        const nMinusTwo = predecessorRecord();
        nMinusTwo.predecessor_release_version = "0.37.0";
        expect(() => validateStopRecord(nMinusTwo, ctx, "0.38.0")).toThrow(
            /skipped or N-2/,
        );

        const badTarget = predecessorRecord();
        badTarget.target = "win32-x64";
        expect(() => validateStopRecord(badTarget, ctx, "0.38.0")).toThrow(
            /not a supported platform/,
        );

        const modified = predecessorRecord();
        modified.predecessor_manifest = {
            ...modified.predecessor_manifest,
            mode: "production",
        };
        expect(() => validateStopRecord(modified, ctx, "0.38.0")).toThrow(
            /modified N-1 fails closed/,
        );

        const badProof = predecessorRecord();
        badProof.legacy_proof_version = 2;
        expect(() => validateStopRecord(badProof, ctx, "0.38.0")).toThrow(
            /legacy stop-only proof version/,
        );
    });
});

describe("trust index", () => {
    test("qualified trust generation requires a complete three-target payload root", () => {
        const ctx = qualifiedContext();
        expect(() => buildTrustArtifacts(ctx)).toThrow(
            /requires the complete payload root/,
        );
    });

    test("unqualified entries must fail closed", () => {
        const ctx = unqualifiedContext();
        const { index } = buildTrustArtifacts(ctx);
        // biome-ignore lint/suspicious/noExplicitAny: test mutates a deep copy
        const qualified: any = structuredClone(index);
        qualified.entries[0].qualified = true;
        qualified.entries[0].payload_manifest_digest = sha256Hex("x");
        qualified.entries[0].bootstrap_launcher_digest = sha256Hex("y");
        delete qualified.entries[0].unqualified_reason;
        expect(() => validateTrustIndex(qualified, ctx)).toThrow(
            /cannot be qualified while release inputs are unqualified/,
        );

        // biome-ignore lint/suspicious/noExplicitAny: test mutates a deep copy
        const digestWhileUnqualified: any = structuredClone(index);
        digestWhileUnqualified.entries[0].payload_manifest_digest =
            sha256Hex("x");
        expect(() => validateTrustIndex(digestWhileUnqualified, ctx)).toThrow(
            /unpublished with null digests/,
        );

        // biome-ignore lint/suspicious/noExplicitAny: test mutates a deep copy
        const published: any = structuredClone(index);
        published.publication.published = true;
        expect(() => validateTrustIndex(published, ctx)).toThrow(
            /no publication/,
        );
    });

    test("publication order must put payloads before parents", () => {
        const ctx = unqualifiedContext();
        const { index } = buildTrustArtifacts(ctx);
        // biome-ignore lint/suspicious/noExplicitAny: test mutates a deep copy
        const reordered: any = structuredClone(index);
        reordered.publication.order.reverse();
        expect(() => validateTrustIndex(reordered, ctx)).toThrow(
            /payload package before every parent/,
        );
    });

    test("drift in entries, floors, budgets, or citations fails", () => {
        const ctx = unqualifiedContext();
        const { index } = buildTrustArtifacts(ctx);
        // biome-ignore lint/suspicious/noExplicitAny: test mutates deep copies
        const cases: [string, (copy: any) => void, RegExp][] = [
            [
                "stale U8 digest",
                (copy) => {
                    copy.release_contract_sha256 = sha256Hex("stale");
                },
                /stale U8 contract digest/,
            ],
            [
                "stale lock digest",
                (copy) => {
                    copy.production_inputs_lock_sha256 = sha256Hex("stale");
                },
                /stale U9 input-lock digest/,
            ],
            [
                "floor drift",
                (copy) => {
                    copy.entries[2].platform_floor.glibc_min = "2.27";
                },
                /platform floor drift/,
            ],
            [
                "budget drift",
                (copy) => {
                    copy.entries[2].size_budget_bytes.unpacked_max += 1;
                },
                /size budget drift/,
            ],
            [
                "synapse drift",
                (copy) => {
                    copy.entries[0].synapse = "certified_cpu";
                },
                /Synapse claim drift/,
            ],
        ];
        for (const [, mutate, pattern] of cases) {
            const copy = structuredClone(index);
            // biome-ignore lint/suspicious/noExplicitAny: test mutates a deep copy
            mutate(copy as any);
            expect(() => validateTrustIndex(copy, ctx)).toThrow(pattern);
        }
    });

    test("runCheck reports drift while release inputs remain unqualified", () => {
        const root = freshRoot();
        markRegistryGatePassing(root);
        const record = readMutable(root, OUTPUT_PATHS.stop);
        record.release_version = "0.39.0";
        writeFileSync(
            join(root, OUTPUT_PATHS.stop),
            `${canonicalJson(record)}\n`,
        );
        const result = runCheck(root, { write: false });
        expect(result.drift).toEqual([
            expect.stringContaining("mc-host-n-minus-one-stop.json"),
        ]);
    });
});

describe("production payload assembly", () => {
    test("production binary must embed the current input-lock digest", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-binary-identity-"));
        tempRoots.push(root);
        const binary = join(root, "ck-mc-host");
        const digest = "a".repeat(64);
        writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${digest}'\n`);
        chmodSync(binary, 0o700);
        expect(() =>
            verifyProductionBinaryIdentity(binary, digest),
        ).not.toThrow();
        expect(() =>
            verifyProductionBinaryIdentity(binary, "b".repeat(64)),
        ).toThrow(/does not embed the current U9 input-lock digest/);
    });

    test("Linux copies the launcher and exact locked runtime/model slots", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-production-"));
        tempRoots.push(root);
        const binary = join(root, "ck-mc-host");
        writeFileSync(binary, "\x7fELF production launcher\n");
        const qualifiedInputs: Record<string, string> = {};
        const qualifiedInputExpectations: Record<
            string,
            { size_bytes: number; sha256: string }
        > = {};
        for (const input of Object.keys(LINUX_PRODUCTION_PAYLOAD_SLOTS)) {
            const source = join(root, `source-${input}`);
            const bytes = `qualified ${input} bytes\n`;
            writeFileSync(source, bytes);
            qualifiedInputs[input] = source;
            qualifiedInputExpectations[input] = {
                size_bytes: Buffer.byteLength(bytes),
                sha256: sha256Hex(bytes),
            };
        }

        const result = assembleProductionPayload(
            qualifiedContext(),
            targetFor("linux-x64-gnu"),
            {
                outDir: join(root, "out"),
                sources: {
                    binaryPath: binary,
                    qualifiedInputs,
                    qualifiedInputExpectations,
                },
            },
        );

        expect(result.manifest.mode).toBe("production");
        expect(result.manifest.files.map((entry) => entry.path)).toEqual(
            [
                LAUNCHER_PATH,
                ...Object.values(LINUX_PRODUCTION_PAYLOAD_SLOTS),
            ].sort(),
        );
        expect(() => verifyPayloadDir(result.outDir, result.manifest)).not.toThrow();
        expect(payloadManifestDigest(result.manifest)).toBe(result.digest);
        for (const [input, relative] of Object.entries(
            LINUX_PRODUCTION_PAYLOAD_SLOTS,
        )) {
            expect(
                result.manifest.files.find((entry) => entry.path === relative)
                    ?.sha256,
            ).toBe(qualifiedInputExpectations[input]?.sha256);
        }

        writeFileSync(
            qualifiedInputs.model_onnx,
            "mutated model bytes after qualification\n",
        );
        expect(() =>
            assembleProductionPayload(
                qualifiedContext(),
                targetFor("linux-x64-gnu"),
                {
                    outDir: join(root, "mutated"),
                    sources: {
                        binaryPath: binary,
                        qualifiedInputs,
                        qualifiedInputExpectations,
                    },
                },
            ),
        ).toThrow(/differs from the U9 lock/);
    });

    test("macOS host-only payload carries no Linux model bytes", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-production-"));
        tempRoots.push(root);
        const binary = join(root, "ck-mc-host");
        writeFileSync(binary, "Mach-O production launcher\n");

        const result = assembleProductionPayload(
            qualifiedContext(),
            targetFor("darwin-arm64"),
            {
                outDir: join(root, "out"),
                sources: { binaryPath: binary },
            },
        );

        expect(result.manifest.files.map((entry) => entry.path)).toEqual([
            LAUNCHER_PATH,
        ]);
        expect(result.manifest.synapse).toBe("unsupported");
    });

    test("source pathname replacement after open cannot change copied bytes", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-source-swap-"));
        tempRoots.push(root);
        const binary = join(root, "ck-mc-host");
        writeFileSync(binary, "\x7fELF production launcher\n");
        const qualifiedInputs: Record<string, string> = {};
        const qualifiedInputExpectations: Record<
            string,
            { size_bytes: number; sha256: string }
        > = {};
        for (const input of Object.keys(LINUX_PRODUCTION_PAYLOAD_SLOTS)) {
            const source = join(root, `source-${input}`);
            const bytes = `qualified ${input} bytes\n`;
            writeFileSync(source, bytes);
            qualifiedInputs[input] = source;
            qualifiedInputExpectations[input] = {
                size_bytes: Buffer.byteLength(bytes),
                sha256: sha256Hex(bytes),
            };
        }
        const modelPath = qualifiedInputs.model_onnx;
        let swapped = false;
        const result = assembleProductionPayload(
            qualifiedContext(),
            targetFor("linux-x64-gnu"),
            {
                outDir: join(root, "out"),
                sources: {
                    binaryPath: binary,
                    qualifiedInputs,
                    qualifiedInputExpectations,
                    afterSourceOpenForTest(relative, sourcePath) {
                        if (
                            relative ===
                            LINUX_PRODUCTION_PAYLOAD_SLOTS.model_onnx
                        ) {
                            renameSync(sourcePath, `${sourcePath}.opened`);
                            writeFileSync(sourcePath, "attacker replacement");
                            swapped = true;
                        }
                    },
                },
            },
        );
        expect(swapped).toBeTrue();
        expect(
            result.manifest.files.find(
                (entry) =>
                    entry.path ===
                    LINUX_PRODUCTION_PAYLOAD_SLOTS.model_onnx,
            )?.sha256,
        ).toBe(qualifiedInputExpectations.model_onnx?.sha256);
        expect(readFileSync(modelPath, "utf8")).toBe("attacker replacement");
    });

    test("npm 11 packs the manifest and payload from the staged package root", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-production-"));
        tempRoots.push(root);
        const binary = join(root, "ck-mc-host");
        writeFileSync(binary, "Mach-O production launcher\n");
        const result = assembleProductionPayload(
            qualifiedContext(),
            targetFor("darwin-x64"),
            {
                outDir: join(root, "out"),
                packageMetadataDir: join(
                    repoRoot,
                    "packages",
                    "mc-host-darwin-x64",
                ),
                sources: { binaryPath: binary },
            },
        );

        const packed = packProductionPayload(result, join(root, "tarballs"));
        const listing = Bun.spawnSync(["tar", "-tf", packed.tarballPath]);

        expect(listing.exitCode).toBe(0);
        const names = listing.stdout.toString("utf8");
        expect(names).toContain("package/payload-manifest.json");
        expect(names).toContain("package/payload/bin/ck-mc-host");
        expect(() =>
            packProductionPayload(
                { ...result, releaseQualified: false },
                join(root, "blocked-tarballs"),
            ),
        ).toThrow(/gate-bypassed payloads cannot be packed/);
    });

    test("unqualified context and missing Linux inputs fail before a manifest exists", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-production-"));
        tempRoots.push(root);
        const binary = join(root, "ck-mc-host");
        writeFileSync(binary, "\x7fELF production launcher\n");

        expect(() =>
            assembleProductionPayload(
                unqualifiedContext(),
                targetFor("darwin-x64"),
                {
                outDir: join(root, "unqualified"),
                sources: { binaryPath: binary },
                },
            ),
        ).toThrow(/production-qualified/);
        expect(() =>
            assembleProductionPayload(
                qualifiedContext(),
                targetFor("linux-x64-gnu"),
                {
                    outDir: join(root, "missing"),
                    sources: { binaryPath: binary },
                },
            ),
        ).toThrow(/missing qualified/);
    });

    test("complete target outputs become a qualified unpublished parent trust index", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-production-"));
        tempRoots.push(root);
        const outDir = join(root, "out");
        const binary = join(root, "ck-mc-host");
        writeFileSync(binary, "qualified launcher bytes\n");
        const qualifiedInputs: Record<string, string> = {};
        for (const input of Object.keys(LINUX_PRODUCTION_PAYLOAD_SLOTS)) {
            const source = join(root, `source-${input}`);
            writeFileSync(source, `qualified ${input} bytes\n`);
            qualifiedInputs[input] = source;
        }
        const ctx = qualifiedContext();
        for (const target of PAYLOAD_TARGETS) {
            assembleProductionPayload(ctx, target, {
                outDir,
                sources: {
                    binaryPath: binary,
                    ...(target.synapse === "certified_cpu"
                        ? { qualifiedInputs }
                        : {}),
                },
            });
        }

        const artifacts = buildTrustArtifacts(ctx, outDir);

        expect(() => validateTrustIndex(artifacts.index, ctx)).not.toThrow();
        const entries = (artifacts.index.entries as Record<string, unknown>[]);
        expect(entries).toHaveLength(3);
        expect(entries.every((entry) => entry.qualified === true)).toBe(true);
        expect(entries.every((entry) => entry.published === false)).toBe(true);
        expect(
            entries.every(
                (entry) =>
                    typeof entry.payload_manifest_digest === "string" &&
                    typeof entry.bootstrap_launcher_digest === "string",
            ),
        ).toBe(true);
    });
});

describe("dev payload build", () => {
    // `process.platform` reads "linux" on musl systems too, so the only signal
    // separating them is whether the running process is glibc-linked.
    function withReportHeader<T>(header: unknown, body: () => T): T {
        const host = process as unknown as { report?: unknown };
        const original = host.report;
        host.report = { getReport: () => ({ header }) };
        try {
            return body();
        } finally {
            host.report = original;
        }
    }

    test("a Linux host that cannot prove glibc is refused, not labeled -gnu", () => {
        if (process.platform !== "linux") {
            // The gate only guards the matrix's `-gnu` target.
            expect(hostTarget().target).not.toMatch(/-gnu$/);
            return;
        }
        expect(withReportHeader({ glibcVersionRuntime: "2.28" }, () => hostTarget().target)).toBe(
            "linux-x64-gnu",
        );
        // A musl host reports no runtime glibc version. Selecting linux-x64-gnu
        // anyway would stamp a musl-linked launcher with the glibc floor.
        expect(() => withReportHeader({}, () => hostTarget())).toThrow(/not glibc-linked/);
        expect(() => withReportHeader(undefined, () => hostTarget())).toThrow(
            /not glibc-linked/,
        );
    });

    test("dev payload manifest recomputes to the same digest from disk", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-dev-"));
        tempRoots.push(root);
        const fakeBinary = join(root, "ck-mc-host-src");
        writeFileSync(fakeBinary, "\x7fELF fake dev binary bytes\n");
        const result = buildDevPayload(repoRoot, {
            outDir: join(root, "out"),
            binaryPath: fakeBinary,
            target: targetFor("darwin-x64"),
        });
        const ctx = context();
        const reloaded = JSON.parse(readFileSync(result.manifestPath, "utf8"));
        validatePayloadManifest(reloaded, ctx);
        expect(payloadManifestDigest(reloaded)).toBe(result.digest);
        expect(() => verifyPayloadDir(result.outDir, reloaded)).not.toThrow();
        expect(reloaded.mode).toBe("dev");
        expect(reloaded.files).toHaveLength(1);
        expect(result.launcherDigest).toBe(reloaded.files[0].sha256);
    });

    test("staged dev bytes are mutation-detected", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-dev-"));
        tempRoots.push(root);
        const fakeBinary = join(root, "ck-mc-host-src");
        writeFileSync(fakeBinary, "dev binary");
        const result = buildDevPayload(repoRoot, {
            outDir: join(root, "out"),
            binaryPath: fakeBinary,
            target: targetFor("darwin-arm64"),
        });
        writeFileSync(join(result.outDir, LAUNCHER_PATH), "dev binarY");
        expect(() => verifyPayloadDir(result.outDir, result.manifest)).toThrow(
            /digest drift/,
        );
    });
});
