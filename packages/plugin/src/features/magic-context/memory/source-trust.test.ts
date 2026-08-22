/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { SOURCE_TRUST_CLASSES, trustClassForLegacyMemorySource } from "./source-trust";

describe("legacy memory source trust mapping (AE4)", () => {
    test("only the literal user source maps to explicit_user", () => {
        const cases: Array<[string | null | undefined, string]> = [
            ["user", "explicit_user"],
            ["historian", "model_inference"],
            ["agent", "model_inference"],
            ["dreamer", "model_inference"],
            ["tool", "model_inference"],
            ["test", "model_inference"],
            ["module:some-unknown", "model_inference"],
            ["USER", "model_inference"],
            ["", "model_inference"],
            [null, "model_inference"],
            [undefined, "model_inference"],
        ];
        for (const [sourceType, expected] of cases) {
            expect(trustClassForLegacyMemorySource(sourceType), String(sourceType)).toBe(
                expected as ReturnType<typeof trustClassForLegacyMemorySource>,
            );
        }
    });

    test("the mapping only produces constrained trust classes", () => {
        const produced = new Set(
            ["user", "historian", "whatever", null].map((value) =>
                trustClassForLegacyMemorySource(value),
            ),
        );
        for (const trust of produced) {
            expect(SOURCE_TRUST_CLASSES).toContain(trust);
        }
    });
});
