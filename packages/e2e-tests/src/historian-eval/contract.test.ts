import { describe, expect, test } from "bun:test";
import {
    HARD_NEGATIVE_FAMILIES,
    HistorianEvalContractError,
    MANIFEST_SCHEMA,
    MAX_EXPECTATION_ENTRIES,
    MAX_TRANSCRIPT_TURNS,
    MAX_TURN_TEXT_CHARS,
    buildReleaseTuple,
    lintScenario,
    normalizeContent,
    parseManifest,
    parseScenario,
    predicateMatches,
    releaseApprovalFingerprint,
    renderedTranscriptBlocks,
    scenarioFingerprint,
} from "./contract";
import { ballastProse } from "../ballast";
import { estimateTokens } from "../../../plugin/src/shared/token-estimator";
import { validScenario, validScenarioRaw } from "./test-support";

/** Deep key-order permutation: same semantics, different byte order. */
function permuteKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(permuteKeys);
    if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>).reverse();
        const out: Record<string, unknown> = {};
        for (const [key, entryValue] of entries) out[key] = permuteKeys(entryValue);
        return out;
    }
    return value;
}

describe("parseScenario", () => {
    test("valid scenario parses and round-trips with a stable fingerprint", () => {
        const scenario = validScenario();
        expect(scenario.id).toBe("hse-auth-rejected-redis");
        expect(scenario.gold.expectedClaims).toHaveLength(2);
        const again = parseScenario(JSON.parse(JSON.stringify(validScenarioRaw())));
        expect(scenarioFingerprint(again)).toBe(scenarioFingerprint(scenario));
    });

    test("key-order permutation yields the same fingerprint", () => {
        const scenario = validScenario();
        const permuted = parseScenario(permuteKeys(validScenarioRaw()));
        expect(scenarioFingerprint(permuted)).toBe(scenarioFingerprint(scenario));
    });

    test("trigger pressure is outside the fingerprint; declared run count is inside", () => {
        const base = validScenario();
        const retuned = validScenarioRaw();
        (retuned.trigger as Record<string, unknown>).spikeUsageTokens = 120_000;
        (retuned.trigger as Record<string, unknown>).ballastTokensPerTurn = 5_000;
        expect(scenarioFingerprint(parseScenario(retuned))).toBe(scenarioFingerprint(base));

        const rerun = validScenarioRaw();
        (rerun.trigger as Record<string, unknown>).expectedHistorianRuns = 1;
        expect(scenarioFingerprint(parseScenario(rerun))).not.toBe(scenarioFingerprint(base));
    });

    test("gold, probes, families, transcript, and epilogue boundary are all inside the fingerprint", () => {
        const base = scenarioFingerprint(validScenario());
        const edits: Array<(raw: Record<string, unknown>) => void> = [
            (raw) => {
                (
                    raw.gold as { expectedClaims: Array<{ predicate: { value: string } }> }
                ).expectedClaims[0].predicate.value = "weakened predicate";
            },
            (raw) => {
                (raw.gold as { expectedAbsent: Array<{ predicate: { value: string } }> }).expectedAbsent[0].predicate.value =
                    "different forbidden formation";
            },
            (raw) => {
                (raw.probes as Array<{ goldAnswer?: string }>)[0].goldAnswer = "2048";
            },
            (raw) => {
                raw.families = ["assistant-speculation"];
                (raw.gold as { expectedAbsent: Array<{ family: string }> }).expectedAbsent[0].family =
                    "assistant-speculation";
            },
            (raw) => {
                (raw.transcript as { turns: Array<{ user: string }> }).turns[0].user =
                    "Should we use Memcached for the session cache?";
            },
            (raw) => {
                (raw.transcript as { epilogueStartIndex: number }).epilogueStartIndex = 2;
            },
        ];
        for (const edit of edits) {
            const raw = validScenarioRaw();
            edit(raw);
            expect(scenarioFingerprint(parseScenario(raw))).not.toBe(base);
        }
    });

    test("trigger integers reject values above the operational maxima", () => {
        const raw = validScenarioRaw();
        (raw.trigger as Record<string, unknown>).ballastTokensPerTurn = 1_000_000;
        expect(() => parseScenario(raw)).toThrow(/above-operational-maximum/);
    });

    test("transcript above the turn-count operational maximum rejects", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: unknown[] }).turns;
        const template = JSON.stringify(turns[0]);
        while (turns.length <= MAX_TRANSCRIPT_TURNS) turns.push(JSON.parse(template));
        expect(() => parseScenario(raw)).toThrow(/above-operational-maximum/);
    });

    test("turn text above the length operational maximum rejects", () => {
        const raw = validScenarioRaw();
        (raw.transcript as { turns: Array<{ user: string }> }).turns[0].user = "x".repeat(MAX_TURN_TEXT_CHARS + 1);
        expect(() => parseScenario(raw)).toThrow(/above-operational-maximum/);
    });

    test("unknown key rejects with a named error", () => {
        const raw = validScenarioRaw();
        raw.note = "smuggled";
        expect(() => parseScenario(raw)).toThrow(/fields-invalid/);
    });

    test("missing gold field rejects", () => {
        const raw = validScenarioRaw();
        delete (raw.gold as Record<string, unknown>).expectedAbsent;
        expect(() => parseScenario(raw)).toThrow(/fields-invalid/);
    });

    test("literal claim-id gold rejects: probe must reference a gold expected claim", () => {
        const raw = validScenarioRaw();
        (raw.probes as Record<string, unknown>[])[2].expectedClaimRef = "mem-01HXYZ";
        expect(() => parseScenario(raw)).toThrow(/id-invalid/);
    });

    test("dangling expected-claim reference rejects", () => {
        const raw = validScenarioRaw();
        (raw.probes as Record<string, unknown>[])[2].expectedClaimRef = "exp-not-authored";
        expect(() => parseScenario(raw)).toThrow(/dangling-reference/);
    });

    test("free-text probe answer type rejects", () => {
        const raw = validScenarioRaw();
        (raw.probes as Record<string, unknown>[])[0].answerType = "free-text";
        expect(() => parseScenario(raw)).toThrow(/enum-invalid/);
    });

    test("probe with answer type exact but empty gold answer rejects", () => {
        const raw = validScenarioRaw();
        (raw.probes as Record<string, unknown>[])[0].goldAnswer = "";
        expect(() => parseScenario(raw)).toThrow(/string-invalid/);
    });

    test("whitespace-only contract strings reject like empty ones", () => {
        // Production transcript formatting trims and can discard a blank
        // message, and a blank probe answer is not scoreable, so a
        // whitespace-only value would freeze a scenario whose runtime input the
        // gold contract cannot match.
        const edits: Array<(raw: Record<string, unknown>) => void> = [
            (raw) => {
                raw.title = "   ";
            },
            (raw) => {
                (raw.transcript as { turns: Array<{ user: string }> }).turns[0].user = "  \t ";
            },
            (raw) => {
                (raw.probes as Record<string, unknown>[])[0].goldAnswer = " ";
            },
            (raw) => {
                (raw.probes as Record<string, unknown>[])[0].question = "\n";
            },
        ];
        for (const edit of edits) {
            const raw = validScenarioRaw();
            edit(raw);
            expect(() => parseScenario(raw)).toThrow(/string-invalid/);
        }
    });

    test("two expected claims sharing a category and normalized predicate reject", () => {
        const raw = validScenarioRaw();
        const claims = (raw.gold as { expectedClaims: Record<string, unknown>[] }).expectedClaims;
        // Distinct id, same expectation: whitespace and case are normalized away,
        // so this is one gold written twice and would double-count on recall.
        claims.push({
            id: "exp-lru-cache-again",
            category: "ARCHITECTURE",
            predicate: { kind: "normalized-substring", value: "In-Process   LRU Cache" },
            sourceTurnRange: [1, 1],
        });
        expect(() => parseScenario(raw)).toThrow(/gold\.expectedClaims\.identity: duplicate/);
    });

    test("two expected-absent entries sharing a family and normalized predicate reject", () => {
        const raw = validScenarioRaw();
        const absent = (raw.gold as { expectedAbsent: Record<string, unknown>[] }).expectedAbsent;
        absent.push({
            id: "abs-redis-active-again",
            family: "proposed-but-rejected",
            predicate: { kind: "normalized-substring", value: "Use   REDIS for the Session Cache" },
        });
        expect(() => parseScenario(raw)).toThrow(/gold\.expectedAbsent\.identity: duplicate/);
    });

    test("the same forbidden formation may serve two declared families", () => {
        const raw = validScenarioRaw();
        raw.families = ["proposed-but-rejected", "explored-never-accepted"];
        (raw.gold as { expectedAbsent: Record<string, unknown>[] }).expectedAbsent.push({
            id: "abs-redis-explored",
            family: "explored-never-accepted",
            predicate: { kind: "normalized-substring", value: "use Redis for the session cache" },
        });
        // Family is part of the identity precisely so this stays legal.
        expect(lintScenario(parseScenario(raw))).toEqual([]);
    });

    test("expectation and probe arrays reject above the operational maximum", () => {
        const cases: Array<[string, (raw: Record<string, unknown>) => void]> = [
            [
                "gold.expectedClaims",
                (raw) => {
                    (raw.gold as { expectedClaims: unknown[] }).expectedClaims = Array.from(
                        { length: MAX_EXPECTATION_ENTRIES + 1 },
                        (_unused, index) => ({
                            id: `exp-bulk-${index}`,
                            category: "ARCHITECTURE",
                            predicate: { kind: "normalized-substring", value: `formation ${index}` },
                            sourceTurnRange: [1, 1],
                        }),
                    );
                },
            ],
            [
                "gold.expectedAbsent",
                (raw) => {
                    (raw.gold as { expectedAbsent: unknown[] }).expectedAbsent = Array.from(
                        { length: MAX_EXPECTATION_ENTRIES + 1 },
                        (_unused, index) => ({
                            id: `abs-bulk-${index}`,
                            family: "proposed-but-rejected",
                            predicate: { kind: "normalized-substring", value: `forbidden ${index}` },
                        }),
                    );
                },
            ],
            [
                "probes",
                (raw) => {
                    raw.probes = Array.from({ length: MAX_EXPECTATION_ENTRIES + 1 }, (_unused, index) => ({
                        id: `probe-bulk-${index}`,
                        question: `question ${index}?`,
                        answerType: "exact",
                        goldAnswer: `${index}`,
                        sourceClaimRef: "exp-lru-cache",
                    }));
                },
            ],
        ];
        // Bounded before mapping: the lint compares every absent predicate with
        // every claim, so uncapped arrays hang freeze lint rather than failing it.
        for (const [label, edit] of cases) {
            const raw = validScenarioRaw();
            edit(raw);
            expect(() => parseScenario(raw)).toThrow(
                new RegExp(`${label.replace(/\./g, "\\.")}: above-operational-maximum`),
            );
        }
    });

    test("exact and multiple-choice probes require a gold source claim", () => {
        for (const index of [0, 1]) {
            const raw = validScenarioRaw();
            delete (raw.probes as Record<string, unknown>[])[index].sourceClaimRef;
            // Without it the probe's gold answer has no declared source range, so
            // the runtime cannot separate an injection-budget trim (the KTD6
            // ERROR) from a model failure.
            expect(() => parseScenario(raw)).toThrow(/probes\[\d\]: fields-invalid/);
        }
    });

    test("multiple-choice options that normalize alike reject", () => {
        const raw = validScenarioRaw();
        // Two spellings of one option: `probeIdentity` treats them as the same
        // answer, so a model picking the non-gold spelling would be scored wrong.
        (raw.probes as Array<{ choices?: string[] }>)[1].choices = ["in-process lru", " In-Process   LRU "];
        expect(() => parseScenario(raw)).toThrow(/choices: duplicate/);
    });

    test("a claim-id probe carries only its expected-claim reference", () => {
        const raw = validScenarioRaw();
        (raw.probes as Record<string, unknown>[])[2].sourceClaimRef = "exp-lru-cache";
        expect(() => parseScenario(raw)).toThrow(/probes\[2\]: fields-invalid/);
    });

    test("a probe copied verbatim under a new id rejects", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // Same question, same gold answer, same backing claim: one question asked
        // twice, which double-weights that behavior in probe accuracy.
        probes.push({ ...probes[0], id: "probe-capacity-again" });
        expect(() => parseScenario(raw)).toThrow(/probes\.identity: duplicate/);
    });

    test("probe identity ignores incidental spelling and choice order", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        probes.push({
            id: "probe-store-again",
            question: "  Which   CACHE backs sessions? ",
            answerType: "multiple-choice",
            choices: ["in-process lru", "REDIS"],
            goldAnswer: "in-process lru",
            sourceClaimRef: "exp-lru-cache",
        });
        expect(() => parseScenario(raw)).toThrow(/probes\.identity: duplicate/);
    });

    test("two probes asking the same question of different claims stay distinct", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        probes.push({ ...probes[0], id: "probe-capacity-of-lru", sourceClaimRef: "exp-lru-cache" });
        // The backing claim is part of the identity, so this is a different probe.
        expect(parseScenario(raw).probes).toHaveLength(4);
    });

    test("run budget above two rejects (KTD3)", () => {
        const raw = validScenarioRaw();
        (raw.trigger as Record<string, unknown>).expectedHistorianRuns = 3;
        expect(() => parseScenario(raw)).toThrow(/run-budget-exceeded/);
    });

    test("diagnostics are carried on the error", () => {
        try {
            parseScenario({ schema: "wrong" });
            throw new Error("expected rejection");
        } catch (error) {
            expect(error).toBeInstanceOf(HistorianEvalContractError);
            expect((error as HistorianEvalContractError).diagnostics.length).toBeGreaterThan(0);
        }
    });
});

describe("lintScenario", () => {
    test("accepts a well-formed scenario carrying each of the seven hard-negative families", () => {
        const raw = validScenarioRaw();
        raw.families = [...HARD_NEGATIVE_FAMILIES];
        // Each predicate is a formation the pre-epilogue transcript actually
        // contains: a hard negative the historian was never exposed to would
        // pass its absence check vacuously, so the lint requires the evidence.
        const authoredFormations = [
            "use Redis for the session cache",
            "TTL eviction",
            "operational dependency",
            "Redis would give us",
            "Redis rejected",
            "cache capacity",
            "out of the box",
        ];
        (raw.gold as Record<string, unknown>).expectedAbsent = HARD_NEGATIVE_FAMILIES.map((family, index) => ({
            id: `abs-family-${index}`,
            family,
            predicate: { kind: "normalized-substring", value: authoredFormations[index] },
        }));
        expect(lintScenario(parseScenario(raw))).toEqual([]);
    });

    test("rejects a gold category outside the 5-category taxonomy", () => {
        const raw = validScenarioRaw();
        (raw.gold as { expectedClaims: Record<string, unknown>[] }).expectedClaims[0].category = "WORKFLOW_RULES";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics.some((d) => d.includes("outside-taxonomy"))).toBe(true);
    });

    test("rejects a transcript exceeding the single-chunk headroom margin", () => {
        const raw = validScenarioRaw();
        (raw.trigger as Record<string, unknown>).ballastTokensPerTurn = 40_000;
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics.some((d) => d.includes("exceeds-single-chunk-headroom"))).toBe(true);
    });

    test("rejects a scenario with zero expected-absent predicates in a declared hard-negative family", () => {
        const raw = validScenarioRaw();
        raw.families = ["proposed-but-rejected", "assistant-speculation"];
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.families.assistant-speculation: missing-expected-absent",
        );
    });

    test("rejects gold facts authored inside the epilogue", () => {
        const raw = validScenarioRaw();
        (raw.gold as { expectedClaims: Record<string, unknown>[] }).expectedClaims[1].sourceTurnRange = [3, 3];
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics.some((d) => d.includes("inside-epilogue"))).toBe(true);
    });

    test("rejects a scenario with zero probes", () => {
        const raw = validScenarioRaw();
        raw.probes = [];
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics.some((d) => d.includes("probes: empty"))).toBe(true);
    });

    test("rejects an expected-absent predicate that contradicts a gold claim", () => {
        const raw = validScenarioRaw();
        // "LRU cache" is a normalized substring of the gold claim
        // "in-process LRU cache": any content satisfying the gold predicate
        // necessarily trips the forbidden formation, so the scenario could
        // never pass once frozen.
        (raw.gold as { expectedAbsent: Array<{ predicate: { value: string } }> }).expectedAbsent[0].predicate.value =
            "LRU cache";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.gold.expectedAbsent.abs-redis-active: contradicts-exp-lru-cache",
        );
    });

    test("rejects a compartment minCount above the transcript's message capacity", () => {
        const raw = validScenarioRaw();
        // 4 turns = 8 messages; compartments partition messages, so 9 can
        // never be satisfied.
        (raw.gold as { compartments: { minCount: number } }).compartments.minCount = 9;
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics.some((d) => d.includes("minCount: exceeds-message-capacity"))).toBe(true);
    });

    test("rejects a gold claim whose predicate is absent from its declared source range", () => {
        const raw = validScenarioRaw();
        // Range [1,1] is the LRU-cache decision turn; "4096" is authored in turn
        // 2. The range is what the leakage gate guards and what the scorer treats
        // as the fact's origin, so a predicate that is not in it names no
        // authored fact.
        (raw.gold as { expectedClaims: Array<{ sourceTurnRange: [number, number] }> }).expectedClaims[1].sourceTurnRange =
            [1, 1];
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.gold.expectedClaims.exp-cache-capacity.sourceTurnRange: predicate-not-authored",
        );
    });

    test("accepts a gold claim whose predicate spans its multi-turn source range", () => {
        const raw = validScenarioRaw();
        (raw.gold as { expectedClaims: Array<{ sourceTurnRange: [number, number] }> }).expectedClaims[1].sourceTurnRange =
            [0, 2];
        expect(lintScenario(parseScenario(raw))).toEqual([]);
    });

    test("rejects a hard-negative predicate the transcript never authors", () => {
        const raw = validScenarioRaw();
        (raw.gold as { expectedAbsent: Array<{ predicate: { value: string } }> }).expectedAbsent[0].predicate.value =
            "use Cassandra for the session cache";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.gold.expectedAbsent.abs-redis-active.predicate: not-authored-before-epilogue",
        );
    });

    test("rejects a hard-negative predicate authored only in the discardable epilogue", () => {
        const raw = validScenarioRaw();
        (raw.transcript as { turns: Array<{ user: string }> }).turns[3].user =
            "One last thought: we could still use Kafka for the session cache.";
        (raw.gold as { expectedAbsent: Array<{ predicate: { value: string } }> }).expectedAbsent[0].predicate.value =
            "use Kafka for the session cache";
        const diagnostics = lintScenario(parseScenario(raw));
        // Discard-last can drop the epilogue, so the historian may never see the
        // formation and the absence check would pass without measuring anything.
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.gold.expectedAbsent.abs-redis-active.predicate: not-authored-before-epilogue",
        );
    });

    test("rejects a probe gold answer absent from its claim's source range", () => {
        const raw = validScenarioRaw();
        // Valid reference, unsupported answer: the frozen probe would reward a
        // hallucinated 2048 and mark the transcript-supported 4096 wrong.
        (raw.probes as Record<string, unknown>[])[0].goldAnswer = "2048";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.probes.probe-capacity.goldAnswer: not-authored-in-source-range",
        );
    });

    test("a probe gold answer is checked against its own claim's range, not the whole transcript", () => {
        const raw = validScenarioRaw();
        // "4096" is authored in turn 2, but this probe now claims the LRU decision
        // turn as its provenance, so the answer is not supported where it says.
        (raw.probes as Record<string, unknown>[])[0].sourceClaimRef = "exp-lru-cache";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.probes.probe-capacity.goldAnswer: not-authored-in-source-range",
        );
    });

    test("headroom lint measures the ballast the harnesses actually send", () => {
        const scenario = validScenario();
        const blocks = renderedTranscriptBlocks(scenario);
        // `ballastProse` takes only a token count, and `TestHarness.ballast` plus
        // its pi/rust twins forward exactly that, so every turn must carry these
        // bytes. Pinned because the lint measuring bytes no runner sends is the
        // failure this rendering exists to prevent.
        const harnessBallast = ballastProse(scenario.trigger.ballastTokensPerTurn);
        expect(harnessBallast.length).toBeGreaterThan(0);
        expect(blocks.filter((block) => block.includes(harnessBallast))).toHaveLength(
            scenario.transcript.turns.length,
        );
    });

    test("headroom lint accounts per block, as production budgets", () => {
        const scenario = validScenario();
        const blocks = renderedTranscriptBlocks(scenario);
        // Production tokenizes each formatBlock result and accumulates the counts,
        // so the lint must sum the same per-block estimates. Estimation is not
        // additive across concatenation, which is what makes this observable.
        expect(blocks).toHaveLength(scenario.transcript.turns.length * 2);
        const summed = blocks.reduce((total, block) => total + estimateTokens(block), 0);
        const joined = estimateTokens(blocks.join("\n"));
        const reported = lintScenario(
            parseScenario({
                ...validScenarioRaw(),
                trigger: { ...(validScenarioRaw().trigger as Record<string, unknown>), headroomMarginTokens: 100_000 },
            }),
        ).find((diagnostic) => diagnostic.includes("exceeds-single-chunk-headroom"));
        expect(reported).toContain(`(${summed} + margin 100000`);
        expect(reported).not.toContain(`(${joined} + margin 100000`);
    });
});

describe("predicate matching", () => {
    test("normalization is trim + case-fold + whitespace-collapse", () => {
        expect(normalizeContent("  Foo   BAR\nbaz ")).toBe("foo bar baz");
        expect(
            predicateMatches({ kind: "normalized-substring", value: "In-Process   LRU" }, "the in-process lru cache"),
        ).toBe(true);
        expect(predicateMatches({ kind: "normalized-substring", value: "redis" }, "no cache named")).toBe(false);
    });
});

describe("release tuple and manifest", () => {
    test("release tuple is order-independent over the corpus", () => {
        const a = validScenario();
        const rawB = validScenarioRaw();
        rawB.id = "hse-second-scenario";
        // A distinct id is no longer enough to make a second corpus entry: the
        // tuple rejects semantic duplicates regardless of name, so `b` has to
        // differ in substance. Editing an epilogue turn keeps every gold range
        // and predicate valid.
        (rawB.transcript as { turns: Array<{ user: string }> }).turns[3].user = "That is all for today.";
        const b = parseScenario(rawB);
        expect(buildReleaseTuple([a, b])).toEqual(buildReleaseTuple([b, a]));
    });

    test("release tuple rejects an empty corpus", () => {
        // A vacuous release still produces a bindable fingerprint, so approvals
        // could promote a corpus that measures nothing.
        expect(() => buildReleaseTuple([])).toThrow(/releaseTuple\.scenarios: empty/);
    });

    test("release tuple rejects a scenario copied under a new id", () => {
        const a = validScenario();
        const rawCopy = validScenarioRaw();
        rawCopy.id = "hse-auth-rejected-redis-copy";
        rawCopy.title = "A relabelled copy of the same evaluation";
        const copy = parseScenario(rawCopy);
        // Identity fingerprints cover id and title, so they differ here by
        // construction; only the id-independent check can see the duplicate.
        expect(scenarioFingerprint(copy)).not.toBe(scenarioFingerprint(a));
        expect(() => buildReleaseTuple([a, copy])).toThrow(/releaseTuple\.scenarios\.semantic: duplicate/);
    });

    test("reordering set-like arrays does not hide a copied scenario", () => {
        const a = validScenario();
        const rawCopy = validScenarioRaw();
        rawCopy.id = "hse-auth-rejected-redis-permuted";
        rawCopy.title = "The same evaluation with its arrays permuted";
        // canonicalJson preserves array order, so a permuted copy would otherwise
        // hash differently while running the identical transcript and checks.
        (rawCopy.gold as { expectedClaims: unknown[] }).expectedClaims.reverse();
        (rawCopy.probes as unknown[]).reverse();
        const copy = parseScenario(rawCopy);
        expect(() => buildReleaseTuple([a, copy])).toThrow(/releaseTuple\.scenarios\.semantic: duplicate/);
    });

    test("reordering the transcript is a real difference, not a permutation", () => {
        const a = validScenario();
        const rawReordered = validScenarioRaw();
        rawReordered.id = "hse-turns-reordered";
        const turns = (rawReordered.transcript as { turns: unknown[] }).turns;
        // Turn order is meaning: the decision turn now precedes the proposal.
        [turns[0], turns[1]] = [turns[1], turns[0]];
        (rawReordered.gold as { expectedClaims: Array<{ sourceTurnRange: [number, number] }> }).expectedClaims[0].sourceTurnRange =
            [0, 0];
        const reordered = parseScenario(rawReordered);
        expect(() => buildReleaseTuple([a, reordered])).not.toThrow();
    });

    test("respelling a predicate does not hide a copied scenario", () => {
        const a = validScenario();
        const rawCopy = validScenarioRaw();
        rawCopy.id = "hse-auth-rejected-redis-respelled";
        // Every comparison of a predicate runs through normalizeContent, so a
        // respelling that normalizes alike evaluates identically.
        (rawCopy.gold as { expectedClaims: Array<{ predicate: { value: string } }> }).expectedClaims[0].predicate.value =
            "  IN-PROCESS   lru   Cache ";
        const copy = parseScenario(rawCopy);
        expect(() => buildReleaseTuple([a, copy])).toThrow(/releaseTuple\.scenarios\.semantic: duplicate/);
    });

    test("renumbering contract-local ids does not hide a copied scenario", () => {        const a = validScenario();
        const rawCopy = validScenarioRaw();
        rawCopy.id = "hse-auth-rejected-redis-renumbered";
        rawCopy.title = "The same evaluation with every local id renamed";
        // `exp-*`, `abs-*`, and `probe-*` are labels, not semantics. Renaming them
        // and rewriting the probe references leaves the evaluation identical.
        const renames: Record<string, string> = {
            "exp-lru-cache": "exp-a1",
            "exp-cache-capacity": "exp-a2",
            "abs-redis-active": "abs-b1",
            "probe-capacity": "probe-c1",
            "probe-store": "probe-c2",
            "probe-claim": "probe-c3",
        };
        const renamed = JSON.parse(
            JSON.stringify(rawCopy).replace(
                new RegExp(Object.keys(renames).join("|"), "g"),
                (match) => renames[match],
            ),
        );
        const copy = parseScenario(renamed);
        expect(copy.gold.expectedClaims[0].id).toBe("exp-a1");
        expect(() => buildReleaseTuple([a, copy])).toThrow(/releaseTuple\.scenarios\.semantic: duplicate/);
    });

    test("release tuple rejects duplicate scenario ids and duplicated scenarios", () => {
        const a = validScenario();
        const rawSameIdDifferentContent = validScenarioRaw();
        (rawSameIdDifferentContent.trigger as Record<string, unknown>).expectedHistorianRuns = 1;
        const sameId = parseScenario(rawSameIdDifferentContent);
        expect(() => buildReleaseTuple([a, sameId])).toThrow(/releaseTuple\.scenarios\.id: duplicate/);
        expect(() => buildReleaseTuple([a, a])).toThrow(/duplicate/);
    });

    test("manifest parses with fingerprint-bound approvals and rejects stale bindings", () => {
        const tuple = buildReleaseTuple([validScenario()]);
        const buildManifest = (tombstones: string[]) => {
            const releaseFingerprint = releaseApprovalFingerprint({
                releaseVersion: "v1",
                releaseTuple: tuple,
                tombstones,
            });
            return {
                schema: MANIFEST_SCHEMA,
                releaseVersion: "v1",
                releaseTuple: tuple,
                approvals: {
                    privacy: { kind: "privacy", approver: "operator-a", releaseFingerprint },
                    goldIntent: { kind: "gold-intent", approver: "operator-b", releaseFingerprint },
                },
                tombstones,
            };
        };
        const manifest = buildManifest(["hse-known-wrong"]);
        expect(parseManifest(manifest).releaseVersion).toBe("v1");

        const stale = JSON.parse(JSON.stringify(manifest));
        stale.approvals.privacy.releaseFingerprint = "0".repeat(64);
        expect(() => parseManifest(stale)).toThrow(/stale-or-foreign-release/);

        const wrongKind = JSON.parse(JSON.stringify(manifest));
        wrongKind.approvals.privacy.kind = "gold-intent";
        expect(() => parseManifest(wrongKind)).toThrow(/wrong-kind/);
    });

    test("approvals bind the tombstone set: dropping a tombstone invalidates them", () => {
        const tuple = buildReleaseTuple([validScenario()]);
        const releaseFingerprint = releaseApprovalFingerprint({
            releaseVersion: "v1",
            releaseTuple: tuple,
            tombstones: ["hse-known-wrong"],
        });
        // Same tuple, same approvals, tombstone silently dropped: the errata
        // resurrection this binding exists to prevent.
        const dropped = {
            schema: MANIFEST_SCHEMA,
            releaseVersion: "v1",
            releaseTuple: tuple,
            approvals: {
                privacy: { kind: "privacy", approver: "operator-a", releaseFingerprint },
                goldIntent: { kind: "gold-intent", approver: "operator-b", releaseFingerprint },
            },
            tombstones: [],
        };
        expect(() => parseManifest(dropped)).toThrow(/stale-or-foreign-release/);
    });

    test("approvals bind the release version", () => {
        const tuple = buildReleaseTuple([validScenario()]);
        const releaseFingerprint = releaseApprovalFingerprint({
            releaseVersion: "v1",
            releaseTuple: tuple,
            tombstones: [],
        });
        const bumped = {
            schema: MANIFEST_SCHEMA,
            releaseVersion: "v2",
            releaseTuple: tuple,
            approvals: {
                privacy: { kind: "privacy", approver: "operator-a", releaseFingerprint },
                goldIntent: { kind: "gold-intent", approver: "operator-b", releaseFingerprint },
            },
            tombstones: [],
        };
        expect(() => parseManifest(bumped)).toThrow(/stale-or-foreign-release/);
    });

    test("one actor cannot hold both governance seats", () => {
        const tuple = buildReleaseTuple([validScenario()]);
        // Trivially different spellings are the same actor: the string validator
        // preserves the authored value, so an exact comparison would pass them.
        for (const [privacyApprover, goldApprover] of [
            ["operator-a", "operator-a"],
            ["alice", " alice "],
            ["Alice", "alice"],
        ]) {
            const releaseFingerprint = releaseApprovalFingerprint({
                releaseVersion: "v1",
                releaseTuple: tuple,
                tombstones: [],
            });
            const sameActor = {
                schema: MANIFEST_SCHEMA,
                releaseVersion: "v1",
                releaseTuple: tuple,
                approvals: {
                    privacy: { kind: "privacy", approver: privacyApprover, releaseFingerprint },
                    goldIntent: { kind: "gold-intent", approver: goldApprover, releaseFingerprint },
                },
                tombstones: [],
            };
            expect(() => parseManifest(sameActor)).toThrow(/approver-not-independent/);
        }
    });

    test("privacy and sanitizer versions must be the ones the lane implements", () => {
        const tuple = buildReleaseTuple([validScenario()]);
        for (const key of ["privacyPolicyVersion", "sanitizerVersion"] as const) {
            // A manifest that invents a version and recomputes the fingerprint
            // over it would present the corpus as reviewed under a policy no code
            // here enforces, so the check cannot rely on the binding alone.
            const forgedTuple = { ...tuple, [key]: "made-up" };
            const releaseFingerprint = releaseApprovalFingerprint({
                releaseVersion: "v1",
                releaseTuple: forgedTuple,
                tombstones: [],
            });
            const forged = {
                schema: MANIFEST_SCHEMA,
                releaseVersion: "v1",
                releaseTuple: forgedTuple,
                approvals: {
                    privacy: { kind: "privacy", approver: "operator-a", releaseFingerprint },
                    goldIntent: { kind: "gold-intent", approver: "operator-b", releaseFingerprint },
                },
                tombstones: [],
            };
            expect(() => parseManifest(forged)).toThrow(new RegExp(`${key}: version-invalid`));
        }
    });
});
