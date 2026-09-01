import { describe, expect, test } from "bun:test";
import type { AuthenticatedPeer, CatalogEntry } from "../mc-host-client";
import {
    evaluateCompatibility,
    evaluateDaemonCompatibility,
    evaluateEpochCompatibility,
    evaluateModuleCompatibility,
    observedEpochsFromMagicContextMetrics,
    parseSemverTriple,
} from "./compatibility";
import { releaseContract } from "./generated-contract";

function entry(id: string, version: string): CatalogEntry {
    return { module_id: id, module_version: version, roles: [], control_ops: [] };
}

function peer(daemonVer: string): AuthenticatedPeer {
    return { daemonVer, daemonId: new Uint8Array(16), proof: "current" };
}

const healthyCatalog = [
    entry("magic-context", "0.1.0"),
    entry("synapse", "0.1.0"),
    entry("broca", "0.1.0"),
];

const healthyEpochs = { ...releaseContract.epochs };

describe("daemon version range (U3 scenario 12)", () => {
    test("in-range authenticated versions pass; bounds are half-open", () => {
        expect(evaluateDaemonCompatibility(peer("mc-host/0.1.0"))).toEqual({ ok: true });
        expect(evaluateDaemonCompatibility(peer("mc-host/0.1.99"))).toEqual({ ok: true });
        for (const bad of [
            "mc-host/0.2.0",
            "mc-host/0.0.9",
            "other/0.1.0",
            "mc-host/1",
            "0.1.0",
            "mc-host/00.1.0",
            "mc-host/0.01.0",
        ]) {
            const verdict = evaluateDaemonCompatibility(peer(bad));
            expect(verdict.ok).toBe(false);
            if (!verdict.ok) expect(verdict.reason).toBe("incompatible_daemon");
        }
    });

    test("the gate consumes an authenticated peer, never a bare version string", () => {
        // A bare version string lacks `daemonVer`, so `evaluateDaemonCompatibility` throws instead of returning a verdict.
        expect(evaluateDaemonCompatibility(peer(releaseContract.versions.daemon))).toEqual({
            ok: true,
        });
        expect(() => evaluateDaemonCompatibility(releaseContract.versions.daemon as never)).toThrow(
            TypeError,
        );
    });
});

describe("module version ranges", () => {
    test("each fixed module mismatch names the exact module", () => {
        for (const moduleId of ["magic-context", "synapse", "broca"]) {
            const catalog = healthyCatalog.map((existing) =>
                existing.module_id === moduleId ? entry(moduleId, "0.2.0") : existing,
            );
            const verdict = evaluateModuleCompatibility(catalog);
            expect(verdict.ok).toBe(false);
            if (!verdict.ok) {
                expect(verdict.reason).toBe("incompatible_module");
                expect(verdict.detail).toContain(moduleId);
            }
        }
    });

    test("a missing fixed module and a malformed version are incompatible_module", () => {
        const missing = evaluateModuleCompatibility(healthyCatalog.slice(0, 2));
        expect(missing.ok).toBe(false);
        const malformed = evaluateModuleCompatibility([
            ...healthyCatalog.slice(0, 2),
            entry("broca", "not-semver"),
        ]);
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.detail).toContain("broca");
    });

    test("extra unknown modules do not fail the fixed-module check", () => {
        expect(
            evaluateModuleCompatibility([...healthyCatalog, entry("future-module", "9.9.9")]),
        ).toEqual({ ok: true });
    });
});

describe("exact epoch comparison", () => {
    test("maps the five Magic Context wire epoch names to the release contract", () => {
        expect(
            observedEpochsFromMagicContextMetrics({
                epochs: {
                    memory_render_epoch: 2,
                    compartment_render_epoch: 2,
                    profile_epoch: 2,
                    tagger_epoch: 3,
                    state_sync_epoch: 1,
                    state_sync_deltas: true,
                },
            }),
        ).toEqual(healthyEpochs);
    });

    test("missing or malformed status fields remain absent and fail closed", () => {
        expect(observedEpochsFromMagicContextMetrics(null)).toEqual({});
        expect(observedEpochsFromMagicContextMetrics({ epochs: [] })).toEqual({});
        expect(
            observedEpochsFromMagicContextMetrics({
                epochs: { state_sync_epoch: "1" },
            }),
        ).toEqual({ state_sync: "1" });
    });

    test("missing, nonnumeric, stale, and future epochs each name the epoch", () => {
        const stale = { ...healthyEpochs, tagger: healthyEpochs.tagger - 1 };
        const future = { ...healthyEpochs, tagger: healthyEpochs.tagger + 1 };
        const missing: Record<string, unknown> = { ...healthyEpochs };
        delete missing.state_sync;
        const nonnumeric = { ...healthyEpochs, memory_render: "2" };
        for (const observed of [stale, future, missing, nonnumeric]) {
            const verdict = evaluateEpochCompatibility(observed as never);
            expect(verdict.ok).toBe(false);
            if (!verdict.ok) expect(verdict.reason).toBe("incompatible_epochs");
        }
        expect(evaluateEpochCompatibility(healthyEpochs)).toEqual({ ok: true });
    });

    test("an unknown epoch key fails even when every expected epoch matches", () => {
        // Decoded JSON can contain keys absent from the contract; the observed key set must equal the contract key set.
        const withFuture = { ...healthyEpochs, future_contract: 99 };
        const verdict = evaluateEpochCompatibility(withFuture as never);
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toBe("incompatible_epochs");
    });
});

describe("composed gate order", () => {
    test("daemon range failure wins over module and epoch failures", () => {
        const verdict = evaluateCompatibility({
            authenticatedPeer: peer("mc-host/0.2.0"),
            catalog: [],
            epochs: {},
        });
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toBe("incompatible_daemon");
    });

    test("a healthy triple passes end to end", () => {
        expect(
            evaluateCompatibility({
                authenticatedPeer: peer(releaseContract.versions.daemon),
                catalog: healthyCatalog,
                epochs: healthyEpochs,
            }),
        ).toEqual({ ok: true });
    });
});

describe("semver parsing", () => {
    test("only canonical X.Y.Z parses", () => {
        expect(parseSemverTriple("1.2.3")).toEqual([1, 2, 3]);
        for (const bad of ["1.2", "1.2.3.4", "v1.2.3", "1.2.x", ""]) {
            expect(parseSemverTriple(bad)).toBeNull();
        }
    });
    test("leading zeroes are rejected rather than normalized", () => {
        expect(parseSemverTriple("0.1.0")).toEqual([0, 1, 0]);
        for (const bad of ["00.1.0", "0.01.0", "0.1.00", "00.01.000", "01.2.3"]) {
            expect(parseSemverTriple(bad)).toBeNull();
        }
    });

    test("a non-canonical daemon version fails the compatibility gate", () => {
        // Canonical validation rejects leading-zero spellings that `\d+` parses as in-range triples.
        // `00.01.000` normalizes to `[0, 1, 0]`, which is within the supported half-open range; canonical validation must reject it.
        const verdict = evaluateDaemonCompatibility(peer("mc-host/00.01.000"));
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) {
            expect(verdict.reason).toBe("incompatible_daemon");
            expect(verdict.detail).toBe("daemon version is not a canonical mc-host/X.Y.Z value");
        }
    });

    test("leading-zero components are not canonical", () => {
        // `00.1.0` and `0.1.0` parse to the same triple.
        for (const bad of ["00.1.0", "0.01.0", "0.1.00", "01.2.3", "0.0.01"]) {
            expect(parseSemverTriple(bad)).toBeNull();
        }
        expect(parseSemverTriple("0.0.0")).toEqual([0, 0, 0]);
        expect(parseSemverTriple("10.20.30")).toEqual([10, 20, 30]);
    });
});
