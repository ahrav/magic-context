import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { type FrozenReleaseIdentity, HoldoutContractError } from "./contract";
import { verifyReleaseRoot, type VerifiedReleaseRoot } from "./release-root";
import type { ProspectiveScenario } from "./registry";
import {
    parseProspectiveCellResult,
    ProspectivePrerequisiteUnavailable,
    ProspectiveProductFailure,
    type ProspectiveCellResult,
    runProspectiveCase,
} from "./runner";
import { H1, releaseRootFixture } from "./test-fixtures";

function scenario(
    driver: ProspectiveScenario["driver"],
    options: { cleanup?: ProspectiveScenario["cleanup"]; verifier?: ProspectiveScenario["verifier"] } = {},
): ProspectiveScenario {
    return {
        caseId: `case-${"a".repeat(32)}`,
        familyId: "fam-context-loss",
        semanticRevision: "rev-first",
        scenarioFingerprint: H1,
        implementationFingerprint: H1,
        implementationFiles: ["scenario.ts"],
        harness: "opencode",
        subjective: false,
        driver,
        cleanup: options.cleanup ?? (async () => undefined),
        normalizer: (raw) => raw,
        verifier: options.verifier ?? ((observation) => [{
            id: "check-current",
            passed: (observation as { state?: string }).state === "current",
        }]),
    };
}

function expectedRelease(root: VerifiedReleaseRoot): FrozenReleaseIdentity {
    return {
        role: "release-n",
        releaseId: root.manifest.releaseId,
        channel: root.manifest.channel,
        platformMatrix: [root.manifest.platform],
        immutableReference: root.manifest.immutableReference,
        releaseRootManifestFingerprint: canonicalFingerprint(root.manifest),
        sourceFingerprint: root.manifest.sourceFingerprint,
        lockfileFingerprint: root.manifest.lockfileFingerprint,
        artifactFingerprint: root.manifest.artifactFingerprint,
        runtimeFingerprint: root.manifest.runtimeFingerprint,
        harnessFingerprint: root.manifest.harnessFingerprint,
    };
}

/**
 * `runProspectiveCase` binds the coordinate to the running host, so roots and
 * inputs are built at this host's platform rather than a fixed literal. A
 * literal would pass only on the machine it names and would otherwise report
 * the binding as broken.
 */
const HOST_PLATFORM = `${process.platform}-${process.arch}`;
/** Well formed, and never this host, so only the host binding rejects it. */
const FOREIGN_PLATFORM = HOST_PLATFORM === "linux-x64" ? "darwin-arm64" : "linux-x64";

async function withRoots(
    run: (root: VerifiedReleaseRoot, paired: VerifiedReleaseRoot, active: string) => Promise<void>,
    platform: string = HOST_PLATFORM,
): Promise<void> {
    const release = mkdtempSync(join(tmpdir(), "runner-release-"));
    const pairedRelease = mkdtempSync(join(tmpdir(), "runner-paired-release-"));
    const active = mkdtempSync(join(tmpdir(), "runner-active-"));
    try {
        // `releaseRootFixture` declares a fixed `linux-x64`, and `platform` is outside the bytes
        // `rootFingerprint` covers, so restating it leaves every digest and fingerprint check intact.
        const manifest = { ...releaseRootFixture(release), platform };
        const pairedManifest = {
            ...releaseRootFixture(pairedRelease, {
                releaseId: "v1.9.0",
                sourceBytes: "previous-source",
                immutableReference: `sha256:${"b".repeat(64)}`,
            }),
            platform,
        };
        await run(
            verifyReleaseRoot(release, manifest, {
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            }),
            verifyReleaseRoot(pairedRelease, pairedManifest, {
                expectedRootFingerprint: pairedManifest.rootFingerprint,
                activeCheckout: active,
            }),
            active,
        );
    } finally {
        rmSync(release, { recursive: true, force: true });
        rmSync(pairedRelease, { recursive: true, force: true });
        rmSync(active, { recursive: true, force: true });
    }
}

function baseInput(root: VerifiedReleaseRoot, paired: VerifiedReleaseRoot, active: string) {
    return {
        releaseRole: "release-n" as const,
        releaseRoot: root,
        pairedReleaseRoot: paired,
        expectedRelease: expectedRelease(root),
        activeCheckout: active,
        workspaceRoot: active,
        model: "fixture/model",
        seed: 7,
        platform: root.manifest.platform,
        timeoutMs: 100,
    };
}

/** Committed rows arrive as JSON text, so parse what a serialized cell decodes to. */
function roundTrip(cell: ProspectiveCellResult): ProspectiveCellResult {
    return parseProspectiveCellResult(JSON.parse(JSON.stringify(cell)));
}

function terminalKey(cell: ProspectiveCellResult): string {
    return `${cell.runHealth}|${cell.productOutcome}|${cell.reasonCode ?? "null"}`;
}

/** Diagnostics of the single contract error `run` raises, so one code is provable. */
function diagnostics(run: () => unknown): readonly string[] {
    try {
        run();
    } catch (error) {
        if (error instanceof HoldoutContractError) return error.diagnostics;
        throw error;
    }
    throw new Error("expected a contract error");
}

/** The rejecting counterpart of `diagnostics`, for breaches `runProspectiveCase` raises. */
async function rejectionDiagnostics(run: Promise<unknown>): Promise<readonly string[]> {
    try {
        await run;
    } catch (error) {
        if (error instanceof HoldoutContractError) return error.diagnostics;
        throw error;
    }
    throw new Error("expected a contract error");
}

/**
 * Drives every terminal path `runProspectiveCase` has so the allowed-triple set
 * is measured against the runner instead of restated as literals.
 */
async function runnerTerminals(
    root: VerifiedReleaseRoot,
    paired: VerifiedReleaseRoot,
    active: string,
): Promise<Array<{ label: string; cell: ProspectiveCellResult }>> {
    const base = baseInput(root, paired, active);
    let resolveDriver: ((value: { state: string }) => void) | undefined;
    return [
        {
            label: "pass",
            cell: await runProspectiveCase({
                ...base,
                scenario: scenario(async () => ({ state: "current" })),
            }),
        },
        {
            label: "failed-check",
            cell: await runProspectiveCase({
                ...base,
                scenario: scenario(async () => ({ state: "stale" })),
            }),
        },
        {
            label: "product-failure",
            cell: await runProspectiveCase({
                ...base,
                scenario: scenario(async () => { throw new ProspectiveProductFailure(); }),
            }),
        },
        {
            label: "empty-verifier",
            cell: await runProspectiveCase({
                ...base,
                scenario: scenario(async () => ({ state: "current" }), { verifier: () => [] }),
            }),
        },
        {
            label: "prerequisite-unavailable",
            cell: await runProspectiveCase({
                ...base,
                scenario: scenario(async () => { throw new ProspectivePrerequisiteUnavailable(); }),
            }),
        },
        {
            label: "runner-crash",
            cell: await runProspectiveCase({
                ...base,
                scenario: scenario(async () => { throw new Error("private output"); }),
            }),
        },
        {
            label: "timeout",
            cell: await runProspectiveCase({
                ...base,
                timeoutMs: 5,
                scenario: scenario(
                    () => new Promise((resolve) => { resolveDriver = resolve; }),
                    { cleanup: async () => { resolveDriver?.({ state: "late" }); } },
                ),
            }),
        },
    ];
}

describe("prospective runner", () => {
    it("records expected root identity and frozen matrix coordinates", async () => {
        await withRoots(async (root, paired, active) => {
            const result = await runProspectiveCase({
                ...baseInput(root, paired, active),
                scenario: scenario(async () => ({ state: "current" })),
            });
            expect(result.productOutcome).toBe("pass");
            expect(result.expectedRootFingerprint).toBe(result.observedRootFingerprint);
            expect([result.model, result.seed, result.platform]).toEqual(["fixture/model", 7, HOST_PLATFORM]);
        });
    });

    it("rejects a coordinate whose platform is not this host", async () => {
        await withRoots(async (root, paired, active) => {
            const input = baseInput(root, paired, active);
            // Both manifests and the input agree on the foreign platform, so the agreement checks
            // pass and only the host binding can be the code that fires.
            expect([input.platform, root.manifest.platform, paired.manifest.platform]).toEqual([
                FOREIGN_PLATFORM, FOREIGN_PLATFORM, FOREIGN_PLATFORM,
            ]);
            expect(await rejectionDiagnostics(runProspectiveCase({
                ...input,
                scenario: scenario(async () => ({ state: "current" })),
            }))).toEqual(["prospective-runner: platform-not-host"]);
        }, FOREIGN_PLATFORM);
    });

    it("catches synchronous driver throws and rejects empty verifier evidence", async () => {
        await withRoots(async (root, paired, active) => {
            const base = baseInput(root, paired, active);
            const thrown = await runProspectiveCase({
                ...base,
                scenario: scenario(() => { throw new Error("private output"); }),
            });
            const empty = await runProspectiveCase({
                ...base,
                scenario: scenario(async () => ({ state: "current" }), { verifier: () => [] }),
            });
            expect([thrown.runHealth, thrown.reasonCode]).toEqual(["crash", "runner-crash"]);
            expect([empty.productOutcome, empty.reasonCode]).toEqual(["fail", "invalid-result"]);
        });
    });

    it("aborts and awaits cleanup before returning a timeout", async () => {
        await withRoots(async (root, paired, active) => {
            let resolveDriver: ((value: { state: string }) => void) | undefined;
            let cleaned = false;
            const result = await runProspectiveCase({
                ...baseInput(root, paired, active),
                timeoutMs: 5,
                scenario: scenario(
                    () => new Promise((resolve) => { resolveDriver = resolve; }),
                    {
                        cleanup: async (context) => {
                            expect(context.signal.aborted).toBe(true);
                            cleaned = true;
                            resolveDriver?.({ state: "late" });
                        },
                    },
                ),
            });
            expect(cleaned).toBe(true);
            expect([result.runHealth, result.reasonCode]).toEqual(["timeout", "deadline-exceeded"]);
        });
    });

    it("refuses a cell when the driver outlives the bounded drain", async () => {
        await withRoots(async (root, paired, active) => {
            let cleaned = false;
            // Cleanup reports success and still leaves the driver running, which is the case a
            // returned timeout cell would hand to a retry while the driver can still write.
            const breach = rejectionDiagnostics(runProspectiveCase({
                ...baseInput(root, paired, active),
                timeoutMs: 5,
                scenario: scenario(
                    () => new Promise<{ state: string }>(() => {}),
                    { cleanup: async () => { cleaned = true; } },
                ),
            }));
            expect(await breach).toEqual(["prospective-runner: driver-abandoned"]);
            expect(cleaned).toBe(true);
        });
    });

    it("keeps product crashes as failures and infrastructure errors incomplete", async () => {
        await withRoots(async (root, paired, active) => {
            const base = baseInput(root, paired, active);
            const product = await runProspectiveCase({
                ...base,
                scenario: scenario(async () => { throw new ProspectiveProductFailure(); }),
            });
            const infrastructure = await runProspectiveCase({
                ...base,
                scenario: scenario(async () => { throw new Error("private output"); }),
            });
            expect([product.runHealth, product.productOutcome, product.reasonCode]).toEqual([
                "completed", "fail", "product-crash",
            ]);
            expect([infrastructure.runHealth, infrastructure.productOutcome, infrastructure.reasonCode]).toEqual([
                "crash", "not-evaluated", "runner-crash",
            ]);
            expect(JSON.stringify(infrastructure)).not.toContain("private output");
        });
    });

    it("parses a committed row for every terminal triple the runner emits", async () => {
        await withRoots(async (root, paired, active) => {
            const terminals = await runnerTerminals(root, paired, active);
            for (const { label, cell } of terminals) {
                expect([label, roundTrip(cell)]).toEqual([label, cell]);
            }
            expect(terminals.map(({ cell }) => terminalKey(cell)).sort()).toEqual([
                "completed|fail|invalid-result",
                "completed|fail|null",
                "completed|fail|product-crash",
                "completed|pass|null",
                "crash|not-evaluated|runner-crash",
                "timeout|not-evaluated|deadline-exceeded",
                "unavailable|not-evaluated|prerequisite-unavailable",
            ]);
        });
    });

    it("rejects health, outcome, and reason triples no runner path emits", async () => {
        await withRoots(async (root, paired, active) => {
            const byLabel = new Map(
                (await runnerTerminals(root, paired, active)).map(({ label, cell }) => [label, cell]),
            );
            const timeout = byLabel.get("timeout")!;
            const crash = byLabel.get("runner-crash")!;
            const unavailable = byLabel.get("prerequisite-unavailable")!;
            const failedCheck = byLabel.get("failed-check")!;
            const contradictions: ProspectiveCellResult[] = [
                { ...timeout, reasonCode: "runner-crash" },
                { ...unavailable, reasonCode: "deadline-exceeded" },
                { ...crash, reasonCode: "deadline-exceeded" },
                { ...crash, runHealth: "malformed" },
                { ...failedCheck, reasonCode: "prerequisite-unavailable" },
            ];
            for (const cell of contradictions) {
                expect([terminalKey(cell), diagnostics(() => roundTrip(cell))]).toEqual([
                    terminalKey(cell), ["cell: health-reason-mismatch"],
                ]);
            }
        });
    });

    it("rejects duplicate failed check identifiers in a committed row", async () => {
        await withRoots(async (root, paired, active) => {
            const failedCheck = await runProspectiveCase({
                ...baseInput(root, paired, active),
                scenario: scenario(async () => ({ state: "stale" })),
            });
            expect(failedCheck.failedChecks).toEqual(["check-current"]);
            const duplicated = { ...failedCheck, failedChecks: ["check-current", "check-current"] };
            expect(diagnostics(() => roundTrip(duplicated))).toEqual(["cell.failedChecks: duplicate"]);
        });
    });

    it("rejects a reason code paired with per-check failure evidence", async () => {
        await withRoots(async (root, paired, active) => {
            const productCrash = await runProspectiveCase({
                ...baseInput(root, paired, active),
                scenario: scenario(async () => { throw new ProspectiveProductFailure(); }),
            });
            expect([productCrash.reasonCode, productCrash.failedChecks]).toEqual(["product-crash", []]);
            expect(diagnostics(() => roundTrip({ ...productCrash, failedChecks: ["check-current"] })))
                .toEqual(["cell: reason-code-checks-invalid"]);
        });
    });
});
