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
 * Writes the artifact directory the way a close installed into a repository
 * appears to validation, without going through `publishClose`. Returns the
 * fingerprint the load path demands.
 */
function installCloseArtifact(dir: string, manifest: CohortCloseManifest): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return canonicalFingerprint(manifest);
}

/**
 * Assembles the smallest repository `validateHoldoutRepository` accepts and returns the
 * epoch root. A ledger that stops at `frozen` owes only the freeze artifact and the
 * ledger itself, so the epoch's artifact set is what the run is left to check. Returns
 * the epoch root, which is the artifact parent a publish stages into.
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
            // A publisher killed between `mkdtempSync` and its rename leaves exactly this
            // directory beside the artifact, holding the manifest it had already written.
            const orphan = mkdtempSync(join(root, ".staging-"));
            writeFileSync(join(orphan, "manifest.json"), `${JSON.stringify(freeze, null, 2)}\n`);
            const stale = new Date(Date.now() - 600_000);
            utimesSync(orphan, stale, stale);
            const live = mkdtempSync(join(root, ".staging-"));
            // The identical retry is the documented recovery, and it publishes through the
            // accept-existing path, so it is the run that has to clear the leftover.
            expect(publishFreeze(freeze, destination, readyPolicies())).toEqual(published);
            expect(existsSync(orphan)).toBe(false);
            // A directory touched a moment ago is indistinguishable from one a concurrent
            // publisher is about to rename, so age is what holds the removal back.
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
            // A publisher killed mid-publish leaves this directory in the epoch root. Reading
            // it as a committed artifact rejects the epoch, which strands the identical retry
            // that is meant to recover it until an operator deletes the directory by hand.
            const orphan = mkdtempSync(join(epoch, ".staging-"));
            expect(validateHoldoutRepository(root).states).toEqual({ "epoch-test-release": "frozen" });
            // Validation reads the tree without changing it, so the removal stays with the
            // publisher that owns the parent.
            expect(existsSync(orphan)).toBe(true);
            // A name that is not the shape `mkdtempSync` produces falls outside the filter.
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
