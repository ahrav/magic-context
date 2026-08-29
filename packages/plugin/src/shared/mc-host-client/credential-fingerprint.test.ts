import { describe, expect, test } from "bun:test";
import { canonicalCredentialRowEncoding, credentialFingerprints } from "./credential-fingerprint";

describe("Broca credential fingerprints", () => {
    test("pins the domain-derived cross-language row vector", () => {
        const key = Uint8Array.from({ length: 32 }, (_value, index) => index);
        expect(
            canonicalCredentialRowEncoding("opencode", "anthropic", [
                ["ANTHROPIC_API_KEY", "secret"],
            ]),
        ).toBe(
            "36:harness-provider-name-length-value/18:opencode9:anthropic17:ANTHROPIC_API_KEY1:66:secret",
        );
        expect(
            credentialFingerprints(key, "opencode", {
                ANTHROPIC_API_KEY: "secret",
            }),
        ).toEqual({
            anthropic: "7433149b20d0453ae0014a4ddd46e06c6f445af63528ab1c9f6faa1c508ab100",
        });
    });

    test("omits incomplete rows and excludes unrelated ambient values", () => {
        const key = new Uint8Array(32);
        const fingerprints = credentialFingerprints(key, "pi", {
            OPENAI_API_KEY: "direct",
            AWS_ACCESS_KEY_ID: "ambient",
            HTTPS_PROXY: "ambient",
            PATH: "/attacker/bin",
        });
        expect(Object.keys(fingerprints)).toEqual(["openai"]);
        expect(JSON.stringify(fingerprints)).not.toContain("direct");
        expect(JSON.stringify(fingerprints)).not.toContain("ambient");
    });

    test("rejects malformed keys and oversize values", () => {
        expect(() => credentialFingerprints(new Uint8Array(31), "pi", {})).toThrow(/exactly 32/);
        expect(() =>
            credentialFingerprints(new Uint8Array(32), "pi", {
                ANTHROPIC_API_KEY: "x".repeat(16 * 1024 + 1),
            }),
        ).toThrow(/size cap/);
    });
});
