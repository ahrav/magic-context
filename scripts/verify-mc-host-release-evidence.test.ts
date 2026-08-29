import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
            path: `proofs/${index}.json`,
            sha256: "0".repeat(64),
        })),
        qualified: true,
        blockers: [],
    });
}

/**
 * Bytes to stage for a cited artifact.
 *
 * The GA gate binds each cited artifact to this release — schema, contract
 * digest, and identity set — so these fixtures have to reproduce the real
 * citations rather than just the qualified booleans. The input lock is only
 * digest-compared and can stay opaque.
 */
function citedArtifactBytes(field: string): string {
    const contract = buildContract();
    const contractDigest = sha256Hex(canonicalJson(contract));
    if (field === "qualification_sha256") {
        return `${canonicalJson({
            schema: "magic-context.mc-host-release-qualification/v1",
            release_contract_sha256: contractDigest,
            production_qualified: true,
            unqualified: [],
        })}\n`;
    }
    if (field === "payload_index_sha256") {
        return `${canonicalJson({
            schema: "magic-context.mc-host-payload-index/v1",
            release: {
                id: contract.release.id,
                version: contract.packages.version,
            },
            release_contract_sha256: contractDigest,
            production_qualified: true,
            publication: {
                payloads_before_parents: true,
                published: true,
            },
            entries: contract.platforms.supported.map((platform) => ({
                qualified: true,
                target: platform.target,
            })),
        })}\n`;
    }
    if (field === "stop_provenance_sha256") {
        // Genesis is the only acceptable ancestry for the first payload-bearing
        // release, and `validateStopRecord` requires exactly the contract's
        // genesis fields bound to the current release identity.
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
 * Stages the registry gate the GA gate reads reservation versions from.
 *
 * Payload reservations must be inert prereleases and must never collide with a
 * release version, which is what makes them safe to exclude from ancestry.
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
                        test_report_sha256: targetEvidence?.test_report_sha256,
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
            const bytes = citedArtifactBytes(field);
            mkdirSync(dirname(join(root, relative)), { recursive: true });
            writeFileSync(join(root, relative), bytes);
            evidence[field] = sha256Hex(bytes);
        }
        installProofArtifacts(root, evidence);
            installRegistryGate(root);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: () => true,
                requireQualification: () => {},
            }),
        ).not.toThrow();
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: () => false,
                requireQualification: () => {},
            }),
        ).toThrow(/lacks a valid attestation/);
        const proofs = evidence.proof_artifacts as {
            subject: string;
        }[];
        const lastSubject = proofs.at(-1)?.subject;
        const checked: string[] = [];
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                requireQualification: () => {},
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
            installRegistryGate(root);
        for (const [field, relative] of Object.entries(files)) {
            const bytes = citedArtifactBytes(field);
            mkdirSync(dirname(join(root, relative)), { recursive: true });
            writeFileSync(join(root, relative), bytes);
            evidence[field] = sha256Hex(bytes);
        }
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(
                root,
                evidence,
                true,
                { verifyAttestation: () => true,
                requireQualification: () => {} },
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
                    { verifyAttestation: () => true,
                requireQualification: () => {} },
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
                { verifyAttestation: () => true,
                requireQualification: () => {} },
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
                "docs/evidence/mc-host-release-qualification.json",
            payload_index_sha256: "release/mc-host-payload-index.json",
            stop_provenance_sha256: "release/mc-host-n-minus-one-stop.json",
        } as const;
        // Each case rewrites one cited artifact into its committed fail-closed
        // shape. The evidence still claims `qualified: true` with passing,
        // attested proofs, so only parsing the artifact's own claim can catch it.
        // Each case rewrites one cited artifact and re-derives its digest, so the
        // evidence stays byte-consistent with what it cites.
        const cases: [string, string, (parsed: Record<string, unknown>) => void, RegExp][] = [
            [
                // The qualification run's own contents are validated by its full
                // consumer, which this test stubs; only the citation this gate owns
                // is checked here — that the evidence and the run name the *same*
                // contract, not merely that each is current on its own.
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
                /cited payload index is not production-qualified/,
            ],
            [
                "one unqualified payload entry",
                files.payload_index_sha256,
                (parsed) => {
                    (parsed.entries as { qualified: boolean }[])[0].qualified = false;
                },
                /cited payload index entry .* is not qualified/,
            ],
            [
                "index qualifying only one easy target",
                files.payload_index_sha256,
                (parsed) => {
                    parsed.entries = (parsed.entries as unknown[]).slice(0, 1);
                },
                /cited payload index targets must contain the exact release set/,
            ],
            [
                "skeletal index carrying only qualified entries",
                files.payload_index_sha256,
                (parsed) => {
                    const entries = parsed.entries;
                    for (const key of Object.keys(parsed)) delete parsed[key];
                    parsed.entries = entries;
                },
                /not a payload index/,
            ],
            [
                "index recording no completed publication",
                files.payload_index_sha256,
                (parsed) => {
                    (parsed.publication as { published: boolean }).published = false;
                },
                /records no completed publication/,
            ],
            [
                "index recording a parents-first publication",
                files.payload_index_sha256,
                (parsed) => {
                    (
                        parsed.publication as { payloads_before_parents: boolean }
                    ).payloads_before_parents = false;
                },
                /records a parents-first publication/,
            ],
        ];
        for (const [label, mutated, mutate, pattern] of cases) {
            const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
            const evidence = qualifiedEvidence();
            installProofArtifacts(root, evidence);
            installRegistryGate(root);
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
                        { verifyAttestation: () => true,
                requireQualification: () => {} },
                    ),
                label,
            ).toThrow(pattern);
            // Schema-only verification still accepts it: the artifacts are only
            // required to be qualified when the evidence is gating GA.
            expect(() =>
                validateInstalledReleaseEvidenceAgainstArtifacts(
                    root,
                    evidence,
                    false,
                    { verifyAttestation: () => true,
                requireQualification: () => {} },
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
        // The published order regressed to parents-first, but the boolean and
        // the publication proof that echoes it still say otherwise.
        expect((evidence.publication as { payloads_before_parents: boolean })
            .payloads_before_parents).toBe(true);
        expect(() => validateInstalledReleaseEvidence(evidence)).toThrow(
            /payloads_before_parents does not match the registry_packages order/,
        );
    });

    test("a target proof cannot name a test report the evidence never recorded", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installProofArtifacts(root, evidence);
            installRegistryGate(root);
        for (const [field, relative] of Object.entries({
            production_inputs_sha256:
                "release/mc-host-production-inputs.lock.json",
            qualification_sha256:
                "docs/evidence/mc-host-release-qualification.json",
            payload_index_sha256: "release/mc-host-payload-index.json",
            stop_provenance_sha256: "release/mc-host-n-minus-one-stop.json",
        })) {
            const bytes = citedArtifactBytes(field);
            mkdirSync(dirname(join(root, relative)), { recursive: true });
            writeFileSync(join(root, relative), bytes);
            evidence[field] = sha256Hex(bytes);
        }
        // Swapping only the recorded digest proves the comparison has two
        // independent sides; reading the expected value back out of the proof
        // made this substitution invisible.
        (evidence.targets as { test_report_sha256: string }[])[0].test_report_sha256 =
            "c".repeat(64);
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: () => true,
                requireQualification: () => {},
            }),
        ).toThrow(/observations drift/);
    });

    test("an unusable cited stop-provenance record cannot gate GA", () => {
        const files = {
            production_inputs_sha256:
                "release/mc-host-production-inputs.lock.json",
            qualification_sha256:
                "docs/evidence/mc-host-release-qualification.json",
            payload_index_sha256: "release/mc-host-payload-index.json",
            stop_provenance_sha256: "release/mc-host-n-minus-one-stop.json",
        } as const;
        // No proof kind covers stop provenance, so a digest match was the only
        // thing between qualified evidence and a stop record granting no usable
        // authority. Each replacement is byte-consistent with its digest.
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
                // Schema-valid in every respect, including a `predecessor_manifest`
                // that really does hash to its cited digest — so only the ancestry
                // rules reject it. This is what schema-level validation alone
                // accepted: an unauthorized grant of legacy stop authority.
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
            installProofArtifacts(root, evidence);
            installRegistryGate(root);
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
                        { verifyAttestation: () => true,
                requireQualification: () => {} },
                    ),
                label,
            ).toThrow(pattern);
            expect(() =>
                validateInstalledReleaseEvidenceAgainstArtifacts(
                    root,
                    evidence,
                    false,
                    { verifyAttestation: () => true,
                requireQualification: () => {} },
                ),
            ).not.toThrow();
        }
    });

    test("GA verification names the missing qualification workflow instead of blaming the proofs", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installProofArtifacts(root, evidence);
            installRegistryGate(root);
        for (const [field, relative] of Object.entries({
            production_inputs_sha256:
                "release/mc-host-production-inputs.lock.json",
            qualification_sha256:
                "docs/evidence/mc-host-release-qualification.json",
            payload_index_sha256: "release/mc-host-payload-index.json",
            stop_provenance_sha256: "release/mc-host-n-minus-one-stop.json",
        })) {
            const bytes = citedArtifactBytes(field);
            mkdirSync(dirname(join(root, relative)), { recursive: true });
            writeFileSync(join(root, relative), bytes);
            evidence[field] = sha256Hex(bytes);
        }
        // No `verifyAttestation` stub, so the real `gh` path is selected and the
        // pinned signer identity has to be satisfiable. Until the lane exists it
        // is not, and the failure must say so rather than reporting six proofs
        // as unattested. Qualification is stubbed to isolate the attestation
        // preconditions; the assertion below covers the unstubbed default.
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                requireQualification: () => {},
            }),
        ).toThrow(/qualification workflow at .*mc-host-release-qualification\.yml/);
        // With the workflow present the next unmet precondition must surface, not
        // a permissive verification: an unpinned source ref lets the approved
        // workflow authorize GA from any branch.
        const workflow = ".github/workflows/mc-host-release-qualification.yml";
        mkdirSync(dirname(join(root, workflow)), { recursive: true });
        writeFileSync(join(root, workflow), "name: placeholder\n");
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                requireQualification: () => {},
            }),
        ).toThrow(/requires an attestation source ref/);
        // Unstubbed, the real production-input qualification consumer runs and its
        // rejection surfaces — proof that GA delegates to the full validator
        // rather than to the summary fields this file used to check.
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true),
        ).toThrow(/qualification evidence rejected/);
        // Both stubs bypass it: the preconditions are about the `gh` path.
        expect(() =>
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: () => true,
                requireQualification: () => {},
            }),
        ).not.toThrow();
    });

    test("a parent flow proof cannot pass without naming the published artifact", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-host-installed-evidence-"));
        const evidence = qualifiedEvidence();
        installProofArtifacts(root, evidence);
        installRegistryGate(root);
        for (const [field, relative] of Object.entries({
            production_inputs_sha256:
                "release/mc-host-production-inputs.lock.json",
            qualification_sha256:
                "docs/evidence/mc-host-release-qualification.json",
            payload_index_sha256: "release/mc-host-payload-index.json",
            stop_provenance_sha256: "release/mc-host-n-minus-one-stop.json",
        })) {
            const bytes = citedArtifactBytes(field);
            mkdirSync(dirname(join(root, relative)), { recursive: true });
            writeFileSync(join(root, relative), bytes);
            evidence[field] = sha256Hex(bytes);
        }
        // Rewrite one flow proof so it reports the same three passing booleans
        // against a different artifact — the source-checkout / stale-install case.
        // The proof stays byte-consistent with its recorded digest, so only the
        // integrity binding can reject it.
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
            validateInstalledReleaseEvidenceAgainstArtifacts(root, evidence, true, {
                verifyAttestation: () => true,
                requireQualification: () => {},
            }),
        ).toThrow(/product_flow:.* observations drift/);
    });

    test("canonical evidence has a stable digest", () => {
        const evidence = qualifiedEvidence();
        expect(sha256Hex(canonicalJson(evidence))).toBe(
            sha256Hex(canonicalJson(JSON.parse(canonicalJson(evidence)))),
        );
    });
});
