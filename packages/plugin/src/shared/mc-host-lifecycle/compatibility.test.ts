import { describe, expect, test } from "bun:test";
import type { CatalogEntry } from "../mc-host-client";
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

const healthyCatalog = [
    entry("magic-context", "0.1.0"),
    entry("synapse", "0.1.0"),
    entry("broca", "0.1.0"),
];

const healthyEpochs = { ...releaseContract.epochs };

describe("daemon version range (U3 scenario 12)", () => {
    test("in-range authenticated versions pass; bounds are half-open", () => {
        expect(evaluateDaemonCompatibility("mc-host/0.1.0")).toEqual({ ok: true });
        expect(evaluateDaemonCompatibility("mc-host/0.1.99")).toEqual({ ok: true });
        for (const bad of ["mc-host/0.2.0", "mc-host/0.0.9", "other/0.1.0", "mc-host/1", "0.1.0"]) {
            const verdict = evaluateDaemonCompatibility(bad);
            expect(verdict.ok).toBe(false);
            if (!verdict.ok) expect(verdict.reason).toBe("incompatible_daemon");
        }
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
});

describe("composed gate order", () => {
    test("daemon range failure wins over module and epoch failures", () => {
        const verdict = evaluateCompatibility({
            authenticatedDaemonVer: "mc-host/0.2.0",
            catalog: [],
            epochs: {},
        });
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toBe("incompatible_daemon");
    });

    test("a healthy triple passes end to end", () => {
        expect(
            evaluateCompatibility({
                authenticatedDaemonVer: releaseContract.versions.daemon,
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
        // Each of these would parse to an in-range triple under `\d+`, so the
        // range gate would accept a non-canonical version.
        for (const bad of ["00.1.0", "0.01.0", "0.1.00", "00.01.000", "01.2.3"]) {
            expect(parseSemverTriple(bad)).toBeNull();
        }
    });

    test("a non-canonical daemon version fails the compatibility gate", () => {
        // `00.01.000` normalizes to `[0, 1, 0]`, which is inside the supported
        // half-open range, so only canonical-form rejection keeps this closed.
        const verdict = evaluateDaemonCompatibility("mc-host/00.01.000");
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) {
            expect(verdict.reason).toBe("incompatible_daemon");
            expect(verdict.detail).toBe("daemon version is not a canonical mc-host/X.Y.Z value");
        }
    });
});
