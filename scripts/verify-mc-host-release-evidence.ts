/**
 * Validates the installed non-GA release evidence that gates mc-host GA tags.
 *
 * `--check` requires complete qualified evidence. `--write-template` refreshes
 * the fail-closed repository template from the current release artifacts.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    buildContract,
    canonicalJson,
    type ReleaseContract,
    sha256Hex,
} from "./generate-mc-host-release-manifest";

const EVIDENCE_PATH = "tmp/mc-host-installed-release-evidence.json";
const QUALIFICATION_PATH = "tmp/mc-host-release-qualification.json";
const INPUT_LOCK_PATH = "release/mc-host-production-inputs.lock.json";
const PAYLOAD_INDEX_PATH = "release/mc-host-payload-index.json";
const STOP_PROVENANCE_PATH = "release/mc-host-n-minus-one-stop.json";
const SHA256_RE = /^[0-9a-f]{64}$/;
const QUALIFICATION_WORKFLOW_PATH = ".github/workflows/mc-host-release-qualification.yml";

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

export interface WorkflowSource {
    runUrl: string;
    repository: string;
    headSha: string;
    workflow: string;
}

export function workflowRunApiPath(source: WorkflowSource): string | null {
    const runId = source.runUrl.match(/\/actions\/runs\/(\d+)$/)?.[1];
    return runId === undefined ? null : `repos/${source.repository}/actions/runs/${runId}`;
}

function attestationCertificateMatches(
    value: unknown,
    source: WorkflowSource,
    artifactSha256: string,
): boolean {
    if (!Array.isArray(value) || value.length === 0) return false;
    const claimedRunId = source.runUrl.match(/\/actions\/runs\/(\d+)$/)?.[1];
    if (claimedRunId === undefined) return false;
    return value.some((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
        const verificationResult = (entry as Record<string, unknown>).verificationResult;
        if (
            verificationResult === null ||
            typeof verificationResult !== "object" ||
            Array.isArray(verificationResult)
        ) {
            return false;
        }
        const signature = (verificationResult as Record<string, unknown>).signature;
        if (signature === null || typeof signature !== "object" || Array.isArray(signature)) {
            return false;
        }
        const certificate = (signature as Record<string, unknown>).certificate;
        if (
            certificate === null ||
            typeof certificate !== "object" ||
            Array.isArray(certificate)
        ) {
            return false;
        }
        const fields = certificate as Record<string, unknown>;
        const statement = (verificationResult as Record<string, unknown>).statement;
        if (statement === null || typeof statement !== "object" || Array.isArray(statement)) {
            return false;
        }
        const subjects = (statement as Record<string, unknown>).subject;
        const artifactMatches =
            Array.isArray(subjects) &&
            subjects.some((subject) => {
                if (subject === null || typeof subject !== "object" || Array.isArray(subject)) {
                    return false;
                }
                const digest = (subject as Record<string, unknown>).digest;
                return (
                    digest !== null &&
                    typeof digest === "object" &&
                    !Array.isArray(digest) &&
                    (digest as Record<string, unknown>).sha256 === artifactSha256
                );
            });
        const runInvocationUri = fields.runInvocationURI;
        const attestedRunId =
            typeof runInvocationUri === "string"
                ? runInvocationUri.match(/\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?$/)?.[1]
                : undefined;
        return (
            fields.sourceRepositoryURI === `https://github.com/${source.repository}` &&
            fields.sourceRepositoryDigest === source.headSha &&
            typeof fields.buildConfigURI === "string" &&
            fields.buildConfigURI.split("@", 1)[0] ===
                `https://github.com/${source.repository}/${source.workflow}` &&
            artifactMatches &&
            attestedRunId === claimedRunId
        );
    });
}

export function attestationMatchesWorkflowSource(
    value: unknown,
    source: WorkflowSource,
    artifactSha256: string,
): boolean {
    return attestationCertificateMatches(value, source, artifactSha256);
}

function verifyAttestationWithGitHub(
    rootDir: string,
    path: string,
    source: WorkflowSource,
): unknown {
    const result = spawnSync(
        "gh",
        [
            "attestation",
            "verify",
            path,
            "--repo",
            source.repository,
            "--source-digest",
            source.headSha,
            "--signer-workflow",
            `${source.repository}/${source.workflow}`,
            "--format",
            "json",
        ],
        { cwd: rootDir, encoding: "utf8" },
    );
    if (result.status !== 0) return null;
    try {
        return JSON.parse(result.stdout) as unknown;
    } catch {
        return null;
    }
}

export function resolveAttestationVerification(
    injected: (() => unknown) | undefined,
    fallback: () => unknown,
): unknown {
    return injected === undefined ? fallback() : injected();
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

function isSafeRelativePath(path: string): boolean {
    return (
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    );
}

function validateTargetTestReport(
    rootDir: string,
    observations: Record<string, unknown>,
    target: string,
): { path: string; sha256: string } {
    const path = stringField(observations, "test_report_path", "target observations");
    const sha256 = stringField(observations, "test_report_sha256", "target observations");
    if (!isSafeRelativePath(path) || !SHA256_RE.test(sha256)) {
        fail("target test report path or digest is invalid");
    }
    let report: Record<string, unknown>;
    try {
        report = record(
            JSON.parse(readFileSync(join(rootDir, path), "utf8")),
            "target test report",
        );
    } catch {
        fail("target test report is missing or malformed");
    }
    exactKeys(report, ["schema", "target", "passed"], "target test report");
    if (
        report.schema !== "magic-context.mc-host-test-report/v1" ||
        report.target !== target ||
        report.passed !== true ||
        sha256File(rootDir, path) !== sha256
    ) {
        fail("target test report does not prove a passing run for its target");
    }
    return { path, sha256 };
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

export function buildInstalledReleaseEvidence(
    options: BuildInstalledReleaseEvidenceOptions,
): InstalledReleaseEvidence {
    const payloadsBeforeParents =
        options.registryPackages
            .map((entry) => entry.name)
            .join("\n") ===
        [...options.contract.packages.payloads, ...options.contract.packages.parents].join("\n");
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
            payloads_before_parents: payloadsBeforeParents,
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
            ],
            `targets[${index}]`,
        );
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
        if (!isSafeRelativePath(path) || !path.startsWith("tmp/mc-host-release-proofs/")) {
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

export function validateInstalledReleaseEvidenceAgainstArtifacts(
    rootDir: string,
    value: unknown,
    requireQualified: boolean,
    options: {
        verifyAttestation?: (
            path: string,
            proof: ProofArtifactRef,
            source: WorkflowSource,
        ) => unknown;
        verifyWorkflowRun?: (
            source: WorkflowSource,
            proof: ProofArtifactRef,
        ) => boolean;
        verifyInstalledEvidenceAttestation?: (
            path: string,
            source: WorkflowSource,
            sha256: string,
        ) => unknown;
        expectedHeadSha?: string;
    } = {},
): InstalledReleaseEvidence {
    const evidence = validateInstalledReleaseEvidence(value);
    const contract = buildContract();
    const expectedHeadSha =
        options.expectedHeadSha ??
        (() => {
            const result = spawnSync("git", ["rev-parse", "HEAD"], {
                cwd: rootDir,
                encoding: "utf8",
            });
            return result.status === 0 ? result.stdout.trim() : "";
        })();
    if (requireQualified && !/^[0-9a-f]{40}$/.test(expectedHeadSha)) {
        fail("cannot bind qualified evidence to the current release commit");
    }
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
    let qualifiedSource: WorkflowSource | null = null;
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
        exactKeys(
            source,
            ["run_url", "repository", "head_sha", "workflow"],
            `proof ${proof.path}.source`,
        );
        const runUrl = stringField(source, "run_url", `proof ${proof.path}.source`);
        const repository = stringField(source, "repository", `proof ${proof.path}.source`);
        const headSha = stringField(source, "head_sha", `proof ${proof.path}.source`);
        const workflow = stringField(source, "workflow", `proof ${proof.path}.source`);
        if (
            !/^https:\/\/github\.com\/ahrav\/magic-context\/actions\/runs\/\d+$/.test(runUrl) ||
            repository !== "ahrav/magic-context" ||
            !/^[0-9a-f]{40}$/.test(headSha) ||
            headSha !== expectedHeadSha ||
            workflow !== QUALIFICATION_WORKFLOW_PATH
        ) {
            fail(`proof artifact ${proof.kind}:${proof.subject} has no immutable workflow run`);
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
        const targetTestReport =
            proof.kind === "target" && target
                ? validateTargetTestReport(rootDir, observations, target.target)
                : null;
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
                        test_report_path: targetTestReport?.path ?? null,
                        test_report_sha256: targetTestReport?.sha256 ?? null,
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
            const workflowSource = {
                runUrl,
                repository,
                headSha,
                workflow,
            };
            if (
                qualifiedSource !== null &&
                canonicalJson(qualifiedSource) !== canonicalJson(workflowSource)
            ) {
                fail("qualified proof artifacts must share one workflow source");
            }
            qualifiedSource = workflowSource;
            const workflowVerified =
                options.verifyWorkflowRun?.(workflowSource, proof) ??
                (() => {
                    const apiPath = workflowRunApiPath(workflowSource);
                    if (apiPath === null) return false;
                    const result = spawnSync(
                        "gh",
                        ["api", apiPath],
                        { cwd: rootDir, encoding: "utf8" },
                    );
                    if (result.status !== 0) return false;
                    try {
                        const observed = record(
                            JSON.parse(result.stdout),
                            "workflow run verification",
                        );
                        return (
                            observed.conclusion === "success" &&
                            observed.head_sha === headSha &&
                            observed.html_url === runUrl &&
                            observed.path === workflow
                        );
                    } catch {
                        return false;
                    }
                })();
            if (!workflowVerified) {
                fail(`proof artifact ${proof.kind}:${proof.subject} workflow run is unverified`);
            }
            const attestationResult = resolveAttestationVerification(
                options.verifyAttestation === undefined
                    ? undefined
                    : () => options.verifyAttestation?.(proofPath, proof, workflowSource),
                () => verifyAttestationWithGitHub(rootDir, proofPath, workflowSource),
            );
            const verified = attestationCertificateMatches(
                attestationResult,
                workflowSource,
                proof.sha256,
            );
            if (!verified) {
                fail(`proof artifact ${proof.kind}:${proof.subject} lacks a valid attestation`);
            }
        }
    }
    if (requireQualified) {
        if (qualifiedSource === null) {
            fail("qualified evidence has no attested workflow source");
        }
        const installedEvidencePath = join(rootDir, EVIDENCE_PATH);
        const installedEvidenceBytes = readFileSync(installedEvidencePath);
        if (
            canonicalJson(JSON.parse(installedEvidenceBytes.toString("utf8"))) !==
            canonicalJson(evidence)
        ) {
            fail("installed release evidence bytes differ from the validated value");
        }
        const installedEvidenceSha256 = createHash("sha256")
            .update(installedEvidenceBytes)
            .digest("hex");
        const attestationResult = resolveAttestationVerification(
            options.verifyInstalledEvidenceAttestation === undefined
                ? undefined
                : () =>
                      options.verifyInstalledEvidenceAttestation?.(
                          installedEvidencePath,
                          qualifiedSource,
                          installedEvidenceSha256,
                      ),
            () =>
                verifyAttestationWithGitHub(
                    rootDir,
                    installedEvidencePath,
                    qualifiedSource,
                ),
        );
        if (
            !attestationCertificateMatches(
                attestationResult,
                qualifiedSource,
                installedEvidenceSha256,
            )
        ) {
            fail("installed release evidence lacks a valid attestation");
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
        console.error(
            "usage: verify-mc-host-release-evidence.ts [--check|--check-schema|--write-template]",
        );
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
