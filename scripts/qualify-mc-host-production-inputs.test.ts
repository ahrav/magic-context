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
        // Cargo resolves `[patch]`/`[replace]` from the workspace root, so ruling out
        // an override of the qualified crates needs the root manifest too.
        "Cargo.toml",
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
/**
 * Restate the copied smoke report over the manifest a test is about to install.
 *
 * The oracle's report is a separate file bound by digest, so a test that rewrote
 * input digests or host capabilities would otherwise trip the report/manifest
 * identity check for its own setup's reason instead of the rule under test.
 * Tests that mean to forge a report call {@link checkOracleEvidence} with one
 * directly and do not go through here.
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
    // The report names the semantic corpus `semantic_corpus`; the manifest keys it
    // `corpus`.
    // An unqualified input carries no digest. The report's required keys are fixed,
    // so keep what it already named instead of dropping the key and failing the
    // setup on a shape error.
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

/** Mirrors the qualifier's JSON-shaped input set, so a staged production artifact
 *  is loadable rather than merely digest-correct. */
const JSON_SHAPED_INPUTS: ReadonlySet<string> = new Set([
    "config",
    "corpus",
    "special_tokens_map",
    "tokenizer",
    "tokenizer_config",
]);

/**
 * Where production-mode tests stage artifact bytes. Production qualification
 * denies any verify path under `scripts/__fixtures__`, so a production manifest
 * must name a location outside it — as a real qualifying host would.
 */
const STAGED_PRODUCTION_INPUT_DIR = "opt/mc-host-inputs";

/**
 * Rebind the oracle transcript to whatever digests the inputs now carry.
 *
 * Any helper that restages bytes has to do this, which is the binding working as
 * intended: a transcript naming digests the lock no longer holds is exactly the
 * stale-oracle case the check exists to reject.
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
 * Point every source at a resolvable host. The committed fixtures name RFC 2606
 * `.invalid` hosts, which production mode rejects because they can never serve an
 * artifact, so a production-mode test aimed at any other rule has to clear that one
 * first — as a real production manifest would.
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
    rebindOracle(manifest);
}

/**
 * Give every input a production-policy license approver.
 *
 * The fixture is approved by `test-fixture`, which production mode rejects, so a
 * test that promotes the fixture must restate the approval or fail on the
 * approver before reaching the rule it is exercising.
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
 * Every fixture-provenance adjustment production mode requires.
 *
 * The fixture names `.invalid` hosts and is approved by `test-fixture`; both are
 * rejected in production mode, and a test that fixes one but not the other fails
 * on the provenance it forgot rather than on the rule it is exercising.
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
    // Deliberately NOT the committed fixture bytes: their digests are denied in
    // production mode, so a production manifest must carry distinct bytes and
    // the digests computed from them, exactly as a real qualifying host would.
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
        // The JSON inputs must parse: a correct digest over plain text still cannot
        // be loaded by the runtime, so byte verification rejects it. Distinct
        // contents per key keep the digests distinct, as real artifacts would be.
        const bytes = Buffer.from(
            JSON_SHAPED_INPUTS.has(key)
                ? `${JSON.stringify({ staged_production_stand_in: key })}\n`
                : `staged production stand-in for ${key}\n`,
        );
        writeFileSync(target, bytes);
        artifact.verify_local_path = target;
        artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
        artifact.size_bytes = bytes.length;
        // The fixtures name RFC 2606 `.invalid` hosts, which production mode
        // rejects because they can never serve an artifact. A production manifest
        // must name a resolvable host, exactly as a real one would.
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

    test("a source whose normalized path is a directory is rejected", () => {
        // A dot segment moves the trailing slash out of the spelling: the raw string
        // ends in `..`, while `new URL()` normalizes the path to the parent
        // directory. The content-address check still passes because the digest
        // survives as a segment, so the URL qualified as one artifact while naming
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

    test("digest-correct bytes the runtime cannot load are rejected", () => {
        // Byte identity is not loadability: a plain-text stand-in with a matching
        // digest would qualify and then fail at bundle load.
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
        // A credential hides in a query value as readily as in its name — a nested
        // URL with its own userinfo, and one level down from that. The component is
        // rejected outright in production rather than proven clean at every depth.
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
        // positively: an unlisted branch reads as immutable only because nobody
        // thought of it.
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

        // The artifact's own digest satisfies it, and so does any
        // content-addressed revision of git-SHA-1 length or longer.
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
        // The committed fixtures name RFC 2606 `.invalid` hosts. Leaving one in a
        // production manifest records provenance nobody can retrieve, so the lock
        // would claim an artifact origin that cannot exist.
        for (const host of [
            "models.example.invalid",
            "artifacts.example.test",
            "cdn.localhost",
            "files.example.com",
            // `URL.hostname` brackets an IPv6 literal, so the bare `::1` entry in
            // the list would never match without normalizing first.
            "[::1]",
            "127.0.0.1",
            // The whole 127.0.0.0/8 block is loopback, not only `.1`.
            "127.0.0.2",
            // `URL` canonicalizes an IPv4-mapped literal to `[::ffff:7f00:1]`,
            // which equals neither entry in the list it is meant to match.
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

        // Test-fixture mode keeps using them, which is what the fixtures are.
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
        // The fixture artifacts are tiny text stand-ins named `model.onnx` and
        // `ort-runtime.so` with `example.invalid` provenance. Two independent
        // mechanisms must keep them out of a production lock.

        // 1. By digest, which survives relocating the bytes anywhere.
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

        // 2. By path, for bytes carrying digests the blacklist does not know.
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
        // `verifyBytes` is the one gate, and it is the flag `--verify-bytes` and
        // `requireQualificationEvidence` actually pass. It previously read a
        // `verifyExternalBytes` option that was not in `generate`'s signature, so
        // no caller could set it and closure source bytes went unverified while
        // the command reported that every production byte had been checked.
        // Asserting the closure message specifically is what keeps that gate
        // wired: a generic /missing/ passes on the artifact paths alone.
        expect(() => generate(root, { check: true, verifyBytes: true })).toThrow(
            /closure verify root is missing/,
        );
        expect(() => generate(root, { check: false })).toThrow(/missing/);
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

    test("a workspace override of a qualified crate fails production closed", () => {
        // Cargo resolves `[patch]` from the workspace root, so the leaf manifest can
        // name the exact pin while the build compiles a replacement source.
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
                // No trailing blank line: the subtable runs to EOF. Deciding from
                // assignment lines read `path` as the crate and only reached the
                // header's crate on a non-assignment line, so this form was never
                // checked — and the case above passed only because its trailing
                // newline produced one.
                '[patch.crates-io.fastembed]\npath = "../vendored-fastembed"',
                /overrides fastembed, so the build would not resolve/,
            ],
            [
                // A patch entry renames the same way a dependency does, so the key is
                // not the crate.
                '[patch.crates-io]\nort_fork = { package = "ort", path = "../vendored-ort" }\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // The same rename in subtable form.
                '[patch.crates-io.ort_fork]\npackage = "ort"\npath = "../vendored-ort"\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                'patch.crates-io.ort = { path = "fake-ort" }\n',
                /dotted override assignment this qualifier cannot attribute/,
            ],
            [
                // A dotted key's components are TOML keys too, so `"patch"` names the
                // same table as `patch`. Testing the still-quoted component against a
                // bare-name pattern matched nothing and the override went unnoticed.
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
                // The same replacement in subtable form. Cargo deserializes the
                // header's package-ID spec and applies the replacement; a scan that
                // opens subtables only under `patch` reads this body as an override
                // of a crate named `path`.
                '[replace."ort:2.0.0-rc.13"]\npath = "../vendored-ort"\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // Subtable form running to EOF, for the same reason the `patch` case
                // above carries one: the verdict must not depend on a trailing line.
                '[replace."ort:2.0.0-rc.13"]\npath = "../vendored-ort"',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // `name@version` is the modern package-ID spelling and Cargo accepts
                // it here. Cutting the spec at its first `:` leaves the version
                // attached, so the override reads as one of an unrelated crate.
                '[replace]\n"ort@2.0.0-rc.13" = { path = "../vendored-ort" }\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                '[replace."ort@2.0.0-rc.13"]\npath = "../vendored-ort"\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // A spec may name its source as a URL and the package in the
                // fragment. Cutting at the first `:` reduces this one to `https`.
                '[replace]\n"https://github.com/pykeio/ort#ort:2.0.0-rc.13" = { path = "../vendored-ort" }\n',
                /overrides ort, so the build would not resolve/,
            ],
            [
                // Literal-string spellings of the same key.
                "[replace.'ort:2.0.0-rc.13']\npath = \"../vendored-ort\"\n",
                /overrides ort, so the build would not resolve/,
            ],
            [
                // A URL spec whose fragment holds only a version leaves Cargo to
                // derive the package from the source, which this scan cannot follow.
                '[replace."https://github.com/pykeio/ort#2.0.0-rc.13"]\npath = "../vendored-ort"\n',
                /declares an override this qualifier cannot read/,
            ],
            [
                // Table names are TOML keys, so they may be quoted. Comparing the
                // header text left every quoted spelling unattributed and therefore
                // unexamined, for `replace` and `patch` alike.
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

        // An override of an unrelated crate is not this check's business, in the
        // subtable spellings as much as the inline ones — the point of resolving the
        // header is to attribute the override, not to reject every one on sight.
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
                // The subtable form is a valid Cargo spelling, so it must be
                // checked rather than refused: its keys are the same ones the
                // inline table carries, just under a header.
                (cargo) =>
                    `${cargo.replace(/^ort = .*$/m, "")}\n[dependencies.ort]\nversion = "=2.0.0-rc.13"\ndefault-features = false\nfeatures = ["load-dynamic", "download-binaries"]\n`,
                /ort feature download-binaries .* outside the qualified closure/,
            ],
            [
                // A multiline array inside a subtable. Its lines sit below top
                // level, so skipping them truncates `features = [` and the feature
                // check reports a valid manifest as unreadable instead of reading
                // the forbidden entry.
                (cargo) =>
                    `${cargo.replace(/^ort = .*$/m, "")}\n[dependencies.ort]\nversion = "=2.0.0-rc.13"\ndefault-features = false\nfeatures = [\n    "load-dynamic",\n    "tensorrt",\n]\n`,
                /ort feature tensorrt .* outside the qualified closure/,
            ],
            [
                // A target-specific subtable, which Cargo unifies into the Linux
                // build's feature set while the base entry stays clean.
                (cargo) =>
                    `${cargo}\n[target.'cfg(target_os = "linux")'.dependencies.ort]\nversion = "=2.0.0-rc.13"\nfeatures = ["cuda"]\n`,
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
            [
                // A dependency key is not a crate name. Cargo resolves this to the
                // same `ort` and unifies its features with the ordinary entry, so
                // comparing keys leaves it unexamined.
                (cargo) =>
                    `${cargo}\nort_cuda = { package = "ort", version = "=2.0.0-rc.13", default-features = false, features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // A rename whose `package` value cannot be read must refuse the
                // file rather than be attributed to its key.
                (cargo) =>
                    `${cargo}\nort_alias = { package = "o\\u0072t", version = "=2.0.0-rc.13" }\n`,
                /must be declared exactly once/,
            ],
            [
                // The other side of the closure. Cargo's feature table forwards to a
                // dependency with `dep/feature`, and `default` is on for every build
                // that does not pass --no-default-features, which `build:rust` does
                // not.
                (cargo) => `${cargo}\n[features]\ndefault = ["ort/cuda"]\n`,
                /\[features\] table .* forwards ort\/cuda, which is outside the qualified closure/,
            ],
            [
                // Scanned whether or not the entry is reachable from `default`, and
                // under a renamed key, since forwarding names the key.
                (cargo) =>
                    `${cargo.replace(
                        /^ort = /m,
                        'ort_dep = { package = "ort", version = "=2.0.0-rc.13", default-features = false, features = ["load-dynamic"] }\nunused_ort = ',
                    )}\n[features]\nnever-enabled = ["ort_dep/tensorrt"]\n`,
                /forwards ort_dep\/tensorrt, which is outside the qualified closure/,
            ],
            [
                // A TOML literal string is a valid spelling of the same forwarding.
                (cargo) => `${cargo}\n[features]\nbypass = ['ort/cuda']\n`,
                /forwards ort\/cuda, which is outside the qualified closure/,
            ],
            [
                // And so is a quoted table name: `["features"]` is the same table, so
                // comparing the raw header left the whole forwarding table unexamined
                // while Cargo still reported `default = ["ort/cuda"]`.
                (cargo) => `${cargo}\n["features"]\ndefault = ["ort/cuda"]\n`,
                /forwards ort\/cuda, which is outside the qualified closure/,
            ],
            [
                // Header eligibility from bracket depth alone let a line inside a
                // multi-line string read as a real header, moving the section away
                // from `features` so every forwarding after it went unread.
                (cargo) =>
                    `${cargo}\n[features]\npoison = ["""\n[package.metadata.decoy]\n"""]\ndefault = ["ort/cuda"]\n`,
                /forwards ort\/cuda, which is outside the qualified closure/,
            ],
            [
                // A multi-line string's closing delimiter may sit behind a `#`, which
                // is content there. Stripping comments per line deleted that close, so
                // the string state stayed open and every table after it was read as
                // string body — including this Linux-only entry Cargo resolves with
                // the `cuda` feature.
                (cargo) =>
                    `[package.metadata.decoy]\nvalue = """\n# """\n\n${cargo}\n[target.'cfg(target_os = "linux")'.dependencies]\nort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // An escaped basic string decodes to the same value, so a scan that
                // cannot decode it must refuse rather than skip it.
                (cargo) =>
                    `${cargo}\n[features]\nbypass = ["ort/c\\u0075da"]\n`,
                /\[features\] table .* holds a string this qualifier cannot read/,
            ],
            [
                // Every key in a dependency entry is a suffix of some decoy Cargo
                // tolerates as an unused key. The opt-out must come from the real
                // key, or default features — accelerators included — enter the build.
                (cargo) =>
                    cargo.replace(
                        'ort = { version = "=2.0.0-rc.13", default-features = false,',
                        'ort = { version = "=2.0.0-rc.13", fakedefault-features = false,',
                    ),
                /ort .* must set default-features = false/,
            ],
            [
                // Same shape on the version pin, which a substring test also read
                // out of a decoy.
                (cargo) =>
                    cargo.replace(
                        'ort = { version = "=2.0.0-rc.13",',
                        'ort = { fakeversion = "=2.0.0-rc.13", version = "=2.0.0-rc.12",',
                    ),
                /pinned ort identity does not match/,
            ],
            [
                // A key inside an inline table is a TOML key, so it may be quoted.
                // Cargo reports the `cuda` feature from `"features"` exactly as it
                // does from the bare spelling, while a pattern over the bare key
                // missed both the presence test and the extraction.
                (cargo) =>
                    cargo.replace(
                        /^ort = \{ version = "=2\.0\.0-rc\.13", default-features = false,.*$/m,
                        'ort = { version = "=2.0.0-rc.13", default-features = false, "features" = ["load-dynamic", "cuda"] }',
                    ),
                /ort feature cuda .* is outside the qualified closure/,
            ],
            [
                // The literal-string spelling of the same key.
                (cargo) =>
                    cargo.replace(
                        /^ort = \{ version = "=2\.0\.0-rc\.13", default-features = false,.*$/m,
                        "ort = { version = \"=2.0.0-rc.13\", default-features = false, 'features' = [\"load-dynamic\", \"tensorrt\"] }",
                    ),
                /ort feature tensorrt .* is outside the qualified closure/,
            ],
            [
                // An escaped quoted key decodes to the same name and no pattern over
                // literal spellings can represent it, so the entry is refused rather
                // than examined with the key read as absent.
                (cargo) =>
                    cargo.replace(
                        /^ort = \{ version = "=2\.0\.0-rc\.13", default-features = false,.*$/m,
                        'ort = { version = "=2.0.0-rc.13", default-features = false, "featu\\u0072es" = ["cuda"] }',
                    ),
                /must be declared exactly once/,
            ],
            [
                // A quoted `package` conceals a rename the same way, so the renamed
                // declaration would be filed under its key and leave the base entry
                // as the only match.
                (cargo) =>
                    `${cargo}\n[target.'cfg(target_os = "linux")'.dependencies]\nort_cuda = { "package" = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // Same form with the whitespace TOML permits around the dots.
                (cargo) =>
                    `target . 'cfg(target_os = "linux")' . dependencies . ort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n${cargo}`,
                /must be declared exactly once/,
            ],
            [
                // `features.default` declares the feature table without a header, so
                // a header-only scan never reaches the forwarding.
                (cargo) => `features.default = ["ort/cuda"]\n${cargo}`,
                /dotted features assignment this qualifier cannot attribute/,
            ],
            [
                // A dotted assignment creates its own table, so this declares a
                // Linux `ort` dependency before the first header — where the section
                // is still empty and the key is unreadable to a text scan.
                (cargo) =>
                    `target.'cfg(target_os = "linux")'.dependencies.ort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n${cargo}`,
                /must be declared exactly once/,
            ],
            [
                // TOML permits whitespace around the dots in a table header, and it
                // is the same table either way. A raw suffix test classifies it as
                // something else and everything inside goes unexamined.
                (cargo) =>
                    `${cargo}\n[target . 'cfg(target_os = "linux")' . dependencies]\nort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // A header component is a TOML key, so `"dependencies"` names the
                // ordinary dependency table. Cargo reports the target entry's `cuda`
                // feature either way; classifying the section from the raw suffix
                // recorded the rename as an unrelated crate, leaving the safe base
                // entry as the only `ort` declaration.
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
                // Header eligibility was decided from bracket depth alone, so a line
                // inside a multi-line string read as a real header and closed the
                // dependency subtable early. Cargo keeps every key below it in the
                // entry — `features` included — so the forbidden capability was
                // simply absent from what the scan examined.
                (cargo) =>
                    `${cargo.replace(/^ort = .*$/m, "")}\n[dependencies.ort]\nversion = "=2.0.0-rc.13"\ndefault-features = false\npoison = """\n[package.metadata.decoy]\n"""\nfeatures = ["cuda"]\n`,
                /ort feature cuda .* is outside the qualified closure/,
            ],
            [
                // A multi-line string spans lines, so quote state cannot reset per
                // line: a bracket inside one would otherwise drive the shared depth
                // wrong for everything after it.
                (cargo) =>
                    `${cargo}\npoison = """\n]\n"""\n\n[target.'cfg(target_os = "linux")'.dependencies]\nort_cuda = { package = "ort", version = "=2.0.0-rc.13", features = ["cuda"] }\n`,
                /ort must be declared exactly once/,
            ],
            [
                // A bracket inside a quoted value is not structure. Counting it
                // leaves the depth permanently positive, so every later line is
                // read as nested content and a target-specific dependency after it
                // is never seen.
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
            /does not satisfy the certified linux-x64-gnu lane/,
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
                /does not satisfy the certified linux-x64-gnu lane/,
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
                /does not satisfy the certified linux-x64-gnu lane/,
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
            // The fixture records the floor exactly. These cases deliberately move
            // the host, so the exact-floor claim stops describing it; leaving it
            // set would fail on that claim rather than on the floor comparison
            // this case is about.
            manifest.oracle.host.exact_floor = false;
            installManifest(root, manifest);
            expect(() => generate(root, { check: false })).not.toThrow();
        }
    });

    test("an oracle transcript cannot outlive the bytes it names", () => {
        // The scenario the binding exists for: artifacts are requalified with new
        // digests and the oracle object is retained. A recorded pass then covers
        // bytes that are no longer in the lock.
        const root = freshRoot();
        installProductionManifest(root, (manifest) => {
            manifest.inputs.model_onnx.sha256 = createHash("sha256")
                .update("requalified model bytes")
                .digest("hex");
        });
        // `installProductionManifest` rebinds, so undo that to model the stale case.
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
        // The certified Linux lane executes the sealed ORT object through
        // /proc/self/fd. An oracle that loaded it some other way did not exercise
        // the production path, so its evidence cannot stand in for one that did.
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
        // Every other oracle field describes how the run was configured. A run
        // that failed, or never happened, produces the same parameters, so
        // presence must not read as success.
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
        // The oracle binds itself to the artifact digests, so the check needs the
        // input table it is being validated against.
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
    test("committed qualification remains blocked on the exact kernel floor", () => {
        expect(() => requireQualificationEvidence(repoRoot)).toThrow(
            /not production-qualified/,
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
        useProductionProvenance(manifest);
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

describe("release prerequisite (CLI)", () => {
    test("the consumption gate is reachable outside the tests", () => {
        // `--check` reports drift and exits 0 over unqualified inputs on purpose, so
        // without a separate entry point nothing in the repo would reject an
        // unqualified release. `--require-qualified` is that entry point: it runs the
        // same gate a production build runs, ready for a release job to invoke.
        const script = join(
            repoRoot,
            "scripts/qualify-mc-host-production-inputs.ts",
        );
        // No `--verify-bytes`, so the gate regenerates in check mode and reads no
        // artifact: it must reach the verdict rather than stop on the runtime binding,
        // which only governs runs that will actually hash bytes.
        const required = spawnSync("bun", [script, "--require-qualified"], {
            cwd: repoRoot,
            encoding: "utf8",
        });
        expect(required.status).toBe(1);
        expect(required.stderr).toContain("not production-qualified");

        // The drift check over the same tree stays green, which is what keeps CI
        // usable while the real production bytes are still unqualified.
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
        // Checked as a predicate over an explicit value, not against whatever Bun
        // happens to run the suite: an assertion about the host belongs at the CLI
        // boundary, and putting it inside `generate` made every production-mode test
        // and CI's portable drift check depend on the runner's version.
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
        // The manifest scans bound what `crates/mc-host/Cargo.toml` declares. They
        // cannot bound what Cargo *selects*: features are unified per package across
        // the whole normal dependency graph, so any node — another workspace member,
        // a path dependency, or a registry crate whose manifest is not in this
        // repository — can turn on an accelerator on the same ORT node while the leaf
        // manifest still reads as CPU-only. Only the resolver knows, which is why
        // this assertion lives here rather than in the portable drift check: it needs
        // a resolvable workspace and a toolchain, exactly as the `cargo tree`
        // dependency-boundary test does.
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
            // Ids are `<source>#<name>@<version>`, or `<source>#<version>` when the
            // path segment already names the package.
            const tail = node.id.split("#").pop() ?? "";
            const name = tail.includes("@") ? tail.split("@")[0] : tail;
            if (name !== undefined) resolved.set(name, node.features);
        }
        // Not "no forbidden feature appears" alone: the published closure is an exact
        // claim, so anything the resolver adds to it — forbidden or merely undeclared
        // — contradicts the lock and has to fail.
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
        // `ort-sys` is the crate that would link or download a runtime, so the
        // opt-out the lock publishes has to be active in the resolved set too.
        for (const feature of RUNTIME_IDENTITY.rust_crates.ort_sys_features) {
            expect(resolved.get("ort-sys")).toContain(feature);
        }
        // The default per-test timeout is not a meaningful bound for this one:
        // `cargo metadata` is the first toolchain invocation in its CI job, so on
        // a cold runner it has to populate the registry index before it can
        // resolve, which routinely outruns a few seconds. Being killed mid-fetch
        // surfaces as `status: null` rather than a resolver disagreement, which
        // reads as a contract failure this test never actually observed.
    }, 120_000);
});
