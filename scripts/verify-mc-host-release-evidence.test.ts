import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContract, canonicalJson, sha256Hex } from "./generate-mc-host-release-manifest";
import {
    attestationMatchesWorkflowSource,
    buildInstalledReleaseEvidence,
    QUALIFICATION_WORKFLOW_PATH,
    schemaReferenceEvidence,
    validateInstalledReleaseEvidence,
    validateInstalledReleaseEvidenceAgainstArtifacts,
    workflowRunApiPath,
    workflowRunAttemptMatchesSource,
} from "./verify-mc-host-release-evidence";

function matchingAttestation(
    overrides: Record<string, unknown> = {},
): Record<string, unknown>[] {
    const { artifactSha256 = "0".repeat(64), ...certificateOverrides } = overrides;
    return [
        {
            verificationResult: {
                signature: {
                    certificate: {
                        sourceRepositoryURI: "https://github.com/ahrav/magic-context",
                        sourceRepositoryDigest: "a".repeat(40),
                        buildConfigURI:
                            "https://github.com/ahrav/magic-context/.github/workflows/mc-host-release-qualification.yml@refs/heads/main",
                        runInvocationURI:
                            "https://github.com/ahrav/magic-context/actions/runs/123456/attempts/1",
                        ...certificateOverrides,
                    },
                },
                statement: {
                    subject: [{ digest: { sha256: artifactSha256 } }],
                },
            },
        },
    ];
}

/** Stubs that satisfy every attested-chain gate, so a test isolates one break. */
function fullStubs() {
    return {
        requireQualification: () => stubQualification(),
        verifyAttestation: (_path: string, proof: { sha256: string }) =>
            matchingAttestation({ artifactSha256: proof.sha256 }),
        verifyWorkflowRun: () => true,
        verifyInstalledEvidenceAttestation: (
            _path: string,
            _source: unknown,
            sha256: string,
        ) => matchingAttestation({ artifactSha256: sha256 }),
        expectedHeadSha: "a".repeat(40),
    };
}

/* */
function rewriteProof(
    root: string,
    evidence: Record<string, unknown>,
    proofPath: string,
    mutate: (report: Record<string, unknown>) => void,
): void {
    const report = JSON.parse(readFileSync(join(root, proofPath), "utf8")) as Record<
        string,
        unknown
    >;
    mutate(report);
    const bytes = `${canonicalJson(report)}\n`;
    writeFileSync(join(root, proofPath), bytes);
    const ref = (evidence.proof_artifacts as { path: string; sha256: string }[]).find(
        (proof) => proof.path === proofPath,
    );
    if (ref === undefined) throw new Error(`missing proof ref for ${proofPath}`);
    ref.sha256 = sha256Hex(bytes);
}

function qualifiedEvidence(): Record<string, unknown> {
    const contract = buildContract();
    const proofIdentities = [
        ...contract.packages.payloads.map((subject) => ["registry_package", subject] as const),
        ...contract.packages.parents.map((subject) => ["registry_package", subject] as const),
        ...contract.platforms.supported.map((entry) => ["target", entry.target] as const),
        ...contract.packages.parents.map((subject) => ["product_flow", subject] as const),
        ["publication", contract.release.id] as const,
        ["production_synapse", "linux-x64-gnu"] as const,
    ];
    return buildInstalledReleaseEvidence({
        contract,
        productionInputsSha256: "1".repeat(64),
        qualificationSha256: "2".repeat(64),
        payloadIndexSha256: "3".repeat(64),
        stopProvenanceSha256: "4".repeat(64),
        registryPackages: [
            ...contract.packages.payloads,
            ...contract.packages.parents,
        ].map((name) => ({
            name,
            version: contract.packages.version,
            integrity: `sha512-${Buffer.from(name).toString("base64")}`,
            provenance_verified: true,
        })),
        targets: contract.platforms.supported.map((platform) => ({
            target: platform.target,
            filesystem_verified: true,
            self_fd_verified: true,
            process_crash_atomicity_verified: true,
            lifecycle_smoke_passed: true,
            test_report_sha256: sha256Hex(`test report ${platform.target}`),
        })),
        productFlows: contract.packages.parents.map((name) => ({
            package: name,
            cli_commands_passed: name === "@cortexkit/magic-context",
            managed_demand_passed: true,
            offline_verified: true,
        })),
        oidcProvenanceVerified: true,
        longLivedTokenUsed: false,
        productionSynapseVerified: true,
        productionSynapseReportSha256: sha256Hex("production synapse report"),
        proofArtifacts: proofIdentities.map(([kind, subject], index) => ({
            kind,
            subject,
            path: `tmp/mc-host-release-proofs/${index}.json`,
            sha256: "0".repeat(64),
        })),
        qualified: true,
        blockers: [],
    }) as unknown as Record<string, unknown>;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "release/mc-host-production-inputs.lock.json";
const INDEX_PATH = "release/mc-host-payload-index.json";

/**
 *
 */
function stubQualification(): { u8Digest: string; lockSha256: string } {
    return {
        u8Digest: sha256Hex(canonicalJson(buildContract())),
        lockSha256: sha256Hex(readFileSync(join(repoRoot, LOCK_PATH), "utf8")),
    };
}

/**
 *
 *
 */
function citedArtifactBytes(field: string): string {
    const contract = buildContract();
    const contractDigest = sha256Hex(canonicalJson(contract));
    if (field === "production_inputs_sha256") {
        return readFileSync(join(repoRoot, LOCK_PATH), "utf8");
    }
    if (field === "payload_index_sha256") {
        const index = JSON.parse(
            readFileSync(join(repoRoot, INDEX_PATH), "utf8"),
        ) as {
            production_qualified: boolean;
            entries: Record<string, unknown>[];
        };
        index.production_qualified = true;
        index.entries = index.entries.map((entry, position) => {
            const { unqualified_reason: _dropped, ...rest } = entry;
            return {
                ...rest,
                qualified: true,
                payload_manifest_digest: sha256Hex(`payload manifest ${position}`),
                bootstrap_launcher_digest: sha256Hex(`bootstrap launcher ${position}`),
            };
        });
        return `${canonicalJson(index)}\n`;
    }
    if (field === "qualification_sha256") {
        return `${canonicalJson({
            schema: "magic-context.mc-host-release-qualification/v1",
            release_contract_sha256: contractDigest,
            production_qualified: true,
            unqualified: [],
        })}\n`;
    }
    if (field === "stop_provenance_sha256") {
        const genesis: Record<string, unknown> = {};
        for (const key of contract.stop_provenance_schema.genesis
            .required_fields) {
            genesis[key] =
                key === contract.stop_provenance_schema.tag_field
                    ? "genesis"
                    : contract.release.version;
        }
        return `${canonicalJson(genesis)}\n`;
    }
    return `${field} bytes`;
}

/**
 * The staged registry gate supplies reservation versions to the GA gate.
 *
 */
function installRegistryGate(root: string): void {
    const contract = buildContract();
    const relative = "release/mc-host-registry-gate.json";
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(
        join(root, relative),
        `${canonicalJson({
            schema: "magic-context.mc-host-registry-gate/v1",
            release_version: contract.release.version,
            packages: [
                ...contract.packages.payloads.map((name) => ({
                    name,
                    kind: "payload",
                    reservation_version: "0.0.1-reserved.0",
                })),
                ...contract.packages.parents.map((name) => ({
                    name,
                    kind: "parent",
                })),
            ],
        })}\n`,
    );
}

function installProofArtifacts(
    root: string,
    evidence: Record<string, unknown>,
): void {
    const release = evidence.release as { version: string };
    const proofs = evidence.proof_artifacts as {
        kind: string;
        subject: string;
        path: string;
        sha256: string;
    }[];
    const registry = evidence.registry_packages as {
        name: string;
        integrity: string;
        provenance_verified: boolean;
    }[];
    const targets = evidence.targets as {
        target: string;
        filesystem_verified: boolean;
        self_fd_verified: boolean;
        process_crash_atomicity_verified: boolean;
        lifecycle_smoke_passed: boolean;
        test_report_sha256: string | null;
    }[];
    const flows = evidence.product_flows as {
        package: string;
        cli_commands_passed: boolean;
        managed_demand_passed: boolean;
        offline_verified: boolean;
    }[];
    const publication = evidence.publication as Record<string, boolean>;
    for (const proof of proofs) {
        const packageEvidence = registry.find((entry) => entry.name === proof.subject);
        const targetEvidence = targets.find((entry) => entry.target === proof.subject);
        const flowEvidence = flows.find((entry) => entry.package === proof.subject);
        const testReportPath = `tmp/mc-host-test-reports/${proof.subject.replaceAll("/", "_")}.json`;
        const testReportBytes = `${canonicalJson({
            schema: "magic-context.mc-host-test-report/v1",
            target: proof.subject,
            passed: true,
        })}\n`;
        if (proof.kind === "target") {
            mkdirSync(dirname(join(root, testReportPath)), { recursive: true });
            writeFileSync(join(root, testReportPath), testReportBytes);
            if (targetEvidence !== undefined) {
                targetEvidence.test_report_sha256 = sha256Hex(testReportBytes);
            }
        }
        const observations =
            proof.kind === "registry_package"
                ? {
                      integrity: packageEvidence?.integrity,
                      provenance_verified: packageEvidence?.provenance_verified,
                  }
                : proof.kind === "target"
                  ? {
                        filesystem_verified: targetEvidence?.filesystem_verified,
                        lifecycle_commands: [
                            "doctor",
                            "restart",
                            "start",
                            "status",
                            "stop",
                        ],
                        lifecycle_smoke_passed: targetEvidence?.lifecycle_smoke_passed,
                        package_integrity: registry.find((entry) =>
                            entry.name.endsWith(proof.subject),
                        )?.integrity,
                        process_crash_atomicity_verified:
                            targetEvidence?.process_crash_atomicity_verified,
                        runner_arch: proof.subject.endsWith("arm64")
                            ? "arm64"
                            : "x64",
                        runner_os: proof.subject.startsWith("darwin")
                            ? "darwin"
                            : "linux",
                        self_fd_verified: targetEvidence?.self_fd_verified,
                        target: proof.subject,
                        test_report_path: testReportPath,
                        test_report_sha256: sha256Hex(testReportBytes),
                    }
                  : proof.kind === "product_flow"
                    ? {
                          cli_commands_passed: flowEvidence?.cli_commands_passed,
                          managed_demand_passed: flowEvidence?.managed_demand_passed,
                          package_integrity: registry.find(
                              (entry) => entry.name === proof.subject,
                          )?.integrity,
                          offline_verified: flowEvidence?.offline_verified,
                      }
                      : proof.kind === "publication"
                      ? publication
                      : {
                            package_integrity: registry.find((entry) =>
                                entry.name.endsWith("linux-x64-gnu"),
                            )?.integrity,
                            production_synapse_report_sha256:
                                evidence.production_synapse_report_sha256,
                            production_synapse_verified:
                                evidence.production_synapse_verified,
                        };
        const report = {
            schema: "magic-context.mc-host-release-proof/v1",
            kind: proof.kind,
            subject: proof.subject,
            release_version: release.version,
            passed: true,
            source: {
                run_url: "https://github.com/ahrav/magic-context/actions/runs/123456",
                repository: "ahrav/magic-context",
                head_sha: "a".repeat(40),
                workflow: ".github/workflows/mc-host-release-qualification.yml",
            },
            observations,
        };
        const bytes = `${canonicalJson(report)}\n`;
        mkdirSync(dirname(join(root, proof.path)), { recursive: true });
        writeFileSync(join(root, proof.path), bytes);
        proof.sha256 = sha256Hex(bytes);
    }
    mkdirSync(dirname(join(root, "tmp/mc-host-installed-release-evidence.json")), {
        recursive: true,
    });
    writeFileSync(
        join(root, "tmp/mc-host-installed-release-evidence.json"),
        `${canonicalJson(evidence)}\n`,
    );
}

const RELEASE_ARTIFACTS = {
    production_inputs_sha256: "release/mc-host-production-inputs.lock.json",
    qualification_sha256: "tmp/mc-host-release-qualification.json",
    payload_index_sha256: "release/mc-host-payload-index.json",
    stop_provenance_sha256: "release/mc-host-n-minus-one-stop.json",
} as const;

function installReleaseArtifacts(
    root: string,
    evidence: Record<string, unknown>,
): void {
    for (const [field, relative] of Object.entries(RELEASE_ARTIFACTS)) {
        const bytes = citedArtifactBytes(field);
        mkdirSync(dirname(join(root, relative)), { recursive: true });
        writeFileSync(join(root, relative), bytes);
        evidence[field] = sha256Hex(bytes);
    }
    installRegistryGate(root);
    const workflowPath = join(root, QUALIFICATION_WORKFLOW_PATH);
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, "name: qualification stub\n");
}

/** The staged verifier needs imported sibling modules to resolve relative imports. */
const VERIFIER_MODULES = [
    "verify-mc-host-release-evidence",
    "build-mc-host-payload",
    "generate-mc-host-release-manifest",
    "qualify-mc-host-production-inputs",
] as const;

/**
 * The verifier copy's root contains no release artifacts.
 *
 * `node_modules` is linked in because one sibling module imports `typescript`.
 */
function isolatedVerifier(): string {
    const root = mkdtempSync(join(tmpdir(), "mc-host-evidence-clean-"));
    mkdirSync(join(root, "scripts"));
    for (const name of VERIFIER_MODULES) {
        copyFileSync(
            join(repoRoot, "scripts", `${name}.ts`),
            join(root, "scripts", `${name}.ts`),
        );
    }
    symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
    return join(root, "scripts", "verify-mc-host-release-evidence.ts");
}

function runVerifier(script: string, flag: string): { status: number; output: string } {
    const result = spawnSync("bun", [script, flag], { encoding: "utf8" });
    return {
        status: result.status ?? 1,
        output: `${result.stdout}${result.stderr}`,
    };
}

describe("installed release evidence", () => {
    test("a complete installed non-GA release passes the GA gate", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, fullStubs()),
        ).not.toThrow();
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                ...fullStubs(),
                verifyAttestation: () => null,
            }),
        ).toThrow(/lacks a valid attestation/);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                requireQualification: () => stubQualification(),
                verifyAttestation: (_path, proof) =>
                    matchingAttestation({
                        artifactSha256: proof.sha256,
                    }),
                verifyWorkflowRun: () => false,
                verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                    matchingAttestation({ artifactSha256: sha256 }),
                expectedHeadSha: "a".repeat(40),
            }),
        ).toThrow(/workflow run is unverified/);
        const proofs = evidence.proof_artifacts as {
            subject: string;
        }[];
        const lastSubject = proofs.at(-1)?.subject;
        const checked: string[] = [];
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                requireQualification: () => stubQualification(),
                verifyAttestation: (_path, proof) => {
                    checked.push(proof.subject);
                    return proof.subject !== lastSubject
                        ? matchingAttestation({ artifactSha256: proof.sha256 })
                        : null;
                },
                verifyWorkflowRun: () => true,
                verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                    matchingAttestation({ artifactSha256: sha256 }),
                expectedHeadSha: "a".repeat(40),
            }),
        ).toThrow(/lacks a valid attestation/);
        expect(checked.at(-1)).toBe(lastSubject);
        expect(() => validateInstalledReleaseEvidence(evidence)).not.toThrow();
    });

    test("attestation certificate is bound to the claimed workflow run and commit", () => {
        const source = {
            runUrl: "https://github.com/ahrav/magic-context/actions/runs/123456",
            repository: "ahrav/magic-context",
            headSha: "a".repeat(40),
            workflow: ".github/workflows/mc-host-release-qualification.yml",
        };
        expect(
            attestationMatchesWorkflowSource(matchingAttestation(), source, "0".repeat(64)),
        ).toBe(true);
        expect(
            attestationMatchesWorkflowSource(
                matchingAttestation({ sourceRepositoryDigest: "b".repeat(40) }),
                source,
                "0".repeat(64),
            ),
        ).toBe(false);
        expect(
            attestationMatchesWorkflowSource(
                matchingAttestation({
                    runInvocationURI:
                        "https://github.com/ahrav/magic-context/actions/runs/654321/attempts/1",
                }),
                source,
                "0".repeat(64),
            ),
        ).toBe(false);
        expect(
            attestationMatchesWorkflowSource(
                matchingAttestation({
                    buildConfigURI:
                        "https://github.com/ahrav/magic-context/.github/workflows/untrusted.yml@refs/heads/main",
                }),
                source,
                "0".repeat(64),
            ),
        ).toBe(false);
        expect(
            attestationMatchesWorkflowSource(
                matchingAttestation({ artifactSha256: "b".repeat(64) }),
                source,
                "0".repeat(64),
            ),
        ).toBe(false);
        expect(workflowRunApiPath(source)).toBe(
            "repos/ahrav/magic-context/actions/runs/123456",
        );
    });

    test("run urls and invocation uris are anchored to the expected repository", () => {
        const source = {
            runUrl: "https://github.com/ahrav/magic-context/actions/runs/123456",
            repository: "ahrav/magic-context",
            headSha: "a".repeat(40),
            workflow: ".github/workflows/mc-host-release-qualification.yml",
        };
        expect(
            workflowRunApiPath({
                ...source,
                runUrl: "https://github.com/evil/fork/actions/runs/123456",
            }),
        ).toBeNull();
        expect(
            workflowRunApiPath({
                ...source,
                runUrl: "https://evil.example.com/ahrav/magic-context/actions/runs/123456",
            }),
        ).toBeNull();
        // The certificate binds the attempt; `run_url` does not.
        expect(
            workflowRunApiPath({
                ...source,
                runUrl: "https://github.com/ahrav/magic-context/actions/runs/123456/attempts/1",
            }),
        ).toBeNull();
        // A matching trailing /attempts/<n> under a foreign repository is not a binding.
        expect(
            attestationMatchesWorkflowSource(
                matchingAttestation({
                    runInvocationURI:
                        "https://github.com/evil/fork/actions/runs/123456/attempts/1",
                }),
                source,
                "0".repeat(64),
            ),
        ).toBe(false);
    });

    test("schema-only validation accepts proofs from another release commit", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        // `--check-schema` validates shape, not GA qualification.
        // The GA gate binds proofs to the checked-out commit.
        // Schema-only runs at other commits do not require proof binding to the checked-out commit.
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, false, {
                requireQualification: () => stubQualification(),
                verifyAttestation: (_path, proof) =>
                    matchingAttestation({ artifactSha256: proof.sha256 }),
                verifyWorkflowRun: () => true,
                verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                    matchingAttestation({ artifactSha256: sha256 }),
                expectedHeadSha: "b".repeat(40),
            }),
        ).not.toThrow();
    });

    test("qualified evidence is bound to the release checkout commit", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                requireQualification: () => stubQualification(),
                verifyAttestation: (_path, proof) =>
                    matchingAttestation({ artifactSha256: proof.sha256 }),
                verifyWorkflowRun: () => true,
                verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                    matchingAttestation({ artifactSha256: sha256 }),
                expectedHeadSha: "b".repeat(40),
            }),
        ).toThrow(/current release commit|immutable workflow run/);
    });

    test.each([
        ["repository", "evil/fork"],
        ["workflow", ".github/workflows/untrusted.yml"],
    ])("qualified proofs cannot select their %s", (field, value) => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        const proof = (evidence.proof_artifacts as { path: string }[])[0];
        if (proof === undefined) throw new Error("missing proof artifact");
        rewriteProof(root, evidence, proof.path, (report) => {
            (report.source as Record<string, unknown>)[field] = value;
        });

        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, fullStubs()),
        ).toThrow(/no immutable workflow run/);
    });

    test("target proof requires the referenced test report bytes", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        const targetProof = (evidence.proof_artifacts as { kind: string; path: string }[]).find(
            (proof) => proof.kind === "target",
        );
        if (targetProof === undefined) throw new Error("missing target proof");
        const report = JSON.parse(
            readFileSync(join(root, targetProof.path), "utf8"),
        ) as Record<string, unknown>;
        const observations = report.observations as Record<string, unknown>;
        writeFileSync(join(root, observations.test_report_path as string), "mutated report");
        const bytes = `${canonicalJson(report)}\n`;
        writeFileSync(join(root, targetProof.path), bytes);
        const proofRef = (
            evidence.proof_artifacts as { path: string; sha256: string }[]
        ).find((proof) => proof.path === targetProof.path);
        if (proofRef === undefined) throw new Error("missing target proof ref");
        proofRef.sha256 = sha256Hex(bytes);

        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                requireQualification: () => stubQualification(),
                verifyAttestation: (_path, proof) =>
                    matchingAttestation({ artifactSha256: proof.sha256 }),
                verifyWorkflowRun: () => true,
                verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                    matchingAttestation({ artifactSha256: sha256 }),
                expectedHeadSha: "a".repeat(40),
            }),
        ).toThrow(/test report digest does not match/);
    });

    test("a target proof cannot opt out of its test report with a null citation", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        const targetProof = (evidence.proof_artifacts as { kind: string; path: string }[]).find(
            (proof) => proof.kind === "target",
        );
        if (targetProof === undefined) throw new Error("missing target proof");
        rewriteProof(root, evidence, targetProof.path, (report) => {
            const observations = report.observations as Record<string, unknown>;
            observations.test_report_path = null;
            observations.test_report_sha256 = null;
        });

        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, fullStubs()),
        ).toThrow(/must cite a test report under tmp\/mc-host-test-reports\//);
    });

    test("a target proof cannot cite an unrelated file as its test report", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        const targetProof = (evidence.proof_artifacts as { kind: string; path: string }[]).find(
            (proof) => proof.kind === "target",
        );
        if (targetProof === undefined) throw new Error("missing target proof");
        rewriteProof(root, evidence, targetProof.path, (report) => {
            const observations = report.observations as Record<string, unknown>;
            observations.test_report_path = "release/mc-host-payload-index.json";
            observations.test_report_sha256 = sha256Hex(
                readFileSync(join(root, "release/mc-host-payload-index.json"), "utf8"),
            );
        });

        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, fullStubs()),
        ).toThrow(/must cite a test report under tmp\/mc-host-test-reports\//);
    });

    for (const mutation of ["failed", "wrong-schema", "wrong-target"] as const) {
        test(`a test report must attest a passing run for its target (${mutation})`, () => {
            const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
            const evidence = qualifiedEvidence();
            installReleaseArtifacts(root, evidence);
            installProofArtifacts(root, evidence);
            const targetProof = (
                evidence.proof_artifacts as { kind: string; path: string; subject: string }[]
            ).find((proof) => proof.kind === "target");
            if (targetProof === undefined) throw new Error("missing target proof");
            const report = JSON.parse(
                readFileSync(join(root, targetProof.path), "utf8"),
            ) as Record<string, unknown>;
            const reportPath = (report.observations as Record<string, unknown>)
                .test_report_path as string;
            const forged = `${canonicalJson({
                schema:
                    mutation === "wrong-schema"
                        ? "magic-context.mc-host-test-report/v0"
                        : "magic-context.mc-host-test-report/v1",
                target: mutation === "wrong-target" ? "some-other-target" : targetProof.subject,
                passed: mutation !== "failed",
            })}\n`;
            writeFileSync(join(root, reportPath), forged);
            rewriteProof(root, evidence, targetProof.path, (current) => {
                const observations = current.observations as Record<string, unknown>;
                observations.test_report_sha256 = sha256Hex(forged);
            });

            expect(() =>
                validateInstalledReleaseEvidenceAgainstArtifacts(
                    root,
                    evidence,
                    true,
                    fullStubs(),
                ),
            ).toThrow(/test report does not attest a passing/);
        });
    }

    test("one test report cannot satisfy two targets", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        const targetProofs = (evidence.proof_artifacts as { kind: string; path: string }[]).filter(
            (proof) => proof.kind === "target",
        );
        expect(targetProofs.length).toBeGreaterThan(1);
        const first = JSON.parse(
            readFileSync(join(root, targetProofs[0].path), "utf8"),
        ) as Record<string, unknown>;
        const shared = (first.observations as Record<string, unknown>)
            .test_report_path as string;
        rewriteProof(root, evidence, targetProofs[1].path, (report) => {
            const observations = report.observations as Record<string, unknown>;
            observations.test_report_path = shared;
            observations.test_report_sha256 = sha256Hex(readFileSync(join(root, shared), "utf8"));
        });

        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, fullStubs()),
        ).toThrow(/reuses the test report already cited by/);
    });

    test("a declined attestation stub is rejected without consulting gh", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        let calls = 0;
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                ...fullStubs(),
                verifyAttestation: () => {
                    calls += 1;
                    return null;
                },
            }),
        ).toThrow(/lacks a valid attestation/);
        expect(calls).toBe(1);
    });

    test("an attestation from another run attempt cannot gate GA", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        let seen = 0;
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                ...fullStubs(),
                verifyAttestation: (_path, proof) => {
                    seen += 1;
                    return matchingAttestation({
                        artifactSha256: proof.sha256,
                        runInvocationURI: `https://github.com/ahrav/magic-context/actions/runs/123456/attempts/${seen}`,
                    });
                },
            }),
        ).toThrow(/must share one workflow run attempt/);
    });

    test("a re-run qualifies on the successful attempt whatever the attestation order", () => {
        // Attestation-array order must not determine qualification.
        // Attestation-array order must not determine qualification.
        const attemptEntry = (sha256: string, attempt: string) =>
            matchingAttestation({
                artifactSha256: sha256,
                runInvocationURI: `https://github.com/ahrav/magic-context/actions/runs/123456/attempts/${attempt}`,
            })[0];
        for (const order of [
            ["1", "2"],
            ["2", "1"],
        ]) {
            const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
            const evidence = qualifiedEvidence();
            installReleaseArtifacts(root, evidence);
            installProofArtifacts(root, evidence);
            const runChecks: string[] = [];
            expect(() =>
                validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                    requireQualification: () => stubQualification(),
                    verifyAttestation: (_path, proof) =>
                        order.map((attempt) => attemptEntry(proof.sha256, attempt)),
                    verifyWorkflowRun: (_source, attempt) => {
                        runChecks.push(attempt);
                        return attempt === "2";
                    },
                    verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                        order.map((attempt) => attemptEntry(sha256, attempt)),
                    expectedHeadSha: "a".repeat(40),
                }),
            ).not.toThrow();
            // Attempt 1 is rejected; attempt 2 qualifies the release.
            expect(runChecks).toEqual(["1", "2"]);
        }
    });

    test("a run attempt matches whether or not its path carries a ref suffix", () => {
        const source = {
            runUrl: "https://github.com/ahrav/magic-context/actions/runs/123456",
            repository: "ahrav/magic-context",
            headSha: "a".repeat(40),
            workflow: ".github/workflows/mc-host-release-qualification.yml",
        };
        const observed = (path: string, overrides: Record<string, unknown> = {}) => ({
            head_sha: "a".repeat(40),
            path,
            run_attempt: 2,
            ...overrides,
        });
        expect(
            workflowRunAttemptMatchesSource(observed(source.workflow), source, "2"),
        ).toBe(true);
        expect(
            workflowRunAttemptMatchesSource(
                observed(`${source.workflow}@refs/heads/main`),
                source,
                "2",
            ),
        ).toBe(true);
        expect(
            workflowRunAttemptMatchesSource(observed(`${source.workflow}@main`), source, "2"),
        ).toBe(true);
        // Verification drops the malformed ref, not the claim.
        expect(
            workflowRunAttemptMatchesSource(
                observed(".github/workflows/untrusted.yml@main"),
                source,
                "2",
            ),
        ).toBe(false);
        expect(
            workflowRunAttemptMatchesSource(
                observed(source.workflow, { head_sha: "b".repeat(40) }),
                source,
                "2",
            ),
        ).toBe(false);
        expect(
            workflowRunAttemptMatchesSource(observed(source.workflow), source, "1"),
        ).toBe(false);
    });

    test("an attestation without a run attempt is not a binding", () => {
        const source = {
            runUrl: "https://github.com/ahrav/magic-context/actions/runs/123456",
            repository: "ahrav/magic-context",
            headSha: "a".repeat(40),
            workflow: ".github/workflows/mc-host-release-qualification.yml",
        };
        expect(
            attestationMatchesWorkflowSource(
                matchingAttestation({
                    runInvocationURI:
                        "https://github.com/ahrav/magic-context/actions/runs/123456",
                }),
                source,
                "0".repeat(64),
            ),
        ).toBe(false);
    });

    test("the workflow run is verified once for one shared attempt", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        let runChecks = 0;
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                ...fullStubs(),
                verifyWorkflowRun: () => {
                    runChecks += 1;
                    return true;
                },
            }),
        ).not.toThrow();
        expect((evidence.proof_artifacts as unknown[]).length).toBeGreaterThan(1);
        expect(runChecks).toBe(1);
    });

    test("an unqualified repository artifact is valid evidence but cannot gate GA", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        evidence.qualified = false;
        evidence.blockers = ["production target smoke has not run"];
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        expect(() => validateInstalledReleaseEvidence(evidence)).not.toThrow();
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                requireQualification: () => stubQualification(),
                verifyAttestation: (_path, proof) =>
                    matchingAttestation({ artifactSha256: proof.sha256 }),
                verifyWorkflowRun: () => true,
                verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                    matchingAttestation({ artifactSha256: sha256 }),
                expectedHeadSha: "a".repeat(40),
            }),
        ).toThrow(/not qualified/);
    });

    test.each([
        [
            "target filesystem",
            (evidence: Record<string, unknown>) => {
                const targets = evidence.targets as Record<string, unknown>[];
                targets[0].filesystem_verified = false;
            },
        ],
        [
            "registry provenance",
            (evidence: Record<string, unknown>) => {
                const packages = evidence.registry_packages as Record<string, unknown>[];
                packages[0].provenance_verified = false;
            },
        ],
        [
            "target self-fd execution",
            (evidence: Record<string, unknown>) => {
                const targets = evidence.targets as Record<string, unknown>[];
                targets[0].self_fd_verified = false;
            },
        ],
        [
            "target process-crash atomicity",
            (evidence: Record<string, unknown>) => {
                const targets = evidence.targets as Record<string, unknown>[];
                targets[0].process_crash_atomicity_verified = false;
            },
        ],
        [
            "target lifecycle smoke",
            (evidence: Record<string, unknown>) => {
                const targets = evidence.targets as Record<string, unknown>[];
                targets[0].lifecycle_smoke_passed = false;
            },
        ],
        [
            "CLI product flow",
            (evidence: Record<string, unknown>) => {
                const flows = evidence.product_flows as Record<string, unknown>[];
                const cli = flows.find(
                    (flow) => flow.package === "@cortexkit/magic-context",
                );
                if (cli === undefined) throw new Error("missing CLI product flow");
                cli.cli_commands_passed = false;
            },
        ],
        [
            "managed-demand product flow",
            (evidence: Record<string, unknown>) => {
                const flows = evidence.product_flows as Record<string, unknown>[];
                flows[0].managed_demand_passed = false;
            },
        ],
        [
            "offline product flow",
            (evidence: Record<string, unknown>) => {
                const flows = evidence.product_flows as Record<string, unknown>[];
                flows[0].offline_verified = false;
            },
        ],
        [
            "OIDC provenance",
            (evidence: Record<string, unknown>) => {
                const publication = evidence.publication as Record<string, unknown>;
                publication.oidc_provenance_verified = false;
            },
        ],
        [
            "payload-before-parent publication order",
            (evidence: Record<string, unknown>) => {
                const publication = evidence.publication as Record<string, unknown>;
                publication.payloads_before_parents = false;
            },
        ],
        [
            "long-lived-token prohibition",
            (evidence: Record<string, unknown>) => {
                const publication = evidence.publication as Record<string, unknown>;
                publication.long_lived_token_used = true;
            },
        ],
        [
            "production Synapse",
            (evidence: Record<string, unknown>) => {
                evidence.production_synapse_verified = false;
            },
        ],
    ])("%s proof is required for GA", (_name, mutate) => {
        const evidence = qualifiedEvidence();
        mutate(evidence);
        // The schema gate rejects failed proofs before reading artifacts.
        expect(() => validateInstalledReleaseEvidence(evidence)).toThrow(
            /qualified evidence contains a failed proof or blocker|payloads_before_parents/,
        );
    });

    test("a checkout without the qualification workflow cannot pass the GA gate", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        rmSync(join(root, QUALIFICATION_WORKFLOW_PATH));
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, fullStubs()),
        ).toThrow(/qualification workflow .* does not exist/);
    });

    test("qualification evidence cannot substitute for installed release evidence", () => {
        expect(() =>
            validateInstalledReleaseEvidence(
                {
                    schema: "magic-context.mc-host-release-qualification/v1",
                    production_qualified: true,
                },
            ),
        ).toThrow(/installed-release schema/);
    });

    test("release and artifact digest drift fails closed", () => {
        const evidence = qualifiedEvidence();
        evidence.release_contract_sha256 = "f".repeat(64);
        expect(() => validateInstalledReleaseEvidence(evidence)).toThrow(
            /release contract digest drift/,
        );
    });

    test("artifact digests are checked against current bytes", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(
                root,
                evidence,
                true,
                fullStubs(),
            ),
        ).not.toThrow();

        for (const field of Object.keys(RELEASE_ARTIFACTS)) {
            const drifted = structuredClone(evidence);
            drifted[field] = "f".repeat(64);
            expect(() =>
                validateInstalledReleaseEvidenceAgainstArtifacts(
                    root,
                    drifted,
                    true,
                    fullStubs(),
                ),
            ).toThrow(new RegExp(`${field} does not match`));
        }

        writeFileSync(
            join(root, RELEASE_ARTIFACTS.payload_index_sha256),
            "mutated payload index",
        );
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(
                root,
                evidence,
                true,
                fullStubs(),
            ),
        ).toThrow(/payload_index_sha256 does not match/);
    });

    test("all six registry packages, three targets, and three parent flows are required", () => {
        for (const field of ["registry_packages", "targets", "product_flows"] as const) {
            const evidence = qualifiedEvidence();
            (evidence[field] as unknown[]).pop();
            expect(() => validateInstalledReleaseEvidence(evidence)).toThrow(
                /exact release set/,
            );
        }
    });

    test("a fail-closed cited artifact cannot be laundered by a qualified evidence file", () => {
        const files = {
            production_inputs_sha256:
                "release/mc-host-production-inputs.lock.json",
            qualification_sha256:
                "tmp/mc-host-release-qualification.json",
            payload_index_sha256: "release/mc-host-payload-index.json",
            stop_provenance_sha256: "release/mc-host-n-minus-one-stop.json",
        } as const;
        const cases: [string, string, (parsed: Record<string, unknown>) => void, RegExp][] = [
            [
                "qualification from another release contract",
                files.qualification_sha256,
                (parsed) => {
                    parsed.release_contract_sha256 = "e".repeat(64);
                },
                /qualification was produced against a different release contract/,
            ],
            [
                "unqualified payload index",
                files.payload_index_sha256,
                (parsed) => {
                    parsed.production_qualified = false;
                },
                /trust index disagrees with U9 qualification state/,
            ],
            [
                "one unqualified payload entry",
                files.payload_index_sha256,
                (parsed) => {
                    (parsed.entries as { qualified: boolean }[])[0].qualified = false;
                },
                /entries\[0\]: missing key unqualified_reason/,
            ],
            [
                "index qualifying only one easy target",
                files.payload_index_sha256,
                (parsed) => {
                    parsed.entries = (parsed.entries as unknown[]).slice(0, 1);
                },
                /must carry exactly one entry per payload package/,
            ],
            [
                "skeletal index carrying only qualified entries",
                files.payload_index_sha256,
                (parsed) => {
                    const entries = parsed.entries;
                    for (const key of Object.keys(parsed)) delete parsed[key];
                    parsed.entries = entries;
                },
                /trust index: missing key schema/,
            ],
            [
                "index recording a parents-first publication",
                files.payload_index_sha256,
                (parsed) => {
                    (
                        parsed.publication as { payloads_before_parents: boolean }
                    ).payloads_before_parents = false;
                },
                /payloads must publish before parents/,
            ],
        ];
        for (const [label, mutated, mutate, pattern] of cases) {
            const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
            const evidence = qualifiedEvidence();
            installReleaseArtifacts(root, evidence);
            installProofArtifacts(root, evidence);
            for (const [field, relative] of Object.entries(files)) {
                let bytes = citedArtifactBytes(field);
                if (relative === mutated) {
                    const parsed = JSON.parse(bytes) as Record<string, unknown>;
                    mutate(parsed);
                    bytes = `${canonicalJson(parsed)}\n`;
                }
                mkdirSync(dirname(join(root, relative)), { recursive: true });
                writeFileSync(join(root, relative), bytes);
                evidence[field] = sha256Hex(bytes);
            }
            expect(
                () =>
                    validateInstalledReleaseEvidenceAgainstArtifacts(
                        root,
                        evidence,
                        true,
                        fullStubs(),
                    ),
                label,
            ).toThrow(pattern);
            // Schema-only verification does not require proof artifacts; GA qualification does.
            // Schema-only verification does not require proof artifacts; GA qualification does.
            expect(() =>
                validateInstalledReleaseEvidenceAgainstArtifacts(
                    root,
                    evidence,
                    false,
                    fullStubs(),
                ),
            ).not.toThrow();
        }
    });

    test("a parents-first registry order cannot claim payloads_before_parents", () => {
        const evidence = qualifiedEvidence();
        const packages = evidence.registry_packages as { name: string }[];
        const contract = buildContract();
        evidence.registry_packages = [
            ...contract.packages.parents,
            ...contract.packages.payloads,
        ].map((name) => packages.find((entry) => entry.name === name));
        // The package-order flag and publication proof must match the published order.
        // The package-order flag and publication proof must match the published order.
        expect((evidence.publication as { payloads_before_parents: boolean })
            .payloads_before_parents).toBe(true);
        expect(() => validateInstalledReleaseEvidence(evidence)).toThrow(
            /payloads_before_parents does not match the registry_packages order/,
        );
    });

    test("a target proof cannot name a test report the evidence never recorded", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        // The target proof must match the digest recorded in `evidence.targets`.
        // The target proof must match the digest recorded in `evidence.targets`.
        (evidence.targets as { test_report_sha256: string }[])[0].test_report_sha256 =
            sha256Hex("a different test report");
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, fullStubs()),
        ).toThrow(/observations drift/);
    });

    test("an unusable cited stop-provenance record cannot gate GA", () => {
        const files = {
            production_inputs_sha256:
                "release/mc-host-production-inputs.lock.json",
            qualification_sha256:
                "tmp/mc-host-release-qualification.json",
            payload_index_sha256: "release/mc-host-payload-index.json",
            stop_provenance_sha256: "release/mc-host-n-minus-one-stop.json",
        } as const;
        // A digest match alone must not grant usable stop authority.
        // A digest match alone must not grant usable stop authority.
        // Each forged replacement matches its recorded digest.
        const cases: [string, unknown, RegExp][] = [
            ["unknown tag", { tag: "whatever" }, /unknown stop-provenance tag/],
            [
                "genesis bound to another release",
                { tag: "genesis", release_version: "0.37.0" },
                /genesis must bind the current release identity/,
            ],
            [
                "genesis carrying legacy authority",
                {
                    tag: "genesis",
                    release_version: buildContract().release.version,
                    predecessor_release_version: "0.37.0",
                },
                /forbidden field predecessor_release_version/,
            ],
            [
                // Schema validation accepts a digest-valid `predecessor_manifest` even when ancestry rules reject it.
                // Schema validation accepts a digest-valid `predecessor_manifest` even when ancestry rules reject it.
                // Schema validation accepts a digest-valid `predecessor_manifest` even when ancestry rules reject it.
                // Schema validation accepts a digest-valid `predecessor_manifest` even when ancestry rules reject it.
                "a fully well-formed predecessor grant",
                (() => {
                    const contract = buildContract();
                    const manifest = { release_version: "0.37.0" };
                    return {
                        tag: "predecessor",
                        release_version: contract.release.version,
                        predecessor_release_version: "0.37.0",
                        predecessor_daemon_version: contract.versions.daemon,
                        legacy_proof_version:
                            contract.proof.legacy_stop_only.version,
                        target: contract.platforms.supported[0]?.target,
                        predecessor_manifest: manifest,
                        payload_manifest_digest: sha256Hex(
                            canonicalJson(manifest),
                        ),
                    };
                })(),
                /the first payload-bearing release has no predecessor; genesis is required/,
            ],
        ];
        for (const [label, stopRecord, pattern] of cases) {
            const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
            const evidence = qualifiedEvidence();
            installReleaseArtifacts(root, evidence);
            installProofArtifacts(root, evidence);
            for (const [field, relative] of Object.entries(files)) {
                const bytes =
                    field === "stop_provenance_sha256"
                        ? `${canonicalJson(stopRecord)}\n`
                        : citedArtifactBytes(field);
                mkdirSync(dirname(join(root, relative)), { recursive: true });
                writeFileSync(join(root, relative), bytes);
                evidence[field] = sha256Hex(bytes);
            }
            expect(
                () =>
                    validateInstalledReleaseEvidenceAgainstArtifacts(
                        root,
                        evidence,
                        true,
                        fullStubs(),
                    ),
                label,
            ).toThrow(pattern);
            expect(() =>
                validateInstalledReleaseEvidenceAgainstArtifacts(
                    root,
                    evidence,
                    false,
                    fullStubs(),
                ),
            ).not.toThrow();
        }
    });

    test("GA verification names the missing qualification workflow instead of blaming the proofs", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        rmSync(join(root, QUALIFICATION_WORKFLOW_PATH));
        // Without `verifyAttestation`, verification uses the real `gh` path.
        // Tests stub qualification to isolate attestation verification.
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                requireQualification: () => stubQualification(),
                expectedHeadSha: "a".repeat(40),
            }),
        ).toThrow(/qualification workflow .* does not exist/);
        // With the workflow present, verification looks up attestations by exact source digest.
        const workflow = ".github/workflows/mc-host-release-qualification.yml";
        mkdirSync(dirname(join(root, workflow)), { recursive: true });
        writeFileSync(join(root, workflow), "name: placeholder\n");
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                requireQualification: () => stubQualification(),
                expectedHeadSha: "a".repeat(40),
            }),
        ).toThrow(/lacks a valid attestation/);
        // Without a qualification stub, GA invokes the production-input validator.
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                expectedHeadSha: "a".repeat(40),
            }),
        ).toThrow(/qualification evidence rejected/);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                ...fullStubs(),
            }),
        ).not.toThrow();
    });

    test("a parent flow proof cannot pass without naming the published artifact", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        // A product-flow proof must bind the published artifact's integrity digest.
        // The proof's package_integrity differs from the published artifact's integrity digest.
        // The integrity binding must reject a proof whose bytes match its recorded digest but whose artifact digest differs.
        const proofs = evidence.proof_artifacts as {
            kind: string;
            path: string;
            sha256: string;
        }[];
        const flowProof = proofs.find((entry) => entry.kind === "product_flow");
        if (flowProof === undefined) throw new Error("no product_flow proof");
        const report = JSON.parse(
            readFileSync(join(root, flowProof.path), "utf8"),
        ) as { observations: Record<string, unknown> };
        report.observations.package_integrity = "sha512-someotherartifact";
        const rewritten = `${canonicalJson(report)}\n`;
        writeFileSync(join(root, flowProof.path), rewritten);
        flowProof.sha256 = sha256Hex(rewritten);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, fullStubs()),
        ).toThrow(/product_flow:.* observations drift/);
    });

    test("qualified evidence cannot leave a report digest unrecorded", () => {
        // `null` marks an unrecorded report digest.
        // Matching `null` values do not bind a proof to a report.
        // The binding must reject a proof that names no report.
        // A placeholder digest binds no report, so qualified evidence must reject it.
        for (const [label, mutate, pattern] of [
            [
                "null synapse report",
                (evidence: Record<string, unknown>) => {
                    evidence.production_synapse_report_sha256 = null;
                },
                /must record a real production_synapse_report_sha256/,
            ],
            [
                "placeholder synapse report",
                (evidence: Record<string, unknown>) => {
                    evidence.production_synapse_report_sha256 = "a".repeat(64);
                },
                /must record a real production_synapse_report_sha256/,
            ],
            [
                "null target test report",
                (evidence: Record<string, unknown>) => {
                    (
                        evidence.targets as { test_report_sha256: string | null }[]
                    )[0].test_report_sha256 = null;
                },
                /must record a real test_report_sha256 for/,
            ],
        ] as [string, (evidence: Record<string, unknown>) => void, RegExp][]) {
            const evidence = qualifiedEvidence();
            mutate(evidence);
            expect(
                () => validateInstalledReleaseEvidence(evidence),
                label,
            ).toThrow(pattern);
        }
        // Unqualified template evidence may retain `null`.
        const template = qualifiedEvidence();
        template.qualified = false;
        template.blockers = ["target smoke has not run"];
        template.production_synapse_report_sha256 = null;
        expect(() => validateInstalledReleaseEvidence(template)).not.toThrow();
    });

    test("canonical evidence has a stable digest", () => {
        const evidence = qualifiedEvidence();
        expect(sha256Hex(canonicalJson(evidence))).toBe(
            sha256Hex(canonicalJson(JSON.parse(canonicalJson(evidence)))),
        );
    });

    test("the schema gate passes with no installed evidence on disk", () => {
        const script = isolatedVerifier();
        const result = runVerifier(script, "--check-schema");
        expect(result.output).not.toMatch(/ENOENT/);
        expect(result.status, result.output).toBe(0);
        expect(result.output).toMatch(/schema only/);
    });

    test("the GA gate still requires the installed evidence", () => {
        const script = isolatedVerifier();
        const result = runVerifier(script, "--check");
        expect(result.status).not.toBe(0);
        expect(result.output).toMatch(/tmp\/mc-host-installed-release-evidence\.json/);
    });

    test("the schema gate rejects a malformed reference document", () => {
        expect(() => validateInstalledReleaseEvidence(schemaReferenceEvidence())).not.toThrow();
        for (const [label, mutate, pattern] of [
            [
                "an unqualified document naming no blocker",
                (reference: Record<string, unknown>) => {
                    reference.blockers = [];
                },
                /must name at least one blocker/,
            ],
            [
                "a digest that is not lowercase SHA-256",
                (reference: Record<string, unknown>) => {
                    reference.qualification_sha256 = "not-a-digest";
                },
                /qualification_sha256 must be lowercase SHA-256/,
            ],
            [
                "a target the release contract does not name",
                (reference: Record<string, unknown>) => {
                    (reference.targets as { target: string }[])[0].target = "sunos-sparc";
                },
                /targets must contain the exact release set/,
            ],
            [
                "a field the schema does not declare",
                (reference: Record<string, unknown>) => {
                    reference.extra = true;
                },
                /evidence keys must be exactly/,
            ],
        ] as [string, (reference: Record<string, unknown>) => void, RegExp][]) {
            const reference = JSON.parse(
                canonicalJson(schemaReferenceEvidence()),
            ) as Record<string, unknown>;
            mutate(reference);
            expect(() => validateInstalledReleaseEvidence(reference), label).toThrow(pattern);
        }
    });
});
