import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMockHistorianOutput } from "../mock-historian";
import { lintScenario, parseScenario, type HistorianEvalScenario } from "../historian-eval/contract";
import {
    MAX_PROBE_ATTEMPTS,
    TRIGGER_TURNS_PER_HISTORIAN_RUN,
    fillerTurnCountFor,
    historianWaitBudgetMs,
    liveRolePromptCount,
    paddingTurnCountFor,
    type SystemVersionTuple,
} from "../historian-eval/runner";
import { DEFAULT_PROMPT_TIMEOUT_MS } from "../harness";
import { scoreRawOutputWithInjectedClaims } from "../historian-eval/scorer";
import { validScenario } from "../historian-eval/test-support";
import { INJECTION_CANARY } from "./injection-canary";
import {
    compareLivePair,
    runLiveMetamorphicEval,
    type LiveMetamorphicOptions,
    type LiveObservation,
    type LiveRole,
} from "./live";
import { buildMetamorphicReport, metamorphicExitCode, parseMetamorphicReport, type MetamorphicReport } from "./report";
import { buildScriptedOutput, runDeterministicMetamorphicEval, DETERMINISTIC_SEEDS } from "./runner";
import { TRANSFORMS, type Transform } from "./transforms";
import {
    liveRoleBudgetMs,
    partialReportPath,
    prepareDeterministicOutputPaths,
    prepareLiveOutputPaths,
    runLiveAndWriteReport,
    stagingReportPath,
} from "../../scripts/run-metamorphic-eval";

const CORPUS_DIR = join(import.meta.dir, "../../historian-eval/dev");

function corpus(): HistorianEvalScenario[] {
    return readdirSync(CORPUS_DIR)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => parseScenario(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")), file));
}

function reorder(): Transform {
    return TRANSFORMS.find((transform) => transform.id === "reorder-independent-turns")!;
}

function liveObservation(claims: LiveObservation["injectedClaims"]): LiveObservation {
    return {
        expectationMatches: {},
        injectedClaims: claims,
        score: {
            scenarioId: "scenario",
            verdict: "PASS",
            failReasons: [],
            errorReason: null,
            errorDetail: null,
            precision: 1,
            recall: 1,
            expectedClaimsMatched: 0,
            expectedClaimsTotal: 0,
            visibleClaimsMatched: 0,
            visibleClaimsTotal: claims.length,
            falseAuthoritativeMatches: [],
            structuralFindings: [],
            probeVerdicts: [],
            system: null,
            source: "raw-output",
        },
    };
}

function injectedClaim(content: string) {
    return {
        publicClaimId: "clm_01h00000000000000000000000",
        revisionLocator: `clm_01h00000000000000000000000@1:${"a".repeat(64)}`,
        content,
        category: "ARCHITECTURE",
        revision: 1,
    } as const;
}

function systemTuple(): SystemVersionTuple {
    return {
        repoCommitSha: "a".repeat(40),
        bunVersion: "1.4.0",
        opencodeVersion: "test",
        historianModelId: "test/historian",
        probeModelId: "test/probe",
        parserImpl: "ts",
        chunkTokenBudget: null,
    };
}

function liveMode(): LiveMetamorphicOptions["mode"] {
    return {
        kind: "live",
        apiKey: "test",
        historianModel: "test/historian",
        probeModel: { providerID: "test", modelID: "probe" },
    };
}

/** Pairs only score when both roles report one system tuple, so a shared tuple is what lets these fixtures reach the invariant comparison. */
function pairedObservation(
    claims: LiveObservation["injectedClaims"] = [],
    overrides: Partial<LiveObservation["score"]> = {},
): LiveObservation {
    const base = liveObservation(claims);
    return { ...base, score: { ...base.score, system: systemTuple(), ...overrides } };
}

function importancesOf(output: string): number[] {
    return [...output.matchAll(/ importance="(\d+)"/g)].map((match) => Number(match[1]));
}

describe("deterministic metamorphic runner", () => {
    test("rejects an empty scenario input", () => {
        expect(() => runDeterministicMetamorphicEval([])).toThrow(
            "deterministic metamorphic eval needs at least one scenario",
        );
    });

    test("scores one real scenario through reorder end to end", () => {
        const report = runDeterministicMetamorphicEval([corpus()[0]!], { transforms: [reorder()] });

        expect(report.entries).toHaveLength(1);
        expect(report.entries[0]?.kind).toBe("scored");
        expect(report.coverage[0]?.applied).toBe(1);
        expect(metamorphicExitCode(report)).toBe(0);
    });

    test("parseMetamorphicReport round-trips the full corpus report and rejects malformed variants", () => {
        const report = runDeterministicMetamorphicEval(corpus(), {
            transforms: [reorder()],
            seeds: [DETERMINISTIC_SEEDS[0]!],
        });
        expect(parseMetamorphicReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
        const invalid = buildMetamorphicReport({
            entries: [
                { scenarioId: "hse-a", transformId: "reorder-independent-turns", transformVersion: 1, seed: 0, kind: "error", error: "boom" },
                {
                    scenarioId: "hse-a", transformId: "reorder-independent-turns", transformVersion: 1, seed: 1,
                    kind: "stage-not-scored", role: "derivative", stage: "validation-rejected", error: "rejected",
                },
                { scenarioId: "hse-a", transformId: "reorder-independent-turns", transformVersion: 1, seed: 2, kind: "lint-red", diagnostics: ["d1"] },
            ],
            coverage: [{ scenarioId: "hse-a", applied: 1, inapplicable: [{ scenarioId: "hse-a", transformId: "t", transformVersion: 1, seed: 3, reason: "n/a" }], violations: [] }],
            injectionCanaryHits: [{ scenarioId: "hse-a", role: "control-a", transformId: null, transformVersion: null, seed: null }],
            tierInvalidReason: { kind: "control-disagreement", systemMismatch: true, failedInvariants: ["scenario-verdict-equality"] },
            system: systemTuple(),
        });
        expect(parseMetamorphicReport(JSON.parse(JSON.stringify(invalid)))).toEqual(invalid);

        expect(() => parseMetamorphicReport({ ...report, schema: "metamorphic-eval-report/v1" })).toThrow(/report\.schema: version-invalid/);
        expect(() => parseMetamorphicReport({ ...report, operator: "x" })).toThrow(/^report: fields-invalid/);
        const unknownKind = structuredClone(invalid) as unknown as { entries: Record<string, unknown>[] };
        unknownKind.entries[0]!.kind = "skipped";
        expect(() => parseMetamorphicReport(unknownKind)).toThrow(/report\.entries\[0\]\.kind: enum-invalid/);
        // On a completed run, every applied pair left an entry behind.
        const inflatedApplied = structuredClone(report);
        inflatedApplied.coverage[0]!.applied += 1;
        expect(metamorphicExitCode(inflatedApplied)).toBe(metamorphicExitCode(report));
        expect(() => parseMetamorphicReport(inflatedApplied)).toThrow(/report\.coverage\[0\]\.applied: derived-mismatch/);
        // A transform that throws during admission leaves an error entry without counting as applied, so a
        // lower applied count is a shape the producer can emit.
        const deflatedApplied = structuredClone(report);
        deflatedApplied.coverage[0]!.applied -= 1;
        if (deflatedApplied.coverage[0]!.applied === 0) deflatedApplied.coverage[0]!.violations = ["no transforms applied"];
        expect(() => parseMetamorphicReport(deflatedApplied)).not.toThrow();
        // A scenario nothing applied to records that as a violation.
        const silentZero = structuredClone(report);
        const zeroRow = silentZero.coverage[0]!;
        silentZero.entries = silentZero.entries.filter((entry) => entry.scenarioId !== zeroRow.scenarioId || entry.kind === "lint-red");
        zeroRow.applied = 0;
        zeroRow.violations = [];
        expect(() => parseMetamorphicReport(silentZero)).toThrow(/report\.coverage\[0\]\.violations: derived-mismatch/);
        // One admission disposition per coordinate, so an inapplicable pair is listed once.
        const doubledInapplicable = structuredClone(invalid);
        doubledInapplicable.coverage[0]!.inapplicable.push(structuredClone(doubledInapplicable.coverage[0]!.inapplicable[0]!));
        expect(() => parseMetamorphicReport(doubledInapplicable)).toThrow(/report\.coverage\[0\]\.inapplicable: duplicate/);
        // selection-empty means nothing was admitted or scored.
        const falseEmpty = structuredClone(report);
        falseEmpty.tierInvalidReason = { kind: "selection-empty", reason: "n/a" };
        expect(() => parseMetamorphicReport(falseEmpty)).toThrow(/report\.tierInvalidReason: selection-empty-with-entries/);
        // A coordinate is inapplicable, rejected, or admitted, never two of those.
        const doubleBooked = structuredClone(report);
        const bookedEntry = doubleBooked.entries.find((entry) => entry.kind === "scored")!;
        doubleBooked.coverage.find(({ scenarioId }) => scenarioId === bookedEntry.scenarioId)!.inapplicable.push({
            scenarioId: bookedEntry.scenarioId, transformId: bookedEntry.transformId,
            transformVersion: bookedEntry.transformVersion, seed: bookedEntry.seed, reason: "n/a",
        });
        expect(() => parseMetamorphicReport(doubleBooked)).toThrow(/report\.coverage\[\d+\]\.inapplicable\[\d+\]: entry-conflict/);
        const duplicateCoverage = structuredClone(invalid);
        duplicateCoverage.coverage.push(structuredClone(duplicateCoverage.coverage[0]!));
        expect(() => parseMetamorphicReport(duplicateCoverage)).toThrow(/report\.coverage: duplicate/);
        const strayInapplicable = structuredClone(invalid);
        strayInapplicable.coverage[0]!.inapplicable[0]!.scenarioId = "hse-elsewhere";
        expect(() => parseMetamorphicReport(strayInapplicable))
            .toThrow(/report\.coverage\[0\]\.inapplicable\[0\]\.scenarioId: coverage-scenario-mismatch/);
        // The builder sorts each array, so a reordered archive is not a shape it can emit.
        const reordered = structuredClone(report);
        expect(reordered.entries.length).toBeGreaterThan(1);
        reordered.entries.reverse();
        expect(() => parseMetamorphicReport(reordered)).toThrow(/report\.entries: order-invalid/);
        const bothNull = structuredClone(invalid) as unknown as { tierInvalidReason: Record<string, unknown> };
        bothNull.tierInvalidReason = { kind: "control-error", controlAErrorReason: null, controlBErrorReason: null };
        expect(() => parseMetamorphicReport(bothNull))
            .toThrow(/report\.tierInvalidReason: control-error-reason-required/);
        // A control disagreement is recorded only with a cause, and only over the live comparator's invariants.
        const causeless = structuredClone(invalid) as unknown as { tierInvalidReason: Record<string, unknown> };
        causeless.tierInvalidReason.systemMismatch = false;
        causeless.tierInvalidReason.failedInvariants = [];
        expect(() => parseMetamorphicReport(causeless))
            .toThrow(/report\.tierInvalidReason: control-disagreement-cause-required/);
        const foreignInvariant = structuredClone(invalid) as unknown as { tierInvalidReason: Record<string, unknown> };
        foreignInvariant.tierInvalidReason.failedInvariants = ["verdict-monotonicity"];
        expect(() => parseMetamorphicReport(foreignInvariant))
            .toThrow(/report\.tierInvalidReason\.failedInvariants\[0\]: enum-invalid/);
        // Only the derivative ran a transform, so only it names one.
        const canaryCoords = structuredClone(invalid) as unknown as { injectionCanaryHits: Record<string, unknown>[] };
        canaryCoords.injectionCanaryHits[0]!.transformId = "reorder-independent-turns";
        expect(() => parseMetamorphicReport(canaryCoords))
            .toThrow(/report\.injectionCanaryHits\[0\]: canary-coordinates-unexpected/);
        const canarySeed = structuredClone(invalid) as unknown as { injectionCanaryHits: Record<string, unknown>[] };
        canarySeed.injectionCanaryHits[0]!.role = "derivative";
        expect(() => parseMetamorphicReport(canarySeed))
            .toThrow(/report\.injectionCanaryHits\[0\]: canary-coordinates-required/);
        const extraNested = structuredClone(report) as unknown as { entries: Record<string, unknown>[] };
        extraNested.entries[0]!.note = "x";
        expect(() => parseMetamorphicReport(extraNested)).toThrow(/report\.entries\[0\]: fields-invalid/);
        const badReason = structuredClone(invalid) as unknown as { tierInvalidReason: Record<string, unknown> };
        badReason.tierInvalidReason.kind = "tired";
        expect(() => parseMetamorphicReport(badReason)).toThrow(/report\.tierInvalidReason\.kind: enum-invalid/);

        // `holds` is derivable from each invariant's evidence, so a recorded value that disagrees is rejected rather than trusted.
        const scoredIndex = report.entries.findIndex((entry) => entry.kind === "scored");
        expect(scoredIndex).toBeGreaterThanOrEqual(0);
        const flipped = structuredClone(report);
        const scored = flipped.entries[scoredIndex]!;
        if (scored.kind !== "scored") throw new Error("unreachable");
        const verdictEquality = scored.invariants.findIndex((entry) => entry.invariant === "scenario-verdict-equality");
        const target = scored.invariants[verdictEquality]!;
        if (target.invariant !== "scenario-verdict-equality") throw new Error("unreachable");
        target.derivativeVerdict = target.baselineVerdict === "PASS" ? "FAIL" : "PASS";
        // The flipped evidence leaves `holds` untouched, so the exit code alone cannot see the contradiction.
        expect(metamorphicExitCode(flipped)).toBe(metamorphicExitCode(report));
        expect(() => parseMetamorphicReport(flipped))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]\\.invariants\\[${verdictEquality}\\]\\.holds: derived-mismatch`));

        // A scored pair whose roles ran different systems cannot isolate the transform, so parsing rejects it.
        const crossSystem = structuredClone(report);
        const crossEntry = crossSystem.entries[scoredIndex]!;
        if (crossEntry.kind !== "scored") throw new Error("unreachable");
        crossEntry.derivativeScore.system = {
            repoCommitSha: "f".repeat(40),
            bunVersion: "9.9.9",
            opencodeVersion: "9.9.9",
            historianModelId: "other-model",
            probeModelId: "other-probe",
            parserImpl: "ts",
            chunkTokenBudget: null,
        };
        // Both roles still say PASS and every archived invariant still holds, so the exit code stays green.
        expect(metamorphicExitCode(crossSystem)).toBe(metamorphicExitCode(report));
        expect(() => parseMetamorphicReport(crossSystem))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]: pair-system-mismatch`));

        // The raw-output scorer stamps a null tuple, so a matching pair of forged tuples is still not its output.
        const forgedTuples = structuredClone(report);
        const forgedTupleEntry = forgedTuples.entries[scoredIndex]!;
        if (forgedTupleEntry.kind !== "scored") throw new Error("unreachable");
        forgedTupleEntry.baselineScore.system = systemTuple();
        forgedTupleEntry.derivativeScore.system = systemTuple();
        expect(() => parseMetamorphicReport(forgedTuples))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]: report-system-mismatch`));
        // Equal tuples parse, including the null pair this runner produces.
        expect(report.entries[scoredIndex]).toMatchObject({ baselineScore: { system: null }, derivativeScore: { system: null } });
        expect(() => parseMetamorphicReport(report)).not.toThrow();

        // A baseline score lifted from another scenario would let one passing bundle stand in for every pair.
        const unbound = structuredClone(report);
        const unboundEntry = unbound.entries[scoredIndex]!;
        if (unboundEntry.kind !== "scored") throw new Error("unreachable");
        unboundEntry.baselineScore.scenarioId = `${unboundEntry.scenarioId}-other`;
        expect(metamorphicExitCode(unbound)).toBe(metamorphicExitCode(report));
        expect(() => parseMetamorphicReport(unbound))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]\\.baselineScore\\.scenarioId: pair-scenario-mismatch`));

        // The derivative id is derivable from the pair key, so a score from another pair cannot stand in.
        const swapped = structuredClone(report);
        const swappedEntry = swapped.entries[scoredIndex]!;
        if (swappedEntry.kind !== "scored") throw new Error("unreachable");
        expect(swappedEntry.derivativeScore.scenarioId).toBe(
            `${swappedEntry.scenarioId}-d-${swappedEntry.transformId}-v${swappedEntry.transformVersion}-s${swappedEntry.seed}`,
        );
        swappedEntry.derivativeScore.scenarioId = `${swappedEntry.derivativeScore.scenarioId}-x`;
        expect(metamorphicExitCode(swapped)).toBe(metamorphicExitCode(report));
        expect(() => parseMetamorphicReport(swapped))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]\\.derivativeScore\\.scenarioId: pair-scenario-mismatch`));

        // `normalizedSeed` rejects a seed past 32 bits, so the runner records such a coordinate as an error.
        const wideSeed = structuredClone(report);
        wideSeed.entries[scoredIndex]!.seed = 0x1_0000_0000;
        expect(() => parseMetamorphicReport(wideSeed))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]\\.seed: integer-invalid`));

        // Changing both verdicts preserves `holds`; score evidence must still match.
        const bothSides = structuredClone(report);
        const bothSidesEntry = bothSides.entries[scoredIndex]!;
        if (bothSidesEntry.kind !== "scored") throw new Error("unreachable");
        const equality = bothSidesEntry.invariants.findIndex((entry) => entry.invariant === "scenario-verdict-equality");
        const both = bothSidesEntry.invariants[equality]!;
        if (both.invariant !== "scenario-verdict-equality") throw new Error("unreachable");
        both.baselineVerdict = "ERROR";
        both.derivativeVerdict = "ERROR";
        expect(both.holds).toBe(true);
        expect(metamorphicExitCode(bothSides)).toBe(metamorphicExitCode(report));
        expect(() => parseMetamorphicReport(bothSides))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]\\.invariants\\[${equality}\\]\\.baselineVerdict: score-evidence-mismatch`));

        const duplicated = structuredClone(report);
        duplicated.entries.push(structuredClone(duplicated.entries[scoredIndex]!));
        expect(() => parseMetamorphicReport(duplicated)).toThrow(/report\.entries: duplicate/);

        // The control exemption is claimable only at the reserved coordinate.
        const forgedControl = structuredClone(report);
        const forgedEntry = forgedControl.entries[scoredIndex]!;
        forgedEntry.transformId = "baseline-control";
        forgedEntry.transformVersion = 7;
        if (forgedEntry.kind !== "scored") throw new Error("unreachable");
        forgedEntry.derivativeScore.scenarioId = forgedEntry.scenarioId;
        expect(() => parseMetamorphicReport(forgedControl))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]: control-pair-coordinates-invalid`));
        // Only the live runner emits the control pair, so a raw-output pair cannot claim the exemption.
        const relabelled = structuredClone(report);
        const relabelledEntry = relabelled.entries[scoredIndex]!;
        relabelledEntry.transformId = "baseline-control";
        relabelledEntry.transformVersion = 1;
        relabelledEntry.seed = 0;
        if (relabelledEntry.kind !== "scored") throw new Error("unreachable");
        relabelledEntry.derivativeScore.scenarioId = relabelledEntry.scenarioId;
        expect(relabelledEntry.baselineScore.source).toBe("raw-output");
        expect(() => parseMetamorphicReport(relabelled))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]: control-pair-source-invalid`));

        // The pair checks only prove the roles agree with each other, not that they ran the named system.
        const rootMismatch = structuredClone(report);
        rootMismatch.system = systemTuple();
        // A raw-output report publishes no root tuple at all.
        expect(() => parseMetamorphicReport(rootMismatch)).toThrow(/report\.system: report-system-mismatch/);
        // Relabelled as a live report, the roles must still name the root's system.
        for (const entry of rootMismatch.entries) {
            if (entry.kind !== "scored") continue;
            entry.baselineScore.source = "run-record";
            entry.derivativeScore.source = "run-record";
            const probe = { probeId: "probe-1", outcome: "pass" as const, expected: "yes", actual: "yes" };
            entry.baselineScore.probeVerdicts = [probe];
            entry.derivativeScore.probeVerdicts = [probe];
            entry.invariants = entry.invariants.filter(({ invariant }) =>
                invariant !== "expected-absent-empty" && invariant !== "verdict-monotonicity");
        }
        // A live report carries its stability control before any product pair.
        expect(() => parseMetamorphicReport(rootMismatch)).toThrow(/report\.entries: control-pair-required/);
        const rootEntry = rootMismatch.entries[scoredIndex]!;
        if (rootEntry.kind !== "scored") throw new Error("unreachable");
        const otherSystem = { ...systemTuple(), historianModelId: "another-model" };
        rootEntry.baselineScore.system = otherSystem;
        rootEntry.derivativeScore.system = otherSystem;
        const control = structuredClone(rootEntry);
        control.transformId = "baseline-control";
        control.transformVersion = 1;
        control.seed = 0;
        control.derivativeScore.scenarioId = control.scenarioId;
        rootMismatch.entries.push(control);
        rootMismatch.entries.sort((left, right) =>
            `${left.scenarioId}\u0000${left.transformId}`.localeCompare(`${right.scenarioId}\u0000${right.transformId}`));
        expect(() => parseMetamorphicReport(rootMismatch)).toThrow(/report\.entries\[\d+\]: report-system-mismatch/);
        // A run-record score carries the tuple its record was validated with.
        const nullPairSystem = structuredClone(rootMismatch);
        for (const entry of nullPairSystem.entries) {
            if (entry.kind !== "scored") continue;
            entry.baselineScore.system = null;
            entry.derivativeScore.system = null;
        }
        expect(() => parseMetamorphicReport(nullPairSystem)).toThrow(/report\.entries\[\d+\]: system-required/);
        // A live report always names the system it ran.
        const identityless = structuredClone(rootMismatch);
        identityless.system = null;
        for (const entry of identityless.entries) {
            if (entry.kind !== "scored") continue;
            entry.baselineScore.system = systemTuple();
            entry.derivativeScore.system = systemTuple();
        }
        expect(() => parseMetamorphicReport(identityless)).toThrow(/report\.system: report-system-mismatch/);
        // Control roles exist only in a live report, which names the system it ran.
        const strayControl = structuredClone(report);
        strayControl.injectionCanaryHits.push({ scenarioId: "hse-control", role: "control-a", transformId: null, transformVersion: null, seed: null });
        expect(() => parseMetamorphicReport(strayControl))
            .toThrow(/report\.injectionCanaryHits\[0\]: control-role-requires-live-report/);
        // A canary hit names a covered scenario.
        const strayHit = structuredClone(report);
        strayHit.injectionCanaryHits.push({ scenarioId: "hse-nowhere", role: "baseline", transformId: null, transformVersion: null, seed: 1 });
        expect(() => parseMetamorphicReport(strayHit)).toThrow(/report\.injectionCanaryHits\[0\]: coverage-row-required/);
        // Every scenario with entries has its coverage row, or its violations could vanish with it.
        const uncovered = structuredClone(report);
        const dropped = uncovered.coverage.shift()!;
        expect(uncovered.entries.some((entry) => entry.scenarioId === dropped.scenarioId)).toBe(true);
        expect(() => parseMetamorphicReport(uncovered)).toThrow(/report\.entries\[\d+\]: coverage-row-required/);
        // Each producer emits a fixed invariant set, so dropping a row hides a failure.
        const missingInvariant = structuredClone(report);
        const missingEntry = missingInvariant.entries[scoredIndex]!;
        if (missingEntry.kind !== "scored") throw new Error("unreachable");
        missingEntry.invariants = missingEntry.invariants.filter(({ invariant }) => invariant !== "injection-set-equality");
        expect(metamorphicExitCode(missingInvariant)).toBe(metamorphicExitCode(report));
        expect(() => parseMetamorphicReport(missingInvariant))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]\\.invariants: invariant-set-mismatch`));

        // Each producer scores both roles through one path, so a mixed-source pair is unreachable.
        const mixedSource = structuredClone(report);
        const mixedEntry = mixedSource.entries[scoredIndex]!;
        if (mixedEntry.kind !== "scored") throw new Error("unreachable");
        expect(mixedEntry.baselineScore.source).toBe("raw-output");
        mixedEntry.derivativeScore.source = "run-record";
        mixedEntry.derivativeScore.probeVerdicts = [{ probeId: "probe-1", outcome: "pass", expected: "yes", actual: "yes" }];
        expect(metamorphicExitCode(mixedSource)).toBe(metamorphicExitCode(report));
        expect(() => parseMetamorphicReport(mixedSource))
            .toThrow(new RegExp(`report\\.entries\\[${scoredIndex}\\]: pair-source-mismatch`));
    });

    test("refuses a seed the transforms would reject before building any entry", () => {
        expect(() => runDeterministicMetamorphicEval([corpus()[0]!], { seeds: [0x1_0000_0000] }))
            .toThrow(/seed 4294967296 is outside the unsigned 32-bit range/);
        expect(() => runDeterministicMetamorphicEval([corpus()[0]!], { seeds: [7, 7] })).toThrow(/seed 7 is listed twice/);
        expect(() => runDeterministicMetamorphicEval([corpus()[0]!], { transforms: [reorder(), reorder()] })).toThrow(/is listed twice/);
        expect(() => runDeterministicMetamorphicEval([corpus()[0]!], { transforms: [{ ...reorder(), version: 1.5 }] }))
            .toThrow(/not a non-negative safe integer/);
        expect(() => runDeterministicMetamorphicEval([corpus()[0]!], { transforms: [{ ...reorder(), id: "baseline-control" }] }))
            .toThrow(/reserved for the control pair/);
    });

    test("runs the full corpus deterministically with all invariants green", () => {
        const scenarios = corpus();
        const first = runDeterministicMetamorphicEval(scenarios);
        const second = runDeterministicMetamorphicEval(scenarios);

        expect(metamorphicExitCode(first)).toBe(0);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    test("assigns distinct importances up to the value range, then repeats them", () => {
        const scenario = validScenario();
        const atRange = {
            ...scenario,
            transcript: {
                ...scenario.transcript,
                turns: Array.from({ length: 100 }, () => ({ user: "context", assistant: "noted" })),
            },
        };
        const atRangeImportances = importancesOf(buildScriptedOutput(atRange, 0));

        expect(atRangeImportances).toHaveLength(100);
        expect(new Set(atRangeImportances).size).toBe(100);

        const beyondRange = {
            ...atRange,
            gold: { ...atRange.gold, compartments: { minCount: 150 } },
        };
        const beyondRangeImportances = importancesOf(buildScriptedOutput(beyondRange, 0));

        expect(beyondRangeImportances).toHaveLength(150);
        expect(new Set(beyondRangeImportances).size).toBe(100);
        expect(Math.min(...beyondRangeImportances)).toBeGreaterThanOrEqual(1);
        expect(Math.max(...beyondRangeImportances)).toBeLessThanOrEqual(100);
    });

    test("scores a scenario whose lint-legal compartment count exceeds the importance range", () => {
        const scenario = validScenario();
        const wide = {
            ...scenario,
            transcript: {
                ...scenario.transcript,
                turns: Array.from({ length: 60 }, () => ({ user: "context", assistant: "noted" })),
            },
            gold: { ...scenario.gold, compartments: { minCount: 110 } },
        };

        expect(lintScenario(wide).filter((d) => d.includes("compartments.minCount"))).toEqual([]);
        expect(importancesOf(buildScriptedOutput(wide, 0))).toHaveLength(110);
    });

    test("builds at least the declared compartment minimum", () => {
        const scenario = validScenario();
        scenario.gold.compartments.minCount = 6;

        const output = buildScriptedOutput(scenario, 0);

        expect([...output.matchAll(/<compartment\b/g)]).toHaveLength(6);
    });

    test("normalizes predicate text before building scripted facts", () => {
        const scenario = validScenario();
        scenario.gold.expectedClaims[0]!.predicate.value = "  use the in-process\nLRU cache  ";

        expect(buildScriptedOutput(scenario, 0)).toContain("use the in-process lru cache");
    });

    test("reports a seeded accepted-claim drop as product brittleness", () => {
        const scenario = validScenario();
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            buildOutput: (candidate, seed) =>
                buildScriptedOutput(
                    candidate,
                    seed,
                    candidate.id.includes("-d-")
                        ? candidate.gold.expectedClaims.slice(1)
                        : candidate.gold.expectedClaims,
                ),
        });

        const entry = report.entries[0];
        expect(entry?.kind).toBe("scored");
        if (entry?.kind !== "scored") throw new Error("expected scored entry");
        expect(entry.invariants[0]?.holds).toBe(false);
        expect(entry.invariants[0]).toEqual(expect.objectContaining({
            changes: expect.arrayContaining([
                expect.objectContaining({ direction: "missing-from-derivative" }),
            ]),
        }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("reorder exposes an ordinal-sensitive producer without editing its output", () => {
        const scenario = validScenario();
        let seed = 0;
        let movedClaimId = "";
        for (; seed < 100; seed += 1) {
            const transformed = reorder().apply(scenario, seed);
            if (!transformed.applicable) continue;
            const moved = transformed.scenario.gold.expectedClaims.find((claim) => {
                const base = scenario.gold.expectedClaims.find((candidate) => candidate.id === claim.id)!;
                return claim.sourceTurnRange[0] !== base.sourceTurnRange[0];
            });
            if (moved) {
                movedClaimId = moved.id;
                break;
            }
        }
        expect(movedClaimId).not.toBe("");

        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            seeds: [seed],
            buildOutput: (candidate, candidateSeed) => {
                const claims = candidate.gold.expectedClaims.filter((claim) => {
                    const base = scenario.gold.expectedClaims.find((expected) => expected.id === claim.id);
                    return base === undefined || claim.sourceTurnRange[0] === base.sourceTurnRange[0];
                });
                return buildScriptedOutput(candidate, candidateSeed, claims);
            },
        });

        const entry = report.entries[0];
        expect(entry?.kind).toBe("scored");
        if (entry?.kind !== "scored") throw new Error("expected scored entry");
        expect(entry.invariants[0]).toEqual(expect.objectContaining({ holds: false }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("classifies lint-red before derivative scoring", () => {
        const scenario = validScenario();
        let scoreCalls = 0;
        const broken: Transform = {
            id: "broken-remap",
            version: 1,
            alwaysApplicable: false,
            preservesTurnText: true,
            apply(base) {
                return {
                    applicable: true,
                    scenario: parseScenario({
                        ...base,
                        id: `${base.id}-d-broken-remap-v1-s0`,
                        gold: {
                            ...base.gold,
                            expectedClaims: base.gold.expectedClaims.map((claim, index) =>
                                index === 0
                                    ? { ...claim, predicate: { ...claim.predicate, value: "not authored here" } }
                                    : claim,
                            ),
                        },
                    }),
                    turnMap: base.transcript.turns.map((_, index) => index),
                };
            },
        };
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [broken],
            seeds: [0],
            scoreOutput(rawOutput, candidate, options) {
                scoreCalls += 1;
                return scoreRawOutputWithInjectedClaims(rawOutput, candidate, options);
            },
        });

        const brokenResult = broken.apply(scenario, 0);
        if (!brokenResult.applicable) throw new Error("broken fixture must apply");
        expect(lintScenario(brokenResult.scenario)).not.toEqual([]);
        expect(report.entries[0]?.kind).toBe("lint-red");
        expect(scoreCalls).toBe(1);
        expect(report.coverage[0]).toEqual(expect.objectContaining({
            applied: 0,
            violations: ["no transforms applied"],
        }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("rejects a derivative whose declared turn map disagrees with its gold", () => {
        const transform: Transform = {
            ...reorder(),
            id: "wrong-map",
            apply(base, seed) {
                const result = reorder().apply(base, seed);
                if (!result.applicable) return result;
                return { ...result, turnMap: base.transcript.turns.map((_, index) => index) };
            },
        };

        const report = runDeterministicMetamorphicEval([validScenario()], {
            transforms: [transform],
            seeds: [0],
        });

        expect(report.entries[0]).toEqual(expect.objectContaining({
            kind: "lint-red",
            diagnostics: expect.arrayContaining(["derivative gold does not match its declared turn map"]),
        }));
    });

    test("matches each derivative with the baseline built from the same seed", () => {
        const scenario = validScenario();
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            seeds: [0, 1],
            buildOutput(candidate, seed) {
                return buildScriptedOutput(
                    candidate,
                    seed,
                    seed === 0 ? candidate.gold.expectedClaims : candidate.gold.expectedClaims.slice(1),
                );
            },
        });

        expect(report.entries).toHaveLength(2);
        expect(report.entries.every((entry) =>
            entry.kind === "scored" && entry.invariants[0]?.holds === true
        )).toBe(true);
    });

    test("emits score-level invariants for scored pairs", () => {
        const report = runDeterministicMetamorphicEval([validScenario()], {
            transforms: [reorder()],
            seeds: [0],
        });
        const entry = report.entries[0];
        if (entry?.kind !== "scored") throw new Error("expected scored entry");

        expect(entry.invariants.map((invariant) => invariant.invariant)).toEqual([
            "injection-set-equality",
            "expected-absent-empty",
            "verdict-monotonicity",
            "expectation-predicate-equality",
            "false-authoritative-set-equality",
            "scenario-verdict-equality",
        ]);
    });

    test("fails an empty report instead of passing vacuously", () => {
        expect(metamorphicExitCode(buildMetamorphicReport({
            entries: [],
            coverage: [],
            injectionCanaryHits: [],
        }))).toBe(1);
    });

    test("preserves canary claims from authored-evidence-unprocessed output", () => {
        const scenario = validScenario();
        const output = buildMockHistorianOutput({
            compartments: [{ start: 1, end: 2, title: "Prefix", body: "Prefix only." }],
            facts: [{ category: "CONSTRAINTS", content: INJECTION_CANARY }],
        });
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            buildOutput: (candidate, seed) =>
                candidate.id.includes("-d-") ? output : buildScriptedOutput(candidate, seed),
        });

        expect(report.entries[0]).toEqual(expect.objectContaining({
            kind: "stage-not-scored",
            role: "derivative",
            stage: "authored-evidence-unprocessed",
        }));
        expect(report.injectionCanaryHits).toEqual([
            expect.objectContaining({ role: "derivative" }),
        ]);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("rejects a transform that changes only derived labels", () => {
        const noOp: Transform = {
            id: "no-op-labels",
            version: 1,
            alwaysApplicable: true,
            preservesTurnText: true,
            apply(base) {
                return {
                    applicable: true,
                    scenario: parseScenario({
                        ...base,
                        id: `${base.id}-d-no-op-labels-v1-s0`,
                        title: `${base.title} (derived)`,
                    }),
                    turnMap: base.transcript.turns.map((_, index) => index),
                };
            },
        };

        const report = runDeterministicMetamorphicEval([validScenario()], {
            transforms: [noOp],
            seeds: [0],
        });

        expect(report.entries).toEqual([
            expect.objectContaining({
                kind: "lint-red",
                diagnostics: expect.arrayContaining(["derivative semantic fingerprint equals baseline"]),
            }),
        ]);
    });

    test.each([
        ["validation-rejected", () => "not historian output"],
        [
            "authored-evidence-unprocessed",
            (scenario: HistorianEvalScenario) => buildMockHistorianOutput({
                compartments: [{ start: 1, end: 2, title: "Prefix", body: "Prefix only." }],
                facts: scenario.gold.expectedClaims.map((claim) => ({
                    category: claim.category,
                    content: claim.predicate.value,
                })),
            }),
        ],
    ] as const)("classifies %s scripted output as stage-not-scored", (stage, derivativeOutput) => {
        const scenario = validScenario();
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            buildOutput: (candidate, seed) =>
                candidate.id.includes("-d-") ? derivativeOutput(candidate) : buildScriptedOutput(candidate, seed),
        });

        expect(report.entries[0]).toEqual(expect.objectContaining({
            kind: "stage-not-scored",
            role: "derivative",
            stage,
        }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("gives injection promotion exclusive exit code 2", () => {
        const scenario = validScenario();
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            buildOutput: (candidate, seed) => {
                if (!candidate.id.includes("-d-")) return buildScriptedOutput(candidate, seed);
                return buildMockHistorianOutput({
                    compartments: [{
                        start: 1,
                        end: candidate.transcript.turns.length * 2,
                        title: "Injection canary",
                        body: "Injection canary test.",
                    }],
                    facts: [
                        ...candidate.gold.expectedClaims.map((claim) => ({
                            category: claim.category,
                            content: claim.predicate.value,
                        })),
                        { category: "CONSTRAINTS", content: INJECTION_CANARY },
                    ],
                });
            },
        });

        expect(report.injectionCanaryHits).toEqual([
            expect.objectContaining({ role: "derivative", transformId: reorder().id }),
        ]);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("records a baseline canary without derivative coordinates", () => {
        const scenario = validScenario();
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            buildOutput: (candidate, seed) => buildMockHistorianOutput({
                compartments: [{
                    start: 1,
                    end: candidate.transcript.turns.length * 2,
                    title: "Canary fixture",
                    body: "Canary fixture.",
                }],
                facts: [
                    ...candidate.gold.expectedClaims.map((claim) => ({
                        category: claim.category,
                        content: claim.predicate.value,
                    })),
                    ...(!candidate.id.includes("-d-")
                        ? [{ category: "CONSTRAINTS" as const, content: INJECTION_CANARY }]
                        : []),
                ],
            }),
        });

        expect(report.injectionCanaryHits).toEqual([{
            scenarioId: scenario.id,
            role: "baseline",
            transformId: null,
            transformVersion: null,
            seed: DETERMINISTIC_SEEDS[0],
        }]);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("names the offending seed when one seeded baseline promotes the canary", () => {
        const scenario = validScenario();
        const seeds = [11, 22, 33] as const;
        const offending = 22;
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [reorder()],
            seeds,
            buildOutput: (candidate, seed) => buildMockHistorianOutput({
                compartments: [{
                    start: 1,
                    end: candidate.transcript.turns.length * 2,
                    title: "Canary fixture",
                    body: "Canary fixture.",
                }],
                facts: [
                    ...candidate.gold.expectedClaims.map((claim) => ({
                        category: claim.category,
                        content: claim.predicate.value,
                    })),
                    ...(!candidate.id.includes("-d-") && seed === offending
                        ? [{ category: "CONSTRAINTS" as const, content: INJECTION_CANARY }]
                        : []),
                ],
            }),
        });

        expect(report.injectionCanaryHits).toEqual([{
            scenarioId: scenario.id,
            role: "baseline",
            transformId: null,
            transformVersion: null,
            seed: offending,
        }]);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("rejects a text-preserving transform whose turn map misstates provenance", () => {
        const scenario = validScenario();
        const liar: Transform = {
            id: "liar-map",
            version: 1,
            alwaysApplicable: true,
            preservesTurnText: true,
            apply(base) {
                const turns = [...base.transcript.turns];
                const order = turns.map((_, index) => index);
                [order[0], order[1]] = [order[1]!, order[0]!];
                return {
                    applicable: true,
                    scenario: parseScenario({
                        ...base,
                        id: `${base.id}-d-liar-map-v1-s0`,
                        transcript: {
                            ...base.transcript,
                            turns: order.map((index) => ({ ...turns[index]! })),
                        },
                    }),
                    turnMap: turns.map((_, index) => index),
                };
            },
        };
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [liar],
            seeds: [0],
        });

        expect(report.entries).toEqual([
            expect.objectContaining({
                kind: "lint-red",
                diagnostics: expect.arrayContaining([
                    expect.stringContaining("turn map does not match the transcript"),
                ]),
            }),
        ]);
    });

    test("rejects a transform that mutates authored fields outside the transcript", () => {
        const scenario = validScenario();
        const probeDrift: Transform = {
            id: "probe-drift",
            version: 1,
            alwaysApplicable: true,
            preservesTurnText: true,
            apply(base) {
                return {
                    applicable: true,
                    scenario: parseScenario({
                        ...base,
                        id: `${base.id}-d-probe-drift-v1-s0`,
                        probes: base.probes.map((probe, index) =>
                            index === 0 ? { ...probe, question: `${probe.question} (drifted)` } : probe,
                        ),
                    }),
                    turnMap: base.transcript.turns.map((_, index) => index),
                };
            },
        };
        const report = runDeterministicMetamorphicEval([scenario], {
            transforms: [probeDrift],
            seeds: [0],
        });

        expect(report.entries).toEqual([
            expect.objectContaining({
                kind: "lint-red",
                diagnostics: expect.arrayContaining([
                    expect.stringContaining("authored fields outside the transcript"),
                ]),
            }),
        ]);
    });

    test("fails coverage when every transform is inapplicable", () => {
        const never: Transform = {
            id: "never",
            version: 1,
            alwaysApplicable: false,
            preservesTurnText: true,
            apply: () => ({ applicable: false, reason: "fixture has no target" }),
        };
        const report = runDeterministicMetamorphicEval([validScenario()], {
            transforms: [never],
            seeds: [0],
        });

        expect(report.coverage[0]).toEqual(expect.objectContaining({
            applied: 0,
            inapplicable: [expect.objectContaining({ transformId: "never" })],
            violations: ["no transforms applied"],
        }));
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("records scorer exceptions as errors, not empty reads", () => {
        const report = runDeterministicMetamorphicEval([validScenario()], {
            transforms: [reorder()],
            scoreOutput(rawOutput, scenario, options) {
                if (scenario.id.includes("-d-")) throw new Error("injected scorer failure");
                return scoreRawOutputWithInjectedClaims(rawOutput, scenario, options);
            },
        });

        expect(report.entries[0]).toEqual(expect.objectContaining({
            kind: "error",
            error: "injected scorer failure",
        }));
        expect(report.injectionCanaryHits).toEqual([]);
        expect(metamorphicExitCode(report)).toBe(1);
    });
});

describe("live metamorphic runner", () => {
    test("fails injection equality when an unscored claim changes", () => {
        const verdict = compareLivePair(
            liveObservation([injectedClaim("keep the cache local")]),
            liveObservation([injectedClaim("keep the cache local"), injectedClaim("use redis")]),
        )[0];

        expect(verdict).toEqual(expect.objectContaining({
            invariant: "injection-set-equality",
            holds: false,
            changes: [expect.objectContaining({ direction: "added-in-derivative" })],
        }));
    });

    test("marks every progress report incomplete", async () => {
        const progress: ReturnType<typeof runDeterministicMetamorphicEval>[] = [];
        const observation = liveObservation([]);
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: {
                kind: "live",
                apiKey: "test",
                historianModel: "test/historian",
                probeModel: { providerID: "test", modelID: "probe" },
            },
            artifactRoot: "/tmp/metamorphic-live-test",
            opencodeVersion: "test",
            transforms: [reorder()],
            seeds: [0],
            admit: () => [],
            execute: async () => observation,
            onProgress: (partial) => progress.push(partial),
        });

        expect(progress.length).toBeGreaterThan(0);
        expect(progress[0]?.tierInvalidReason?.kind).toBe("incomplete");
        expect(progress.every((partial) => metamorphicExitCode(partial) === 1)).toBe(true);
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("rejects live outputs that overlap the scenario corpus", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-paths-"));
        try {
            const corpus = join(root, "corpus");
            mkdirSync(corpus);
            expect(() => prepareLiveOutputPaths(join(corpus, "report.json"), corpus)).toThrow(
                "must not overlap the scenario corpus",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("clears stale regular reports before live admission", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-stale-"));
        try {
            const corpus = join(root, "corpus");
            const report = join(root, "output", "report.json");
            mkdirSync(corpus);
            mkdirSync(join(root, "output"));
            writeFileSync(report, "stale");
            writeFileSync(partialReportPath(report), "stale partial");

            prepareLiveOutputPaths(report, corpus);

            expect(existsSync(report)).toBe(false);
            expect(existsSync(partialReportPath(report))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("does not remove an unowned partial directory", async () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-partial-"));
        try {
            const reportPath = join(root, "report.json");
            const partialPath = partialReportPath(reportPath);
            mkdirSync(partialPath);
            const never: Transform = {
                id: "never",
                version: 1,
                alwaysApplicable: false,
                preservesTurnText: false,
                apply: () => ({ applicable: false, reason: "fixture" }),
            };

            await runLiveAndWriteReport(reportPath, [validScenario()], {
                mode: {
                    kind: "live",
                    apiKey: "test",
                    historianModel: "test/historian",
                    probeModel: { providerID: "test", modelID: "probe" },
                },
                artifactRoot: join(root, "artifacts"),
                opencodeVersion: "test",
                transforms: [never],
                seeds: [0],
            });

            expect(existsSync(partialPath)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("rejects a corpus reached through a symlinked output path", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-symlink-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            const alias = join(root, "corpus-alias");
            symlinkSync(corpusDirectory, alias);

            expect(() => prepareLiveOutputPaths(join(alias, "scenario.json"), corpusDirectory)).toThrow(
                "must not overlap the scenario corpus",
            );
            expect(() => prepareLiveOutputPaths(join(corpusDirectory, "scenario.json"), alias)).toThrow(
                "must not overlap the scenario corpus",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("rejects report, staging, and partial paths that are not regular files", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-shape-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            const occupied = join(root, "as-directory", "report.json");
            mkdirSync(occupied, { recursive: true });
            expect(() => prepareLiveOutputPaths(occupied, corpusDirectory)).toThrow(
                "is not a regular file",
            );

            const staged = join(root, "as-staging", "report.json");
            mkdirSync(join(root, "as-staging"));
            mkdirSync(stagingReportPath(staged));
            expect(() => prepareLiveOutputPaths(staged, corpusDirectory)).toThrow("is not a regular file");

            const linked = join(root, "as-symlink", "report.json");
            mkdirSync(join(root, "as-symlink"));
            symlinkSync(join(root, "elsewhere.json"), stagingReportPath(linked));
            expect(() => prepareLiveOutputPaths(linked, corpusDirectory)).toThrow("is a symlink");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("rejects a report destination inside the artifact namespace", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-namespace-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            expect(() =>
                prepareLiveOutputPaths(join(root, "metamorphic-eval-artifacts"), corpusDirectory),
            ).toThrow("must stay outside the artifact namespace");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("validates deterministic report destinations against the corpus", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-deterministic-paths-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            expect(() =>
                prepareDeterministicOutputPaths(join(corpusDirectory, "report.json"), corpusDirectory),
            ).toThrow("must not overlap the scenario corpus");

            const report = join(root, "output", "report.json");
            mkdirSync(join(root, "output"));
            writeFileSync(report, "stale");
            prepareDeterministicOutputPaths(report, corpusDirectory);
            expect(existsSync(report)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("never writes a report through a symlinked staging path", async () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-staging-"));
        try {
            const reportPath = join(root, "report.json");
            const victim = join(root, "victim.json");
            writeFileSync(victim, "protected");
            symlinkSync(victim, stagingReportPath(reportPath));
            const never: Transform = {
                id: "never",
                version: 1,
                alwaysApplicable: false,
                preservesTurnText: false,
                apply: () => ({ applicable: false, reason: "fixture" }),
            };

            await runLiveAndWriteReport(reportPath, [validScenario()], {
                mode: liveMode(),
                artifactRoot: join(root, "artifacts"),
                opencodeVersion: "test",
                transforms: [never],
                seeds: [0],
            });

            expect(readFileSync(victim, "utf8")).toBe("protected");
            expect(lstatSync(reportPath).isFile()).toBe(true);
            expect(JSON.parse(readFileSync(reportPath, "utf8")).schema).toBe("metamorphic-eval-report/v2");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("live metamorphic control tier", () => {
    async function runWithExecutor(
        execute: (role: LiveRole) => LiveObservation,
        overrides: Partial<LiveMetamorphicOptions> = {},
    ): Promise<{ report: MetamorphicReport; roles: LiveRole[] }> {
        const roles: LiveRole[] = [];
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: liveMode(),
            artifactRoot: "/tmp/metamorphic-control-tier",
            opencodeVersion: "test",
            transforms: [reorder()],
            seeds: [0],
            admit: () => [],
            execute: async (_scenario, role) => {
                roles.push(role);
                return execute(role);
            },
            ...overrides,
        });
        return { report, roles };
    }

    test("treats two ERROR controls as tier-invalid instead of agreement", async () => {
        const { report, roles } = await runWithExecutor(() =>
            pairedObservation([], {
                verdict: "ERROR",
                errorReason: "historian-transport",
                errorDetail: "provider unreachable",
                precision: null,
                recall: null,
            }),
        );

        expect(report.tierInvalidReason?.kind).toBe("control-error");
        expect(roles).toEqual(["control-a", "control-b"]);
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("publishes a control-a canary hit through the progress callback", async () => {
        const progress: MetamorphicReport[] = [];
        const { report } = await runWithExecutor(
            () => pairedObservation([injectedClaim(INJECTION_CANARY)]),
            { onProgress: (partial) => progress.push(partial) },
        );

        expect(report.injectionCanaryHits).toHaveLength(1);
        expect(progress.at(-1)?.injectionCanaryHits).toEqual(report.injectionCanaryHits);
        expect(metamorphicExitCode(report)).toBe(2);
    });

    test("leaves transform coordinates off a baseline canary hit", async () => {
        const { report } = await runWithExecutor((role) =>
            role === "baseline"
                ? pairedObservation([injectedClaim(INJECTION_CANARY)])
                : pairedObservation(),
        );

        expect(report.injectionCanaryHits).toEqual([
            {
                scenarioId: validScenario().id,
                role: "baseline",
                transformId: null,
                transformVersion: null,
                seed: null,
            },
        ]);
    });

    test("runs one baseline per scenario across transforms", async () => {
        const roles: LiveRole[] = [];
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: liveMode(),
            artifactRoot: "/tmp/metamorphic-baseline-reuse",
            opencodeVersion: "test",
            transforms: [...TRANSFORMS],
            seeds: [0],
            admit: () => [],
            execute: async (_scenario, role) => {
                roles.push(role);
                return pairedObservation();
            },
        });

        const derivatives = roles.filter((role) => role === "derivative").length;
        expect(derivatives).toBeGreaterThan(1);
        expect(roles.filter((role) => role === "baseline")).toHaveLength(1);
        expect(report.entries.filter((entry) => entry.kind === "scored")).toHaveLength(derivatives + 1);
    });

    test("carries the precomputed system tuple into partial reports", async () => {
        const progress: MetamorphicReport[] = [];
        const system = systemTuple();
        const { report } = await runWithExecutor(() => pairedObservation(), {
            system,
            onProgress: (partial) => progress.push(partial),
        });

        expect(progress.length).toBeGreaterThan(0);
        expect(progress[0]?.system).toEqual(system);
        expect(report.system).toEqual(system);
    });

    test("publishes the deadline outcome and next role through the progress callback", async () => {
        const progress: MetamorphicReport[] = [];
        let clock = 0;
        const { report } = await runWithExecutor(() => pairedObservation(), {
            deadlineAtMs: 10,
            nowMs: () => (clock += 6),
            onProgress: (partial) => progress.push(partial),
        });

        expect(report.tierInvalidReason).toEqual({ kind: "deadline-exhausted", nextRole: "control-b" });
        expect(progress.at(-1)?.tierInvalidReason).toEqual(report.tierInvalidReason);
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("rejects report destinations that reserve another run's auxiliary names", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-reserved-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            // `foo.json` derives and unlinks both of these, so accepting either as a
            // canonical destination lets one invocation delete another's report.
            for (const reserved of ["foo.partial.json", "foo.json.tmp"]) {
                expect(() => prepareLiveOutputPaths(join(root, reserved), corpusDirectory)).toThrow(
                    "a name this runner derives and deletes",
                );
                expect(() => prepareDeterministicOutputPaths(join(root, reserved), corpusDirectory)).toThrow(
                    "a name this runner derives and deletes",
                );
            }
            expect(() => prepareLiveOutputPaths(join(root, "foo.json"), corpusDirectory)).not.toThrow();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("rejects outputs that resolve onto a symlinked corpus scenario", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-corpus-link-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            const outsideTarget = join(root, "shared", "scenario.json");
            mkdirSync(join(root, "shared"));
            writeFileSync(outsideTarget, "{}");
            symlinkSync(outsideTarget, join(corpusDirectory, "linked.json"));

            expect(() => prepareLiveOutputPaths(outsideTarget, corpusDirectory)).toThrow(
                "must not resolve onto a scenario file",
            );
            expect(() => prepareDeterministicOutputPaths(outsideTarget, corpusDirectory)).toThrow(
                "must not resolve onto a scenario file",
            );
            expect(readFileSync(outsideTarget, "utf8")).toBe("{}");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("accepts a live rerun once the artifact namespace exists", () => {
        const root = mkdtempSync(join(tmpdir(), "metamorphic-rerun-"));
        try {
            const corpusDirectory = join(root, "corpus");
            mkdirSync(corpusDirectory);
            const report = join(root, "out", "report.json");
            mkdirSync(join(root, "out"));

            const first = prepareLiveOutputPaths(report, corpusDirectory);
            /** A control run creates `first.artifactNamespace`; later runs must tolerate it. */
            mkdirSync(first.artifactNamespace);
            expect(() => prepareLiveOutputPaths(report, corpusDirectory)).not.toThrow();
            expect(() => prepareLiveOutputPaths(join(root, "out", "sibling.json"), corpusDirectory)).not.toThrow();

            mkdirSync(join(root, "out2"));
            writeFileSync(join(root, "out2", "metamorphic-eval-artifacts"), "not a directory");
            expect(() => prepareLiveOutputPaths(join(root, "out2", "report.json"), corpusDirectory)).toThrow(
                "artifact namespace exists and is not a directory",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("derives distinct partials for extensionless and JSON reports", () => {
        expect(partialReportPath("/x/foo")).not.toBe(partialReportPath("/x/foo.json"));
        expect(partialReportPath("/x/foo.json")).toBe("/x/foo.json.partial.json");
        expect(stagingReportPath("/x/foo")).not.toBe(stagingReportPath("/x/foo.json"));
    });

    test("counts only admitted derivatives as applied coverage", async () => {
        /** An identity derivative lints red on its fingerprint, which is the `rejected` branch that must not count as applied. */
        const identity: Transform = {
            id: "identity-fixture",
            version: 1,
            alwaysApplicable: true,
            preservesTurnText: true,
            apply: (scenario) => ({
                applicable: true,
                scenario,
                turnMap: scenario.transcript.turns.map((_, index) => index),
            }),
        };
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: liveMode(),
            artifactRoot: "/tmp/metamorphic-applied-coverage",
            opencodeVersion: "test",
            transforms: [identity],
            seeds: [0],
            execute: async () => pairedObservation(),
        });

        expect(report.entries).toHaveLength(1);
        expect(report.entries[0]?.kind).toBe("lint-red");
        expect(report.coverage[0]?.applied).toBe(0);
        expect(report.coverage[0]?.violations).toContain("no transforms applied");
    });

    test("publishes the completed report so the surviving partial is not marked incomplete", async () => {
        const progress: MetamorphicReport[] = [];
        const { report } = await runWithExecutor(() => pairedObservation(), {
            onProgress: (partial) => progress.push(partial),
        });

        expect(metamorphicExitCode(report)).toBe(0);
        expect(progress.at(-1)?.tierInvalidReason).toBeNull();
        expect(progress.at(-1)).toEqual(report);
        expect(progress.slice(0, -1).every((partial) => partial.tierInvalidReason !== null)).toBe(true);
    });

    test("skips paid derivatives after a baseline scores ERROR", async () => {
        const roles: LiveRole[] = [];
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: liveMode(),
            artifactRoot: "/tmp/metamorphic-error-baseline",
            opencodeVersion: "test",
            transforms: [...TRANSFORMS],
            seeds: [0],
            admit: () => [],
            execute: async (_scenario, role) => {
                roles.push(role);
                return role === "baseline"
                    ? pairedObservation([], { verdict: "ERROR", errorReason: "historian-transport" })
                    : pairedObservation();
            },
        });

        // An ERROR baseline already forces exit 1, so every derivative would be
        // paid for and unusable.
        expect(roles).toEqual(["control-a", "control-b", "baseline"]);
        expect(roles).not.toContain("derivative");
        expect(report.entries.filter((entry) => entry.kind === "error").length).toBeGreaterThan(0);
        expect(metamorphicExitCode(report)).toBe(1);
    });

    test("reserves a role budget before starting paid work", async () => {
        const roles: LiveRole[] = [];
        let clock = 0;
        const report = await runLiveMetamorphicEval([validScenario()], {
            mode: liveMode(),
            artifactRoot: "/tmp/metamorphic-role-budget",
            opencodeVersion: "test",
            transforms: [reorder()],
            seeds: [0],
            admit: () => [],
            // Deadline has not passed, but one role cannot finish inside what is left.
            deadlineAtMs: 100,
            roleBudgetMs: 60,
            nowMs: () => (clock += 50),
            execute: async (_scenario, role) => {
                roles.push(role);
                return pairedObservation();
            },
        });

        expect(roles).toEqual([]);
        expect(report.tierInvalidReason).toEqual({ kind: "deadline-exhausted", nextRole: "control-a" });
    });

    test("budgets every declared historian run in a role", () => {
        const mode = liveMode();
        const scenario = validScenario();
        const oneRun = { ...scenario, trigger: { ...scenario.trigger, expectedHistorianRuns: 1 } };
        const twoRuns = { ...scenario, trigger: { ...scenario.trigger, expectedHistorianRuns: 2 } };

        // Marginal, not proportional: one more declared run adds its two trigger
        // prompts plus one completion wait. The transcript and probe prompts are
        // per-role costs that do not scale with the run count, so the budget is
        // deliberately not a multiple of it.
        expect(liveRoleBudgetMs([twoRuns], mode) - liveRoleBudgetMs([oneRun], mode)).toBe(
            TRIGGER_TURNS_PER_HISTORIAN_RUN * DEFAULT_PROMPT_TIMEOUT_MS + historianWaitBudgetMs(mode),
        );
        expect(liveRoleBudgetMs([oneRun, twoRuns], mode)).toBe(liveRoleBudgetMs([twoRuns], mode));
        expect(liveRoleBudgetMs(corpus(), mode)).toBeGreaterThan(liveRoleBudgetMs([oneRun], mode));
    });

    test("budgets every prompt the role sends, not only the historian runs", () => {
        // Reserving only the declared runs admitted a role that then spent the whole
        // transcript, trigger, and probe prompt sequence beyond the reserve. Each of
        // those prompts carries only the harness default timeout, and they were
        // missed one class at a time — transcript turns, then probe re-asks, then
        // per-run triggers — so the budget is now derived from the prompt COUNT
        // rather than a hand-listed set of phases.
        const mode = liveMode();
        const scenario = validScenario();
        const runsOnly = scenario.trigger.expectedHistorianRuns * historianWaitBudgetMs(mode);

        expect(liveRoleBudgetMs([scenario], mode)).toBe(
            liveRolePromptCount(scenario) * DEFAULT_PROMPT_TIMEOUT_MS
                + (scenario.trigger.expectedHistorianRuns + 1) * historianWaitBudgetMs(mode),
        );
        expect(liveRoleBudgetMs([scenario], mode)).toBeGreaterThan(runsOnly);

        // The count covers all three prompt classes, so each one moves the budget.
        const transcript = fillerTurnCountFor(scenario)
            + scenario.transcript.turns.length
            + paddingTurnCountFor(scenario);
        expect(transcript).toBeGreaterThan(0);
        expect(liveRolePromptCount(scenario)).toBe(
            transcript
                + scenario.trigger.expectedHistorianRuns * TRIGGER_TURNS_PER_HISTORIAN_RUN
                + scenario.probes.length * MAX_PROBE_ATTEMPTS,
        );

        // Every probe may be asked twice, so probe count moves the budget.
        const doubled = { ...scenario, probes: [...scenario.probes, ...scenario.probes] };
        expect(liveRoleBudgetMs([doubled], mode) - liveRoleBudgetMs([scenario], mode)).toBe(
            scenario.probes.length * MAX_PROBE_ATTEMPTS * DEFAULT_PROMPT_TIMEOUT_MS,
        );
    });

    test("reports a thrown control failure as a control error, not an incomplete run", async () => {
        for (const failing of ["control-a", "control-b"] as const) {
            const { report } = await runWithExecutor((role) => {
                if (role === failing) throw new Error(`${failing} artifact setup failed`);
                return pairedObservation();
            });

            expect(report.tierInvalidReason).toEqual({
                kind: "control-error",
                controlAErrorReason: failing === "control-a" ? "control-a artifact setup failed" : null,
                controlBErrorReason: failing === "control-b" ? "control-b artifact setup failed" : null,
            });
        }
    });
});
