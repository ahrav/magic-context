import { describe, expect, it } from "bun:test";
import { isCompactionEnabled } from "./agent-disable";
import { MagicContextConfigSchema } from "./schema/magic-context";

// schema-level assertions).

describe("compaction config back-compat (issue #266 S1)", () => {
    it("parses {} with compaction.enabled === true (default-on at top level)", () => {
        const parsed = MagicContextConfigSchema.parse({});
        expect(parsed.compaction).toBeDefined();
        expect(parsed.compaction.enabled).toBe(true);
        expect(isCompactionEnabled(parsed)).toBe(true);
    });

    it("parses { compaction: {} } with compaction.enabled === true (default-on at block level)", () => {
        const parsed = MagicContextConfigSchema.parse({ compaction: {} });
        expect(parsed.compaction.enabled).toBe(true);
        expect(isCompactionEnabled(parsed)).toBe(true);
    });

    it("parses a config with no compaction block (absent block → default-on)", () => {
        const parsed = MagicContextConfigSchema.parse({ memory: { enabled: false } });
        expect(parsed.compaction).toBeDefined();
        expect(parsed.compaction.enabled).toBe(true);
        expect(isCompactionEnabled(parsed)).toBe(true);
    });

    it("resolves explicit user-tier compaction.enabled === false", () => {
        const parsed = MagicContextConfigSchema.parse({ compaction: { enabled: false } });
        expect(parsed.compaction.enabled).toBe(false);
        expect(isCompactionEnabled(parsed)).toBe(false);
    });

    it("resolves explicit compaction.enabled === true", () => {
        const parsed = MagicContextConfigSchema.parse({ compaction: { enabled: true } });
        expect(parsed.compaction.enabled).toBe(true);
        expect(isCompactionEnabled(parsed)).toBe(true);
    });

    it("absent block is byte-identical to default block for compaction (no behavior gated yet)", () => {
        const absent = MagicContextConfigSchema.parse({ memory: { enabled: true } });
        const empty = MagicContextConfigSchema.parse({ compaction: {} });
        expect(absent.compaction).toEqual(empty.compaction);
    });
});
