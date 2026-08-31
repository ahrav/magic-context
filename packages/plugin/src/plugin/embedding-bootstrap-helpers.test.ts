import { describe, expect, it } from "bun:test";

import type { EmbeddingConfig } from "../config/schema/magic-context";
import {
    type EmbeddingLoadResultDetailed,
    isConfigLoadUntrusted,
} from "./embedding-bootstrap-helpers";

type Detailed = EmbeddingLoadResultDetailed<{ embedding: EmbeddingConfig }>;

function makeDetailed(embedding: EmbeddingConfig): Detailed {
    return {
        config: { embedding },
        loadOutcome: "ok",
        sources: { userConfig: "ok", projectConfig: "ok" },
        substitutionFailures: [],
        recoveredTopLevelKeys: [],
    };
}

describe("isConfigLoadUntrusted — literal config tokens", () => {
    it("treats a literal {env:} token in an embedding field as untrusted", () => {
        const detailed = makeDetailed({
            provider: "openai-compatible",
            model: "qwen/qwen3-embedding-8b",
            endpoint: "{env:EMBED_ENDPOINT}/v1",
        });
        expect(isConfigLoadUntrusted(detailed)).toBe(true);
    });

    it("treats a literal {file:} token in the api_key as untrusted", () => {
        const detailed = makeDetailed({
            provider: "openai-compatible",
            model: "qwen/qwen3-embedding-8b",
            endpoint: "https://openrouter.ai/api/v1",
            api_key: "{file:~/.config/key}",
        });
        expect(isConfigLoadUntrusted(detailed)).toBe(true);
    });

    it("trusts a fully-resolved embedding config", () => {
        const detailed = makeDetailed({
            provider: "openai-compatible",
            model: "qwen/qwen3-embedding-8b",
            endpoint: "https://openrouter.ai/api/v1",
            api_key: "sk-real-resolved-value",
        });
        expect(isConfigLoadUntrusted(detailed)).toBe(false);
    });

    it("trusts a local provider with no tokens", () => {
        const detailed = makeDetailed({ provider: "local", model: "minilm" });
        expect(isConfigLoadUntrusted(detailed)).toBe(false);
    });
});
