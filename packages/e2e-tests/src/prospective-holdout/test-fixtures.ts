import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import type { ReleaseFileKind, ReleaseRootManifest } from "./release-root";
import type { SanitizedIntake } from "./intake";
import type { ProspectiveCellResult } from "./runner";
import {
    CLOSE_SCHEMA,
    FREEZE_SCHEMA,
    type CohortCloseManifest,
    type FreezeBody,
    type PolicyOwnerDocument,
    type ReleaseFreezeManifest,
} from "./contract";

export const H1 = "1".repeat(64);
export const H2 = "2".repeat(64);
export const H3 = "3".repeat(64);
export const H4 = "4".repeat(64);

export function readyPolicies(): { analysis: PolicyOwnerDocument; scorecard: PolicyOwnerDocument } {
    const analysisPolicy = { schema: "analysis-contract/v1", estimand: "owned-by-x4l-14", pairedRetryLimit: 0 };
    const scorecardPolicy = { schema: "scorecard-contract/v1", gates: "owned-by-x4l-15" };
    return {
        analysis: {
            schema: "prospective-policy-owner/v1",
            owner: "magic-context-x4l.14",
            status: "ready",
            policy: analysisPolicy,
            policyFingerprint: canonicalFingerprint(analysisPolicy),
        },
        scorecard: {
            schema: "prospective-policy-owner/v1",
            owner: "magic-context-x4l.15",
            status: "ready",
            policy: scorecardPolicy,
            policyFingerprint: canonicalFingerprint(scorecardPolicy),
        },
    };
}

export function freezeManifest(): ReleaseFreezeManifest {
    const policies = readyPolicies();
    const body: FreezeBody = {
        epochId: "epoch-test-release",
        releases: [
            {
                role: "release-n",
                releaseId: "v2.0.0",
                channel: "stable",
                platformMatrix: ["linux-x64"],
                immutableReference: `sha256:${H1}`,
                releaseRootManifestFingerprint: H1,
                sourceFingerprint: H1,
                lockfileFingerprint: H2,
                artifactFingerprint: H3,
                runtimeFingerprint: H4,
                harnessFingerprint: H1,
            },
            {
                role: "release-n-minus-1",
                releaseId: "v1.9.0",
                channel: "stable",
                platformMatrix: ["linux-x64"],
                immutableReference: `sha256:${H2}`,
                releaseRootManifestFingerprint: H2,
                sourceFingerprint: H2,
                lockfileFingerprint: H2,
                artifactFingerprint: H3,
                runtimeFingerprint: H4,
                harnessFingerprint: H1,
            },
        ],
        policies: {
            analysis: {
                owner: "magic-context-x4l.14",
                schemaVersion: "analysis-contract/v1",
                policyFingerprint: policies.analysis.policyFingerprint!,
            },
            scorecard: {
                owner: "magic-context-x4l.15",
                schemaVersion: "scorecard-contract/v1",
                policyFingerprint: policies.scorecard.policyFingerprint!,
            },
        },
        eligibleSuiteRegistryFingerprint: H1,
        evaluatorFingerprint: H2,
        intakeWindow: {
            opensAt: "2026-09-01T00:00:00Z",
            closesAt: "2026-09-08T00:00:00Z",
        },
        admissionRubric: { version: "admission/v1", rubricFingerprint: H3 },
        executionMatrix: {
            models: ["fixture/model"],
            seeds: [7],
            platforms: ["linux-x64"],
            decodingFingerprint: H3,
            promptFingerprint: H4,
        },
    };
    const subjectFingerprint = canonicalFingerprint(body);
    return {
        schema: FREEZE_SCHEMA,
        body,
        approvals: [
            { kind: "release-operator", approver: "operator-one", subjectFingerprint },
            { kind: "independent-review", approver: "reviewer-two", subjectFingerprint },
        ],
    };
}

export function sanitizedIntakeFixture(overrides: { accepted?: boolean; subjective?: boolean } = {}): SanitizedIntake {
    const reviewed = {
        schema: "prospective-sanitized-intake/v1" as const,
        intakeId: `intake-${"d".repeat(32)}`,
        submittedAt: "2026-09-02T00:00:00Z",
        provenance: "regression" as const,
        familyId: "fam-context-loss",
        scenario: {
            revision: "scenario-v1",
            steps: ["Create synthetic record", "Run bounded operation"],
            expected: "Synthetic record remains available",
            fixtureKinds: ["synthetic-record"],
            subjective: overrides.subjective ?? false,
        },
    };
    const accepted = overrides.accepted ?? true;
    return {
        ...reviewed,
        privacyDecision: {
            approved: true,
            reviewer: "privacy-reviewer",
            reviewedFingerprint: canonicalFingerprint(reviewed),
        },
        admission: {
            accepted,
            reviewer: "admission-reviewer",
            rubricFingerprint: H3,
            reasonCode: accepted ? null : "rubric-mismatch",
        },
        custody: {
            custodianOutcomeAccess: false,
            admissionReviewerOutcomeAccess: false,
            buildIdentityAccess: false,
            diagnosticsAccess: false,
            concealedMapAccess: false,
        },
        deletionEvidence: ["raw", "temporary", "logs", "caches", "backups"].map((store) => ({
            store: store as SanitizedIntake["deletionEvidence"][number]["store"],
            deadline: "2026-09-07T00:00:00Z",
            completedAt: "2026-09-03T00:00:00Z",
            evidenceFingerprint: H4,
        })),
    };
}

export function releaseRootFixture(root: string): ReleaseRootManifest {
    const entries: Array<[string, string, ReleaseFileKind]> = [
        ["packages/plugin/dist/index.js", "opencode", "artifact"],
        ["packages/pi-plugin/dist/index.js", "pi", "artifact"],
        ["bin/mc-host", "rust", "runtime"],
        ["database/context.db", "db", "artifact"],
        ["src/revision.txt", "source", "source"],
        ["bun.lock", "lock", "lockfile"],
        ["harness/version.txt", "harness", "harness"],
    ];
    for (const [path, bytes] of entries) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), bytes);
    }
    const files = entries.map(([path, bytes, kind]) => ({
        path,
        digest: createHash("sha256").update(bytes).digest("hex"),
        kind,
    }));
    const byKind = (kind: ReleaseFileKind): string => canonicalFingerprint(
        files.filter((file) => file.kind === kind).map(({ path, digest }) => ({ path, digest })),
    );
    return {
        schema: "prospective-release-root/v1",
        releaseId: "v2.0.0",
        channel: "stable",
        platform: "linux-x64",
        immutableReference: `sha256:${"a".repeat(64)}`,
        files,
        sourceFingerprint: byKind("source"),
        lockfileFingerprint: byKind("lockfile"),
        artifactFingerprint: byKind("artifact"),
        runtimeFingerprint: byKind("runtime"),
        harnessFingerprint: byKind("harness"),
        rootFingerprint: canonicalFingerprint(files),
        entrypoints: {
            opencodePlugin: "packages/plugin/dist/index.js",
            piPlugin: "packages/pi-plugin/dist/index.js",
            rustHost: "bin/mc-host",
            databaseTemplate: "database/context.db",
        },
    };
}

export function cellResultFixture(
    role: "release-n" | "release-n-minus-1",
    overrides: Partial<ProspectiveCellResult> = {},
    freeze = freezeManifest(),
): ProspectiveCellResult {
    const release = freeze.body.releases.find((entry) => entry.role === role)!;
    return {
        schema: "prospective-cell-result/v1",
        caseId: `case-${"a".repeat(32)}`,
        familyId: "fam-context-loss",
        releaseRole: role,
        expectedReleaseId: release.releaseId,
        observedReleaseId: release.releaseId,
        expectedRootFingerprint: H1,
        observedRootFingerprint: H1,
        releaseRootManifestFingerprint: release.releaseRootManifestFingerprint,
        releaseIdentityFingerprint: canonicalFingerprint(release),
        implementationFingerprint: H2,
        harness: "opencode",
        runHealth: "completed",
        productOutcome: "pass",
        failedChecks: [],
        reasonCode: null,
        ...overrides,
    };
}

export function closeManifest(freeze = freezeManifest()): CohortCloseManifest {
    const body = {
        epochId: freeze.body.epochId,
        freezeManifestFingerprint: canonicalFingerprint(freeze),
        closedAt: "2026-09-08T00:00:00Z",
        cases: [{
            intakeId: `intake-${"d".repeat(32)}`,
            caseId: `case-${"a".repeat(32)}`,
            caseCommitment: H1,
            familyId: "fam-context-loss",
            scenarioFingerprint: H2,
            subjective: false,
        }],
        rejected: [{ intakeId: `intake-${"b".repeat(32)}`, reasonCode: "privacy-rejected" as const }],
        late: [{ intakeId: `intake-${"c".repeat(32)}` }],
        aggregateCounts: { admitted: 1, rejected: 1, late: 1 },
        subjectiveMapCommitment: H3,
        retentionEvidenceFingerprint: H4,
        custodyEvidenceFingerprint: H1,
    };
    const subjectFingerprint = canonicalFingerprint(body);
    return {
        schema: CLOSE_SCHEMA,
        body,
        approvals: [
            { kind: "cohort-custodian", approver: "custodian-one", subjectFingerprint },
            { kind: "admission-reviewer", approver: "reviewer-two", subjectFingerprint },
        ],
    };
}
