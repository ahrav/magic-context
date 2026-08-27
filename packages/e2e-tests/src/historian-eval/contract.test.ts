import { describe, expect, test } from "bun:test";
import {
    HARD_NEGATIVE_FAMILIES,
    HistorianEvalContractError,
    MANIFEST_SCHEMA,
    MAX_TRANSCRIPT_TURNS,
    MAX_TURN_TEXT_CHARS,
    buildReleaseTuple,
    lintScenario,
    normalizeContent,
    parseManifest,
    parseScenario,
    predicateMatches,
    releaseApprovalFingerprint,
    scenarioFingerprint,
} from "./contract";
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
        (raw.gold as Record<string, unknown>).expectedAbsent = HARD_NEGATIVE_FAMILIES.map((family, index) => ({
            id: `abs-family-${index}`,
            family,
            predicate: { kind: "normalized-substring", value: `forbidden formation ${index}` },
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
        const b = parseScenario(rawB);
        expect(buildReleaseTuple([a, b])).toEqual(buildReleaseTuple([b, a]));
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
});
