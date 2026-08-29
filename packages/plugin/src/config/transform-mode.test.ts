import { describe, expect, it } from "bun:test";

import {
    RUST_COMPACTION_OFF_WARNING,
    RUST_REQUIRES_USER_CONSENT_WARNING,
    resolveTransformMode,
} from "./transform-mode";

describe("resolveTransformMode", () => {
    it("keeps rust when the user tier itself selected rust (managed consent)", () => {
        expect(
            resolveTransformMode({
                configured: "rust",
                userTierConfiguredRust: true,
                userTierHasSubc: false,
                compactionEnabled: true,
            }),
        ).toEqual({ mode: "rust", warnings: [] });
    });

    it("keeps rust when trusted user-level subc is present", () => {
        expect(
            resolveTransformMode({
                configured: "rust",
                userTierConfiguredRust: false,
                userTierHasSubc: true,
                compactionEnabled: true,
            }),
        ).toEqual({ mode: "rust", warnings: [] });
    });

    it("falls back to ts when only project config selects rust without user-tier consent", () => {
        expect(
            resolveTransformMode({
                configured: "rust",
                userTierConfiguredRust: false,
                userTierHasSubc: false,
                compactionEnabled: true,
            }),
        ).toEqual({
            mode: "ts",
            warnings: [RUST_REQUIRES_USER_CONSENT_WARNING],
        });
    });

    it("keeps ts without warnings when ts is configured", () => {
        expect(
            resolveTransformMode({
                configured: "ts",
                userTierConfiguredRust: false,
                userTierHasSubc: false,
                compactionEnabled: true,
            }),
        ).toEqual({ mode: "ts", warnings: [] });
    });

    it("keeps rust in the default compaction-on mode without a warning", () => {
        const result = resolveTransformMode({
            configured: "rust",
            userTierConfiguredRust: false,
            userTierHasSubc: true,
            compactionEnabled: true,
        });

        expect(result.mode).toBe("rust");
        expect(result.warnings).toEqual([]);
    });

    it("downgrades rust to ts with one warning when compaction is off", () => {
        expect(
            resolveTransformMode({
                configured: "rust",
                userTierConfiguredRust: false,
                userTierHasSubc: true,
                compactionEnabled: false,
            }),
        ).toEqual({
            mode: "ts",
            warnings: [RUST_COMPACTION_OFF_WARNING],
        });
    });
});
