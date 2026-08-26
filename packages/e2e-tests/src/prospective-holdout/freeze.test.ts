import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { loadClose, loadFreeze, publishClose, publishFreeze, readTrustedManifestRegistry } from "./freeze";
import { parseFreezeManifest } from "./contract";
import { closeManifest, freezeManifest, readyPolicies } from "./test-fixtures";

describe("freeze and close publication", () => {
    it("publishes once and requires external trust on reload", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-freeze-"));
        try {
            const freeze = freezeManifest();
            const destination = join(root, "freeze");
            const published = publishFreeze(freeze, destination, readyPolicies());
            expect(published.manifestFingerprint).toBe(canonicalFingerprint(freeze));
            expect(() => publishFreeze(freeze, destination, readyPolicies())).toThrow(/destination-exists/);
            expect(() => loadFreeze(destination, "f".repeat(64), readyPolicies())).toThrow(/untrusted/);

            const close = closeManifest(freeze);
            const closed = publishClose(close, join(root, "close"), published);
            expect(loadClose(join(root, "close"), closed.manifestFingerprint, published).manifest.body.cases).toHaveLength(1);
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
