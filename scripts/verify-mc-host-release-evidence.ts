/**
 * Validates the installed non-GA release evidence that gates mc-host GA tags.
 *
 * `--check` requires complete qualified evidence.
 * `--check-schema` validates the schema against a contract-derived reference document before evidence exists.
 * `--write-template` refreshes the fail-closed repository template from current release artifacts.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStopRecord, validateTrustIndex } from "./build-mc-host-payload";
import {
    buildContract,
    canonicalJson,
    type ReleaseContract,
    sha256Hex,
} from "./generate-mc-host-release-manifest";
import {
    isPlaceholderSha256,
    OUTPUT_PATHS as U9_OUTPUT_PATHS,
    requireQualificationEvidence,
} from "./qualify-mc-host-production-inputs";

const EVIDENCE_PATH = "tmp/mc-host-installed-release-evidence.json";
// Use `U9_OUTPUT_PATHS.evidence` so moving the artifact cannot desynchronize its writer and GA verifier.
const QUALIFICATION_PATH = U9_OUTPUT_PATHS.evidence;
const INPUT_LOCK_PATH = "release/mc-host-production-inputs.lock.json";
const PAYLOAD_INDEX_PATH = "release/mc-host-payload-index.json";
const STOP_PROVENANCE_PATH = "release/mc-host-n-minus-one-stop.json";
const SHA256_RE = /^[0-9a-f]{64}$/;
export const QUALIFICATION_WORKFLOW_PATH = ".github/workflows/mc-host-release-qualification.yml";
const EXPECTED_REPOSITORY = "ahrav/magic-context";
const TEST_REPORT_DIR = "tmp/mc-host-test-reports/";
const TEST_REPORT_SCHEMA = "magic-context.mc-host-test-report/v1";
const REGISTRY_GATE_PATH = "release/mc-host-registry-gate.json";

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
     * `test_report_sha256` records the target test-report digest independently of the proof so their values can be compared.
     *
     * `null` means no report digest was captured; the proof must also contain `null`.
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

export interface WorkflowSource {
    runUrl: string;
    repository: string;
    headSha: string;
    workflow: string;
}

/**
 * Returns the run ID claimed by an immutable GitHub run URL under `source.repository`; otherwise returns `undefined`.
 *
 * Match the GitHub origin and `source.repository` to reject run IDs borrowed from another host or repository.
 * `attempt` is signed into the certificate, not included in `runUrl`.
 */
function claimedRunId(source: WorkflowSource): string | undefined {
    const prefix = `https://github.com/${source.repository}/actions/runs/`;
    if (!source.runUrl.startsWith(prefix)) return undefined;
    return source.runUrl.slice(prefix.length).match(/^(\d+)$/)?.[1];
}

export function workflowRunApiPath(source: WorkflowSource): string | null {
    const runId = claimedRunId(source);
    return runId === undefined ? null : `repos/${source.repository}/actions/runs/${runId}`;
}

/**
 * Returns every matching attempt, deduplicated and ordered by attempt number.
 *
 * Require `attempt` because a run-level conclusion covers only its latest attempt.
 * Without `attempt`, a successful rerun could bless artifacts signed by a failed attempt.
 *
 * A digest can have multiple verified attestations, so return every matching attempt.
 * A rerun can attest the same digest in failed and successful attempts because `run_url` omits `attempt`.
 * `gh attestation verify` emits one array entry per verified attestation and does not guarantee ordering.
 * Return every matching attempt because `gh attestation verify` does not guarantee ordering.
 * A failed attempt can be selected based on undocumented array order.
 * Callers intersect the matching-attempt sets for every artifact.
 */
function matchedAttestationAttempts(
    value: unknown,
    source: WorkflowSource,
    artifactSha256: string,
): string[] {
    const attempts = new Set<string>();
    if (!Array.isArray(value) || value.length === 0) return [];
    const runId = claimedRunId(source);
    if (runId === undefined) return [];
    for (const entry of value) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const verificationResult = (entry as Record<string, unknown>).verificationResult;
        if (
            verificationResult === null ||
            typeof verificationResult !== "object" ||
            Array.isArray(verificationResult)
        ) {
            continue;
        }
        const signature = (verificationResult as Record<string, unknown>).signature;
        if (signature === null || typeof signature !== "object" || Array.isArray(signature)) {
            continue;
        }
        const certificate = (signature as Record<string, unknown>).certificate;
        if (
            certificate === null ||
            typeof certificate !== "object" ||
            Array.isArray(certificate)
        ) {
            continue;
        }
        const fields = certificate as Record<string, unknown>;
        const statement = (verificationResult as Record<string, unknown>).statement;
        if (statement === null || typeof statement !== "object" || Array.isArray(statement)) {
            continue;
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
        // `invocationPrefix` includes the expected origin, repository, and run ID so another repository's `/attempts/<n>` suffix cannot match.
        const invocationPrefix = `https://github.com/${source.repository}/actions/runs/${runId}/attempts/`;
        const attempt =
            typeof runInvocationUri === "string" &&
            runInvocationUri.startsWith(invocationPrefix)
                ? runInvocationUri.slice(invocationPrefix.length).match(/^(\d+)$/)?.[1]
                : undefined;
        if (attempt === undefined) continue;
        if (
            fields.sourceRepositoryURI === `https://github.com/${source.repository}` &&
            fields.sourceRepositoryDigest === source.headSha &&
            typeof fields.buildConfigURI === "string" &&
            fields.buildConfigURI.split("@", 1)[0] ===
                `https://github.com/${source.repository}/${source.workflow}` &&
            artifactMatches
        ) {
            attempts.add(attempt);
        }
    }
    return [...attempts].sort((a, b) => Number(a) - Number(b));
}

/**
 * `gh attestation verify` returns the parsed bundle or `null` when its subprocess or output is unusable.
 * `null` can also indicate unusable verification output.
 */
function ghAttestationJson(
    rootDir: string,
    artifactPath: string,
    source: WorkflowSource,
): unknown {
    const result = spawnSync(
        "gh",
        [
            "attestation",
            "verify",
            artifactPath,
            "--repo",
            EXPECTED_REPOSITORY,
            "--source-digest",
            source.headSha,
            "--signer-workflow",
            `${EXPECTED_REPOSITORY}/${QUALIFICATION_WORKFLOW_PATH}`,
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

/**
 *
 * The workflow path comparison accepts both a bare path and a path suffixed with `@<ref>`.
 * GitHub may report a run attempt's `path` as `.github/workflows/build.yml@main`.
 * GitHub may return a bare workflow path for a directly triggered workflow.
 * The ref is mutable; `head_sha` provides the separately checked immutable binding.
 */
export function workflowRunAttemptMatchesSource(
    observed: Record<string, unknown>,
    source: WorkflowSource,
    attempt: string,
): boolean {
    return (
        observed.head_sha === source.headSha &&
        typeof observed.path === "string" &&
        observed.path.split("@", 1)[0] === source.workflow &&
        String(observed.run_attempt) === attempt
    );
}

/**
 *
 * `detail` distinguishes missing `gh`, authentication, or `actions: read` failures from negative verdicts so blocked releases are not reported as tampered evidence.
 */
function verifyWorkflowRunAttempt(
    rootDir: string,
    source: WorkflowSource,
    attempt: string,
): { ok: boolean; detail: string } {
    const apiPath = workflowRunApiPath(source);
    if (apiPath === null) return { ok: false, detail: "unparsable run url" };
    const result = spawnSync("gh", ["api", `${apiPath}/attempts/${attempt}`], {
        cwd: rootDir,
        encoding: "utf8",
    });
    if (result.status !== 0) {
        const stderr = (result.stderr ?? "").trim().split("\n").at(-1) ?? "";
        return {
            ok: false,
            detail: `gh api exit ${String(result.status)}${stderr === "" ? "" : `: ${stderr}`}`,
        };
    }
    let observed: Record<string, unknown>;
    try {
        observed = record(JSON.parse(result.stdout), "workflow run verification");
    } catch {
        return { ok: false, detail: "unparsable gh api response" };
    }
    if (observed.conclusion !== "success") {
        return { ok: false, detail: `attempt ${attempt} concluded ${String(observed.conclusion)}` };
    }
    if (!workflowRunAttemptMatchesSource(observed, source, attempt)) {
        return { ok: false, detail: `attempt ${attempt} does not match the claimed source` };
    }
    return { ok: true, detail: "" };
}

/**
 *
 * Qualified proofs share one workflow source and attempt, so the gate issues one identical `gh api` call per attempt rather than per proof.
 */
function cachedWorkflowRunCheck(
    rootDir: string,
    source: WorkflowSource,
    attempt: string,
    cache: Map<string, { ok: boolean; detail: string }>,
    override?: (source: WorkflowSource, attempt: string) => boolean,
): { ok: boolean; detail: string } {
    const key = `${workflowRunApiPath(source) ?? source.runUrl}/attempts/${attempt}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const check =
        override !== undefined
            ? { ok: override(source, attempt), detail: "injected verifier declined" }
            : verifyWorkflowRunAttempt(rootDir, source, attempt);
    cache.set(key, check);
    return check;
}

export function attestationMatchesWorkflowSource(
    value: unknown,
    source: WorkflowSource,
    artifactSha256: string,
): boolean {
    return matchedAttestationAttempts(value, source, artifactSha256).length > 0;
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
    /**
     * The independently recorded production semantic-Synapse report digest prevents a proof from witnessing itself.
     */
    production_synapse_report_sha256: string | null;
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
    productionSynapseReportSha256: string | null;
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

/** The digest operation returns null when the cited file is absent or unreadable. */
function sha256FileOrNull(rootDir: string, relative: string): string | null {
    try {
        return sha256File(rootDir, relative);
    } catch {
        return null;
    }
}

function isSafeRelativePath(path: string): boolean {
    return (
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    );
}

/**
 * target.
 *
 * The report is mandatory because deriving expected observations from observed observations would allow a proof with a null citation to pass.
 */
function verifyTargetTestReport(
    rootDir: string,
    proof: ProofArtifactRef,
    observations: Record<string, unknown>,
    seen: Map<string, string>,
): { path: string; sha256: string } {
    const identity = `proof artifact ${proof.kind}:${proof.subject}`;
    const reportPath = observations.test_report_path;
    if (
        typeof reportPath !== "string" ||
        !isSafeRelativePath(reportPath) ||
        !reportPath.startsWith(TEST_REPORT_DIR)
    ) {
        fail(`${identity} must cite a test report under ${TEST_REPORT_DIR}`);
    }
    const claimed = observations.test_report_sha256;
    if (typeof claimed !== "string" || !SHA256_RE.test(claimed)) {
        fail(`${identity} must cite a sha256 for ${reportPath}`);
    }
    const reusedBy = seen.get(reportPath);
    if (reusedBy !== undefined) {
        fail(`${identity} reuses the test report already cited by ${reusedBy}`);
    }
    const actual = sha256FileOrNull(rootDir, reportPath);
    if (actual === null) {
        fail(`${identity} cites an unreadable test report at ${reportPath}`);
    }
    if (actual !== claimed) {
        fail(`${identity} test report digest does not match ${reportPath}`);
    }
    let report: Record<string, unknown>;
    try {
        report = record(
            JSON.parse(readFileSync(join(rootDir, reportPath), "utf8")),
            `${identity} test report`,
        );
    } catch {
        fail(`${identity} cites a malformed test report at ${reportPath}`);
    }
    if (
        report.schema !== TEST_REPORT_SCHEMA ||
        report.target !== proof.subject ||
        report.passed !== true
    ) {
        fail(`${identity} test report does not attest a passing ${proof.subject}`);
    }
    seen.set(reportPath, proof.subject);
    return { path: reportPath, sha256: claimed };
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
 *
 * `publication.payloads_before_parents` is meaningful only when the builder and verifier derive it from the same package order.
 * The verifier must derive the boolean from `names` with the builder's ordering rule.
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
        production_synapse_report_sha256: options.productionSynapseReportSha256,
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
            "production_synapse_report_sha256",
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
    // `payloadsBeforeParents` must derive the boolean from `names`; otherwise a parents-first list could claim `true`.
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
    const synapseReport = evidence.production_synapse_report_sha256;
    if (
        synapseReport !== null &&
        (typeof synapseReport !== "string" || !SHA256_RE.test(synapseReport))
    ) {
        fail(
            "production_synapse_report_sha256 must be lowercase SHA-256 or null",
        );
    }

    if (qualified && (!allProofsPass || blockers.length !== 0)) {
        fail("qualified evidence contains a failed proof or blocker");
    }
    if (qualified) {
        if (synapseReport === null || isPlaceholderSha256(synapseReport)) {
            fail(
                "qualified evidence must record a real production_synapse_report_sha256",
            );
        }
        for (const target of targets) {
            if (
                target.test_report_sha256 === null ||
                isPlaceholderSha256(target.test_report_sha256)
            ) {
                fail(
                    `qualified evidence must record a real test_report_sha256 for ${target.target}`,
                );
            }
        }
    }
    if (!qualified && blockers.length === 0) {
        fail("unqualified evidence must name at least one blocker");
    }
    return evidence as unknown as InstalledReleaseEvidence;
}

/**
 * Evidence requires each cited artifact to be release-qualified.
 *
 * Parsing cited artifacts prevents `qualified: true` from overriding contradictory artifact contents.
 * Parsing requires cited qualification runs to record `production_qualified: true` before the GA gate clears.
 *
 *
 * `release:qualify:check` validates input-lock byte citations and payload manifest/launcher digests.
 * `release:qualify:check` and `release:payload:check` validate input-lock citations and payload manifest and launcher digests.
 * `release:qualify:check` and `release:payload:check` must remain the only qualification and payload validators to prevent divergent implementations.
 * `release:qualify:check` and `release:payload:check` must remain the only qualification and payload validators to prevent divergent implementations.
 * Evidence validation rejects evidence bytes that stand in for the qualification and payload artifacts.
 */
function assertCitedArtifactsQualified(
    rootDir: string,
    contract: ReleaseContract,
    expectedContractDigest: string,
    requireQualification: (
        rootDir: string,
    ) => { u8Digest: string; lockSha256: string },
): void {
    const { u8Digest, lockSha256 } = requireQualification(rootDir);
    const qualification = record(
        readJson(rootDir, QUALIFICATION_PATH),
        "cited qualification",
    );
    if (qualification.release_contract_sha256 !== expectedContractDigest) {
        fail("cited qualification was produced against a different release contract");
    }

    //
    // `validateTrustIndex` requires `publication.published === false` for the build-time payload index.
    //
    // `productionQualified: true` relies on `requireQualification` to derive the verdict from input-lock bytes.
    const lock = record(readJson(rootDir, INPUT_LOCK_PATH), "cited input lock");
    validateTrustIndex(readJson(rootDir, PAYLOAD_INDEX_PATH), {
        contract,
        u8Digest,
        lockSha256,
        productionQualified: true,
        lock: lock as unknown as Parameters<typeof validateTrustIndex>[1]["lock"],
    });
    const payloadIndex = record(
        readJson(rootDir, PAYLOAD_INDEX_PATH),
        "cited payload index",
    );
    if (payloadIndex.release_contract_sha256 !== expectedContractDigest) {
        fail("cited payload index was produced against a different release contract");
    }

    const gate = record(
        readJson(rootDir, REGISTRY_GATE_PATH),
        "cited registry gate",
    );
    const reservationVersions = (
        Array.isArray(gate.packages) ? gate.packages : []
    )
        .map((entry) =>
            typeof entry === "object" && entry !== null
                ? (entry as Record<string, unknown>).reservation_version
                : undefined,
        )
        .filter((version): version is string => typeof version === "string");
    // `null` is required because the first payload-bearing release may descend only from genesis.
    // `runCheck` requires each subsequent payload release to use its actual N-1 predecessor.
    validateStopRecord(
        readJson(rootDir, STOP_PROVENANCE_PATH),
        { contract, reservationVersions },
        null,
    );
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
            attempt: string,
        ) => boolean;
        verifyInstalledEvidenceAttestation?: (
            path: string,
            source: WorkflowSource,
            sha256: string,
        ) => unknown;
        expectedHeadSha?: string;
        /**
         * Tests stub `requireQualification`; production uses `requireQualificationEvidence` by default.
         * Tests that do not exercise qualification stub `requireQualification`.
         * `--check` uses `requireQualificationEvidence`, so GA runs the full validator.
         */
        requireQualification?: (
            rootDir: string,
        ) => { u8Digest: string; lockSha256: string };
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
    // Every qualified proof must cite `QUALIFICATION_WORKFLOW_PATH`.
    // A checkout without `QUALIFICATION_WORKFLOW_PATH` cannot produce or reproduce the attested evidence.
    // The validator checks for `QUALIFICATION_WORKFLOW_PATH` before per-proof verification to report the missing workflow directly.
    // The validator checks for `QUALIFICATION_WORKFLOW_PATH` before per-proof verification to report the missing workflow directly.
    if (requireQualified && !existsSync(join(rootDir, QUALIFICATION_WORKFLOW_PATH))) {
        fail(
            `qualification workflow ${QUALIFICATION_WORKFLOW_PATH} does not exist in this checkout`,
        );
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
    let qualifiedAttempts: string[] | null = null;
    const citedTestReports = new Map<string, string>();
    const workflowRunChecks = new Map<string, { ok: boolean; detail: string }>();
    if (requireQualified) {
        assertCitedArtifactsQualified(
            rootDir,
            contract,
            evidence.release_contract_sha256,
            options.requireQualification ?? requireQualificationEvidence,
        );
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
            repository !== EXPECTED_REPOSITORY ||
            claimedRunId({ runUrl, repository, headSha, workflow }) === undefined ||
            !/^[0-9a-f]{40}$/.test(headSha) ||
            (requireQualified && headSha !== expectedHeadSha) ||
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
        const verifiedTestReport =
            proof.kind === "target" && target
                ? verifyTargetTestReport(rootDir, proof, observations, citedTestReports)
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
                        test_report_path: verifiedTestReport?.path ?? null,
                        test_report_sha256: target.test_report_sha256,
                    }
                  : proof.kind === "product_flow" && flow
                    ? {
                          cli_commands_passed: flow.cli_commands_passed,
                          managed_demand_passed: flow.managed_demand_passed,
                          // The flow proof must identify the artifact whose behavior it exercises.
                          // A source checkout, staged tarball, and stale install would otherwise produce identical proofs.
                          // The registry proof establishes that a package with the recorded integrity exists.
                          // The proof must name the package integrity to bind the package bytes to observed behavior.
                          // Target proofs already carry `package_integrity` to bind behavior to package bytes.
                          // reason.
                          package_integrity: evidence.registry_packages.find(
                              (entry) => entry.name === flow.package,
                          )?.integrity,
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
                              // The production semantic proof must identify the bytes that ran the semantic lane.
                              // A source checkout, staged payload, and stale install would otherwise produce identical proofs.
                              // The Linux payload integrity and semantic report digest bind the result to the selected artifact bytes.
                              package_integrity:
                                  evidence.registry_packages.find((entry) =>
                                      entry.name.endsWith("linux-x64-gnu"),
                                  )?.integrity,
                              production_synapse_report_sha256:
                                  evidence.production_synapse_report_sha256,
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
            // The validator defers the run check because one artifact cannot identify the shared attempt that succeeded.
            const attestationResult =
                options.verifyAttestation !== undefined
                    ? options.verifyAttestation(proofPath, proof, workflowSource)
                    : ghAttestationJson(rootDir, proofPath, workflowSource);
            const attempts = matchedAttestationAttempts(
                attestationResult,
                workflowSource,
                proof.sha256,
            );
            if (attempts.length === 0) {
                fail(`proof artifact ${proof.kind}:${proof.subject} lacks a valid attestation`);
            }
            qualifiedAttempts =
                qualifiedAttempts === null
                    ? attempts
                    : qualifiedAttempts.filter((candidate) => attempts.includes(candidate));
            if (qualifiedAttempts.length === 0) {
                fail("qualified proof artifacts must share one workflow run attempt");
            }
        }
    }
    if (requireQualified) {
        if (qualifiedSource === null) {
            fail("qualified evidence has no attested workflow source");
        }
        const installedEvidencePath = join(rootDir, EVIDENCE_PATH);
        const installedEvidenceBytes = readFileSync(installedEvidencePath);
        // Malformed bytes must produce a structured validation failure instead of a `SyntaxError`.
        let installedEvidenceValue: unknown;
        try {
            installedEvidenceValue = JSON.parse(installedEvidenceBytes.toString("utf8"));
        } catch {
            fail(`installed release evidence at ${EVIDENCE_PATH} is malformed JSON`);
        }
        if (canonicalJson(installedEvidenceValue) !== canonicalJson(evidence)) {
            fail("installed release evidence bytes differ from the validated value");
        }
        const installedEvidenceSha256 = createHash("sha256")
            .update(installedEvidenceBytes)
            .digest("hex");
        const attestationResult =
            options.verifyInstalledEvidenceAttestation !== undefined
                ? options.verifyInstalledEvidenceAttestation(
                      installedEvidencePath,
                      qualifiedSource,
                      installedEvidenceSha256,
                  )
                : ghAttestationJson(rootDir, installedEvidencePath, qualifiedSource);
        const installedAttempts = matchedAttestationAttempts(
            attestationResult,
            qualifiedSource,
            installedEvidenceSha256,
        );
        if (installedAttempts.length === 0) {
            fail("installed release evidence lacks a valid attestation");
        }
        const sharedAttempts = (qualifiedAttempts ?? []).filter((candidate) =>
            installedAttempts.includes(candidate),
        );
        if (sharedAttempts.length === 0) {
            fail("installed release evidence was attested by a different workflow run attempt");
        }
        // At least one shared attempt must have concluded successfully.
        let verifiedAttempt: string | null = null;
        let lastDetail = "";
        for (const candidate of sharedAttempts) {
            const runCheck = cachedWorkflowRunCheck(
                rootDir,
                qualifiedSource,
                candidate,
                workflowRunChecks,
                options.verifyWorkflowRun,
            );
            if (runCheck.ok) {
                verifiedAttempt = candidate;
                break;
            }
            lastDetail = runCheck.detail;
        }
        if (verifiedAttempt === null) {
            fail(`attested workflow run is unverified (${lastDetail})`);
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

interface CitedArtifactDigests {
    productionInputsSha256: string;
    qualificationSha256: string;
    payloadIndexSha256: string;
    stopProvenanceSha256: string;
}

/**
 *
 */
function buildFailClosedEvidence(
    digests: CitedArtifactDigests,
    blockers: string[],
): InstalledReleaseEvidence {
    const contract = buildContract();
    return buildInstalledReleaseEvidence({
        contract,
        productionInputsSha256: digests.productionInputsSha256,
        qualificationSha256: digests.qualificationSha256,
        payloadIndexSha256: digests.payloadIndexSha256,
        stopProvenanceSha256: digests.stopProvenanceSha256,
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
        productionSynapseReportSha256: null,
        proofArtifacts: [],
        qualified: false,
        blockers,
    });
}

function buildTemplate(rootDir: string): InstalledReleaseEvidence {
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
    return buildFailClosedEvidence(
        {
            productionInputsSha256: sha256File(rootDir, INPUT_LOCK_PATH),
            qualificationSha256: sha256File(rootDir, QUALIFICATION_PATH),
            payloadIndexSha256: sha256File(rootDir, PAYLOAD_INDEX_PATH),
            stopProvenanceSha256: sha256File(rootDir, STOP_PROVENANCE_PATH),
        },
        [
            ...(qualification.production_qualified === true
                ? []
                : [
                      `production inputs are not qualified: ${
                          qualificationBlockers.join("; ") || "reason unavailable"
                      }`,
                  ]),
            "npm publication intentionally skipped; registry provenance and installed package flows are unavailable",
            "macOS targets and an exact kernel 4.18 canary have not run",
        ],
    );
}

/**
 * contract alone.
 *
 */
export function schemaReferenceEvidence(): InstalledReleaseEvidence {
    const placeholder = "0".repeat(64);
    return buildFailClosedEvidence(
        {
            productionInputsSha256: placeholder,
            qualificationSha256: placeholder,
            payloadIndexSha256: placeholder,
            stopProvenanceSha256: placeholder,
        },
        ["schema reference document cites no release artifact"],
    );
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
    if (flag === "--check-schema") {
        validateInstalledReleaseEvidence(schemaReferenceEvidence());
        console.log("checked mc-host installed release evidence (schema only)");
        return;
    }
    const evidence = readJson(rootDir, EVIDENCE_PATH);
    validateInstalledReleaseEvidenceAgainstArtifacts(rootDir, evidence, true);
    console.log("checked mc-host installed release evidence (GA-qualified)");
}

if (import.meta.main) main();
