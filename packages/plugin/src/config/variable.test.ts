import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import { substituteConfigVariables } from "./variable";

describe("substituteConfigVariables", () => {
    const ORIGINAL_ENV = { ...process.env };
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "mc-variable-test-"));
    });

    afterEach(() => {
        try {
            rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* */
        }
        process.env = { ...ORIGINAL_ENV };
    });

    describe("env substitution", () => {
        it("replaces {env:VAR} with process.env value", () => {
            process.env.MC_TEST_KEY = "sk-real-value";
            const input = `{ "api_key": "{env:MC_TEST_KEY}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "sk-real-value" }`);
            expect(result.warnings).toHaveLength(0);
        });

        it("trims whitespace inside env token", () => {
            process.env.MC_TEST_KEY = "trimmed-value";
            const input = `{ "api_key": "{env: MC_TEST_KEY }" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "trimmed-value" }`);
            expect(result.warnings).toHaveLength(0);
        });

        it("JSON-escapes quotes in env values so JSONC parsing survives", () => {
            process.env.MC_QUOTED = 'sk-"quoted"-value';
            const input = `{ "api_key": "{env:MC_QUOTED}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "sk-\\"quoted\\"-value" }`);
            expect(JSON.parse(result.text).api_key).toBe('sk-"quoted"-value');
            expect(result.warnings).toHaveLength(0);
        });

        it("JSON-escapes newlines in env values so JSONC parsing survives", () => {
            process.env.MC_MULTILINE = "line1\nline2";
            const input = `{ "api_key": "{env:MC_MULTILINE}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "line1\\nline2" }`);
            expect(JSON.parse(result.text).api_key).toBe("line1\nline2");
            expect(result.warnings).toHaveLength(0);
        });

        it("prevents env values from injecting sibling JSON keys", () => {
            process.env.MC_INJECT = 'abc", "provider": "off';
            const input = `{ "api_key": "{env:MC_INJECT}" }`;

            const result = substituteConfigVariables({ text: input });
            const parsed = JSON.parse(result.text);

            expect(parsed.api_key).toBe('abc", "provider": "off');
            expect(parsed.provider).toBeUndefined();
            expect(result.warnings).toHaveLength(0);
        });

        it("emits warning and empty string for missing env var", () => {
            delete process.env.MC_MISSING_VAR;
            const input = `{ "api_key": "{env:MC_MISSING_VAR}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "" }`);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toContain("MC_MISSING_VAR");
            expect(result.warnings[0]).toContain("not set");
        });

        it("emits warning for empty-string env var", () => {
            process.env.MC_EMPTY = "";
            const input = `{ "api_key": "{env:MC_EMPTY}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "" }`);
            expect(result.warnings).toHaveLength(1);
        });

        it("passes {env:} literally through (matches OpenCode regex: at least one char required)", () => {
            const input = `{ "api_key": "{env:}" }`;

            const result = substituteConfigVariables({ text: input });

            // `{env:}` passes through because env tokens require a nonempty name.
            expect(result.text).toBe(input);
            expect(result.warnings).toHaveLength(0);
        });

        it("handles multiple env tokens in one text", () => {
            process.env.MC_A = "alpha";
            process.env.MC_B = "beta";
            const input = `{ "a": "{env:MC_A}", "b": "{env:MC_B}", "c": "{env:MC_MISSING}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "a": "alpha", "b": "beta", "c": "" }`);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toContain("MC_MISSING");
        });
    });

    describe("file substitution", () => {
        it("inlines file contents for absolute path", () => {
            const keyFile = join(tmpDir, "key.txt");
            writeFileSync(keyFile, "sk-from-file\n");
            const input = `{ "api_key": "{file:${keyFile}}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "sk-from-file" }`);
            expect(result.warnings).toHaveLength(0);
        });

        it("resolves relative path against configPath directory", () => {
            const keyFile = join(tmpDir, "key.txt");
            writeFileSync(keyFile, "relative-value");
            const configPath = join(tmpDir, "magic-context.jsonc");

            const input = `{ "api_key": "{file:./key.txt}" }`;
            const result = substituteConfigVariables({ text: input, configPath });

            expect(result.text).toBe(`{ "api_key": "relative-value" }`);
            expect(result.warnings).toHaveLength(0);
        });

        it("resolves relative path without leading ./", () => {
            const keyFile = join(tmpDir, "key.txt");
            writeFileSync(keyFile, "no-dot-slash");
            const configPath = join(tmpDir, "magic-context.jsonc");

            const input = `{ "api_key": "{file:key.txt}" }`;
            const result = substituteConfigVariables({ text: input, configPath });

            expect(result.text).toBe(`{ "api_key": "no-dot-slash" }`);
        });

        it("expands ~/ to home directory", () => {
            const input = `{ "marker": "{file:~/__mc-never-exists-${Date.now()}}" }`;

            const result = substituteConfigVariables({ text: input });

            // Missing-file warnings report the homedir-resolved path.
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toContain(homedir() + sep);
        });

        it("JSON-escapes quotes and newlines in file contents", () => {
            const keyFile = join(tmpDir, "multiline.txt");
            writeFileSync(keyFile, 'line1 with "quote"\nline2');
            const input = `{ "value": "{file:${keyFile}}" }`;

            const result = substituteConfigVariables({ text: input });

            // JSON escaping preserves the enclosing JSONC string's validity.
            expect(result.text).toBe(`{ "value": "line1 with \\"quote\\"\\nline2" }`);
            const parsed = JSON.parse(result.text);
            expect(parsed.value).toBe('line1 with "quote"\nline2');
        });

        it("emits warning and empty string for missing file", () => {
            const missing = join(tmpDir, "never-exists.txt");
            const input = `{ "api_key": "{file:${missing}}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "" }`);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toContain("not found");
            expect(result.warnings[0]).toContain(missing);
        });

        it("passes {file:} literally through (matches OpenCode regex: at least one char required)", () => {
            const input = `{ "api_key": "{file:}" }`;

            const result = substituteConfigVariables({ text: input });

            // `{file:}` is not a valid token and passes through literally.
            expect(result.text).toBe(input);
            expect(result.warnings).toHaveLength(0);
        });

        it("suppresses {file:} expansion inside // line comments", () => {
            const keyFile = join(tmpDir, "key.txt");
            writeFileSync(keyFile, "should-not-appear");
            const input = [
                `{`,
                `    // see docs: {file:${keyFile}}`,
                `    "other": "value"`,
                `}`,
            ].join("\n");

            const result = substituteConfigVariables({ text: input });

            expect(result.text).not.toContain(`{file:${keyFile}}`);
            expect(result.text).not.toContain("should-not-appear");
            expect(result.warnings).toHaveLength(0);
        });

        it("suppresses {file:} expansion inside block comments", () => {
            const keyFile = join(tmpDir, "key.txt");
            writeFileSync(keyFile, "should-not-appear");
            const input = [
                `{`,
                `    /* see docs: {file:${keyFile}} */`,
                `    "other": "value"`,
                `}`,
            ].join("\n");

            const result = substituteConfigVariables({ text: input });

            expect(result.text).not.toContain(`{file:${keyFile}}`);
            expect(result.text).not.toContain("should-not-appear");
            expect(result.warnings).toHaveLength(0);
        });

        it("still expands {file:} tokens inside strings that contain URL comment markers", () => {
            const keyFile = join(tmpDir, "key.txt");
            writeFileSync(keyFile, "token-value");
            const input = `{ "endpoint": "https://example.test/*literal*/{file:${keyFile}}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(
                `{ "endpoint": "https://example.test/*literal*/token-value" }`,
            );
            expect(JSON.parse(result.text).endpoint).toBe(
                "https://example.test/*literal*/token-value",
            );
            expect(result.warnings).toHaveLength(0);
        });
    });

    describe("combined substitution", () => {
        it("handles env and file tokens together", () => {
            process.env.MC_COMBINED = "env-val";
            const keyFile = join(tmpDir, "combined.txt");
            writeFileSync(keyFile, "file-val");

            const input = `{ "e": "{env:MC_COMBINED}", "f": "{file:${keyFile}}" }`;
            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "e": "env-val", "f": "file-val" }`);
            expect(result.warnings).toHaveLength(0);
        });

        it("env tokens inside {file:} path expand before file read", () => {
            // Environment substitution runs before file substitution.
            // The file pass resolves paths emitted by env substitution.
            // substitution.
            process.env.MC_FILE_DIR = tmpDir;
            const keyFile = join(tmpDir, "indirect.txt");
            writeFileSync(keyFile, "indirect-value");

            const input = `{ "api_key": "{file:{env:MC_FILE_DIR}/indirect.txt}" }`;
            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "indirect-value" }`);
        });
    });

    describe("no-op cases", () => {
        it("returns text unchanged when no tokens present", () => {
            const input = `{ "api_key": "literal-value", "provider": "openai-compatible" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(input);
            expect(result.warnings).toHaveLength(0);
        });

        it("leaves partial patterns like {env alone", () => {
            const input = `{ "note": "this {env is not a token" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(input);
            expect(result.warnings).toHaveLength(0);
        });
    });

    describe("sensitive-path warnings", () => {
        it("warns when a user {file:} resolves into ~/.ssh", () => {
            const input = `{ "key": "{file:~/.ssh/id_rsa}" }`;
            const result = substituteConfigVariables({ text: input });
            // Whether the file exists or not, the sensitive-path warning fires
            // The sensitive-path warning precedes the existence check.
            expect(result.warnings.some((w) => w.includes("sensitive path"))).toBe(true);
            expect(result.warnings.some((w) => w.includes("SSH keys"))).toBe(true);
        });

        it("does NOT warn for an ordinary {file:} path", () => {
            const input = `{ "prompt": "{file:~/notes/context.md}" }`;
            const result = substituteConfigVariables({ text: input });
            expect(result.warnings.some((w) => w.includes("sensitive path"))).toBe(false);
        });
    });
});
