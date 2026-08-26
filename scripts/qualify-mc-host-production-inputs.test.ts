import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildContract } from "./generate-mc-host-release-manifest";
import {
    assertPinsMatchContract,
    buildCredentialsDoc,
    canonicalClosureManifest,
    canonicalCredentialRowEncoding,
    checkOracleEvidence,
    closureManifestDigest,
    evaluateBrocaRun,
    generate,
    type HarnessClosureManifest,
    OUTPUT_PATHS,
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
const FIXTURE_MANIFEST = join(
    repoRoot,
    FIXTURE_DIR,
    "source-manifest.test-fixture.json",
);
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

function installProductionManifest(root: string): void {
    const manifest = fixtureManifest();
    manifest.mode = "production";
    for (const artifact of Object.values(manifest.inputs) as {
        license: { approved_by: string };
    }[]) {
        artifact.license.approved_by = "mc-host U9 SPDX allowlist";
    }
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
    for (const artifact of Object.values(manifest.inputs) as {
        verify_local_path: string;
    }[]) {
        artifact.verify_local_path = join(root, artifact.verify_local_path);
    }
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

    test("placeholder hashes are rejected", () => {
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.inputs.ort_runtime.sha256 = "0".repeat(64);
        installManifest(root, manifest);
        expect(() => generate(root, { check: false })).toThrow(
            /placeholder hash/,
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
        mkdirSync(join(rootB, dirname(TINY_MANIFEST)), { recursive: true });
        cpSync(join(repoRoot, TINY_MANIFEST), join(rootB, TINY_MANIFEST));
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

    test("production mode requires absolute verify paths and bun.lock pins", () => {
        const root = freshRoot();
        const manifest = fixtureManifest();
        manifest.mode = "production";
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
        expect(() =>
            generate(root, { check: true, verifyExternalBytes: true }),
        ).toThrow(/missing/);
        expect(() => generate(root, { check: false })).toThrow(/missing/);
    });
});

describe("oracle evidence hook", () => {
    test("recorded oracle evidence qualifies; absence fails closed", () => {
        const qualified = freshRoot();
        installProductionManifest(qualified);
        const withOracle = generate(qualified, { check: false });
        expect(withOracle.productionQualified).toBe(true);

        const absent = freshRoot();
        const manifest = fixtureManifest();
        manifest.mode = "production";
        for (const artifact of Object.values(manifest.inputs) as {
            verify_local_path: string;
            license: { approved_by: string };
        }[]) {
            artifact.license.approved_by = "mc-host U9 SPDX allowlist";
            artifact.verify_local_path = join(
                absent,
                artifact.verify_local_path,
            );
        }
        manifest.oracle = null;
        installManifest(absent, manifest);
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

    test("mismatched oracle evidence is rejected", () => {
        const contract = buildContract();
        const manifest = fixtureManifest();
        const base = manifest.oracle;
        const report = JSON.parse(
            readFileSync(
                join(repoRoot, FIXTURE_DIR, "artifacts/synapse-smoke-report.json"),
                "utf8",
            ),
        );
        const cases: [(o: typeof base) => void, RegExp][] = [
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
            expect(() =>
                checkOracleEvidence(oracle, contract, report, manifest.inputs),
            ).toThrow(error);
        }
        expect(() =>
            checkOracleEvidence(base, contract, report, manifest.inputs),
        ).not.toThrow();
        const forged = structuredClone(report);
        forged.model_fingerprint = "e".repeat(64);
        expect(() =>
            checkOracleEvidence(base, contract, forged, manifest.inputs),
        ).toThrow(/smoke report identity/);
        const wrongInput = structuredClone(report);
        wrongInput.inputs.model_onnx = "e".repeat(64);
        expect(() =>
            checkOracleEvidence(base, contract, wrongInput, manifest.inputs),
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
});
