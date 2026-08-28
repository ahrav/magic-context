/**
 * The dev corpus is the artifact promotion actually freezes, but nothing loaded
 * it: every other test in this lane builds scenarios from `validScenarioRaw`.
 * Contract rules therefore tightened without the corpus being re-checked, and
 * two files drifted out of compliance while the suite stayed green. This test
 * closes that gap by driving the real gates — parse, freeze lint, release
 * tuple, and the recomputed mutation battery — over the files on disk.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReleaseTuple, lintScenario, parseScenario, type HistorianEvalScenario } from "./contract";
import { runMutationBattery } from "./mutations";
import { CORPUS_SIZE_BUDGET } from "./promote";

const CORPUS_DIR = join(import.meta.dir, "../../historian-eval/dev");

function corpusFiles(): string[] {
    return readdirSync(CORPUS_DIR)
        .filter((entry) => entry.endsWith(".json"))
        .sort();
}

function parseCorpus(): HistorianEvalScenario[] {
    return corpusFiles().map((file) =>
        parseScenario(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")), file),
    );
}

describe("dev corpus", () => {
    test("positive-claim mutations cover every expected claim, not just the first", () => {
        const multi = parseCorpus().filter((scenario) => scenario.gold.expectedClaims.length > 1);
        // Most of the corpus declares several expected claims, so mutating only
        // index 0 left the rest unexercised: a scorer regression that stopped
        // enforcing the second or third claim would still trip on the first and
        // the evidence would stay green.
        expect(multi.length).toBeGreaterThan(0);
        const artifact = runMutationBattery(multi);
        expect(artifact.green).toBe(true);
        const perClaimClasses = ["wrong-category", "dropped-gold-fact", "near-miss-perturbation"];
        for (const [index, entry] of artifact.scenarios.entries()) {
            const claimCount = multi[index].gold.expectedClaims.length;
            for (const mutationClass of perClaimClasses) {
                const result = entry.results.find((candidate) => candidate.mutationClass === mutationClass);
                expect(result).toBeDefined();
                // The detail records how many claims were actually mutated, so a
                // regression to first-claim-only is visible in the evidence.
                expect(result!.detail).toContain(`all ${claimCount} expected claim(s)`);
            }
        }
    });


    test("scenarios declaring several hard negatives in one family have every one mutated", () => {
        const multi = parseCorpus().filter((scenario) => {
            const perFamily = new Map<string, number>();
            for (const absent of scenario.gold.expectedAbsent) {
                perFamily.set(absent.family, (perFamily.get(absent.family) ?? 0) + 1);
            }
            return [...perFamily.values()].some((count) => count > 1);
        });
        // Same family implies the same battery class, so these are exactly the
        // scenarios where mutating only the first predicate left a
        // false-authoritative check in the release that nothing demonstrated.
        expect(multi.length).toBeGreaterThan(0);
        const artifact = runMutationBattery(multi);
        expect(artifact.green).toBe(true);
        for (const entry of artifact.scenarios) {
            const applied = entry.results.filter(
                (result) =>
                    (result.mutationClass === "speculation-promoted" ||
                        result.mutationClass === "rejected-proposal-active") &&
                    result.applicable,
            );
            expect(applied.length).toBeGreaterThan(0);
            // The detail carries the number actually mutated, so a regression to
            // first-predicate-only surfaces here instead of passing silently.
            expect(
                applied.some((result) => /^all ([2-9]|\d{2,}) expected-absent target/.test(result.detail)),
            ).toBe(true);
        }
    });


    test("every scenario parses under the current contract", () => {
        // Reported per file: a bare throw names only the first offender, and a
        // contract change usually breaks several at once.
        const failures = corpusFiles().flatMap((file) => {
            try {
                parseScenario(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")), file);
                return [];
            } catch (error) {
                return [`${file}: ${(error as Error).message}`];
            }
        });
        expect(failures).toEqual([]);
    });

    test("every scenario is freeze-lint clean", () => {
        const diagnostics = parseCorpus().flatMap((scenario) => lintScenario(scenario));
        expect(diagnostics).toEqual([]);
    });

    test("filenames match scenario ids, as a release directory requires", () => {
        const mismatches = corpusFiles().filter((file) => {
            const scenario = parseScenario(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")), file);
            return file !== `${scenario.id}.json`;
        });
        expect(mismatches).toEqual([]);
    });

    test("the corpus builds a release tuple and sits inside the size budget", () => {
        const scenarios = parseCorpus();
        expect(scenarios.length).toBeGreaterThanOrEqual(CORPUS_SIZE_BUDGET.min);
        expect(scenarios.length).toBeLessThanOrEqual(CORPUS_SIZE_BUDGET.max);
        // Also proves ids and semantic fingerprints are unique: a scenario
        // copied under a new name would double-weight one evaluation.
        expect(() => buildReleaseTuple(scenarios)).not.toThrow();
    });

    test("the recomputed mutation battery is green for every scenario", () => {
        const artifact = runMutationBattery(parseCorpus());
        // Promotion recomputes this and refuses anything not green, so a red
        // entry here means the corpus cannot be frozen at all.
        const red = artifact.scenarios
            .filter((entry) => !entry.green)
            .map((entry) => `${entry.scenarioId}: ${entry.results.filter((r) => !r.green).map((r) => `${r.mutationClass} (${r.detail})`).join("; ")}`);
        expect(red).toEqual([]);
        expect(artifact.green).toBe(true);
    });
});
