/**
 * Versioned sparse benchmark profiles (KTD14, R58).
 *
 * A profile enumerates an EXACT bounded case set — anchor sweeps plus
 * required interaction corners — never an implicit Cartesian product. For
 * reference-host profiles (`host.class` arm-neon / x86-avx2) every axis
 * endpoint (corpus scale 1K-1M, dims 128-1024, candidate K 5-100, filter
 * selectivity 0.1%-100%, concurrency 1-8) plus the 100K/384 audit cell and
 * the 1M/1024/concurrency-8 corner must be present, or the profile rejects
 * at parse time. The CI host class runs the deterministic SMALL profile:
 * it still must cover both modes, all-cold and all-warm cache states, and
 * all-lane plus single-lane cases, but it is exempt from the heavy
 * scale/dims/K/selectivity/concurrency endpoints — seeding 1M-scale
 * fixtures inside a CI-sized deterministic check is infeasible by design,
 * and CI latency is informational only. A resource preflight prices each
 * case before any allocation so an undersized host fails first.
 */

import { readFileSync } from "node:fs";

import { z } from "zod";
import { canonicalFingerprint } from "./canonical-json";
import { ContractError, SOURCE_FILTERS, SYNTHETIC_SCALES } from "./contract";

export const PROFILE_SCHEMA_VERSION = "retrieval-benchmark-profile/v1";

export const PROFILE_AXIS_ENDPOINTS = {
    scale: { min: 1_000, max: 1_000_000 },
    dims: { min: 128, max: 1_024 },
    candidateK: { min: 5, max: 100 },
    selectivityFraction: { min: 0.001, max: 1 },
    concurrency: { min: 1, max: 8 },
} as const;

/** R59 audit cell: 100K corpus, 384 dims, automatic mode. */
export const AUDIT_CELL = { scale: 100_000, dims: 384 } as const;

/** Discrete rounding rule for declared selectivity cardinalities. */
export const SELECTIVITY_ROUNDING_TOLERANCE = 1;

/** Hard ceiling on enumerated cases per profile (anti-Cartesian guard). */
export const MAX_PROFILE_CASES = 64;

export const CACHE_LAYERS = [
    "processVector",
    "connectionStatement",
    "sqlitePage",
    "osPage",
] as const;
export type CacheLayer = (typeof CACHE_LAYERS)[number];

const cacheStateSchema = z.strictObject({
    processVector: z.enum(["cold", "warm"]),
    connectionStatement: z.enum(["cold", "warm"]),
    sqlitePage: z.enum(["cold", "warm"]),
    osPage: z.enum(["cold", "warm"]),
});
export type CacheState = z.infer<typeof cacheStateSchema>;

const selectivitySchema = z.strictObject({
    fraction: z
        .number()
        .min(PROFILE_AXIS_ENDPOINTS.selectivityFraction.min)
        .max(PROFILE_AXIS_ENDPOINTS.selectivityFraction.max),
    /** Named production predicates that realize the fraction (no support
     *  flag or report-only percentage substitutes for execution). */
    predicate: z.strictObject({
        projectScope: z.string().min(1),
        sessionScope: z.string().min(1).nullable(),
        sources: z.array(z.enum(SOURCE_FILTERS)).nullable(),
        messageOrdinalCutoff: z.number().int().nonnegative().nullable(),
        visibleMemoryIds: z.array(z.number().int().nonnegative()),
    }),
    preFilterDenominator: z.number().int().positive(),
    eligibleCount: z.number().int().nonnegative(),
    expectedScannedCount: z.number().int().nonnegative(),
});
export type SelectivityCell = z.infer<typeof selectivitySchema>;

const caseSchema = z.strictObject({
    id: z.string().regex(/^case-[a-z0-9-]+$/),
    scale: z.union([
        z.literal(SYNTHETIC_SCALES[0]),
        z.literal(SYNTHETIC_SCALES[1]),
        z.literal(SYNTHETIC_SCALES[2]),
        z.literal(SYNTHETIC_SCALES[3]),
    ]),
    dims: z
        .number()
        .int()
        .min(PROFILE_AXIS_ENDPOINTS.dims.min)
        .max(PROFILE_AXIS_ENDPOINTS.dims.max),
    candidateK: z.strictObject({
        requested: z
            .number()
            .int()
            .min(PROFILE_AXIS_ENDPOINTS.candidateK.min)
            .max(PROFILE_AXIS_ENDPOINTS.candidateK.max),
        effective: z
            .number()
            .int()
            .min(PROFILE_AXIS_ENDPOINTS.candidateK.min)
            .max(PROFILE_AXIS_ENDPOINTS.candidateK.max),
    }),
    mode: z.enum(["explicit", "automatic"]),
    /** null = all enabled source lanes. */
    sourceLanes: z.array(z.enum(SOURCE_FILTERS)).nullable(),
    concurrency: z
        .number()
        .int()
        .min(PROFILE_AXIS_ENDPOINTS.concurrency.min)
        .max(PROFILE_AXIS_ENDPOINTS.concurrency.max),
    cacheState: cacheStateSchema,
    selectivity: selectivitySchema,
});
export type ProfileCase = z.infer<typeof caseSchema>;

const profileSchema = z.strictObject({
    schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
    id: z.string().regex(/^profile-[a-z0-9-]+$/),
    description: z.string().min(1),
    expectedCaseCount: z.number().int().positive(),
    runtime: z.strictObject({
        warmups: z.number().int().nonnegative(),
        samples: z.number().int().positive(),
        maxWallTimeMs: z.number().int().positive(),
    }),
    budgets: z.strictObject({
        maxFixtureBytes: z.number().int().positive(),
        maxPeakRssBytes: z.number().int().positive(),
    }),
    host: z.strictObject({
        class: z.enum(["ci", "arm-neon", "x86-avx2"]),
        cpuArchitecture: z.enum(["any", "arm64", "x64"]),
        minTotalMemoryBytes: z.number().int().positive(),
        minAvailableDiskBytes: z.number().int().positive(),
    }),
    cases: z.array(caseSchema).min(1),
});
export type BenchmarkProfile = z.infer<typeof profileSchema>;

function formatIssues(error: z.ZodError): string[] {
    return error.issues.map((issue) => `profile.${issue.path.join(".")}: ${issue.code}`).sort();
}

const GIB = 2 ** 30;
const F32_BYTES = 4;
/** Row/index/FTS overhead multiplier over the raw vector payload. */
const FIXTURE_DISK_OVERHEAD = 2;
/** Per-worker runtime baseline outside the vector payload. */
const WORKER_BASELINE_RSS_BYTES = 64 * 1024 * 1024;

export interface CaseResourceEstimate {
    caseId: string;
    /** Raw f32 vector payload: scale x dims x 4 bytes. */
    vectorPayloadBytes: number;
    /** Vector payload multiplied across closed-loop workers. */
    workerPayloadBytes: number;
    peakRssBytes: number;
    fixtureDiskBytes: number;
    /** `VACUUM INTO` needs a full second copy while both files exist. */
    vacuumHeadroomBytes: number;
    requiredDiskBytes: number;
}

export function estimateCaseResources(profileCase: ProfileCase): CaseResourceEstimate {
    const vectorPayloadBytes = profileCase.scale * profileCase.dims * F32_BYTES;
    const workerPayloadBytes = vectorPayloadBytes * profileCase.concurrency;
    const fixtureDiskBytes = vectorPayloadBytes * FIXTURE_DISK_OVERHEAD;
    const vacuumHeadroomBytes = fixtureDiskBytes;
    return {
        caseId: profileCase.id,
        vectorPayloadBytes,
        workerPayloadBytes,
        peakRssBytes:
            workerPayloadBytes + WORKER_BASELINE_RSS_BYTES * profileCase.concurrency,
        fixtureDiskBytes,
        vacuumHeadroomBytes,
        requiredDiskBytes: fixtureDiskBytes + vacuumHeadroomBytes,
    };
}

export interface ProfileResourceEstimate {
    cases: CaseResourceEstimate[];
    maxPeakRssBytes: number;
    maxRequiredDiskBytes: number;
    maxFixtureDiskBytes: number;
}

export function estimateProfileResources(profile: BenchmarkProfile): ProfileResourceEstimate {
    const cases = profile.cases.map(estimateCaseResources);
    return {
        cases,
        maxPeakRssBytes: Math.max(...cases.map((estimate) => estimate.peakRssBytes)),
        maxRequiredDiskBytes: Math.max(...cases.map((estimate) => estimate.requiredDiskBytes)),
        maxFixtureDiskBytes: Math.max(...cases.map((estimate) => estimate.fixtureDiskBytes)),
    };
}

export interface HostResources {
    totalMemoryBytes: number;
    availableDiskBytes: number;
    cpuArchitecture: "arm64" | "x64" | string;
}

export interface PreflightResult {
    ok: boolean;
    diagnostics: string[];
}

/**
 * Price every case against the actual host BEFORE any fixture allocation:
 * an undersized host fails here with the offending case named, instead of
 * exhausting memory or disk hours into a matrix run.
 */
export function checkHostResources(
    profile: BenchmarkProfile,
    host: HostResources,
): PreflightResult {
    const diagnostics: string[] = [];
    if (
        profile.host.cpuArchitecture !== "any" &&
        profile.host.cpuArchitecture !== host.cpuArchitecture
    ) {
        diagnostics.push(
            `preflight: host architecture mismatch (${profile.host.cpuArchitecture})`,
        );
    }
    if (host.totalMemoryBytes < profile.host.minTotalMemoryBytes) {
        diagnostics.push("preflight: host below declared memory requirement");
    }
    if (host.availableDiskBytes < profile.host.minAvailableDiskBytes) {
        diagnostics.push("preflight: host below declared disk requirement");
    }
    for (const estimate of estimateProfileResources(profile).cases) {
        if (estimate.peakRssBytes > host.totalMemoryBytes) {
            diagnostics.push(`preflight: insufficient memory for case (${estimate.caseId})`);
        }
        if (estimate.requiredDiskBytes > host.availableDiskBytes) {
            diagnostics.push(`preflight: insufficient disk for case (${estimate.caseId})`);
        }
    }
    diagnostics.sort();
    return { ok: diagnostics.length === 0, diagnostics };
}

export function verifySelectivityObservation(
    cell: SelectivityCell,
    observed: { preFilterDenominator: number; eligibleCount: number },
): PreflightResult {
    const diagnostics: string[] = [];
    if (observed.preFilterDenominator !== cell.preFilterDenominator) {
        diagnostics.push("selectivity: observed denominator mismatch");
    }
    if (Math.abs(observed.eligibleCount - cell.eligibleCount) > SELECTIVITY_ROUNDING_TOLERANCE) {
        diagnostics.push("selectivity: observed eligible count outside rounding tolerance");
    }
    return { ok: diagnostics.length === 0, diagnostics };
}

function validateSelectivity(index: number, cell: SelectivityCell, diagnostics: string[]): void {
    const path = `profile.cases[${index}].selectivity`;
    const expectedEligible = cell.fraction * cell.preFilterDenominator;
    if (Math.abs(cell.eligibleCount - expectedEligible) > SELECTIVITY_ROUNDING_TOLERANCE) {
        diagnostics.push(`${path}.eligibleCount: outside-rounding-rule`);
    }
    if (cell.eligibleCount > cell.preFilterDenominator) {
        diagnostics.push(`${path}.eligibleCount: exceeds-denominator`);
    }
    if (
        cell.expectedScannedCount < cell.eligibleCount ||
        cell.expectedScannedCount > cell.preFilterDenominator
    ) {
        diagnostics.push(`${path}.expectedScannedCount: outside-eligible-denominator-range`);
    }
    const cutoff = cell.predicate.messageOrdinalCutoff;
    if (cutoff === null) {
        if (cell.eligibleCount !== cell.preFilterDenominator) {
            diagnostics.push(`${path}.predicate.messageOrdinalCutoff: missing-narrowing`);
        }
    } else if (cell.eligibleCount !== Math.min(cutoff, cell.preFilterDenominator)) {
        diagnostics.push(`${path}.predicate.messageOrdinalCutoff: cutoff-eligible-mismatch`);
    }
}

export function parseProfile(value: unknown): BenchmarkProfile {
    const parsed = profileSchema.safeParse(value);
    if (!parsed.success) throw new ContractError(formatIssues(parsed.error));
    const profile = parsed.data;
    const diagnostics: string[] = [];

    if (profile.expectedCaseCount !== profile.cases.length) {
        diagnostics.push("profile.expectedCaseCount: mismatch");
    }
    if (profile.cases.length > MAX_PROFILE_CASES) {
        diagnostics.push("profile.cases: exceeds-case-ceiling");
    }

    const ids = new Set<string>();
    const scales = new Set<number>();
    const dims = new Set<number>();
    const ks = new Set<number>();
    const fractions = new Set<number>();
    const concurrencies = new Set<number>();
    const modes = new Set<string>();
    let hasAllCold = false;
    let hasAllWarm = false;
    let hasAllLanes = false;
    let hasSingleLane = false;
    let hasAuditCell = false;
    let hasScaleDimsConcurrencyCorner = false;

    for (const [index, profileCase] of profile.cases.entries()) {
        if (ids.has(profileCase.id)) {
            diagnostics.push(`profile.cases[${index}].id: duplicate`);
        }
        ids.add(profileCase.id);
        if (profileCase.candidateK.requested !== profileCase.candidateK.effective) {
            diagnostics.push(`profile.cases[${index}].candidateK: requested-effective-mismatch`);
        }
        scales.add(profileCase.scale);
        dims.add(profileCase.dims);
        ks.add(profileCase.candidateK.requested);
        fractions.add(profileCase.selectivity.fraction);
        concurrencies.add(profileCase.concurrency);
        modes.add(profileCase.mode);
        const states = CACHE_LAYERS.map((layer) => profileCase.cacheState[layer]);
        if (states.every((state) => state === "cold")) hasAllCold = true;
        if (states.every((state) => state === "warm")) hasAllWarm = true;
        if (profileCase.sourceLanes === null) hasAllLanes = true;
        if (profileCase.sourceLanes !== null && profileCase.sourceLanes.length === 1) {
            hasSingleLane = true;
        }
        if (
            profileCase.scale === AUDIT_CELL.scale &&
            profileCase.dims === AUDIT_CELL.dims &&
            profileCase.mode === "automatic"
        ) {
            hasAuditCell = true;
        }
        if (
            profileCase.scale === PROFILE_AXIS_ENDPOINTS.scale.max &&
            profileCase.dims === PROFILE_AXIS_ENDPOINTS.dims.max &&
            profileCase.concurrency === PROFILE_AXIS_ENDPOINTS.concurrency.max
        ) {
            hasScaleDimsConcurrencyCorner = true;
        }
        validateSelectivity(index, profileCase.selectivity, diagnostics);
    }

    // Full axis-endpoint coverage is a reference-host obligation; CI host
    // profiles require only mode, cache-state, and lane coverage.
    const requiresFullAxisCoverage = profile.host.class !== "ci";
    const endpointChecks: Array<[boolean, string]> = requiresFullAxisCoverage
        ? [
        [scales.has(PROFILE_AXIS_ENDPOINTS.scale.min), "profile.cases: missing scale endpoint 1000"],
        [
            scales.has(PROFILE_AXIS_ENDPOINTS.scale.max),
            "profile.cases: missing scale endpoint 1000000",
        ],
        [dims.has(PROFILE_AXIS_ENDPOINTS.dims.min), "profile.cases: missing dims endpoint 128"],
        [dims.has(PROFILE_AXIS_ENDPOINTS.dims.max), "profile.cases: missing dims endpoint 1024"],
        [ks.has(PROFILE_AXIS_ENDPOINTS.candidateK.min), "profile.cases: missing candidate K 5"],
        [ks.has(PROFILE_AXIS_ENDPOINTS.candidateK.max), "profile.cases: missing candidate K 100"],
        [
            fractions.has(PROFILE_AXIS_ENDPOINTS.selectivityFraction.min),
            "profile.cases: missing selectivity endpoint 0.001",
        ],
        [
            fractions.has(PROFILE_AXIS_ENDPOINTS.selectivityFraction.max),
            "profile.cases: missing selectivity endpoint 1",
        ],
        [
            concurrencies.has(PROFILE_AXIS_ENDPOINTS.concurrency.min),
            "profile.cases: missing concurrency endpoint 1",
        ],
        [
            concurrencies.has(PROFILE_AXIS_ENDPOINTS.concurrency.max),
            "profile.cases: missing concurrency endpoint 8",
        ],
        [hasAuditCell, "profile.cases: missing 100K/384 audit cell"],
        [hasScaleDimsConcurrencyCorner, "profile.cases: missing 1M/1024/concurrency-8 corner"],
          ]
        : [];
    endpointChecks.push(
        [modes.has("explicit"), "profile.cases: missing explicit mode"],
        [modes.has("automatic"), "profile.cases: missing automatic mode"],
        [hasAllCold, "profile.cases: missing all-cold cache case"],
        [hasAllWarm, "profile.cases: missing all-warm cache case"],
        [hasAllLanes, "profile.cases: missing all-lane case"],
        [hasSingleLane, "profile.cases: missing single-lane case"],
    );
    for (const [present, diagnostic] of endpointChecks) {
        if (!present) diagnostics.push(diagnostic);
    }

    // Anti-Cartesian guard: the enumerated case count must stay strictly
    // below the axis-value product, otherwise the profile has silently
    // re-derived the full grid it was supposed to sample from.
    const axisProduct =
        scales.size * dims.size * ks.size * fractions.size * concurrencies.size * modes.size;
    if (profile.cases.length >= axisProduct) {
        diagnostics.push("profile.cases: accidental-cartesian-product");
    }

    const estimate = estimateProfileResources(profile);
    if (estimate.maxFixtureDiskBytes > profile.budgets.maxFixtureBytes) {
        diagnostics.push("profile.budgets.maxFixtureBytes: below-estimated-fixture");
    }
    if (estimate.maxPeakRssBytes > profile.budgets.maxPeakRssBytes) {
        diagnostics.push("profile.budgets.maxPeakRssBytes: below-estimated-rss");
    }
    if (estimate.maxPeakRssBytes > profile.host.minTotalMemoryBytes) {
        diagnostics.push("profile.host.minTotalMemoryBytes: below-estimated-rss");
    }
    if (estimate.maxRequiredDiskBytes > profile.host.minAvailableDiskBytes) {
        diagnostics.push("profile.host.minAvailableDiskBytes: below-estimated-disk");
    }

    if (diagnostics.length > 0) throw new ContractError(diagnostics.sort());
    return profile;
}

/** Same promoter-serialization byte rule the release loader enforces. */
export function loadProfileFile(path: string): BenchmarkProfile {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        throw new ContractError(["profile: unreadable"]);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new ContractError(["profile: invalid-json"]);
    }
    if (`${JSON.stringify(parsed, null, 2)}\n` !== text) {
        throw new ContractError(["profile: non-canonical-bytes"]);
    }
    return parseProfile(parsed);
}

export function profileFingerprint(profile: BenchmarkProfile): string {
    return canonicalFingerprint(profile);
}

export const THIRTY_GIB = 30 * GIB;
