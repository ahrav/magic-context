import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import { tupleKey } from "./tuple-key";
import { compareCodeUnits } from "../code-unit-order";
import { fnv1a32 } from "../fnv1a";
import {
    completeFamilyCount,
    pairedFactsFingerprint,
    type Direction,
    type EstimatorOutcome,
    type FamilyEstimatorAdapter,
} from "../prospective-holdout/report";
import type { RunHealth } from "./contract";

export const MIN_BOOTSTRAP_RESAMPLES = 2000;
/** Bounds the work a resample count can demand of a reader that replays the bootstrap; the policy uses 5000. */
export const MAX_BOOTSTRAP_RESAMPLES = 100_000;
/** Bounds observations times resamples, the sampling work one estimate or its replay performs. */
export const MAX_BOOTSTRAP_WORK = 20_000_000;
// `splitmix32` consumes a 32-bit state, so wider seeds would silently alias.
export const MAX_BOOTSTRAP_SEED = 0xFFFFFFFF;
export const PRIMARY_ENDPOINTS = ["mc-on-vs-mc-off", "mc-on-vs-compaction"] as const;
// Both rungs that read R1 are provider-mixed: R1's scripted `ctx_search` turn and its follow-up are mock-served, and `formation` is R2 - R1. Only `representation` compares two wholly live arms.
export const PROVIDER_MIXED_REGRET_ENDPOINTS = ["retrieval", "formation"] as const;
export const LIVE_REGRET_ENDPOINTS = ["representation"] as const;
// Composing the regret set from the two partitions keeps a new rung from landing in neither aggregate bucket.
export const REGRET_ENDPOINTS = [
    ...PROVIDER_MIXED_REGRET_ENDPOINTS,
    ...LIVE_REGRET_ENDPOINTS,
] as const;
export type PrimaryEndpoint = (typeof PRIMARY_ENDPOINTS)[number];
export type RegretEndpoint = (typeof REGRET_ENDPOINTS)[number];
export type DeltaEndpoint = PrimaryEndpoint | RegretEndpoint;

// An estimate for an undeclared endpoint belongs to no output bucket and is omitted from the analysis.
const DECLARED_ENDPOINTS: ReadonlySet<string> = new Set<string>([
    ...PRIMARY_ENDPOINTS,
    ...REGRET_ENDPOINTS,
]);

export class PairedDeltaEstimatorError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PairedDeltaEstimatorError";
    }
}

export interface Interval {
    lower: number;
    upper: number;
}

export interface FamilyDeltaObservation {
    coordinateId: string;
    familyId: string;
    endpoint: DeltaEndpoint;
    delta: number;
    runHealth: RunHealth;
}

export interface FamilyNoiseFloor {
    /** Which delta the floor was measured on. A floor from one primary baseline does not describe the other. */
    endpoint?: PrimaryEndpoint;
    familyId: string;
    value: number;
    interval: Interval;
}

export type DeltaResolution = "resolved" | "unresolved";
export type NoiseComparison = "no-noise-floor" | "inside-floor" | "outside-floor";

export interface FamilyEstimate {
    familyId: string;
    pointEstimate: number;
    interval: Interval;
    resolution: DeltaResolution;
    noise: {
        label: NoiseComparison;
        floor: FamilyNoiseFloor | null;
    };
}

export interface EndpointEstimate {
    endpoint: DeltaEndpoint;
    pointEstimate: number;
    interval: Interval;
    familyCount: number;
    resolution: DeltaResolution;
    families: FamilyEstimate[];
}

export interface RawRegretRecord {
    coordinateId: string;
    familyId: string;
    endpoint: RegretEndpoint;
    delta: number;
    inferential: false;
}

export interface LaneBinding {
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    policyFingerprint: string;
    pairedFactsFingerprint: string;
}

export interface FamilyDeltaAnalysis extends LaneBinding {
    bootstrapSeed: number;
    bootstrapResamples: number;
    minimumAnalyzableFamilyCount: number;
    analyzableFamilyCount: number;
    evidenceSufficient: boolean;
    endpoints: EndpointEstimate[];
    /** Aggregate regret carries the clustered-bootstrap interval and noise-floor comparison of a primary delta; the non-inferential label belongs to the per-coordinate `rawRegretRecords`, not to these estimates. */
    liveRegret: EndpointEstimate[];
    /** The retrieval rung compares a mock-served intervention arm, so its interval is provider-mixed evidence and is kept out of `liveRegret`. */
    providerMixedRegret: EndpointEstimate[];
    rawRegretRecords: RawRegretRecord[];
}

export function mean(values: readonly number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted: readonly number[], probability: number): number {
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;
    return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
}

function bootstrapInterval(
    values: readonly number[],
    resamples: number,
    seed: number,
): Interval {
    const next = splitmix32(seed);
    const samples = Array.from({ length: resamples }, () => {
        let total = 0;
        for (let index = 0; index < values.length; index += 1) {
            total += values[Math.floor(next() * values.length)]!;
        }
        return total / values.length;
    }).sort((left, right) => left - right);
    return {
        lower: percentile(samples, 0.025),
        upper: percentile(samples, 0.975),
    };
}

function floorKey(familyId: string, endpoint: PrimaryEndpoint | undefined): string {
    return tupleKey(familyId, endpoint);
}

export function includesZero(interval: Interval): boolean {
    return interval.lower <= 0 && interval.upper >= 0;
}

/** A delta no larger than its family's calibrated floor is not separable from measured noise. */
export function noiseLabel(pointEstimate: number, floor: FamilyNoiseFloor | null): NoiseComparison {
    if (floor === null) return "no-noise-floor";
    return Math.abs(pointEstimate) <= floor.value ? "inside-floor" : "outside-floor";
}

/**
 * Resolution over the family estimates alone, which is why the consumer can recompute it.
 *
 * An aggregate cannot clear measured noise that one of its own families sits inside, so a single inside-floor
 * family leaves the endpoint unresolved.
 */
export function endpointResolution(
    families: readonly { noise: { label: NoiseComparison } }[],
    interval: Interval,
    minimumAnalyzableFamilyCount: number,
): "resolved" | "unresolved" {
    return families.length >= minimumAnalyzableFamilyCount &&
        families.length >= 2 &&
        !includesZero(interval) &&
        !families.some(({ noise }) => noise.label === "inside-floor")
        ? "resolved"
        : "unresolved";
}

function estimateEndpoint(
    endpoint: DeltaEndpoint,
    observations: readonly FamilyDeltaObservation[],
    noiseFloors: ReadonlyMap<string, FamilyNoiseFloor>,
    minimumAnalyzableFamilyCount: number,
    bootstrapResamples: number,
    bootstrapSeed: number,
): EndpointEstimate {
    const byFamily = new Map<string, number[]>();
    for (const observation of observations) {
        const values = byFamily.get(observation.familyId) ?? [];
        values.push(observation.delta);
        byFamily.set(observation.familyId, values);
    }
    const enoughFamilies = byFamily.size >= minimumAnalyzableFamilyCount;
    /**
     * Calibration samples the primary arms and scores them on the binary valid-success endpoint, so
     * its floors describe those series alone. Applying them to a regret rung compares a fraction over
     * the whole check vector against a threshold measured from a different quantity on arms the
     * calibration never sampled, which can both resolve noisy representation evidence and suppress a
     * stable one.
     */
    const primary = PRIMARY_ENDPOINTS.includes(endpoint as PrimaryEndpoint)
        ? (endpoint as PrimaryEndpoint)
        : null;
    const families = [...byFamily].sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([familyId, values]): FamilyEstimate => {
            const pointEstimate = mean(values);
            const interval = bootstrapInterval(
                values,
                bootstrapResamples,
                bootstrapSeed ^ fnv1a32(`${endpoint}:${familyId}`),
            );
            /** An endpoint-keyed floor first, then one recorded without an endpoint, so a record from either shape resolves. */
            const floor = primary === null
                ? null
                : noiseFloors.get(floorKey(familyId, primary)) ??
                    noiseFloors.get(floorKey(familyId, undefined)) ??
                    null;
            const label = noiseLabel(pointEstimate, floor);
            return {
                familyId,
                pointEstimate,
                interval,
                // A nonzero singleton yields a zero-width interval without variance evidence; keep it unresolved.
                /** A delta no larger than its family's calibrated floor is not separable from measured noise, so the floor decides resolution rather than only annotating it. */
                resolution: enoughFamilies && values.length >= 2 && !includesZero(interval) &&
                    label !== "inside-floor"
                    ? "resolved"
                    : "unresolved",
                noise: { label, floor },
            };
        });
    const familyMeans = families.map(({ pointEstimate }) => pointEstimate);
    const interval = bootstrapInterval(
        familyMeans,
        bootstrapResamples,
        bootstrapSeed ^ fnv1a32(endpoint),
    );
    /** An aggregate cannot clear measured noise that one of its own families sits inside, so a single inside-floor family leaves the endpoint unresolved. */
    return {
        endpoint,
        pointEstimate: mean(familyMeans),
        interval,
        familyCount: families.length,
        resolution: endpointResolution(families, interval, minimumAnalyzableFamilyCount),
        families,
    };
}

/**
 * Recomputes one regret endpoint's estimate from its archived raw records.
 *
 * A regret rung takes no noise floor, and `estimateFamilyDeltas` includes every regret observation, so the
 * archived records, seed, and resample count determine the estimate exactly.
 */
export function estimateRegretEndpoint(
    endpoint: RegretEndpoint,
    records: readonly RawRegretRecord[],
    settings: { minimumAnalyzableFamilyCount: number; bootstrapResamples: number; bootstrapSeed: number },
): EndpointEstimate {
    return estimateEndpoint(
        endpoint,
        records.filter((record) => record.endpoint === endpoint).map((record) => ({
            coordinateId: record.coordinateId,
            familyId: record.familyId,
            endpoint: record.endpoint,
            delta: record.delta,
            runHealth: "completed",
        })),
        new Map(),
        settings.minimumAnalyzableFamilyCount,
        settings.bootstrapResamples,
        settings.bootstrapSeed,
    );
}

export function estimateFamilyDeltas(input: {
    observations: readonly FamilyDeltaObservation[];
    minimumAnalyzableFamilyCount: number;
    bootstrapSeed: number;
    bootstrapResamples: number;
    lane: LaneBinding;
    noiseFloors?: readonly FamilyNoiseFloor[];
}): FamilyDeltaAnalysis {
    if (
        !Number.isSafeInteger(input.minimumAnalyzableFamilyCount) ||
        input.minimumAnalyzableFamilyCount < 1
    ) {
        throw new PairedDeltaEstimatorError("minimum-analyzable-family-count-invalid");
    }
    if (
        !Number.isSafeInteger(input.bootstrapSeed) ||
        input.bootstrapSeed < 0 ||
        input.bootstrapSeed > MAX_BOOTSTRAP_SEED
    ) {
        throw new PairedDeltaEstimatorError("bootstrap-seed-invalid");
    }
    if (!Number.isSafeInteger(input.bootstrapResamples) || input.bootstrapResamples < MIN_BOOTSTRAP_RESAMPLES) {
        throw new PairedDeltaEstimatorError("bootstrap-resamples-too-small");
    }
    if (input.bootstrapResamples > MAX_BOOTSTRAP_RESAMPLES) {
        throw new PairedDeltaEstimatorError("bootstrap-resamples-too-large");
    }
    if (input.observations.length * input.bootstrapResamples > MAX_BOOTSTRAP_WORK) {
        throw new PairedDeltaEstimatorError("bootstrap-work-too-large");
    }
    if (!/^[0-9a-f]{64}$/.test(input.lane.poolManifestFingerprint)) {
        throw new PairedDeltaEstimatorError("lane-pool-manifest-fingerprint-invalid");
    }
    if (!/^[0-9a-f]{64}$/.test(input.lane.policyFingerprint)) {
        throw new PairedDeltaEstimatorError("lane-policy-fingerprint-invalid");
    }
    if (!/^[0-9a-f]{64}$/.test(input.lane.pairedFactsFingerprint)) {
        throw new PairedDeltaEstimatorError("lane-paired-facts-fingerprint-invalid");
    }
    if (input.lane.pinnedSnapshotId.trim().length === 0) {
        throw new PairedDeltaEstimatorError("lane-pinned-snapshot-id-invalid");
    }
    if (input.observations.length === 0) {
        throw new PairedDeltaEstimatorError("observations-empty");
    }

    const coordinateKeys = new Set<string>();
    const familyByCoordinate = new Map<string, string>();
    for (const observation of input.observations) {
        if (!DECLARED_ENDPOINTS.has(observation.endpoint)) {
            throw new PairedDeltaEstimatorError(
                `observation: endpoint-undeclared-${observation.endpoint}`,
            );
        }
        if (observation.runHealth !== "completed") {
            throw new PairedDeltaEstimatorError(
                `observation: unanalyzable-${observation.coordinateId}`,
            );
        }
        // Both identifiers name report rows the parser admits only as non-blank strings.
        if (observation.familyId.trim().length === 0 || observation.coordinateId.trim().length === 0) {
            throw new PairedDeltaEstimatorError(
                `observation: identifier-blank-${observation.coordinateId}`,
            );
        }
        // A delta is a difference of two values in [0, 1], which is also the bound the report parser applies.
        if (!Number.isFinite(observation.delta) || observation.delta < -1 || observation.delta > 1) {
            throw new PairedDeltaEstimatorError(
                `observation: delta-invalid-${observation.coordinateId}`,
            );
        }
        const key = `${observation.endpoint}:${observation.coordinateId}`;
        if (coordinateKeys.has(key)) {
            throw new PairedDeltaEstimatorError(`observation: duplicate-${key}`);
        }
        coordinateKeys.add(key);
        // One coordinate under two families would join two bootstrap clusters, so the family assignment must agree across endpoints.
        const family = familyByCoordinate.get(observation.coordinateId);
        if (family !== undefined && family !== observation.familyId) {
            throw new PairedDeltaEstimatorError(
                `observation: family-conflict-${observation.coordinateId}`,
            );
        }
        familyByCoordinate.set(observation.coordinateId, observation.familyId);
    }

    const noiseFloors = new Map<string, FamilyNoiseFloor>();
    for (const floor of input.noiseFloors ?? []) {
        // A malformed floor must surface as a typed estimator error, not a TypeError from reading `interval`.
        const interval: Interval | null | undefined = floor.interval;
        if (
            noiseFloors.has(floorKey(floor.familyId, floor.endpoint)) ||
            !Number.isFinite(floor.value) ||
            floor.value < 0 ||
            interval === null ||
            interval === undefined ||
            typeof interval !== "object" ||
            !Number.isFinite(interval.lower) ||
            !Number.isFinite(interval.upper) ||
            interval.lower < 0 ||
            interval.lower > floor.value ||
            floor.value > interval.upper
        ) {
            throw new PairedDeltaEstimatorError(`noise-floor-invalid-${floor.familyId}`);
        }
        noiseFloors.set(floorKey(floor.familyId, floor.endpoint), floor);
    }

    const sorted = [...input.observations].sort((left, right) =>
        compareCodeUnits(left.endpoint, right.endpoint) ||
        compareCodeUnits(left.familyId, right.familyId) ||
        compareCodeUnits(left.coordinateId, right.coordinateId));
    const coordinatesByPrimaryEndpoint = PRIMARY_ENDPOINTS.map((endpoint) => new Set(
        sorted.filter((observation) => observation.endpoint === endpoint)
            .map(({ coordinateId }) => coordinateId),
    ));
    // Only coordinates present at every primary endpoint contribute to paired estimates and `analyzableFamilyCount`.
    const pairedCoordinates = new Set([...coordinatesByPrimaryEndpoint[0]!].filter((coordinateId) =>
        coordinatesByPrimaryEndpoint.every((coordinates) => coordinates.has(coordinateId))));
    const analyzable = sorted.filter((observation) =>
        !PRIMARY_ENDPOINTS.includes(observation.endpoint as PrimaryEndpoint) ||
        pairedCoordinates.has(observation.coordinateId));
    const estimates = [...new Set(analyzable.map(({ endpoint }) => endpoint))]
        .sort(compareCodeUnits)
        .map((endpoint) => estimateEndpoint(
            endpoint,
            analyzable.filter((observation) => observation.endpoint === endpoint),
            noiseFloors,
            input.minimumAnalyzableFamilyCount,
            input.bootstrapResamples,
            input.bootstrapSeed,
        ));
    const endpoints = estimates.filter(({ endpoint }) =>
        PRIMARY_ENDPOINTS.includes(endpoint as PrimaryEndpoint));
    const analyzableFamilyCount = new Set(analyzable
        .filter((observation) => PRIMARY_ENDPOINTS.includes(observation.endpoint as PrimaryEndpoint))
        .map(({ familyId }) => familyId)).size;
    return {
        poolManifestFingerprint: input.lane.poolManifestFingerprint,
        pinnedSnapshotId: input.lane.pinnedSnapshotId,
        policyFingerprint: input.lane.policyFingerprint,
        pairedFactsFingerprint: input.lane.pairedFactsFingerprint,
        bootstrapSeed: input.bootstrapSeed,
        bootstrapResamples: input.bootstrapResamples,
        minimumAnalyzableFamilyCount: input.minimumAnalyzableFamilyCount,
        analyzableFamilyCount,
        evidenceSufficient: analyzableFamilyCount >= input.minimumAnalyzableFamilyCount,
        endpoints,
        liveRegret: estimates.filter(({ endpoint }) =>
            LIVE_REGRET_ENDPOINTS.includes(endpoint as (typeof LIVE_REGRET_ENDPOINTS)[number])),
        providerMixedRegret: estimates.filter(({ endpoint }) =>
            PROVIDER_MIXED_REGRET_ENDPOINTS.includes(
                endpoint as (typeof PROVIDER_MIXED_REGRET_ENDPOINTS)[number])),
        rawRegretRecords: sorted.flatMap((observation) =>
            REGRET_ENDPOINTS.includes(observation.endpoint as RegretEndpoint)
                ? [{
                    coordinateId: observation.coordinateId,
                    familyId: observation.familyId,
                    endpoint: observation.endpoint as RegretEndpoint,
                    delta: observation.delta,
                    inferential: false as const,
                }]
                : []),
    };
}

function projectedDirection(analysis: FamilyDeltaAnalysis): Direction {
    // A directional verdict requires the family minimum, so the gate holds for every consumer of `EstimatorOutcome` rather than for callers that recheck it.
    if (!analysis.evidenceSufficient) return "no-change";
    // Opposite-signed resolved endpoints are a heterogeneous outcome, not an
    // impossible state, and project as "no-change".
    const resolved = analysis.endpoints.filter(({ resolution }) => resolution === "resolved");
    if (resolved.length === 0) return "no-change";
    const hasPositive = resolved.some(({ interval }) => interval.lower > 0);
    const hasNegative = resolved.some(({ interval }) => interval.upper < 0);
    if (hasPositive && hasNegative) return "no-change";
    return hasPositive ? "improvement" : "regression";
}

export function createFamilyEstimatorAdapter(input: {
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    policyFingerprint: string;
    analysis: FamilyDeltaAnalysis;
}): FamilyEstimatorAdapter {
    return {
        owner: "magic-context-x4l.14",
        analyze(pairs, policyFingerprint): EstimatorOutcome {
            if (
                input.analysis.poolManifestFingerprint !== input.poolManifestFingerprint ||
                input.analysis.pinnedSnapshotId !== input.pinnedSnapshotId
            ) {
                throw new PairedDeltaEstimatorError("adapter: lane-binding-mismatch");
            }
            if (
                input.analysis.policyFingerprint !== input.policyFingerprint ||
                policyFingerprint !== input.policyFingerprint
            ) {
                throw new PairedDeltaEstimatorError("adapter: policy-fingerprint-mismatch");
            }
            if (pairedFactsFingerprint(pairs) !== input.analysis.pairedFactsFingerprint) {
                throw new PairedDeltaEstimatorError("adapter: paired-facts-fingerprint-mismatch");
            }
            const result = {
                direction: projectedDirection(input.analysis),
                evidenceSufficient: input.analysis.evidenceSufficient,
                completeFamilyCount: completeFamilyCount(pairs),
                resultFingerprint: canonicalFingerprint({
                    poolManifestFingerprint: input.poolManifestFingerprint,
                    pinnedSnapshotId: input.pinnedSnapshotId,
                    policyFingerprint: input.policyFingerprint,
                    pairedFactsFingerprint: input.analysis.pairedFactsFingerprint,
                    analysis: input.analysis,
                }),
            };
            return result;
        },
    };
}
