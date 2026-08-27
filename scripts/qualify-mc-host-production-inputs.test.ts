import { afterEach, describe, expect, test } from "bun:test";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildContract } from "./generate-mc-host-release-manifest";
import {
    assertPinsMatchContract,
    buildCredentialsDoc,
    canonicalCredentialRowEncoding,
    checkOracleEvidence,
    evaluateBrocaRun,
    generate,
    OUTPUT_PATHS,
    renderArgumentVariant,
    requireQualificationEvidence,
    ROW_CAP_BYTES,
    SOURCE_MANIFEST_PATH,
    VALUE_CAP_BYTES,
    validateCredentialsDoc,
} from "./qualify-mc-host-production-inputs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = "scripts/__fixtures__/mc-host-qualification";
const FIXTURE_MANIFEST_RELATIVE = join(
    FIXTURE_DIR,
    "source-manifest.test-fixture.json",
);
const FIXTURE_MANIFEST = join(repoRoot, FIXTURE_MANIFEST_RELATIVE);
const RELEASE_CONTRACT = "release/mc-host-release.json";
const TINY_MANIFEST =
    "crates/mc-host/tests/fixtures/synapse-tiny/manifest.json";

const tempRoots: string[] = [];

afterEach(() => {
    while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        if (root !== undefined) rmSync(root, { recursive: true, force: true });
    }
});

function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "mc-host-qual-"));
    tempRoots.push(root);
    for (const relative of [
        RELEASE_CONTRACT,
        "bun.lock",
        "crates/mc-host/Cargo.toml",
        // Required input: the qualifier fails closed without it so a missing
        // manifest cannot silently empty the tiny-fixture hash blacklist.
        TINY_MANIFEST,
        // Present in the real repo, so production qualification must reject its
        // artifact digests wherever those bytes are relocated to.
        FIXTURE_MANIFEST_RELATIVE,
        // The U2/U6 gate re-derives every U8 output, so the registry gate its
        // generation requires and the generated consumer artifacts it compares
        // against must both exist in a staged root.
        "release/mc-host-registry-gate.json",
        "release/generated/mc-host-release-contract.rs",
        "packages/plugin/src/shared/mc-host-lifecycle/generated-contract.ts",
    ]) {
        mkdirSync(join(root, dirname(relative)), { recursive: true });
        cpSync(join(repoRoot, relative), join(root, relative));
    }
    return root;
}

// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the manifest
function fixtureManifest(): any {
    return JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8"));
}

// biome-ignore lint/suspicious/noExplicitAny: tests install mutated manifests
function installManifest(root: string, manifest: any): void {
    cpSync(
        join(repoRoot, FIXTURE_DIR, "artifacts"),
        join(root, FIXTURE_DIR, "artifacts"),
        { recursive: true },
    );
    mkdirSync(join(root, dirname(SOURCE_MANIFEST_PATH)), { recursive: true });
    writeFileSync(
        join(root, SOURCE_MANIFEST_PATH),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
}

/**
 * Where production-mode tests stage artifact bytes. Production qualification
 * denies any verify path under `scripts/__fixtures__`, so a production manifest
 * must name a location outside it — as a real qualifying host would.
 */
const STAGED_PRODUCTION_INPUT_DIR = "opt/mc-host-inputs";

/**
 * Replace every declared digest with a distinct non-blacklisted value. Production
 * mode denies the committed fixture digests outright, which fires before the path
 * rules, so a test targeting a path rule must not carry those digests.
 */
// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the manifest
function unblacklistDigests(manifest: any): void {
    let n = 0;
    for (const artifact of Object.values(manifest.inputs) as {
        sha256: string;
    }[]) {
        artifact.sha256 = createHash("sha256")
            .update(`path-rule probe ${n++}`)
            .digest("hex");
    }
}

// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the manifest
function installProductionManifest(
    root: string,
    mutate?: (manifest: any) => void,
): void {
    const manifest = fixtureManifest();
    manifest.mode = "production";
    const stagedDir = join(root, STAGED_PRODUCTION_INPUT_DIR);
    mkdirSync(stagedDir, { recursive: true });
    // Deliberately NOT the committed fixture bytes: their digests are denied in
    // production mode, so a production manifest must carry distinct bytes and
    // the digests computed from them, exactly as a real qualifying host would.
    for (const [key, artifact] of Object.entries(manifest.inputs) as [
        string,
        { verify_local_path: string; sha256: string; size_bytes: number },
    ][]) {
        const target = join(stagedDir, basename(artifact.verify_local_path));
        const bytes = Buffer.from(`staged production stand-in for ${key}\n`);
        writeFileSync(target, bytes);
        artifact.verify_local_path = target;
        artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
        artifact.size_bytes = bytes.length;
    }
    mutate?.(manifest);
    installManifest(root, manifest);
}

// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the doc
function credentialsCopy(): any {
    return JSON.parse(JSON.stringify(buildCredentialsDoc()));
}

// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the contract
function contractCopy(): any {
    return JSON.parse(JSON.stringify(buildContract()));
}

/**
 * Overwrite a cited qualification artifact and re-point every evidence citation
 * at the bytes now on disk, so no digest check can fire. A test using this is
 * aiming at what the gate believes about an artifact's *contents*, not at
 * whether it noticed a digest mismatch.
 */
function recite(root: string, artifactPath: string, bytes: string): void {
    writeFileSync(artifactPath, bytes);
    const evidencePath = join(root, OUTPUT_PATHS.evidence);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    for (const [key, relative] of [
        ["production_inputs_lock", OUTPUT_PATHS.lock],
        ["provider_credentials", OUTPUT_PATHS.credentials],
    ] as const) {
        evidence.artifacts[key].sha256 = createHash("sha256")
            .update(readFileSync(join(root, relative), "utf8"))
            .digest("hex");
    }
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

describe("deterministic generation and drift", () => {
    test("two qualifications over the same inputs are byte-identical", () => {
        const rootA = freshRoot();
        const rootB = freshRoot();
        installManifest(rootA, fixtureManifest());
        installManifest(rootB, fixtureManifest());
        const first = generate(rootA, { check: false });
        const second = generate(rootB, { check: false });
        expect(first.lockSha256).toBe(second.lockSha256);
        expect(first.credentialsSha256).toBe(second.credentialsSha256);
        for (const relative of Object.values(OUTPUT_PATHS)) {
            expect(readFileSync(join(rootA, relative), "utf8")).toBe(
                readFileSync(join(rootB, relative), "utf8"),
            );
        }
    });

    test("committed outputs match a clean regeneration (--check green)", () => {
        const result = generate(repoRoot, { check: true });
        expect(result.drift).toEqual([]);
        expect(result.productionQualified).toBe(false);
    });

    test("pins, floors, budgets, and layout IDs drift only through regeneration", () => {
        const root = freshRoot();
        installManifest(root, fixtureManifest());
        generate(root, { check: false });
        for (const relative of Object.values(OUTPUT_PATHS)) {
            const path = join(root, relative);
            const original = readFileSync(path, "utf8");
            writeFileSync(path, `${original.trimEnd()} \n`);
            expect(
                generate(root, { check: true }).drift.some((line) =>
                    line.startsWith(relative),
                ),
            ).toBe(true);
            writeFileSync(path, original);
        }
        const lockPath = join(root, OUTPUT_PATHS.lock);
        const lockOriginal = readFileSync(lockPath, "utf8");
        writeFileSync(lockPath, lockOriginal.replace('"4.18"', '"4.19"'));
        expect(
            generate(root, { check: true }).drift.some((line) =>
                line.startsWith(OUTPUT_PATHS.lock),
            ),
        ).toBe(true);
        writeFileSync(lockPath, lockOriginal);
        expect(generate(root, { check: true }).drift).toEqual([]);
    });

    test("stale or edited U8 contract fails closed", () => {
        const root = freshRoot();
        installManifest(root, fixtureManifest());
        const contractPath = join(root, RELEASE_CONTRACT);
        const original = readFileSync(contractPath, "utf8");
        writeFileSync(contractPath, original.replace('"0.38.0"', '"0.38.1"'));
        expect(() => generate(root, { check: false })).toThrow(
            /stale or edited U8 release contract/,
        );
        rmSync(contractPath);
        expect(() => generate(root, { check: false })).toThrow(
            /missing U8 release contract/,
        );
    });
});

describe("immutable input fail-closed rules", () => {
    test("a one-byte artifact mutation fails before any production build", () => {
        const root = freshRoot();
        installManifest(root, fixtureManifest());
        const bytesPath = join(root, FIXTURE_DIR, "artifacts", "model.onnx");
        const bytes = readFileSync(bytesPath);
        bytes[0] = bytes[0] ^ 1;
        writeFileSync(bytesPath, bytes);
        expect(() => generate(root, { check: false })).toThrow(
            /inputs\.model_onnx: byte digest does not match/,
        );
    });

    test("a wrong locked size fails", () => {
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.inputs.corpus.size_bytes += 1;
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /inputs\.corpus: byte size/,
        );
    });

    test("mutable source identity is rejected", () => {
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.inputs.model_onnx.source =
            "https://models.example.invalid/gte-modernbert-base-f16/resolve/main/model.onnx";
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /mutable source identity/,
        );
    });

    test("a mutable ref as the final path segment is rejected", () => {
        // No trailing slash follows the ref, so a substring match on `/main/`
        // misses it while the URL still names a moving branch.
        for (const ref of ["main", "master", "latest", "HEAD", "nightly"]) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            manifest.inputs.model_onnx.source =
                `https://models.example.invalid/gte-modernbert-base-f16/resolve/${ref}`;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(
                new RegExp(`mutable source identity \\(${ref} ref\\)`),
            );
        }
    });

    test("a percent-encoded mutable ref is rejected", () => {
        // `URL.pathname` preserves the encoding, so a literal comparison would
        // miss `ma%69n` even though the server resolves it as `main`.
        for (const encoded of ["ma%69n", "MAIN", "%4cATEST"]) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            manifest.inputs.model_onnx.source =
                `https://models.example.invalid/m/resolve/${encoded}/model.onnx`;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(
                /mutable source identity/,
            );
        }
    });

    test("an unparseable source URL fails with the tool's framing", () => {
        // `startsWith("https://")` does not imply parseability; a raw
        // `TypeError: Invalid URL` would lose the consistent failure prefix.
        const root = freshRoot();
        const manifest = fixtureManifest();
        // An unterminated IPv6 bracket is unparseable; a space in the path is
        // only percent-encoded, so it would not exercise the catch.
        manifest.inputs.model_onnx.source = "https://[invalid/model.onnx";
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /inputs\.model_onnx: source is not a parseable URL/,
        );
    });

    test("a mutable ref in the query string is rejected", () => {
        // An endpoint can name its revision outside the path, and such a URL
        // keeps resolving a moving target however immutable its path looks.
        for (const source of [
            "https://artifacts.example.invalid/download?ref=main",
            "https://artifacts.example.invalid/download?rev=v1&branch=LATEST",
            "https://artifacts.example.invalid/d?path=repo/main/model.onnx",
        ]) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            manifest.inputs.model_onnx.source = source;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(
                /mutable source identity/,
            );
        }
    });

    test("a mutable ref behind encoded separators is rejected", () => {
        // One raw path segment, but a server that decodes escaped separators
        // resolves it through the moving ref. Comparing the decoded value
        // wholesale against the ref set misses it.
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.inputs.model_onnx.source =
            "https://artifacts.example.invalid/repo/resolve%2Fmain%2Fmodel.onnx";
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /mutable source identity \(main ref\)/,
        );
    });

    test("a source URL fragment is rejected outright", () => {
        // A fragment never reaches the server, so it cannot select artifact
        // bytes; what it can do is carry an OAuth-style token that `buildLock`
        // would copy into the committed lock.
        for (const source of [
            "https://artifacts.example.invalid/rev/abc123/model.onnx#access_token=secret",
            "https://artifacts.example.invalid/rev/abc123/model.onnx#HEAD",
            "https://artifacts.example.invalid/rev/abc123/model.onnx#anything",
        ]) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            manifest.inputs.model_onnx.source = source;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(
                /source must not carry a URL fragment/,
            );
        }
    });

    test("a source URL carrying credentials is rejected", () => {
        // `buildLock` copies `source` verbatim into a committed artifact, so
        // accepting either shape would publish the secret in Git permanently.
        const withUserinfo = freshRoot();
        const userinfoManifest = fixtureManifest();
        userinfoManifest.inputs.model_onnx.source =
            "https://user:token@models.example.invalid/rev/abc123/model.onnx";
        installManifest(withUserinfo, userinfoManifest);
        expect(() => generate(withUserinfo, { check: false })).toThrow(
            /source must not embed URL credentials/,
        );

        for (const param of [
            "access_token=abc",
            "X-Amz-Signature=abc",
            "apiKey=abc",
            "sig=abc",
        ]) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            manifest.inputs.model_onnx.source =
                `https://models.example.invalid/rev/abc123/model.onnx?${param}`;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(
                /carries a credential and is rejected/,
            );
        }
    });

    test("placeholder hashes are rejected", () => {
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.inputs.ort_runtime.sha256 = "0".repeat(64);
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /placeholder hash/,
        );
    });

    test("production mode rejects the committed qualification fixtures", () => {
        // The fixture artifacts are tiny text stand-ins named `model.onnx` and
        // `ort-runtime.so` with `example.invalid` provenance. Two independent
        // mechanisms must keep them out of a production lock.

        // 1. By digest, which survives relocating the bytes anywhere.
        const relocated = freshRoot();
        const byHash = fixtureManifest();
        byHash.mode = "production";
        const staged = join(relocated, "opt/relocated-inputs");
        mkdirSync(staged, { recursive: true });
        cpSync(join(repoRoot, FIXTURE_DIR, "artifacts"), staged, {
            recursive: true,
        });
        for (const artifact of Object.values(byHash.inputs) as {
            verify_local_path: string;
        }[]) {
            artifact.verify_local_path = join(
                staged,
                basename(artifact.verify_local_path),
            );
        }
        installManifest(relocated, byHash);
        expect(() => generate(relocated, { check: false })).toThrow(
            /committed tiny fixture bytes can never qualify/,
        );

        // 2. By path, for bytes carrying digests the blacklist does not know.
        const inPlace = freshRoot();
        const byPath = fixtureManifest();
        byPath.mode = "production";
        unblacklistDigests(byPath);
        for (const artifact of Object.values(byPath.inputs) as {
            verify_local_path: string;
        }[]) {
            artifact.verify_local_path = join(
                inPlace,
                artifact.verify_local_path,
            );
        }
        installManifest(inPlace, byPath);
        expect(() => generate(inPlace, { check: false })).toThrow(
            /fixture\/developer-cache verify path \(__fixtures__\)/,
        );
    });

    test("the committed tiny fixture can never qualify, by path or by hash", () => {
        const rootA = freshRoot();
        const byPath = fixtureManifest();
        byPath.inputs.model_onnx.verify_local_path =
            "crates/mc-host/tests/fixtures/synapse-tiny/model.onnx";
        installManifest(rootA, byPath);
        expect(() => generate(rootA, { check: false })).toThrow(
            /fixture\/developer-cache verify path/,
        );

        const rootB = freshRoot();
        const tiny = JSON.parse(
            readFileSync(join(repoRoot, TINY_MANIFEST), "utf8"),
        );
        const byHash = fixtureManifest();
        byHash.inputs.model_onnx.sha256 = tiny.model_file.sha256;
        installManifest(rootB, byHash);
        expect(() => generate(rootB, { check: false })).toThrow(
            /tiny fixture bytes can never qualify/,
        );
    });

    test("developer-cache and home-relative verify paths are rejected", () => {
        for (const path of [
            "~/models/model.onnx",
            "/home/dev/.cache/huggingface/model.onnx",
            "node_modules/.cache/model.onnx",
        ]) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            manifest.inputs.model_onnx.verify_local_path = path;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(
                /verify path/,
            );
        }
    });

    test("missing or unapproved license blocks qualification", () => {
        const casesAndErrors: [
            (m: ReturnType<typeof fixtureManifest>) => void,
            RegExp,
        ][] = [
            [
                (m) => {
                    m.inputs.model_onnx.license.redistribution_approved =
                        false;
                },
                /redistribution approval is required/,
            ],
            [
                (m) => {
                    m.inputs.model_onnx.license.spdx = "SSPL-1.0";
                },
                /not an approved redistribution license/,
            ],
            [
                (m) => {
                    m.inputs.model_onnx.license.approved_by = "";
                },
                /must name an approver/,
            ],
            [
                (m) => {
                    m.inputs.model_onnx.license = undefined;
                },
                /license/,
            ],
        ];
        for (const [mutate, error] of casesAndErrors) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            mutate(manifest);
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(error);
        }
    });

    test("whitespace-only attestations are rejected", () => {
        // A blank string reads as an approver or a provenance record in the
        // committed lock while asserting nothing, so a length check is not enough.
        const cases: [(manifest: any) => void, RegExp][] = [
            [
                (m) => {
                    m.inputs.model_onnx.provenance = "   ";
                },
                /provenance is required/,
            ],
            [
                (m) => {
                    m.inputs.model_onnx.license.approved_by = "\t\n ";
                },
                /must name an approver/,
            ],
            [
                (m) => {
                    m.inputs.model_onnx.verify_local_path = "  ";
                },
                /must verify real local bytes/,
            ],
            [
                (m) => {
                    m.inputs.model_onnx = { qualified: false, reason: " " };
                },
                /unqualified entries must state a reason/,
            ],
            [
                (m) => {
                    m.harnesses.pi = {
                        package: "@earendil-works/pi-coding-agent",
                        version: null,
                        unqualified_reason: "  ",
                    };
                },
                /an unqualified version must state a reason/,
            ],
        ];
        for (const [mutate, error] of cases) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            mutate(manifest);
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(error);
        }
    });

    test("production mode requires absolute verify paths and bun.lock pins", () => {
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.mode = "production";
        unblacklistDigests(manifest);
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /requires an absolute verify path/,
        );

        const rootPi = freshRoot();
        const badPi = fixtureManifest();
        badPi.harnesses.pi.version = "9.9.9";
        installManifest(rootPi, badPi);
        expect(() => generate(rootPi, { check: false })).toThrow(
            /does not match the resolved bun\.lock pin/,
        );
    });

    test("the Pi version is the one the workspace resolves, not any in the lock", () => {
        const pkg = "@earendil-works/pi-coding-agent";

        // A transitive copy at an unrelated version satisfies a substring search
        // for `"<pkg>@<version>"` while the workspace resolves to something else.
        const decoy = freshRoot();
        const lockPath = join(decoy, "bun.lock");
        const lock = readFileSync(lockPath, "utf8");
        writeFileSync(
            lockPath,
            lock.replace(
                `    "${pkg}": [`,
                `    "some-other-package/${pkg}": ["${pkg}@0.79.0", "", {}, "sha512-decoy"],\n\n    "${pkg}": [`,
            ),
        );
        const citesDecoy = fixtureManifest();
        citesDecoy.harnesses.pi.version = "0.79.0";
        installManifest(decoy, citesDecoy);
        expect(() => generate(decoy, { check: false })).toThrow(
            /does not match the resolved bun\.lock pin \(0\.80\.2\)/,
        );

        // A nested resolution outranks the hoisted one. Bun keys it by the
        // consumer's package name, never by its directory.
        const nested = freshRoot();
        const nestedLockPath = join(nested, "bun.lock");
        writeFileSync(
            nestedLockPath,
            readFileSync(nestedLockPath, "utf8").replace(
                `    "${pkg}": [`,
                `    "@cortexkit/pi-magic-context/${pkg}": ["${pkg}@0.81.0", "", {}, "sha512-nested"],\n\n    "${pkg}": [`,
            ),
        );
        const citesNested = fixtureManifest();
        citesNested.harnesses.pi.version = "0.81.0";
        installManifest(nested, citesNested);
        expect(() => generate(nested, { check: false })).not.toThrow();

        // A directory-keyed entry is not a Bun resolution and must not be read
        // as one, or the check silently falls back to the hoisted version.
        const pathKeyed = freshRoot();
        const pathKeyedLock = join(pathKeyed, "bun.lock");
        writeFileSync(
            pathKeyedLock,
            readFileSync(pathKeyedLock, "utf8").replace(
                `    "${pkg}": [`,
                `    "packages/pi-plugin/${pkg}": ["${pkg}@0.81.0", "", {}, "sha512-pathkeyed"],\n\n    "${pkg}": [`,
            ),
        );
        const citesPathKeyed = fixtureManifest();
        citesPathKeyed.harnesses.pi.version = "0.81.0";
        installManifest(pathKeyed, citesPathKeyed);
        expect(() => generate(pathKeyed, { check: false })).toThrow(
            /does not match the resolved bun\.lock pin \(0\.80\.2\)/,
        );

        // A hoisted entry is only the workspace's resolution if the workspace
        // still depends on the package. Otherwise the lock would record a version
        // nothing in the released workspace binds to.
        const undeclared = freshRoot();
        const undeclaredLock = join(undeclared, "bun.lock");
        writeFileSync(
            undeclaredLock,
            readFileSync(undeclaredLock, "utf8")
                .replace(`        "${pkg}": "^0.80.2",\n`, "")
                .replace(`        "${pkg}": "^0.80.2",\n`, ""),
        );
        installManifest(undeclared, fixtureManifest());
        expect(() => generate(undeclared, { check: false })).toThrow(
            /bun\.lock does not resolve/,
        );

        // An unreadable or unresolved lockfile fails closed rather than passing.
        const unreadable = freshRoot();
        writeFileSync(join(unreadable, "bun.lock"), "{not json\n");
        installManifest(unreadable, fixtureManifest());
        expect(() => generate(unreadable, { check: false })).toThrow(
            /bun\.lock does not resolve/,
        );
    });

    test("a forbidden ORT capability in Cargo.toml fails production closed", () => {
        // The declared array is not the effective feature closure, but adding a
        // download, TLS, or accelerator feature while leaving the version pin
        // untouched is exactly the edit the version-only check missed.
        const cargoPath = "crates/mc-host/Cargo.toml";
        const cases: [(cargo: string) => string, RegExp][] = [
            [
                (cargo) =>
                    cargo.replace(
                        '"load-dynamic", "ndarray", "std"',
                        '"load-dynamic", "ndarray", "std", "download-binaries"',
                    ),
                /ort feature download-binaries .* outside the qualified closure/,
            ],
            [
                (cargo) =>
                    cargo.replace(
                        '"ort-load-dynamic"',
                        '"ort-load-dynamic", "hf-hub"',
                    ),
                /fastembed feature hf-hub .* outside the qualified closure/,
            ],
            [
                (cargo) =>
                    cargo.replace(
                        'ort = { version = "=2.0.0-rc.13", default-features = false,',
                        'ort = { version = "=2.0.0-rc.13",',
                    ),
                /ort .* must set default-features = false/,
            ],
            [
                // The same declaration reformatted across lines. A one-line scan
                // sees no closing bracket, finds no features array, and would
                // pass vacuously.
                (cargo) =>
                    cargo.replace(
                        'features = ["load-dynamic", "ndarray", "std"] }',
                        'features = [\n    "load-dynamic",\n    "ndarray",\n    "std",\n    "download-binaries",\n] }',
                    ),
                /ort feature download-binaries .* outside the qualified closure/,
            ],
            [
                // A features key whose array cannot be read must fail, not be
                // treated as an empty list.
                (cargo) =>
                    cargo.replace(
                        'features = ["load-dynamic", "ndarray", "std"] }',
                        'features = FEATURES }',
                    ),
                /declares a features list this qualifier cannot read/,
            ],
            [
                // The section form puts the crate's keys on lines this text scan
                // cannot attribute to it, so it must be rejected outright.
                (cargo) =>
                    cargo.replace(
                        /^ort = .*$/m,
                        '[dependencies.ort]\nversion = "=2.0.0-rc.13"\ndefault-features = false\nfeatures = ["load-dynamic"]',
                    ),
                /ort must be declared exactly once/,
            ],
            [
                // A decoy assignment under an unrelated table. A scan that
                // ignores section headers validates the decoy and never reaches
                // the real dependency's forbidden feature.
                (cargo) =>
                    cargo
                        .replace(
                            '"load-dynamic", "ndarray", "std"',
                            '"load-dynamic", "ndarray", "std", "download-binaries"',
                        )
                        .replace(
                            "[dependencies]",
                            '[package.metadata.qualification]\nort = { version = "=2.0.0-rc.13", default-features = false, features = ["load-dynamic"] }\n\n[dependencies]',
                        ),
                /ort must be declared exactly once/,
            ],
            [
                // A comment is the one place Cargo.toml can hold text that reads
                // exactly like a declaration and means nothing. The real pin here
                // is rc.12; the commented rc.13 must not satisfy the check.
                (cargo) =>
                    cargo.replace(
                        'ort = { version = "=2.0.0-rc.13", default-features = false, features = ["load-dynamic", "ndarray", "std"] }',
                        'ort = { version = "=2.0.0-rc.12", default-features = false, features = [\n    # version = "=2.0.0-rc.13"\n    "load-dynamic",\n] }',
                    ),
                /pinned ort identity does not match/,
            ],
            [
                // Same shape, faking the default-features opt-out instead.
                (cargo) =>
                    cargo.replace(
                        'ort = { version = "=2.0.0-rc.13", default-features = false, features = ["load-dynamic", "ndarray", "std"] }',
                        'ort = { version = "=2.0.0-rc.13", features = [\n    # default-features = false\n    "load-dynamic",\n] }',
                    ),
                /ort .* must set default-features = false/,
            ],
            [
                // A `#` inside a quoted value is not a comment, so the entry must
                // survive intact rather than be truncated into a rejection.
                (cargo) =>
                    cargo.replace(
                        '"load-dynamic", "ndarray", "std"',
                        '"load-dynamic", "ndarray", "std", "cuda#notacomment"',
                    ),
                /ort feature cuda#notacomment .* outside the qualified closure/,
            ],
            [
                // TOML allows any whitespace around `=`, so a target-specific
                // duplicate spelled `ort={ ... }` must still be counted. Missing it
                // leaves its accelerator feature unchecked while the base entry
                // validates cleanly — and Cargo unifies both into the resolved set.
                (cargo) =>
                    `${cargo}\n[target.'cfg(target_os = "linux")'.dependencies]\nort={ version = "=2.0.0-rc.13", default-features = false, features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // A quoted key can carry escapes: Cargo reads `"o\u0072t"` as
                // `ort` and unifies its features. A scan that cannot decode the
                // spelling must refuse the file, not treat it as a different key
                // and validate only the safe base entry.
                (cargo) =>
                    `${cargo}\n[target.'cfg(target_os = "linux")'.dependencies]\n"o\\u0072t" = { version = "=2.0.0-rc.13", default-features = false, features = ["cuda"] }\n`,
                // Crate-agnostic: an unreadable dependency table means no crate's
                // closure can be checked, so whichever is validated first reports.
                /must be declared exactly once/,
            ],
        ];
        for (const [mutate, error] of cases) {
            const root = freshRoot();
            installProductionManifest(root);
            const path = join(root, cargoPath);
            const mutated = mutate(readFileSync(path, "utf8"));
            expect(mutated).not.toBe(readFileSync(path, "utf8"));
            writeFileSync(path, mutated);
            expect(() => generate(root, { check: false })).toThrow(error);
        }
    });
});

describe("oracle evidence hook", () => {
    test("recorded oracle evidence qualifies; absence fails closed", () => {
        const qualified = freshRoot();
        installProductionManifest(qualified);
        const withOracle = generate(qualified, { check: false });
        expect(withOracle.productionQualified).toBe(true);

        const absent = freshRoot();
        installProductionManifest(absent, (manifest) => {
            manifest.oracle = null;
        });
        const result = generate(absent, { check: false });
        expect(result.productionQualified).toBe(false);
        const evidence = JSON.parse(
            readFileSync(join(absent, OUTPUT_PATHS.evidence), "utf8"),
        );
        expect(evidence.production_qualified).toBe(false);
        expect(
            evidence.unqualified.some((line: string) =>
                line.startsWith("oracle:"),
            ),
        ).toBe(true);
    });

    test("real host version strings agree with the platform gate", () => {
        // `compareDotted` exists to read these spellings; a format pre-filter
        // here would reject hosts that `evaluatePlatform` accepts on the same
        // floors, which is the disagreement the shared comparator prevents.
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.oracle.host.kernel = "4.18.0-513.el8.x86_64";
        manifest.oracle.host.glibc = "2.28-236.el8";
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).not.toThrow();

        // Below the floor still fails closed.
        const low = freshRoot();
        const lowManifest = fixtureManifest();
        lowManifest.oracle.host.kernel = "2.6.32-696.el6.x86_64";
        installManifest(low, lowManifest);
        expect(() => generate(low, { check: false })).toThrow(
            /host must meet the exact minimum Linux floor/,
        );
    });

    test("a truncated host version cannot clear a floor on one component", () => {
        // `compareDotted` scores a missing component as 0, so a value shorter
        // than the floor is compared as if its absent components were zeros and
        // one high segment decides the result alone.
        for (const [field, value] of [
            ["kernel", "999garbage"],
            ["glibc", "999garbage"],
            ["kernel", "5"],
        ] as const) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            manifest.oracle.host[field] = value;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(
                /host must meet the exact minimum Linux floor/,
            );
        }
    });

    test("a prerelease host version does not satisfy the stable floor", () => {
        // `compareDotted` reads leading digits only, so a release candidate
        // scores exactly equal to the floor it actually precedes.
        for (const [field, value] of [
            ["kernel", "4.18-rc1"],
            ["kernel", "4.18.0-rc2"],
            ["glibc", "2.28-pre"],
            ["glibc", "2.28-beta3"],
        ] as const) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            manifest.oracle.host[field] = value;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(
                /host must meet the exact minimum Linux floor/,
            );
        }

        // A numeric release suffix means the opposite — the floor plus patches —
        // and a prerelease is only disqualifying while the version sits exactly
        // at the floor.
        for (const [field, value] of [
            ["kernel", "4.18.0-513.el8.x86_64"],
            ["glibc", "2.28-236.el8"],
            ["kernel", "4.19-rc1"],
            ["kernel", "4.18.1-rc2"],
        ] as const) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            manifest.oracle.host[field] = value;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).not.toThrow();
        }
    });

    test("mismatched oracle evidence is rejected", () => {
        const contract = buildContract();
        const base = fixtureManifest().oracle;
        const cases: [(o: typeof base) => void, RegExp][] = [
            [
                // A mis-cased nested key must be reported as an unknown key,
                // not fall through as an absent version.
                (o) => {
                    o.host = {
                        target: o.host.target,
                        Kernel: o.host.kernel,
                        glibc: o.host.glibc,
                    } as unknown as typeof o.host;
                },
                /oracle\.host/,
            ],
            [
                (o) => {
                    o.execution_provider = "cuda";
                },
                /execution provider must be cpu/,
            ],
            [
                (o) => {
                    o.model_fingerprint = "f".repeat(64);
                },
                /model fingerprint must be a real 64-hex digest/,
            ],
            [
                (o) => {
                    o.network_access = "resolved";
                },
                /network access must be none/,
            ],
            [
                (o) => {
                    o.tolerance = 0.2;
                },
                /tolerance must be finite/,
            ],
            [
                (o) => {
                    o.host.kernel = "4.17";
                },
                /minimum Linux floor/,
            ],
            [
                (o) => {
                    o.host.target = "darwin-arm64";
                },
                /linux-x64-gnu lane/,
            ],
        ];
        for (const [mutate, error] of cases) {
            const oracle = JSON.parse(JSON.stringify(base));
            mutate(oracle);
            expect(() => checkOracleEvidence(oracle, contract)).toThrow(error);
        }
        expect(() => checkOracleEvidence(base, contract)).not.toThrow();
    });
});

describe("provider-credential matrix", () => {
    const doc = buildCredentialsDoc();

    test("matrix pins agree with the U8 contract", () => {
        validateCredentialsDoc(doc, buildContract());
        assertPinsMatchContract(buildContract());
    });

    test("a repeated template placeholder fails the one-to-one check", () => {
        // Keyed by name, a Map collapses the duplicate and reports size 1 for a
        // 1-field variant. `renderArgumentVariant` substitutes only
        // `field.position`, so the other `{model}` would survive into argv.
        const bad = credentialsCopy();
        const [harness] = Object.keys(bad.harnesses);
        const variants = bad.harnesses[harness].argument_variants.variants;
        const [variantName] = Object.keys(variants);
        const variant = variants[variantName];
        const [fieldName, field] = Object.entries(
            variant.fields as Record<string, { position: number }>,
        )[0];
        variant.template = ["--flag", `{${fieldName}}`, `{${fieldName}}`];
        variant.fields = { [fieldName]: { ...field, position: 1 } };
        expect(() => validateCredentialsDoc(bad, buildContract())).toThrow(
            /fields and template placeholders must correspond one-to-one/,
        );
    });

    test("mismatched U8 values fail closed", () => {
        const badCaps = contractCopy();
        badCaps.harness_unavailable.row_cap_bytes = 32768;
        expect(() => validateCredentialsDoc(doc, badCaps)).toThrow(
            /credential caps disagree/,
        );
        const badReasons = contractCopy();
        badReasons.harness_unavailable.reasons_by_precedence.pop();
        expect(() => validateCredentialsDoc(doc, badReasons)).toThrow(
            /must cover exactly the U8 harness_unavailable_reason union/,
        );
        const badFloor = contractCopy();
        badFloor.platforms.supported[2].kernel_min = "4.19";
        expect(() => assertPinsMatchContract(badFloor)).toThrow(
            /linux floor pins disagree/,
        );
        const badLayouts = contractCopy();
        badLayouts.install_layouts = ["npm_hoisted"];
        expect(() => assertPinsMatchContract(badLayouts)).toThrow(
            /install layout IDs disagree/,
        );
    });

    test("unsupported auth mechanisms map exactly to auth_mechanism_unsupported", () => {
        for (const mechanism of doc.unsupported_auth_mechanisms) {
            const result = evaluateBrocaRun(doc, {
                harness: "opencode",
                provider: "anthropic",
                mechanism,
                credentials: { ANTHROPIC_API_KEY: "k" },
            });
            expect(result).toEqual({
                ok: false,
                reason: "auth_mechanism_unsupported",
            });
        }
    });

    test("unknown/custom providers map exactly to provider_unsupported", () => {
        for (const provider of ["acme-llm", "amazon-bedrock", "vertex"]) {
            for (const harness of ["opencode", "pi"]) {
                expect(
                    evaluateBrocaRun(doc, {
                        harness,
                        provider,
                        credentials: {},
                    }),
                ).toEqual({ ok: false, reason: "provider_unsupported" });
            }
        }
        // Pi subscription aliases are not OpenCode providers.
        expect(
            evaluateBrocaRun(doc, {
                harness: "opencode",
                provider: "openai-codex",
                credentials: { OPENAI_API_KEY: "k" },
            }),
        ).toEqual({ ok: false, reason: "provider_unsupported" });
    });

    test("Pi alias fallback selects only the canonical row", () => {
        const result = evaluateBrocaRun(doc, {
            harness: "pi",
            provider: "openai-codex",
            credentials: { OPENAI_API_KEY: "k", GEMINI_API_KEY: "other" },
        });
        expect(result).toEqual({
            ok: true,
            provider: "openai",
            variables: ["OPENAI_API_KEY"],
            viaAlias: "openai-codex",
        });
        // The alias's own subscription mechanism is unsupported.
        expect(
            evaluateBrocaRun(doc, {
                harness: "pi",
                provider: "openai-codex",
                mechanism: "subscription_oauth",
                credentials: { OPENAI_API_KEY: "k" },
            }),
        ).toEqual({ ok: false, reason: "auth_mechanism_unsupported" });
    });

    test("absent or empty credentials map to credential_missing", () => {
        for (const credentials of [{}, { ANTHROPIC_API_KEY: "" }]) {
            expect(
                evaluateBrocaRun(doc, {
                    harness: "pi",
                    provider: "anthropic",
                    credentials,
                }),
            ).toEqual({ ok: false, reason: "credential_missing" });
        }
    });

    test("16 KiB value boundary is exact", () => {
        const at = evaluateBrocaRun(doc, {
            harness: "opencode",
            provider: "openai",
            credentials: { OPENAI_API_KEY: "v".repeat(VALUE_CAP_BYTES) },
        });
        expect(at.ok).toBe(true);
        expect(
            evaluateBrocaRun(doc, {
                harness: "opencode",
                provider: "openai",
                credentials: {
                    OPENAI_API_KEY: "v".repeat(VALUE_CAP_BYTES + 1),
                },
            }),
        ).toEqual({ ok: false, reason: "credential_value_too_large" });
    });

    test("64 KiB row boundary is exact, with individual-size precedence", () => {
        const doc4 = credentialsCopy();
        doc4.harnesses.opencode.providers.openai.credential_variables = [
            "K1",
            "K2",
            "K3",
            "K4",
        ];
        const nameBytes = 8;
        const filler = VALUE_CAP_BYTES;
        const last = ROW_CAP_BYTES - nameBytes - 3 * filler;
        expect(last).toBeLessThanOrEqual(VALUE_CAP_BYTES);
        const exactly = {
            K1: "a".repeat(filler),
            K2: "b".repeat(filler),
            K3: "c".repeat(filler),
            K4: "d".repeat(last),
        };
        expect(
            evaluateBrocaRun(doc4, {
                harness: "opencode",
                provider: "openai",
                credentials: exactly,
            }).ok,
        ).toBe(true);
        expect(
            evaluateBrocaRun(doc4, {
                harness: "opencode",
                provider: "openai",
                credentials: { ...exactly, K4: "d".repeat(last + 1) },
            }),
        ).toEqual({ ok: false, reason: "credential_row_too_large" });
        // A row failing both caps reports the individual value first.
        expect(
            evaluateBrocaRun(doc4, {
                harness: "opencode",
                provider: "openai",
                credentials: {
                    ...exactly,
                    K4: "d".repeat(VALUE_CAP_BYTES + 1),
                },
            }),
        ).toEqual({ ok: false, reason: "credential_value_too_large" });
    });

    test("wildcard and ambient-state variable names are rejected statically", () => {
        for (const name of [
            "OPENAI_*",
            "HOME",
            "XDG_CONFIG_HOME",
            "HTTPS_PROXY",
            "npm_config_registry",
            "SSH_AUTH_SOCK",
            "GITHUB_TOKEN",
            "LD_PRELOAD",
        ]) {
            const bad = credentialsCopy();
            bad.harnesses.pi.providers.openai.credential_variables = [name];
            expect(() => validateCredentialsDoc(bad, buildContract())).toThrow(
                /wildcards rejected|forbidden ambient state/,
            );
        }
    });
});

describe("credential-row fingerprint canonicalization", () => {
    test("reorder and value changes produce distinct encodings", () => {
        const rowA: [string, string][] = [
            ["OPENAI_API_KEY", "secret-one"],
            ["OPENAI_ORG_ID", "org-two"],
        ];
        const same = canonicalCredentialRowEncoding("pi", "openai", rowA);
        expect(canonicalCredentialRowEncoding("pi", "openai", rowA)).toBe(
            same,
        );
        const reordered = canonicalCredentialRowEncoding("pi", "openai", [
            rowA[1],
            rowA[0],
        ]);
        expect(reordered).not.toBe(same);
        const changedValue = canonicalCredentialRowEncoding("pi", "openai", [
            ["OPENAI_API_KEY", "secret-one!"],
            ["OPENAI_ORG_ID", "org-two"],
        ]);
        expect(changedValue).not.toBe(same);
        expect(
            canonicalCredentialRowEncoding("opencode", "openai", rowA),
        ).not.toBe(same);
        // Length prefixes remove delimiter ambiguity across name/value splits.
        expect(
            canonicalCredentialRowEncoding("pi", "openai", [["AB", "C"]]),
        ).not.toBe(
            canonicalCredentialRowEncoding("pi", "openai", [["A", "BC"]]),
        );
    });

    test("no fingerprint or credential value enters any release artifact", () => {
        const root = freshRoot();
        installManifest(root, fixtureManifest());
        const result = generate(root, { check: false });
        const sampleEncoding = canonicalCredentialRowEncoding("pi", "openai", [
            ["OPENAI_API_KEY", "sample-secret-value"],
        ]);
        for (const text of Object.values(result.outputs)) {
            expect(text).not.toContain("sample-secret-value");
            expect(text).not.toContain(sampleEncoding);
        }
        const credentials = JSON.parse(result.outputs.credentials);
        expect(credentials.fingerprint.emitted).toBe(false);
        expect(credentials.fingerprint.domain).toBe(
            "subc-broca-credential-v1",
        );
    });
});

describe("typed argument variants", () => {
    const doc = buildCredentialsDoc();

    test("a valid variant renders one exact fixed isolation argv", () => {
        const opencode = renderArgumentVariant(doc, "opencode", "run_prompt", {
            model: "anthropic/claude-sonnet-4",
            prompt: "summarize the repo",
        });
        expect(opencode).toEqual({
            ok: true,
            argv: [
                "run",
                "--model",
                "anthropic/claude-sonnet-4",
                "summarize the repo",
            ],
        });
        const pi = renderArgumentVariant(doc, "pi", "run_prompt", {
            model: "openai/gpt-5",
            prompt: "hello",
        });
        expect(pi.ok).toBe(true);
        if (pi.ok) {
            expect(pi.argv).toEqual([
                "--print",
                "--mode",
                "json",
                "--no-session",
                "--no-skills",
                "--no-prompt-templates",
                "--no-context-files",
                "--no-extensions",
                "--model",
                "openai/gpt-5",
                "hello",
            ]);
        }
    });

    test("raw flags, --, duplicates, and flag-like values fail qualification", () => {
        const cases: [string, Record<string, unknown>][] = [
            ["flag-like value", { model: "openai/gpt-5", prompt: "--yolo" }],
            ["bare --", { model: "openai/gpt-5", prompt: "--" }],
            ["short flag", { model: "openai/gpt-5", prompt: "-x" }],
            [
                "duplicate host control",
                { model: "openai/gpt-5", prompt: "json" },
            ],
            [
                "template literal duplicate",
                { model: "openai/gpt-5", prompt: "--no-session" },
            ],
            [
                "raw appendable argv",
                { model: "openai/gpt-5", prompt: "ok", argv: ["--x"] },
            ],
            ["missing field", { model: "openai/gpt-5" }],
            ["control bytes", { model: "openai/gpt-5", prompt: "a\nb" }],
            ["pattern violation", { model: "not a model ref", prompt: "ok" }],
        ];
        for (const [, fields] of cases) {
            const result = renderArgumentVariant(
                doc,
                "pi",
                "run_prompt",
                fields,
            );
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.reason).toBe("argument_variant_invalid");
            }
        }
        expect(
            renderArgumentVariant(doc, "pi", "yolo_mode", { model: "a/b" }).ok,
        ).toBe(false);
    });

    test("every rejection condition binds to exactly one U8 subreason", () => {
        const contract = buildContract();
        const union = contract.harness_unavailable.reasons_by_precedence.map(
            (row) => row.id,
        );
        for (const reason of Object.values(doc.rejection_bindings)) {
            expect(union).toContain(reason);
        }
        for (const id of union) {
            expect(Object.values(doc.rejection_bindings)).toContain(id);
        }
    });

    // The matrix is a second declaration of an argv contract the Rust broca
    // backends already implement. Without this cross-check the two drift and
    // the collision oracle stops covering flags the daemon actually emits, so
    // a prompt equal to a host-owned flag would render as a real control.
    test("control_tokens cover every flag the Rust broca backends emit", () => {
        for (const [harness, source] of [
            ["opencode", "crates/mc-host/src/broca/opencode.rs"],
            ["pi", "crates/mc-host/src/broca/pi.rs"],
        ] as const) {
            const rust = readFileSync(join(repoRoot, source), "utf8");
            const emitted = new Set(
                [...rust.matchAll(/"(--[a-z][a-z0-9-]*)"/g)].map((m) => m[1]),
            );
            expect(emitted.size).toBeGreaterThan(0);
            const declared = doc.harnesses[harness].argument_variants
                .control_tokens as readonly string[];
            for (const flag of [...emitted].sort()) {
                expect(declared).toContain(flag);
            }
        }
    });

    test("control_tokens are sorted and duplicate-free", () => {
        for (const harness of ["opencode", "pi"] as const) {
            const tokens = doc.harnesses[harness].argument_variants
                .control_tokens as readonly string[];
            expect([...tokens]).toEqual([...new Set(tokens)].sort());
        }
    });
});

describe("build-entrypoint evidence consumption (U2/U6 gate)", () => {
    test("committed evidence is not production-qualified and is rejected", () => {
        expect(() => requireQualificationEvidence(repoRoot)).toThrow(
            /inputs are not production-qualified/,
        );
    });

    test("absent, malformed, and test-only evidence are rejected", () => {
        const absent = freshRoot();
        expect(() => requireQualificationEvidence(absent)).toThrow(/absent/);

        const malformed = freshRoot();
        mkdirSync(join(malformed, dirname(OUTPUT_PATHS.evidence)), {
            recursive: true,
        });
        writeFileSync(join(malformed, OUTPUT_PATHS.evidence), "{nope");
        expect(() => requireQualificationEvidence(malformed)).toThrow(
            /malformed JSON/,
        );

        const wrongSchema = freshRoot();
        mkdirSync(join(wrongSchema, dirname(OUTPUT_PATHS.evidence)), {
            recursive: true,
        });
        writeFileSync(
            join(wrongSchema, OUTPUT_PATHS.evidence),
            '{"schema":"nope/v1"}\n',
        );
        expect(() => requireQualificationEvidence(wrongSchema)).toThrow(
            /unknown schema/,
        );

        const testOnly = freshRoot();
        installManifest(testOnly, fixtureManifest());
        generate(testOnly, { check: false });
        expect(() => requireQualificationEvidence(testOnly)).toThrow(
            /test-only evidence/,
        );
    });

    test("stale evidence is rejected after an artifact drifts", () => {
        const root = freshRoot();
        installProductionManifest(root);
        generate(root, { check: false });
        const lockPath = join(root, OUTPUT_PATHS.lock);
        writeFileSync(
            lockPath,
            readFileSync(lockPath, "utf8").replace('"4.18"', '"4.19"'),
        );
        expect(() => requireQualificationEvidence(root)).toThrow(
            /stale artifact digest/,
        );
    });

    test("fully qualified production evidence is accepted with matching digests", () => {
        const root = freshRoot();
        installProductionManifest(root);
        const generated = generate(root, { check: false });
        expect(generated.productionQualified).toBe(true);
        const accepted = requireQualificationEvidence(root);
        expect(accepted.lockSha256).toBe(generated.lockSha256);
        expect(accepted.credentialsSha256).toBe(generated.credentialsSha256);
        expect(accepted.u8Digest).toBe(generated.u8Digest);
    });

    test("the gate re-hashes real artifacts when asked", () => {
        // The lock records each artifact's sha256 but deliberately not its
        // host-specific verify path, so the gate cannot hash bytes on its own.
        // A build running on the qualifying host can demand it.
        const root = freshRoot();
        installProductionManifest(root);
        generate(root, { check: false });
        expect(() =>
            requireQualificationEvidence(root, { verifyBytes: true }),
        ).not.toThrow();

        const bytesPath = join(
            root,
            STAGED_PRODUCTION_INPUT_DIR,
            "model.onnx",
        );
        writeFileSync(bytesPath, "swapped after qualification\n");

        // Every digest in the committed description still agrees; only the
        // artifact bytes changed, which the default portable gate cannot see.
        expect(() => requireQualificationEvidence(root)).not.toThrow();
        expect(() =>
            requireQualificationEvidence(root, { verifyBytes: true }),
        ).toThrow(/inputs\.model_onnx: byte size/);
    });

    test("stripped lock rows cannot pass the gate", () => {
        // Every marker check reads only a `qualified` flag or a version's type,
        // so a lock whose rows keep nothing but those markers satisfies all of
        // them while carrying no artifact hash, size, license, oracle result, or
        // harness identity at all.
        const root = freshRoot();
        installProductionManifest(root);
        generate(root, { check: false });

        const lockPath = join(root, OUTPUT_PATHS.lock);
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        for (const key of Object.keys(lock.inputs)) {
            lock.inputs[key] = { qualified: true };
        }
        lock.oracle = { qualified: true };
        for (const name of Object.keys(lock.harnesses)) {
            lock.harnesses[name] = { package: "", version: "" };
        }
        recite(root, lockPath, `${JSON.stringify(lock, null, 2)}\n`);

        expect(() => requireQualificationEvidence(root)).toThrow(
            /not a canonical regeneration.*mc-host-production-inputs\.lock\.json/,
        );
    });

    test("a replaced credential matrix cannot pass the gate", () => {
        // The citation loop compares a self-reported digest and never parses the
        // matrix, so updating both together would otherwise let a production
        // build embed an empty or foreign credential policy.
        const root = freshRoot();
        installProductionManifest(root);
        generate(root, { check: false });

        recite(root, join(root, OUTPUT_PATHS.credentials), "{}\n");

        expect(() => requireQualificationEvidence(root)).toThrow(
            /not a canonical regeneration.*mc-host-provider-credentials\.json/,
        );
    });

    test("an edited generated U8 contract cannot pass the gate", () => {
        // The runtime compiles the generated Rust contract, not the in-source
        // literal the cited U8 digest is derived from.
        const root = freshRoot();
        installProductionManifest(root);
        generate(root, { check: false });

        const generatedRust = join(
            root,
            "release/generated/mc-host-release-contract.rs",
        );
        writeFileSync(
            generatedRust,
            `${readFileSync(generatedRust, "utf8")}// drifted\n`,
        );

        expect(() => requireQualificationEvidence(root)).toThrow(
            /generated U8 outputs are not canonical/,
        );
    });

    test("summary-only lock edits cannot fake a verdict", () => {
        const root = freshRoot();
        // One input left unqualified, so the lock carries a false row.
        const manifest = fixtureManifest();
        manifest.inputs.model_onnx = {
            qualified: false,
            reason: "real model bytes not yet qualified",
        };
        installManifest(root, manifest);
        generate(root, { check: false });

        // Edit the lock's summary fields AND re-point the evidence citation at
        // the edited bytes, so every digest check still passes. The per-row
        // truth is what must be believed.
        const lockPath = join(root, OUTPUT_PATHS.lock);
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        lock.mode = "production";
        lock.production_qualified = true;
        lock.unqualified = [];
        const lockBytes = `${JSON.stringify(lock, null, 2)}\n`;
        writeFileSync(lockPath, lockBytes);
        expect(lock.inputs.model_onnx.qualified).toBe(false);

        const evidencePath = join(root, OUTPUT_PATHS.evidence);
        const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
        evidence.production_qualified = true;
        evidence.test_only = false;
        evidence.unqualified = [];
        evidence.artifacts.production_inputs_lock.sha256 = createHash("sha256")
            .update(lockBytes)
            .digest("hex");
        writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

        expect(() => requireQualificationEvidence(root)).toThrow(
            /lock row inputs\.\w+ is not qualified/,
        );
    });

    test("evidence claiming qualification over an unqualified lock is rejected", () => {
        const root = freshRoot();
        // Test-mode manifest => the lock records unqualified inputs.
        installManifest(root, fixtureManifest());
        generate(root, { check: false });

        // Forge evidence that asserts a production verdict while citing the
        // real, unmodified lock and credentials digests. The gate must derive
        // the verdict from the lock bytes, not from these self-reported bits.
        const evidencePath = join(root, OUTPUT_PATHS.evidence);
        const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
        evidence.production_qualified = true;
        evidence.test_only = false;
        evidence.unqualified = [];
        writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

        expect(() => requireQualificationEvidence(root)).toThrow(
            /inputs are not production-qualified/,
        );
    });
});

describe("verify-path resolution", () => {
    test("a symlink into a developer cache cannot qualify", () => {
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.mode = "production";
        unblacklistDigests(manifest);

        // Real bytes live in a developer cache; the manifest names an
        // innocuous absolute path that is a symlink to them.
        const cache = join(root, "home/.cache/huggingface");
        mkdirSync(cache, { recursive: true });
        const realModel = join(cache, "model.onnx");
        cpSync(
            join(repoRoot, FIXTURE_DIR, "artifacts/model.onnx"),
            realModel,
        );
        const link = join(root, "qualified-model.onnx");
        symlinkSync(realModel, link);

        for (const artifact of Object.values(manifest.inputs) as {
            verify_local_path: string;
        }[]) {
            artifact.verify_local_path = join(root, artifact.verify_local_path);
        }
        manifest.inputs.model_onnx.verify_local_path = link;
        installManifest(root, manifest);

        expect(() => generate(root, { check: false })).toThrow(
            /fixture\/developer-cache verify path/,
        );
    });

    test("parent segments in a verify path are rejected", () => {
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.inputs.model_onnx.verify_local_path =
            "scripts/__fixtures__/mc-host-qualification/artifacts/../artifacts/model.onnx";
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /parent segments in the verify path are rejected/,
        );
    });

    test("the fixture deny-list matches path segments, not substrings", () => {
        // A real artifact store whose name merely contains a denied word names
        // nothing that is actually a fixture or a cache.
        const allowed = freshRoot();
        installProductionManifest(allowed, (manifest) => {
            const dir = join(allowed, "mnt/release/hf-tests/fixtures-store");
            mkdirSync(dir, { recursive: true });
            const target = join(dir, "model.onnx");
            const bytes = Buffer.from("relocated production model bytes\n");
            writeFileSync(target, bytes);
            manifest.inputs.model_onnx.verify_local_path = target;
            manifest.inputs.model_onnx.sha256 = createHash("sha256")
                .update(bytes)
                .digest("hex");
            manifest.inputs.model_onnx.size_bytes = bytes.length;
        });
        expect(generate(allowed, { check: false }).productionQualified).toBe(
            true,
        );

        // The real segment run is still denied wherever it appears.
        const denied = freshRoot();
        installProductionManifest(denied, (manifest) => {
            manifest.inputs.model_onnx.verify_local_path = join(
                denied,
                "srv/tests/fixtures/model.onnx",
            );
        });
        expect(() => generate(denied, { check: false })).toThrow(
            /fixture\/developer-cache verify path \(tests\/fixtures\)/,
        );
    });

    test("a missing tiny-fixture manifest fails closed", () => {
        const root = freshRoot();
        installManifest(root, fixtureManifest());
        rmSync(join(root, TINY_MANIFEST), { force: true });
        expect(() => generate(root, { check: false })).toThrow(
            /missing tiny-fixture manifest/,
        );
    });

    test("--check does not require local artifact bytes", () => {
        const root = freshRoot();
        installProductionManifest(root);
        generate(root, { check: false });

        // Drop the artifacts a foreign host (CI) would never hold. Drift
        // checking of the committed lock must still work.
        rmSync(join(root, STAGED_PRODUCTION_INPUT_DIR), {
            recursive: true,
            force: true,
        });
        expect(generate(root, { check: true }).drift).toEqual([]);

        // Byte verification remains available on the qualifying host.
        expect(() =>
            generate(root, { check: true, verifyBytes: true }),
        ).toThrow(/verify bytes missing/);
    });
});
