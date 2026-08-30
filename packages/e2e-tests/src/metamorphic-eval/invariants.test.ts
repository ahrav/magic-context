import { describe, expect, test } from "bun:test";

import type { InjectedClaimRecord } from "../historian-eval/claim-read";
import type { FailReason, ScenarioScore } from "../historian-eval/scorer";
import { compareInvariants } from "./invariants";

function claim(
    content: string,
    category = "ARCHITECTURE",
    publicClaimId = "clm_01h00000000000000000000000",
): InjectedClaimRecord {
    return {
        publicClaimId,
        revisionLocator: `${publicClaimId}@1:${"a".repeat(64)}`,
        content,
        category,
        revision: 1,
    };
}

type ComparableScore = Pick<ScenarioScore, "verdict" | "failReasons" | "falseAuthoritativeMatches">;

function score(
    verdict: ScenarioScore["verdict"] = "PASS",
    failReasons: FailReason[] = [],
    falseAuthoritativeMatches: string[] = [],
): ComparableScore {
    return { verdict, failReasons, falseAuthoritativeMatches };
}

const cleanScore = score();

describe("metamorphic invariant comparator", () => {
    test("ignores array order, public claim ids, case, and whitespace", () => {
        const baseline = [
            claim("Use the in-process LRU cache", "ARCHITECTURE", "clm_01h00000000000000000000001"),
            claim("Capacity is 4096", "CONFIG_VALUES", "clm_01h00000000000000000000002"),
        ];
        const derivative = [
            claim("  CAPACITY\nis  4096  ", "CONFIG_VALUES", "clm_01h00000000000000000000003"),
            claim("use THE in-process lru cache", "ARCHITECTURE", "clm_01h00000000000000000000004"),
        ];

        expect(compareInvariants(baseline, derivative, cleanScore, cleanScore)).toEqual([
            {
                invariant: "injection-set-equality",
                holds: true,
                changes: [],
            },
            {
                invariant: "expected-absent-empty",
                holds: true,
                baselineMatches: [],
                derivativeMatches: [],
            },
            {
                invariant: "verdict-monotonicity",
                holds: true,
                baselineVerdict: "PASS",
                derivativeVerdict: "PASS",
                introducedFailReasons: [],
            },
        ]);
    });

    test("names an accepted claim missing from the derivative", () => {
        const verdict = compareInvariants(
            [claim("Use the in-process LRU cache")],
            [],
            cleanScore,
            cleanScore,
        )[0];

        expect(verdict).toEqual({
            invariant: "injection-set-equality",
            holds: false,
            changes: [
                {
                    direction: "missing-from-derivative",
                    claim: { category: "ARCHITECTURE", content: "use the in-process lru cache" },
                },
            ],
        });
    });

    test.each([
        "Use Redis for the session cache",
        "The old timeout remains 30 seconds",
    ])("rejects excluded content surfacing only in the derivative: %s", (content) => {
        const verdict = compareInvariants(
            [],
            [claim(content)],
            cleanScore,
            cleanScore,
        )[0];

        expect(verdict).toEqual({
            invariant: "injection-set-equality",
            holds: false,
            changes: [
                {
                    direction: "added-in-derivative",
                    claim: { category: "ARCHITECTURE", content: content.toLowerCase() },
                },
            ],
        });
    });

    test("holds when superseded content is absent from both reads", () => {
        expect(compareInvariants([], [], cleanScore, cleanScore)[0]).toEqual({
            invariant: "injection-set-equality",
            holds: true,
            changes: [],
        });
    });

    test("requires expected-absent matches to be empty on both sides", () => {
        const verdict = compareInvariants(
            [],
            [],
            score("FAIL", ["false-authoritative"], ["abs-baseline"]),
            score("FAIL", ["false-authoritative"], ["abs-derivative"]),
        )[1];

        expect(verdict).toEqual({
            invariant: "expected-absent-empty",
            holds: false,
            baselineMatches: ["abs-baseline"],
            derivativeMatches: ["abs-derivative"],
        });
    });

    test.each([
        [["abs-baseline"], []],
        [[], ["abs-derivative"]],
    ])("rejects one-sided expected-absent matches: %j / %j", (baselineMatches, derivativeMatches) => {
        expect(
            compareInvariants(
                [],
                [],
                score("FAIL", ["false-authoritative"], baselineMatches),
                score("FAIL", ["false-authoritative"], derivativeMatches),
            )[1],
        ).toEqual({
            invariant: "expected-absent-empty",
            holds: false,
            baselineMatches,
            derivativeMatches,
        });
    });

    test.each([
        ["FAIL" as const, ["probe" as const]],
        ["FAIL" as const, ["recall" as const]],
        ["FAIL" as const, ["structural" as const]],
        ["FAIL" as const, ["invalid-output" as const]],
        ["ERROR" as const, [] as FailReason[]],
    ])(
        "rejects a baseline-PASS derivative-%s pair whose claims and absent matches agree: %j",
        (derivativeVerdict, failReasons) => {
            const verdicts = compareInvariants(
                [claim("Use the in-process LRU cache")],
                [claim("Use the in-process LRU cache")],
                cleanScore,
                score(derivativeVerdict, failReasons),
            );

            // The regression is invisible to the other two invariants by
            // construction: both claim sets and both match sets are equal.
            expect(verdicts[0]!.holds).toBe(true);
            expect(verdicts[1]!.holds).toBe(true);
            expect(verdicts[2]).toEqual({
                invariant: "verdict-monotonicity",
                holds: false,
                baselineVerdict: "PASS",
                derivativeVerdict,
                introducedFailReasons: failReasons,
            });
        },
    );

    test("holds when a failing baseline yields a passing derivative", () => {
        expect(
            compareInvariants([], [], score("FAIL", ["recall"]), cleanScore)[2],
        ).toEqual({
            invariant: "verdict-monotonicity",
            holds: true,
            baselineVerdict: "FAIL",
            derivativeVerdict: "PASS",
            introducedFailReasons: [],
        });
    });
});
