import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContractError } from "./contract";
import {
    AUDIT_CELL,
    type BenchmarkProfile,
    checkHostResources,
    estimateCaseResources,
    estimateProfileResources,
    loadProfileFile,
    MAX_PROFILE_CASES,
    parseProfile,
    PROFILE_AXIS_ENDPOINTS,
    profileFingerprint,
    verifySelectivityObservation,
} from "./profiles";

const THIRTY_GIB = 30 * 2 ** 30;

const PROFILE_DIR = join(
    import.meta.dir,
    "..",
    "fixtures",
    "retrieval-benchmark",
    "profiles",
    "v1",
);
const PROFILE_FILES = ["ci.json", "arm-neon.json", "x86-avx2.json"] as const;

function loadFixtureProfile(name: (typeof PROFILE_FILES)[number]): BenchmarkProfile {
    return loadProfileFile(join(PROFILE_DIR, name));
}

function fixtureProfileJson(name: (typeof PROFILE_FILES)[number]): BenchmarkProfile {
    return JSON.parse(readFileSync(join(PROFILE_DIR, name), "utf8"));
}

function diagnosticsOf(fn: () => unknown): string[] {
    try {
        fn();
    } catch (error) {
        if (error instanceof ContractError) return [...error.diagnostics];
        throw error;
    }
    throw new Error("expected ContractError");
}

describe("fixture profiles", () => {
    it("validate strictly with a fixed case count", () => {
        for (const name of PROFILE_FILES) {
            const profile = loadFixtureProfile(name);
            expect(profile.expectedCaseCount).toBe(profile.cases.length);
            expect(profile.cases.length).toBeLessThanOrEqual(MAX_PROFILE_CASES);
        }
        // The two reference profiles share one case set; the CI profile
        // omits the heavy endpoint cases.
        const caseIds = (["arm-neon.json", "x86-avx2.json"] as const).map((name) =>
            loadFixtureProfile(name)
                .cases.map((profileCase) => profileCase.id)
                .join(","),
        );
        expect(new Set(caseIds).size).toBe(1);
    });

    it("cover every axis endpoint, the audit cell, and stay non-Cartesian", () => {
        const profile = loadFixtureProfile("arm-neon.json");
        const scales = profile.cases.map((c) => c.scale);
        expect(scales).toContain(PROFILE_AXIS_ENDPOINTS.scale.min);
        expect(scales).toContain(PROFILE_AXIS_ENDPOINTS.scale.max);
        const dims = profile.cases.map((c) => c.dims);
        expect(dims).toContain(PROFILE_AXIS_ENDPOINTS.dims.min);
        expect(dims).toContain(PROFILE_AXIS_ENDPOINTS.dims.max);
        const ks = profile.cases.map((c) => c.candidateK.requested);
        expect(ks).toContain(PROFILE_AXIS_ENDPOINTS.candidateK.min);
        expect(ks).toContain(PROFILE_AXIS_ENDPOINTS.candidateK.max);
        const fractions = profile.cases.map((c) => c.selectivity.fraction);
        expect(fractions).toContain(PROFILE_AXIS_ENDPOINTS.selectivityFraction.min);
        expect(fractions).toContain(PROFILE_AXIS_ENDPOINTS.selectivityFraction.max);
        const concurrency = profile.cases.map((c) => c.concurrency);
        expect(concurrency).toContain(PROFILE_AXIS_ENDPOINTS.concurrency.min);
        expect(concurrency).toContain(PROFILE_AXIS_ENDPOINTS.concurrency.max);
        expect(
            profile.cases.some(
                (c) =>
                    c.scale === AUDIT_CELL.scale &&
                    c.dims === AUDIT_CELL.dims &&
                    c.mode === "automatic",
            ),
        ).toBe(true);

        const axisProduct =
            new Set(scales).size *
            new Set(dims).size *
            new Set(ks).size *
            new Set(fractions).size *
            new Set(concurrency).size *
            new Set(profile.cases.map((c) => c.mode)).size;
        expect(profile.cases.length).toBeLessThan(axisProduct);
    });

    it("declare an identical fingerprint only for identical profile bytes", () => {
        const ci = loadFixtureProfile("ci.json");
        const arm = loadFixtureProfile("arm-neon.json");
        expect(profileFingerprint(ci)).toBe(profileFingerprint(loadFixtureProfile("ci.json")));
        expect(profileFingerprint(ci)).not.toBe(profileFingerprint(arm));
    });

    it("reject non-canonical profile bytes", () => {
        const dir = mkdtempSync(join(tmpdir(), "profile-bytes-"));
        try {
            const canonical = readFileSync(join(PROFILE_DIR, "ci.json"), "utf8");
            const path = join(dir, "profile.json");
            // Same JSON value, one extra trailing newline: the loader's
            // byte-for-byte canonical rule must reject it.
            writeFileSync(path, `${canonical}\n`);
            expect(() => loadProfileFile(path)).toThrow(ContractError);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reject an unreadable profile file", () => {
        expect(() => loadProfileFile(join(PROFILE_DIR, "..", "missing.json"))).toThrow(
            ContractError,
        );
    });
});

describe("parseProfile required cells", () => {
    it("rejects a reference profile missing the required K=100 cell", () => {
        const profile = fixtureProfileJson("arm-neon.json");
        for (const profileCase of profile.cases) {
            if (profileCase.candidateK.requested === 100) {
                profileCase.candidateK = { requested: 50, effective: 50 };
            }
        }
        expect(diagnosticsOf(() => parseProfile(profile))).toContain(
            "profile.cases: missing candidate K 100",
        );
    });

    it("rejects a reference profile missing a selectivity endpoint", () => {
        const profile = fixtureProfileJson("arm-neon.json");
        for (const profileCase of profile.cases) {
            if (profileCase.selectivity.fraction === 0.001) {
                profileCase.selectivity.fraction = 0.01;
                profileCase.selectivity.eligibleCount = Math.round(
                    profileCase.selectivity.preFilterDenominator * 0.01,
                );
                profileCase.selectivity.expectedScannedCount =
                    profileCase.selectivity.eligibleCount;
                profileCase.selectivity.predicate.messageOrdinalCutoff =
                    profileCase.selectivity.eligibleCount;
            }
        }
        expect(diagnosticsOf(() => parseProfile(profile))).toContain(
            "profile.cases: missing selectivity endpoint 0.001",
        );
    });

    it("rejects a missing audit cell and a missing interaction corner", () => {
        const noAudit = fixtureProfileJson("arm-neon.json");
        noAudit.cases = noAudit.cases.filter(
            (profileCase) => profileCase.id !== "case-audit-auto-100k-384",
        );
        noAudit.expectedCaseCount = noAudit.cases.length;
        expect(diagnosticsOf(() => parseProfile(noAudit))).toContain(
            "profile.cases: missing 100K/384 audit cell",
        );

        const noCorner = fixtureProfileJson("arm-neon.json");
        noCorner.cases = noCorner.cases.filter(
            (profileCase) => profileCase.id !== "case-corner-1m-1024-c8",
        );
        noCorner.expectedCaseCount = noCorner.cases.length;
        const diagnostics = diagnosticsOf(() => parseProfile(noCorner));
        expect(diagnostics).toContain("profile.cases: missing 1M/1024/concurrency-8 corner");
    });

    it("exempts the CI host class from heavy axis endpoints but not structural cells", () => {
        // The checked-in CI profile has no 1M/1024/concurrency-8 cases and
        // still parses; the SAME case set under a reference host class must
        // reject for the missing heavy endpoints.
        const ci = fixtureProfileJson("ci.json");
        expect(() => parseProfile(ci)).not.toThrow();
        const promoted = fixtureProfileJson("ci.json");
        promoted.host = {
            class: "x86-avx2",
            cpuArchitecture: "x64",
            minTotalMemoryBytes: promoted.host.minTotalMemoryBytes,
            minAvailableDiskBytes: promoted.host.minAvailableDiskBytes,
        };
        const diagnostics = diagnosticsOf(() => parseProfile(promoted));
        expect(diagnostics).toContain("profile.cases: missing scale endpoint 1000000");
        expect(diagnostics).toContain("profile.cases: missing 1M/1024/concurrency-8 corner");

        // Structural cells stay mandatory for the CI class.
        const noAutomatic = fixtureProfileJson("ci.json");
        noAutomatic.cases = noAutomatic.cases.filter(
            (profileCase) => profileCase.mode !== "automatic",
        );
        noAutomatic.expectedCaseCount = noAutomatic.cases.length;
        expect(diagnosticsOf(() => parseProfile(noAutomatic))).toContain(
            "profile.cases: missing automatic mode",
        );
    });

    it("rejects an expected case count that disagrees with the enumerated cases", () => {
        const profile = fixtureProfileJson("ci.json");
        profile.expectedCaseCount = profile.cases.length + 1;
        expect(diagnosticsOf(() => parseProfile(profile))).toContain(
            "profile.expectedCaseCount: mismatch",
        );
    });

    it("rejects a requested/effective candidate-K mismatch", () => {
        const profile = fixtureProfileJson("ci.json");
        profile.cases[0].candidateK.effective = profile.cases[0].candidateK.requested - 1;
        expect(diagnosticsOf(() => parseProfile(profile)).join(";")).toContain(
            "requested-effective-mismatch",
        );
    });

    it("rejects selectivity numbers outside the discrete rounding rule", () => {
        const profile = fixtureProfileJson("arm-neon.json");
        const cell = profile.cases.find(
            (profileCase) => profileCase.selectivity.fraction === 0.001,
        );
        if (!cell) throw new Error("missing selectivity-min case");
        cell.selectivity.eligibleCount += 5;
        cell.selectivity.predicate.messageOrdinalCutoff = cell.selectivity.eligibleCount;
        expect(diagnosticsOf(() => parseProfile(profile)).join(";")).toContain(
            "outside-rounding-rule",
        );
    });

    it("rejects a cutoff predicate that disagrees with the declared eligible count", () => {
        const profile = fixtureProfileJson("arm-neon.json");
        const cell = profile.cases.find(
            (profileCase) => profileCase.selectivity.fraction === 0.001,
        );
        if (!cell) throw new Error("missing selectivity-min case");
        cell.selectivity.predicate.messageOrdinalCutoff =
            cell.selectivity.eligibleCount + 1;
        expect(diagnosticsOf(() => parseProfile(profile)).join(";")).toContain(
            "cutoff-eligible-mismatch",
        );
    });

    it("rejects unknown fields recursively", () => {
        const profile = fixtureProfileJson("ci.json") as Record<string, unknown>;
        profile.surprise = true;
        expect(() => parseProfile(profile)).toThrow(ContractError);
    });
});

describe("resource preflight", () => {
    it("prices the 1M/1024/concurrency-8 corner above 30 GiB of f32 worker payload", () => {
        const profile = loadFixtureProfile("arm-neon.json");
        const corner = profile.cases.find(
            (profileCase) => profileCase.id === "case-corner-1m-1024-c8",
        );
        if (!corner) throw new Error("missing corner case");
        const estimate = estimateCaseResources(corner);
        expect(estimate.vectorPayloadBytes).toBe(1_000_000 * 1_024 * 4);
        expect(estimate.workerPayloadBytes).toBe(estimate.vectorPayloadBytes * 8);
        expect(estimate.workerPayloadBytes).toBeGreaterThan(THIRTY_GIB);
        expect(estimate.peakRssBytes).toBeGreaterThan(estimate.workerPayloadBytes);
        expect(estimate.requiredDiskBytes).toBeGreaterThan(estimate.fixtureDiskBytes);
    });

    it("fails an undersized host before allocation and names the offending case", () => {
        const profile = loadFixtureProfile("x86-avx2.json");
        const undersized = checkHostResources(profile, {
            totalMemoryBytes: 16 * 2 ** 30,
            availableDiskBytes: 100 * 2 ** 30,
            cpuArchitecture: "x64",
        });
        expect(undersized.ok).toBe(false);
        expect(undersized.diagnostics.join(";")).toContain(
            "preflight: insufficient memory for case (case-corner-1m-1024-c8)",
        );

        const qualifying = checkHostResources(profile, {
            totalMemoryBytes: 64 * 2 ** 30,
            availableDiskBytes: 100 * 2 ** 30,
            cpuArchitecture: "x64",
        });
        expect(qualifying).toEqual({ ok: true, diagnostics: [] });
    });

    it("rejects a host architecture mismatch for a pinned reference profile", () => {
        const profile = loadFixtureProfile("arm-neon.json");
        const result = checkHostResources(profile, {
            totalMemoryBytes: 64 * 2 ** 30,
            availableDiskBytes: 100 * 2 ** 30,
            cpuArchitecture: "x64",
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics.join(";")).toContain("host architecture mismatch");
    });

    it("keeps profile budgets and host declarations above the worst-case estimate", () => {
        for (const name of PROFILE_FILES) {
            const profile = loadFixtureProfile(name);
            const estimate = estimateProfileResources(profile);
            expect(estimate.maxPeakRssBytes).toBeLessThanOrEqual(
                profile.host.minTotalMemoryBytes,
            );
            expect(estimate.maxRequiredDiskBytes).toBeLessThanOrEqual(
                profile.host.minAvailableDiskBytes,
            );
            // All unique fixtures stay on disk for the whole run, so the
            // host declaration must cover their sum, not just the max.
            expect(estimate.totalRequiredDiskBytes).toBeLessThanOrEqual(
                profile.host.minAvailableDiskBytes,
            );
            expect(estimate.maxFixtureDiskBytes).toBeLessThanOrEqual(
                profile.budgets.maxFixtureBytes,
            );
        }
    });
});

describe("verifySelectivityObservation", () => {
    it("accepts observations within the rounding tolerance and rejects drift", () => {
        const profile = loadFixtureProfile("arm-neon.json");
        const cell = profile.cases.find(
            (profileCase) => profileCase.selectivity.fraction === 0.001,
        );
        if (!cell) throw new Error("missing selectivity-min case");
        expect(
            verifySelectivityObservation(cell.selectivity, {
                preFilterDenominator: cell.selectivity.preFilterDenominator,
                eligibleCount: cell.selectivity.eligibleCount + 1,
            }).ok,
        ).toBe(true);
        const drifted = verifySelectivityObservation(cell.selectivity, {
            preFilterDenominator: cell.selectivity.preFilterDenominator,
            eligibleCount: cell.selectivity.eligibleCount + 5,
        });
        expect(drifted.ok).toBe(false);
        expect(drifted.diagnostics.join(";")).toContain("rounding tolerance");
    });
});
