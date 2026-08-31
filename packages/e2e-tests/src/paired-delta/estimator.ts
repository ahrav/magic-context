import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import { compareCodeUnits } from "../code-unit-order";
import {
    completeFamilyCount,
    pairedFactsFingerprint,
    type Direction,
    type EstimatorOutcome,
    type FamilyEstimatorAdapter,
} from "../prospective-holdout/report";
import type { RunHealth } from "./contract";

export const MIN_BOOTSTRAP_RESAMPLES = 2000;
// `splitmix32` consumes a 32-bit state, so wider seeds would silently alias.
export const MAX_BOOTSTRAP_SEED = 0xFFFFFFFF;
export const PRIMARY_ENDPOINTS = ["mc-on-vs-mc-off", "mc-on-vs-compaction"] as const;
// The intervention arm behind the retrieval rung is mock-served, so its estimate is provider-mixed rather than live.
export const PROVIDER_MIXED_REGRET_ENDPOINTS = ["retrieval"] as const;
export const LIVE_REGRET_ENDPOINTS = ["formation", "representation"] as const;
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

function mean(values: readonly number[]): number {
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

function stringSeed(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    }
    return hash >>> 0;
}

function includesZero(interval: Interval): boolean {
    return interval.lower <= 0 && interval.upper >= 0;
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
    const families = [...byFamily].sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([familyId, values]): FamilyEstimate => {
            const pointEstimate = mean(values);
            const interval = bootstrapInterval(
                values,
                bootstrapResamples,
                bootstrapSeed ^ stringSeed(`${endpoint}:${familyId}`),
            );
            const floor = noiseFloors.get(familyId) ?? null;
            return {
                familyId,
                pointEstimate,
                interval,
                // A nonzero singleton yields a zero-width interval without variance evidence; keep it unresolved.
                resolution: enoughFamilies && values.length >= 2 && !includesZero(interval)
                    ? "resolved"
                    : "unresolved",
                noise: {
                    label: floor === null
                        ? "no-noise-floor"
                        : Math.abs(pointEstimate) <= floor.value ? "inside-floor" : "outside-floor",
                    floor,
                },
            };
        });
    const familyMeans = families.map(({ pointEstimate }) => pointEstimate);
    const interval = bootstrapInterval(
        familyMeans,
        bootstrapResamples,
        bootstrapSeed ^ stringSeed(endpoint),
    );
    return {
        endpoint,
        pointEstimate: mean(familyMeans),
        interval,
        familyCount: families.length,
        resolution: enoughFamilies && familyMeans.length >= 2 && !includesZero(interval)
            ? "resolved"
            : "unresolved",
        families,
    };
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
    if (
        !Number.isSafeInteger(input.bootstrapResamples) ||
        input.bootstrapResamples < MIN_BOOTSTRAP_RESAMPLES
    ) {
        throw new PairedDeltaEstimatorError("bootstrap-resamples-too-small");
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
        if (!Number.isFinite(observation.delta)) {
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
            noiseFloors.has(floor.familyId) ||
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
        noiseFloors.set(floor.familyId, floor);
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
