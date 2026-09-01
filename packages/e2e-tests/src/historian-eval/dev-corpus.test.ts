/**
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReleaseTuple, lintScenario, parseScenario, type HistorianEvalScenario } from "./contract";
import { V2_MEMORY_CATEGORIES } from "../../../plugin/src/features/magic-context/memory/constants";
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
    test("a rejection record names the subject it rejects", () => {
        // Each rejected CONSTRAINTS predicate must identify the rejected subject.
        // A generic predicate can satisfy recall without preserving the rejection.
        // A claim-id probe can accept a generic predicate that omits the rejected subject.
        // Without a subject check, a historian can omit the rejection and still pass.
        const words = (value: string): string[] =>
            value
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter((word) => word.length >= 4);
        const records = parseCorpus()
            .filter((scenario) => scenario.families.includes("proposed-but-rejected"))
            .flatMap((scenario) => {
                const subject = new Set(
                    scenario.gold.expectedAbsent.flatMap((absent) => words(absent.predicate.value)),
                );
                return scenario.gold.expectedClaims
                    .filter((claim) => claim.category === "CONSTRAINTS")
                    .map((claim) => ({
                        scenario: scenario.id,
                        claim: claim.id,
                        shared: words(claim.predicate.value).filter((word) => subject.has(word)),
                    }));
            });
        expect(records.length).toBeGreaterThan(0);
        for (const record of records) {
            expect(record.shared.length).toBeGreaterThan(0);
        }
    });

    test("positive-claim mutations cover every expected claim and every wrong category", () => {
        const multi = parseCorpus().filter((scenario) => scenario.gold.expectedClaims.length > 1);
        // Mutating only claim 0 cannot detect regressions in later claims.
        expect(multi.length).toBeGreaterThan(0);
        const artifact = runMutationBattery(multi);
        expect(artifact.green).toBe(true);
        for (const [index, entry] of artifact.scenarios.entries()) {
            const claimCount = multi[index].gold.expectedClaims.length;
            for (const mutationClass of ["dropped-gold-fact", "near-miss-perturbation"]) {
                const result = entry.results.find((candidate) => candidate.mutationClass === mutationClass);
                expect(result).toBeDefined();
                // The detail must report the mutated-variant count so a one-variant regression fails.
                expect(result!.detail).toContain(`all ${claimCount} expected claim(s)`);
            }
            // Every expected-claim/category pairing must be mutated because a scorer can enforce categories selectively.
            const wrongCategory = entry.results.find((candidate) => candidate.mutationClass === "wrong-category");
            expect(wrongCategory).toBeDefined();
            expect(wrongCategory!.detail).toContain(
                `all ${claimCount * (V2_MEMORY_CATEGORIES.length - 1)} category pairing(s)`,
            );
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
        // Mutating only the first predicate cannot validate the remaining predicates.
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
            // The detail must report the mutated-predicate count so a first-predicate-only regression fails.
            expect(
                applied.some((result) => /^all ([2-9]|\d{2,}) expected-absent target/.test(result.detail)),
            ).toBe(true);
        }
    });


    test("every scenario parses under the current contract", () => {
        // One contract violation can affect multiple files, so the report must list every offending file.
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
        // Unique scenario IDs and semantic fingerprints prevent duplicate evaluation weight.
        // A scenario copied under a new name would double-weight one evaluation.
        expect(() => buildReleaseTuple(scenarios)).not.toThrow();
    });

    test("the recomputed mutation battery is green for every scenario", () => {
        const artifact = runMutationBattery(parseCorpus());
        // Promotion rejects a corpus unless its recomputed mutation battery is green.
        const red = artifact.scenarios
            .filter((entry) => !entry.green)
            .map((entry) => `${entry.scenarioId}: ${entry.results.filter((r) => !r.green).map((r) => `${r.mutationClass} (${r.detail})`).join("; ")}`);
        expect(red).toEqual([]);
        expect(artifact.green).toBe(true);
    });
});
