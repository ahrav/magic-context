import { makeContractPrimitives } from "../contract-primitives";
import type { SystemVersionTuple } from "../historian-eval/runner";
import { FAIL_REASONS, parseScenarioScore, type ScenarioScore } from "../historian-eval/scorer";
import type { InvariantVerdict } from "./invariants";

export const METAMORPHIC_REPORT_SCHEMA = "metamorphic-eval-report/v2";

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

const INVARIANT_IDS = [
    "injection-set-equality",
    "expected-absent-empty",
    "verdict-monotonicity",
    "expectation-predicate-equality",
    "false-authoritative-set-equality",
    "scenario-verdict-equality",
] as const satisfies readonly MetamorphicInvariantVerdict["invariant"][];
const SCENARIO_VERDICTS = ["PASS", "FAIL", "ERROR"] as const;
const ROLES = ["baseline", "derivative", "control-a", "control-b"] as const;

function text(value: unknown, label: string): string {
    if (typeof value !== "string") p.fail(`${label}: string-invalid`);
    return value as string;
}

function boolean(value: unknown, label: string): boolean {
    if (typeof value !== "boolean") p.fail(`${label}: boolean-invalid`);
    return value as boolean;
}

function textArray(value: unknown, label: string): string[] {
    return p.array(value, label).map((entry, index) => text(entry, `${label}[${index}]`));
}

function parsePairKey(value: Record<string, unknown>, label: string): PairKey {
    return {
        scenarioId: p.string(value.scenarioId, `${label}.scenarioId`),
        transformId: p.string(value.transformId, `${label}.transformId`),
        transformVersion: p.integer(value.transformVersion, `${label}.transformVersion`),
        seed: p.integer(value.seed, `${label}.seed`),
    };
}

const PAIR_KEYS = ["scenarioId", "transformId", "transformVersion", "seed"] as const;

function parseInvariant(raw: unknown, label: string): MetamorphicInvariantVerdict {
    const value = p.record(raw, label);
    const invariant = p.enumeration(value.invariant, INVARIANT_IDS, `${label}.invariant`);
    const holds = boolean(value.holds, `${label}.holds`);
    switch (invariant) {
        case "injection-set-equality":
            p.exact(value, ["invariant", "holds", "changes"], label);
            return {
                invariant,
                holds,
                changes: p.array(value.changes, `${label}.changes`).map((entry, index) => {
                    const changeLabel = `${label}.changes[${index}]`;
                    const change = p.record(entry, changeLabel);
                    p.exact(change, ["direction", "claim"], changeLabel);
                    const claim = p.record(change.claim, `${changeLabel}.claim`);
                    p.exact(claim, ["category", "content"], `${changeLabel}.claim`);
                    return {
                        direction: p.enumeration(change.direction, ["missing-from-derivative", "added-in-derivative"] as const, `${changeLabel}.direction`),
                        claim: { category: text(claim.category, `${changeLabel}.claim.category`), content: text(claim.content, `${changeLabel}.claim.content`) },
                    };
                }),
            };
        case "expected-absent-empty":
        case "false-authoritative-set-equality":
            p.exact(value, ["invariant", "holds", "baselineMatches", "derivativeMatches"], label);
            return { invariant, holds, baselineMatches: textArray(value.baselineMatches, `${label}.baselineMatches`), derivativeMatches: textArray(value.derivativeMatches, `${label}.derivativeMatches`) };
        case "verdict-monotonicity":
            p.exact(value, ["invariant", "holds", "baselineVerdict", "derivativeVerdict", "introducedFailReasons"], label);
            return {
                invariant,
                holds,
                baselineVerdict: p.enumeration(value.baselineVerdict, SCENARIO_VERDICTS, `${label}.baselineVerdict`),
                derivativeVerdict: p.enumeration(value.derivativeVerdict, SCENARIO_VERDICTS, `${label}.derivativeVerdict`),
                introducedFailReasons: p.array(value.introducedFailReasons, `${label}.introducedFailReasons`)
                    .map((entry, index) => p.enumeration(entry, FAIL_REASONS, `${label}.introducedFailReasons[${index}]`)),
            };
        case "expectation-predicate-equality":
            p.exact(value, ["invariant", "holds", "changedExpectationIds"], label);
            return { invariant, holds, changedExpectationIds: textArray(value.changedExpectationIds, `${label}.changedExpectationIds`) };
        case "scenario-verdict-equality":
            p.exact(value, ["invariant", "holds", "baselineVerdict", "derivativeVerdict"], label);
            return {
                invariant,
                holds,
                baselineVerdict: p.enumeration(value.baselineVerdict, SCENARIO_VERDICTS, `${label}.baselineVerdict`),
                derivativeVerdict: p.enumeration(value.derivativeVerdict, SCENARIO_VERDICTS, `${label}.derivativeVerdict`),
            };
    }
}

function parseEntry(raw: unknown, label: string): MetamorphicReportEntry {
    const value = p.record(raw, label);
    const kind = p.enumeration(value.kind, ["lint-red", "stage-not-scored", "scored", "error"] as const, `${label}.kind`);
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
                role: p.enumeration(value.role, ["baseline", "derivative"] as const, `${label}.role`),
                stage: p.enumeration(value.stage, ["validation-rejected", "authored-evidence-unprocessed"] as const, `${label}.stage`),
                error: text(value.error, `${label}.error`),
            };
        case "scored":
            p.exact(value, [...PAIR_KEYS, "kind", "baselineScore", "derivativeScore", "invariants"], label);
            return {
                ...pair,
                kind,
                baselineScore: parseScenarioScore(value.baselineScore, `${label}.baselineScore`),
                derivativeScore: parseScenarioScore(value.derivativeScore, `${label}.derivativeScore`),
                invariants: p.array(value.invariants, `${label}.invariants`)
                    .map((entry, index) => parseInvariant(entry, `${label}.invariants[${index}]`)),
            };
        case "error":
            p.exact(value, [...PAIR_KEYS, "kind", "error"], label);
            return { ...pair, kind, error: text(value.error, `${label}.error`) };
    }
}

function parseTierInvalidReason(raw: unknown, label: string): TierInvalidReason | null {
    if (raw === null) return null;
    const value = p.record(raw, label);
    const kind = p.enumeration(value.kind, ["incomplete", "control-disagreement", "control-error", "selection-empty", "deadline-exhausted"] as const, `${label}.kind`);
    switch (kind) {
        case "incomplete":
            p.exact(value, ["kind"], label);
            return { kind };
        case "control-disagreement":
            p.exact(value, ["kind", "systemMismatch", "failedInvariants"], label);
            return {
                kind,
                systemMismatch: boolean(value.systemMismatch, `${label}.systemMismatch`),
                failedInvariants: p.array(value.failedInvariants, `${label}.failedInvariants`)
                    .map((entry, index) => p.enumeration(entry, INVARIANT_IDS, `${label}.failedInvariants[${index}]`)),
            };
        case "control-error":
            p.exact(value, ["kind", "controlAErrorReason", "controlBErrorReason"], label);
            return {
                kind,
                controlAErrorReason: value.controlAErrorReason === null ? null : text(value.controlAErrorReason, `${label}.controlAErrorReason`),
                controlBErrorReason: value.controlBErrorReason === null ? null : text(value.controlBErrorReason, `${label}.controlBErrorReason`),
            };
        case "selection-empty":
            p.exact(value, ["kind", "reason"], label);
            return { kind, reason: text(value.reason, `${label}.reason`) };
        case "deadline-exhausted":
            p.exact(value, ["kind", "nextRole"], label);
            return { kind, nextRole: p.enumeration(value.nextRole, ROLES, `${label}.nextRole`) };
    }
}

function parseSystem(raw: unknown, label: string): SystemVersionTuple | null {
    if (raw === null) return null;
    const value = p.record(raw, label);
    p.exact(value, ["repoCommitSha", "bunVersion", "opencodeVersion", "historianModelId", "probeModelId", "parserImpl", "chunkTokenBudget"], label);
    if (value.parserImpl !== "ts") p.fail(`${label}.parserImpl: enum-invalid`);
    return {
        repoCommitSha: p.string(value.repoCommitSha, `${label}.repoCommitSha`),
        bunVersion: p.string(value.bunVersion, `${label}.bunVersion`),
        opencodeVersion: p.string(value.opencodeVersion, `${label}.opencodeVersion`),
        historianModelId: p.string(value.historianModelId, `${label}.historianModelId`),
        probeModelId: p.string(value.probeModelId, `${label}.probeModelId`),
        parserImpl: "ts",
        chunkTokenBudget: value.chunkTokenBudget === null ? null : p.integer(value.chunkTokenBudget, `${label}.chunkTokenBudget`, 1),
    };
}

/** Strict consumer parser: exact keys over every entry variant and every `tierInvalidReason` variant. */
export function parseMetamorphicReport(raw: unknown): MetamorphicReport {
    const root = p.record(raw, "report");
    p.exact(root, ["schema", "system", "entries", "coverage", "injectionCanaryHits", "tierInvalidReason"], "report");
    if (root.schema !== METAMORPHIC_REPORT_SCHEMA) p.fail("report.schema: version-invalid");
    return {
        schema: METAMORPHIC_REPORT_SCHEMA,
        system: parseSystem(root.system, "report.system"),
        entries: p.array(root.entries, "report.entries").map((entry, index) => parseEntry(entry, `report.entries[${index}]`)),
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
                    return { ...parsePairKey(inapplicable, itemLabel), reason: text(inapplicable.reason, `${itemLabel}.reason`) };
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
