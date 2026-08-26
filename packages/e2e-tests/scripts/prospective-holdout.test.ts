import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint, canonicalJson } from "../../plugin/scripts/retrieval-benchmark/canonical-json";
import { appendLifecycleEvent } from "../src/prospective-holdout/lifecycle";
import { buildProspectiveReport, type ReportRecomputers } from "../src/prospective-holdout/report";
import { publishClose, publishFreeze } from "../src/prospective-holdout/freeze";
import { cellResultFixture, closeManifest, freezeManifest, H1, H2, readyPolicies } from "../src/prospective-holdout/test-fixtures";
import { runProspectiveHoldoutCli } from "./prospective-holdout";

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function completeRepository(
    root: string,
    options: { sufficient?: boolean; lifecycleState?: "reported" | "insufficient-evidence" } = {},
): ReportRecomputers {
    const holdout = join(root, "prospective-holdout");
    const epoch = join(holdout, "epochs", "epoch-test-release");
    mkdirSync(join(holdout, "policies"), { recursive: true });
    mkdirSync(epoch, { recursive: true });
    const policies = readyPolicies();
    writeJson(join(holdout, "policies", "analysis-policy.json"), policies.analysis);
    writeJson(join(holdout, "policies", "scorecard-policy.json"), policies.scorecard);
    const freeze = publishFreeze(freezeManifest(), join(epoch, "freeze"), policies);
    const close = publishClose(closeManifest(freeze.manifest), join(epoch, "close"), freeze);
    const releaseN = cellResultFixture("release-n", {}, freeze.manifest);
    const releaseNMinus1 = cellResultFixture("release-n-minus-1", {}, freeze.manifest);
    const outcomes = {
        schema: "prospective-outcomes/v1",
        attempts: [
            { attempt: 0, cell: releaseN },
            { attempt: 0, cell: releaseNMinus1 },
        ],
    };
    writeJson(join(epoch, "outcomes.json"), outcomes);
    const pair = {
        caseId: releaseN.caseId,
        familyId: releaseN.familyId,
        implementationFingerprint: releaseN.implementationFingerprint,
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
    const report = buildProspectiveReport({
        epochId: freeze.manifest.body.epochId,
        freezeManifestFingerprint: freeze.manifestFingerprint,
        closeManifestFingerprint: close.manifestFingerprint,
        analysisPolicyFingerprint: policies.analysis.policyFingerprint!,
        scorecardPolicyFingerprint: policies.scorecard.policyFingerprint!,
        pairs: [pair],
        ...recomputers,
        invalidated: false,
    });
    writeJson(join(epoch, "report.json"), report);
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
    lifecycle = appendLifecycleEvent(lifecycle, {
        epochId: freeze.manifest.body.epochId,
        state: "running",
        occurredAt: "2026-09-08T00:00:01Z",
        artifactFingerprint: canonicalFingerprint(outcomes),
        reasonCode: null,
        approvers: ["operator-one"],
    });
    lifecycle = appendLifecycleEvent(lifecycle, {
        epochId: freeze.manifest.body.epochId,
        state: options.lifecycleState ?? "reported",
        occurredAt: "2026-09-09T00:00:00Z",
        artifactFingerprint: report.reportFingerprint,
        reasonCode: null,
        approvers: ["reviewer-one"],
    });
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
        { schema: "prospective-trust-entry/v1", epochId: freeze.manifest.body.epochId, kind: "report", sequence: null, manifestFingerprint: canonicalFingerprint(report) },
    ];
    writeFileSync(join(holdout, "trusted-manifests.jsonl"), trust.map(canonicalJson).join("\n") + "\n");
    return recomputers;
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
});

function existsSyncSafe(path: string): boolean {
    try {
        readFileSync(path);
        return true;
    } catch {
        return false;
    }
}
