import { canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { compareCodeUnits } from "../code-unit-order";
import { makeContractPrimitives, vocabulary } from "../contract-primitives";
import type { SystemVersionTuple } from "../historian-eval/runner";
import { FAIL_REASONS, SCENARIO_VERDICTS, parseScenarioScore, type ScenarioScore } from "../historian-eval/scorer";
import { parseSystemVersionTuple, requireScoreSystemBinding } from "../historian-eval/system-tuple";
import { falseAuthoritativeMatchSet, introducedFailReasons, invariantHolds, type InvariantEvidence, type InvariantVerdict } from "./invariants";
import { MAX_TRANSFORM_SEED } from "./transforms";

export const METAMORPHIC_REPORT_SCHEMA = "metamorphic-eval-report/v2";

/** Pair key of the live stability pair, whose two roles are both runs of the base scenario. */
export const CONTROL_TRANSFORM_ID = "baseline-control";
export const CONTROL_TRANSFORM_VERSION = 1;
export const CONTROL_SEED = 0;

/**
 * Rejects run options the report contract cannot represent before any entry is built.
 *
 * The parser classifies an entry by the control id alone, so no product transform may claim it, and a pair key
 * carries its seed as a bounded integer, so a seed the transform would refuse must not reach an error entry.
 */
export function requireRepresentableRunOptions(transforms: readonly { id: string }[], seeds: readonly number[]): void {
    if (transforms.some(({ id }) => id === CONTROL_TRANSFORM_ID)) {
        throw new Error(`metamorphic-eval: transform id "${CONTROL_TRANSFORM_ID}" is reserved for the control pair`);
    }
    for (const seed of seeds) {
        if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_TRANSFORM_SEED) {
            throw new Error(`metamorphic-eval: seed ${String(seed)} is outside the unsigned 32-bit range`);
        }
    }
}

export interface PairKey {
    scenarioId: string;
    transformId: string;
    transformVersion: number;
    seed: number;
}

export interface ExpectationPredicateEqualityVerdict {
    invariant: "expectation-predicate-equality";
    holds: boolean;
    changedExpectationIds: string[];
}

export interface FalseAuthoritativeSetEqualityVerdict {
    invariant: "false-authoritative-set-equality";
    holds: boolean;
    baselineMatches: string[];
    derivativeMatches: string[];
}

export interface ScenarioVerdictEqualityVerdict {
    invariant: "scenario-verdict-equality";
    holds: boolean;
    baselineVerdict: ScenarioScore["verdict"];
    derivativeVerdict: ScenarioScore["verdict"];
}

export type MetamorphicInvariantVerdict =
    | InvariantVerdict
    | ExpectationPredicateEqualityVerdict
    | FalseAuthoritativeSetEqualityVerdict
    | ScenarioVerdictEqualityVerdict;

export type MetamorphicReportEntry =
    | (PairKey & { kind: "lint-red"; diagnostics: string[] })
    | (PairKey & {
          kind: "stage-not-scored";
          role: "baseline" | "derivative";
          stage: "validation-rejected" | "authored-evidence-unprocessed";
          error: string;
      })
    | (PairKey & {
          kind: "scored";
          baselineScore: ScenarioScore;
          derivativeScore: ScenarioScore;
          invariants: MetamorphicInvariantVerdict[];
      })
    | (PairKey & { kind: "error"; error: string });

export interface InapplicableTransformEntry extends PairKey {
    reason: string;
}

export interface ScenarioCoverage {
    scenarioId: string;
    applied: number;
    inapplicable: InapplicableTransformEntry[];
    violations: string[];
}

export interface InjectionCanaryHit {
    scenarioId: string;
    role: "baseline" | "derivative" | "control-a" | "control-b";
    transformId: string | null;
    transformVersion: number | null;
    seed: number | null;
}

export interface MetamorphicReport {
    schema: typeof METAMORPHIC_REPORT_SCHEMA;
    /** Resolved pre-run, because a partial report can hold no scored entry to carry it; null for the deterministic runner. */
    system: SystemVersionTuple | null;
    entries: MetamorphicReportEntry[];
    coverage: ScenarioCoverage[];
    injectionCanaryHits: InjectionCanaryHit[];
    tierInvalidReason: TierInvalidReason | null;
}

export type TierInvalidReason =
    | { kind: "incomplete" }
    | {
          kind: "control-disagreement";
          systemMismatch: boolean;
          failedInvariants: MetamorphicInvariantVerdict["invariant"][];
      }
    | {
          /** Two ERROR controls satisfy every equality invariant trivially, so agreement proves nothing here. */
          kind: "control-error";
          controlAErrorReason: string | null;
          controlBErrorReason: string | null;
      }
    | { kind: "selection-empty"; reason: string }
    | { kind: "deadline-exhausted"; nextRole: "control-a" | "control-b" | "baseline" | "derivative" };

/** Rejects an array the builder would have emitted in another order, which its own sort makes unreachable. */
function requireSorted<T>(values: readonly T[], rank: (value: T) => string, label: string): void {
    for (let index = 1; index < values.length; index += 1) {
        if (compareCodeUnits(rank(values[index - 1]!), rank(values[index]!)) > 0) p.fail(`${label}: order-invalid`);
    }
}

/** A field-order-independent rank, so the builder's sort and the parser's check cannot disagree. */
function canaryKey(hit: InjectionCanaryHit): string {
    return canonicalJson([hit.scenarioId, hit.role, hit.transformId, hit.transformVersion, hit.seed]);
}

// Canonical JSON escapes rather than concatenates, so an id containing a separator cannot collide.
function key(entry: PairKey): string {
    return canonicalJson([entry.scenarioId, entry.transformId, entry.transformVersion, entry.seed]);
}

export function buildMetamorphicReport(args: {
    entries: MetamorphicReportEntry[];
    coverage: ScenarioCoverage[];
    injectionCanaryHits: InjectionCanaryHit[];
    tierInvalidReason?: TierInvalidReason | null;
    system?: SystemVersionTuple | null;
}): MetamorphicReport {
    return {
        schema: METAMORPHIC_REPORT_SCHEMA,
        system: args.system ?? null,
        entries: [...args.entries].sort((left, right) => compareCodeUnits(key(left), key(right))),
        coverage: [...args.coverage].sort((left, right) => compareCodeUnits(left.scenarioId, right.scenarioId)),
        injectionCanaryHits: [...args.injectionCanaryHits].sort((left, right) =>
            compareCodeUnits(canaryKey(left), canaryKey(right)),
        ),
        tierInvalidReason: args.tierInvalidReason ?? null,
    };
}

export class MetamorphicReportError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: readonly string[]) {
        super(diagnostics.join("; "));
        this.name = "MetamorphicReportError";
        this.diagnostics = diagnostics;
    }
}

const p = makeContractPrimitives(MetamorphicReportError);

const INVARIANT_IDS = vocabulary<MetamorphicInvariantVerdict["invariant"]>({
    "injection-set-equality": true,
    "expected-absent-empty": true,
    "verdict-monotonicity": true,
    "expectation-predicate-equality": true,
    "false-authoritative-set-equality": true,
    "scenario-verdict-equality": true,
});
const ENTRY_KINDS = vocabulary<MetamorphicReportEntry["kind"]>({
    "lint-red": true,
    "stage-not-scored": true,
    scored: true,
    error: true,
});
const TIER_INVALID_KINDS = vocabulary<TierInvalidReason["kind"]>({
    incomplete: true,
    "control-disagreement": true,
    "control-error": true,
    "selection-empty": true,
    "deadline-exhausted": true,
});
const ROLES = vocabulary<InjectionCanaryHit["role"]>({ baseline: true, derivative: true, "control-a": true, "control-b": true });
/** The invariants `compareLivePair` emits, which is the only source a control disagreement can name. */
type ControlInvariantId =
    | "injection-set-equality"
    | "expectation-predicate-equality"
    | "false-authoritative-set-equality"
    | "scenario-verdict-equality";
/** The invariants each producer emits per scored pair; the raw-output path runs both comparators, the live path its own. */
const INVARIANTS_BY_SOURCE: Readonly<Record<ScenarioScore["source"], readonly MetamorphicInvariantVerdict["invariant"][]>> = {
    "raw-output": [
        "injection-set-equality", "expected-absent-empty", "verdict-monotonicity",
        "expectation-predicate-equality", "false-authoritative-set-equality", "scenario-verdict-equality",
    ],
    "run-record": [
        "injection-set-equality", "expectation-predicate-equality", "false-authoritative-set-equality", "scenario-verdict-equality",
    ],
};
const CONTROL_INVARIANT_IDS = vocabulary<ControlInvariantId>({
    "injection-set-equality": true,
    "expectation-predicate-equality": true,
    "false-authoritative-set-equality": true,
    "scenario-verdict-equality": true,
});
const SCORED_ROLES = vocabulary<Extract<MetamorphicReportEntry, { kind: "stage-not-scored" }>["role"]>({ baseline: true, derivative: true });
const UNSCORED_STAGES = vocabulary<Extract<MetamorphicReportEntry, { kind: "stage-not-scored" }>["stage"]>({
    "validation-rejected": true,
    "authored-evidence-unprocessed": true,
});
const CHANGE_DIRECTIONS = vocabulary<Extract<InvariantVerdict, { invariant: "injection-set-equality" }>["changes"][number]["direction"]>({
    "missing-from-derivative": true,
    "added-in-derivative": true,
});

function textArray(value: unknown, label: string): string[] {
    return p.array(value, label).map((entry, index) => p.text(entry, `${label}[${index}]`));
}

function parsePairKey(value: Record<string, unknown>, label: string): PairKey {
    return {
        scenarioId: p.string(value.scenarioId, `${label}.scenarioId`),
        transformId: p.string(value.transformId, `${label}.transformId`),
        transformVersion: p.integer(value.transformVersion, `${label}.transformVersion`),
        seed: p.boundedInteger(value.seed, `${label}.seed`, 0, MAX_TRANSFORM_SEED),
    };
}

const PAIR_KEYS = ["scenarioId", "transformId", "transformVersion", "seed"] as const;

function parseInvariantEvidence(value: Record<string, unknown>, invariant: MetamorphicInvariantVerdict["invariant"], label: string): InvariantEvidence {
    switch (invariant) {
        case "injection-set-equality":
            p.exact(value, ["invariant", "holds", "changes"], label);
            return {
                invariant,
                changes: p.array(value.changes, `${label}.changes`).map((entry, index) => {
                    const changeLabel = `${label}.changes[${index}]`;
                    const change = p.record(entry, changeLabel);
                    p.exact(change, ["direction", "claim"], changeLabel);
                    const claim = p.record(change.claim, `${changeLabel}.claim`);
                    p.exact(claim, ["category", "content"], `${changeLabel}.claim`);
                    return {
                        direction: p.enumeration(change.direction, CHANGE_DIRECTIONS, `${changeLabel}.direction`),
                        claim: { category: p.text(claim.category, `${changeLabel}.claim.category`), content: p.text(claim.content, `${changeLabel}.claim.content`) },
                    };
                }),
            };
        case "expected-absent-empty":
        case "false-authoritative-set-equality":
            p.exact(value, ["invariant", "holds", "baselineMatches", "derivativeMatches"], label);
            return { invariant, baselineMatches: textArray(value.baselineMatches, `${label}.baselineMatches`), derivativeMatches: textArray(value.derivativeMatches, `${label}.derivativeMatches`) };
        case "verdict-monotonicity":
            p.exact(value, ["invariant", "holds", "baselineVerdict", "derivativeVerdict", "introducedFailReasons"], label);
            return {
                invariant,
                baselineVerdict: p.enumeration(value.baselineVerdict, SCENARIO_VERDICTS, `${label}.baselineVerdict`),
                derivativeVerdict: p.enumeration(value.derivativeVerdict, SCENARIO_VERDICTS, `${label}.derivativeVerdict`),
                introducedFailReasons: p.array(value.introducedFailReasons, `${label}.introducedFailReasons`)
                    .map((entry, index) => p.enumeration(entry, FAIL_REASONS, `${label}.introducedFailReasons[${index}]`)),
            };
        case "expectation-predicate-equality":
            p.exact(value, ["invariant", "holds", "changedExpectationIds"], label);
            return { invariant, changedExpectationIds: textArray(value.changedExpectationIds, `${label}.changedExpectationIds`) };
        case "scenario-verdict-equality":
            p.exact(value, ["invariant", "holds", "baselineVerdict", "derivativeVerdict"], label);
            return {
                invariant,
                baselineVerdict: p.enumeration(value.baselineVerdict, SCENARIO_VERDICTS, `${label}.baselineVerdict`),
                derivativeVerdict: p.enumeration(value.derivativeVerdict, SCENARIO_VERDICTS, `${label}.derivativeVerdict`),
            };
    }
}

// `metamorphicExitCode` reads `holds` alone, so a recorded value that disagrees with its evidence is rejected rather than trusted.
/**
 * Rejects evidence that contradicts the pair's own scores.
 *
 * `injection-set-equality` and `expectation-predicate-equality` are omitted: they derive from injected
 * claims and expectation predicates, which the report does not publish.
 */
interface PairScores {
    baselineScore: ScenarioScore;
    derivativeScore: ScenarioScore;
    /** Sorted unique false-authoritative matches per role, shared by the two set-equality invariants. */
    baselineMatches: string[];
    derivativeMatches: string[];
}

function pairScores(baselineScore: ScenarioScore, derivativeScore: ScenarioScore): PairScores {
    return {
        baselineScore,
        derivativeScore,
        baselineMatches: falseAuthoritativeMatchSet(baselineScore),
        derivativeMatches: falseAuthoritativeMatchSet(derivativeScore),
    };
}

function checkScoreDerivedEvidence(
    evidence: InvariantEvidence,
    { baselineScore, derivativeScore, baselineMatches, derivativeMatches }: PairScores,
    label: string,
): void {
    const mismatch = (field: string): never => p.fail(`${label}.${field}: score-evidence-mismatch`);
    switch (evidence.invariant) {
        case "scenario-verdict-equality":
        case "verdict-monotonicity": {
            if (evidence.baselineVerdict !== baselineScore.verdict) mismatch("baselineVerdict");
            if (evidence.derivativeVerdict !== derivativeScore.verdict) mismatch("derivativeVerdict");
            if (evidence.invariant === "verdict-monotonicity") {
                const derived = introducedFailReasons(baselineScore, derivativeScore);
                if (canonicalJson(evidence.introducedFailReasons) !== canonicalJson(derived)) {
                    mismatch("introducedFailReasons");
                }
            }
            return;
        }
        case "expected-absent-empty":
        case "false-authoritative-set-equality": {
            if (canonicalJson(evidence.baselineMatches) !== canonicalJson(baselineMatches)) mismatch("baselineMatches");
            if (canonicalJson(evidence.derivativeMatches) !== canonicalJson(derivativeMatches)) mismatch("derivativeMatches");
            return;
        }
        case "injection-set-equality":
        case "expectation-predicate-equality":
            return;
    }
}

function parseInvariant(
    raw: unknown,
    label: string,
    scores: PairScores,
): MetamorphicInvariantVerdict {
    const value = p.record(raw, label);
    const invariant = p.enumeration(value.invariant, INVARIANT_IDS, `${label}.invariant`);
    const holds = p.boolean(value.holds, `${label}.holds`);
    const evidence = parseInvariantEvidence(value, invariant, label);
    if (invariantHolds(evidence) !== holds) p.fail(`${label}.holds: derived-mismatch`);
    // Editing both sides of one invariant keeps `holds` self-consistent, so the scores are the outside oracle.
    checkScoreDerivedEvidence(evidence, scores, label);
    return { ...evidence, holds } as MetamorphicInvariantVerdict;
}

function parseEntry(raw: unknown, label: string): MetamorphicReportEntry {
    const value = p.record(raw, label);
    const kind = p.enumeration(value.kind, ENTRY_KINDS, `${label}.kind`);
    const pair = parsePairKey(value, label);
    switch (kind) {
        case "lint-red":
            p.exact(value, [...PAIR_KEYS, "kind", "diagnostics"], label);
            return { ...pair, kind, diagnostics: textArray(value.diagnostics, `${label}.diagnostics`) };
        case "stage-not-scored":
            p.exact(value, [...PAIR_KEYS, "kind", "role", "stage", "error"], label);
            return {
                ...pair,
                kind,
                role: p.enumeration(value.role, SCORED_ROLES, `${label}.role`),
                stage: p.enumeration(value.stage, UNSCORED_STAGES, `${label}.stage`),
                error: p.text(value.error, `${label}.error`),
            };
        case "scored": {
            p.exact(value, [...PAIR_KEYS, "kind", "baselineScore", "derivativeScore", "invariants"], label);
            const baselineScore = parseScenarioScore(value.baselineScore, `${label}.baselineScore`);
            const derivativeScore = parseScenarioScore(value.derivativeScore, `${label}.derivativeScore`);
            // Equality rather than the live runner's non-null `sameSystem`: the raw-output path scores both
            // roles with a null tuple, so requiring non-null would reject its reports.
            if (canonicalJson(baselineScore.system) !== canonicalJson(derivativeScore.system)) {
                p.fail(`${label}: pair-system-mismatch`);
            }
            if (baselineScore.source !== derivativeScore.source) {
                p.fail(`${label}: pair-source-mismatch`);
            }
            // Baseline scores must match `pair.scenarioId` to prevent replay under another pair key.
            if (baselineScore.scenarioId !== pair.scenarioId) {
                p.fail(`${label}.baselineScore.scenarioId: pair-scenario-mismatch`);
            }
            // `applyTransform` names the derivative scenario after its pair, so the id is derivable. The
            // control pair scores two runs of the base scenario and keeps that id on both roles.
            const isControlPair = pair.transformId === CONTROL_TRANSFORM_ID;
            if (isControlPair && (pair.transformVersion !== CONTROL_TRANSFORM_VERSION || pair.seed !== CONTROL_SEED)) {
                p.fail(`${label}: control-pair-coordinates-invalid`);
            }
            // The control pair requires a run-record baseline score.
            if (isControlPair && baselineScore.source !== "run-record") {
                p.fail(`${label}: control-pair-source-invalid`);
            }
            const derivativeScenarioId = isControlPair
                ? pair.scenarioId
                : `${pair.scenarioId}-d-${pair.transformId}-v${pair.transformVersion}-s${pair.seed}`;
            if (derivativeScore.scenarioId !== derivativeScenarioId) {
                p.fail(`${label}.derivativeScore.scenarioId: pair-scenario-mismatch`);
            }
            const scores = pairScores(baselineScore, derivativeScore);
            const invariants = p.array(value.invariants, `${label}.invariants`)
                .map((entry, index) => parseInvariant(entry, `${label}.invariants[${index}]`, scores));
            // Each producer emits a fixed invariant set, so a missing row hides a failure rather than omitting evidence.
            const expected = INVARIANTS_BY_SOURCE[baselineScore.source];
            const actual = invariants.map(({ invariant }) => invariant);
            if (canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort())) {
                p.fail(`${label}.invariants: invariant-set-mismatch`);
            }
            return { ...pair, kind, baselineScore, derivativeScore, invariants };
        }
        case "error":
            p.exact(value, [...PAIR_KEYS, "kind", "error"], label);
            return { ...pair, kind, error: p.text(value.error, `${label}.error`) };
    }
}

function parseCoverage(raw: unknown, label: string): ScenarioCoverage[] {
    const coverage = p.array(raw, label).map((entry, index) => {
        const itemLabel = `${label}[${index}]`;
        const value = p.record(entry, itemLabel);
        p.exact(value, ["scenarioId", "applied", "inapplicable", "violations"], itemLabel);
        const scenarioId = p.string(value.scenarioId, `${itemLabel}.scenarioId`);
        return {
            scenarioId,
            applied: p.integer(value.applied, `${itemLabel}.applied`),
            inapplicable: p.array(value.inapplicable, `${itemLabel}.inapplicable`).map((item, innerIndex) => {
                const innerLabel = `${itemLabel}.inapplicable[${innerIndex}]`;
                const inapplicable = p.record(item, innerLabel);
                p.exact(inapplicable, [...PAIR_KEYS, "reason"], innerLabel);
                const pair = parsePairKey(inapplicable, innerLabel);
                // An inapplicable pair is recorded under the scenario it was admitted against.
                if (pair.scenarioId !== scenarioId) p.fail(`${innerLabel}.scenarioId: coverage-scenario-mismatch`);
                return { ...pair, reason: p.text(inapplicable.reason, `${innerLabel}.reason`) };
            }),
            violations: textArray(value.violations, `${itemLabel}.violations`),
        };
    });
    // One coverage row per scenario, and `requireSorted` alone admits an adjacent repeat.
    p.unique(coverage.map(({ scenarioId }) => scenarioId), label);
    requireSorted(coverage, ({ scenarioId }) => scenarioId, label);
    return coverage;
}

function parseInjectionCanaryHits(raw: unknown, label: string): InjectionCanaryHit[] {
    const hits = p.array(raw, label).map((entry, index) => {
        const itemLabel = `${label}[${index}]`;
        const value = p.record(entry, itemLabel);
        p.exact(value, ["scenarioId", "role", "transformId", "transformVersion", "seed"], itemLabel);
        const role = p.enumeration(value.role, ROLES, `${itemLabel}.role`);
        const transformId = value.transformId === null ? null : p.string(value.transformId, `${itemLabel}.transformId`);
        const transformVersion = value.transformVersion === null ? null : p.integer(value.transformVersion, `${itemLabel}.transformVersion`);
        const seed = value.seed === null ? null : p.boundedInteger(value.seed, `${itemLabel}.seed`, 0, MAX_TRANSFORM_SEED);
        // Only the derivative ran a transform, so only it names one. A deterministic baseline hit still
        // carries the seed it was generated from; a control hit names no coordinate at all.
        if (role === "derivative") {
            if (transformId === null || transformVersion === null || seed === null) {
                p.fail(`${itemLabel}: canary-coordinates-required`);
            }
        } else if (transformId !== null || transformVersion !== null) {
            p.fail(`${itemLabel}: canary-coordinates-unexpected`);
        } else if (role !== "baseline" && seed !== null) {
            p.fail(`${itemLabel}: canary-coordinates-unexpected`);
        }
        return { scenarioId: p.string(value.scenarioId, `${itemLabel}.scenarioId`), role, transformId, transformVersion, seed };
        });
    requireSorted(hits, canaryKey, label);
    return hits;
}

function parseTierInvalidReason(raw: unknown, label: string): TierInvalidReason | null {
    if (raw === null) return null;
    const value = p.record(raw, label);
    const kind = p.enumeration(value.kind, TIER_INVALID_KINDS, `${label}.kind`);
    switch (kind) {
        case "incomplete":
            p.exact(value, ["kind"], label);
            return { kind };
        case "control-disagreement": {
            p.exact(value, ["kind", "systemMismatch", "failedInvariants"], label);
            const systemMismatch = p.boolean(value.systemMismatch, `${label}.systemMismatch`);
            const failedInvariants = p.array(value.failedInvariants, `${label}.failedInvariants`)
                .map((entry, index) => p.enumeration(entry, CONTROL_INVARIANT_IDS, `${label}.failedInvariants[${index}]`));
            p.unique(failedInvariants, `${label}.failedInvariants`);
            // This reason is recorded only when the systems differ or an invariant failed, so it always
            // carries the cause of its own rejection.
            if (!systemMismatch && failedInvariants.length === 0) {
                p.fail(`${label}: control-disagreement-cause-required`);
            }
            return { kind, systemMismatch, failedInvariants };
        }
        case "control-error": {
            p.exact(value, ["kind", "controlAErrorReason", "controlBErrorReason"], label);
            const controlAErrorReason = value.controlAErrorReason === null ? null : p.text(value.controlAErrorReason, `${label}.controlAErrorReason`);
            const controlBErrorReason = value.controlBErrorReason === null ? null : p.text(value.controlBErrorReason, `${label}.controlBErrorReason`);
            // This reason is recorded only when a control errored, and an ERROR score carries its reason.
            if (controlAErrorReason === null && controlBErrorReason === null) {
                p.fail(`${label}: control-error-reason-required`);
            }
            return { kind, controlAErrorReason, controlBErrorReason };
        }
        case "selection-empty":
            p.exact(value, ["kind", "reason"], label);
            return { kind, reason: p.text(value.reason, `${label}.reason`) };
        case "deadline-exhausted":
            p.exact(value, ["kind", "nextRole"], label);
            return { kind, nextRole: p.enumeration(value.nextRole, ROLES, `${label}.nextRole`) };
    }
}

/** Strict consumer parser: exact keys over every entry variant and every `tierInvalidReason` variant. */
export function parseMetamorphicReport(raw: unknown): MetamorphicReport {
    const root = p.record(raw, "report");
    p.exact(root, ["schema", "system", "entries", "coverage", "injectionCanaryHits", "tierInvalidReason"], "report");
    if (root.schema !== METAMORPHIC_REPORT_SCHEMA) p.fail("report.schema: version-invalid");
    const report: MetamorphicReport = {
        schema: METAMORPHIC_REPORT_SCHEMA,
        system: parseSystemVersionTuple(p, root.system, "report.system"),
        entries: (() => {
            const entries = p.array(root.entries, "report.entries")
                .map((entry, index) => parseEntry(entry, `report.entries[${index}]`));
            // One pair is observed once, so a repeated key means a duplicated observation.
            p.unique(entries.map(key), "report.entries");
            requireSorted(entries, key, "report.entries");
            return entries;
        })(),
        coverage: parseCoverage(root.coverage, "report.coverage"),
        injectionCanaryHits: parseInjectionCanaryHits(root.injectionCanaryHits, "report.injectionCanaryHits"),
        tierInvalidReason: parseTierInvalidReason(root.tierInvalidReason, "report.tierInvalidReason"),
    };
    // The pair checks prove the two roles agree with each other, not that either ran the system the report
    // names. Where both tuples are stated they have to be the same run.
    // An admitted pair always leaves one non-lint entry, so on a completed run each scenario's applied count
    // is backed by at least that many. The bound is not an equality: a transform that throws during admission
    // also leaves an `error` entry without counting as applied, and the archive does not say which errors
    // were those. A tier-invalid run keeps its scheduled coverage over a partial entry set.
    if (report.tierInvalidReason === null) {
        const backed = new Map<string, number>();
        for (const entry of report.entries) {
            if (entry.kind === "lint-red" || entry.transformId === CONTROL_TRANSFORM_ID) continue;
            backed.set(entry.scenarioId, (backed.get(entry.scenarioId) ?? 0) + 1);
        }
        for (const [index, row] of report.coverage.entries()) {
            if (row.applied > (backed.get(row.scenarioId) ?? 0)) p.fail(`report.coverage[${index}].applied: derived-mismatch`);
            // Both producers record this violation whenever nothing applied.
            if (row.applied === 0 && !row.violations.includes("no transforms applied")) {
                p.fail(`report.coverage[${index}].violations: derived-mismatch`);
            }
        }
    }
    // Both producers write one coverage row per selected scenario, and `metamorphicExitCode` reads violations
    // only from rows that exist, so a scenario with entries but no row would hide its own violations.
    // `admitPair` returns exactly one disposition per coordinate, so an inapplicable key never also has an entry.
    const entryKeys = new Set(report.entries.map(key));
    for (const [index, row] of report.coverage.entries()) {
        for (const [innerIndex, pair] of row.inapplicable.entries()) {
            if (entryKeys.has(key(pair))) p.fail(`report.coverage[${index}].inapplicable[${innerIndex}]: entry-conflict`);
        }
    }
    const covered = new Set(report.coverage.map(({ scenarioId }) => scenarioId));
    for (const [index, entry] of report.entries.entries()) {
        if (entry.transformId === CONTROL_TRANSFORM_ID) continue;
        if (!covered.has(entry.scenarioId)) p.fail(`report.entries[${index}]: coverage-row-required`);
    }
    // Both runners build a scenario's coverage row around its canary collection, so a hit names a covered
    // scenario; the control roles are the exception, since the control scenario has no row.
    for (const [index, hit] of report.injectionCanaryHits.entries()) {
        if (hit.role === "control-a" || hit.role === "control-b") {
            // Only the live runner runs controls, and it publishes the system it ran them on.
            if (report.system === null) p.fail(`report.injectionCanaryHits[${index}]: control-role-requires-live-report`);
            continue;
        }
        if (!covered.has(hit.scenarioId)) p.fail(`report.injectionCanaryHits[${index}]: coverage-row-required`);
    }
    const sources = new Set(report.entries.flatMap((entry) => entry.kind === "scored" ? [entry.baselineScore.source] : []));
    // The live runner completes and validates its control pair before any product pair, so a tier-valid
    // run-record report carries exactly one scored control.
    if (report.tierInvalidReason === null && sources.has("run-record")) {
        const controls = report.entries.filter((entry) => entry.transformId === CONTROL_TRANSFORM_ID);
        if (controls.length !== 1 || controls[0]!.kind !== "scored") p.fail("report.entries: control-pair-required");
    }
    // One producer writes a report, and each producer scores through one seam.
    if (sources.size > 1) p.fail("report.entries: source-mismatch");
    // The raw-output path scores without a system tuple and publishes none at the root; the live entry point
    // resolves its tuple before running and exits without a report when it cannot.
    if (sources.has("raw-output") && report.system !== null) p.fail("report.system: report-system-mismatch");
    if (sources.has("run-record") && report.system === null) p.fail("report.system: report-system-mismatch");
    // The pair checks prove the two roles agree with each other; this binds the pair to its seam and report.
    for (const [index, entry] of report.entries.entries()) {
        if (entry.kind !== "scored") continue;
        requireScoreSystemBinding(p, entry.baselineScore, report.system, `report.entries[${index}]`);
    }
    return report;
}

export function metamorphicExitCode(report: MetamorphicReport): 0 | 1 | 2 {
    if (report.injectionCanaryHits.length > 0) return 2;
    if (report.tierInvalidReason !== null) return 1;
    if (report.entries.length === 0) return 1;
    if (report.coverage.some((coverage) => coverage.violations.length > 0)) return 1;
    for (const entry of report.entries) {
        if (entry.kind !== "scored") return 1;
        if (entry.baselineScore.verdict !== "PASS" || entry.derivativeScore.verdict !== "PASS") return 1;
        if (entry.invariants.some((invariant) => !invariant.holds)) return 1;
    }
    return 0;
}
