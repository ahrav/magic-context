import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import type { FrozenReleaseIdentity } from "./contract";
import { verifyReleaseRoot, type VerifiedReleaseRoot } from "./release-root";
import type { ProspectiveScenario } from "./registry";
import { ProspectiveProductFailure, runProspectiveCase } from "./runner";
import { H1, releaseRootFixture } from "./test-fixtures";

function scenario(driver: ProspectiveScenario["driver"]): ProspectiveScenario {
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
        normalizer: (raw) => raw,
        verifier: (observation) => [{
            id: "check-current",
            passed: (observation as { state?: string }).state === "current",
        }],
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

async function withRoot(run: (root: ReturnType<typeof verifyReleaseRoot>, active: string) => Promise<void>): Promise<void> {
    const release = mkdtempSync(join(tmpdir(), "runner-release-"));
    const active = mkdtempSync(join(tmpdir(), "runner-active-"));
    try {
        const manifest = releaseRootFixture(release);
        await run(verifyReleaseRoot(release, manifest, {
            expectedRootFingerprint: manifest.rootFingerprint,
            activeCheckout: active,
        }), active);
    } finally {
        rmSync(release, { recursive: true, force: true });
        rmSync(active, { recursive: true, force: true });
    }
}

describe("prospective runner", () => {
    it("records expected and observed release root identity", async () => {
        await withRoot(async (root, active) => {
            const result = await runProspectiveCase({
                scenario: scenario(async () => ({ state: "current" })),
                releaseRole: "release-n",
                releaseRoot: root,
                expectedRelease: expectedRelease(root),
                activeCheckout: active,
                workspaceRoot: active,
                timeoutMs: 100,
            });
            expect(result.productOutcome).toBe("pass");
            expect(result.expectedRootFingerprint).toBe(result.observedRootFingerprint);
        });
    });

    it("keeps product crashes as failures and infrastructure errors incomplete", async () => {
        await withRoot(async (root, active) => {
            const base = {
                releaseRole: "release-n" as const,
                releaseRoot: root,
                expectedRelease: expectedRelease(root),
                activeCheckout: active,
                workspaceRoot: active,
                timeoutMs: 100,
            };
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
});
