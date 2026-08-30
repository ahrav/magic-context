import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { splitmix32 } from "../../../plugin/scripts/retrieval-benchmark/synthetic";
import { estimateTokens } from "../../../plugin/src/shared/token-estimator";
import {
    authoredEvidenceText,
    containsCompleteValue,
    lintScenario,
    MAX_TURN_TEXT_CHARS,
    normalizeContent,
    normalizedEvidenceMessages,
    parseScenario,
    predicateMatches,
    type HistorianEvalScenario,
} from "../historian-eval/contract";
import { validScenario, validScenarioRaw } from "../historian-eval/test-support";
import {
    ALWAYS_APPLICABLE_TRANSFORM_IDS,
    CONTRACT_VIOLATION_REASON,
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

/** Inserts a background turn so `move-accepted-decision` has a two-position move. */
function movableScenarioRaw(): Record<string, unknown> {
    const raw = validScenarioRaw();
    const transcript = raw.transcript as {
        turns: Array<{ user: string; assistant: string }>;
        epilogueStartIndex: number;
    };
    transcript.turns.splice(3, 0, {
        user: "Unrelated: the standup moved to 9am.",
        assistant: "Noted; standup time recorded informally.",
    });
    transcript.epilogueStartIndex = 4;
    return raw;
}

/**
 * Authors a forbidden formation across the turn-0 assistant / turn-1 user
 * boundary: the freeze lint accepts it because it searches the whole
 * pre-epilogue evidence, and no single turn contains it.
 */
function crossTurnEvidenceRaw(): Record<string, unknown> {
    const raw = validScenarioRaw();
    const transcript = raw.transcript as {
        turns: Array<{ user: string; assistant: string }>;
        epilogueStartIndex: number;
    };
    transcript.turns.unshift(
        { user: "Quick planning note.", assistant: "Noted; we keep the legacy" },
        { user: "bridge alive for now.", assistant: "Understood." },
    );
    transcript.epilogueStartIndex += 2;
    const gold = raw.gold as {
        expectedClaims: Array<{ sourceTurnRange: [number, number] }>;
        expectedAbsent: Array<Record<string, unknown>>;
    };
    for (const claim of gold.expectedClaims) {
        claim.sourceTurnRange = [claim.sourceTurnRange[0] + 2, claim.sourceTurnRange[1] + 2];
    }
    gold.expectedAbsent.push({
        id: "abs-legacy-bridge",
        family: "proposed-but-rejected",
        predicate: { kind: "normalized-substring", value: "legacy bridge" },
    });
    return raw;
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
        const raw = movableScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string }> }).turns;
        turns[4].user = "Close the aux_worker.ts notes.";
        const scenario = parseScenario(raw);
        for (const transform of TRANSFORMS) {
            const result = firstApplicable(transform, scenario);
            expect(result, transform.id).toBeDefined();
            expect(() => parseScenario(result!.scenario)).not.toThrow();
            expect(lintScenario(result!.scenario), transform.id).toEqual([]);
            expect(result!.scenario.transcript).not.toEqual(scenario.transcript);
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
        const scenario = parseScenario(movableScenarioRaw());
        const transform = TRANSFORMS.find((candidate) => candidate.id === "move-accepted-decision")!;
        const result = firstApplicable(transform, scenario)!;
        const movedClaim = scenario.gold.expectedClaims.find((claim, index) =>
            result.scenario.gold.expectedClaims[index].sourceTurnRange[0] !== claim.sourceTurnRange[0],
        )!;
        const derivativeClaim = result.scenario.gold.expectedClaims.find(
            (claim) => claim.id === movedClaim.id,
        )!;
        expect(derivativeClaim.sourceTurnRange[0]).toBeGreaterThan(movedClaim.sourceTurnRange[0] + 1);
        expect(derivativeClaim.sourceTurnRange[1]).toBeLessThan(
            result.scenario.transcript.epilogueStartIndex,
        );
        expect(lintScenario(result.scenario)).toEqual([]);
    });

    test("move refuses when the only relocation is an adjacent swap", () => {
        const scenario = validScenario();
        const transform = TRANSFORMS.find((candidate) => candidate.id === "move-accepted-decision")!;
        expect(transform.apply(scenario, 7)).toEqual({
            applicable: false,
            reason: "no movable single-turn accepted decision before epilogue",
        });
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

    test("role-local rewrites preserve turn-spanning negative evidence", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[3] = { user: "Keep the bridge", assistant: "token aux_worker.ts unchanged." };
        const absent = (raw.gold as { expectedAbsent: Array<{ predicate: { value: string } }> })
            .expectedAbsent[0]!;
        absent.predicate.value = "bridge token";
        const scenario = parseScenario(raw);
        const predicate = scenario.gold.expectedAbsent[0]!.predicate;

        for (const id of ["paraphrase-irrelevant", "rename-unrelated-symbols"]) {
            const transform = TRANSFORMS.find((candidate) => candidate.id === id)!;
            const result = firstApplicable(transform, scenario)!;
            // The invariant is that the formation stays authored, not that the
            // turn is byte-identical: framing text around a message keeps its
            // wording, so a rewrite that leaves the spanning halves adjacent is
            // a legitimate perturbation.
            expect(
                predicateMatches(predicate, authoredEvidenceText(result.scenario.transcript.turns)),
                id,
            ).toBe(true);
        }
        // Renaming edits inside a message, so it cannot touch a message the
        // formation runs through at all.
        const rename = TRANSFORMS.find((candidate) => candidate.id === "rename-unrelated-symbols")!;
        expect(firstApplicable(rename, scenario)!.scenario.transcript.turns[3]).toEqual(
            scenario.transcript.turns[3],
        );
    });

    test("duplicate rejection excludes turns containing accepted evidence", () => {
        const raw = validScenarioRaw();
        const absent = (raw.gold as { expectedAbsent: Array<{ predicate: { value: string } }> })
            .expectedAbsent[0]!;
        absent.predicate.value = "redis rejected for the operational dependency";
        const scenario = parseScenario(raw);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "duplicate-rejected-proposal")!;

        expect(transform.apply(scenario, 0)).toEqual({
            applicable: false,
            reason: "no rejected proposal insertion preserves contiguous gold ranges",
        });
    });

    test("duplicate rejection is inapplicable at the transcript turn limit", () => {
        const raw = validScenarioRaw();
        const transcript = raw.transcript as {
            turns: Array<{ user: string; assistant: string }>;
            epilogueStartIndex: number;
        };
        while (transcript.turns.length < 100) {
            transcript.turns.push({ user: "Background context.", assistant: "Noted." });
        }
        transcript.epilogueStartIndex = 99;
        const scenario = parseScenario(raw);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "duplicate-rejected-proposal")!;

        expect(transform.apply(scenario, 0)).toEqual({
            applicable: false,
            reason: "transcript is already at the turn limit",
        });
    });

    test("every transform preserves negative evidence spanning adjacent turns", () => {
        const scenario = parseScenario(crossTurnEvidenceRaw());
        // The forbidden formation is authored only across the turn-0 assistant
        // and turn-1 user boundary, so neither turn carries it alone.
        expect(lintScenario(scenario)).toEqual([]);
        for (const index of [0, 1]) {
            const turn = scenario.transcript.turns[index]!;
            expect(normalizeContent(`${turn.user} ${turn.assistant}`)).not.toContain("legacy bridge");
        }

        for (const transform of TRANSFORMS) {
            for (let seed = 0; seed < 40; seed += 1) {
                const result = transform.apply(scenario, seed);
                if (!result.applicable) continue;
                expect(lintScenario(result.scenario), `${transform.id}/s${seed}`).toEqual([]);
            }
        }
    });

    test("paraphrase reports inapplicability instead of throwing at the turn text limit", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string }> }).turns;
        turns[3]!.user = `Background: ${"a ".repeat(MAX_TURN_TEXT_CHARS)}`.slice(0, MAX_TURN_TEXT_CHARS);
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "paraphrase-irrelevant")!;

        for (let seed = 0; seed < 30; seed += 1) {
            const result = transform.apply(scenario, seed);
            if (!result.applicable) continue;
            for (const turn of result.scenario.transcript.turns) {
                expect(turn.user.length, `s${seed}`).toBeLessThanOrEqual(MAX_TURN_TEXT_CHARS);
            }
        }
        // The over-limit message is never the rewrite target, so the transform
        // still applies to another eligible message rather than aborting.
        expect(firstApplicable(transform, scenario)).toBeDefined();
    });

    test("rename reports inapplicability when the replacement exceeds the turn text limit", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[0]!.assistant = "We could; that would give us eviction out of the box.";
        turns[3]!.user = `Wrapping up aux.ts. ${"a ".repeat(MAX_TURN_TEXT_CHARS)}`.slice(
            0,
            MAX_TURN_TEXT_CHARS,
        );
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "rename-unrelated-symbols")!;

        expect(transform.apply(scenario, 0)).toEqual({
            applicable: false,
            reason: "rename does not fit the turn text limit",
        });
    });

    test("rewrites never materialize a message the historian would have discarded", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        // Both discard paths: production strips reminder blocks and drops a
        // directive-only user message, so neither reaches the historian.
        turns[0]!.user = `<system-reminder>internal note</system-reminder> ${turns[0]!.user}`;
        turns[3]!.user = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT] refresh the working set";
        const scenario = parseScenario(raw);
        const visible = (candidate: HistorianEvalScenario) =>
            normalizedEvidenceMessages(candidate.transcript.turns)
                .map((message) => `${message.turnIndex}:${message.role}`)
                .join("|");

        for (const id of ["paraphrase-irrelevant", "rename-unrelated-symbols"]) {
            const transform = TRANSFORMS.find((candidate) => candidate.id === id)!;
            for (let seed = 0; seed < 30; seed += 1) {
                const result = transform.apply(scenario, seed);
                if (!result.applicable) continue;
                expect(result.scenario.transcript.turns[3]!.user, `${id}/s${seed}`).toBe(
                    scenario.transcript.turns[3]!.user,
                );
                expect(visible(result.scenario), `${id}/s${seed}`).toBe(visible(scenario));
            }
        }
    });

    test("reorder preserves a second occurrence of the same negative evidence", () => {
        const raw = validScenarioRaw();
        const transcript = raw.transcript as {
            turns: Array<{ user: string; assistant: string }>;
            epilogueStartIndex: number;
        };
        // `legacy bridge` is authored twice: once wholly inside a turn, and once
        // across the turn-1/turn-2 boundary the swap would separate. A
        // predicate-level check passes on the survivor alone.
        transcript.turns.unshift(
            { user: "Note the legacy bridge stays.", assistant: "Understood." },
            { user: "Second note.", assistant: "We keep the legacy" },
            { user: "bridge alive for now.", assistant: "Acknowledged." },
        );
        transcript.epilogueStartIndex += 3;
        const gold = raw.gold as {
            expectedClaims: Array<{ sourceTurnRange: [number, number] }>;
            expectedAbsent: Array<Record<string, unknown>>;
        };
        for (const claim of gold.expectedClaims) {
            claim.sourceTurnRange = [claim.sourceTurnRange[0] + 3, claim.sourceTurnRange[1] + 3];
        }
        gold.expectedAbsent.push({
            id: "abs-legacy-bridge",
            family: "proposed-but-rejected",
            predicate: { kind: "normalized-substring", value: "legacy bridge" },
        });
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const occurrences = (candidate: HistorianEvalScenario) =>
            normalizeContent(authoredEvidenceText(candidate.transcript.turns)).split("legacy bridge")
                .length - 1;
        expect(occurrences(scenario)).toBe(2);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "reorder-independent-turns")!;

        for (let seed = 0; seed < 40; seed += 1) {
            const result = transform.apply(scenario, seed);
            if (!result.applicable) continue;
            expect(occurrences(result.scenario), `seed ${seed}`).toBeGreaterThanOrEqual(2);
        }
    });

    test("move refuses a span containing a rejected proposal", () => {
        const raw = movableScenarioRaw();
        const gold = raw.gold as { expectedAbsent: Array<Record<string, unknown>> };
        // The only move is turn 1 to position 3, whose span covers turn 2. Giving
        // turn 2 rejected-proposal evidence would leave that proposal ahead of the
        // decision it was rejected by.
        gold.expectedAbsent.push({
            id: "abs-capacity-proposal",
            family: "proposed-but-rejected",
            predicate: { kind: "normalized-substring", value: "set the cache capacity" },
        });
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "move-accepted-decision")!;

        expect(transform.apply(scenario, 7)).toEqual({
            applicable: false,
            reason: "no movable single-turn accepted decision before epilogue",
        });
    });

    test("paraphrase never frames a message into expected-claim evidence", () => {
        const raw = validScenarioRaw();
        const gold = raw.gold as {
            expectedClaims: Array<Record<string, unknown>>;
        };
        // The framing wording itself satisfies a gold predicate, so an unframed
        // unprotected message would gain authoritative evidence. No probe
        // references this claim, so no answer check can stand in for the claim
        // check — which is also the case for a `claim-id` probe.
        gold.expectedClaims.push({
            id: "exp-background",
            category: "ARCHITECTURE",
            predicate: { kind: "normalized-substring", value: "background context" },
            sourceTurnRange: [2, 2],
        });
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[2]!.assistant = "Done: cache capacity is 4096 entries, recorded as background context.";
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "paraphrase-irrelevant")!;
        const occurrences = (candidate: HistorianEvalScenario) =>
            normalizeContent(authoredEvidenceText(candidate.transcript.turns)).split(
                "background context",
            ).length - 1;

        for (let seed = 0; seed < 30; seed += 1) {
            const result = transform.apply(scenario, seed);
            if (!result.applicable) continue;
            expect(occurrences(result.scenario), `seed ${seed}`).toBe(occurrences(scenario));
        }
    });

    test("paraphrase framing does not recase a leading identifier", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[3]!.user = "MyFile.ts contains the helper.";
        const scenario = parseScenario(raw);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "paraphrase-irrelevant")!;

        for (let seed = 0; seed < 30; seed += 1) {
            const result = transform.apply(scenario, seed);
            if (!result.applicable) continue;
            const rewritten = result.scenario.transcript.turns[3]!.user;
            if (rewritten === scenario.transcript.turns[3]!.user) continue;
            expect(rewritten, `seed ${seed}`).toContain("MyFile.ts");
            expect(rewritten, `seed ${seed}`).not.toContain("myFile.ts");
        }
    });

    test("duplication selects a turn whose rejection the historian receives", () => {
        const raw = validScenarioRaw();
        const transcript = raw.transcript as {
            turns: Array<{ user: string; assistant: string }>;
            epilogueStartIndex: number;
        };
        // The rejection is authored in a protected turn; the only other raw
        // occurrence sits in a reminder block production strips, so that turn
        // carries no rejection the historian can see.
        transcript.turns.unshift({
            user: "<system-reminder>should we use Redis for the session cache</system-reminder> Unrelated background.",
            assistant: "Noted.",
        });
        transcript.epilogueStartIndex += 1;
        const gold = raw.gold as {
            expectedClaims: Array<{ sourceTurnRange: [number, number] }>;
        };
        for (const claim of gold.expectedClaims) {
            claim.sourceTurnRange = [claim.sourceTurnRange[0] + 1, claim.sourceTurnRange[1] + 1];
        }
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "duplicate-rejected-proposal")!;

        for (let seed = 0; seed < 20; seed += 1) {
            const result = transform.apply(scenario, seed);
            if (!result.applicable) continue;
            expect(result.scenario.transcript.turns[1]!.user, `seed ${seed}`).not.toContain(
                "system-reminder",
            );
        }
    });

    test("rename leaves inline commands and probe-referenced symbols alone", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[0]!.assistant = "We could consider it.";
        turns[3] = {
            user: "Wrapping up: run `npm test -- --watch` and check buildAPI plus aux_worker.ts.",
            assistant: "Summary recorded.",
        };
        (raw.probes as Array<Record<string, unknown>>)[0] = {
            id: "probe-capacity",
            question: "What status does buildAPI return?",
            answerType: "exact",
            goldAnswer: "4096",
            sourceClaimRef: "exp-cache-capacity",
        };
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "rename-unrelated-symbols")!;

        let renamed = 0;
        for (let seed = 0; seed < 40; seed += 1) {
            const result = transform.apply(scenario, seed);
            if (!result.applicable) continue;
            const rewritten = result.scenario.transcript.turns[3]!.user;
            expect(rewritten, `seed ${seed}`).toContain("`npm test -- --watch`");
            expect(rewritten, `seed ${seed}`).toContain("buildAPI");
            if (!rewritten.includes("aux_worker.ts")) renamed += 1;
        }
        // The one symbol neither a probe nor inline code claims is still renameable.
        expect(renamed).toBeGreaterThan(0);
    });

    test("reorder refuses a pair the historian receives identically", () => {
        const raw = validScenarioRaw();
        const transcript = raw.transcript as {
            turns: Array<{ user: string; assistant: string }>;
            epilogueStartIndex: number;
        };
        // The two turns differ only inside a reminder block production strips,
        // so the historian receives them identically.
        transcript.turns.unshift(
            { user: "<system-reminder>first</system-reminder> Background note.", assistant: "Noted." },
            { user: "<system-reminder>second</system-reminder> Background note.", assistant: "Noted." },
        );
        transcript.epilogueStartIndex += 2;
        const gold = raw.gold as { expectedClaims: Array<{ sourceTurnRange: [number, number] }> };
        for (const claim of gold.expectedClaims) {
            claim.sourceTurnRange = [claim.sourceTurnRange[0] + 2, claim.sourceTurnRange[1] + 2];
        }
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "reorder-independent-turns")!;

        for (let seed = 0; seed < 40; seed += 1) {
            const result = transform.apply(scenario, seed);
            if (!result.applicable) continue;
            const visible = (candidate: HistorianEvalScenario) =>
                normalizedEvidenceMessages(candidate.transcript.turns)
                    .map((message) => message.text)
                    .join("|");
            expect(visible(result.scenario), `seed ${seed}`).not.toBe(visible(scenario));
        }
    });

    test("paraphrase still applies when every unprotected message carries negative evidence", () => {
        const raw = validScenarioRaw();
        const transcript = raw.transcript as {
            turns: Array<{ user: string; assistant: string }>;
            epilogueStartIndex: number;
        };
        // Every pre-epilogue turn is covered by an expected-claim range and both
        // epilogue messages repeat the forbidden formation, so no message is free
        // of gold or negative evidence.
        transcript.turns = [
            {
                user: "Should we use Redis for the session cache? No — use the in-process LRU cache with capacity 4096 entries.",
                assistant: "Understood: in-process LRU cache for sessions, capacity 4096 entries.",
            },
            {
                user: "Recap: we did not use Redis for the session cache.",
                assistant: "Right, we will not use Redis for the session cache.",
            },
        ];
        transcript.epilogueStartIndex = 1;
        const gold = raw.gold as { expectedClaims: Array<{ sourceTurnRange: [number, number] }> };
        for (const claim of gold.expectedClaims) claim.sourceTurnRange = [0, 0];
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "paraphrase-irrelevant")!;

        const result = transform.apply(scenario, 0);
        expect(result.applicable).toBe(true);
        if (!result.applicable) return;
        expect(lintScenario(result.scenario)).toEqual([]);
    });

    test("paraphrase never frames a message with a probe gold answer", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[2] = {
            user: "Which tier owns the retry budget?",
            assistant:
                "Done: cache capacity is 4096 entries and the background tier owns the retry budget.",
        };
        const gold = raw.gold as {
            expectedClaims: Array<{ predicate: { value: string } }>;
        };
        gold.expectedClaims[1]!.predicate.value = "background tier owns the retry budget";
        // `background` is a valid gold answer that also appears in the paraphrase
        // framing, so an unfiltered rewrite would put the answer into raw history
        // the probe still reads.
        (raw.probes as Array<Record<string, unknown>>)[0] = {
            id: "probe-capacity",
            question: "Which tier owns the retry budget?",
            answerType: "exact",
            goldAnswer: "background",
            sourceClaimRef: "exp-cache-capacity",
        };
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "paraphrase-irrelevant")!;

        for (let seed = 0; seed < 30; seed += 1) {
            const result = transform.apply(scenario, seed);
            if (!result.applicable) continue;
            result.scenario.transcript.turns.forEach((turn, index) => {
                for (const role of ["user", "assistant"] as const) {
                    const before = scenario.transcript.turns[index]![role];
                    if (turn[role] === before) continue;
                    expect(
                        containsCompleteValue(turn[role], "background"),
                        `seed ${seed} ${index}:${role}`,
                    ).toBe(containsCompleteValue(before, "background"));
                }
            });
        }
    });

    test("duplication refuses to push the rendered transcript past single-chunk headroom", () => {
        const raw = validScenarioRaw();
        const transcript = raw.transcript as {
            turns: Array<{ user: string; assistant: string }>;
            epilogueStartIndex: number;
        };
        const filler = ` ${"filler word ".repeat(14_000 / 12)}`;
        for (const turn of transcript.turns) {
            turn.user += filler;
            turn.assistant += filler;
        }
        const scenario = parseScenario(raw);
        // Lint-clean with margin to spare, but one more rendered turn does not fit.
        expect(lintScenario(scenario)).toEqual([]);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "duplicate-rejected-proposal")!;

        const result = transform.apply(scenario, 0);
        expect(result.applicable).toBe(false);
        if (result.applicable) return;
        expect(result.reason).toContain(CONTRACT_VIOLATION_REASON);
        expect(result.reason).toContain("exceeds-single-chunk-headroom");
    });

    test("rename changes every eligible occurrence without colliding", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[0].assistant = "We could consider it.";
        turns[3] = {
            user: "Close aux_worker.ts after aux_worker.ts and aux_symbol_1234 are checked.",
            assistant: "Background only.",
        };
        const scenario = parseScenario(raw);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "rename-unrelated-symbols")!;
        const result = firstApplicable(transform, scenario)!;
        const originalSymbols = new Set(["aux_worker.ts", "aux_symbol_1234"]);
        const derivativeText = result.scenario.transcript.turns[3]!.user;
        const derivativeSymbols = [...derivativeText.matchAll(/aux_(?:worker\.ts|symbol_\d+)/g)]
            .map((match) => match[0]);
        const introduced = derivativeSymbols.filter((symbol) => !originalSymbols.has(symbol));

        expect(derivativeText).not.toContain("aux_worker.ts");
        expect(introduced).toHaveLength(2);
        expect(new Set(introduced).size).toBe(1);
        expect(introduced[0]).not.toBe("aux_symbol_1234");
    });

    test("rename never picks a symbol shared with an ineligible message", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[0].assistant = "We could consider it.";
        turns[3] = {
            user: "Close the in-process LRU work and the aux_worker.ts notes.",
            assistant: "Background only.",
        };
        const scenario = parseScenario(raw);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "rename-unrelated-symbols")!;
        for (let seed = 0; seed < 50; seed += 1) {
            const result = transform.apply(scenario, seed);
            expect(result.applicable, `seed ${seed}`).toBe(true);
            if (!result.applicable) continue;
            expect(result.scenario.transcript.turns[3]!.user).toContain("in-process LRU");
            expect(result.scenario.transcript.turns[1]).toEqual(scenario.transcript.turns[1]);
        }
    });

    test("rename symbol scan stays fast on long separator runs", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string }> }).turns;
        turns[3].user = `Rule A${"-".repeat(5_000)} applies, then close the aux_worker.ts notes.`;
        const scenario = parseScenario(raw);
        const transform = TRANSFORMS.find((candidate) => candidate.id === "rename-unrelated-symbols")!;
        const start = performance.now();
        const result = transform.apply(scenario, 0);
        expect(performance.now() - start).toBeLessThan(1_000);
        expect(result.applicable).toBe(true);
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
        const contentTransformIds = ["paraphrase-irrelevant", "rename-unrelated-symbols"];
        const preEpilogueRewrites = new Set<string>();
        for (const scenario of corpus()) {
            let applied = 0;
            for (const transform of TRANSFORMS) {
                const result = transform.apply(scenario, 20_260_830);
                if (!result.applicable) {
                    expect(ALWAYS_APPLICABLE_TRANSFORM_IDS).not.toContain(transform.id);
                    // A frozen scenario must never make a transform build a
                    // derivative the contract rejects: that reason means the
                    // transform declined at the backstop instead of at candidate
                    // selection, and the corpus is where it gets fixed.
                    expect(result.reason, `${scenario.id}/${transform.id}`).not.toContain(
                        CONTRACT_VIOLATION_REASON,
                    );
                    continue;
                }
                applied += 1;
                expect(lintScenario(result.scenario), `${scenario.id}/${transform.id}`).toEqual([]);
                if (contentTransformIds.includes(transform.id)) {
                    for (let seed = 0; seed < 10; seed += 1) {
                        const seeded = transform.apply(scenario, seed);
                        if (!seeded.applicable) continue;
                        const changedBeforeEpilogue = seeded.scenario.transcript.turns.some(
                            (turn, index) =>
                                index < scenario.transcript.epilogueStartIndex &&
                                (turn.user !== scenario.transcript.turns[index].user ||
                                    turn.assistant !== scenario.transcript.turns[index].assistant),
                        );
                        if (changedBeforeEpilogue) preEpilogueRewrites.add(transform.id);
                    }
                }
            }
            expect(applied, scenario.id).toBeGreaterThan(0);
        }
        expect([...preEpilogueRewrites].sort()).toEqual([...contentTransformIds].sort());
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
