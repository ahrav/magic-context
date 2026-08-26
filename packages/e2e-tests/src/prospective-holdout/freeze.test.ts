import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { loadClose, loadFreeze, publishClose, publishFreeze, readTrustedManifestRegistry } from "./freeze";
import { type CohortCloseManifest, parseFreezeManifest } from "./contract";
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
});
