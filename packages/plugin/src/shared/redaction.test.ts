/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import vocabulary from "./fixtures/redaction-vocabulary-v1.json";
import {
    credentialValueFormat,
    hasShareabilitySensitiveText,
    isCredentialBearingConfigKey,
    redactSecretText,
    SECRET_QUALIFIERS,
    SECRET_WORDS,
} from "./redaction";

describe("redaction vocabulary fixture", () => {
    test("matches the cross-runtime label vocabulary", () => {
        expect(SECRET_WORDS).toEqual(vocabulary.label_words);
        expect([...SECRET_QUALIFIERS]).toEqual(vocabulary.label_qualifiers);
    });

    test("matches the cross-runtime redacted output", () => {
        for (const fixture of vocabulary.cases) {
            expect(redactSecretText(fixture.input)).toBe(fixture.expected_redacted);
            for (const detection of fixture.detections) {
                const bytes = Buffer.from(fixture.input, "utf8");
                expect(detection.offset + detection.length).toBeLessThanOrEqual(bytes.length);
                expect(detection.secret_type.length).toBeGreaterThan(0);
            }
        }
    });

    test("preserves scalar exemptions and documents known misses", () => {
        for (const unchanged of [...vocabulary.exemptions, ...vocabulary.known_misses]) {
            expect(redactSecretText(unchanged)).toBe(unchanged);
        }
    });
});

describe("redactSecretText — token counts and scalar diagnostics stay visible", () => {
    test("keeps numeric/boolean values whose key merely contains a secret word", () => {
        // These log shapes are counts/flags, not secrets, so they must stay readable.
        expect(redactSecretText("tokens.input=45000 cache.read=0 cache.write=0")).toBe(
            "tokens.input=45000 cache.read=0 cache.write=0",
        );
        expect(redactSecretText("hasUsageTokens=true")).toBe("hasUsageTokens=true");
        expect(redactSecretText("totalInputTokens=132000")).toBe("totalInputTokens=132000");
        expect(redactSecretText("max_tokens=4096")).toBe("max_tokens=4096");
    });

    test("keeps quoted numeric values matched only on the key word", () => {
        expect(redactSecretText('"max_tokens": "4096"')).toBe('"max_tokens": "4096"');
    });

    test("still redacts real secret string values", () => {
        // Key-based matching exempts numeric and boolean scalar values.
        const syntheticApiKey = "sk-abc123XYZ" + "secretvalue"; // gitleaks:allow redaction-test fixture
        expect(redactSecretText(`api_key=${syntheticApiKey}`)).toContain("<REDACTED:");
        expect(redactSecretText(`api_key=${syntheticApiKey}`)).not.toContain(syntheticApiKey);
        const syntheticAuthToken = "tok_live_" + "9f8e7d6c5b";
        expect(redactSecretText(`"auth_token": "${syntheticAuthToken}"`)).toContain("<REDACTED:");
    });

    test("value-shaped secret patterns still fire independent of key name", () => {
        // A bearer/JWT value is caught by its own pattern even if its key is bland.
        expect(redactSecretText("Authorization: Bearer abc123def456ghi789")).toContain(
            "<REDACTED:bearer>",
        );
        const syntheticJwt = ["eyJhbGciOi", "eyJzdWIiOiIx", "SflKxwRJSMeKKF2QT4"].join(".");
        expect(redactSecretText(`blob=${syntheticJwt}`)).toContain("<JWT_REDACTED>");
    });
});

describe("hasShareabilitySensitiveText", () => {
    test("safe project facts are shareable", () => {
        expect(
            hasShareabilitySensitiveText(
                "The historian runs as a hidden subagent and never busts the prompt cache.",
            ),
        ).toBe(false);
        expect(
            hasShareabilitySensitiveText("Migration v45 adds the retrospective watermark column."),
        ).toBe(false);
    });

    test("flags inline key:value / key=value secrets the keyed redactor misses in prose", () => {
        expect(hasShareabilitySensitiveText("Set api_key: sk-live-abc123 in the env.")).toBe(true); // gitleaks:allow redaction-test fixture
        expect(hasShareabilitySensitiveText("password=hunter2 for the staging box")).toBe(true);
        expect(hasShareabilitySensitiveText("client_secret = abcdef in the OAuth app")).toBe(true);
    });

    test("flags Windows forward-slash home paths", () => {
        expect(hasShareabilitySensitiveText("logs are under C:/Users/ufuk/AppData/mc")).toBe(true);
    });

    test("flags ~/ rooted personal paths", () => {
        expect(hasShareabilitySensitiveText("config lives at ~/.config/opencode/x.jsonc")).toBe(
            true,
        );
    });

    test("flags local / private endpoints", () => {
        expect(hasShareabilitySensitiveText("embed endpoint is http://localhost:1234/v1")).toBe(
            true,
        );
        expect(hasShareabilitySensitiveText("the box answers on 127.0.0.1:8080")).toBe(true);
        expect(hasShareabilitySensitiveText("LAN host 192.168.1.42 runs the model")).toBe(true);
        expect(hasShareabilitySensitiveText("internal 10.0.0.5 endpoint")).toBe(true);
    });

    test("a public IP / port alone is not flagged by the private-range rules", () => {
        // 8.8.8.8 is public; no private-range or localhost pattern should match.
        expect(hasShareabilitySensitiveText("DNS resolver at 8.8.8.8")).toBe(false);
    });
});

describe("isCredentialBearingConfigKey", () => {
    test("judges a config key by its final word, unlike the redaction predicate", () => {
        // `isSecretKey` needs a qualifier before the secret word, which is right for
        // masking and wrong for a guard that refuses to write a credential to disk.
        for (const key of [
            "masterKey",
            "dbPassword",
            "webhookSecret",
            "signingSecret",
            "encryptionKey",
            "APIKEY",
            "apikey",
            "Cookie",
            "Proxy-Authorization",
            "idToken",
            "accessToken",
            "dbPasswords",
            "customCookies",
            "backupPassphrases",
            "apitoken",
            // A `*Token` qualifier that names an issuer rather than a quantity.
            "botToken",
            "webhookToken",
            "slackToken",
            "csrfToken",
            "verificationToken",
            // An identity token is a credential, whatever the plural suggests.
            "identityTokens",
            // A trailing descriptor names the field, not the thing.
            "dbPasswordValue",
            "masterKeyId",
            "apiKeyHeader",
            "accessTokenValue",
            // An all-caps glued name gives the camel-case split nothing to break on, so its descriptor has to come off the compacted form.
            "DBPASSWORDVALUE",
            "MASTERKEYID",
            "APIKEYHEADER",
            "ACCESSTOKENVALUE",
        ]) {
            expect(isCredentialBearingConfigKey(key)).toBe(true);
        }

        // `token` also counts things, so it stays qualified.
        for (const key of [
            "maxTokens",
            "promptTokens",
            "tokenBudget",
            "idleTokens",
            "idealTokens",
            "baseURL",
            "models",
            // `key` names a position in a data structure at least as often as a credential.
            "foreignKey",
            "primaryKey",
            "partitionKey",
            "sortKey",
            "hotkey",
            // Structural keys keep their descriptors too.
            "primaryKeyId",
            "foreignKeyValue",
            // Peeling a descriptor off the compacted form must not promote a structural key.
            "PRIMARYKEYID",
            "FOREIGNKEYVALUE",
            "HOTKEY",
            "PARTITIONKEY",
        ]) {
            expect(isCredentialBearingConfigKey(key)).toBe(false);
        }
    });
});

describe("credentialValueFormat", () => {
    test("names the format a credential announces, and nothing else", () => {
        expect(credentialValueFormat("Bearer sk-live-abcdefghij")).toBe(
            "HTTP authorization scheme",
        );
        expect(credentialValueFormat("sk-ant-abcdefghijklmnopqrstuv")).toBe("Anthropic-style key");
        expect(credentialValueFormat("ghp_abcdefghijklmnopqrstuvwxyz012345")).toBe("GitHub token");
        expect(credentialValueFormat("postgres://user:pw@host/db")).toBe("credential-bearing URI");
        // The password-only shape, whose username segment is empty.
        expect(credentialValueFormat("redis://:supersecret@cache.internal:6379")).toBe(
            "credential-bearing URI",
        );
        // A bare token in the username position, with no password at all.
        expect(credentialValueFormat("https://ghp_abcdefghijklmnop@github.internal")).toBe(
            "credential-bearing URI",
        );
        expect(credentialValueFormat("-----BEGIN RSA PRIVATE KEY-----")).toBe("PEM private key");

        // `SECRET_TEXT_PATTERNS` redacts these formats, so config validation must reject
        // them under innocuous keys.
        expect(credentialValueFormat("github_pat_abcdefghijklmnopqrstuv0123456789")).toBe(
            "GitHub fine-grained token",
        );
        expect(credentialValueFormat("hf_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(
            "Hugging Face token",
        );
        for (const prefix of [
            "xoxa",
            "xoxb",
            "xoxp",
            "xoxr",
            "xoxs",
            "xoxu",
            "xoxv",
            "xoxc",
            "xapp",
        ]) {
            expect(credentialValueFormat(`${prefix}-0123456789abcdef`)).toBe("Slack token");
        }

        for (const value of [
            "run-42",
            "application/json",
            "https://example.test/path",
            "",
            // Prose that opens with a scheme word: one payload, not four words.
            "Basic auth is optional here",
            "Bearer tokens are supported",
        ]) {
            expect(credentialValueFormat(value)).toBeNull();
        }
    });
});
