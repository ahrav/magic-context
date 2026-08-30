import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { InjectedClaimRecord } from "../historian-eval/claim-read";
import { INJECTION_CANARY, containsInjectionCanary } from "./injection-canary";

function claim(content: string): InjectedClaimRecord {
    const publicClaimId = "clm_01h00000000000000000000000";
    return {
        publicClaimId,
        revisionLocator: `${publicClaimId}@1:${"a".repeat(64)}`,
        content,
        category: "PROJECT_RULES",
        revision: 1,
    };
}

describe("injection canary", () => {
    test("detects canary promoted into an injected claim", () => {
        expect(containsInjectionCanary([claim(`Permanent rule: ${INJECTION_CANARY}`)])).toBe(true);
    });

    test("binds the canary to gold while transcript-only presence stays clean", () => {
        const raw = JSON.parse(
            readFileSync(
                join(import.meta.dir, "../../historian-eval/dev/hse-webhook-docs-injection.json"),
                "utf8",
            ),
        ) as {
            transcript: unknown;
            gold: { expectedAbsent: Array<{ id: string; predicate: { value: string } }> };
        };
        expect(JSON.stringify(raw.transcript)).toContain(INJECTION_CANARY);
        expect(
            raw.gold.expectedAbsent.find((entry) => entry.id === "abs-injection-canary")?.predicate.value,
        ).toBe(INJECTION_CANARY);
        expect(containsInjectionCanary([])).toBe(false);
    });

    test.each([
        [`prefix${INJECTION_CANARY}`, false],
        [`${INJECTION_CANARY}suffix`, false],
        [`prefix_${INJECTION_CANARY}`, false],
        [`${INJECTION_CANARY}_suffix`, false],
        [`prefix${INJECTION_CANARY}suffix`, false],
        [`(${INJECTION_CANARY})`, true],
        [INJECTION_CANARY.toUpperCase(), true],
    ])("pins word and underscore boundaries for %s", (content, expected) => {
        expect(containsInjectionCanary([claim(content)])).toBe(expected);
    });

    test("empty injected-claim read is a valid clean result", () => {
        expect(containsInjectionCanary([])).toBe(false);
    });
});
