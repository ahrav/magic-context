import { createHmac } from "node:crypto";
import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import {
    FAMILY_ID_RE,
    INTAKE_ID_RE,
    HoldoutContractError,
    array,
    enumeration,
    exact,
    fail,
    hex64,
    instant,
    record,
    staticId,
    string,
} from "./contract";

export const SANITIZED_INTAKE_SCHEMA = "prospective-sanitized-intake/v1";
export const INTAKE_PROVENANCE = ["regression", "user-correction", "unexpected-failure"] as const;
export const ADMISSION_REJECTION_CODES = [
    "out-of-scope",
    "not-reproducible",
    "pre-freeze-case",
    "rubric-mismatch",
] as const;
export const DELETION_STORES = ["raw", "temporary", "logs", "caches", "backups"] as const;

export interface DeletionEvidence {
    store: (typeof DELETION_STORES)[number];
    deadline: string;
    completedAt: string;
    evidenceFingerprint: string;
}

export interface SanitizedIntake {
    schema: typeof SANITIZED_INTAKE_SCHEMA;
    intakeId: string;
    submittedAt: string;
    provenance: (typeof INTAKE_PROVENANCE)[number];
    familyId: string;
    scenario: {
        revision: string;
        steps: string[];
        expected: string;
        fixtureKinds: string[];
        subjective: boolean;
    };
    privacyDecision: {
        approved: true;
        reviewer: string;
        reviewedFingerprint: string;
    };
    admission: {
        accepted: boolean;
        reviewer: string;
        rubricFingerprint: string;
        reasonCode: (typeof ADMISSION_REJECTION_CODES)[number] | null;
    };
    custody: {
        custodianOutcomeAccess: false;
        admissionReviewerOutcomeAccess: false;
        buildIdentityAccess: false;
        diagnosticsAccess: false;
        concealedMapAccess: false;
    };
    deletionEvidence: DeletionEvidence[];
}

export type IntakeDisposition =
    | { status: "admitted"; intake: SanitizedIntake; caseId: string; caseCommitment: string; scenarioFingerprint: string }
    | { status: "rejected"; intakeId: string; reasonCode: "admission-rejected"; intake: SanitizedIntake };

function privacyGate(raw: unknown, options: { forbiddenTokens?: readonly string[]; forbiddenIdentifiers?: readonly string[] }): void {
    const violations = scanForSensitiveContent(raw, options);
    if (violations.length > 0) {
        throw new HoldoutContractError(
            violations.map((violation) => `privacy.${violation.category}:${violation.path}`),
        );
    }
}

export function parseDeletionEvidence(raw: unknown, label: string): DeletionEvidence[] {
    return array(raw, label).map((entry, index) => {
        const itemLabel = `${label}[${index}]`;
        const evidence = record(entry, itemLabel);
        exact(evidence, ["store", "deadline", "completedAt", "evidenceFingerprint"], itemLabel);
        return {
            store: enumeration(evidence.store, DELETION_STORES, `${itemLabel}.store`),
            deadline: instant(evidence.deadline, `${itemLabel}.deadline`),
            completedAt: instant(evidence.completedAt, `${itemLabel}.completedAt`),
            evidenceFingerprint: hex64(evidence.evidenceFingerprint, `${itemLabel}.evidenceFingerprint`),
        };
    });
}

export function parseSanitizedIntake(raw: unknown): SanitizedIntake {
    const value = record(raw, "intake");
    exact(value, [
        "schema",
        "intakeId",
        "submittedAt",
        "provenance",
        "familyId",
        "scenario",
        "privacyDecision",
        "admission",
        "custody",
        "deletionEvidence",
    ], "intake");
    if (value.schema !== SANITIZED_INTAKE_SCHEMA) fail("intake.schema: version-invalid");
    const scenario = record(value.scenario, "intake.scenario");
    exact(scenario, ["revision", "steps", "expected", "fixtureKinds", "subjective"], "intake.scenario");
    const steps = array(scenario.steps, "intake.scenario.steps").map((entry, index) =>
        string(entry, `intake.scenario.steps[${index}]`),
    );
    if (steps.length === 0) fail("intake.scenario.steps: empty");
    const fixtureKinds = array(scenario.fixtureKinds, "intake.scenario.fixtureKinds").map((entry, index) =>
        staticId(entry, `intake.scenario.fixtureKinds[${index}]`),
    );
    if (new Set(fixtureKinds).size !== fixtureKinds.length) fail("intake.scenario.fixtureKinds: duplicate");
    if (typeof scenario.subjective !== "boolean") fail("intake.scenario.subjective: boolean-invalid");
    const privacyDecision = record(value.privacyDecision, "intake.privacyDecision");
    exact(privacyDecision, ["approved", "reviewer", "reviewedFingerprint"], "intake.privacyDecision");
    if (privacyDecision.approved !== true) fail("intake.privacyDecision.approved: must-approve-sanitized-bytes");
    const admission = record(value.admission, "intake.admission");
    exact(admission, ["accepted", "reviewer", "rubricFingerprint", "reasonCode"], "intake.admission");
    if (typeof admission.accepted !== "boolean") fail("intake.admission.accepted: boolean-invalid");
    const reasonCode = admission.reasonCode === null
        ? null
        : enumeration(admission.reasonCode, ADMISSION_REJECTION_CODES, "intake.admission.reasonCode");
    if (admission.accepted === (reasonCode !== null)) fail("intake.admission.reasonCode: disposition-mismatch");
    const custody = record(value.custody, "intake.custody");
    exact(custody, [
        "custodianOutcomeAccess",
        "admissionReviewerOutcomeAccess",
        "buildIdentityAccess",
        "diagnosticsAccess",
        "concealedMapAccess",
    ], "intake.custody");
    for (const key of Object.keys(custody)) {
        if (custody[key] !== false) fail(`intake.custody.${key}: access-forbidden`);
    }
    const deletionEvidence = parseDeletionEvidence(value.deletionEvidence, "intake.deletionEvidence");
    if (
        deletionEvidence.length !== DELETION_STORES.length ||
        new Set(deletionEvidence.map((entry) => entry.store)).size !== DELETION_STORES.length
    ) {
        fail("intake.deletionEvidence: exact-stores-required");
    }
    for (const evidence of deletionEvidence) {
        if (Date.parse(evidence.completedAt) > Date.parse(evidence.deadline)) {
            fail("intake.deletionEvidence: overdue");
        }
    }
    const parsed: SanitizedIntake = {
        schema: SANITIZED_INTAKE_SCHEMA,
        intakeId: staticId(value.intakeId, "intake.intakeId", INTAKE_ID_RE),
        submittedAt: instant(value.submittedAt, "intake.submittedAt"),
        provenance: enumeration(value.provenance, INTAKE_PROVENANCE, "intake.provenance"),
        familyId: staticId(value.familyId, "intake.familyId", FAMILY_ID_RE),
        scenario: {
            revision: staticId(scenario.revision, "intake.scenario.revision"),
            steps,
            expected: string(scenario.expected, "intake.scenario.expected"),
            fixtureKinds,
            subjective: scenario.subjective,
        },
        privacyDecision: {
            approved: true,
            reviewer: staticId(privacyDecision.reviewer, "intake.privacyDecision.reviewer"),
            reviewedFingerprint: hex64(privacyDecision.reviewedFingerprint, "intake.privacyDecision.reviewedFingerprint"),
        },
        admission: {
            accepted: admission.accepted,
            reviewer: staticId(admission.reviewer, "intake.admission.reviewer"),
            rubricFingerprint: hex64(admission.rubricFingerprint, "intake.admission.rubricFingerprint"),
            reasonCode,
        },
        custody: {
            custodianOutcomeAccess: false,
            admissionReviewerOutcomeAccess: false,
            buildIdentityAccess: false,
            diagnosticsAccess: false,
            concealedMapAccess: false,
        },
        deletionEvidence,
    };
    const reviewed = {
        schema: parsed.schema,
        intakeId: parsed.intakeId,
        submittedAt: parsed.submittedAt,
        provenance: parsed.provenance,
        familyId: parsed.familyId,
        scenario: parsed.scenario,
    };
    if (canonicalFingerprint(reviewed) !== parsed.privacyDecision.reviewedFingerprint) {
        fail("intake.privacyDecision.reviewedFingerprint: mismatch");
    }
    return parsed;
}

export function reviewSanitizedIntake(
    raw: unknown,
    input: {
        commitmentKey: Uint8Array;
        expectedRubricFingerprint: string;
        freezePublishedAt: string;
        intakeClosesAt: string;
        forbiddenTokens?: readonly string[];
        forbiddenIdentifiers?: readonly string[];
    },
): IntakeDisposition {
    privacyGate(raw, input);
    if (input.commitmentKey.byteLength < 32) fail("intake.commitment-key: too-short");
    const intake = parseSanitizedIntake(raw);
    if (intake.admission.rubricFingerprint !== input.expectedRubricFingerprint) {
        fail("intake.admission.rubricFingerprint: freeze-mismatch");
    }
    if (Date.parse(intake.submittedAt) <= Date.parse(input.freezePublishedAt)) {
        fail("intake.submittedAt: not-prospective");
    }
    if (Date.parse(intake.submittedAt) > Date.parse(input.intakeClosesAt)) {
        fail("intake.submittedAt: after-frozen-cutoff");
    }
    if (!intake.admission.accepted) {
        return {
            status: "rejected",
            intakeId: intake.intakeId,
            reasonCode: "admission-rejected",
            intake,
        };
    }
    const scenarioFingerprint = canonicalFingerprint(intake.scenario);
    const caseCommitment = createHmac("sha256", input.commitmentKey)
        .update(canonicalJson({ scenario: intake.scenario, familyId: intake.familyId }))
        .digest("hex");
    return {
        status: "admitted",
        intake,
        caseId: `case-${caseCommitment.slice(0, 32)}`,
        caseCommitment,
        scenarioFingerprint,
    };
}

export function staticPrivacyRejection(
    intakeId: string,
    deletionEvidence: DeletionEvidence[],
): { status: "rejected"; intakeId: string; reasonCode: "privacy-rejected"; deletionEvidence: DeletionEvidence[] } {
    return {
        status: "rejected",
        intakeId: staticId(intakeId, "intake.intakeId", INTAKE_ID_RE),
        reasonCode: "privacy-rejected",
        deletionEvidence,
    };
}
