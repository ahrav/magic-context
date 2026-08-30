import { describe, expect, it } from "bun:test";

import {
    DreamerProviderOutputFailureError,
    providerOutputFailureFromInvalidManifest,
    rethrowInvalidManifestAsProviderFailure,
} from "./provider-output-failure";

function assistantCompletion(args: {
    created: number;
    output: number;
    reasoning: number;
    finish?: string;
    error?: unknown;
}) {
    return {
        info: {
            role: "assistant",
            time: { created: args.created },
            finish: args.finish ?? "stop",
            error: args.error ?? null,
            tokens: { output: args.output, reasoning: args.reasoning },
        },
        parts: [{ type: "text", text: "provider text" }],
    };
}

describe("providerOutputFailureFromInvalidManifest", () => {
    it("classifies the latest near-zero no-reasoning completion as a transient provider failure", () => {
        const messages = [
            assistantCompletion({ created: 1, output: 8, reasoning: 0 }),
            assistantCompletion({ created: 2, output: 8, reasoning: 0 }),
            assistantCompletion({ created: 3, output: 8, reasoning: 0 }),
        ];

        const failure = providerOutputFailureFromInvalidManifest(
            messages,
            "All Antigravity endpoints failed",
        );

        expect(failure).toBeInstanceOf(DreamerProviderOutputFailureError);
        expect(failure?.transient).toBe(true);
        expect(failure?.outputTokens).toBe(8);
        expect(failure?.reasoningTokens).toBe(0);
        expect(failure?.message).toContain("provider-outage completion");
        expect(failure?.message).not.toContain("manifest missing");
    });

    it("requires the complete outage token shape instead of matching response wording", () => {
        const responseText = "All Antigravity endpoints failed";

        expect(
            providerOutputFailureFromInvalidManifest(
                [assistantCompletion({ created: 1, output: 33, reasoning: 0 })],
                responseText,
            ),
        ).toBeNull();
        expect(
            providerOutputFailureFromInvalidManifest(
                [assistantCompletion({ created: 1, output: 8, reasoning: 1 })],
                responseText,
            ),
        ).toBeNull();
        expect(
            providerOutputFailureFromInvalidManifest(
                [assistantCompletion({ created: 1, output: 8, reasoning: 0, finish: "length" })],
                responseText,
            ),
        ).toBeNull();
        expect(
            providerOutputFailureFromInvalidManifest(
                [
                    assistantCompletion({
                        created: 1,
                        output: 8,
                        reasoning: 0,
                        error: { name: "ProviderError" },
                    }),
                ],
                responseText,
            ),
        ).toBeNull();
    });
});

describe("rethrowInvalidManifestAsProviderFailure", () => {
    const outageMessages = [assistantCompletion({ created: 1, output: 8, reasoning: 0 })];

    it("returns silently when the validator accepts", () => {
        expect(() =>
            rethrowInvalidManifestAsProviderFailure(outageMessages, "provider text", () => {}),
        ).not.toThrow();
    });

    it("reclassifies a validator rejection as a provider failure on the outage token shape", () => {
        expect(() =>
            rethrowInvalidManifestAsProviderFailure(outageMessages, "provider text", () => {
                throw new Error("manifest missing <memories> root");
            }),
        ).toThrow(DreamerProviderOutputFailureError);
    });

    it("propagates the validator error when the transcript is not an outage shape", () => {
        const messages = [assistantCompletion({ created: 1, output: 400, reasoning: 12 })];
        expect(() =>
            rethrowInvalidManifestAsProviderFailure(messages, "long real reply", () => {
                throw new Error("manifest missing <memories> root");
            }),
        ).toThrow("manifest missing <memories> root");
    });
});
