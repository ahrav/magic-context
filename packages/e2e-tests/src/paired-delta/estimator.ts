import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import {
    completeFamilyCount,
    pairedFactsFingerprint,
    type Direction,
    type EstimatorOutcome,
    type FamilyEstimatorAdapter,
} from "../prospective-holdout/report";
import type { RunHealth } from "./contract";

export const MIN_BOOTSTRAP_RESAMPLES = 2000;
export const PRIMARY_ENDPOINTS = ["mc-on-vs-mc-off", "mc-on-vs-compaction"] as const;
export const REGRET_ENDPOINTS = ["retrieval", "formation", "representation"] as const;
export type PrimaryEndpoint = (typeof PRIMARY_ENDPOINTS)[number];
export type RegretEndpoint = (typeof REGRET_ENDPOINTS)[number];
export type DeltaEndpoint = PrimaryEndpoint | RegretEndpoint;

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

export interface FamilyDeltaAnalysis {
    bootstrapSeed: number;
    bootstrapResamples: number;
    minimumAnalyzableFamilyCount: number;
    analyzableFamilyCount: number;
    evidenceSufficient: boolean;
    endpoints: EndpointEstimate[];
    liveRegret: EndpointEstimate[];
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
    const families = [...byFamily].sort(([left], [right]) => left.localeCompare(right))
        .map(([familyId, values]): FamilyEstimate => {
            const pointEstimate = mean(values);
            const interval = bootstrapInterval(
                values,
                bootstrapResamples,
                bootstrapSeed ^ stringSeed(`${endpoint}:${familyId}`),
            );
            const floor = noiseFloors.get(familyId) ?? null;
            // A single observation resamples to itself, so its interval has
            // zero width and excludes zero whenever the estimate is nonzero;
            // n = 1 can never count as resolved evidence.
            const resolvable = enoughFamilies && values.length >= 2;
            return {
                familyId,
                pointEstimate,
                interval,
                resolution: resolvable && !includesZero(interval) ? "resolved" : "unresolved",
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
        resolution:
            enoughFamilies && familyMeans.length >= 2 && !includesZero(interval)
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
    noiseFloors?: readonly FamilyNoiseFloor[];
}): FamilyDeltaAnalysis {
    if (
        !Number.isSafeInteger(input.minimumAnalyzableFamilyCount) ||
        input.minimumAnalyzableFamilyCount < 1
    ) {
        throw new PairedDeltaEstimatorError("minimum-analyzable-family-count-invalid");
    }
    if (!Number.isSafeInteger(input.bootstrapSeed)) {
        throw new PairedDeltaEstimatorError("bootstrap-seed-invalid");
    }
    if (
        !Number.isSafeInteger(input.bootstrapResamples) ||
        input.bootstrapResamples < MIN_BOOTSTRAP_RESAMPLES
    ) {
        throw new PairedDeltaEstimatorError("bootstrap-resamples-too-small");
    }
    if (input.observations.length === 0) {
        throw new PairedDeltaEstimatorError("observations-empty");
    }

    const coordinateKeys = new Set<string>();
    for (const observation of input.observations) {
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
    }

    const noiseFloors = new Map<string, FamilyNoiseFloor>();
    for (const floor of input.noiseFloors ?? []) {
        if (
            noiseFloors.has(floor.familyId) ||
            !Number.isFinite(floor.value) ||
            floor.value < 0 ||
            !Number.isFinite(floor.interval.lower) ||
            !Number.isFinite(floor.interval.upper) ||
            floor.interval.lower < 0 ||
            floor.interval.lower > floor.value ||
            floor.value > floor.interval.upper
        ) {
            throw new PairedDeltaEstimatorError(`noise-floor-invalid-${floor.familyId}`);
        }
        noiseFloors.set(floor.familyId, floor);
    }

    const sorted = [...input.observations].sort((left, right) =>
        `${left.endpoint}:${left.familyId}:${left.coordinateId}`.localeCompare(
            `${right.endpoint}:${right.familyId}:${right.coordinateId}`,
        ));
    const estimates = [...new Set(sorted.map(({ endpoint }) => endpoint))]
        .sort((left, right) => left.localeCompare(right))
        .map((endpoint) => estimateEndpoint(
            endpoint,
            sorted.filter((observation) => observation.endpoint === endpoint),
            noiseFloors,
            input.minimumAnalyzableFamilyCount,
            input.bootstrapResamples,
            input.bootstrapSeed,
        ));
    const endpoints = estimates.filter(({ endpoint }) =>
        PRIMARY_ENDPOINTS.includes(endpoint as PrimaryEndpoint));
    const analyzableFamilyCount = endpoints.length === 0
        ? 0
        : Math.min(...endpoints.map(({ familyCount }) => familyCount));
    return {
        bootstrapSeed: input.bootstrapSeed,
        bootstrapResamples: input.bootstrapResamples,
        minimumAnalyzableFamilyCount: input.minimumAnalyzableFamilyCount,
        analyzableFamilyCount,
        evidenceSufficient: analyzableFamilyCount >= input.minimumAnalyzableFamilyCount,
        endpoints,
        liveRegret: estimates.filter(({ endpoint }) =>
            endpoint === "formation" || endpoint === "representation"),
        providerMixedRegret: estimates.filter(({ endpoint }) => endpoint === "retrieval"),
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

function endpointDirection({ resolution, interval }: EndpointEstimate): Direction {
    if (resolution !== "resolved") return "no-change";
    if (interval.lower > 0) return "improvement";
    if (interval.upper < 0) return "regression";
    return "no-change";
}

/**
 * The primary contrasts compare MC-on against different baselines, so
 * conflicting non-neutral endpoint directions are a legitimate outcome and
 * produce an inconclusive projection rather than an error.
 */
function projectedDirection(analysis: FamilyDeltaAnalysis): Direction {
    const directions = new Set(
        analysis.endpoints
            .map(endpointDirection)
            .filter((direction) => direction !== "no-change"),
    );
    if (directions.size !== 1) return "no-change";
    return [...directions][0]!;
}

export function createFamilyEstimatorAdapter(input: {
    poolManifestFingerprint: string;
    pinnedSnapshotId: string;
    policyFingerprint: string;
    expectedPairedFactsFingerprint: string;
    analysis: FamilyDeltaAnalysis & {
        poolManifestFingerprint: string;
        pinnedSnapshotId: string;
        policyFingerprint: string;
    };
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
            if (pairedFactsFingerprint(pairs) !== input.expectedPairedFactsFingerprint) {
                throw new PairedDeltaEstimatorError("adapter: paired-facts-fingerprint-mismatch");
            }
            const evidenceSufficient =
                input.analysis.analyzableFamilyCount >=
                input.analysis.minimumAnalyzableFamilyCount;
            const result = {
                direction: projectedDirection(input.analysis),
                evidenceSufficient,
                completeFamilyCount: completeFamilyCount(pairs),
                resultFingerprint: canonicalFingerprint({
                    poolManifestFingerprint: input.poolManifestFingerprint,
                    pinnedSnapshotId: input.pinnedSnapshotId,
                    policyFingerprint: input.policyFingerprint,
                    pairedFactsFingerprint: input.expectedPairedFactsFingerprint,
                    analysis: input.analysis,
                }),
            };
            return result;
        },
    };
}
