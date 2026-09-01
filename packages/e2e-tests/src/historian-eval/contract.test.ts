import { describe, expect, test } from "bun:test";
import {
    HARD_NEGATIVE_FAMILIES,
    HistorianEvalContractError,
    MANIFEST_SCHEMA,
    SCENARIO_SCHEMA,
    assertReleaseSuccession,
    assertTombstonesRetired,
    authoredEvidenceText,
    compactedEvidenceMessages,
    containsCompleteValue,
    countCompleteValues,
    normalizedEvidenceMessages,
    parseReleaseLineage,
    MAX_EXPECTATION_ENTRIES,
    MAX_PROBE_CHOICES,
    MAX_TRANSCRIPT_TURNS,
    MAX_TURN_TEXT_CHARS,
    buildReleaseTuple,
    lintScenario,
    normalizeContent,
    parseManifest,
    parseScenario,
    predicateMatches,
    releaseApprovalFingerprint,
    renderedFillerBlocks,
    renderedTranscriptBlocks,
    scenarioFingerprint,
    parseModelRoute,
} from "./contract";
import { ballastProse } from "../ballast";
import { estimateTokens } from "../../../plugin/src/shared/token-estimator";
import { validScenario, validScenarioRaw } from "./test-support";

/** Reversing object keys preserves semantics but changes serialized bytes. */
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
        // Production transcript formatting trims whitespace and can discard blank messages.
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
        // The validator rejects duplicate gold expectations after whitespace and case normalization because they double-count recall.
        // The validator rejects duplicate gold expectations after whitespace and case normalization because they double-count recall.
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
        // The family differentiates otherwise identical expectations.
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
        // The lint compares every absent predicate with every claim, so caps bound its work.
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
            // Each probe gold answer requires a declared source range.
            expect(() => parseScenario(raw)).toThrow(/probes\[\d\]: fields-invalid/);
        }
    });

    test("multiple-choice options above the operational maximum reject", () => {
        const raw = validScenarioRaw();
        (raw.probes as Array<{ choices?: string[] }>)[1].choices = Array.from(
            { length: MAX_PROBE_CHOICES + 1 },
            (_unused, index) => `option ${index}`,
        );
        // Nested arrays require separate caps because a scenario can remain within the probe cap while exceeding a nested-array cap.
        expect(() => parseScenario(raw)).toThrow(/choices: above-operational-maximum/);
    });

    test("multiple-choice options that normalize alike reject", () => {
        const raw = validScenarioRaw();
        // `probeIdentity` canonicalizes option spellings before comparing answers.
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
        // Probes with the same question, gold answer, and backing claim ask one question.
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
        // Probes run in one session, so an earlier exchange can answer a later probe with the same gold value.
        probes.push({
            ...probes[0],
            id: "probe-capacity-of-lru",
            sourceClaimRef: "exp-lru-cache",
            goldAnswer: "in-process lru cache",
        });
        // The backing claim differentiates probes with the same question and gold answer.
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

describe("gold and probe freeze guards", () => {
    test("rejects two probes sharing an answer value even on different claims", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // When probes share a gold value, the earlier response places the later answer in recent history regardless of backing claim.
        probes.push({
            id: "probe-other-4096",
            question: "How many entries does the cache hold?",
            answerType: "exact",
            goldAnswer: "4096",
            sourceClaimRef: "exp-lru-cache",
        });
        expect(() => parseScenario(raw)).toThrow(/shared-answer-surface/);
    });

    test("rejects two choices that differ only by XML encoding", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // `compareProbeAnswer` decodes option spellings before comparing them.
        probes.push({
            id: "probe-encoded-choices",
            question: "Which marker was used?",
            answerType: "multiple-choice",
            choices: ["A&B", "A&amp;B"],
            goldAnswer: "A&B",
            sourceClaimRef: "exp-cache-capacity",
        });
        expect(() => parseScenario(raw)).toThrow(/choices/);
    });

    test("rejects a multiple-choice option that exposes another claim's exact answer", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The option list would reveal probe-capacity's gold value.
        probes.push({
            id: "probe-capacity-choice",
            question: "Which capacity was configured?",
            answerType: "multiple-choice",
            choices: ["4096", "8192"],
            goldAnswer: "8192",
            sourceClaimRef: "exp-lru-cache",
        });
        expect(() => parseScenario(raw)).toThrow(/shared-answer-surface/);
    });

    test("rejects two claim-id probes whose same-category claims one promotion can satisfy", () => {
        const raw = validScenarioRaw();
        (raw.gold as { expectedClaims: Record<string, unknown>[] }).expectedClaims.push({
            id: "exp-eviction",
            category: "ARCHITECTURE",
            predicate: { kind: "normalized-substring", value: "TTL eviction" },
            sourceTurnRange: [0, 0],
        });
        (raw.probes as Record<string, unknown>[]).push({
            id: "probe-claim-eviction",
            question: "Which claim records the eviction policy?",
            answerType: "claim-id",
            expectedClaimRef: "exp-eviction",
        });
        expect(() => parseScenario(raw)).toThrow(/claim-id-co-resolvable/);
    });

    test("accepts two claim-id probes on different categories", () => {
        const raw = validScenarioRaw();
        (raw.probes as Record<string, unknown>[]).push({
            id: "probe-claim-capacity",
            question: "Which claim records the capacity?",
            answerType: "claim-id",
            expectedClaimRef: "exp-cache-capacity",
        });
        expect(() => parseScenario(raw)).not.toThrow();
    });

    test("rejects two claim-id probes on one claim, whose runtime answer is identical", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        probes.push({
            id: "probe-claim-again",
            question: "Which claim id records the cache architecture?",
            answerType: "claim-id",
            expectedClaimRef: "exp-lru-cache",
        });
        expect(() => parseScenario(raw)).toThrow(/shared-answer-surface/);
    });

    test("rejects two probes on one claim whose answer surfaces overlap", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        probes.push({
            id: "probe-store-exact",
            question: "Name the cache that backs sessions.",
            answerType: "exact",
            goldAnswer: "in-process lru",
            sourceClaimRef: "exp-lru-cache",
        });
        expect(() => parseScenario(raw)).toThrow(/shared-answer-surface/);
    });

    test("accepts an exact and a claim-id probe on one claim, whose answers cannot substitute", () => {
        expect(() => parseScenario(validScenarioRaw())).not.toThrow();
    });

    test("rejects an earlier answer value that contains a later probe's answer", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The scenario is invalid because an earlier accepted response states the later gold answer `4096` despite disjoint answer surfaces.
        // The scenario is invalid because an earlier accepted response states the later gold answer `4096` despite disjoint answer surfaces.
        // The scenario is invalid because an earlier accepted response states the later gold answer `4096` despite disjoint answer surfaces.
        probes.unshift({
            id: "probe-limit-phrase",
            question: "How was the cap described?",
            answerType: "exact",
            goldAnswer: "limit 4096 bytes",
            sourceClaimRef: "exp-cache-capacity",
        });
        expect(() => parseScenario(raw)).toThrow(/shared-answer-surface/);
    });

    test("accepts a containing answer value when it runs LAST", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The scenario is valid because the response containing the gold value follows the exposed probe and is absent from that probe's history.
        probes.push({
            id: "probe-limit-phrase",
            question: "How was the cap described?",
            answerType: "exact",
            goldAnswer: "limit 4096 bytes",
            sourceClaimRef: "exp-cache-capacity",
        });
        expect(() => parseScenario(raw)).not.toThrow();
    });

    test("a containing value is matched as a complete value, not a substring", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The earlier answer is "4096", so a substring match would incorrectly treat it as the complete value "409".
        probes.unshift({
            id: "probe-limit-phrase",
            question: "How was the cap described?",
            answerType: "exact",
            goldAnswer: "limit 4096 bytes",
            sourceClaimRef: "exp-cache-capacity",
        });
        (probes.find((probe) => probe.id === "probe-capacity") as Record<string, unknown>).goldAnswer = "409";
        expect(() => parseScenario(raw)).not.toThrow();
    });

    test("rejects an earlier probe whose question states a later probe's answer", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The gold answers "yes" and "4096" do not overlap, but the earlier question places "4096" in the later probe's session history.
        // resumed session.
        probes.unshift({
            id: "probe-capacity-confirm",
            question: "Was the session cache capacity set to 4096 entries?",
            answerType: "multiple-choice",
            choices: ["yes", "no"],
            goldAnswer: "yes",
            sourceClaimRef: "exp-cache-capacity",
        });
        expect(() => parseScenario(raw)).toThrow(/question-exposed-answer/);
    });

    test("accepts the same pair when the exposing question runs LAST", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The parser accepts the pair because the exposing question runs after the probe and is absent from its history.
        // The parser accepts the pair because the exposing question runs after the probe and is absent from its history.
        probes.push({
            id: "probe-capacity-confirm",
            question: "Was the session cache capacity set to 4096 entries?",
            answerType: "multiple-choice",
            choices: ["yes", "no"],
            goldAnswer: "yes",
            sourceClaimRef: "exp-cache-capacity",
        });
        expect(() => parseScenario(raw)).not.toThrow();
    });

    test("rejects a multiple-choice question that points at its own correct option", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The question names the gold option without restating every choice, but it still exposes the correct selection.
        probes.push({
            id: "probe-store-steered",
            question: "memcached is correct; which cache was rejected second?",
            answerType: "multiple-choice",
            choices: ["memcached", "hazelcast"],
            goldAnswer: "memcached",
            sourceClaimRef: "exp-lru-cache",
        });
        expect(() => parseScenario(raw)).toThrow(/self-answering/);
    });

    test("rejects a self-answering multiple-choice question that names every option too", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The question names every choice and identifies the correct one, so it exposes its own gold answer.
        probes.push({
            id: "probe-store-steered-all",
            question: "memcached, not hazelcast, is correct; which cache was rejected second?",
            answerType: "multiple-choice",
            choices: ["memcached", "hazelcast"],
            goldAnswer: "memcached",
            sourceClaimRef: "exp-lru-cache",
        });
        expect(() => parseScenario(raw)).toThrow(/self-answering/);
    });

    test("a multiple-choice question that names no option value freezes", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // Multiple-choice prompts render `Choose exactly one of: ...`, so questions need not repeat choice values.
        probes.push({
            id: "probe-store-clean",
            question: "Which cache was rejected second?",
            answerType: "multiple-choice",
            choices: ["memcached", "hazelcast"],
            goldAnswer: "memcached",
            sourceClaimRef: "exp-lru-cache",
        });
        expect(() => parseScenario(raw)).not.toThrow();
    });

    test("probe diagnostics name the failure class and ids, never the answer text", () => {
        // Diagnostics never echo artifact values, preventing freeze logs and CI transcripts from leaking corpus content.
        const selfAnswering = validScenarioRaw();
        (selfAnswering.probes as Record<string, unknown>[])[0].question = "What limit was set to 4096?";
        expect(() => parseScenario(selfAnswering)).toThrow(/self-answering/);
        expect(() => parseScenario(selfAnswering)).not.toThrow(/4096/);

        // The test uses digit-free probe IDs because diagnostics may echo IDs; an ID containing the value would confound the assertion.
        const sharedSurface = validScenarioRaw();
        (sharedSurface.probes as Record<string, unknown>[]).push({
            id: "probe-capacity-again",
            question: "How many entries does the cache hold?",
            answerType: "exact",
            goldAnswer: "4096",
            sourceClaimRef: "exp-lru-cache",
        });
        expect(() => parseScenario(sharedSurface)).toThrow(/shared-answer-surface/);
        expect(() => parseScenario(sharedSurface)).not.toThrow(/4096/);
    });

    test("a question stating the ESCAPED form of its own answer is still self-answering", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // `compareProbeAnswer` accepts `A&amp;B` for authored `A&B`; `containsCompleteValue` must canonicalize escaped forms too.
        // `containsCompleteValue` canonicalizes escaped forms, so prompts cannot contain values accepted by `compareProbeAnswer`.
        probes.push({
            id: "probe-escaped-self",
            question: "The marker is A&amp;B — what is the marker?",
            answerType: "exact",
            goldAnswer: "A&B",
            sourceClaimRef: "exp-cache-capacity",
        });
        expect(() => parseScenario(raw)).toThrow(/self-answering/);
    });

    test("an oversized numeric entity is refused, not a thrown RangeError", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // `String.fromCodePoint` throws for invalid code points, so the decoder leaves entities that name no character unchanged.
        probes.push({
            id: "probe-bad-entity",
            question: "What does &#999999999; denote?",
            answerType: "exact",
            goldAnswer: "nothing",
            sourceClaimRef: "exp-cache-capacity",
        });
        expect(() => parseScenario(raw)).not.toThrow(/RangeError|Invalid code point/);
    });

    test("rejects an exact probe whose question states its own gold answer", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The rewarded value appears in the prompt, so a correct reply cannot prove injected-memory recall.
        probes.push({
            id: "probe-capacity-restated",
            question: "The capacity is 4096 entries — what is the session cache capacity?",
            answerType: "exact",
            goldAnswer: "4096",
            sourceClaimRef: "exp-cache-capacity",
        });
        expect(() => parseScenario(raw)).toThrow(/self-answering/);
    });

    test("a question that shares only a digit prefix with an answer is not exposure", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // Because `probe-capacity-confirm` follows `probe-capacity`, it cannot expose `4096` to `probe-capacity`.
        probes.push({
            id: "probe-capacity-confirm",
            question: "Was the session cache capacity set to 4096 entries?",
            answerType: "multiple-choice",
            choices: ["yes", "no"],
            goldAnswer: "yes",
            sourceClaimRef: "exp-cache-capacity",
        });
        // Bare-substring matching would reject the pair because "4096" contains "4"; no source turn states "4" as a complete value.
        probes.push({
            id: "probe-replica-count",
            question: "How many cache replicas were configured?",
            answerType: "exact",
            goldAnswer: "4",
            sourceClaimRef: "exp-lru-cache",
        });
        expect(() => parseScenario(raw)).not.toThrow();
    });

    test("rejects same-category predicate subsumption, which credits one fact to two golds", () => {
        const raw = validScenarioRaw();
        // A claim matching "in-process LRU cache" also matches "LRU cache", so one fact would satisfy two same-category gold claims.
        // The overlapping predicates produce 2/2 recall.
        (raw.gold as { expectedClaims: Record<string, unknown>[] }).expectedClaims.push({
            id: "exp-lru-short",
            category: "ARCHITECTURE",
            predicate: { kind: "normalized-substring", value: "LRU cache" },
            sourceTurnRange: [1, 1],
        });
        expect(() => parseScenario(raw)).toThrow(/subsumed-predicate/);
    });

    test("accepts a same-predicate pair under different categories", () => {
        const raw = validScenarioRaw();
        (raw.gold as { expectedClaims: Record<string, unknown>[] }).expectedClaims.push({
            id: "exp-lru-constraint",
            category: "CONSTRAINTS",
            predicate: { kind: "normalized-substring", value: "in-process LRU cache" },
            sourceTurnRange: [1, 1],
        });
        expect(() => parseScenario(raw)).not.toThrow();
    });

    test("rejects a gold answer the answer envelope cannot carry", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        probes[0].goldAnswer = "4096</answer>y";
        expect(() => parseScenario(raw)).toThrow(/answer-envelope-delimiter/);
    });

    test("rejects a choice containing the option separator the prompt renders with", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The rendering `A | B | C` does not reveal whether it represents two options or three.
        probes[1].choices = ["A | B", "in-process lru"];
        probes[1].goldAnswer = "in-process lru";
        expect(() => parseScenario(raw)).toThrow(/choice-separator/);
    });

    test("rejects a delimiter-bearing multiple-choice option, not only the gold one", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        probes[1].choices = ["redis</answer>", "in-process lru"];
        expect(() => parseScenario(raw)).toThrow(/answer-envelope-delimiter/);
    });
});

describe("lintScenario probe backing", () => {
    test("flags a probe answer the backing gold claim does not require", () => {
        const raw = validScenarioRaw();
        const gold = raw.gold as { expectedClaims: Array<{ id: string; predicate: { value: string } }> };
        // Claims authored in the source range do not trigger `not-authored-in-source-range`.
        // A claim can satisfy the predicate without carrying the probe's answer.
        // The historian can receive full recall although no injected claim contains the probe answer, producing the excluded `error-trimmed` probe tier instead of an extraction failure.
        gold.expectedClaims[0].predicate.value = "in-process";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics.some((entry) => /probe-store\.goldAnswer: not-required-by-exp-lru-cache/.test(entry))).toBe(
            true,
        );
    });

    test("the reference scenario requires every probe answer in its backing claim", () => {
        expect(lintScenario(parseScenario(validScenarioRaw()))).toEqual([]);
    });
});

describe("lintScenario", () => {
    test("flags a trigger recipe whose build turns cross the execution threshold", () => {
        const raw = validScenarioRaw();
        // The historian would launch during filler or authored turns before `driveHistorianRun` starts counting, misaligning run rows with scripted outputs.
        (raw.trigger as Record<string, unknown>).usageTokensPerTurn = 100_000;
        const diagnostics = lintScenario(parseScenario(raw));
        expect(
            diagnostics.some((entry) => entry.includes("build-turn-crosses-threshold")),
        ).toBe(true);
    });

    test("flags a recipe whose padding cannot clear the protected tail within the cap", () => {
        const raw = validScenarioRaw();
        // Capped padding turns cannot clear the protected tail when `ballastTokensPerTurn` is 1.
        // Capped padding cannot clear the protected tail, causing `run-never-fired` or `probe-gold-uncovered`.
        (raw.trigger as Record<string, unknown>).ballastTokensPerTurn = 1;
        const diagnostics = lintScenario(parseScenario(raw));
        expect(
            diagnostics.some((entry) => entry.includes("padding-cannot-clear-protected-tail")),
        ).toBe(true);
    });

    test("flags a trigger recipe whose spike never crosses the execution threshold", () => {
        const raw = validScenarioRaw();
        // A spike below 40% never launches a run, so the scenario ends as `run-never-fired`.
        // run-never-fired.
        (raw.trigger as Record<string, unknown>).spikeUsageTokens = 10_000;
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics.some((entry) => entry.includes("spike-below-threshold"))).toBe(true);
    });

    test("accepts a well-formed scenario carrying each of the seven hard-negative families", () => {
        const raw = validScenarioRaw();
        raw.families = [...HARD_NEGATIVE_FAMILIES];
        // Each hard-negative predicate must match a formation in the pre-epilogue transcript.
        // A hard-negative predicate with no pre-epilogue formation passes its absence check vacuously.
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
        // The gold predicate's `LRU cache` normalized substring matches `in-process LRU cache`.
        // Any content satisfying the gold predicate also matches the forbidden formation.
        // The scenario cannot pass because gold-predicate matches also match the forbidden formation.
        (raw.gold as { expectedAbsent: Array<{ predicate: { value: string } }> }).expectedAbsent[0].predicate.value =
            "LRU cache";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.gold.expectedAbsent.abs-redis-active: contradicts-exp-lru-cache",
        );
    });

    test("rejects a compartment minCount above the transcript's message capacity", () => {
        const raw = validScenarioRaw();
        // Four turns contain eight messages, so a nine-message compartment cannot fit within them.
        (raw.gold as { compartments: { minCount: number } }).compartments.minCount = 9;
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics.some((d) => d.includes("minCount: exceeds-message-capacity"))).toBe(true);
    });

    test("rejects a gold claim whose predicate is absent from its declared source range", () => {
        const raw = validScenarioRaw();
        // `[1,1]` is the LRU-cache decision turn, and it contains the authored value `4096`.
        // `[1,1]` is the leakage gate's guarded range and the scorer's fact-origin range.
        // The predicate matches only text outside `sourceTurnRange`, so no in-range turn can establish the fact origin.
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
        // Discarding the last turn can hide the formation from the historian, allowing the absence check to pass without evaluating it.
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.gold.expectedAbsent.abs-redis-active.predicate: not-authored-before-epilogue",
        );
    });

    // Each row swaps in one gold answer for the FIRST probe (probe-capacity,
    // which runs before any prompt suffix has rendered) and checks whether the
    // harness-owned-text lint rejects it. Rejected rows prove the surface covers
    // a given harness text source; accepted rows pin the deliberate holes.
    test.each([
        // "boundary" is in `ballastProse`'s word bank, so every filler, authored,
        // padding, and spike turn states it. The post-epilogue padding sits in the
        // protected tail, which is never compartment-covered and so never spliced
        // out — the probe model can read the answer off raw history and PASS with
        // the injected payload contributing nothing. Both runtime gates are scoped
        // to the authored gold range and cannot see it.
        ["rejects a probe gold answer the harness's own ballast emits", "boundary", true],
        // Not only ballast: the runner's padding turns say "Housekeeping
        // acknowledged." verbatim, and those turns are the protected tail.
        ["rejects a probe gold answer the harness's own turn text states", "housekeeping", true],
        // The runner numbers every padding turn — `Wrap-up housekeeping note 3.` —
        // and those turns are the protected tail. A bare "3" is therefore stated in
        // raw history the probe can read, and a surface that rendered index 1 alone
        // would not see it.
        ["rejects a probe gold answer that collides with a generated padding index", "3", true],
        // The canonical recipe needs ten padding turns, so the last one says
        // "Wrap-up housekeeping note 10." A surface built from a fixed sample of
        // indices rather than from `paddingTurnCount()`'s own arithmetic would stop
        // short and miss it. Run indices are rendered the same way ("step 1",
        // "step 2"), but the canonical recipe's two runs fall inside the padding
        // range, so no value separates the two sources here.
        ["the generated-index surface spans every padding turn the runner sends", "10", true],
        // `buildProbePrompt` writes "Question: <authored question>", so a gold answer of
        // "question" is supplied by the very prompt being answered. The label was the one
        // piece of the wrapper still written as a literal rather than a linted constant.
        ["rejects a probe gold answer the prompt's question label states", "question", true],
        // probe-capacity runs FIRST, so no `Choose exactly one of:` has been sent when it
        // is asked and "choose" is in nothing its history carries. Refusing here would
        // keep a valid scenario out of the corpus on text the session never held.
        ["an exact probe is not rejected for a suffix no EARLIER prompt rendered", "choose", false],
        // "memory" is in the shared boilerplate every probe's prompt carries, so the
        // per-probe-type surface split must not narrow it out.
        ["shared prompt wording is still checked for every probe type", "memory", true],
        // The bank emits "session", never "sessio". Bare containment would refuse a
        // legitimate answer here; the check matches complete values.
        ["a gold answer merely contained in a harness word is not a collision", "sessio", false],
    ] as Array<[string, string, boolean]>)("%s", (_title, goldAnswer, rejected) => {
        const raw = validScenarioRaw();
        (raw.probes as Record<string, unknown>[])[0].goldAnswer = goldAnswer;
        const diagnostics = lintScenario(parseScenario(raw));
        const expectation = expect(diagnostics);
        (rejected ? expectation : expectation.not).toContain(
            "hse-auth-rejected-redis.probes.probe-capacity.goldAnswer: occurs-in-harness-owned-text",
        );
    });

    test("rejects a gold answer an EARLIER probe's suffix already rendered", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The exact probe runs after the multiple-choice probe.
        // `Choose exactly one of:` is in the resumed session's raw history when the exact probe runs.
        // The ordered surface contains every suffix rendered before the exact probe.
        probes.push({
            id: "probe-choose-word",
            question: "Which verb did the instructions use?",
            answerType: "exact",
            goldAnswer: "choose",
            sourceClaimRef: "exp-cache-capacity",
        });
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.probes.probe-choose-word.goldAnswer: occurs-in-harness-owned-text",
        );
    });

    test("rejects a gold answer an earlier claim-id prompt's suffix rendered", () => {
        const raw = validScenarioRaw();
        const probes = raw.probes as Record<string, unknown>[];
        // The canonical scenario's third probe, claim-id, includes the suffix `the identifier before the colon`.
        // A later exact probe can answer `identifier` from that suffix in its history.
        probes.push({
            id: "probe-identifier-word",
            question: "What did the instructions call the id?",
            answerType: "exact",
            goldAnswer: "identifier",
            sourceClaimRef: "exp-cache-capacity",
        });
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.probes.probe-identifier-word.goldAnswer: occurs-in-harness-owned-text",
        );
    });

    test("a multiple-choice probe IS rejected for its own prompt's choice wording", () => {
        const raw = validScenarioRaw();
        // The claim-id prompt renders `identifier`, so the lint must check it.
        const probes = raw.probes as Record<string, unknown>[];
        const store = probes.find((probe) => probe.id === "probe-store") as Record<string, unknown>;
        store.choices = ["choose", "memcached"];
        store.goldAnswer = "choose";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.probes.probe-store.goldAnswer: occurs-in-harness-owned-text",
        );
    });

    test("an oversized probe question is a named diagnostic, not a regex blow-up", () => {
        const raw = validScenarioRaw();
        (raw.probes as Record<string, unknown>[])[0].question = "x".repeat(20_001);
        expect(() => parseScenario(raw)).toThrow(/question: above-operational-maximum/);
    });

    test("an oversized probe answer is a named diagnostic, not a regex blow-up", () => {
        const raw = validScenarioRaw();
        // Escaping each answer prevents regex metacharacters from changing all-pairs matching.
        // The parser rejects oversized answers before all-pairs scanning.
        (raw.probes as Record<string, unknown>[])[0].goldAnswer = "y".repeat(2_001);
        expect(() => parseScenario(raw)).toThrow(/goldAnswer: above-operational-maximum/);
    });

    test("rejects a probe gold answer absent from its claim's source range", () => {
        const raw = validScenarioRaw();
        // A frozen probe with `goldAnswer` `2048` would reward a hallucinated answer and reject the transcript-supported `4096`.
        (raw.probes as Record<string, unknown>[])[0].goldAnswer = "2048";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.probes.probe-capacity.goldAnswer: not-authored-in-source-range",
        );
    });

    test("a probe gold answer is checked against its own claim's range, not the whole transcript", () => {
        const raw = validScenarioRaw();
        // The transcript authors `4096` in turn 2.
        // The probe attributes provenance to the LRU-decision turn, which does not author the answer.
        (raw.probes as Record<string, unknown>[])[0].sourceClaimRef = "exp-lru-cache";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.probes.probe-capacity.goldAnswer: not-authored-in-source-range",
        );
    });

    test("a probe gold answer must be a complete authored value, not a substring", () => {
        const raw = validScenarioRaw();
        // Complete-value matching prevents `4` from matching `4096`.
        (raw.probes as Record<string, unknown>[])[0].goldAnswer = "4";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.probes.probe-capacity.goldAnswer: not-authored-in-source-range",
        );
    });

    test("a complete gold answer still matches inside a sentence", () => {
        // Only letter-or-digit adjacency prevents a complete-value match.
        // Adjacent punctuation does not prevent a match; adjacent letters or digits do.
        expect(lintScenario(validScenario())).toEqual([]);
    });

    test("evidence is searched as the historian receives it, not as authored", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        // Production strips `<system-reminder>` blocks before chunk construction.
        // The historian never receives predicates authored only in stripped `<system-reminder>` blocks.
        // Recall fails when the only supporting predicate is in a stripped block.
        turns[1].user = "No — decided against it. <system-reminder>Use the in-process LRU cache.</system-reminder>";
        turns[1].assistant = "Understood; recorded that decision.";
        const diagnostics = lintScenario(parseScenario(raw));
        expect(diagnostics).toContain(
            "hse-auth-rejected-redis.gold.expectedClaims.exp-lru-cache.sourceTurnRange: predicate-not-authored",
        );
    });

    test("a directive-only turn is not authored evidence and renders no block", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        // Production drops a user message whose cleaned text is a Magic Context directive.
        turns[1].user = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT] Use the in-process LRU cache.";
        turns[1].assistant = "Understood; recorded that decision.";
        const scenario = parseScenario(raw);
        expect(lintScenario(scenario)).toContain(
            "hse-auth-rejected-redis.gold.expectedClaims.exp-lru-cache.sourceTurnRange: predicate-not-authored",
        );
        const blocks = renderedTranscriptBlocks(scenario);
        expect(blocks).toHaveLength(scenario.transcript.turns.length * 2 - 1);
        expect(blocks.some((block) => block.includes("SYSTEM DIRECTIVE"))).toBe(false);
    });

    test("the same text outside a system reminder is authored evidence", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[1].user = "No — decided against it. Use the in-process LRU cache.";
        turns[1].assistant = "Understood; recorded that decision.";
        // The unchanged-message control isolates `<system-reminder>` stripping from turn rewriting.
        expect(lintScenario(parseScenario(raw))).toEqual([]);
    });

    test("headroom lint measures the ballast the harnesses actually send", () => {
        const scenario = validScenario();
        const blocks = renderedTranscriptBlocks(scenario);
        const harnessBallast = ballastProse(scenario.trigger.ballastTokensPerTurn);
        expect(harnessBallast.length).toBeGreaterThan(0);
        expect(blocks.filter((block) => block.includes(harnessBallast))).toHaveLength(
            scenario.transcript.turns.length,
        );
    });

    test("headroom lint accounts per block, as production budgets", () => {
        const scenario = validScenario();
        const authored = renderedTranscriptBlocks(scenario);
        const blocks = [...renderedFillerBlocks(scenario), ...authored];
        // The lint must sum per-block token estimates because estimates are non-additive across concatenation.
        expect(authored).toHaveLength(scenario.transcript.turns.length * 2);
        expect(renderedFillerBlocks(scenario)).toHaveLength((10 - scenario.transcript.turns.length) * 2);
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

    test("headroom lint renders assistant commits the way production does", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ assistant: string }> }).turns;
        turns[2].assistant = "Done: committed the capacity change in a1b2c3d4e5.";
        const blocks = renderedTranscriptBlocks(parseScenario(raw));
        const block = blocks.find((candidate) => candidate.includes("capacity change"));
        // `compactTextForSummary` removes the hash from prose.
        // `formatBlock` appends the hash as a `commits:` suffix.
        // `commitHashes: []` and unprocessed text produce different bytes.
        expect(block).toContain("commits: a1b2c3d4e5");
        expect(block).not.toContain("in a1b2c3d4e5");
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

describe("complete-value counting", () => {
    test("counts occurrences by starting position, including overlaps", () => {
        // A consuming global match reports one here, which would let a caller
        // comparing counts across a perturbation miss the loss of an occurrence.
        expect(countCompleteValues("blue blue blue", "blue blue")).toBe(2);
        expect(countCompleteValues("blue blue blue", "blue")).toBe(3);
        expect(countCompleteValues("4096 entries", "4")).toBe(0);
        expect(countCompleteValues("", "blue")).toBe(0);
        expect(containsCompleteValue("blue blue blue", "blue blue")).toBe(true);
    });

    test("boundaries are code points, not code units", () => {
        // A single `charAt` on an astral letter returns one surrogate half, which is
        // not a letter under the boundary rule, so the match would have looked clean.
        expect(containsCompleteValue("\u{10400}foo", "foo")).toBe(false);
        expect(containsCompleteValue("foo\u{10400}", "foo")).toBe(false);
        expect(countCompleteValues("\u{10400}foo foo", "foo")).toBe(1);
        expect(containsCompleteValue("a foo b", "foo")).toBe(true);
    });

    test("stays linear against a repetitive haystack", () => {
        // A regex advanced one character at a time re-derives every overlapping
        // match, which turned a long answer against a megabyte of repetition into
        // seconds. Both sizes are inside the contract's own limits.
        const haystack = "a ".repeat(500_000);
        const needle = "a ".repeat(1_000).trim();
        const start = performance.now();
        expect(countCompleteValues(haystack, needle)).toBeGreaterThan(0);
        expect(containsCompleteValue(haystack, needle)).toBe(true);
        expect(performance.now() - start).toBeLessThan(900);
    });
});

describe("compacted evidence view", () => {
    test("two spellings of one commit hash reach the historian identically", () => {
        const turn = (hash: string) => ({
            user: "Status check.",
            assistant: `Committed ${hash} for the record.`,
        });
        const [upper] = compactedEvidenceMessages([turn("ABCDEF1")]).slice(-1);
        const [lower] = compactedEvidenceMessages([turn("abcdef1")]).slice(-1);
        expect(upper!.text).toBe(lower!.text);
        // Ordinary identifier case is still significant.
        expect(compactedEvidenceMessages([{ user: "MyFile.ts here.", assistant: "ok" }])[0]!.text)
            .not.toBe(
                compactedEvidenceMessages([{ user: "myfile.ts here.", assistant: "ok" }])[0]!.text,
            );
    });
});

describe("authored evidence views", () => {
    test("the normalized messages join back to the evidence text a predicate is matched against", () => {
        const scenario = validScenario();
        const messages = normalizedEvidenceMessages(scenario.transcript.turns);
        expect(messages.map((message) => message.text).join(" ")).toBe(
            normalizeContent(authoredEvidenceText(scenario.transcript.turns)),
        );
    });

    test("a match no single message contains is spanned by both of its messages", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[0] = { user: "Should we keep the legacy", assistant: "bridge alive for now?" };
        const scenario = parseScenario(raw);
        const predicate = { kind: "normalized-substring", value: "legacy bridge" } as const;

        expect(predicateMatches(predicate, authoredEvidenceText(scenario.transcript.turns))).toBe(true);
        expect(predicateMatches(predicate, turns[0]!.user)).toBe(false);
        expect(predicateMatches(predicate, turns[0]!.assistant)).toBe(false);

        const messages = normalizedEvidenceMessages(scenario.transcript.turns);
        const evidence = messages.map((message) => message.text).join(" ");
        const at = evidence.indexOf(normalizeContent(predicate.value));
        let offset = 0;
        const spanned = messages.flatMap((message) => {
            const start = offset;
            offset += message.text.length + 1;
            return start < at + predicate.value.length && at < start + message.text.length
                ? [`${message.turnIndex}:${message.role}`]
                : [];
        });
        expect(spanned).toEqual(["0:user", "0:assistant"]);
    });

    test("messages production discards carry no evidence", () => {
        const raw = validScenarioRaw();
        const turns = (raw.transcript as { turns: Array<{ user: string; assistant: string }> }).turns;
        turns[3]!.user = "<system-reminder>internal directive</system-reminder>";
        const scenario = parseScenario(raw);

        expect(
            normalizedEvidenceMessages(scenario.transcript.turns).some(
                (message) => message.turnIndex === 3 && message.role === "user",
            ),
        ).toBe(false);
    });
});

describe("release tuple and manifest", () => {
    test("release tuple is order-independent over the corpus", () => {
        const a = validScenario();
        const rawB = validScenarioRaw();
        rawB.id = "hse-second-scenario";
        // The tuple rejects semantically duplicate scenarios regardless of ID; changing an epilogue turn preserves gold ranges and predicates.
        (rawB.transcript as { turns: Array<{ user: string }> }).turns[3].user = "That is all for today.";
        const b = parseScenario(rawB);
        expect(buildReleaseTuple([a, b])).toEqual(buildReleaseTuple([b, a]));
    });

    test("release tuple rejects an empty corpus", () => {
        expect(() => buildReleaseTuple([])).toThrow(/releaseTuple\.scenarios: empty/);
    });

    test("release tuple rejects a scenario copied under a new id", () => {
        const a = validScenario();
        const rawCopy = validScenarioRaw();
        rawCopy.id = "hse-auth-rejected-redis-copy";
        rawCopy.title = "A relabelled copy of the same evaluation";
        const copy = parseScenario(rawCopy);
        expect(scenarioFingerprint(copy)).not.toBe(scenarioFingerprint(a));
        expect(() => buildReleaseTuple([a, copy])).toThrow(/releaseTuple\.scenarios\.semantic: duplicate/);
    });

    test("reordering set-like arrays does not hide a copied scenario", () => {
        const a = validScenario();
        const rawCopy = validScenarioRaw();
        rawCopy.id = "hse-auth-rejected-redis-permuted";
        rawCopy.title = "The same evaluation with its arrays permuted";
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
        (rawCopy.gold as { expectedClaims: Array<{ predicate: { value: string } }> }).expectedClaims[0].predicate.value =
            "  IN-PROCESS   lru   Cache ";
        const copy = parseScenario(rawCopy);
        expect(() => buildReleaseTuple([a, copy])).toThrow(/releaseTuple\.scenarios\.semantic: duplicate/);
    });

    test("renumbering contract-local ids does not hide a copied scenario", () => {        const a = validScenario();
        const rawCopy = validScenarioRaw();
        rawCopy.id = "hse-auth-rejected-redis-renumbered";
        rawCopy.title = "The same evaluation with every local id renamed";
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

    test("a later release cannot drop a predecessor's tombstone", () => {
        const tuple = buildReleaseTuple([validScenario()]);
        const manifest = (releaseVersion: string, tombstones: string[]) => {
            const releaseFingerprint = releaseApprovalFingerprint({ releaseVersion, releaseTuple: tuple, tombstones });
            return parseManifest({
                schema: MANIFEST_SCHEMA,
                releaseVersion,
                releaseTuple: tuple,
                approvals: {
                    privacy: { kind: "privacy", approver: "operator-a", releaseFingerprint },
                    goldIntent: { kind: "gold-intent", approver: "operator-b", releaseFingerprint },
                },
                tombstones,
            });
        };
        const v1 = manifest("v1", ["hse-known-wrong", "hse-also-wrong"]);
        const resurrects = manifest("v2", ["hse-also-wrong"]);
        expect(() => assertReleaseSuccession(v1, resurrects)).toThrow(
            /releaseSuccession\.tombstones: dropped-hse-known-wrong/,
        );

        const carriesForward = manifest("v2", ["hse-known-wrong", "hse-also-wrong", "hse-newly-wrong"]);
        expect(() => assertReleaseSuccession(v1, carriesForward)).not.toThrow();

        expect(() => assertReleaseSuccession(carriesForward, v1)).toThrow(/not-later-than-previous/);
        expect(() => assertReleaseSuccession(v1, v1)).toThrow(/not-later-than-previous/);
    });

    test("a historical predecessor stays readable across a policy rotation", () => {
        const rotated = {
            schema: MANIFEST_SCHEMA,
            releaseVersion: "v1",
            releaseTuple: {
                corpusFingerprint: "a".repeat(64),
                scenarioSchemaVersion: SCENARIO_SCHEMA,
                privacyPolicyVersion: "retired-policy-v0",
                sanitizerVersion: "retired-sanitizer-v0",
            },
            approvals: {
                privacy: { kind: "privacy", approver: "operator-a", releaseFingerprint: "b".repeat(64) },
                goldIntent: { kind: "gold-intent", approver: "operator-b", releaseFingerprint: "b".repeat(64) },
            },
            tombstones: ["hse-known-wrong"],
        };
        expect(() => parseManifest(rotated)).toThrow(/privacyPolicyVersion: version-invalid/);

        const previous = parseReleaseLineage(rotated);
        expect(previous.tombstones).toEqual(["hse-known-wrong"]);
        expect(() =>
            assertReleaseSuccession(previous, { releaseVersion: "v2", tombstones: ["hse-known-wrong"] }),
        ).not.toThrow();
        expect(() => assertReleaseSuccession(previous, { releaseVersion: "v2", tombstones: [] })).toThrow(
            /dropped-hse-known-wrong/,
        );
    });

    test("lineage parsing still rejects a malformed predecessor", () => {
        expect(() => parseReleaseLineage({ schema: "wrong", releaseVersion: "v1", tombstones: [] })).toThrow(
            /schema: version-invalid/,
        );
        expect(() => parseReleaseLineage({ schema: MANIFEST_SCHEMA, releaseVersion: "1", tombstones: [] })).toThrow(
            /releaseVersion: version-invalid/,
        );
        expect(() =>
            parseReleaseLineage({ schema: MANIFEST_SCHEMA, releaseVersion: "v1", tombstones: ["nope"] }),
        ).toThrow(/tombstones\[0\]: id-invalid/);
    });

    test("a release cannot publish and retire the same scenario", () => {
        const scenario = validScenario();
        expect(() =>
            assertTombstonesRetired([scenario], { releaseVersion: "v2", tombstones: [scenario.id] }),
        ).toThrow(/releaseTombstones\.scenarios: still-published-hse-auth-rejected-redis/);
        expect(() =>
            assertTombstonesRetired([scenario], { releaseVersion: "v2", tombstones: ["hse-retired-elsewhere"] }),
        ).not.toThrow();
    });

    test("privacy and sanitizer versions must be the ones the lane implements", () => {        const tuple = buildReleaseTuple([validScenario()]);
        for (const key of ["privacyPolicyVersion", "sanitizerVersion"] as const) {
            // The check must validate the manifest version independently of its fingerprint binding.
            // A fingerprint with an invented version approves an unenforced policy.
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

describe("parseModelRoute", () => {
    test("accepts provider/model and keeps a slash-bearing model id intact", () => {
        expect(parseModelRoute("HISTORIAN_EVAL_MODEL", "anthropic/claude-sonnet-4-5")).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-5",
        });
        expect(parseModelRoute("HISTORIAN_EVAL_MODEL", "openrouter/vendor/model-1")).toEqual({
            providerID: "openrouter",
            modelID: "vendor/model-1",
        });
    });

    test("trims surrounding whitespace off both components", () => {
        // OpenCode receives these strings as model identifiers.
        // OpenCode cannot resolve the provider ID "anthropic " because of its trailing space.
        expect(parseModelRoute("HISTORIAN_EVAL_MODEL", "anthropic / claude-sonnet-4-5")).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-5",
        });
        // parseModelRoute must trim each segment independently; trimming the joined model identifier leaves padding around interior slashes.
        // The route otherwise fails at provider dispatch instead of in `parseModelRoute`.
        expect(parseModelRoute("HISTORIAN_EVAL_MODEL", "openrouter / vendor / model-1")).toEqual({
            providerID: "openrouter",
            modelID: "vendor/model-1",
        });
    });

    test.each([
        ["empty model component", "anthropic/"],
        ["whitespace model component", "anthropic/   "],
        ["empty provider component", "/claude-sonnet-4-5"],
        ["no separator", "claude-sonnet-4-5"],
        ["empty value", ""],
        // Checking only `modelParts.join("/")` accepts `/` and `a//b` as model IDs.
        ["trailing separator", "anthropic//"],
        ["whitespace-only interior segment", "anthropic/ / "],
        ["empty interior segment", "anthropic/a//b"],
    ])("rejects %s before the lane spends a token", (_label, value) => {
        expect(() => parseModelRoute("HISTORIAN_EVAL_PROBE_MODEL", value)).toThrow(HistorianEvalContractError);
    });
});
