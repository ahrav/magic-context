import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    CASE_ID_RE,
    CLOSE_SCHEMA,
    INTAKE_ID_RE,
    type CohortCloseManifest,
    HoldoutContractError,
    exact,
    hex64,
    instant,
    parseCloseManifest,
    record,
    staticId,
} from "./contract";
import {
    DELETION_STORES,
    assertDeletionEvidenceCoversSubmission,
    parseDeletionEvidence,
    parseSanitizedIntake,
    type DeletionEvidence,
    type IntakeDisposition,
} from "./intake";
import { withRecoverableLock } from "./lock";

export type StaticPrivacyRejection = {
    status: "rejected";
    intakeId: string;
    reasonCode: "privacy-rejected";
    /**
     *
     * `submittedAt` bounds deletion completions because privacy rejections do not build a `SanitizedIntake`.
     */
    submittedAt: string;
    deletionEvidence: DeletionEvidence[];
};
export type CohortDisposition = IntakeDisposition | StaticPrivacyRejection;
export interface CohortSnapshot {
    decisions: CohortDisposition[];
    late: Array<{ intakeId: string }>;
}

export interface CustodyEvidence {
    schema: "prospective-custody-evidence/v1";
    verifiedThrough: string;
    custodianOutcomeAccess: false;
    admissionReviewerOutcomeAccess: false;
    buildIdentityAccess: false;
    diagnosticsAccess: false;
    concealedMapAccess: false;
}

export function parseCustodyEvidence(raw: unknown): CustodyEvidence {
    const value = record(raw, "cohort.custodyEvidence");
    exact(value, [
        "schema",
        "verifiedThrough",
        "custodianOutcomeAccess",
        "admissionReviewerOutcomeAccess",
        "buildIdentityAccess",
        "diagnosticsAccess",
        "concealedMapAccess",
    ], "cohort.custodyEvidence");
    if (value.schema !== "prospective-custody-evidence/v1") {
        throw new HoldoutContractError(["cohort.custodyEvidence.schema: version-invalid"]);
    }
    for (const field of [
        "custodianOutcomeAccess",
        "admissionReviewerOutcomeAccess",
        "buildIdentityAccess",
        "diagnosticsAccess",
        "concealedMapAccess",
    ] as const) {
        if (value[field] !== false) {
            throw new HoldoutContractError([`cohort.custodyEvidence.${field}: access-prohibited`]);
        }
    }
    return {
        schema: "prospective-custody-evidence/v1",
        verifiedThrough: instant(value.verifiedThrough, "cohort.custodyEvidence.verifiedThrough"),
        custodianOutcomeAccess: false,
        admissionReviewerOutcomeAccess: false,
        buildIdentityAccess: false,
        diagnosticsAccess: false,
        concealedMapAccess: false,
    };
}

function withLock<T>(root: string, operation: () => T): T {
    // `0o700` restricts newly created store roots to their owner.
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return withRecoverableLock(join(root, ".lock"), { busyCode: "cohort-store: busy" }, operation);
}

function intakeId(disposition: CohortDisposition): string {
    return disposition.status === "admitted" ? disposition.intake.intakeId : disposition.intakeId;
}

function publishFileOnce(storeRoot: string, path: string, bytes: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Staging files stay outside `decisions` and `late` so a crash before cleanup cannot wedge readers.
    const stagingDirectory = join(storeRoot, ".staging");
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    const staging = join(stagingDirectory, `${basename(path)}.${randomBytes(8).toString("hex")}`);
    try {
        writeFileSync(staging, bytes, { flag: "wx", mode: 0o600 });
        linkSync(staging, path);
    } catch (error) {
        if (!existsSync(path) || readFileSync(path, "utf8") !== bytes) throw error;
    } finally {
        rmSync(staging, { force: true });
    }
}

function parseStoredDisposition(raw: unknown): CohortDisposition {
    const value = record(raw, "cohort-store.record");
    if (value.status === "admitted") {
        exact(value, ["status", "intake", "caseId", "caseCommitment", "scenarioFingerprint"], "cohort-store.record");
        const intake = parseSanitizedIntake(value.intake);
        if (!intake.admission.accepted) throw new HoldoutContractError(["cohort-store.record: admission-mismatch"]);
        return {
            status: "admitted",
            intake,
            caseId: staticId(value.caseId, "cohort-store.record.caseId", CASE_ID_RE),
            caseCommitment: hex64(value.caseCommitment, "cohort-store.record.caseCommitment"),
            scenarioFingerprint: hex64(value.scenarioFingerprint, "cohort-store.record.scenarioFingerprint"),
        };
    }
    if (value.reasonCode === "admission-rejected") {
        exact(value, ["status", "intakeId", "reasonCode", "intake"], "cohort-store.record");
        const intake = parseSanitizedIntake(value.intake);
        if (intake.admission.accepted || intake.intakeId !== value.intakeId) {
            throw new HoldoutContractError(["cohort-store.record: rejection-mismatch"]);
        }
        return {
            status: "rejected",
            intakeId: staticId(value.intakeId, "cohort-store.record.intakeId", INTAKE_ID_RE),
            reasonCode: "admission-rejected",
            intake,
        };
    }
    if (value.reasonCode === "privacy-rejected") {
        exact(value, ["status", "intakeId", "reasonCode", "submittedAt", "deletionEvidence"], "cohort-store.record");
        const submittedAt = instant(value.submittedAt, "cohort-store.record.submittedAt");
        const deletionEvidence = parseDeletionEvidence(
            value.deletionEvidence,
            "cohort-store.record.deletionEvidence",
        );
        // Revalidate stored records because disk contents can bypass factory validation.
        assertDeletionEvidenceCoversSubmission(
            deletionEvidence,
            submittedAt,
            "cohort-store.record.deletionEvidence",
        );
        return {
            status: "rejected",
            intakeId: staticId(value.intakeId, "cohort-store.record.intakeId", INTAKE_ID_RE),
            reasonCode: "privacy-rejected",
            submittedAt,
            deletionEvidence,
        };
    }
    throw new HoldoutContractError(["cohort-store.record: disposition-invalid"]);
}

export class ProspectiveIntakeStore {
    constructor(readonly root: string) {}

    submit(disposition: CohortDisposition): "included" | "late" {
        return withLock(this.root, () => {
            const id = intakeId(disposition);
            const dispositionBytes = `${JSON.stringify(disposition, null, 2)}\n`;
            const decisionPath = join(this.root, "decisions", `${id}.json`);
            if (existsSync(decisionPath)) {
                try {
                    publishFileOnce(this.root, decisionPath, dispositionBytes);
                } catch {
                    throw new HoldoutContractError(["cohort-store: disposition-conflict"]);
                }
                return "included";
            }
            const closed = existsSync(join(this.root, "closed.json"));
            const directory = join(this.root, closed ? "late" : "decisions");
            const path = join(directory, `${id}.json`);
            const value = closed
                ? { intakeId: id, dispositionFingerprint: canonicalFingerprint(disposition) }
                : disposition;
            try {
                publishFileOnce(this.root, path, `${JSON.stringify(value, null, 2)}\n`);
            } catch {
                throw new HoldoutContractError(["cohort-store: disposition-conflict"]);
            }
            return closed ? "late" : "included";
        });
    }

    closeSnapshot(epochId: string, closedAt: string): CohortSnapshot {
        return withLock(this.root, () => {
            const marker = join(this.root, "closed.json");
            const bytes = `${JSON.stringify({ epochId, closedAt }, null, 2)}\n`;
            try {
                publishFileOnce(this.root, marker, bytes);
            } catch {
                throw new HoldoutContractError(["cohort-store: already-closed"]);
            }
            return this.readDecisionsUnlocked();
        });
    }

    readDecisions(): CohortSnapshot {
        return withLock(this.root, () => this.readDecisionsUnlocked());
    }

    private readDecisionsUnlocked(): CohortSnapshot {
        const readDirectory = (name: string): unknown[] => {
            const directory = join(this.root, name);
            if (!existsSync(directory)) return [];
            return readdirSync(directory).sort().map((file) => {
                if (!/^intake-[0-9a-f]{32}\.json$/.test(file)) {
                    throw new HoldoutContractError(["cohort-store: filename-invalid"]);
                }
                try {
                    return JSON.parse(readFileSync(join(directory, file), "utf8")) as unknown;
                } catch {
                    throw new HoldoutContractError(["cohort-store: record-invalid"]);
                }
            });
        };
        const late = readDirectory("late").map((raw) => {
            const value = record(raw, "cohort-store.late");
            exact(value, ["intakeId", "dispositionFingerprint"], "cohort-store.late");
            hex64(value.dispositionFingerprint, "cohort-store.late.dispositionFingerprint");
            return { intakeId: staticId(value.intakeId, "cohort-store.late.intakeId", INTAKE_ID_RE) };
        });
        return {
            decisions: readDirectory("decisions").map(parseStoredDisposition),
            late,
        };
    }
}

export function buildCohortClose(input: {
    epochId: string;
    freezeManifestFingerprint: string;
    closedAt: string;
    decisions: readonly CohortDisposition[];
    late: readonly { intakeId: string }[];
    subjectiveMapCommitment: string;
    custodyEvidence: unknown;
    approvalActors: { cohortCustodian: string; admissionReviewer: string };
}): CohortCloseManifest {
    const cases = input.decisions
        .filter((entry): entry is Extract<IntakeDisposition, { status: "admitted" }> => entry.status === "admitted")
        .map((entry) => ({
            intakeId: entry.intake.intakeId,
            caseId: entry.caseId,
            caseCommitment: entry.caseCommitment,
            familyId: entry.intake.familyId,
            scenarioFingerprint: entry.scenarioFingerprint,
            subjective: entry.intake.scenario.subjective,
        }))
        .sort((left, right) => left.caseId.localeCompare(right.caseId));
    const rejected = input.decisions
        .filter((entry): entry is Exclude<CohortDisposition, { status: "admitted" }> => entry.status === "rejected")
        .map((entry) => ({ intakeId: entry.intakeId, reasonCode: entry.reasonCode }))
        .sort((left, right) => left.intakeId.localeCompare(right.intakeId));
    const late = [...input.late].sort((left, right) => left.intakeId.localeCompare(right.intakeId));
    const closedAtMs = Date.parse(input.closedAt);
    const deletionEvidence = input.decisions.map((entry) => {
        // Parse caller-supplied dispositions because downstream count and timestamp checks do not reject invalid store names or unparseable instants.
        const evidence = parseDeletionEvidence(
            "intake" in entry ? entry.intake.deletionEvidence : entry.deletionEvidence,
            "cohort.deletionEvidence",
        );
        const submittedAt = instant(
            "intake" in entry ? entry.intake.submittedAt : entry.submittedAt,
            "cohort.deletionEvidence.submittedAt",
        );
        if (
            evidence.length !== DELETION_STORES.length ||
            new Set(evidence.map((item) => item.store)).size !== DELETION_STORES.length ||
            evidence.some((item) => Date.parse(item.completedAt) > Date.parse(item.deadline))
        ) {
            throw new HoldoutContractError(["cohort: deletion-evidence-invalid"]);
        }
        // `submittedAt` is the lower bound because the deadline and `closedAt` alone allow deletion evidence that predates the report.
        // Privacy rejections carry `submittedAt` directly because they have no `SanitizedIntake`.
        if (evidence.some((item) => Date.parse(item.completedAt) < Date.parse(submittedAt))) {
            throw new HoldoutContractError(["cohort: deletion-before-submission"]);
        }
        // `closedAt` also bounds deletion evidence because a store deadline can exceed the cohort close time.
        // hold.
        if (evidence.some((item) => Date.parse(item.completedAt) > closedAtMs)) {
            throw new HoldoutContractError(["cohort: deletion-after-close"]);
        }
        return { intakeId: intakeId(entry), evidence };
    }).sort((left, right) => left.intakeId.localeCompare(right.intakeId));
    const custodyEvidence = parseCustodyEvidence(input.custodyEvidence);
    if (Date.parse(custodyEvidence.verifiedThrough) < Date.parse(input.closedAt)) {
        throw new HoldoutContractError(["cohort.custodyEvidence: does-not-cover-close"]);
    }
    const body = {
        epochId: input.epochId,
        freezeManifestFingerprint: input.freezeManifestFingerprint,
        closedAt: input.closedAt,
        cases,
        rejected,
        late,
        aggregateCounts: { admitted: cases.length, rejected: rejected.length, late: late.length },
        subjectiveMapCommitment: input.subjectiveMapCommitment,
        retentionEvidenceFingerprint: canonicalFingerprint(deletionEvidence),
        custodyEvidenceFingerprint: canonicalFingerprint(custodyEvidence),
    };
    const subjectFingerprint = canonicalFingerprint(body);
    return parseCloseManifest({
        schema: CLOSE_SCHEMA,
        body,
        approvals: [
            {
                kind: "cohort-custodian",
                approver: input.approvalActors.cohortCustodian,
                subjectFingerprint,
            },
            {
                kind: "admission-reviewer",
                approver: input.approvalActors.admissionReviewer,
                subjectFingerprint,
            },
        ],
    });
}
