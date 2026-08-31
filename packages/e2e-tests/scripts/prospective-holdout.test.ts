import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint, canonicalJson } from "../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    appendJudgment,
    closeAdjudication,
    publishAdjudicationClose,
    type AdjudicationClose,
    type JudgmentEvent,
} from "../src/prospective-holdout/adjudication";
import { buildBlindedPacket } from "../src/prospective-holdout/blinding";
import type { CohortCloseManifest, ReleaseFreezeManifest } from "../src/prospective-holdout/contract";
import { rowDigest } from "../src/incident-pool/history";
import type { PairedCaseFact } from "../src/prospective-holdout/comparison";
import { buildGraduationCandidate, type GraduationCandidate } from "../src/prospective-holdout/graduation";
import { appendLifecycleEvent, parseLifecycleLedger } from "../src/prospective-holdout/lifecycle";
import { LOCK_LEASE_MS, LOCK_OWNER_FILE } from "../src/prospective-holdout/lock";
import { buildProspectiveReport, type ProspectiveReport, type ReportRecomputers } from "../src/prospective-holdout/report";
import { publishClose, publishFreeze } from "../src/prospective-holdout/freeze";
import { cellResultFixture, closeManifest, deadPid, freezeManifest, H1, H2, readyPolicies } from "../src/prospective-holdout/test-fixtures";
import { runProspectiveHoldoutCli } from "./prospective-holdout";

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** `adapterModuleSource` mirrors `completeRepository`'s constant outcomes so recomputation matches. */
function adapterModuleSource(estimatorOwner: string, scorecardOwner: string): string {
    return `export const estimator = {
    owner: ${JSON.stringify(estimatorOwner)},
    analyze: () => ({
        direction: "no-change",
        evidenceSufficient: true,
        completeFamilyCount: 1,
        resultFingerprint: ${JSON.stringify(H1)},
    }),
};
export const scorecard = {
    owner: ${JSON.stringify(scorecardOwner)},
    evaluate: () => ({
        hardGateFailures: [],
        mandatoryEvidenceComplete: true,
        promotionAllowed: true,
        resultFingerprint: ${JSON.stringify(H2)},
    }),
};
`;
}

/** `ADJUDICATION_KEY` authenticates the judgment chain committed by a subjective cohort's adjudication close. */
const ADJUDICATION_KEY = new TextEncoder().encode("a".repeat(32));

type EpochTerminalState = "cohort-closed" | "running" | "reported" | "insufficient-evidence" | "graduated";

/** `CLEAN_INCIDENT_BYTES` models candidate incident bytes without a path, identifier, or secret. */
const CLEAN_INCIDENT_BYTES = { scenario: "synthetic-current-state", expected: "pass" };

interface RepositoryOptions {
    sufficient?: boolean;
    lifecycleState?: EpochTerminalState;
    /**
     * `outcomes` can drop one evidence arm or split a coordinate's arms across attempts; the running event binds the written fingerprint, so neither defect can be corrected.
     */
    outcomes?: "complete" | "attempts-empty" | "aa-empty" | "split-attempt" | "retried-arm";
    /** `subjective` requires an adjudication close for the admitted case. */
    subjective?: boolean;
    /** `adjudicationApprover` replaces the independent approver on the adjudication close. */
    adjudicationApprover?: string;
    /**
     * `adjudicationClosedAt` after the report event's `occurredAt` makes the report score verdicts before the close sealed them.
     */
    adjudicationClosedAt?: string;
    /**
     * `closedAt` after the `cohort-closed` event's `occurredAt` makes the ledger claim closure before the manifest fixed the cohort.
     */
    closedAt?: string;
    /** `incidentBytes` is stamped into the installed graduation candidate. */
    incidentBytes?: unknown;
    /**
     * `epochId` adds a sibling epoch; byte-identical policies and the accumulating trust registry allow one root to hold several.
     */
    epochId?: string;
    /** `intakeIds` lets sibling epochs name disjoint admitted, rejected, and late intakes. */
    intakeIds?: { admitted: string; rejected: string; late: string };
}

/**
 * `closeManifestAt` re-derives approvals because they bind the manifest body's fingerprint; `parseCloseManifest` rejects stale approval subjects.
 */
function closeManifestAt(
    freeze: ReleaseFreezeManifest,
    options: {
        subjective: boolean;
        closedAt?: string;
        intakeIds?: { admitted: string; rejected: string; late: string };
    },
): CohortCloseManifest {
    const base = closeManifest(freeze, {
        subjective: options.subjective,
        ...(options.intakeIds === undefined ? {} : { intakeIds: options.intakeIds }),
    });
    if (options.closedAt === undefined) return base;
    const body = { ...base.body, closedAt: options.closedAt };
    const subjectFingerprint = canonicalFingerprint(body);
    return {
        ...base,
        body,
        approvals: base.approvals.map((approval) => ({ ...approval, subjectFingerprint })),
    };
}

/**
 * Replacing incident bytes re-derives the source fingerprint and second privacy-approval subject, simulating a directly installed artifact the constructor rejects. Clean bytes reproduce constructor output.
 * Replacing incident bytes re-derives the source fingerprint and second privacy-approval subject, simulating a directly installed artifact the constructor rejects. Clean bytes reproduce constructor output.
 * Replacing incident bytes re-derives the source fingerprint and second privacy-approval subject, simulating a directly installed artifact the constructor rejects. Clean bytes reproduce constructor output.
 * Replacing incident bytes re-derives the source fingerprint and second privacy-approval subject, simulating a directly installed artifact the constructor rejects. Clean bytes reproduce constructor output.
 * Replacing incident bytes re-derives the source fingerprint and second privacy-approval subject, simulating a directly installed artifact the constructor rejects. Clean bytes reproduce constructor output.
 * Replacing incident bytes re-derives the source fingerprint and second privacy-approval subject, simulating a directly installed artifact the constructor rejects. Clean bytes reproduce constructor output.
 */
function graduationCandidate(
    close: { manifest: CohortCloseManifest; manifestFingerprint: string },
    report: ProspectiveReport,
    pairs: readonly PairedCaseFact[],
    incidentBytes: unknown,
): GraduationCandidate {
    const candidate = buildGraduationCandidate({
        close: close.manifest,
        trustedCloseFingerprint: close.manifestFingerprint,
        report,
        pairs,
        incidentBytes: CLEAN_INCIDENT_BYTES,
        semanticRevisionId: "rev-first",
        secondPrivacyApproval: {
            approver: "privacy-reviewer",
            subjectFingerprint: canonicalFingerprint({
                epochId: close.manifest.body.epochId,
                caseId: close.manifest.body.cases[0]!.caseId,
                closeManifestFingerprint: close.manifestFingerprint,
                incidentBytesFingerprint: canonicalFingerprint(CLEAN_INCIDENT_BYTES),
            }),
        },
    });
    const incidentBytesFingerprint = canonicalFingerprint(incidentBytes);
    const source = {
        ...candidate.source,
        incident_bytes_fingerprint: incidentBytesFingerprint,
        second_privacy_approval: {
            approver: candidate.source.second_privacy_approval.approver,
            subject_fingerprint: canonicalFingerprint({
                epochId: candidate.source.epoch_id,
                caseId: candidate.source.case_id,
                closeManifestFingerprint: candidate.source.close_manifest_fingerprint,
                incidentBytesFingerprint,
            }),
        },
    };
    return { ...candidate, source, sourceFingerprint: rowDigest(source), incidentBytes };
}

/**
 * `closeAdjudication` signs sealed packets for exactly the subjective case IDs and derives the approval-subject fingerprint that `parseAdjudicationClose` recomputes.
 */
function subjectiveAdjudicationClose(
    close: { manifest: CohortCloseManifest; manifestFingerprint: string },
    approver: string,
    closedAt: string,
): AdjudicationClose {
    const sealedPackets = close.manifest.body.cases
        .filter((entry) => entry.subjective)
        .map((entry) => buildBlindedPacket({
            caseId: entry.caseId,
            assignment: { caseId: entry.caseId, buildA: "release-n", buildB: "release-n-minus-1" },
            observations: {
                "release-n": { status: "pass", checkIds: [] },
                "release-n-minus-1": { status: "fail", checkIds: ["check-current"] },
            },
            allowedCheckIds: ["check-current"],
            secret: ADJUDICATION_KEY,
        }));
    let judgments: JudgmentEvent[] = [];
    for (const packet of sealedPackets) {
        judgments = appendJudgment({
            prior: judgments,
            packet,
            sealedPackets,
            adjudicator: "judge-one",
            verdict: "build-a",
            authenticationKey: ADJUDICATION_KEY,
        });
    }
    return closeAdjudication({
        close: close.manifest,
        trustedCloseFingerprint: close.manifestFingerprint,
        closedAt,
        judgments,
        sealedPackets,
        authenticationKey: ADJUDICATION_KEY,
        approver,
    });
}

function completeRepository(root: string, options: RepositoryOptions = {}): ReportRecomputers {
    const terminal: EpochTerminalState = options.lifecycleState ?? "reported";
    const reachedRunning = terminal !== "cohort-closed";
    // Graduation follows a report, so a graduated ledger carries the reported event too.
    const reportState = terminal === "reported" || terminal === "insufficient-evidence"
        ? terminal
        : terminal === "graduated" ? "reported" : null;
    const holdout = join(root, "prospective-holdout");
    const epochId = options.epochId ?? "epoch-test-release";
    const epoch = join(holdout, "epochs", epochId);
    mkdirSync(join(holdout, "policies"), { recursive: true });
    mkdirSync(epoch, { recursive: true });
    const policies = readyPolicies();
    writeJson(join(holdout, "policies", "analysis-policy.json"), policies.analysis);
    writeJson(join(holdout, "policies", "scorecard-policy.json"), policies.scorecard);
    const freeze = publishFreeze(freezeManifest({ epochId }), join(epoch, "freeze"), policies);
    const close = publishClose(
        closeManifestAt(freeze.manifest, {
            subjective: options.subjective ?? false,
            closedAt: options.closedAt,
            intakeIds: options.intakeIds,
        }),
        join(epoch, "close"),
        freeze,
    );
    const releaseN = cellResultFixture("release-n", {}, freeze.manifest);
    const releaseNMinus1 = cellResultFixture("release-n-minus-1", {}, freeze.manifest);
    // A coordinate is comparable only within one attempt; `split-attempt` places its arms in different attempts, so the matrix is unpaired.
    // `retried-arm` retains a complete attempt-0 pair and adds a surplus release-N run in attempt 1.
    const attemptsByShape: Record<string, Array<{ attempt: number; cell: typeof releaseN }>> = {
        complete: [{ attempt: 0, cell: releaseN }, { attempt: 0, cell: releaseNMinus1 }],
        "attempts-empty": [],
        "aa-empty": [{ attempt: 0, cell: releaseN }, { attempt: 0, cell: releaseNMinus1 }],
        "split-attempt": [{ attempt: 0, cell: releaseN }, { attempt: 1, cell: releaseNMinus1 }],
        "retried-arm": [
            { attempt: 0, cell: releaseN },
            { attempt: 0, cell: releaseNMinus1 },
            { attempt: 1, cell: releaseN },
        ],
    };
    const outcomes = {
        schema: "prospective-outcomes/v1",
        attempts: attemptsByShape[options.outcomes ?? "complete"]!,
        // The comparison gate requires one same-build control per frozen coordinate before accepting release-N versus release-N-1 cells.
        aa: options.outcomes === "aa-empty"
            ? []
            : [{ left: releaseNMinus1, right: structuredClone(releaseNMinus1) }],
    };
    // A cohort-closed epoch has not run, so the file a running event would bind is absent.
    if (reachedRunning) writeJson(join(epoch, "outcomes.json"), outcomes);
    const pair = {
        caseId: releaseN.caseId,
        familyId: releaseN.familyId,
        implementationFingerprint: releaseN.implementationFingerprint,
        model: "fixture/model",
        seed: 7,
        platform: "linux-x64",
        releaseN,
        releaseNMinus1,
        status: "complete" as const,
    };
    const recomputers: ReportRecomputers = {
        estimator: {
            owner: "magic-context-x4l.14",
            analyze: () => ({
                direction: "no-change",
                evidenceSufficient: options.sufficient ?? true,
                completeFamilyCount: 1,
                resultFingerprint: H1,
            }),
        },
        scorecard: {
            owner: "magic-context-x4l.15",
            evaluate: () => ({
                hardGateFailures: [],
                mandatoryEvidenceComplete: true,
                promotionAllowed: true,
                resultFingerprint: H2,
            }),
        },
    };
    const report = reportState === null ? undefined : buildProspectiveReport({
        epochId: freeze.manifest.body.epochId,
        freezeManifestFingerprint: freeze.manifestFingerprint,
        closeManifestFingerprint: close.manifestFingerprint,
        analysisPolicyFingerprint: policies.analysis.policyFingerprint!,
        scorecardPolicyFingerprint: policies.scorecard.policyFingerprint!,
        pairs: [pair],
        ...recomputers,
        invalidated: false,
    });
    if (report) writeJson(join(epoch, "report.json"), report);
    let graduationFingerprint: string | undefined;
    if (report && terminal === "graduated") {
        const candidate = graduationCandidate(
            close,
            report,
            [pair],
            options.incidentBytes ?? CLEAN_INCIDENT_BYTES,
        );
        mkdirSync(join(epoch, "graduation"), { recursive: true });
        writeJson(join(epoch, "graduation", `${candidate.source.case_id}.json`), candidate);
        graduationFingerprint = canonicalFingerprint([candidate]);
    }
    let adjudication: AdjudicationClose | undefined;
    if (report && close.manifest.body.cases.some((entry) => entry.subjective)) {
        const independent = subjectiveAdjudicationClose(
            close,
            "reviewer-three",
            options.adjudicationClosedAt ?? "2026-09-09T00:00:00Z",
        );
        // The approver is outside the fingerprinted subject, so restamping the approver preserves artifact parseability.
        // `closeAdjudication` cannot mint a dependent approval.
        adjudication = options.adjudicationApprover === undefined
            ? independent
            : {
                ...independent,
                approval: { ...independent.approval, approver: options.adjudicationApprover },
            };
        publishAdjudicationClose(adjudication, join(epoch, "adjudication-close.json"));
    }
    let lifecycle = appendLifecycleEvent([], {
        epochId: freeze.manifest.body.epochId,
        state: "frozen",
        occurredAt: "2026-09-01T00:00:00Z",
        artifactFingerprint: freeze.manifestFingerprint,
        reasonCode: null,
        approvers: ["reviewer-one"],
    });
    lifecycle = appendLifecycleEvent(lifecycle, {
        epochId: freeze.manifest.body.epochId,
        state: "intake-open",
        occurredAt: "2026-09-01T00:00:01Z",
        artifactFingerprint: null,
        reasonCode: null,
        approvers: ["operator-one"],
    });
    lifecycle = appendLifecycleEvent(lifecycle, {
        epochId: freeze.manifest.body.epochId,
        state: "cohort-closed",
        occurredAt: "2026-09-08T00:00:00Z",
        artifactFingerprint: close.manifestFingerprint,
        reasonCode: null,
        approvers: ["reviewer-one"],
    });
    if (reachedRunning) {
        lifecycle = appendLifecycleEvent(lifecycle, {
            epochId: freeze.manifest.body.epochId,
            state: "running",
            occurredAt: "2026-09-08T00:00:01Z",
            artifactFingerprint: canonicalFingerprint(outcomes),
            reasonCode: null,
            approvers: ["operator-one"],
        });
    }
    if (report && reportState) {
        lifecycle = appendLifecycleEvent(lifecycle, {
            epochId: freeze.manifest.body.epochId,
            state: reportState,
            occurredAt: "2026-09-09T00:00:00Z",
            artifactFingerprint: report.reportFingerprint,
            reasonCode: null,
            approvers: ["reviewer-one"],
        });
    }
    if (graduationFingerprint) {
        lifecycle = appendLifecycleEvent(lifecycle, {
            epochId: freeze.manifest.body.epochId,
            state: "graduated",
            occurredAt: "2026-09-10T00:00:00Z",
            artifactFingerprint: graduationFingerprint,
            reasonCode: null,
            approvers: ["reviewer-one"],
        });
    }
    writeFileSync(join(epoch, "lifecycle.jsonl"), lifecycle.map(canonicalJson).join("\n") + "\n");
    const trust = [
        { schema: "prospective-trust-entry/v1", epochId: freeze.manifest.body.epochId, kind: "freeze", sequence: null, manifestFingerprint: freeze.manifestFingerprint },
        { schema: "prospective-trust-entry/v1", epochId: freeze.manifest.body.epochId, kind: "close", sequence: null, manifestFingerprint: close.manifestFingerprint },
        ...lifecycle.map((_, index) => ({
            schema: "prospective-trust-entry/v1",
            epochId: freeze.manifest.body.epochId,
            kind: "lifecycle",
            sequence: index + 1,
            manifestFingerprint: canonicalFingerprint(lifecycle.slice(0, index + 1)),
        })),
        ...(report
            ? [{ schema: "prospective-trust-entry/v1", epochId: freeze.manifest.body.epochId, kind: "report", sequence: null, manifestFingerprint: canonicalFingerprint(report) }]
            : []),
        ...(adjudication
            ? [{ schema: "prospective-trust-entry/v1", epochId: freeze.manifest.body.epochId, kind: "adjudication-close", sequence: null, manifestFingerprint: canonicalFingerprint(adjudication) }]
            : []),
    ];
    // A repository-wide registry preserves existing epoch entries when a second epoch is assembled in the same root.
    // The registry adds the second epoch's entries rather than replacing the first epoch's entries.
    const trustPath = join(holdout, "trusted-manifests.jsonl");
    const priorTrust = existsSync(trustPath) ? readFileSync(trustPath, "utf8") : "";
    writeFileSync(trustPath, priorTrust + trust.map(canonicalJson).join("\n") + "\n");
    return recomputers;
}

/** The helper captures the exit code and every CLI output line so diagnostics can match exactly. */
async function validateRepository(
    root: string,
    recomputers?: ReportRecomputers,
): Promise<{ code: number; messages: string[] }> {
    const messages: string[] = [];
    const code = await runProspectiveHoldoutCli(["validate", root], {
        out: (message) => messages.push(message),
        err: (message) => messages.push(message),
    }, recomputers);
    return { code, messages };
}

describe("prospective holdout CLI", () => {
    it("validates an empty pre-first-freeze registry and a synthetic complete epoch", async () => {
        const emptyOut: string[] = [];
        expect(await runProspectiveHoldoutCli(["validate", join(import.meta.dir, "..")], {
            out: (message) => emptyOut.push(message),
            err: (message) => emptyOut.push(message),
        })).toBe(0);
        expect(emptyOut.join(" ")).toContain("epochs=0");

        const root = mkdtempSync(join(tmpdir(), "holdout-cli-complete-"));
        try {
            const recomputers = completeRepository(root);
            const messages: string[] = [];
            const code = await runProspectiveHoldoutCli(["validate", root], {
                out: (message) => messages.push(message),
                err: (message) => messages.push(message),
            }, recomputers);
            expect({ code, messages }).toEqual({ code: 0, messages: ["prospective-holdout valid epochs=1"] });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects both report and insufficient-evidence lifecycle mismatches", async () => {
        for (const [sufficient, lifecycleState] of [
            [false, "reported"],
            [true, "insufficient-evidence"],
        ] as const) {
            const root = mkdtempSync(join(tmpdir(), "holdout-cli-lifecycle-mismatch-"));
            try {
                const recomputers = completeRepository(root, { sufficient, lifecycleState });
                const messages: string[] = [];
                expect(await runProspectiveHoldoutCli(["validate", root], {
                    out: (message) => messages.push(message),
                    err: (message) => messages.push(message),
                }, recomputers)).toBe(1);
                expect(messages.join(" ")).toContain("lifecycle-state-mismatch");
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        }
    });

    it("rejects a running epoch whose outcomes file holds no attempts", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-attempts-empty-"));
        try {
            const recomputers = completeRepository(root, {
                lifecycleState: "running",
                outcomes: "attempts-empty",
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["outcomes: attempts-empty"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a running epoch whose outcomes file holds no A/A evidence", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-aa-empty-"));
        try {
            const recomputers = completeRepository(root, {
                lifecycleState: "running",
                outcomes: "aa-empty",
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["outcomes: aa-empty"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("validates a cohort-closed epoch that carries no outcomes file", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-cohort-closed-"));
        try {
            const recomputers = completeRepository(root, { lifecycleState: "cohort-closed" });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 0,
                messages: ["prospective-holdout valid epochs=1"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a cohort-closed event stamped before the close manifest's closedAt", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-close-before-manifest-"));
        try {
            // A later manifest close lets intake change after the ledger declares a fixed cohort.
            // Events after `cohort-closed` inherit its fixed-cohort claim.
            const recomputers = completeRepository(root, {
                lifecycleState: "cohort-closed",
                closedAt: "2026-09-08T12:00:00Z",
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["lifecycle.cohort-closed.occurredAt: before-cohort-close"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("validates a cohort-closed event stamped at the close manifest's closedAt", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-close-at-manifest-"));
        try {
            // The cohort is fixed at the `cohort-closed` event's `occurredAt`, so equality is the legal boundary.
            const recomputers = completeRepository(root, {
                lifecycleState: "cohort-closed",
                closedAt: "2026-09-08T00:00:00Z",
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 0,
                messages: ["prospective-holdout valid epochs=1"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a running epoch whose coordinate arms sit under different attempt numbers", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-attempt-pair-"));
        try {
            // Both release roles satisfy matrix completeness, but no attempt contains a comparable pair.
            // A running epoch requires a comparable coordinate within one attempt.
            const recomputers = completeRepository(root, {
                lifecycleState: "running",
                outcomes: "split-attempt",
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["outcomes: attempt-pair-incomplete"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("validates a running epoch whose retried arm leaves one attempt holding the pair", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-attempt-retry-"));
        try {
            // `retried-arm` keeps both release roles in attempt 0 and adds a surplus release-N run in attempt 1.
            // An attempt must contain both arms; a surplus unpaired arm in another attempt is legal.
            const recomputers = completeRepository(root, {
                lifecycleState: "running",
                outcomes: "retried-arm",
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 0,
                messages: ["prospective-holdout valid epochs=1"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a later epoch re-claiming an intake an earlier cohort already disposed of", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-intake-reused-"));
        try {
            completeRepository(root, {
                epochId: "epoch-test-release-a",
                lifecycleState: "cohort-closed",
                intakeIds: {
                    admitted: `intake-${"1".repeat(32)}`,
                    rejected: `intake-${"2".repeat(32)}`,
                    late: `intake-${"3".repeat(32)}`,
                },
            });
            // An intake that arrives after the first cutoff but before the next freeze is late for the earlier cohort.
            // Admitting that intake in the later cohort scores its pre-freeze report as prospective.
            const recomputers = completeRepository(root, {
                epochId: "epoch-test-release-b",
                lifecycleState: "cohort-closed",
                intakeIds: {
                    admitted: `intake-${"3".repeat(32)}`,
                    rejected: `intake-${"4".repeat(32)}`,
                    late: `intake-${"5".repeat(32)}`,
                },
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["close.body.dispositions.intakeId: reused-across-epochs"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("validates sibling epochs whose closed cohorts dispose of disjoint intakes", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-intake-disjoint-"));
        try {
            completeRepository(root, {
                epochId: "epoch-test-release-a",
                lifecycleState: "cohort-closed",
                intakeIds: {
                    admitted: `intake-${"1".repeat(32)}`,
                    rejected: `intake-${"2".repeat(32)}`,
                    late: `intake-${"3".repeat(32)}`,
                },
            });
            // The registry rejects intake reuse across epochs while allowing each epoch to admit, reject, and time out three distinct intakes.
            const recomputers = completeRepository(root, {
                epochId: "epoch-test-release-b",
                lifecycleState: "cohort-closed",
                intakeIds: {
                    admitted: `intake-${"4".repeat(32)}`,
                    rejected: `intake-${"5".repeat(32)}`,
                    late: `intake-${"6".repeat(32)}`,
                },
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 0,
                messages: ["prospective-holdout valid epochs=2"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a subjective report stamped before its adjudication close sealed", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-report-before-adjudication-"));
        try {
            // The ledger records no event for the adjudication seal one second after the report event.
            // Because the ledger records no adjudication-seal event, lifecycle ordering cannot detect the seal.
            // The report passes every other binding while scoring verdicts that remain open.
            const recomputers = completeRepository(root, {
                subjective: true,
                adjudicationClosedAt: "2026-09-09T00:00:01Z",
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["lifecycle.report.occurredAt: before-adjudication-close"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("validates a subjective report stamped at its adjudication close", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-report-at-adjudication-"));
        try {
            // The judgments are sealed at that instant, so equality is the legal boundary.
            const recomputers = completeRepository(root, {
                subjective: true,
                adjudicationClosedAt: "2026-09-09T00:00:00Z",
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 0,
                messages: ["prospective-holdout valid epochs=1"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a symlink standing in for an expected epoch entry", async () => {
        for (const entry of ["lifecycle.jsonl", "close"]) {
            const root = mkdtempSync(join(tmpdir(), "holdout-cli-entry-symlink-"));
            try {
                const recomputers = completeRepository(root, { lifecycleState: "cohort-closed" });
                // The artifact retains its published bytes; only its epoch placement is a link.
                // Readers follow the artifact names to their resolved targets.
                // Readers must reject symlinks because they can resolve outside the reviewed epoch tree.
                const epoch = join(root, "prospective-holdout", "epochs", "epoch-test-release");
                const outside = join(root, `outside-${entry}`);
                renameSync(join(epoch, entry), outside);
                symlinkSync(outside, join(epoch, entry));
                expect(await validateRepository(root, recomputers)).toEqual({
                    code: 1,
                    messages: ["epoch: entry-not-regular"],
                });
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        }
    });

    it("validates an epoch whose expected entries are all regular files and directories", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-entry-regular-"));
        try {
            // A subjective reported epoch requires the freeze and close artifact directories and four JSON or JSONL files, but not the graduation directory.
            const recomputers = completeRepository(root, { subjective: true });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 0,
                messages: ["prospective-holdout valid epochs=1"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects an installed graduation candidate carrying sensitive incident bytes", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-graduation-privacy-"));
        try {
            // The candidate's source and approval fingerprints match its bytes, so only the content scan distinguishes it from a clean candidate.
            const recomputers = completeRepository(root, {
                lifecycleState: "graduated",
                incidentBytes: { scenario: "/home/customer-x/notes.txt" },
            });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["graduation: privacy-rejected"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a symlink standing in for a graduation candidate file", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-graduation-symlink-"));
        try {
            const recomputers = completeRepository(root, { lifecycleState: "graduated" });
            const directory = join(root, "prospective-holdout", "epochs", "epoch-test-release", "graduation");
            const candidate = readdirSync(directory)[0]!;
            const target = join(root, "outside-candidate.json");
            renameSync(join(directory, candidate), target);
            symlinkSync(target, join(directory, candidate), "file");
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["graduation: entry-not-regular"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("admits a clean installed graduation candidate past the privacy gate", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-graduation-clean-"));
        try {
            const recomputers = completeRepository(root, { lifecycleState: "graduated" });
            // The candidate passes scan, parsing, source-evidence, and cohort-completeness checks before incident-pool binding fails.
            // Incident-pool binding is the first binding that reads the repository incident pool.
            // An epoch root under a temporary directory lacks the repository incident pool, so incident-pool binding fails.
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["graduation.inventory: unreadable"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("ignores a lifecycle lock and a reclaimed sideline in the epoch root", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-epoch-lock-"));
        try {
            const recomputers = completeRepository(root, { lifecycleState: "cohort-closed" });
            // Artifact-set validation ignores the ledger-adjacent append lock and reclaim directory so transitions and interrupted reclaims do not fail validation.
            const epoch = join(root, "prospective-holdout", "epochs", "epoch-test-release");
            mkdirSync(join(epoch, "lifecycle.jsonl.lock"), { recursive: true });
            mkdirSync(join(epoch, `lifecycle.jsonl.lock.reclaimed-${"a".repeat(32)}`), { recursive: true });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 0,
                messages: ["prospective-holdout valid epochs=1"],
            });
            mkdirSync(join(epoch, "unexpected-artifact"), { recursive: true });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["epoch: artifact-set-invalid"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("exempts runtime entries only on their type and scanned bytes", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-epoch-staging-"));
        try {
            const recomputers = completeRepository(root, { lifecycleState: "cohort-closed" });
            const epoch = join(root, "prospective-holdout", "epochs", "epoch-test-release");
            // A publisher killed between mkdtemp and rename leaves an uncommitted staging directory; treating it as committed would block the publish retry.
            // recovery.
            const staging = join(epoch, ".staging-abc123");
            mkdirSync(staging, { recursive: true });
            writeFileSync(join(staging, "manifest.json"), '{"schema":"partial"}\n');
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 0,
                messages: ["prospective-holdout valid epochs=1"],
            });
            // Exempting a staging entry by name would bypass artifact-set and privacy scanning, allowing sensitive content in the public epoch tree.
            writeFileSync(join(staging, "manifest.json"), '{"path":"/Users/realperson/secrets"}\n');
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["epoch: runtime-privacy-rejected"],
            });
            rmSync(staging, { recursive: true, force: true });
            // Only a directory can be publish staging state; a regular file with the staging name is not exempt.
            writeFileSync(join(epoch, ".staging-abc123"), "committed bytes\n");
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["epoch: runtime-entry-not-directory"],
            });
            rmSync(join(epoch, ".staging-abc123"), { force: true });
            // A regular file named as the lifecycle lock is rejected rather than exempted.
            writeFileSync(join(epoch, "lifecycle.jsonl.lock"), "committed bytes\n");
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["epoch: runtime-entry-not-directory"],
            });
            rmSync(join(epoch, "lifecycle.jsonl.lock"), { force: true });
            // A real lifecycle-lock directory is scanned for sensitive content.
            mkdirSync(join(epoch, "lifecycle.jsonl.lock"), { recursive: true });
            writeFileSync(join(epoch, "lifecycle.jsonl.lock", "owner.json"), '{"path":"/Users/realperson/x"}\n');
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 1,
                messages: ["epoch: runtime-privacy-rejected"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects an adjudication close approved by either cohort close approver", async () => {
        for (const approver of ["custodian-one", "reviewer-two"]) {
            const root = mkdtempSync(join(tmpdir(), "holdout-cli-adjudication-dependent-"));
            try {
                const recomputers = completeRepository(root, {
                    subjective: true,
                    adjudicationApprover: approver,
                });
                expect(await validateRepository(root, recomputers)).toEqual({
                    code: 1,
                    messages: ["adjudication-close.approval: independence-required"],
                });
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        }
    });

    it("validates a subjective epoch whose adjudication close is independently approved", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-adjudication-independent-"));
        try {
            const recomputers = completeRepository(root, { subjective: true });
            expect(await validateRepository(root, recomputers)).toEqual({
                code: 0,
                messages: ["prospective-holdout valid epochs=1"],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects illegal lifecycle operations without creating approvals", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-transition-"));
        try {
            const ledger = join(root, "lifecycle.jsonl");
            const event = join(root, "event.json");
            writeJson(event, {
                schema: "prospective-lifecycle-event/v1",
                epochId: "epoch-test-release",
                seq: 1,
                state: "frozen",
                occurredAt: "2026-09-01T00:00:00Z",
                previousEventFingerprint: null,
                artifactFingerprint: H1,
                reasonCode: null,
                approvers: ["reviewer-one"],
            });
            const errors: string[] = [];
            expect(await runProspectiveHoldoutCli(["close", ledger, event], {
                out: (message) => errors.push(message),
                err: (message) => errors.push(message),
            })).toBe(1);
            expect(errors.join(" ")).toContain("event-state-invalid");
            expect(existsSyncSafe(ledger)).toBe(false);
            expect(readFileSync(event, "utf8")).not.toContain("approval-created");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("routes a prototype-property command name to usage instead of a TypeError", async () => {
        const messages: string[] = [];
        expect(await runProspectiveHoldoutCli(["toString", "a", "b"], {
            out: (message) => messages.push(message),
            err: (message) => messages.push(message),
        })).toBe(1);
        expect(messages.join(" ")).toContain("usage:");
        expect(messages.join(" ")).not.toContain("is not a function");
    });

    it("keeps validate without --recomputers unchanged", async () => {
        const messages: string[] = [];
        expect(await runProspectiveHoldoutCli(["validate"], {
            out: (message) => messages.push(message),
            err: (message) => messages.push(message),
        })).toBe(0);
        expect(messages.join(" ")).toContain("epochs=0");
    });

    it("loads sibling recomputers from --recomputers for a reported epoch", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-recomputers-flag-"));
        const adapters = mkdtempSync(join(tmpdir(), "holdout-cli-adapters-"));
        try {
            completeRepository(root);
            const specifier = join(adapters, "recomputers.ts");
            writeFileSync(specifier, adapterModuleSource("magic-context-x4l.14", "magic-context-x4l.15"));
            const messages: string[] = [];
            const code = await runProspectiveHoldoutCli(["validate", root, "--recomputers", specifier], {
                out: (message) => messages.push(message),
                err: (message) => messages.push(message),
            });
            expect({ code, messages }).toEqual({ code: 0, messages: ["prospective-holdout valid epochs=1"] });
        } finally {
            rmSync(adapters, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects malformed and unloadable --recomputers modules with stable codes", async () => {
        const adapters = mkdtempSync(join(tmpdir(), "holdout-cli-adapters-invalid-"));
        try {
            const missingExport = join(adapters, "missing-export.ts");
            writeFileSync(missingExport, `export const estimator = { owner: "magic-context-x4l.14", analyze: () => ({}) };\n`);
            const wrongOwner = join(adapters, "wrong-owner.ts");
            writeFileSync(wrongOwner, adapterModuleSource("magic-context-x4l.99", "magic-context-x4l.15"));
            for (const specifier of [missingExport, wrongOwner]) {
                const messages: string[] = [];
                expect(await runProspectiveHoldoutCli(["validate", "--recomputers", specifier], {
                    out: (message) => messages.push(message),
                    err: (message) => messages.push(message),
                })).toBe(1);
                expect(messages.join(" ")).toContain("recomputers: adapter-invalid");
            }
            const messages: string[] = [];
            expect(await runProspectiveHoldoutCli(["validate", "--recomputers", join(adapters, "absent.ts")], {
                out: (message) => messages.push(message),
                err: (message) => messages.push(message),
            })).toBe(1);
            expect(messages.join(" ")).toContain("recomputers: unloadable");
        } finally {
            rmSync(adapters, { recursive: true, force: true });
        }
    });

    it("prefers an explicitly passed recomputers argument over --recomputers", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-recomputers-precedence-"));
        try {
            const recomputers = completeRepository(root);
            const messages: string[] = [];
            const code = await runProspectiveHoldoutCli(
                ["validate", root, "--recomputers", join(root, "absent.ts")],
                {
                    out: (message) => messages.push(message),
                    err: (message) => messages.push(message),
                },
                recomputers,
            );
            expect({ code, messages }).toEqual({ code: 0, messages: ["prospective-holdout valid epochs=1"] });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

function existsSyncSafe(path: string): boolean {
    try {
        readFileSync(path);
        return true;
    } catch {
        return false;
    }
}

/** A killed lifecycle-append holder leaves the lifecycle-lock directory behind. */
function seedLifecycleLock(ledgerPath: string, owner: { pid: number; nonce: string; acquiredAt: number }): string {
    const lock = `${ledgerPath}.lock`;
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`);
    return lock;
}

function frozenEventFile(root: string): string {
    const event = join(root, "event.json");
    writeJson(event, {
        schema: "prospective-lifecycle-event/v1",
        epochId: "epoch-test-release",
        seq: 1,
        state: "frozen",
        occurredAt: "2026-09-01T00:00:00Z",
        previousEventFingerprint: null,
        artifactFingerprint: H1,
        reasonCode: null,
        approvers: ["reviewer-one"],
    });
    return event;
}

describe("prospective holdout lifecycle lock", () => {
    it("appends after reclaiming a lifecycle lock whose recorded holder is dead", async () => {
        const pid = deadPid();
        if (pid === null) return;
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-lock-abandoned-"));
        try {
            const ledger = join(root, "lifecycle.jsonl");
            const lock = seedLifecycleLock(ledger, {
                pid,
                nonce: "abandoned-worker",
                acquiredAt: Date.now() - LOCK_LEASE_MS - 60_000,
            });
            const messages: string[] = [];
            expect(await runProspectiveHoldoutCli(["freeze", ledger, frozenEventFile(root)], {
                out: (message) => messages.push(message),
                err: (message) => messages.push(message),
            })).toBe(0);
            expect(parseLifecycleLedger(readFileSync(ledger, "utf8")).map((event) => event.state)).toEqual(["frozen"]);
            expect(existsSync(lock)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reports append-busy while the lifecycle lock holder is live inside its lease", async () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-cli-lock-live-"));
        try {
            const ledger = join(root, "lifecycle.jsonl");
            const lock = seedLifecycleLock(ledger, {
                pid: process.pid,
                nonce: "live-holder",
                acquiredAt: Date.now(),
            });
            const messages: string[] = [];
            expect(await runProspectiveHoldoutCli(["freeze", ledger, frozenEventFile(root)], {
                out: (message) => messages.push(message),
                err: (message) => messages.push(message),
            })).toBe(1);
            expect(messages.join(" ")).toContain("lifecycle: append-busy");
            expect(existsSyncSafe(ledger)).toBe(false);
            expect(existsSync(lock)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);
});
