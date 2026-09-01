/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { buildMagicContextHookConfig } from "./create-session-hooks";

describe("buildMagicContextHookConfig", () => {
    it("threads toast_duration_ms into the per-session hook config", () => {
        const config = buildMagicContextHookConfig({
            enabled: true,
            protected_tags: 10,
            cache_ttl: "5m",
            toast_duration_ms: 30_000,
        } as never);

        expect(config.toast_duration_ms).toBe(30_000);
    });

    it("passes toast_duration_ms = 0 through unchanged (disables toasts)", () => {
        const config = buildMagicContextHookConfig({
            enabled: true,
            toast_duration_ms: 0,
        } as never);

        expect(config.toast_duration_ms).toBe(0);
    });

    it("leaves toast_duration_ms undefined when unset (consumer applies default)", () => {
        const config = buildMagicContextHookConfig({ enabled: true } as never);

        expect(config.toast_duration_ms).toBeUndefined();
    });

    // buildMagicContextHookConfig must preserve hook-consumed plugin-config fields.
    it("passes through every hook-consumed field, not a hand-maintained subset", () => {
        const config = buildMagicContextHookConfig({
            enabled: true,
            smart_drops: true,
            language: "de",
            embedding: { provider: "openai-compatible" },
            transform_mode: "rust",
            temporal_awareness: true,
        } as never) as Record<string, unknown>;

        expect(config.smart_drops).toBe(true);
        expect(config.language).toBe("de");
        expect(config.embedding).toEqual({ provider: "openai-compatible" });
        expect(config.transform_mode).toBe("rust");
        expect(config.temporal_awareness).toBe(true);
    });

    it("still applies the two defaulted fields when unset", () => {
        const config = buildMagicContextHookConfig({ enabled: true } as never);

        expect(config.protected_tags).toBeGreaterThan(0);
        expect(config.execute_threshold_percentage).toBeDefined();
    });
});
