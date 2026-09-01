import { describe, expect, it } from "bun:test";

import { pruneNestedConfigLeaf } from "./prune-config-leaf";

describe("pruneNestedConfigLeaf", () => {
    it("prunes a 2-level leaf and keeps siblings", () => {
        const block = { enabled: false, injection_budget_tokens: 4000 };
        const result = pruneNestedConfigLeaf(block, ["injection_budget_tokens"]);
        expect(result).not.toBeNull();
        expect(result?.block).toEqual({ enabled: false });
        expect(result?.removed).toBe("injection_budget_tokens");
        // original untouched
        expect(block).toEqual({ enabled: false, injection_budget_tokens: 4000 });
    });

    it("prunes the DEEPEST leaf of a 3-level path, preserving a disabled sibling", () => {
        const block = {
            enabled: true,
            git_commit_indexing: { enabled: false, since_days: 99999 },
        };
        const result = pruneNestedConfigLeaf(block, ["git_commit_indexing", "since_days"]);
        expect(result).not.toBeNull();
        expect(result?.block).toEqual({
            enabled: true,
            git_commit_indexing: { enabled: false },
        });
        expect(result?.removed).toBe("git_commit_indexing.since_days");
        expect(block.git_commit_indexing).toEqual({ enabled: false, since_days: 99999 });
    });

    it("prunes the owning field when an intermediate segment is not an object", () => {
        const block = { git_commit_indexing: true, keep_me: { enabled: false } };
        const result = pruneNestedConfigLeaf(block, ["git_commit_indexing", "since_days"]);
        expect(result).not.toBeNull();
        expect(result?.removed).toBe("git_commit_indexing");
        expect(result?.block).toEqual({ keep_me: { enabled: false } });
    });

    it("prunes an invalid array-element leaf to its owning field", () => {
        const block = {
            system_prompt_injection: { enabled: true, skip_signatures: [123] },
        };
        const result = pruneNestedConfigLeaf(block, [
            "system_prompt_injection",
            "skip_signatures",
            0,
        ]);
        expect(result).not.toBeNull();
        expect(result?.removed).toBe("system_prompt_injection.skip_signatures");
        expect(result?.block).toEqual({ system_prompt_injection: { enabled: true } });
    });

    it("returns null when the leaf is absent", () => {
        const block = { auto_search: { enabled: false } };
        expect(pruneNestedConfigLeaf(block, ["auto_search", "missing"])).toBeNull();
    });

    it("returns null for an empty path", () => {
        expect(pruneNestedConfigLeaf({ a: 1 }, [])).toBeNull();
    });

    it("deep-clones intermediate objects (no shared references with input)", () => {
        const inner = { enabled: false, since_days: 1 };
        const block = { git_commit_indexing: inner };
        const result = pruneNestedConfigLeaf(block, ["git_commit_indexing", "since_days"]);
        expect(result?.block.git_commit_indexing).not.toBe(inner);
    });
});
