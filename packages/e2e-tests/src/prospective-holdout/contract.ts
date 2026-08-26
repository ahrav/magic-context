import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";

export const FREEZE_SCHEMA = "prospective-release-freeze/v1";
export const CLOSE_SCHEMA = "prospective-cohort-close/v1";
export const POLICY_OWNER_SCHEMA = "prospective-policy-owner/v1";
export const TRUST_ENTRY_SCHEMA = "prospective-trust-entry/v1";

export const HEX64_RE = /^[0-9a-f]{64}$/;
export const EPOCH_ID_RE = /^epoch-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CASE_ID_RE = /^case-[0-9a-f]{32}$/;
export const INTAKE_ID_RE = /^intake-[0-9a-f]{32}$/;
export const FAMILY_ID_RE = /^fam-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATIC_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELEASE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class HoldoutContractError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: readonly string[]) {
        super([...diagnostics].sort().join("; "));
        this.diagnostics = [...diagnostics].sort();
    }
}

export function fail(code: string): never {
    throw new HoldoutContractError([code]);
}

export function record(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${label}: object-required`);
    }
    return value as Record<string, unknown>;
}

export function exact(recordValue: Record<string, unknown>, keys: readonly string[], label: string): void {
    const actual = Object.keys(recordValue).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label}: fields-invalid`);
    }
}

export function string(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) fail(`${label}: string-invalid`);
    return value;
}

export function staticId(value: unknown, label: string, pattern: RegExp = STATIC_ID_RE): string {
    const result = string(value, label);
    if (!pattern.test(result)) fail(`${label}: id-invalid`);
    return result;
}

export function hex64(value: unknown, label: string): string {
    const result = string(value, label);
    if (!HEX64_RE.test(result)) fail(`${label}: fingerprint-invalid`);
    return result;
}

export function instant(value: unknown, label: string): string {
    const result = string(value, label);
    if (!ISO_INSTANT_RE.test(result) || !Number.isFinite(Date.parse(result))) {
        fail(`${label}: instant-invalid`);
    }
    return result;
}

export function enumeration<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${label}: enum-invalid`);
    return value as T;
}

export function array(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) fail(`${label}: array-required`);
    return value;
}

export function integer(value: unknown, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${label}: integer-invalid`);
    return value as number;
}

function unique(values: readonly string[], label: string): void {
    if (new Set(values).size !== values.length) fail(`${label}: duplicate`);
}

export const BUILD_ROLES = ["release-n", "release-n-minus-1"] as const;
export type BuildRole = (typeof BUILD_ROLES)[number];

export interface FrozenReleaseIdentity {
    role: BuildRole;
    releaseId: string;
    channel: string;
    platformMatrix: string[];
    immutableReference: string;
    releaseRootManifestFingerprint: string;
    sourceFingerprint: string;
    lockfileFingerprint: string;
    artifactFingerprint: string;
    runtimeFingerprint: string;
    harnessFingerprint: string;
}

function parseReleaseIdentity(raw: unknown, label: string): FrozenReleaseIdentity {
    const value = record(raw, label);
    exact(value, [
        "role",
        "releaseId",
        "channel",
        "platformMatrix",
        "immutableReference",
        "releaseRootManifestFingerprint",
        "sourceFingerprint",
        "lockfileFingerprint",
        "artifactFingerprint",
        "runtimeFingerprint",
        "harnessFingerprint",
    ], label);
    const platformMatrix = array(value.platformMatrix, `${label}.platformMatrix`).map((entry, index) =>
        staticId(entry, `${label}.platformMatrix[${index}]`),
    );
    if (platformMatrix.length === 0) fail(`${label}.platformMatrix: empty`);
    unique(platformMatrix, `${label}.platformMatrix`);
    return {
        role: enumeration(value.role, BUILD_ROLES, `${label}.role`),
        releaseId: staticId(value.releaseId, `${label}.releaseId`, RELEASE_ID_RE),
        channel: staticId(value.channel, `${label}.channel`),
        platformMatrix,
        immutableReference: staticId(value.immutableReference, `${label}.immutableReference`, /^[a-z0-9]+:[0-9a-f]{40,64}$/),
        releaseRootManifestFingerprint: hex64(value.releaseRootManifestFingerprint, `${label}.releaseRootManifestFingerprint`),
        sourceFingerprint: hex64(value.sourceFingerprint, `${label}.sourceFingerprint`),
        lockfileFingerprint: hex64(value.lockfileFingerprint, `${label}.lockfileFingerprint`),
        artifactFingerprint: hex64(value.artifactFingerprint, `${label}.artifactFingerprint`),
        runtimeFingerprint: hex64(value.runtimeFingerprint, `${label}.runtimeFingerprint`),
        harnessFingerprint: hex64(value.harnessFingerprint, `${label}.harnessFingerprint`),
    };
}

export type PolicyOwner = "magic-context-x4l.14" | "magic-context-x4l.15";
export interface PolicyBinding {
    owner: PolicyOwner;
    schemaVersion: string;
    policyFingerprint: string;
}

function parsePolicyBinding(raw: unknown, owner: PolicyOwner, label: string): PolicyBinding {
    const value = record(raw, label);
    exact(value, ["owner", "schemaVersion", "policyFingerprint"], label);
    if (value.owner !== owner) fail(`${label}.owner: wrong-owner`);
    return {
        owner,
        schemaVersion: staticId(value.schemaVersion, `${label}.schemaVersion`, /^[a-z0-9][a-z0-9./-]+$/),
        policyFingerprint: hex64(value.policyFingerprint, `${label}.policyFingerprint`),
    };
}

export interface FreezeBody {
    epochId: string;
    releases: [FrozenReleaseIdentity, FrozenReleaseIdentity];
    policies: { analysis: PolicyBinding; scorecard: PolicyBinding };
    eligibleSuiteRegistryFingerprint: string;
    evaluatorFingerprint: string;
    intakeWindow: { opensAt: string; closesAt: string };
    admissionRubric: { version: string; rubricFingerprint: string };
    executionMatrix: {
        models: string[];
        seeds: number[];
        platforms: string[];
        decodingFingerprint: string;
        promptFingerprint: string;
    };
}

export const FREEZE_APPROVAL_KINDS = ["release-operator", "independent-review"] as const;
export const CLOSE_APPROVAL_KINDS = ["cohort-custodian", "admission-reviewer"] as const;
export type ApprovalKind = (typeof FREEZE_APPROVAL_KINDS)[number] | (typeof CLOSE_APPROVAL_KINDS)[number];
export interface BoundApproval {
    kind: ApprovalKind;
    approver: string;
    subjectFingerprint: string;
}

function parseApproval(raw: unknown, allowed: readonly ApprovalKind[], label: string): BoundApproval {
    const value = record(raw, label);
    exact(value, ["kind", "approver", "subjectFingerprint"], label);
    return {
        kind: enumeration(value.kind, allowed, `${label}.kind`),
        approver: staticId(value.approver, `${label}.approver`),
        subjectFingerprint: hex64(value.subjectFingerprint, `${label}.subjectFingerprint`),
    };
}

export interface ReleaseFreezeManifest {
    schema: typeof FREEZE_SCHEMA;
    body: FreezeBody;
    approvals: BoundApproval[];
}

export function parseFreezeManifest(raw: unknown): ReleaseFreezeManifest {
    const root = record(raw, "freeze");
    exact(root, ["schema", "body", "approvals"], "freeze");
    if (root.schema !== FREEZE_SCHEMA) fail("freeze.schema: version-invalid");
    const value = record(root.body, "freeze.body");
    exact(value, [
        "epochId",
        "releases",
        "policies",
        "eligibleSuiteRegistryFingerprint",
        "evaluatorFingerprint",
        "intakeWindow",
        "admissionRubric",
        "executionMatrix",
    ], "freeze.body");
    const releases = array(value.releases, "freeze.body.releases").map((entry, index) =>
        parseReleaseIdentity(entry, `freeze.body.releases[${index}]`),
    );
    if (releases.length !== 2) fail("freeze.body.releases: pair-required");
    if (releases[0]!.role !== "release-n" || releases[1]!.role !== "release-n-minus-1") {
        fail("freeze.body.releases: order-invalid");
    }
    if (releases[0]!.releaseId === releases[1]!.releaseId) fail("freeze.body.releases: release-id-reused");
    if (releases[0]!.immutableReference === releases[1]!.immutableReference) {
        fail("freeze.body.releases: immutable-reference-reused");
    }
    if (releases[0]!.releaseRootManifestFingerprint === releases[1]!.releaseRootManifestFingerprint) {
        fail("freeze.body.releases: release-root-manifest-reused");
    }
    if (releases[0]!.channel !== releases[1]!.channel) fail("freeze.body.releases: channel-mismatch");
    if (canonicalFingerprint(releases[0]!.platformMatrix) !== canonicalFingerprint(releases[1]!.platformMatrix)) {
        fail("freeze.body.releases: platform-matrix-mismatch");
    }
    const policies = record(value.policies, "freeze.body.policies");
    exact(policies, ["analysis", "scorecard"], "freeze.body.policies");
    const intakeWindow = record(value.intakeWindow, "freeze.body.intakeWindow");
    exact(intakeWindow, ["opensAt", "closesAt"], "freeze.body.intakeWindow");
    const opensAt = instant(intakeWindow.opensAt, "freeze.body.intakeWindow.opensAt");
    const closesAt = instant(intakeWindow.closesAt, "freeze.body.intakeWindow.closesAt");
    if (Date.parse(opensAt) >= Date.parse(closesAt)) fail("freeze.body.intakeWindow: order-invalid");
    const admissionRubric = record(value.admissionRubric, "freeze.body.admissionRubric");
    exact(admissionRubric, ["version", "rubricFingerprint"], "freeze.body.admissionRubric");
    const executionMatrix = record(value.executionMatrix, "freeze.body.executionMatrix");
    exact(executionMatrix, ["models", "seeds", "platforms", "decodingFingerprint", "promptFingerprint"], "freeze.body.executionMatrix");
    const models = array(executionMatrix.models, "freeze.body.executionMatrix.models").map((entry, index) =>
        staticId(entry, `freeze.body.executionMatrix.models[${index}]`, /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
    );
    const seeds = array(executionMatrix.seeds, "freeze.body.executionMatrix.seeds").map((entry, index) =>
        integer(entry, `freeze.body.executionMatrix.seeds[${index}]`),
    );
    const platforms = array(executionMatrix.platforms, "freeze.body.executionMatrix.platforms").map((entry, index) =>
        staticId(entry, `freeze.body.executionMatrix.platforms[${index}]`),
    );
    if (models.length === 0 || seeds.length === 0 || platforms.length === 0) fail("freeze.body.executionMatrix: empty");
    unique(models, "freeze.body.executionMatrix.models");
    unique(seeds.map(String), "freeze.body.executionMatrix.seeds");
    unique(platforms, "freeze.body.executionMatrix.platforms");
    if (canonicalFingerprint(platforms) !== canonicalFingerprint(releases[0]!.platformMatrix)) {
        fail("freeze.body.executionMatrix.platforms: release-mismatch");
    }
    const body: FreezeBody = {
        epochId: staticId(value.epochId, "freeze.body.epochId", EPOCH_ID_RE),
        releases: [releases[0]!, releases[1]!],
        policies: {
            analysis: parsePolicyBinding(policies.analysis, "magic-context-x4l.14", "freeze.body.policies.analysis"),
            scorecard: parsePolicyBinding(policies.scorecard, "magic-context-x4l.15", "freeze.body.policies.scorecard"),
        },
        eligibleSuiteRegistryFingerprint: hex64(value.eligibleSuiteRegistryFingerprint, "freeze.body.eligibleSuiteRegistryFingerprint"),
        evaluatorFingerprint: hex64(value.evaluatorFingerprint, "freeze.body.evaluatorFingerprint"),
        intakeWindow: { opensAt, closesAt },
        admissionRubric: {
            version: staticId(admissionRubric.version, "freeze.body.admissionRubric.version", /^[a-z0-9][a-z0-9./-]+$/),
            rubricFingerprint: hex64(admissionRubric.rubricFingerprint, "freeze.body.admissionRubric.rubricFingerprint"),
        },
        executionMatrix: {
            models,
            seeds,
            platforms,
            decodingFingerprint: hex64(executionMatrix.decodingFingerprint, "freeze.body.executionMatrix.decodingFingerprint"),
            promptFingerprint: hex64(executionMatrix.promptFingerprint, "freeze.body.executionMatrix.promptFingerprint"),
        },
    };
    const subjectFingerprint = canonicalFingerprint(body);
    const approvals = array(root.approvals, "freeze.approvals").map((entry, index) =>
        parseApproval(entry, FREEZE_APPROVAL_KINDS, `freeze.approvals[${index}]`),
    );
    if (approvals.length !== FREEZE_APPROVAL_KINDS.length || new Set(approvals.map((entry) => entry.kind)).size !== approvals.length) {
        fail("freeze.approvals: exact-kinds-required");
    }
    if (new Set(approvals.map((entry) => entry.approver)).size !== approvals.length) fail("freeze.approvals: independence-required");
    if (approvals.some((entry) => entry.subjectFingerprint !== subjectFingerprint)) fail("freeze.approvals: stale-subject");
    return { schema: FREEZE_SCHEMA, body, approvals };
}

export const REJECTION_CODES = ["privacy-rejected", "admission-rejected", "late"] as const;
export interface ClosedCase {
    intakeId: string;
    caseId: string;
    caseCommitment: string;
    familyId: string;
    scenarioFingerprint: string;
    subjective: boolean;
}
export interface CohortCloseBody {
    epochId: string;
    freezeManifestFingerprint: string;
    closedAt: string;
    cases: ClosedCase[];
    rejected: Array<{ intakeId: string; reasonCode: "privacy-rejected" | "admission-rejected" }>;
    late: Array<{ intakeId: string }>;
    aggregateCounts: { admitted: number; rejected: number; late: number };
    subjectiveMapCommitment: string;
    retentionEvidenceFingerprint: string;
    custodyEvidenceFingerprint: string;
}
export interface CohortCloseManifest {
    schema: typeof CLOSE_SCHEMA;
    body: CohortCloseBody;
    approvals: BoundApproval[];
}

export function parseCloseManifest(raw: unknown): CohortCloseManifest {
    const root = record(raw, "close");
    exact(root, ["schema", "body", "approvals"], "close");
    if (root.schema !== CLOSE_SCHEMA) fail("close.schema: version-invalid");
    const value = record(root.body, "close.body");
    exact(value, [
        "epochId",
        "freezeManifestFingerprint",
        "closedAt",
        "cases",
        "rejected",
        "late",
        "aggregateCounts",
        "subjectiveMapCommitment",
        "retentionEvidenceFingerprint",
        "custodyEvidenceFingerprint",
    ], "close.body");
    const cases = array(value.cases, "close.body.cases").map((entry, index) => {
        const label = `close.body.cases[${index}]`;
        const item = record(entry, label);
        exact(item, ["intakeId", "caseId", "caseCommitment", "familyId", "scenarioFingerprint", "subjective"], label);
        if (typeof item.subjective !== "boolean") fail(`${label}.subjective: boolean-invalid`);
        return {
            intakeId: staticId(item.intakeId, `${label}.intakeId`, INTAKE_ID_RE),
            caseId: staticId(item.caseId, `${label}.caseId`, CASE_ID_RE),
            caseCommitment: hex64(item.caseCommitment, `${label}.caseCommitment`),
            familyId: staticId(item.familyId, `${label}.familyId`, FAMILY_ID_RE),
            scenarioFingerprint: hex64(item.scenarioFingerprint, `${label}.scenarioFingerprint`),
            subjective: item.subjective,
        };
    });
    unique(cases.map((entry) => entry.caseId), "close.body.cases.caseId");
    unique(cases.map((entry) => entry.caseCommitment), "close.body.cases.caseCommitment");
    const rejected = array(value.rejected, "close.body.rejected").map((entry, index) => {
        const label = `close.body.rejected[${index}]`;
        const item = record(entry, label);
        exact(item, ["intakeId", "reasonCode"], label);
        return {
            intakeId: staticId(item.intakeId, `${label}.intakeId`, INTAKE_ID_RE),
            reasonCode: enumeration(item.reasonCode, ["privacy-rejected", "admission-rejected"] as const, `${label}.reasonCode`),
        };
    });
    const late = array(value.late, "close.body.late").map((entry, index) => {
        const label = `close.body.late[${index}]`;
        const item = record(entry, label);
        exact(item, ["intakeId"], label);
        return { intakeId: staticId(item.intakeId, `${label}.intakeId`, INTAKE_ID_RE) };
    });
    const allIntakeIds = [
        ...cases.map((entry) => entry.intakeId),
        ...rejected.map((entry) => entry.intakeId),
        ...late.map((entry) => entry.intakeId),
    ];
    unique(allIntakeIds, "close.body.dispositions.intakeId");
    const counts = record(value.aggregateCounts, "close.body.aggregateCounts");
    exact(counts, ["admitted", "rejected", "late"], "close.body.aggregateCounts");
    const aggregateCounts = {
        admitted: integer(counts.admitted, "close.body.aggregateCounts.admitted"),
        rejected: integer(counts.rejected, "close.body.aggregateCounts.rejected"),
        late: integer(counts.late, "close.body.aggregateCounts.late"),
    };
    if (aggregateCounts.admitted !== cases.length || aggregateCounts.rejected !== rejected.length || aggregateCounts.late !== late.length) {
        fail("close.body.aggregateCounts: mismatch");
    }
    const body: CohortCloseBody = {
        epochId: staticId(value.epochId, "close.body.epochId", EPOCH_ID_RE),
        freezeManifestFingerprint: hex64(value.freezeManifestFingerprint, "close.body.freezeManifestFingerprint"),
        closedAt: instant(value.closedAt, "close.body.closedAt"),
        cases,
        rejected,
        late,
        aggregateCounts,
        subjectiveMapCommitment: hex64(value.subjectiveMapCommitment, "close.body.subjectiveMapCommitment"),
        retentionEvidenceFingerprint: hex64(value.retentionEvidenceFingerprint, "close.body.retentionEvidenceFingerprint"),
        custodyEvidenceFingerprint: hex64(value.custodyEvidenceFingerprint, "close.body.custodyEvidenceFingerprint"),
    };
    const subjectFingerprint = canonicalFingerprint(body);
    const approvals = array(root.approvals, "close.approvals").map((entry, index) =>
        parseApproval(entry, CLOSE_APPROVAL_KINDS, `close.approvals[${index}]`),
    );
    if (approvals.length !== CLOSE_APPROVAL_KINDS.length || new Set(approvals.map((entry) => entry.kind)).size !== approvals.length) {
        fail("close.approvals: exact-kinds-required");
    }
    if (new Set(approvals.map((entry) => entry.approver)).size !== approvals.length) fail("close.approvals: independence-required");
    if (approvals.some((entry) => entry.subjectFingerprint !== subjectFingerprint)) fail("close.approvals: stale-subject");
    return { schema: CLOSE_SCHEMA, body, approvals };
}

export interface PolicyOwnerDocument {
    schema: typeof POLICY_OWNER_SCHEMA;
    owner: PolicyOwner;
    status: "pending" | "ready";
    policy: unknown | null;
    policyFingerprint: string | null;
}

export function parsePolicyOwnerDocument(raw: unknown, expectedOwner: PolicyOwner): PolicyOwnerDocument {
    const value = record(raw, "policy");
    exact(value, ["schema", "owner", "status", "policy", "policyFingerprint"], "policy");
    if (value.schema !== POLICY_OWNER_SCHEMA || value.owner !== expectedOwner) fail("policy: identity-invalid");
    const status = enumeration(value.status, ["pending", "ready"] as const, "policy.status");
    if (status === "pending") {
        if (value.policy !== null || value.policyFingerprint !== null) fail("policy: pending-must-be-empty");
        return { schema: POLICY_OWNER_SCHEMA, owner: expectedOwner, status, policy: null, policyFingerprint: null };
    }
    if (value.policy === null) fail("policy.policy: required");
    const policyFingerprint = hex64(value.policyFingerprint, "policy.policyFingerprint");
    if (canonicalFingerprint(value.policy) !== policyFingerprint) fail("policy.policyFingerprint: mismatch");
    return { schema: POLICY_OWNER_SCHEMA, owner: expectedOwner, status, policy: value.policy, policyFingerprint };
}

export const TRUST_KINDS = ["freeze", "close", "lifecycle", "adjudication-close", "report"] as const;
export type TrustKind = (typeof TRUST_KINDS)[number];
export interface TrustedManifestEntry {
    schema: typeof TRUST_ENTRY_SCHEMA;
    epochId: string;
    kind: TrustKind;
    sequence: number | null;
    manifestFingerprint: string;
}

export function parseTrustedManifestEntry(raw: unknown, label = "trust"): TrustedManifestEntry {
    const value = record(raw, label);
    exact(value, ["schema", "epochId", "kind", "sequence", "manifestFingerprint"], label);
    if (value.schema !== TRUST_ENTRY_SCHEMA) fail(`${label}.schema: version-invalid`);
    const kind = enumeration(value.kind, TRUST_KINDS, `${label}.kind`);
    const sequence = value.sequence === null ? null : integer(value.sequence, `${label}.sequence`, 1);
    if ((kind === "lifecycle") !== (sequence !== null)) fail(`${label}.sequence: kind-mismatch`);
    return {
        schema: TRUST_ENTRY_SCHEMA,
        epochId: staticId(value.epochId, `${label}.epochId`, EPOCH_ID_RE),
        kind,
        sequence,
        manifestFingerprint: hex64(value.manifestFingerprint, `${label}.manifestFingerprint`),
    };
}
