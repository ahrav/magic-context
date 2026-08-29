/**
 * Validates the installed non-GA release evidence that gates mc-host GA tags.
 *
 * `--check` requires complete qualified evidence. `--write-template` refreshes
 * the fail-closed repository template from the current release artifacts.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    buildContract,
    canonicalJson,
    type ReleaseContract,
    sha256Hex,
    validateStopProvenance,
} from "./generate-mc-host-release-manifest";

const EVIDENCE_PATH = "docs/evidence/mc-host-installed-release-evidence.json";
const QUALIFICATION_PATH = "docs/evidence/mc-host-release-qualification.json";
const INPUT_LOCK_PATH = "release/mc-host-production-inputs.lock.json";
const PAYLOAD_INDEX_PATH = "release/mc-host-payload-index.json";
const STOP_PROVENANCE_PATH = "release/mc-host-n-minus-one-stop.json";
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * The only repository whose workflows may author a proof or its attestation.
 *
 * A proof's `source.run_url` names the run that produced it, so an unconstrained
 * host/owner there would let a report point at a run in an unrelated repository
 * while still satisfying the attestation check below.
 */
const ATTESTATION_REPO = "ahrav/magic-context";

/**
 * The workflow whose identity is accepted as authorizing a proof.
 *
 * `gh attestation verify --repo` constrains the repository only, so any other
 * workflow in the same repository could attest an arbitrary passing proof and
 * clear this GA gate. `gh` validates the signer path only when given
 * `--signer-workflow` or `--cert-identity`, so the approved workflow is named
 * here explicitly and every other same-repository workflow is rejected.
 *
 * The workflow does not exist yet — the qualification lane that publishes,
 * attests, and collects these proofs is still to be built. Naming its path here
 * ahead of time is deliberate and fail-closed: nothing can satisfy this signer
 * until the lane exists, so the lane must be created at this path rather than
 * the check loosened to accept whatever happens to sign.
 */
const ATTESTATION_SIGNER_WORKFLOW_PATH =
    ".github/workflows/mc-host-release-qualification.yml";
const ATTESTATION_SIGNER_WORKFLOW = `${ATTESTATION_REPO}/${ATTESTATION_SIGNER_WORKFLOW_PATH}`;

const RUN_URL_RE = new RegExp(
    `^https://github\\.com/${ATTESTATION_REPO}/actions/runs/\\d+`,
);

interface RegistryPackageEvidence {
    name: string;
    version: string;
    integrity: string;
    provenance_verified: boolean;
}

interface TargetEvidence {
    target: string;
    filesystem_verified: boolean;
    self_fd_verified: boolean;
    process_crash_atomicity_verified: boolean;
    lifecycle_smoke_passed: boolean;
    /**
     * Digest of the target's test report, recorded independently of the proof.
     *
     * Held here rather than read back out of the proof's own observations so
     * that the comparison has two sides. `null` records that no report digest
     * was captured, and the proof must then echo `null` too.
     */
    test_report_sha256: string | null;
}

interface ProductFlowEvidence {
    package: string;
    cli_commands_passed: boolean;
    managed_demand_passed: boolean;
    offline_verified: boolean;
}

type ProofKind =
    | "registry_package"
    | "target"
    | "product_flow"
    | "publication"
    | "production_synapse";

interface ProofArtifactRef {
    kind: ProofKind;
    subject: string;
    path: string;
    sha256: string;
}

export interface InstalledReleaseEvidence {
    schema: "magic-context.mc-host-installed-release-evidence/v1";
    release: {
        id: string;
        version: string;
    };
    release_contract_sha256: string;
    production_inputs_sha256: string;
    qualification_sha256: string;
    payload_index_sha256: string;
    stop_provenance_sha256: string;
    registry_packages: RegistryPackageEvidence[];
    targets: TargetEvidence[];
    product_flows: ProductFlowEvidence[];
    publication: {
        oidc_provenance_verified: boolean;
        long_lived_token_used: boolean;
        payloads_before_parents: boolean;
    };
    production_synapse_verified: boolean;
    proof_artifacts: ProofArtifactRef[];
    qualified: boolean;
    blockers: string[];
}

export interface BuildInstalledReleaseEvidenceOptions {
    contract: ReleaseContract;
    productionInputsSha256: string;
    qualificationSha256: string;
    payloadIndexSha256: string;
    stopProvenanceSha256: string;
    registryPackages: RegistryPackageEvidence[];
    targets: TargetEvidence[];
    productFlows: ProductFlowEvidence[];
    oidcProvenanceVerified: boolean;
    longLivedTokenUsed: boolean;
    productionSynapseVerified: boolean;
    proofArtifacts: ProofArtifactRef[];
    qualified: boolean;
    blockers: string[];
}

function fail(message: string): never {
    throw new Error(`mc-host installed release evidence: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(`${where} must be an object`);
    }
    return value as Record<string, unknown>;
}

function exactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
    where: string,
): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        fail(`${where} keys must be exactly ${expected.join(", ")}`);
    }
}

function stringField(
    value: Record<string, unknown>,
    key: string,
    where: string,
): string {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) {
        fail(`${where}.${key} must be a nonempty string`);
    }
    return field;
}

function booleanField(
    value: Record<string, unknown>,
    key: string,
    where: string,
): boolean {
    const field = value[key];
    if (typeof field !== "boolean") fail(`${where}.${key} must be boolean`);
    return field;
}

function stringArray(value: unknown, where: string): string[] {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        fail(`${where} must be a string array`);
    }
    return value;
}

function sha256File(rootDir: string, relative: string): string {
    return createHash("sha256")
        .update(readFileSync(join(rootDir, relative)))
        .digest("hex");
}

function exactIdentitySet(
    actual: readonly string[],
    expected: readonly string[],
    where: string,
): void {
    if (
        new Set(actual).size !== actual.length ||
        canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort())
    ) {
        fail(`${where} must contain the exact release set`);
    }
}

/**
 * Whether `names` lists every payload package before every parent package.
 *
 * Shared by construction and validation so the two cannot drift: the recorded
 * `publication.payloads_before_parents` boolean is only meaningful if the
 * verifier derives it from the same order the builder derived it from.
 * `exactIdentitySet` sorts, so nothing else in validation observes this order.
 */
function payloadsBeforeParents(
    names: readonly string[],
    contract: ReleaseContract,
): boolean {
    return (
        names.join("\n") ===
        [...contract.packages.payloads, ...contract.packages.parents].join("\n")
    );
}

export function buildInstalledReleaseEvidence(
    options: BuildInstalledReleaseEvidenceOptions,
): InstalledReleaseEvidence {
    return {
        schema: "magic-context.mc-host-installed-release-evidence/v1",
        release: {
            id: options.contract.release.id,
            version: options.contract.packages.version,
        },
        release_contract_sha256: sha256Hex(canonicalJson(options.contract)),
        production_inputs_sha256: options.productionInputsSha256,
        qualification_sha256: options.qualificationSha256,
        payload_index_sha256: options.payloadIndexSha256,
        stop_provenance_sha256: options.stopProvenanceSha256,
        registry_packages: options.registryPackages,
        targets: options.targets,
        product_flows: options.productFlows,
        publication: {
            oidc_provenance_verified: options.oidcProvenanceVerified,
            long_lived_token_used: options.longLivedTokenUsed,
            payloads_before_parents: payloadsBeforeParents(
                options.registryPackages.map((entry) => entry.name),
                options.contract,
            ),
        },
        production_synapse_verified: options.productionSynapseVerified,
        proof_artifacts: options.proofArtifacts,
        qualified: options.qualified,
        blockers: options.blockers,
    };
}

export function validateInstalledReleaseEvidence(
    input: unknown,
): InstalledReleaseEvidence {
    const evidence = record(input, "evidence");
    if (evidence.schema !== "magic-context.mc-host-installed-release-evidence/v1") {
        fail("expected the installed-release schema; qualification evidence is not interchangeable");
    }
    exactKeys(
        evidence,
        [
            "schema",
            "release",
            "release_contract_sha256",
            "production_inputs_sha256",
            "qualification_sha256",
            "payload_index_sha256",
            "stop_provenance_sha256",
            "registry_packages",
            "targets",
            "product_flows",
            "publication",
            "production_synapse_verified",
            "proof_artifacts",
            "qualified",
            "blockers",
        ],
        "evidence",
    );

    const contract = buildContract();
    const release = record(evidence.release, "release");
    exactKeys(release, ["id", "version"], "release");
    if (
        stringField(release, "id", "release") !== contract.release.id ||
        stringField(release, "version", "release") !== contract.packages.version
    ) {
        fail("release identity drift");
    }
    const expectedContractDigest = sha256Hex(canonicalJson(contract));
    if (evidence.release_contract_sha256 !== expectedContractDigest) {
        fail("release contract digest drift");
    }
    for (const key of [
        "production_inputs_sha256",
        "qualification_sha256",
        "payload_index_sha256",
        "stop_provenance_sha256",
    ] as const) {
        const digest = stringField(evidence, key, "evidence");
        if (!SHA256_RE.test(digest)) fail(`${key} must be lowercase SHA-256`);
    }

    if (!Array.isArray(evidence.registry_packages)) {
        fail("registry_packages must be an array");
    }
    const registryPackages = evidence.registry_packages.map((raw, index) => {
        const entry = record(raw, `registry_packages[${index}]`);
        exactKeys(
            entry,
            ["name", "version", "integrity", "provenance_verified"],
            `registry_packages[${index}]`,
        );
        return {
            name: stringField(entry, "name", `registry_packages[${index}]`),
            version: stringField(entry, "version", `registry_packages[${index}]`),
            integrity: stringField(entry, "integrity", `registry_packages[${index}]`),
            provenance_verified: booleanField(
                entry,
                "provenance_verified",
                `registry_packages[${index}]`,
            ),
        };
    });
    exactIdentitySet(
        registryPackages.map((entry) => entry.name),
        [...contract.packages.payloads, ...contract.packages.parents],
        "registry_packages",
    );
    if (
        registryPackages.some(
            (entry) =>
                entry.version !== contract.packages.version ||
                !entry.integrity.startsWith("sha512-"),
        )
    ) {
        fail("registry package version or integrity drift");
    }

    if (!Array.isArray(evidence.targets)) fail("targets must be an array");
    const targets = evidence.targets.map((raw, index) => {
        const entry = record(raw, `targets[${index}]`);
        exactKeys(
            entry,
            [
                "target",
                "filesystem_verified",
                "self_fd_verified",
                "process_crash_atomicity_verified",
                "lifecycle_smoke_passed",
                "test_report_sha256",
            ],
            `targets[${index}]`,
        );
        const testReport = entry.test_report_sha256;
        if (
            testReport !== null &&
            (typeof testReport !== "string" || !SHA256_RE.test(testReport))
        ) {
            fail(`targets[${index}].test_report_sha256 must be lowercase SHA-256 or null`);
        }
        return {
            target: stringField(entry, "target", `targets[${index}]`),
            filesystem_verified: booleanField(
                entry,
                "filesystem_verified",
                `targets[${index}]`,
            ),
            self_fd_verified: booleanField(entry, "self_fd_verified", `targets[${index}]`),
            process_crash_atomicity_verified: booleanField(
                entry,
                "process_crash_atomicity_verified",
                `targets[${index}]`,
            ),
            lifecycle_smoke_passed: booleanField(
                entry,
                "lifecycle_smoke_passed",
                `targets[${index}]`,
            ),
            test_report_sha256: testReport,
        };
    });
    exactIdentitySet(
        targets.map((entry) => entry.target),
        contract.platforms.supported.map((entry) => entry.target),
        "targets",
    );

    if (!Array.isArray(evidence.product_flows)) fail("product_flows must be an array");
    const productFlows = evidence.product_flows.map((raw, index) => {
        const entry = record(raw, `product_flows[${index}]`);
        exactKeys(
            entry,
            ["package", "cli_commands_passed", "managed_demand_passed", "offline_verified"],
            `product_flows[${index}]`,
        );
        return {
            package: stringField(entry, "package", `product_flows[${index}]`),
            cli_commands_passed: booleanField(
                entry,
                "cli_commands_passed",
                `product_flows[${index}]`,
            ),
            managed_demand_passed: booleanField(
                entry,
                "managed_demand_passed",
                `product_flows[${index}]`,
            ),
            offline_verified: booleanField(
                entry,
                "offline_verified",
                `product_flows[${index}]`,
            ),
        };
    });
    exactIdentitySet(
        productFlows.map((entry) => entry.package),
        contract.packages.parents,
        "product_flows",
    );

    const publication = record(evidence.publication, "publication");
    exactKeys(
        publication,
        ["oidc_provenance_verified", "long_lived_token_used", "payloads_before_parents"],
        "publication",
    );
    // The publication proof only echoes this boolean back, so without deriving
    // it here a hand-authored file could list parents first, claim `true`, and
    // pass the payload-first invariant after a parents-first release.
    if (
        booleanField(publication, "payloads_before_parents", "publication") !==
        payloadsBeforeParents(
            registryPackages.map((entry) => entry.name),
            contract,
        )
    ) {
        fail(
            "publication.payloads_before_parents does not match the registry_packages order",
        );
    }
    const blockers = stringArray(evidence.blockers, "blockers");
    const qualified = booleanField(evidence, "qualified", "evidence");
    if (!Array.isArray(evidence.proof_artifacts)) {
        fail("proof_artifacts must be an array");
    }
    const proofArtifacts = evidence.proof_artifacts.map((raw, index) => {
        const entry = record(raw, `proof_artifacts[${index}]`);
        exactKeys(entry, ["kind", "subject", "path", "sha256"], `proof_artifacts[${index}]`);
        const kind = stringField(entry, "kind", `proof_artifacts[${index}]`);
        if (
            ![
                "registry_package",
                "target",
                "product_flow",
                "publication",
                "production_synapse",
            ].includes(kind)
        ) {
            fail(`proof_artifacts[${index}].kind is outside the closed union`);
        }
        const path = stringField(entry, "path", `proof_artifacts[${index}]`);
        if (
            path.startsWith("/") ||
            path.includes("\\") ||
            path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
        ) {
            fail(`proof_artifacts[${index}].path must be a safe relative path`);
        }
        const sha256 = stringField(entry, "sha256", `proof_artifacts[${index}]`);
        if (!SHA256_RE.test(sha256)) {
            fail(`proof_artifacts[${index}].sha256 must be lowercase SHA-256`);
        }
        return {
            kind: kind as ProofKind,
            subject: stringField(entry, "subject", `proof_artifacts[${index}]`),
            path,
            sha256,
        };
    });
    const expectedProofs = [
        ...contract.packages.payloads.map((subject) => `registry_package:${subject}`),
        ...contract.packages.parents.map((subject) => `registry_package:${subject}`),
        ...contract.platforms.supported.map((entry) => `target:${entry.target}`),
        ...contract.packages.parents.map((subject) => `product_flow:${subject}`),
        `publication:${contract.release.id}`,
        "production_synapse:linux-x64-gnu",
    ];
    if (qualified) {
        exactIdentitySet(
            proofArtifacts.map((entry) => `${entry.kind}:${entry.subject}`),
            expectedProofs,
            "proof_artifacts",
        );
    }
    const allProofsPass =
        registryPackages.every((entry) => entry.provenance_verified) &&
        targets.every(
            (entry) =>
                entry.filesystem_verified &&
                entry.self_fd_verified &&
                entry.process_crash_atomicity_verified &&
                entry.lifecycle_smoke_passed,
        ) &&
        productFlows.every(
            (entry) =>
                entry.managed_demand_passed &&
                entry.offline_verified &&
                (entry.package !== "@cortexkit/magic-context" ||
                    entry.cli_commands_passed),
        ) &&
        booleanField(publication, "oidc_provenance_verified", "publication") &&
        !booleanField(publication, "long_lived_token_used", "publication") &&
        booleanField(publication, "payloads_before_parents", "publication") &&
        booleanField(evidence, "production_synapse_verified", "evidence");

    if (qualified && (!allProofsPass || blockers.length !== 0)) {
        fail("qualified evidence contains a failed proof or blocker");
    }
    if (!qualified && blockers.length === 0) {
        fail("unqualified evidence must name at least one blocker");
    }
    return evidence as unknown as InstalledReleaseEvidence;
}

/**
 * Requires the artifacts this evidence cites to themselves be release-qualified.
 *
 * The digest comparison above only binds the evidence to whatever bytes are
 * committed; it says nothing about what those bytes claim. All three artifacts
 * are committed fail-closed between releases, so without parsing them an
 * evidence document could set `qualified: true`, carry passing proofs, and clear
 * the GA gate while citing a qualification run that recorded
 * `production_qualified: false`, payload entries that recorded
 * `qualified: false`, or a stop record that grants no usable stop authority.
 */
function assertCitedArtifactsQualified(
    rootDir: string,
    contract: ReleaseContract,
): void {
    const qualification = record(
        readJson(rootDir, QUALIFICATION_PATH),
        "cited qualification",
    );
    if (qualification.production_qualified !== true) {
        fail("cited production-input qualification is not production-qualified");
    }
    const payloadIndex = record(
        readJson(rootDir, PAYLOAD_INDEX_PATH),
        "cited payload index",
    );
    if (payloadIndex.production_qualified !== true) {
        fail("cited payload index is not production-qualified");
    }
    const entries = payloadIndex.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
        fail("cited payload index has no entries");
    }
    entries.forEach((raw, index) => {
        const entry = record(raw, `cited payload index entries[${index}]`);
        if (entry.qualified !== true) {
            const label =
                typeof entry.target === "string" ? entry.target : String(index);
            fail(`cited payload index entry ${label} is not qualified`);
        }
    });
    // No proof kind covers stop provenance, so a digest match was previously the
    // only thing standing between qualified evidence and a malformed or
    // foreign-release stop record. `validateStopProvenance` is the existing
    // consumer-facing gate and needs only the contract, which is already here.
    const stop = validateStopProvenance(
        contract,
        readJson(rootDir, STOP_PROVENANCE_PATH),
    );
    if (!stop.valid) {
        fail(`cited stop-provenance record is unusable: ${stop.error}`);
    }
}

export function validateInstalledReleaseEvidenceAgainstArtifacts(
    rootDir: string,
    value: unknown,
    requireQualified: boolean,
    options: {
        verifyAttestation?: (path: string, proof: ProofArtifactRef) => boolean;
    } = {},
): InstalledReleaseEvidence {
    const evidence = validateInstalledReleaseEvidence(value);
    const contract = buildContract();
    const expected = {
        production_inputs_sha256: sha256File(rootDir, INPUT_LOCK_PATH),
        qualification_sha256: sha256File(rootDir, QUALIFICATION_PATH),
        payload_index_sha256: sha256File(rootDir, PAYLOAD_INDEX_PATH),
        stop_provenance_sha256: sha256File(rootDir, STOP_PROVENANCE_PATH),
    };
    for (const [field, digest] of Object.entries(expected)) {
        if (evidence[field as keyof typeof expected] !== digest) {
            fail(`${field} does not match the current artifact`);
        }
    }
    if (requireQualified) assertCitedArtifactsQualified(rootDir, contract);
    if (requireQualified && options.verifyAttestation === undefined) {
        // Without this the pinned signer is unsatisfiable and every proof fails
        // with an opaque `lacks a valid attestation`, which reads as a bad proof
        // rather than a lane that was never built. Name the real precondition
        // once, before spawning `gh` six times against an identity that cannot
        // exist. This is a clarity gate, not a security one: a workflow file
        // being present says nothing about what signed a given attestation, so
        // `--signer-workflow` still does the enforcing.
        if (!existsSync(join(rootDir, ATTESTATION_SIGNER_WORKFLOW_PATH))) {
            fail(
                `GA verification requires the qualification workflow at ${ATTESTATION_SIGNER_WORKFLOW_PATH}, which does not exist; ` +
                    "no attestation can match the pinned signer identity until that lane is built",
            );
        }
    }
    for (const proof of evidence.proof_artifacts) {
        const bytes = readFileSync(join(rootDir, proof.path));
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== proof.sha256) {
            fail(`proof artifact ${proof.kind}:${proof.subject} digest mismatch`);
        }
        let report: Record<string, unknown>;
        try {
            report = record(JSON.parse(bytes.toString("utf8")), `proof ${proof.path}`);
        } catch {
            fail(`proof artifact ${proof.kind}:${proof.subject} is malformed`);
        }
        exactKeys(
            report,
            [
                "schema",
                "kind",
                "subject",
                "release_version",
                "passed",
                "source",
                "observations",
            ],
            `proof ${proof.path}`,
        );
        if (
            report.schema !== "magic-context.mc-host-release-proof/v1" ||
            report.kind !== proof.kind ||
            report.subject !== proof.subject ||
            report.release_version !== evidence.release.version ||
            report.passed !== true
        ) {
            fail(`proof artifact ${proof.kind}:${proof.subject} does not match its claim`);
        }
        const source = record(report.source, `proof ${proof.path}.source`);
        exactKeys(source, ["run_url"], `proof ${proof.path}.source`);
        const runUrl = stringField(source, "run_url", `proof ${proof.path}.source`);
        if (!RUN_URL_RE.test(runUrl)) {
            fail(
                `proof artifact ${proof.kind}:${proof.subject} has no immutable ${ATTESTATION_REPO} workflow run`,
            );
        }
        const observations = record(
            report.observations,
            `proof ${proof.path}.observations`,
        );
        const registry = evidence.registry_packages.find(
            (entry) => entry.name === proof.subject,
        );
        const target = evidence.targets.find((entry) => entry.target === proof.subject);
        const targetPackageName =
            proof.kind === "target"
                ? contract.packages.payloads.find((name) =>
                      name.endsWith(proof.subject),
                  )
                : undefined;
        const targetPackage = evidence.registry_packages.find(
            (entry) => entry.name === targetPackageName,
        );
        const flow = evidence.product_flows.find(
            (entry) => entry.package === proof.subject,
        );
        const expectedObservations =
            proof.kind === "registry_package" && registry
                ? {
                      integrity: registry.integrity,
                      provenance_verified: registry.provenance_verified,
                  }
                : proof.kind === "target" && target
                  ? {
                        filesystem_verified: target.filesystem_verified,
                        lifecycle_commands: [
                            "doctor",
                            "restart",
                            "start",
                            "status",
                            "stop",
                        ],
                        lifecycle_smoke_passed: target.lifecycle_smoke_passed,
                        package_integrity: targetPackage?.integrity,
                        process_crash_atomicity_verified:
                            target.process_crash_atomicity_verified,
                        runner_arch: target.target.endsWith("arm64")
                            ? "arm64"
                            : "x64",
                        runner_os: target.target.startsWith("darwin")
                            ? "darwin"
                            : "linux",
                        self_fd_verified: target.self_fd_verified,
                        target: target.target,
                        test_report_sha256: target.test_report_sha256,
                    }
                  : proof.kind === "product_flow" && flow
                    ? {
                          cli_commands_passed: flow.cli_commands_passed,
                          managed_demand_passed: flow.managed_demand_passed,
                          offline_verified: flow.offline_verified,
                      }
                    : proof.kind === "publication"
                      ? {
                            long_lived_token_used:
                                evidence.publication.long_lived_token_used,
                            oidc_provenance_verified:
                                evidence.publication.oidc_provenance_verified,
                            payloads_before_parents:
                                evidence.publication.payloads_before_parents,
                        }
                      : proof.kind === "production_synapse"
                        ? {
                              production_synapse_verified:
                                  evidence.production_synapse_verified,
                          }
                        : null;
        if (
            expectedObservations === null ||
            canonicalJson(observations) !== canonicalJson(expectedObservations)
        ) {
            fail(`proof artifact ${proof.kind}:${proof.subject} observations drift`);
        }
        if (requireQualified) {
            const proofPath = join(rootDir, proof.path);
            const verified =
                options.verifyAttestation?.(proofPath, proof) ??
                spawnSync(
                    "gh",
                    [
                        "attestation",
                        "verify",
                        proofPath,
                        "--repo",
                        ATTESTATION_REPO,
                        "--signer-workflow",
                        ATTESTATION_SIGNER_WORKFLOW,
                    ],
                    { cwd: rootDir, stdio: "ignore" },
                ).status === 0;
            if (!verified) {
                fail(`proof artifact ${proof.kind}:${proof.subject} lacks a valid attestation`);
            }
        }
    }
    if (requireQualified && !evidence.qualified) {
        fail(`installed release evidence is not qualified: ${evidence.blockers.join("; ")}`);
    }
    return evidence;
}

function readJson(rootDir: string, relative: string): unknown {
    return JSON.parse(readFileSync(join(rootDir, relative), "utf8")) as unknown;
}

function buildTemplate(rootDir: string): InstalledReleaseEvidence {
    const contract = buildContract();
    const qualification = record(
        readJson(rootDir, QUALIFICATION_PATH),
        "qualification",
    );
    const qualificationBlockers = Array.isArray(qualification.unqualified)
        ? qualification.unqualified.filter(
              (value): value is string =>
                  typeof value === "string" && value.length > 0,
          )
        : [];
    const blockers = [
        ...(qualification.production_qualified === true
            ? []
            : [
                  `production inputs are not qualified: ${
                      qualificationBlockers.join("; ") || "reason unavailable"
                  }`,
              ]),
        "npm publication intentionally skipped; registry provenance and installed package flows are unavailable",
        "macOS targets and an exact kernel 4.18 canary have not run",
    ];
    return buildInstalledReleaseEvidence({
        contract,
        productionInputsSha256: sha256File(rootDir, INPUT_LOCK_PATH),
        qualificationSha256: sha256File(rootDir, QUALIFICATION_PATH),
        payloadIndexSha256: sha256File(rootDir, PAYLOAD_INDEX_PATH),
        stopProvenanceSha256: sha256File(rootDir, STOP_PROVENANCE_PATH),
        registryPackages: [
            ...contract.packages.payloads,
            ...contract.packages.parents,
        ].map((name) => ({
            name,
            version: contract.packages.version,
            integrity: "sha512-unverified",
            provenance_verified: false,
        })),
        targets: contract.platforms.supported.map((platform) => ({
            target: platform.target,
            filesystem_verified: false,
            self_fd_verified: false,
            process_crash_atomicity_verified: false,
            lifecycle_smoke_passed: false,
            test_report_sha256: null,
        })),
        productFlows: contract.packages.parents.map((name) => ({
            package: name,
            cli_commands_passed: false,
            managed_demand_passed: false,
            offline_verified: false,
        })),
        oidcProvenanceVerified: false,
        longLivedTokenUsed: false,
        productionSynapseVerified: false,
        proofArtifacts: [],
        qualified: false,
        blockers,
    });
}

function main(): void {
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const flag = process.argv[2] ?? "--check";
    if (flag === "--write-template") {
        const template = buildTemplate(rootDir);
        writeFileSync(join(rootDir, EVIDENCE_PATH), `${canonicalJson(template)}\n`);
        console.log(`wrote fail-closed ${EVIDENCE_PATH}`);
        return;
    }
    if (flag !== "--check" && flag !== "--check-schema") {
        console.error("usage: verify-mc-host-release-evidence.ts [--check|--check-schema|--write-template]");
        process.exit(2);
    }
    const evidence = readJson(rootDir, EVIDENCE_PATH);
    validateInstalledReleaseEvidenceAgainstArtifacts(
        rootDir,
        evidence,
        flag === "--check",
    );
    console.log(
        `checked mc-host installed release evidence (${flag === "--check" ? "GA-qualified" : "schema only"})`,
    );
}

if (import.meta.main) main();
