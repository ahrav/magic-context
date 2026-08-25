import { describe, expect, it } from "bun:test";
import { assertBoundVerifierBytesUnchanged } from "./validate-incident-verifiers";

describe("incident verifier contributor gate", () => {
    it("accepts unchanged bound verifier bytes", () => {
        expect(() =>
            assertBoundVerifierBytesUnchanged(
                { "tests/verifier.test.ts": "a".repeat(64) },
                { "tests/verifier.test.ts": "a".repeat(64) },
            ),
        ).not.toThrow();
    });

    it("blocks changed, added, or removed bound verifiers without replay support", () => {
        for (const [accepted, current] of [
            [
                { "tests/verifier.test.ts": "a".repeat(64) },
                { "tests/verifier.test.ts": "b".repeat(64) },
            ],
            [{}, { "tests/verifier.test.ts": "b".repeat(64) }],
            [{ "tests/verifier.test.ts": "a".repeat(64) }, {}],
        ] as const) {
            expect(() =>
                assertBoundVerifierBytesUnchanged(accepted, current),
            ).toThrow(/changed without recorded mutation replay support/);
        }
    });
});
