import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildContract, canonicalJson, sha256Hex } from "./generate-mc-host-release-manifest";
import {
    buildInstalledReleaseEvidence,
    validateInstalledReleaseEvidence,
    validateInstalledReleaseEvidenceAgainstArtifacts,
} from "./verify-mc-host-release-evidence";

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
            path: `proofs/${index}.json`,
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
                        test_report_sha256: "b".repeat(64),
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
            },
            observations,
        };
        const bytes = `${canonicalJson(report)}\n`;
        mkdirSync(dirname(join(root, proof.path)), { recursive: true });
        writeFileSync(join(root, proof.path), bytes);
        proof.sha256 = sha256Hex(bytes);
    }
}

describe("installed release evidence", () => {
    test("a complete installed non-GA release passes the GA gate", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        const files = {
            production_inputs_sha256:
                "release/mc-host-production-inputs.lock.json",
            qualification_sha256:
                "docs/evidence/mc-host-release-qualification.json",
            payload_index_sha256: "release/mc-host-payload-index.json",
            stop_provenance_sha256:
                "release/mc-host-n-minus-one-stop.json",
        } as const;
        for (const [field, relative] of Object.entries(files)) {
            const bytes = `${field} bytes`;
            mkdirSync(dirname(join(root, relative)), { recursive: true });
            writeFileSync(join(root, relative), bytes);
            evidence[field] = sha256Hex(bytes);
        }
        installProofArtifacts(root, evidence);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: () => true,
            }),
        ).not.toThrow();
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: () => false,
            }),
        ).toThrow(/lacks a valid attestation/);
        const proofs = evidence.proof_artifacts as {
            subject: string;
        }[];
        const lastSubject = proofs.at(-1)?.subject;
        const checked: string[] = [];
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: (_path, proof) => {
                    checked.push(proof.subject);
                    return proof.subject !== lastSubject;
                },
            }),
        ).toThrow(/lacks a valid attestation/);
        expect(checked.at(-1)).toBe(lastSubject);
        expect(() => validateInstalledReleaseEvidence(evidence)).not.toThrow();
    });

    test("an unqualified repository artifact is valid evidence but cannot gate GA", () => {
        const evidence = qualifiedEvidence();
        evidence.qualified = false;
        evidence.blockers = ["production target smoke has not run"];
        expect(() => validateInstalledReleaseEvidence(evidence)).not.toThrow();
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
        const files = {
            production_inputs_sha256:
                "release/mc-host-production-inputs.lock.json",
            qualification_sha256:
                "docs/evidence/mc-host-release-qualification.json",
            payload_index_sha256: "release/mc-host-payload-index.json",
            stop_provenance_sha256:
                "release/mc-host-n-minus-one-stop.json",
        } as const;
        const evidence = qualifiedEvidence();
        installProofArtifacts(root, evidence);
        for (const [field, relative] of Object.entries(files)) {
            const bytes = `${field} bytes`;
            mkdirSync(dirname(join(root, relative)), { recursive: true });
            writeFileSync(join(root, relative), bytes);
            evidence[field] = sha256Hex(bytes);
        }
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(
                root,
                evidence,
                true,
                { verifyAttestation: () => true },
            ),
        ).not.toThrow();

        for (const field of Object.keys(files)) {
            const drifted = structuredClone(evidence);
            drifted[field] = "f".repeat(64);
            expect(() =>
                validateInstalledReleaseEvidenceAgainstArtifacts(
                    root,
                    drifted,
                    true,
                    { verifyAttestation: () => true },
                ),
            ).toThrow(new RegExp(`${field} does not match`));
        }

        writeFileSync(
            join(root, files.payload_index_sha256),
            "mutated payload index",
        );
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(
                root,
                evidence,
                true,
                { verifyAttestation: () => true },
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
