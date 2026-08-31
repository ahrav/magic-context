import { afterEach, describe, expect, test } from "bun:test";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { completeRegistryGate } from "./__fixtures__/registry-gate";
import { buildContract } from "./generate-mc-host-release-manifest";
import {
    assertPinsMatchContract,
    FORBIDDEN_RUNTIME_FEATURE_SUBSTRINGS,
    RUNTIME_IDENTITY,
    buildCredentialsDoc,
    canonicalClosureManifest,
    canonicalCredentialRowEncoding,
    checkOracleEvidence,
    closureManifestDigest,
    evaluateBrocaRun,
    generate,
    type HarnessClosureManifest,
    assertPinnedQualifyingRuntime,
    OUTPUT_PATHS,
    QUALIFICATION_PINS,
    renderArgumentVariant,
    requireQualificationEvidence,
    ROW_CAP_BYTES,
    SOURCE_MANIFEST_PATH,
    VALUE_CAP_BYTES,
    validateClosureManifest,
    validateCredentialsDoc,
    validateQualifiedDynamicImports,
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
const VALID_PI_CLOSURE = join(
    repoRoot,
    FIXTURE_DIR,
    "harness-closures/pi-valid.json",
);
const VALID_OPENCODE_CLOSURE = join(
    repoRoot,
    FIXTURE_DIR,
    "harness-closures/opencode-valid.json",
);

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
        // The qualifier fails closed without TINY_MANIFEST, preventing a missing manifest from emptying the tiny-fixture hash blacklist.
        TINY_MANIFEST,
        // Production qualification must reject FIXTURE_MANIFEST_RELATIVE artifact digests after relocation.
        FIXTURE_MANIFEST_RELATIVE,
        // The U2/U6 gate re-derives every U8 output.
        // A staged root must include the registry gate required for generation and the generated consumer artifacts compared against U8 outputs.
        "release/mc-host-registry-gate.json",
        // Cargo resolves `[patch]` and `[replace]` from the workspace root.
        // Ruling out `[patch]` or `[replace]` overrides of qualified crates requires the root Cargo.toml.
        "Cargo.toml",
        "release/generated/mc-host-release-contract.rs",
        "packages/plugin/src/shared/mc-host-lifecycle/generated-contract.ts",
        "packages/retina-local-fs/src/generated-layout.ts",
    ]) {
        mkdirSync(join(root, dirname(relative)), { recursive: true });
        cpSync(join(repoRoot, relative), join(root, relative));
    }
    // The committed gate fails closed, and generation refuses to run against it.
    // Without a synthetic complete gate, every test case fails at the gate instead of its target rule.
    // freshRoot stages a synthetic complete gate so each test reaches its target rule.
    const gatePath = join(root, "release/mc-host-registry-gate.json");
    writeFileSync(
        gatePath,
        `${JSON.stringify(
            completeRegistryGate(JSON.parse(readFileSync(gatePath, "utf8"))),
            null,
            2,
        )}\n`,
    );
    return root;
}

// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the manifest
function fixtureManifest(): any {
    return JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8"));
}

// biome-ignore lint/suspicious/noExplicitAny: tests install mutated manifests
/**
 *
 * The oracle report is a separate file bound by digest.
 * Changing input digests or host capabilities without rebinding the report triggers the report/manifest identity check.
 * rebindSmokeReport prevents setup failures from hiding the rule under test.
 * Tests that forge a report call {@link checkOracleEvidence} directly instead of rebindSmokeReport.
 */
// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the manifest
function rebindSmokeReport(root: string, manifest: any): void {
    const smoke = manifest.oracle?.smoke_report;
    if (smoke === undefined || smoke === null) return;
    const reportPath = join(root, smoke.path);
    if (!existsSync(reportPath)) return;
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.model_fingerprint = manifest.oracle.model_fingerprint;
    report.table_epoch = manifest.oracle.table_epoch;
    report.execution_provider = manifest.oracle.execution_provider;
    report.host = manifest.oracle.host;
    // `corpus`.
    // rebindSmokeReport preserves the report value when an input lacks `sha256` because required report input keys cannot be omitted.
    // Dropping a required report input key causes a setup shape error.
    const digest = (key: string, reportKey: string): string =>
        (manifest.inputs[key] as { sha256?: string }).sha256 ??
        report.inputs[reportKey];
    report.inputs = {
        ort_runtime: digest("ort_runtime", "ort_runtime"),
        model_onnx: digest("model_onnx", "model_onnx"),
        bundle_manifest: digest("bundle_manifest", "bundle_manifest"),
        semantic_corpus: digest("corpus", "semantic_corpus"),
    };
    const bytes = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(reportPath, bytes);
    smoke.sha256 = createHash("sha256").update(bytes).digest("hex");
}

function installManifest(root: string, manifest: any): void {
    cpSync(
        join(repoRoot, FIXTURE_DIR, "artifacts"),
        join(root, FIXTURE_DIR, "artifacts"),
        { recursive: true },
    );
    rebindSmokeReport(root, manifest);
    mkdirSync(join(root, dirname(SOURCE_MANIFEST_PATH)), { recursive: true });
    writeFileSync(
        join(root, SOURCE_MANIFEST_PATH),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
}

/** The fixture mirrors the qualifier's JSON-shaped input set so staged production artifacts are loadable, not merely digest-correct.
 * */
const JSON_SHAPED_INPUTS: ReadonlySet<string> = new Set([
    "config",
    "corpus",
    "special_tokens_map",
    "tokenizer",
    "tokenizer_config",
]);

/**
 * Production qualification rejects verify paths under `scripts/__fixtures__`.
 */
const STAGED_PRODUCTION_INPUT_DIR = "opt/mc-host-inputs";

/**
 *
 * Every helper that restages input bytes must rebind the oracle transcript to the new digests.
 * The oracle check rejects transcripts whose bound digests no longer match the lock.
 */
// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the manifest
function rebindOracle(manifest: any): void {
    if (manifest.oracle === null || manifest.oracle === undefined) return;
    manifest.oracle.bound_inputs = Object.fromEntries(
        Object.entries(manifest.inputs).map(([key, artifact]) => [
            key,
            (artifact as { sha256?: string }).sha256,
        ]),
    );
}

/**
 * Production mode rejects fixture `.invalid` hosts before unrelated rules run.
 */
// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the manifest
function useResolvableSources(manifest: any): void {
    for (const artifact of Object.values(manifest.inputs) as {
        source?: string;
    }[]) {
        if (typeof artifact.source === "string") {
            artifact.source = artifact.source.replace(
                /\.example\.invalid\b/,
                ".mchost-release.io",
            );
        }
    }
}

/**
 * Production mode rejects fixture digests before path rules run.
 * A path-rule test must replace fixture digests because production mode rejects them first.
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
    rebindOracle(manifest);
}

/**
 * Production mode rejects the fixture's `test-fixture` approver before other rules run.
 *
 */
// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the manifest
function useProductionApprovers(manifest: any): void {
    for (const artifact of Object.values(manifest.inputs) as {
        license?: { approved_by: string };
    }[]) {
        if (artifact.license !== undefined) {
            artifact.license.approved_by = "mc-host U9 SPDX allowlist";
        }
    }
}

/**
 *
 * Production mode rejects fixture `.invalid` hosts and the `test-fixture` approver before unrelated rules run.
 */
// biome-ignore lint/suspicious/noExplicitAny: tests mutate deep copies of the manifest
function useProductionProvenance(manifest: any): void {
    useResolvableSources(manifest);
    useProductionApprovers(manifest);
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
    // Production mode denies the committed fixture bytes.
    for (const [key, artifact] of Object.entries(manifest.inputs) as [
        string,
        {
            verify_local_path: string;
            sha256: string;
            size_bytes: number;
            source: string;
        },
    ][]) {
        const target = join(stagedDir, basename(artifact.verify_local_path));
        // Inputs in `JSON_SHAPED_INPUTS` must contain valid JSON; a correct digest alone does not satisfy runtime parsing.
        // Each key requires distinct contents to produce distinct test digests.
        const bytes = Buffer.from(
            JSON_SHAPED_INPUTS.has(key)
                ? `${JSON.stringify({ staged_production_stand_in: key })}\n`
                : `staged production stand-in for ${key}\n`,
        );
        writeFileSync(target, bytes);
        artifact.verify_local_path = target;
        artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
        artifact.size_bytes = bytes.length;
        // Production mode rejects fixture RFC 2606 `.invalid` hosts because they cannot serve artifacts.
        artifact.source = artifact.source.replace(
            /\.example\.invalid\b/,
            ".mchost-release.io",
        );
    }
    useProductionApprovers(manifest);
    manifest.harnesses.opencode.closure = openCodeClosureFixture();
    manifest.harnesses.pi.closure = closureFixture();
    delete manifest.harnesses.opencode.closure_unqualified_reason;
    delete manifest.harnesses.pi.closure_unqualified_reason;
    const closureSources = join(root, "closure-sources");
    const opencodeRoot = join(closureSources, "opencode");
    const nodeRoot = join(closureSources, "node-runtime");
    const piRoot = join(closureSources, "pi-install");
    for (const [path, bytes] of [
        [join(opencodeRoot, "bin/opencode"), "opencode"],
        [join(nodeRoot, "bin/node"), "node"],
        [
            join(
                piRoot,
                "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
            ),
            "cli",
        ],
        [
            join(
                piRoot,
                "node_modules/@earendil-works/pi-coding-agent/dist/helper.js",
            ),
            "helper",
        ],
        [
            join(
                piRoot,
                "node_modules/@earendil-works/pi-coding-agent/native/addon.node",
            ),
            "addon",
        ],
        [join(piRoot, "node_modules/provider/ext.js"), "extension"],
    ]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
    }
    manifest.harnesses.opencode.closure_verify_roots = {
        "opencode-install": opencodeRoot,
    };
    manifest.harnesses.opencode.closure_platforms = ["linux-x64-gnu"];
    manifest.harnesses.pi.closure_verify_roots = {
        "node-runtime": nodeRoot,
        "pi-install": piRoot,
    };
    manifest.harnesses.pi.closure_platforms = ["linux-x64-gnu"];
    mutate?.(manifest);
    rebindOracle(manifest);
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

function closureFixture(): HarnessClosureManifest {
    return JSON.parse(readFileSync(VALID_PI_CLOSURE, "utf8"));
}

function openCodeClosureFixture(): HarnessClosureManifest {
    return JSON.parse(readFileSync(VALID_OPENCODE_CLOSURE, "utf8"));
}

/**
 * `recite` updates evidence digests so tests can validate artifact contents without digest-mismatch failures.
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

    test("check mode ignores local evidence whether absent or present", () => {
        const root = freshRoot();
        installManifest(root, fixtureManifest());
        generate(root, { check: false });

        rmSync(join(root, OUTPUT_PATHS.evidence));
        expect(generate(root, { check: true }).drift).toEqual([]);

        mkdirSync(join(root, dirname(OUTPUT_PATHS.evidence)), {
            recursive: true,
        });
        writeFileSync(join(root, OUTPUT_PATHS.evidence), '{"stale":true}\n');
        expect(generate(root, { check: true }).drift).toEqual([]);
    });

    test("pins, floors, budgets, and layout IDs drift only through regeneration", () => {
        const root = freshRoot();
        installManifest(root, fixtureManifest());
        generate(root, { check: false });
        for (const relative of Object.values(OUTPUT_PATHS).filter(
            (path) => path !== OUTPUT_PATHS.evidence,
        )) {
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

    test("content-addressed project artifacts bind source identity to sha256", () => {
        const root = freshRoot();
        const manifest = fixtureManifest();
        const digest = manifest.inputs.corpus.sha256;
        manifest.inputs.corpus.source = `urn:sha256:${digest}`;
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).not.toThrow();

        manifest.inputs.corpus.source = `urn:sha256:${"a".repeat(64)}`;
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /content-addressed source disagrees/,
        );
    });

    test("a mutable ref as the final path segment is rejected", () => {
        // The URL names the moving `main` branch without a trailing slash, bypassing a `/main/` substring check.
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
        // `URL.pathname` must be decoded before immutable-ref comparison; `%69` resolves to `i`.
        // `ma%69n` resolves to `main` on the server.
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

    test("a source whose normalized path is a directory is rejected", () => {
        // `new URL()` normalizes a trailing `..` path segment to the parent directory.
        // The digest remains a path segment, so digest validation passes although the URL names the parent directory.
        // a directory.
        for (const suffix of ["/..", "/.", "/%2e%2e", "/"]) {
            const root = freshRoot();
            installProductionManifest(root, (manifest) => {
                const digest = manifest.inputs.model_onnx.sha256;
                manifest.inputs.model_onnx.source =
                    `https://models.mchost-release.io/m/resolve/${digest}/model.onnx${suffix}`;
            });
            expect(() => generate(root, { check: false })).toThrow(
                /source must be an https URL naming one artifact/,
            );
        }
    });

    test("an unparseable source URL fails with the tool's framing", () => {        // `startsWith("https://")` does not imply parseability; a raw
        // `TypeError: Invalid URL` would lose the consistent failure prefix.
        const root = freshRoot();
        const manifest = fixtureManifest();
        // A space in the path is percent-encoded instead of causing URL parsing to throw.
        manifest.inputs.model_onnx.source = "https://[invalid/model.onnx";
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /inputs\.model_onnx: source is not a parseable URL/,
        );
    });

    test("a mutable ref in the query string is rejected", () => {
        // A revision in a non-path URL component can still name a moving target.
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
        // Servers that decode escaped separators can resolve the path through a moving ref.
        // Escaped separators prevent wholesale raw-path comparison against the ref set.
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
        // A fragment never reaches the server, so it cannot select an artifact.
        // `buildLock` copies URL fragments into the committed lock.
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
        // Accepting credential-bearing source URLs would commit the secret to Git permanently.
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

    test("digest-correct bytes the runtime cannot load are rejected", () => {
        // A matching digest does not prove that the artifact can load as a bundle.
        const root = freshRoot();
        installProductionManifest(root, (manifest) => {
            const target = manifest.inputs.tokenizer.verify_local_path;
            const bytes = Buffer.from("not json at all\n");
            writeFileSync(target, bytes);
            manifest.inputs.tokenizer.sha256 = createHash("sha256")
                .update(bytes)
                .digest("hex");
            manifest.inputs.tokenizer.size_bytes = bytes.length;
        });
        expect(() => generate(root, { check: false })).toThrow(
            /inputs\.tokenizer: verified bytes are not parseable JSON/,
        );
    });

    test("a production source carries no query string", () => {
        // Nested URLs can contain userinfo at multiple depths.
        // Production validation rejects the query component instead of recursively proving nested URLs clean.
        for (const query of [
            "?redirect=https%3A%2F%2Fuser%3Asecret%40storage.example%2Fx",
            "?harmless=1",
        ]) {
            const root = freshRoot();
            installProductionManifest(root, (manifest) => {
                const digest = manifest.inputs.model_onnx.sha256;
                manifest.inputs.model_onnx.source =
                    `https://models.mchost-release.io/m/resolve/${digest}/model.onnx${query}`;
            });
            expect(() => generate(root, { check: false })).toThrow(
                /production source must not carry a query string/,
            );
        }
    });

    test("a production source must name its content", () => {
        // A denylist of ref names can never be complete, so immutability is required
        // An unlisted branch appears immutable only because no denylist entry names it.
        for (const path of [
            "/gte-modernbert/resolve/develop/model.onnx",
            "/gte-modernbert/resolve/v1.2.3/model.onnx",
            "/gte-modernbert/model.onnx",
        ]) {
            const root = freshRoot();
            installProductionManifest(root, (manifest) => {
                manifest.inputs.model_onnx.source = `https://models.mchost-release.io${path}`;
            });
            expect(() => generate(root, { check: false })).toThrow(
                /production source must name its content/,
            );
        }

        // A content-addressed Git revision must contain at least 40 characters.
        for (const segment of ["${sha256}", "a".repeat(40)]) {
            const root = freshRoot();
            installProductionManifest(root, (manifest) => {
                const digest = manifest.inputs.model_onnx.sha256;
                manifest.inputs.model_onnx.source =
                    `https://models.mchost-release.io/m/resolve/${
                        segment === "${sha256}" ? digest : segment
                    }/model.onnx`;
            });
            expect(generate(root, { check: false }).productionQualified).toBe(
                true,
            );
        }
    });

    test("reserved source hosts cannot qualify for production", () => {
        // An `.invalid` host in a production manifest records an artifact origin that cannot exist.
        for (const host of [
            "models.example.invalid",
            "artifacts.example.test",
            "cdn.localhost",
            "files.example.com",
            // `URL.hostname` returns `[::1]` for an IPv6 loopback literal, so host matching requires brackets.
            "[::1]",
            "127.0.0.1",
            // The whole 127.0.0.0/8 block is loopback, not only `.1`.
            "127.0.0.2",
            // `URL` canonicalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so both forms must be rejected.
            "[::ffff:127.0.0.1]",
        ]) {
            const root = freshRoot();
            installProductionManifest(root, (manifest) => {
                manifest.inputs.model_onnx.source =
                    `https://${host}/rev/abc123/model.onnx`;
            });
            expect(() => generate(root, { check: false })).toThrow(
                /source host .* is reserved/,
            );
        }

        // Test-fixture mode permits reserved hosts.
        const fixture = freshRoot();
        installManifest(fixture, fixtureManifest());
        expect(() => generate(fixture, { check: false })).not.toThrow();
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
        // Fixture artifacts use tiny text stand-ins with `example.invalid` provenance.
        // Production qualification must reject fixture artifacts.

        // Digest checks reject fixture bytes after relocation.
        const relocated = freshRoot();
        const byHash = fixtureManifest();
        byHash.mode = "production";
        useProductionProvenance(byHash);
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

        // Path checks reject fixture bytes whose digests are unknown.
        const inPlace = freshRoot();
        const byPath = fixtureManifest();
        byPath.mode = "production";
        useProductionProvenance(byPath);
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
                    m.inputs.model_onnx.license.redistribution_approved = false;
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
        useProductionProvenance(manifest);
        unblacklistDigests(manifest);
        for (const artifact of Object.values(manifest.inputs) as {
            license: { approved_by: string };
        }[]) {
            artifact.license.approved_by = "mc-host U9 SPDX allowlist";
        }
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

    test("production mode rejects an unrecognized license approver", () => {
        const root = freshRoot();
        installProductionManifest(root);
        const manifest = JSON.parse(
            readFileSync(join(root, SOURCE_MANIFEST_PATH), "utf8"),
        );
        manifest.inputs.model_onnx.license.approved_by = "self-asserted";
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /license approver is not a production policy/,
        );
    });

    test("check mode does not require external production bytes", () => {
        const root = freshRoot();
        installProductionManifest(root);
        const manifest = JSON.parse(
            readFileSync(join(root, SOURCE_MANIFEST_PATH), "utf8"),
        );
        for (const [name, artifact] of Object.entries(manifest.inputs) as [
            string,
            { verify_local_path: string },
        ][]) {
            artifact.verify_local_path = `/missing-production-inputs/${name}`;
        }
        manifest.harnesses.opencode.closure_verify_roots = {
            "opencode-install": "/missing-production-inputs/opencode",
        };
        manifest.harnesses.pi.closure_verify_roots = {
            "node-runtime": "/missing-production-inputs/node",
            "pi-install": "/missing-production-inputs/pi",
        };
        installManifest(root, manifest);
        expect(() => generate(root, { check: true })).not.toThrow();
        // `verifyBytes` controls both `--verify-bytes` and `requireQualificationEvidence`.
        // The closure-specific matcher prevents artifact-path failures from satisfying this assertion.
        expect(() => generate(root, { check: true, verifyBytes: true })).toThrow(
            /closure verify root is missing/,
        );
        expect(() => generate(root, { check: false })).toThrow(/missing/);
    });

    test("the Pi version is the one the workspace resolves, not any in the lock", () => {
        const pkg = "@earendil-works/pi-coding-agent";

        // A transitive copy at an unrelated version satisfies a substring search
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

        // A nested resolution overrides a hoisted resolution. Bun keys resolutions by the consumer package name, not its directory.
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

        // The resolver ignores directory-keyed entries because treating them as Bun resolutions falls back to the hoisted version.
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

        // A hoisted entry resolves the workspace dependency only when the workspace declares the package.
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

    test("a workspace override of a qualified crate fails production closed", () => {
        // Cargo resolves `[patch]` entries from the workspace root, so a leaf manifest's pin can differ from the source Cargo builds.
        const cases: [string, RegExp][] = [
            [
                '[patch.crates-io]\nort = { path = "../vendored-ort" }\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                '[patch.crates-io.fastembed]\npath = "../vendored-fastembed"\n',
                /overrides fastembed, so the build would not resolve/,
            ],
            [
                // The parser detects `[patch.crates-io.<crate>]` subtables that end at EOF.
                '[patch.crates-io.fastembed]\npath = "../vendored-fastembed"',
                /overrides fastembed, so the build would not resolve/,
            ],
            [
                // Renamed patch entries identify the overridden crate through `package`, not the dependency key.
                '[patch.crates-io]\nort_fork = { package = "ort", path = "../vendored-ort" }\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // The parser applies renamed-patch detection to subtable entries.
                '[patch.crates-io.ort_fork]\npackage = "ort"\npath = "../vendored-ort"\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                'patch.crates-io.ort = { path = "fake-ort" }\n',
                /dotted override assignment this qualifier cannot attribute/,
            ],
            [
                // The parser treats quoted components in dotted TOML keys as equivalent to bare components.
                '"patch"."crates-io"."ort" = { path = "fake-ort" }\n',
                /dotted override assignment this qualifier cannot attribute/,
            ],
            [
                "'replace'.'ort:2.0.0-rc.13' = { path = \"fake-ort\" }\n",
                /dotted override assignment this qualifier cannot attribute/,
            ],
            [
                '[replace]\n"ort:2.0.0-rc.13" = { path = "../vendored-ort" }\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // A replacement subtable overrides the package identified by its package-ID header.
                // A replacement subtable overrides the package identified by its package-ID header.
                '[replace."ort:2.0.0-rc.13"]\npath = "../vendored-ort"\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // The parser detects replacement subtables that end at EOF.
                '[replace."ort:2.0.0-rc.13"]\npath = "../vendored-ort"',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // The parser accepts `name@version` as a valid Cargo package-ID spec.
                // The parser excludes the version from the crate name in `name@version` package-ID specs.
                '[replace]\n"ort@2.0.0-rc.13" = { path = "../vendored-ort" }\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                '[replace."ort@2.0.0-rc.13"]\npath = "../vendored-ort"\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // The parser reads the package name from a URL package-ID spec's fragment.
                '[replace]\n"https://github.com/pykeio/ort#ort:2.0.0-rc.13" = { path = "../vendored-ort" }\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // The parser treats literal TOML strings as equivalent key spellings.
                "[replace.'ort:2.0.0-rc.13']\npath = \"../vendored-ort\"\n",
                /overrides ort, so the build would not resolve/,
            ],
            [
                // The scanner cannot derive the package name from a source URL without a package fragment.
                '[replace."https://github.com/pykeio/ort#2.0.0-rc.13"]\npath = "../vendored-ort"\n',
                /declares an override this qualifier cannot read/,
            ],
            [
                // The parser parses quoted TOML table keys to attribute `replace` and `patch` overrides.
                '["replace"."ort:2.0.0-rc.13"]\npath = "../vendored-ort"\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                '["patch"."crates-io"."ort"]\npath = "../vendored-ort"\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                "[patch.crates-io.'fastembed']\npath = \"../vendored-fastembed\"\n",
                /overrides fastembed, so the build would not resolve/,
            ],
            [
                '[patch.crates-io]\n"ort" = { path = "../vendored-ort" }\n',
                /overrides ort, so the build would not resolve/,
            ],
        ];
        for (const [patch, error] of cases) {
            const root = freshRoot();
            installProductionManifest(root);
            const rootManifest = join(root, "Cargo.toml");
            writeFileSync(
                rootManifest,
                `${readFileSync(rootManifest, "utf8")}\n${patch}`,
            );
            expect(() => generate(root, { check: false })).toThrow(error);
        }

        // The parser rejects only target-crate overrides and resolves headers to identify the overridden crate.
        for (const override of [
            '[patch.crates-io]\nserde = { path = "../vendored-serde" }\n',
            '[replace."serde:1.0.0"]\npath = "../vendored-serde"\n',
            '[patch.crates-io."serde"]\npath = "../vendored-serde"\n',
        ]) {
            const unrelated = freshRoot();
            installProductionManifest(unrelated);
            const rootManifest = join(unrelated, "Cargo.toml");
            writeFileSync(
                rootManifest,
                `${readFileSync(rootManifest, "utf8")}\n${override}`,
            );
            expect(
                generate(unrelated, { check: false }).productionQualified,
            ).toBe(true);
        }
    });

    test("a forbidden ORT capability in Cargo.toml fails production closed", () => {
        // Declared features are not the effective closure; a version pin cannot detect forbidden declared features.
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
                // The parser parses multiline feature arrays because a one-line scan misses the closing bracket.
                // pass vacuously.
                (cargo) =>
                    cargo.replace(
                        'features = ["load-dynamic", "ndarray", "std"] }',
                        'features = [\n    "load-dynamic",\n    "ndarray",\n    "std",\n    "download-binaries",\n] }',
                    ),
                /ort feature download-binaries .* outside the qualified closure/,
            ],
            [
                // An unreadable `features` array must fail rather than be treated as empty.
                (cargo) =>
                    cargo.replace(
                        'features = ["load-dynamic", "ndarray", "std"] }',
                        'features = FEATURES }',
                    ),
                /declares a features list this qualifier cannot read/,
            ],
            [
                // The scanner must check dependency subtables because Cargo accepts them as an alternative to inline dependency tables.
                (cargo) =>
                    `${cargo.replace(/^ort = .*$/m, "")}\n[dependencies.ort]\nversion = "=2.0.0-rc.13"\ndefault-features = false\nfeatures = ["load-dynamic", "download-binaries"]\n`,
                /ort feature download-binaries .* outside the qualified closure/,
            ],
            [
                // The scanner must read multiline `features` arrays in dependency subtables; skipping subtable lines reports forbidden features as unreadable.
                (cargo) =>
                    `${cargo.replace(/^ort = .*$/m, "")}\n[dependencies.ort]\nversion = "=2.0.0-rc.13"\ndefault-features = false\nfeatures = [\n    "load-dynamic",\n    "tensorrt",\n]\n`,
                /ort feature tensorrt .* outside the qualified closure/,
            ],
            [
                // Cargo unifies target-specific dependency features into the Linux build.
                (cargo) =>
                    `${cargo}\n[target.'cfg(target_os = "linux")'.dependencies.ort]\nversion = "=2.0.0-rc.13"\nfeatures = ["cuda"]\n`,
                /ort must be declared exactly once/,
            ],
            [
                // The scanner must respect section headers; otherwise an unrelated `ort` assignment can hide the dependency's forbidden feature.
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
                // The qualifier must ignore commented declarations: the manifest pins rc.12, and commented rc.13 does not satisfy the check.
                (cargo) =>
                    cargo.replace(
                        'ort = { version = "=2.0.0-rc.13", default-features = false, features = ["load-dynamic", "ndarray", "std"] }',
                        'ort = { version = "=2.0.0-rc.12", default-features = false, features = [\n    # version = "=2.0.0-rc.13"\n    "load-dynamic",\n] }',
                    ),
                /pinned ort identity does not match/,
            ],
            [
                // A comment must not satisfy `default-features = false`.
                (cargo) =>
                    cargo.replace(
                        'ort = { version = "=2.0.0-rc.13", default-features = false, features = ["load-dynamic", "ndarray", "std"] }',
                        'ort = { version = "=2.0.0-rc.13", features = [\n    # default-features = false\n    "load-dynamic",\n] }',
                    ),
                /ort .* must set default-features = false/,
            ],
            [
                // A `#` inside a quoted value is string content, so the parser must not truncate the entry.
                (cargo) =>
                    cargo.replace(
                        '"load-dynamic", "ndarray", "std"',
                        '"load-dynamic", "ndarray", "std", "cuda#notacomment"',
                    ),
                /ort feature cuda#notacomment .* outside the qualified closure/,
            ],
            [
                // The qualifier must count `ort={ ... }` in target-specific dependency tables because TOML permits whitespace around `=`.
                // Cargo unifies the target-specific and base `ort` entries' features.
                (cargo) =>
                    `${cargo}\n[target.'cfg(target_os = "linux")'.dependencies]\nort={ version = "=2.0.0-rc.13", default-features = false, features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // Cargo reads the quoted key `"o\u0072t"` as `ort`.
                // The qualifier must reject dependency tables whose quoted keys cannot be decoded.
                (cargo) =>
                    `${cargo}\n[target.'cfg(target_os = "linux")'.dependencies]\n"o\\u0072t" = { version = "=2.0.0-rc.13", default-features = false, features = ["cuda"] }\n`,
                // An unreadable dependency table prevents validation of every crate's closure.
                // The qualifier must reject an unreadable dependency table before validating any crate closure.
                /must be declared exactly once/,
            ],
            [
                // A dependency key can rename a crate.
                // Cargo resolves `ort_cuda` to `ort` and unifies its features with the `ort` entry.
                // Matching dependency keys instead of `package` names misses renamed `ort` dependencies.
                (cargo) =>
                    `${cargo}\nort_cuda = { package = "ort", version = "=2.0.0-rc.13", default-features = false, features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // The qualifier must reject a renamed dependency whose `package` value cannot be decoded.
                (cargo) =>
                    `${cargo}\nort_alias = { package = "o\\u0072t", version = "=2.0.0-rc.13" }\n`,
                /must be declared exactly once/,
            ],
            [
                // Cargo feature entries forward dependency features with `dep/feature`.
                // `default` is enabled unless Cargo receives `--no-default-features`.
                // not.
                (cargo) => `${cargo}\n[features]\ndefault = ["ort/cuda"]\n`,
                /\[features\] table .* forwards ort\/cuda, which is outside the qualified closure/,
            ],
            [
                // The qualifier must scan every feature forwarding, including forwardings unreachable from `default`.
                // Feature forwarding uses the dependency key, including renamed keys.
                (cargo) =>
                    `${cargo.replace(
                        /^ort = /m,
                        'ort_dep = { package = "ort", version = "=2.0.0-rc.13", default-features = false, features = ["load-dynamic"] }\nunused_ort = ',
                    )}\n[features]\nnever-enabled = ["ort_dep/tensorrt"]\n`,
                /forwards ort_dep\/tensorrt, which is outside the qualified closure/,
            ],
            [
                // TOML literal strings can spell `ort/cuda` feature forwarding.
                (cargo) => `${cargo}\n[features]\nbypass = ['ort/cuda']\n`,
                /forwards ort\/cuda, which is outside the qualified closure/,
            ],
            [
                // A quoted table header `["features"]` denotes the `[features]` table.
                // Raw-header comparison misses quoted `[features]` table headers.
                (cargo) => `${cargo}\n["features"]\ndefault = ["ort/cuda"]\n`,
                /forwards ort\/cuda, which is outside the qualified closure/,
            ],
            [
                // Header detection must ignore lines inside multi-line strings.
                (cargo) =>
                    `${cargo}\n[features]\npoison = ["""\n[package.metadata.decoy]\n"""]\ndefault = ["ort/cuda"]\n`,
                /forwards ort\/cuda, which is outside the qualified closure/,
            ],
            [
                // A `#` inside a multi-line string is string content, including before its closing delimiter.
                // Per-line comment stripping must preserve multi-line string delimiters.
                (cargo) =>
                    `[package.metadata.decoy]\nvalue = """\n# """\n\n${cargo}\n[target.'cfg(target_os = "linux")'.dependencies]\nort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // The qualifier must decode escaped basic strings before scanning or reject the manifest.
                (cargo) =>
                    `${cargo}\n[features]\nbypass = ["ort/c\\u0075da"]\n`,
                /\[features\] table .* holds a string this qualifier cannot read/,
            ],
            [
                // The qualifier must require exact dependency keys because Cargo ignores unknown keys such as `fakedefault-features`.
                (cargo) =>
                    cargo.replace(
                        'ort = { version = "=2.0.0-rc.13", default-features = false,',
                        'ort = { version = "=2.0.0-rc.13", fakedefault-features = false,',
                    ),
                /ort .* must set default-features = false/,
            ],
            [
                // The qualifier must require the real `version` key; `fakeversion` can contain the required pin.
                (cargo) =>
                    cargo.replace(
                        'ort = { version = "=2.0.0-rc.13",',
                        'ort = { fakeversion = "=2.0.0-rc.13", version = "=2.0.0-rc.12",',
                    ),
                /pinned ort identity does not match/,
            ],
            [
                // A key inside an inline table is a TOML key, so it may be quoted.
                // The parser treats quoted `features` keys as `features` when reading `ort` features.
                (cargo) =>
                    cargo.replace(
                        /^ort = \{ version = "=2\.0\.0-rc\.13", default-features = false,.*$/m,
                        'ort = { version = "=2.0.0-rc.13", default-features = false, "features" = ["load-dynamic", "cuda"] }',
                    ),
                /ort feature cuda .* is outside the qualified closure/,
            ],
            [
                (cargo) =>
                    cargo.replace(
                        /^ort = \{ version = "=2\.0\.0-rc\.13", default-features = false,.*$/m,
                        "ort = { version = \"=2.0.0-rc.13\", default-features = false, 'features' = [\"load-dynamic\", \"tensorrt\"] }",
                    ),
                /ort feature tensorrt .* is outside the qualified closure/,
            ],
            [
                // The parser rejects escaped quoted keys instead of treating them as absent.
                (cargo) =>
                    cargo.replace(
                        /^ort = \{ version = "=2\.0\.0-rc\.13", default-features = false,.*$/m,
                        'ort = { version = "=2.0.0-rc.13", default-features = false, "featu\\u0072es" = ["cuda"] }',
                    ),
                /must be declared exactly once/,
            ],
            [
                // The parser treats quoted `package` keys as `package` when resolving renamed dependencies.
                (cargo) =>
                    `${cargo}\n[target.'cfg(target_os = "linux")'.dependencies]\nort_cuda = { "package" = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // TOML permits whitespace around dots in dotted keys.
                (cargo) =>
                    `target . 'cfg(target_os = "linux")' . dependencies . ort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n${cargo}`,
                /must be declared exactly once/,
            ],
            [
                // `features.default` creates the feature table without a `[features]` header.
                (cargo) => `features.default = ["ort/cuda"]\n${cargo}`,
                /dotted features assignment this qualifier cannot attribute/,
            ],
            [
                // The parser recognizes dotted assignments before any table header as dependency declarations.
                (cargo) =>
                    `target.'cfg(target_os = "linux")'.dependencies.ort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n${cargo}`,
                /must be declared exactly once/,
            ],
            [
                // TOML treats table-header dots with surrounding whitespace as equivalent.
                (cargo) =>
                    `${cargo}\n[target . 'cfg(target_os = "linux")' . dependencies]\nort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // A header component is a TOML key, so quoted `"dependencies"` names the `dependencies` table.
                (cargo) =>
                    `${cargo}\n[target.'cfg(target_os = "linux")'."dependencies"]\nort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                (cargo) =>
                    `${cargo}\n['dev-dependencies']\nort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // The parser must ignore headers inside multiline strings.
                (cargo) =>
                    `${cargo.replace(/^ort = .*$/m, "")}\n[dependencies.ort]\nversion = "=2.0.0-rc.13"\ndefault-features = false\npoison = """\n[package.metadata.decoy]\n"""\nfeatures = ["cuda"]\n`,
                /ort feature cuda .* is outside the qualified closure/,
            ],
            [
                // Quote state must persist across lines in multiline strings.
                // A bracket in a multiline string must not change bracket depth.
                (cargo) =>
                    `${cargo}\npoison = """\n]\n"""\n\n[target.'cfg(target_os = "linux")'.dependencies]\nort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // A bracket inside a quoted value must not change bracket depth.
                // A positive depth prevents detection of later target-specific dependencies.
                (cargo) =>
                    `${cargo}\npoison = "["\n\n[target.'cfg(target_os = "linux")'.dependencies]\nort = { version = "=2.0.0-rc.13", default-features = false, features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
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
        // The shared comparator prevents format filtering from rejecting hosts that `evaluatePlatform` accepts.
        // `compareDotted` and `evaluatePlatform` must use the same version-floor semantics.
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.oracle.host.kernel = "4.18.0-513.el8.x86_64";
        manifest.oracle.host.glibc = "2.28-236.el8";
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).not.toThrow();

        // Versions below the floor fail closed.
        const low = freshRoot();
        const lowManifest = fixtureManifest();
        lowManifest.oracle.host.kernel = "2.6.32-696.el6.x86_64";
        installManifest(low, lowManifest);
        expect(() => generate(low, { check: false })).toThrow(
            /does not satisfy the certified linux-x64-gnu lane/,
        );
    });

    test("a truncated host version cannot clear a floor on one component", () => {
        // `compareDotted` treats missing components as 0.
        // A shorter version is compared with zero for every missing component.
        // After equal preceding segments, a higher segment makes the version pass.
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
                /does not satisfy the certified linux-x64-gnu lane/,
            );
        }
    });

    test("a prerelease host version does not satisfy the stable floor", () => {
        // `compareDotted` treats a numeric suffix as patch components above the floor.
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
                /does not satisfy the certified linux-x64-gnu lane/,
            );
        }

        for (const [field, value] of [
            ["kernel", "4.18.0-513.el8.x86_64"],
            ["glibc", "2.28-236.el8"],
            ["kernel", "4.19-rc1"],
            ["kernel", "4.18.1-rc2"],
        ] as const) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            manifest.oracle.host[field] = value;
            // A host-version fixture must clear exact-floor evidence after changing the host version.
            manifest.oracle.host.exact_floor = false;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).not.toThrow();
        }
    });

    test("an oracle transcript cannot outlive the bytes it names", () => {
        // Requalification must replace the oracle binding when artifact digests change.
        // A retained oracle pass can cover bytes absent from the lock.
        const root = freshRoot();
        installProductionManifest(root, (manifest) => {
            manifest.inputs.model_onnx.sha256 = createHash("sha256")
                .update("requalified model bytes")
                .digest("hex");
        });
        // The stale case retains the prior oracle binding.
        const manifestPath = join(root, SOURCE_MANIFEST_PATH);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.oracle.bound_inputs.model_onnx = createHash("sha256")
            .update("bytes from a previous qualification")
            .digest("hex");
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

        expect(() => generate(root, { check: false })).toThrow(
            /bound_inputs\.model_onnx names bytes that are not the qualified ones/,
        );
    });

    test("an oracle host without procfs fd exec cannot qualify", () => {
        // The certified Linux lane executes the sealed ORT object through `/proc/self/fd`.
        // An oracle that loads the sealed ORT object without `/proc/self/fd` does not exercise the production path.
        // Evidence from an oracle that does not use `/proc/self/fd` cannot qualify for the production path.
        for (const value of [false, undefined]) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            if (value === undefined) {
                delete manifest.oracle.host.procfs_self_fd_exec;
            } else {
                manifest.oracle.host.procfs_self_fd_exec = value;
            }
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(
                value === undefined
                    ? /oracle\.host: missing key procfs_self_fd_exec/
                    : /does not satisfy the certified linux-x64-gnu lane/,
            );
        }
    });

    test("an oracle without a recorded pass cannot qualify", () => {
        // `oracle.result` distinguishes a successful run from a failed or absent run.
        // A failed or absent run can have the same configuration as a successful run.
        // `oracle.result` must equal `"pass"`; its presence alone does not establish success.
        const cases: [(o: any) => void, RegExp][] = [
            [
                (o) => {
                    o.result = "fail";
                },
                /recorded result must be "pass"/,
            ],
            [
                (o) => {
                    delete o.result;
                },
                /oracle: missing key result/,
            ],
            [
                (o) => {
                    o.vectors_compared = o.expected_vectors - 1;
                },
                /compared 7 vectors, expected 8/,
            ],
            [
                (o) => {
                    o.observed_max_error = o.tolerance * 2;
                },
                /observed_max_error must be a finite value/,
            ],
            [
                (o) => {
                    o.observed_max_error = -1;
                },
                /observed_max_error must be a finite value/,
            ],
        ];
        for (const [mutate, error] of cases) {
            const root = freshRoot();
            const manifest = fixtureManifest();
            mutate(manifest.oracle);
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).toThrow(error);
        }
    });

    test("mismatched oracle evidence is rejected", () => {
        const contract = buildContract();
        // The oracle binds to artifact digests, so validation needs the input table being checked.
        const inputs = fixtureManifest().inputs;
        const base = fixtureManifest().oracle;
        const report = JSON.parse(
            readFileSync(
                join(repoRoot, FIXTURE_DIR, "artifacts/synapse-smoke-report.json"),
                "utf8",
            ),
        );
        const cases: [(o: typeof base) => void, RegExp][] = [
            [
                // A mis-cased nested key must be reported as unknown instead of as an absent version.
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
                /network access must be none or available/,
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
                /does not satisfy the certified linux-x64-gnu lane/,
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
            expect(() =>
                checkOracleEvidence(oracle, contract, report, inputs),
            ).toThrow(error);
        }
        expect(() =>
            checkOracleEvidence(base, contract, report, inputs),
        ).not.toThrow();
        const forged = structuredClone(report);
        forged.model_fingerprint = "e".repeat(64);
        expect(() =>
            checkOracleEvidence(base, contract, forged, inputs),
        ).toThrow(/smoke report identity/);
        const wrongInput = structuredClone(report);
        wrongInput.inputs.model_onnx = "e".repeat(64);
        expect(() =>
            checkOracleEvidence(base, contract, wrongInput, inputs),
        ).toThrow(/input model_onnx/);
    });

    test("above-floor oracle evidence is retained but does not qualify production", () => {
        const root = freshRoot();
        installProductionManifest(root);
        const manifest = JSON.parse(
            readFileSync(join(root, SOURCE_MANIFEST_PATH), "utf8"),
        );
        manifest.oracle.host.kernel = "6.12";
        manifest.oracle.host.exact_floor = false;
        const reportPath = join(
            root,
            "scripts/__fixtures__/mc-host-qualification/artifacts/synapse-smoke-report.json",
        );
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        report.host.kernel = "6.12";
        report.host.exact_floor = false;
        const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
        manifest.oracle.smoke_report.sha256 = createHash("sha256")
            .update(reportBytes)
            .digest("hex");
        installManifest(root, manifest);
        writeFileSync(reportPath, reportBytes);
        const result = generate(root, { check: false });
        expect(result.productionQualified).toBe(false);
        expect(JSON.parse(result.outputs.lock).oracle).toMatchObject({
            qualified: false,
            observed: {
                host: {
                    kernel: "6.12",
                    glibc: "2.28",
                    exact_floor: false,
                },
            },
        });
    });
});

describe("provider-credential matrix", () => {
    const doc = buildCredentialsDoc();

    test("matrix pins agree with the U8 contract", () => {
        validateCredentialsDoc(doc, buildContract());
        assertPinsMatchContract(buildContract());
    });

    test("a repeated template placeholder fails the one-to-one check", () => {
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
        badFloor.platforms.supported[0].kernel_min = "4.19";
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
        expect(canonicalCredentialRowEncoding("pi", "openai", rowA)).toBe(same);
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
        expect(credentials.fingerprint.domain).toBe("subc-broca-credential-v1");
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

describe("harness runtime closure graph qualification", () => {
    test("accepts a complete reachable graph and produces a stable canonical digest", () => {
        const closure = closureFixture();
        validateClosureManifest(closure);
        validateClosureManifest(openCodeClosureFixture());
        const reparsed = JSON.parse(canonicalClosureManifest(closure));
        expect(closureManifestDigest(reparsed)).toBe(
            closureManifestDigest(closure),
        );
        expect(closureManifestDigest(closure)).toMatch(/^[0-9a-f]{64}$/);
    });

    test("binds exact schema, harness, package, version, and argument variant", () => {
        const cases: [
            (closure: any) => void,
            RegExp,
        ][] = [
            [
                (closure) => {
                    closure.schema = "magic-context.mc-host-harness-closure/v2";
                },
                /unknown schema/,
            ],
            [
                (closure) => {
                    closure.harness = "unknown";
                },
                /harness must be opencode or pi/,
            ],
            [
                (closure) => {
                    closure.package = "pi-lookalike";
                },
                /package must be @earendil-works\/pi-coding-agent/,
            ],
            [
                (closure) => {
                    closure.version = "0.80";
                },
                /version must be exact semver/,
            ],
            [
                (closure) => {
                    closure.argument_variant = "raw_argv";
                },
                /argument_variant .* is not qualified/,
            ],
            [
                (closure) => {
                    closure.extra = true;
                },
                /unknown key extra/,
            ],
        ];
        for (const [mutate, error] of cases) {
            const closure: any = closureFixture();
            mutate(closure);
            expect(() => validateClosureManifest(closure)).toThrow(error);
        }
    });

    test("rejects invalid source roots, paths, hashes, sizes, modes, and node kinds", () => {
        const cases: [
            (closure: any) => void,
            RegExp,
        ][] = [
            [
                (closure) => {
                    closure.source_roots.reverse();
                },
                /source_roots must be sorted and unique/,
            ],
            [
                (closure) => {
                    closure.nodes[0].source_root = "undeclared";
                },
                /does not name a declared source root/,
            ],
            [
                (closure) => {
                    closure.nodes[0].path = "../node";
                },
                /safe relative POSIX path/,
            ],
            [
                (closure) => {
                    closure.nodes[0].source_path = "bin\\node";
                },
                /safe relative POSIX path/,
            ],
            [
                (closure) => {
                    closure.nodes[0].sha256 = "0".repeat(64);
                },
                /real 64-lowercase-hex digest/,
            ],
            [
                (closure) => {
                    closure.nodes[0].size_bytes = -1;
                },
                /non-negative integer/,
            ],
            [
                (closure) => {
                    closure.nodes[0].mode = 0o1000;
                },
                /owner-only/,
            ],
            [
                (closure) => {
                    closure.nodes[0].kind = "script";
                },
                /not a qualified node kind/,
            ],
        ];
        for (const [mutate, error] of cases) {
            const closure: any = closureFixture();
            mutate(closure);
            expect(() => validateClosureManifest(closure)).toThrow(error);
        }
    });

    test("rejects duplicate, unsorted, missing, and unreachable graph nodes", () => {
        const duplicate: any = closureFixture();
        duplicate.nodes.splice(1, 0, structuredClone(duplicate.nodes[0]));
        expect(() => validateClosureManifest(duplicate)).toThrow(
            /paths must be unique|must be sorted and unique/,
        );

        const unsorted: any = closureFixture();
        unsorted.nodes.reverse();
        expect(() => validateClosureManifest(unsorted)).toThrow(
            /closure.nodes must be sorted and unique/,
        );

        const missing: any = closureFixture();
        missing.nodes[1].dependencies[0].path =
            "node_modules/missing/index.js";
        expect(() => validateClosureManifest(missing)).toThrow(
            /dependency target .* is missing/,
        );

        const unreachable: any = closureFixture();
        unreachable.nodes.push({
            ...structuredClone(unreachable.nodes.at(-1)),
            path: "node_modules/unreachable.js",
            source_path: "node_modules/unreachable.js",
        });
        expect(() => validateClosureManifest(unreachable)).toThrow(
            /node .* is unreachable/,
        );
    });

    test("requires explicit finite-dynamic and native-addon edges", () => {
        const unresolvedDynamic: any = closureFixture();
        unresolvedDynamic.nodes[1].dependencies[1].path =
            "node_modules/provider/not-listed.js";
        expect(() => validateClosureManifest(unresolvedDynamic)).toThrow(
            /dependency target .* is missing/,
        );

        const wrongNativeKind: any = closureFixture();
        wrongNativeKind.nodes[2].dependencies[0].kind = "static";
        expect(() => validateClosureManifest(wrongNativeKind)).toThrow(
            /native dependency kind must correspond exactly/,
        );

        const unclaimedAddon: any = closureFixture();
        unclaimedAddon.nodes[2].dependencies = [];
        expect(() => validateClosureManifest(unclaimedAddon)).toThrow(
            /native\/addon\.node.*unreachable/,
        );

        const unknownDependencyKind: any = closureFixture();
        unknownDependencyKind.nodes[1].dependencies[0].kind = "runtime_scan";
        expect(() => validateClosureManifest(unknownDependencyKind)).toThrow(
            /not a qualified dependency kind/,
        );
    });

    test("validates harness-specific roots and preserves extension order in identity", () => {
        const wrongRootKind: any = closureFixture();
        wrongRootKind.nodes[0].kind = "executable";
        expect(() => validateClosureManifest(wrongRootKind)).toThrow(
            /interpreter root must have node kind interpreter/,
        );

        const missingEntrypoint: any = closureFixture();
        missingEntrypoint.entrypoint = null;
        expect(() => validateClosureManifest(missingEntrypoint)).toThrow(
            /pi requires interpreter and entrypoint roots/,
        );

        const first: any = closureFixture();
        const secondExtension = {
            ...structuredClone(first.nodes.at(-1)),
            path: "node_modules/provider/zext.js",
            source_path: "node_modules/provider/zext.js",
        };
        first.nodes.push(secondExtension);
        first.extensions.push(secondExtension.path);
        validateClosureManifest(first);
        const reordered = structuredClone(first);
        reordered.extensions.reverse();
        validateClosureManifest(reordered);
        expect(closureManifestDigest(reordered)).not.toBe(
            closureManifestDigest(first),
        );

        const duplicateExtension = structuredClone(first);
        duplicateExtension.extensions.push(duplicateExtension.extensions[0]);
        expect(() => validateClosureManifest(duplicateExtension)).toThrow(
            /extensions must be unique/,
        );
    });

    test("optional source closure is validated and locked by digest", () => {
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.harnesses.pi.closure = closureFixture();
        delete manifest.harnesses.pi.closure_unqualified_reason;
        installManifest(root, manifest);
        const generated = generate(root, { check: false });
        const lock = JSON.parse(generated.outputs.lock);
        expect(lock.harnesses.pi.closure.sha256).toBe(
            closureManifestDigest(manifest.harnesses.pi.closure),
        );
        expect(lock.harnesses.pi.closure.source_roots).toEqual(
            manifest.harnesses.pi.closure.source_roots,
        );

        const mismatchRoot = freshRoot();
        const mismatch = fixtureManifest();
        mismatch.harnesses.pi.closure = closureFixture();
        delete mismatch.harnesses.pi.closure_unqualified_reason;
        mismatch.harnesses.pi.closure.version = "0.80.1";
        installManifest(mismatchRoot, mismatch);
        expect(() => generate(mismatchRoot, { check: false })).toThrow(
            /identity does not match its harness source record/,
        );
    });

    test("production closure qualification hashes every declared source node", () => {
        const root = freshRoot();
        installProductionManifest(root);
        expect(() => generate(root, { check: false })).not.toThrow();

        writeFileSync(
            join(
                root,
                "closure-sources/pi-install/node_modules/@earendil-works/pi-coding-agent/dist/helper.js",
            ),
            "mutant",
        );
        expect(() => generate(root, { check: false })).toThrow(
            /closure source node hash changed/,
        );
    });

    test("production closure qualification rejects runtime-derived imports", () => {
        const root = freshRoot();
        installProductionManifest(root);
        const source = "import(userInput)";
        const sourcePath = join(
            root,
            "closure-sources/pi-install/node_modules/@earendil-works/pi-coding-agent/dist/helper.js",
        );
        writeFileSync(sourcePath, source);
        const manifest = JSON.parse(
            readFileSync(join(root, SOURCE_MANIFEST_PATH), "utf8"),
        );
        const helper = manifest.harnesses.pi.closure.nodes.find(
            (node: { source_path: string }) =>
                node.source_path.endsWith("/helper.js"),
        );
        helper.size_bytes = Buffer.byteLength(source);
        helper.sha256 = createHash("sha256").update(source).digest("hex");
        writeFileSync(
            join(root, SOURCE_MANIFEST_PATH),
            `${JSON.stringify(manifest, null, 2)}\n`,
        );
        expect(() => generate(root, { check: false })).toThrow(
            /unresolved dynamic import/,
        );
    });

    test("dynamic-import exceptions bind exact source digest and expression", () => {
        const path =
            "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/env-api-keys.js";
        const expression =
            "import(__rewriteRelativeImportExtension(specifier))";
        const node = {
            path,
            source_root: "pi-install",
            source_path: path,
            kind: "module" as const,
            mode: 0o600,
            size_bytes: 1,
            sha256:
                "102c2b8622b18c8fc3e1f961e5cc2a6c83104a85c5d693f08e419a05d99beaac",
            dependencies: [],
        };
        const closure = {
            ...closureFixture(),
            nodes: [node],
        };
        expect(() =>
            validateQualifiedDynamicImports(
                repoRoot,
                closure,
                node,
                "pi",
                path,
                node.sha256,
                `const load = (specifier) => ${expression};`,
            ),
        ).not.toThrow();
        const mutated = `const load = (specifier) => ${expression}; import(userInput);`;
        const mutatedNode = {
            ...node,
            sha256: createHash("sha256").update(mutated).digest("hex"),
        };
        expect(() =>
            validateQualifiedDynamicImports(
                repoRoot,
                { ...closure, nodes: [mutatedNode] },
                mutatedNode,
                "pi",
                path,
                mutatedNode.sha256,
                mutated,
            ),
        ).toThrow(/unresolved dynamic import/);
    });
});

describe("build-entrypoint evidence consumption (U2/U6 gate)", () => {
    test("production build rejects absent local qualification evidence", () => {
        const root = freshRoot();
        expect(() => requireQualificationEvidence(root)).toThrow(/absent/);
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

        expect(() => requireQualificationEvidence(root)).not.toThrow();
        expect(() =>
            requireQualificationEvidence(root, { verifyBytes: true }),
        ).toThrow(/inputs\.model_onnx: byte size/);
    });

    test("stripped lock rows cannot pass the gate", () => {
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
        const root = freshRoot();
        installProductionManifest(root);
        generate(root, { check: false });

        recite(root, join(root, OUTPUT_PATHS.credentials), "{}\n");

        expect(() => requireQualificationEvidence(root)).toThrow(
            /not a canonical regeneration.*mc-host-provider-credentials\.json/,
        );
    });

    test("an edited generated U8 contract cannot pass the gate", () => {
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
        const manifest = fixtureManifest();
        manifest.inputs.model_onnx = {
            qualified: false,
            reason: "real model bytes not yet qualified",
        };
        installManifest(root, manifest);
        generate(root, { check: false });

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
        installManifest(root, fixtureManifest());
        generate(root, { check: false });

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
        useProductionProvenance(manifest);
        unblacklistDigests(manifest);

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

        rmSync(join(root, STAGED_PRODUCTION_INPUT_DIR), {
            recursive: true,
            force: true,
        });
        expect(generate(root, { check: true }).drift).toEqual([]);

        expect(() =>
            generate(root, { check: true, verifyBytes: true }),
        ).toThrow(/verify bytes missing/);
    });
});

describe("release prerequisite (CLI)", () => {
    test("the consumption gate is reachable outside the tests", () => {
        // Without `--verify-bytes`, the gate must reach a qualification verdict without reading artifacts.
        const script = join(
            repoRoot,
            "scripts/qualify-mc-host-production-inputs.ts",
        );
        const required = spawnSync("bun", [script, "--require-qualified"], {
            cwd: repoRoot,
            encoding: "utf8",
        });
        expect(required.status).toBe(1);
        // Missing evidence and an unqualified recorded verdict both reject qualification.
        expect(required.stderr).toContain("qualification evidence rejected");
        const refusals = [
            "not production-qualified",
            `absent (${OUTPUT_PATHS.evidence})`,
        ];
        expect(
            refusals.filter((reason) => required.stderr.includes(reason)),
        ).not.toEqual([]);

        // The drift check must pass while production bytes remain unqualified.
        const drift = spawnSync("bun", [script, "--check"], {
            cwd: repoRoot,
            encoding: "utf8",
        });
        expect(drift.status).toBe(0);
        expect(drift.stdout).toContain("production_qualified false");
    });
});

describe("qualifying-runtime binding", () => {
    test("only the pinned Bun may verify bytes", () => {
        // `assertPinnedQualifyingRuntime` receives an explicit runtime value so tests do not depend on the Bun that runs them.
        const pinned = QUALIFICATION_PINS.harness_runtimes.bun;
        expect(() => assertPinnedQualifyingRuntime(pinned)).not.toThrow();
        for (const running of ["1.2.14", "1.4.0", undefined]) {
            expect(() => assertPinnedQualifyingRuntime(running)).toThrow(
                /byte verification must run under the pinned Bun/,
            );
        }
    });
});

describe("resolved runtime feature closure", () => {
    test("the graph Cargo resolves carries no forbidden capability", () => {
        // Cargo unifies features across the resolved graph; `cargo metadata` detects features manifest scans miss but requires a resolvable workspace and toolchain.
        const metadata = spawnSync(
            "cargo",
            ["metadata", "--format-version", "1"],
            { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        );
        expect(metadata.status).toBe(0);
        const resolved = new Map<string, string[]>();
        for (const node of JSON.parse(metadata.stdout).resolve.nodes as {
            id: string;
            features: string[];
        }[]) {
            // IDs are `<source>#<name>@<version>`, or `<source>#<version>` when the path segment already names the package.
            const tail = node.id.split("#").pop() ?? "";
            const name = tail.includes("@") ? tail.split("@")[0] : tail;
            if (name !== undefined) resolved.set(name, node.features);
        }
        // Exact equality rejects undeclared resolved features as well as forbidden ones.
        expect(resolved.get("ort")).toEqual([
            ...RUNTIME_IDENTITY.rust_crates.ort_features,
        ]);
        for (const crate of ["ort", "ort-sys", "fastembed"]) {
            for (const feature of resolved.get(crate) ?? []) {
                const forbidden = FORBIDDEN_RUNTIME_FEATURE_SUBSTRINGS.find(
                    (hint) => feature.toLowerCase().includes(hint),
                );
                expect(
                    forbidden === undefined ? null : `${crate}/${feature}`,
                ).toBeNull();
            }
        }
        // `ort-sys` features that disable runtime linking or downloads must be active in the resolved set.
        for (const feature of RUNTIME_IDENTITY.rust_crates.ort_sys_features) {
            expect(resolved.get("ort-sys")).toContain(feature);
        }
    }, 120_000);
});
