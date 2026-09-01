/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { buildReplacementContent } from "./apply-operations";

describe("buildReplacementContent — one canonical placeholder", () => {
    it("is a pure function of tagId — no target/content needed", () => {
        expect(buildReplacementContent(42)).toBe("[dropped \u00a742\u00a7]");
        expect(buildReplacementContent(100413)).toBe("[dropped \u00a7100413\u00a7]");
        expect(buildReplacementContent(7)).toBe("[dropped \u00a77\u00a7]");
    });

    it("is byte-identical to heuristic-cleanup's message placeholder", () => {
        const n = 591;
        expect(buildReplacementContent(n)).toBe(`[dropped \u00a7${n}\u00a7]`);
    });

    it("is deterministic across repeated calls (defer-replay stability)", () => {
        const a = buildReplacementContent(592);
        const b = buildReplacementContent(592);
        const c = buildReplacementContent(592);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it("matches DROPPED_PLACEHOLDER_PATTERN so a fully-dropped non-user message can be sentinelized", () => {
        expect(/^\[dropped §\d+§\]$/.test(buildReplacementContent(11))).toBe(true);
    });
});
