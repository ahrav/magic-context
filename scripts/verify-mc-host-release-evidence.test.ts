import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildContract, canonicalJson, sha256Hex } from "./generate-mc-host-release-manifest";
import {
    attestationMatchesWorkflowSource,
    buildInstalledReleaseEvidence,
    resolveAttestationVerification,
    validateInstalledReleaseEvidence,
    validateInstalledReleaseEvidenceAgainstArtifacts,
    workflowRunApiPath,
} from "./verify-mc-host-release-evidence";

test("an injected attestation rejection never invokes the ambient fallback", () => {
    let fallbacks = 0;
    expect(
        resolveAttestationVerification(
            () => null,
            () => {
                fallbacks += 1;
                return matchingAttestation();
            },
        ),
    ).toBeNull();
    expect(fallbacks).toBe(0);
});

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
        proofArtifacts: proofIdentities.map(([kind, subject], index) => ({
            kind,
            subject,
            path: `tmp/mc-host-release-proofs/${index}.json`,
            sha256: "0".repeat(64),
        })),
        qualified: true,
        blockers: [],
    });
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
        const testReportPath = `reports/${proof.subject.replaceAll("/", "_")}.json`;
        const testReportBytes = `${canonicalJson({
            schema: "magic-context.mc-host-test-report/v1",
            target: proof.subject,
            passed: true,
        })}\n`;
        if (proof.kind === "target") {
            mkdirSync(dirname(join(root, testReportPath)), { recursive: true });
            writeFileSync(join(root, testReportPath), testReportBytes);
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
                          offline_verified: flowEvidence?.offline_verified,
                      }
                    : proof.kind === "publication"
                      ? publication
                      : { production_synapse_verified: evidence.production_synapse_verified };
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
        const bytes = `${field} bytes`;
        mkdirSync(dirname(join(root, relative)), { recursive: true });
        writeFileSync(join(root, relative), bytes);
        evidence[field] = sha256Hex(bytes);
    }
}

describe("installed release evidence", () => {
    test("a complete installed non-GA release passes the GA gate", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: (_path, proof) =>
                    matchingAttestation({
                        artifactSha256: proof.sha256,
                    }),
                verifyWorkflowRun: () => true,
                verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                    matchingAttestation({ artifactSha256: sha256 }),
                expectedHeadSha: "a".repeat(40),
            }),
        ).not.toThrow();
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: () => false,
                verifyWorkflowRun: () => true,
                verifyInstalledEvidenceAttestation: () => false,
                expectedHeadSha: "a".repeat(40),
            }),
        ).toThrow(/lacks a valid attestation/);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
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

    test("qualified evidence is bound to the release checkout commit", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: (_path, proof) =>
                    matchingAttestation({ artifactSha256: proof.sha256 }),
                verifyWorkflowRun: () => true,
                verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                    matchingAttestation({ artifactSha256: sha256 }),
                expectedHeadSha: "b".repeat(40),
            }),
        ).toThrow(/current release commit|immutable workflow run/);
    });

    test("target proof requires a passing report even when its updated digest is attested", () => {
        for (const mutation of ["failed", "wrong-schema", "wrong-target"] as const) {
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
            const observations = report.observations as Record<string, unknown>;
            const failedReportBytes = `${canonicalJson({
                schema:
                    mutation === "wrong-schema"
                        ? "magic-context.mc-host-test-report/v0"
                        : "magic-context.mc-host-test-report/v1",
                target: mutation === "wrong-target" ? "darwin-hostile" : targetProof.subject,
                passed: mutation !== "failed",
            })}\n`;
            writeFileSync(
                join(root, observations.test_report_path as string),
                failedReportBytes,
            );
            observations.test_report_sha256 = sha256Hex(failedReportBytes);
            const bytes = `${canonicalJson(report)}\n`;
            writeFileSync(join(root, targetProof.path), bytes);
            const proofRef = (
                evidence.proof_artifacts as { path: string; sha256: string }[]
            ).find((proof) => proof.path === targetProof.path);
            if (proofRef === undefined) throw new Error("missing target proof ref");
            proofRef.sha256 = sha256Hex(bytes);

            expect(() =>
                validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                    verifyAttestation: (_path, proof) =>
                        matchingAttestation({ artifactSha256: proof.sha256 }),
                    verifyWorkflowRun: () => true,
                    verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                        matchingAttestation({ artifactSha256: sha256 }),
                    expectedHeadSha: "a".repeat(40),
                }),
            ).toThrow(/target test report/);
        }
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
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        mutate(evidence);
        installReleaseArtifacts(root, evidence);
        installProofArtifacts(root, evidence);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: (_path, proof) =>
                    matchingAttestation({ artifactSha256: proof.sha256 }),
                verifyWorkflowRun: () => true,
                expectedHeadSha: "a".repeat(40),
            }),
        ).toThrow(/qualified evidence contains a failed proof or blocker/);
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
                {
                    verifyAttestation: (_path, proof) =>
                        matchingAttestation({ artifactSha256: proof.sha256 }),
                    verifyWorkflowRun: () => true,
                    verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                        matchingAttestation({ artifactSha256: sha256 }),
                    expectedHeadSha: "a".repeat(40),
                },
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
                    {
                        verifyAttestation: (_path, proof) =>
                            matchingAttestation({ artifactSha256: proof.sha256 }),
                        verifyWorkflowRun: () => true,
                        verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                            matchingAttestation({ artifactSha256: sha256 }),
                        expectedHeadSha: "a".repeat(40),
                    },
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
                {
                    verifyAttestation: (_path, proof) =>
                        matchingAttestation({ artifactSha256: proof.sha256 }),
                    verifyWorkflowRun: () => true,
                    verifyInstalledEvidenceAttestation: (_path, _source, sha256) =>
                        matchingAttestation({ artifactSha256: sha256 }),
                    expectedHeadSha: "a".repeat(40),
                },
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

    test("canonical evidence has a stable digest", () => {
        const evidence = qualifiedEvidence();
        expect(sha256Hex(canonicalJson(evidence))).toBe(
            sha256Hex(canonicalJson(JSON.parse(canonicalJson(evidence)))),
        );
    });
});
