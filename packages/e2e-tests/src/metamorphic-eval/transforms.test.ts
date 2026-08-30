import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import { estimateTokens } from "../../../plugin/src/shared/token-estimator";
import {
    lintScenario,
    normalizeContent,
    parseScenario,
    scenarioFingerprint,
    type HistorianEvalScenario,
} from "../historian-eval/contract";
import { validScenario, validScenarioRaw } from "../historian-eval/test-support";
import {
    ALWAYS_APPLICABLE_TRANSFORM_IDS,
    TRANSFORMS,
    remapGold,
    type Transform,
} from "./transforms";

const CORPUS_DIR = join(import.meta.dir, "../../historian-eval/dev");

function corpus(): HistorianEvalScenario[] {
    return readdirSync(CORPUS_DIR)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => parseScenario(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")), file));
}

function firstApplicable(transform: Transform, scenario: HistorianEvalScenario) {
    for (let seed = 0; seed < 100; seed += 1) {
        const result = transform.apply(scenario, seed);
        if (result.applicable) return result;
    }
    return undefined;
}

describe("metamorphic transforms", () => {
    test("pins the shared splitmix32 sequence", () => {
        const next = splitmix32(20_260_830);
        expect(Array.from({ length: 5 }, () => next())).toEqual([
            0.886998507194221,
            0.13460429338738322,
            0.6842124257236719,
            0.7048644621390849,
            0.43559385486878455,
        ]);
    });

    test("registers five table-driven transforms", () => {
        expect(TRANSFORMS.map((transform) => transform.id)).toEqual([
            "paraphrase-irrelevant",
            "reorder-independent-turns",
            "move-accepted-decision",
            "duplicate-rejected-proposal",
            "rename-unrelated-symbols",
        ]);
    });

    test("each applicable transform produces a parsed lint-clean derivative", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string }> }).turns;
        turns[3].user = "Close the aux_worker.ts notes.";
        const scenario = parseScenario(raw);
        for (const transform of TRANSFORMS) {
            const result = firstApplicable(transform, scenario);
            expect(result, transform.id).toBeDefined();
            expect(() => parseScenario(result!.scenario)).not.toThrow();
            expect(lintScenario(result!.scenario), transform.id).toEqual([]);
            expect(scenarioFingerprint(result!.scenario)).not.toBe(scenarioFingerprint(scenario));
            expect(result!.scenario.id).toMatch(
                new RegExp(`^${scenario.id}-d-${transform.id}-v${transform.version}-s\\d+$`),
            );
        }
    });

    test("reorder preserves turns and remaps gold to their new positions", () => {
        const scenario = validScenario();
        const transform = TRANSFORMS.find((candidate) => candidate.id === "reorder-independent-turns")!;
        const result = firstApplicable(transform, scenario)!;
        expect(result.scenario.transcript.turns).not.toEqual(scenario.transcript.turns);
        expect([...result.scenario.transcript.turns].sort((a, b) => a.user.localeCompare(b.user))).toEqual(
            [...scenario.transcript.turns].sort((a, b) => a.user.localeCompare(b.user)),
        );
        for (const [index, claim] of scenario.gold.expectedClaims.entries()) {
            const mapped = result.turnMap.slice(claim.sourceTurnRange[0], claim.sourceTurnRange[1] + 1);
            expect(result.scenario.gold.expectedClaims[index].sourceTurnRange).toEqual([
                Math.min(...mapped),
                Math.max(...mapped),
            ]);
        }
    });

    test("paraphrase and rename change only eligible message text", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string }> }).turns;
        turns[3].user = "Close the aux_worker.ts notes.";
        const scenario = parseScenario(raw);
        for (const id of ["paraphrase-irrelevant", "rename-unrelated-symbols"]) {
            const transform = TRANSFORMS.find((candidate) => candidate.id === id)!;
            const result = firstApplicable(transform, scenario)!;
            const changed = result.scenario.transcript.turns.flatMap((turn, index) =>
                (["user", "assistant"] as const).filter(
                    (role) => turn[role] !== scenario.transcript.turns[index][role],
                ),
            );
            expect(changed, id).toHaveLength(1);
            for (const claim of scenario.gold.expectedClaims) {
                for (let index = claim.sourceTurnRange[0]; index <= claim.sourceTurnRange[1]; index += 1) {
                    expect(result.scenario.transcript.turns[index], `${id}/${claim.id}`).toEqual(
                        scenario.transcript.turns[index],
                    );
                }
            }
        }
    });

    test("move relocates an accepted decision and keeps its gold attached", () => {
        const scenario = validScenario();
        const transform = TRANSFORMS.find((candidate) => candidate.id === "move-accepted-decision")!;
        const result = firstApplicable(transform, scenario)!;
        const movedClaim = scenario.gold.expectedClaims.find((claim, index) =>
            result.scenario.gold.expectedClaims[index].sourceTurnRange[0] !== claim.sourceTurnRange[0],
        )!;
        const derivativeClaim = result.scenario.gold.expectedClaims.find(
            (claim) => claim.id === movedClaim.id,
        )!;
        expect(derivativeClaim.sourceTurnRange[0]).toBeGreaterThan(movedClaim.sourceTurnRange[0]);
        expect(derivativeClaim.sourceTurnRange[1]).toBeLessThan(
            result.scenario.transcript.epilogueStartIndex,
        );
        expect(lintScenario(result.scenario)).toEqual([]);
    });

    test("duplicate inserts one rejected proposal and shifts original turn bindings", () => {
        const scenario = validScenario();
        const transform = TRANSFORMS.find((candidate) => candidate.id === "duplicate-rejected-proposal")!;
        const result = firstApplicable(transform, scenario)!;
        expect(result.scenario.transcript.turns).toHaveLength(scenario.transcript.turns.length + 1);
        const proposal = scenario.transcript.turns[0];
        expect(result.scenario.transcript.turns.filter((turn) => turn.user === proposal.user)).toHaveLength(2);
        expect(result.scenario.transcript.epilogueStartIndex).toBe(
            scenario.transcript.epilogueStartIndex + 1,
        );
        expect(result.scenario.gold.expectedClaims.find((claim) => claim.id === "exp-lru-cache")!.sourceTurnRange).toEqual([2, 2]);
    });

    test("move refuses a decision whose only later position is inside the epilogue", () => {
        const raw = validScenarioRaw();
        const gold = raw.gold as { expectedClaims: Array<{ id: string }> };
        gold.expectedClaims = gold.expectedClaims.filter((claim) => claim.id === "exp-cache-capacity");
        raw.probes = (raw.probes as Array<{ sourceClaimRef?: string; expectedClaimRef?: string }>).filter(
            (probe) =>
                probe.sourceClaimRef === "exp-cache-capacity" ||
                probe.expectedClaimRef === "exp-cache-capacity",
        );
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "move-accepted-decision")!;
        expect(transform.apply(scenario, 7)).toEqual({
            applicable: false,
            reason: "no movable single-turn accepted decision before epilogue",
        });
    });

    test("duplicate rejected proposal records inapplicability when none exists", () => {
        const raw = validScenarioRaw();
        raw.families = ["explored-never-accepted"];
        const absent = (raw.gold as { expectedAbsent: Array<Record<string, unknown>> }).expectedAbsent[0];
        absent.family = "explored-never-accepted";
        const scenario = parseScenario(raw);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "duplicate-rejected-proposal")!;
        expect(transform.apply(scenario, 7)).toEqual({
            applicable: false,
            reason: "no rejected proposal turn",
        });
    });

    test("same input is byte-identical while different seeds select different rewrites", () => {
        const transform = TRANSFORMS.find((candidate) => candidate.id === "paraphrase-irrelevant")!;
        const scenario = validScenario();
        const first = transform.apply(scenario, 1);
        const repeated = transform.apply(scenario, 1);
        expect(JSON.stringify(first)).toBe(JSON.stringify(repeated));
        const variants = new Set(
            Array.from({ length: 12 }, (_, seed) => JSON.stringify(transform.apply(scenario, seed))),
        );
        expect(variants.size).toBeGreaterThan(1);
    });

    test("identity remap is unchanged and a wrong map is caught by lint", () => {
        const scenario = validScenario();
        const identity = scenario.transcript.turns.map((_, index) => index);
        expect(remapGold(scenario.gold, identity)).toEqual(scenario.gold);
        const broken = parseScenario({
            ...scenario,
            gold: remapGold(scenario.gold, [0, 2, 1, 3]),
        });
        expect(lintScenario(broken)).toEqual(
            expect.arrayContaining([expect.stringContaining("predicate-not-authored")]),
        );
    });

    test("remap rejects a non-contiguous mapped source range", () => {
        const scenario = validScenario();
        scenario.gold.expectedClaims[0]!.sourceTurnRange = [0, 1];
        expect(() => remapGold(scenario.gold, [0, 2, 1, 3])).toThrow(/non-contiguous/);
    });

    test("reorder does not invert a rejected proposal and its accepted decision", () => {
        const scenario = corpus().find((candidate) => candidate.id === "hse-proto-cache-decision")!;
        const transform = TRANSFORMS.find((candidate) => candidate.id === "reorder-independent-turns")!;
        const result = transform.apply(scenario, 0);
        if (!result.applicable) throw new Error("safe alternate reorder must apply");

        expect(result.turnMap[0]).toBeLessThan(result.turnMap[1]!);
    });

    test("duplicate rejection is inapplicable when insertion would split a gold range", () => {
        const scenario = corpus().find((candidate) => candidate.id === "hse-test-runner-rejected")!;
        const transform = TRANSFORMS.find((candidate) => candidate.id === "duplicate-rejected-proposal")!;

        expect(transform.apply(scenario, 0)).toEqual({
            applicable: false,
            reason: "no rejected proposal insertion preserves contiguous gold ranges",
        });
    });

    test("whole corpus has anti-vacuous coverage and lint-clean derivatives", () => {
        for (const scenario of corpus()) {
            let applied = 0;
            for (const transform of TRANSFORMS) {
                const result = transform.apply(scenario, 20_260_830);
                if (!result.applicable) {
                    expect(ALWAYS_APPLICABLE_TRANSFORM_IDS).not.toContain(transform.id);
                    continue;
                }
                applied += 1;
                expect(lintScenario(result.scenario), `${scenario.id}/${transform.id}`).toEqual([]);
            }
            expect(applied, scenario.id).toBeGreaterThan(0);
        }
    });

    test("injection canary text and non-binding claim budget survive every derivative", () => {
        const injection = corpus().find((scenario) => scenario.id === "hse-webhook-docs-injection")!;
        const canary = injection.gold.expectedAbsent.find((entry) => entry.id === "abs-injection-canary")!
            .predicate.value;
        const canaryMessage = injection.transcript.turns.flatMap((turn, turnIndex) =>
            (["user", "assistant"] as const).flatMap((role) =>
                normalizeContent(turn[role]).includes(normalizeContent(canary))
                    ? [{ turnIndex, role }]
                    : [],
            ),
        )[0]!;
        for (const transform of TRANSFORMS) {
            const rewritesContent = ["paraphrase-irrelevant", "rename-unrelated-symbols"].includes(transform.id);
            const source = transform.id === "rename-unrelated-symbols"
                ? parseScenario({
                    ...injection,
                    transcript: {
                        ...injection.transcript,
                        turns: injection.transcript.turns.map((turn, index) =>
                            index === 2 ? { ...turn, user: "Perfect, webhook_setup is done." } : turn,
                        ),
                    },
                })
                : injection;
            const result = transform.apply(source, 20_260_830);
            if (rewritesContent) expect(result.applicable, transform.id).toBe(true);
            if (!result.applicable) continue;
            expect(JSON.stringify(result.scenario.transcript)).toContain(canary);
            if (rewritesContent) {
                expect(
                    result.scenario.transcript.turns[result.turnMap[canaryMessage.turnIndex]][canaryMessage.role],
                ).toBe(
                    source.transcript.turns[canaryMessage.turnIndex][canaryMessage.role],
                );
            }
        }
        for (const scenario of corpus()) {
            const claimText = scenario.gold.expectedClaims
                .map((claim) => `${claim.id}: ${claim.predicate.value}`)
                .join("\n");
            expect(estimateTokens(claimText), scenario.id).toBeLessThan(8_000);
        }
    });
});
