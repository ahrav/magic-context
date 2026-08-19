import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizedQueryHash, normalizeQueryText } from "./query-normalization";
import {
    normalizedQueryHash as reexportedHash,
    normalizeQueryText as reexportedNormalize,
} from "./storage-embedding-measurements";

describe("normalizeQueryText", () => {
    it("trims, collapses internal whitespace, and lowercases", () => {
        expect(normalizeQueryText("  How\tDOES  the\n\nCache  work?  ")).toBe(
            "how does the cache work?",
        );
    });

    it("keeps an already-normalized query unchanged", () => {
        expect(normalizeQueryText("plain query")).toBe("plain query");
    });

    it("normalizes a whitespace-only query to the empty string", () => {
        expect(normalizeQueryText(" \t\n ")).toBe("");
    });
});

describe("normalizedQueryHash", () => {
    it("hashes the normalized text with sha256", () => {
        const expected = createHash("sha256").update("how does the cache work?").digest("hex");
        expect(normalizedQueryHash("  How DOES   the Cache work?  ")).toBe(expected);
    });

    it("collides exactly when normalization collides", () => {
        expect(normalizedQueryHash("A  B")).toBe(normalizedQueryHash("a b"));
        expect(normalizedQueryHash("a b")).not.toBe(normalizedQueryHash("a c"));
    });
});

describe("module boundary", () => {
    it("storage-embedding-measurements re-exports the identical functions", () => {
        expect(reexportedNormalize).toBe(normalizeQueryText);
        expect(reexportedHash).toBe(normalizedQueryHash);
    });

    it("imports nothing beyond node:crypto", () => {
        const source = readFileSync(join(import.meta.dir, "query-normalization.ts"), "utf8");
        const imports = Array.from(
            source.matchAll(/^import\s.*?from\s+"([^"]+)"/gms),
            (match) => match[1],
        );
        expect(imports).toEqual(["node:crypto"]);
    });
});
