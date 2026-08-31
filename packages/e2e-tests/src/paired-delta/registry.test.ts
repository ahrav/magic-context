import { describe, expect, it } from "bun:test";
import manifestJson from "../../pools/paired-delta-manifest.json";
import {
    assertFrozenPool,
    buildPairedDeltaRegistry,
    computeManifestEntries,
} from "./registry";
import { parsePairedDeltaManifest } from "./contract";

describe("paired-delta pool freeze", () => {
    it("matches every registered scenario to the committed manifest", () => {
        const manifest = parsePairedDeltaManifest(manifestJson);
        expect(() => assertFrozenPool(buildPairedDeltaRegistry(), manifest)).not.toThrow();
    });

    it("rejects semantic and verifier drift while allowing run-mode edits", () => {
        const registry = buildPairedDeltaRegistry();
        const manifest = parsePairedDeltaManifest(manifestJson);
        const semanticDrift = structuredClone(manifest);
        semanticDrift.scenarios[0]!.semanticFingerprint = "0".repeat(64);
        expect(() => assertFrozenPool(registry, semanticDrift)).toThrow(
            new RegExp(manifest.scenarios[0]!.scenarioId),
        );
        const verifierDrift = structuredClone(manifest);
        verifierDrift.scenarios[0]!.verifierBundleDigest = "0".repeat(64);
        expect(() => assertFrozenPool(registry, verifierDrift)).toThrow(
            new RegExp(manifest.scenarios[0]!.scenarioId),
        );
        const membershipEdit = structuredClone(manifest);
        membershipEdit.scenarios[0]!.runModes = ["release"];
        expect(() => assertFrozenPool(registry, membershipEdit)).not.toThrow();
    });

    it("rejects missing registrations in either direction", () => {
        const registry = buildPairedDeltaRegistry();
        const manifest = parsePairedDeltaManifest(manifestJson);
        expect(() =>
            assertFrozenPool(
                registry,
                { ...manifest, scenarios: manifest.scenarios.slice(1) },
            ),
        ).toThrow(/manifest correspondence/);
        const firstOnly = new Map([...registry].slice(0, 1));
        expect(() => assertFrozenPool(firstOnly, manifest)).toThrow(/manifest correspondence/);
    });

    it("computes stable entries for the current registry", () => {
        expect(computeManifestEntries(buildPairedDeltaRegistry())).toEqual(
            parsePairedDeltaManifest(manifestJson).scenarios,
        );
    });
});
