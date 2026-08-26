import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint, canonicalJson } from "../../plugin/scripts/retrieval-benchmark/canonical-json";
import { appendLifecycleEvent, parseLifecycleLedger } from "../src/prospective-holdout/lifecycle";
import { LOCK_LEASE_MS, LOCK_OWNER_FILE } from "../src/prospective-holdout/lock";
import { buildProspectiveReport, type ReportRecomputers } from "../src/prospective-holdout/report";
import { publishClose, publishFreeze } from "../src/prospective-holdout/freeze";
import { cellResultFixture, closeManifest, freezeManifest, H1, H2, readyPolicies } from "../src/prospective-holdout/test-fixtures";
import { runProspectiveHoldoutCli } from "./prospective-holdout";

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Mirrors the constant outcomes `completeRepository` reports, so recomputation matches. */
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
        // One same-build control per frozen coordinate, which is what the comparison gate
        // requires before it accepts the release-N versus release-N-1 cells.
        aa: [{ left: releaseNMinus1, right: structuredClone(releaseNMinus1) }],
    };
    writeJson(join(epoch, "outcomes.json"), outcomes);
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

/**
 * Yields a pid that is not running: a child is spawned and reaped so the kernel
 * releases its pid, then each candidate is confirmed dead so a recycled pid cannot
 * make an abandoned-lock fixture look live. Returns null when nothing can be
 * proven dead. The cohort store's lock suite keeps an identical probe; the two
 * suites live in different directories with no fixture module in common.
 */
function deadPid(): number | null {
    const reaped = spawnSync(process.execPath, ["--version"], { stdio: "ignore" }).pid;
    for (const candidate of [reaped, 4_194_301, 4_194_302, 4_194_303]) {
        if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate <= 1) continue;
        try {
            process.kill(candidate, 0);
        } catch (error) {
            if ((error as { code?: string }).code === "ESRCH") return candidate;
        }
    }
    return null;
}

/** Installs the lock a lifecycle append acquires, in the shape a killed holder leaves behind. */
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
