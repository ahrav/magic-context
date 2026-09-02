import { canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { makeContractPrimitives, vocabulary } from "../contract-primitives";
import type { SystemVersionTuple } from "../historian-eval/runner";
import { FAIL_REASONS, SCENARIO_VERDICTS, parseScenarioScore, type ScenarioScore } from "../historian-eval/scorer";
import { parseSystemVersionTuple } from "../historian-eval/system-tuple";
import { falseAuthoritativeMatchSet, introducedFailReasons, invariantHolds, type InvariantEvidence, type InvariantVerdict } from "./invariants";
import { MAX_TRANSFORM_SEED } from "./transforms";

export const METAMORPHIC_REPORT_SCHEMA = "metamorphic-eval-report/v2";

/** Transform id of the live stability pair, whose two roles are both runs of the base scenario. */
export const CONTROL_TRANSFORM_ID = "baseline-control";

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

function key(entry: PairKey): string {
    return `${entry.scenarioId}\u0000${entry.transformId}\u0000${entry.transformVersion}\u0000${entry.seed}`;
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
        entries: [...args.entries].sort((left, right) => key(left).localeCompare(key(right))),
        coverage: [...args.coverage].sort((left, right) => left.scenarioId.localeCompare(right.scenarioId)),
        injectionCanaryHits: [...args.injectionCanaryHits].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
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
function checkScoreDerivedEvidence(
    evidence: InvariantEvidence,
    baselineScore: ScenarioScore,
    derivativeScore: ScenarioScore,
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
            if (canonicalJson(evidence.baselineMatches) !== canonicalJson(falseAuthoritativeMatchSet(baselineScore))) {
                mismatch("baselineMatches");
            }
            if (canonicalJson(evidence.derivativeMatches) !== canonicalJson(falseAuthoritativeMatchSet(derivativeScore))) {
                mismatch("derivativeMatches");
            }
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
    scores?: { baselineScore: ScenarioScore; derivativeScore: ScenarioScore },
): MetamorphicInvariantVerdict {
    const value = p.record(raw, label);
    const invariant = p.enumeration(value.invariant, INVARIANT_IDS, `${label}.invariant`);
    const holds = p.boolean(value.holds, `${label}.holds`);
    const evidence = parseInvariantEvidence(value, invariant, label);
    if (invariantHolds(evidence) !== holds) p.fail(`${label}.holds: derived-mismatch`);
    // Editing both sides of one invariant keeps `holds` self-consistent, so the scores are the outside oracle.
    if (scores !== undefined) {
        checkScoreDerivedEvidence(evidence, scores.baselineScore, scores.derivativeScore, label);
    }
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
            // The reserved control pair has fixed coordinates: transformVersion 1 and seed 0.
            const isControlPair = pair.transformId === CONTROL_TRANSFORM_ID;
            if (isControlPair && (pair.transformVersion !== 1 || pair.seed !== 0)) {
                p.fail(`${label}: control-pair-coordinates-invalid`);
            }
            const derivativeScenarioId = isControlPair
                ? pair.scenarioId
                : `${pair.scenarioId}-d-${pair.transformId}-v${pair.transformVersion}-s${pair.seed}`;
            if (derivativeScore.scenarioId !== derivativeScenarioId) {
                p.fail(`${label}.derivativeScore.scenarioId: pair-scenario-mismatch`);
            }
            return {
                ...pair,
                kind,
                baselineScore,
                derivativeScore,
                invariants: p.array(value.invariants, `${label}.invariants`)
                    .map((entry, index) => parseInvariant(entry, `${label}.invariants[${index}]`, { baselineScore, derivativeScore })),
            };
        }
        case "error":
            p.exact(value, [...PAIR_KEYS, "kind", "error"], label);
            return { ...pair, kind, error: p.text(value.error, `${label}.error`) };
    }
}

function parseTierInvalidReason(raw: unknown, label: string): TierInvalidReason | null {
    if (raw === null) return null;
    const value = p.record(raw, label);
    const kind = p.enumeration(value.kind, TIER_INVALID_KINDS, `${label}.kind`);
    switch (kind) {
        case "incomplete":
            p.exact(value, ["kind"], label);
            return { kind };
        case "control-disagreement":
            p.exact(value, ["kind", "systemMismatch", "failedInvariants"], label);
            return {
                kind,
                systemMismatch: p.boolean(value.systemMismatch, `${label}.systemMismatch`),
                failedInvariants: p.array(value.failedInvariants, `${label}.failedInvariants`)
                    .map((entry, index) => p.enumeration(entry, INVARIANT_IDS, `${label}.failedInvariants[${index}]`)),
            };
        case "control-error":
            p.exact(value, ["kind", "controlAErrorReason", "controlBErrorReason"], label);
            return {
                kind,
                controlAErrorReason: value.controlAErrorReason === null ? null : p.text(value.controlAErrorReason, `${label}.controlAErrorReason`),
                controlBErrorReason: value.controlBErrorReason === null ? null : p.text(value.controlBErrorReason, `${label}.controlBErrorReason`),
            };
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
    return {
        schema: METAMORPHIC_REPORT_SCHEMA,
        system: parseSystemVersionTuple(p, root.system, "report.system"),
        entries: (() => {
            const entries = p.array(root.entries, "report.entries")
                .map((entry, index) => parseEntry(entry, `report.entries[${index}]`));
            // One pair is observed once, so a repeated key means a duplicated observation.
            p.unique(entries.map(key), "report.entries");
            return entries;
        })(),
        coverage: p.array(root.coverage, "report.coverage").map((entry, index) => {
            const label = `report.coverage[${index}]`;
            const value = p.record(entry, label);
            p.exact(value, ["scenarioId", "applied", "inapplicable", "violations"], label);
            return {
                scenarioId: p.string(value.scenarioId, `${label}.scenarioId`),
                applied: p.integer(value.applied, `${label}.applied`),
                inapplicable: p.array(value.inapplicable, `${label}.inapplicable`).map((item, itemIndex) => {
                    const itemLabel = `${label}.inapplicable[${itemIndex}]`;
                    const inapplicable = p.record(item, itemLabel);
                    p.exact(inapplicable, [...PAIR_KEYS, "reason"], itemLabel);
                    return { ...parsePairKey(inapplicable, itemLabel), reason: p.text(inapplicable.reason, `${itemLabel}.reason`) };
                }),
                violations: textArray(value.violations, `${label}.violations`),
            };
        }),
        injectionCanaryHits: p.array(root.injectionCanaryHits, "report.injectionCanaryHits").map((entry, index) => {
            const label = `report.injectionCanaryHits[${index}]`;
            const value = p.record(entry, label);
            p.exact(value, ["scenarioId", "role", "transformId", "transformVersion", "seed"], label);
            return {
                scenarioId: p.string(value.scenarioId, `${label}.scenarioId`),
                role: p.enumeration(value.role, ROLES, `${label}.role`),
                transformId: value.transformId === null ? null : p.string(value.transformId, `${label}.transformId`),
                transformVersion: value.transformVersion === null ? null : p.integer(value.transformVersion, `${label}.transformVersion`),
                seed: value.seed === null ? null : p.integer(value.seed, `${label}.seed`),
            };
        }),
        tierInvalidReason: parseTierInvalidReason(root.tierInvalidReason, "report.tierInvalidReason"),
    };
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
