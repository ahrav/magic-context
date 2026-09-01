import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { loadClose, loadFreeze, publishClose, publishFreeze, readTrustedManifestRegistry } from "./freeze";
import { type CohortCloseManifest, parseFreezeManifest } from "./contract";
import { appendLifecycleEvent } from "./lifecycle";
import { validateHoldoutRepository } from "./validation";
import { closeManifest, freezeManifest, readyPolicies } from "./test-fixtures";

/** Approvals bind to the body, so a mutated body needs its approvals re-derived. */
function rebindApprovals(manifest: CohortCloseManifest): CohortCloseManifest {
    const subjectFingerprint = canonicalFingerprint(manifest.body);
    for (const approval of manifest.approvals) approval.subjectFingerprint = subjectFingerprint;
    return manifest;
}

/**
 * Tests use `installCloseArtifact` to bypass `publishClose` validation.
 */
function installCloseArtifact(dir: string, manifest: CohortCloseManifest): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return canonicalFingerprint(manifest);
}

/**
 */
function frozenRepository(e2eRoot: string): string {
    const holdout = join(e2eRoot, "prospective-holdout");
    const epoch = join(holdout, "epochs", "epoch-test-release");
    mkdirSync(join(holdout, "policies"), { recursive: true });
    mkdirSync(epoch, { recursive: true });
    const policies = readyPolicies();
    writeFileSync(
        join(holdout, "policies", "analysis-policy.json"),
        `${JSON.stringify(policies.analysis, null, 2)}\n`,
    );
    writeFileSync(
        join(holdout, "policies", "scorecard-policy.json"),
        `${JSON.stringify(policies.scorecard, null, 2)}\n`,
    );
    const freeze = publishFreeze(freezeManifest(), join(epoch, "freeze"), policies);
    const lifecycle = appendLifecycleEvent([], {
        epochId: freeze.manifest.body.epochId,
        state: "frozen",
        occurredAt: "2026-09-01T00:00:00Z",
        artifactFingerprint: freeze.manifestFingerprint,
        reasonCode: null,
        approvers: ["reviewer-one"],
    });
    writeFileSync(join(epoch, "lifecycle.jsonl"), `${lifecycle.map(canonicalJson).join("\n")}\n`);
    const trust = [
        {
            schema: "prospective-trust-entry/v1",
            epochId: freeze.manifest.body.epochId,
            kind: "freeze",
            sequence: null,
            manifestFingerprint: freeze.manifestFingerprint,
        },
        ...lifecycle.map((_, index) => ({
            schema: "prospective-trust-entry/v1",
            epochId: freeze.manifest.body.epochId,
            kind: "lifecycle",
            sequence: index + 1,
            manifestFingerprint: canonicalFingerprint(lifecycle.slice(0, index + 1)),
        })),
    ];
    writeFileSync(join(holdout, "trusted-manifests.jsonl"), `${trust.map(canonicalJson).join("\n")}\n`);
    return epoch;
}

describe("freeze and close publication", () => {
    it("publishes once and requires external trust on reload", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-freeze-"));
        try {
            const freeze = freezeManifest();
            const destination = join(root, "freeze");
            const published = publishFreeze(freeze, destination, readyPolicies());
            expect(published.manifestFingerprint).toBe(canonicalFingerprint(freeze));
            expect(publishFreeze(freeze, destination, readyPolicies())).toEqual(published);
            const conflict = structuredClone(freeze);
            conflict.body.evaluatorFingerprint = "f".repeat(64);
            const subjectFingerprint = canonicalFingerprint(conflict.body);
            for (const approval of conflict.approvals) approval.subjectFingerprint = subjectFingerprint;
            expect(() => publishFreeze(conflict, destination, readyPolicies())).toThrow(/destination-conflict/);
            expect(() => loadFreeze(destination, "f".repeat(64), readyPolicies())).toThrow(/untrusted/);

            const close = closeManifest(freeze);
            const closeDestination = join(root, "close");
            const closed = publishClose(close, closeDestination, published);
            expect(publishClose(close, closeDestination, published)).toEqual(closed);
            expect(loadClose(closeDestination, closed.manifestFingerprint, published).manifest.body.cases).toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects an installed close stamped before the frozen intake cutoff", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-close-cutoff-"));
        try {
            const freeze = freezeManifest();
            const published = publishFreeze(freeze, join(root, "freeze"), readyPolicies());

            const early = closeManifest(freeze);
            early.body.closedAt = "2026-09-07T00:00:00Z";
            rebindApprovals(early);
            const earlyDir = join(root, "close-early");
            const earlyFingerprint = installCloseArtifact(earlyDir, early);
            expect(() => loadClose(earlyDir, earlyFingerprint, published)).toThrow(/close\.closedAt: before-cutoff/);
            expect(() => publishClose(early, join(root, "close-published"), published))
                .toThrow(/close\.closedAt: before-cutoff/);

            const onTimeDir = join(root, "close");
            const closed = publishClose(closeManifest(freeze), onTimeDir, published);
            expect(loadClose(onTimeDir, closed.manifestFingerprint, published).manifest.body.closedAt)
                .toBe(freeze.body.intakeWindow.closesAt);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a close sharing an approver with the freeze on both paths", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-close-independence-"));
        try {
            const freeze = freezeManifest();
            const published = publishFreeze(freeze, join(root, "freeze"), readyPolicies());
            // Only pair-level validation can reject a release operator or independent reviewer shared by both manifests.
            // Each manifest parser validates only its own two approvers.
            for (const [seat, approver] of [[0, "operator-one"], [1, "reviewer-five"]] as const) {
                const shared = closeManifest(freeze);
                // Approvals are outside the fingerprinted subject.
                // The close manifest's two approvers remain distinct.
                // The close manifest can check independence only between its own two approvers.
                shared.approvals[seat]!.approver = approver;
                const installed = join(root, `close-shared-${seat}`);
                const fingerprint = installCloseArtifact(installed, shared);
                expect(() => loadClose(installed, fingerprint, published))
                    .toThrow(/close\.approvals: freeze-independence-required/);
                expect(() => publishClose(shared, join(root, `close-shared-published-${seat}`), published))
                    .toThrow(/close\.approvals: freeze-independence-required/);
            }
            // The fixture uses four distinct actors to satisfy cross-manifest independence.
            const destination = join(root, "close");
            const closed = publishClose(closeManifest(freeze), destination, published);
            expect(loadClose(destination, closed.manifestFingerprint, published)
                .manifest.approvals.map((approval) => approval.approver))
                .toEqual(["custodian-one", "reviewer-two"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reports one freeze-link diagnostic for either broken close link", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-close-link-"));
        try {
            const freeze = freezeManifest();
            const published = publishFreeze(freeze, join(root, "freeze"), readyPolicies());

            const foreignEpoch = closeManifest(freeze);
            foreignEpoch.body.epochId = "epoch-other-release";
            rebindApprovals(foreignEpoch);
            const epochDir = join(root, "close-epoch");
            const epochFingerprint = installCloseArtifact(epochDir, foreignEpoch);
            expect(() => loadClose(epochDir, epochFingerprint, published)).toThrow(/close: freeze-link-invalid/);

            const foreignFreeze = closeManifest(freeze);
            foreignFreeze.body.freezeManifestFingerprint = "e".repeat(64);
            rebindApprovals(foreignFreeze);
            const freezeDir = join(root, "close-freeze");
            const freezeFingerprint = installCloseArtifact(freezeDir, foreignFreeze);
            expect(() => loadClose(freezeDir, freezeFingerprint, published)).toThrow(/close: freeze-link-invalid/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("requires distinct immutable references and release-root manifests", () => {
        const reusedReference = freezeManifest();
        reusedReference.body.releases[1]!.immutableReference = reusedReference.body.releases[0]!.immutableReference;
        expect(() => parseFreezeManifest(reusedReference)).toThrow(/immutable-reference-reused/);

        const reusedManifest = freezeManifest();
        reusedManifest.body.releases[1]!.releaseRootManifestFingerprint =
            reusedManifest.body.releases[0]!.releaseRootManifestFingerprint;
        expect(() => parseFreezeManifest(reusedManifest)).toThrow(/release-root-manifest-reused/);

        const wrongPolicyVersion = freezeManifest();
        wrongPolicyVersion.body.policies.analysis.schemaVersion = "analysis-contract/v2";
        const subjectFingerprint = canonicalFingerprint(wrongPolicyVersion.body);
        for (const approval of wrongPolicyVersion.approvals) approval.subjectFingerprint = subjectFingerprint;
        expect(() => publishFreeze(wrongPolicyVersion, "/unused", readyPolicies())).toThrow(/schema-version-mismatch/);
    });

    it("rejects symlinked artifact directories", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-freeze-symlink-"));
        try {
            const target = join(root, "target");
            const published = publishFreeze(freezeManifest(), target, readyPolicies());
            const link = join(root, "link");
            symlinkSync(target, link, "dir");
            expect(() => loadFreeze(link, published.manifestFingerprint, readyPolicies())).toThrow(/directory-not-regular/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("accepts empty pre-first-freeze trust and rejects noncanonical entries", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-trust-"));
        try {
            const path = join(root, "trusted.jsonl");
            writeFileSync(path, "");
            expect(readTrustedManifestRegistry(path)).toEqual([]);
            const entry = {
                schema: "prospective-trust-entry/v1",
                epochId: "epoch-test-release",
                kind: "freeze",
                sequence: null,
                manifestFingerprint: "a".repeat(64),
            };
            writeFileSync(path, `${JSON.stringify(entry)}\n`);
            expect(() => readTrustedManifestRegistry(path)).toThrow(/non-canonical/);
            writeFileSync(path, `${canonicalJson(entry)}\n`);
            expect(readTrustedManifestRegistry(path)).toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("removes an orphaned staging directory on retry and leaves a live one alone", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-staging-"));
        try {
            const freeze = freezeManifest();
            const destination = join(root, "freeze");
            const published = publishFreeze(freeze, destination, readyPolicies());
            // A publisher that dies after writing its staging manifest but before rename leaves a staging directory beside the artifact.
            const orphan = mkdtempSync(join(root, ".staging-"));
            writeFileSync(join(orphan, "manifest.json"), `${JSON.stringify(freeze, null, 2)}\n`);
            const stale = new Date(Date.now() - 600_000);
            utimesSync(orphan, stale, stale);
            const live = mkdtempSync(join(root, ".staging-"));
            // An identical retry uses the `accept-existing` path.
            expect(publishFreeze(freeze, destination, readyPolicies())).toEqual(published);
            expect(existsSync(orphan)).toBe(false);
            // Age prevents removal because a recently touched staging directory may belong to a concurrent publisher about to rename it.
            // Age prevents removal because a recently touched staging directory may belong to a concurrent publisher about to rename it.
            expect(existsSync(live)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("validates an epoch carrying an orphaned staging directory and rejects unexpected entries", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-staging-epoch-"));
        try {
            const epoch = frozenRepository(root);
            expect(validateHoldoutRepository(root).states).toEqual({ "epoch-test-release": "frozen" });
            // Validation rejects an epoch when it reads a leftover staging directory as a committed artifact.
            // The `accept-existing` path does not use a staging directory as a published artifact.
            const orphan = mkdtempSync(join(epoch, ".staging-"));
            expect(validateHoldoutRepository(root).states).toEqual({ "epoch-test-release": "frozen" });
            // Validation reads the tree without changing it.
            // Validation does not remove staging directories; the publisher that owns the parent does.
            expect(existsSync(orphan)).toBe(true);
            const nearMiss = join(epoch, ".staging-toolong");
            mkdirSync(nearMiss);
            expect(() => validateHoldoutRepository(root)).toThrow(/epoch: artifact-set-invalid/);
            rmSync(nearMiss, { recursive: true, force: true });
            mkdirSync(join(epoch, "unexpected-artifact"));
            expect(() => validateHoldoutRepository(root)).toThrow(/epoch: artifact-set-invalid/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
