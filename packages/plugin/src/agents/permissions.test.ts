import { describe, expect, it } from "bun:test";
import { DREAMER_CURATE_ALLOWED_TOOLS, DREAMER_DOCS_ALLOWED_TOOLS } from "./dreamer";
import {
    applyDisallowedTools,
    buildAllowOnlyPermission,
    HISTORIAN_ALLOWED_TOOLS,
    SIDEKICK_ALLOWED_TOOLS,
} from "./permissions";

describe("buildAllowOnlyPermission", () => {
    it("starts with wildcard deny so nothing is allowed by default", () => {
        const perm = buildAllowOnlyPermission([]);
        expect(perm["*"]).toBe("deny");
    });

    it("layers the allow-list on top of the wildcard deny", () => {
        const perm = buildAllowOnlyPermission(["read", "ctx_search"]);
        expect(perm["*"]).toBe("deny");
        expect(perm.read).toBe("allow");
        expect(perm.ctx_search).toBe("allow");
    });

    it("places named allows AFTER the wildcard deny so findLast-semantics make them win", () => {
        // OpenCode's Permission.evaluate uses `findLast` over the ruleset
        // built from this object's insertion order. If "*" appeared after a
        // named tool, the deny would clobber it — guard against accidental
        // regressions in the helper's ordering.
        const perm = buildAllowOnlyPermission(["read"]);
        const keys = Object.keys(perm);
        const wildcardIdx = keys.indexOf("*");
        const readIdx = keys.indexOf("read");
        expect(wildcardIdx).toBeLessThan(readIdx);
    });

    it("never accidentally allows `task`, `bash`, or `edit` unless explicitly listed", () => {
        // The whole point of this helper is preventing historian / dreamer /
        // sidekick from inheriting the primary-agent surface. Lock that in.
        const perm = buildAllowOnlyPermission(["read"]);
        expect(perm.task).toBeUndefined();
        expect(perm.bash).toBeUndefined();
        expect(perm.edit).toBeUndefined();
        expect(perm.webfetch).toBeUndefined();
        expect(perm.websearch).toBeUndefined();
        // The wildcard deny covers them via findLast — verified above.
    });

    it("returns an empty allow-list as just the wildcard deny", () => {
        const perm = buildAllowOnlyPermission([]);
        expect(Object.keys(perm)).toEqual(["*"]);
    });
});

describe("HISTORIAN_ALLOWED_TOOLS", () => {
    it("includes `read` (for state-file offload)", () => {
        // Historian's primary tool need is reading the offloaded
        // existing-state XML the runner writes to a temp file.
        expect(HISTORIAN_ALLOWED_TOOLS).toContain("read");
    });

    it("includes `aft_outline`, `aft_zoom`, `aft_search` for token-efficient repo navigation/search", () => {
        // Read-only AFT navigation + search tools let historian/compressor
        // find or verify a symbol or skim file structure when writing
        // accurate compartment summaries without dragging in whole files.
        expect(HISTORIAN_ALLOWED_TOOLS).toContain("aft_outline");
        expect(HISTORIAN_ALLOWED_TOOLS).toContain("aft_zoom");
        expect(HISTORIAN_ALLOWED_TOOLS).toContain("aft_search");
    });

    it("does NOT include `task` (the bug we're fixing — preventing subagent fanout)", () => {
        expect(HISTORIAN_ALLOWED_TOOLS).not.toContain("task");
    });

    it("does NOT include any edit / bash / web tools", () => {
        for (const dangerous of ["bash", "edit", "write", "webfetch", "websearch"]) {
            expect(HISTORIAN_ALLOWED_TOOLS).not.toContain(dangerous);
        }
    });

    it("does NOT include `grep` or `glob` (historian summarizes, not explores)", () => {
        // Historian's job is summarizing the input it was given.
        // Repo-wide exploration belongs to dreamer / primary agents.
        expect(HISTORIAN_ALLOWED_TOOLS).not.toContain("grep");
        expect(HISTORIAN_ALLOWED_TOOLS).not.toContain("glob");
    });
});

describe("applyDisallowedTools", () => {
    it("returns the defaults unchanged when disallowed is empty", () => {
        expect(applyDisallowedTools(HISTORIAN_ALLOWED_TOOLS, [])).toEqual([
            ...HISTORIAN_ALLOWED_TOOLS,
        ]);
    });

    it('removes all tools when "*" is in the disallowed list', () => {
        expect(applyDisallowedTools(HISTORIAN_ALLOWED_TOOLS, ["*"])).toEqual([]);
    });

    it('removes all tools when "*" appears alongside other entries', () => {
        expect(applyDisallowedTools(HISTORIAN_ALLOWED_TOOLS, ["*", "read"])).toEqual([]);
    });

    it("removes a single tool by name", () => {
        const result = applyDisallowedTools(HISTORIAN_ALLOWED_TOOLS, ["read"]);
        expect(result).not.toContain("read");
        expect(result).toContain("aft_outline");
        expect(result).toContain("aft_zoom");
        expect(result).toContain("aft_search");
    });

    it("removes multiple tools by name", () => {
        const result = applyDisallowedTools(HISTORIAN_ALLOWED_TOOLS, ["read", "aft_search"]);
        expect(result).toEqual(["aft_outline", "aft_zoom"]);
    });

    it("silently ignores unknown tool names (defense-in-depth)", () => {
        expect(applyDisallowedTools(HISTORIAN_ALLOWED_TOOLS, ["nonexistent"])).toEqual([
            ...HISTORIAN_ALLOWED_TOOLS,
        ]);
    });

    it("produces empty allow-list → buildAllowOnlyPermission yields wildcard deny only", () => {
        const allowed = applyDisallowedTools(HISTORIAN_ALLOWED_TOOLS, ["*"]);
        const perm = buildAllowOnlyPermission(allowed);
        expect(perm).toEqual({ "*": "deny" });
    });
});

describe("DREAMER_CURATE_ALLOWED_TOOLS (base dreamer = curate only)", () => {
    it("is EMPTY — curate calls no tools; the host applies its manifest", () => {
        // Curate emits one XML manifest and the host validates it and applies
        // every claim write inside a single guarded transaction, which is
        // curate's only write path. Granting ctx_memory would expose
        // list/create/revise/archive/restore/merge to the model and let a run
        // mutate claims outside that transaction. A separate verify task owns
        // memory-vs-code correctness, so curate needs no read/grep/bash/
        // write/edit surface either.
        expect([...DREAMER_CURATE_ALLOWED_TOOLS]).toEqual([]);
    });

    it("does NOT include the memory-mutation tool or any codebase / shell / file-write tool", () => {
        for (const denied of [
            "ctx_memory",
            "read",
            "grep",
            "glob",
            "bash",
            "write",
            "edit",
            "aft_search",
            "ctx_search",
            "ctx_note",
            "task",
        ]) {
            expect(DREAMER_CURATE_ALLOWED_TOOLS).not.toContain(denied);
        }
    });
});

describe("DREAMER_DOCS_ALLOWED_TOOLS (maintain-docs)", () => {
    it("includes read/grep/glob/bash + write/edit + aft for doc maintenance", () => {
        for (const tool of [
            "read",
            "grep",
            "glob",
            "bash",
            "write",
            "edit",
            "aft_outline",
            "aft_zoom",
            "aft_search",
        ]) {
            expect(DREAMER_DOCS_ALLOWED_TOOLS).toContain(tool);
        }
    });

    it("does NOT include memory tools (it edits docs, not the memory store)", () => {
        for (const denied of ["ctx_memory", "ctx_search", "ctx_note", "task"]) {
            expect(DREAMER_DOCS_ALLOWED_TOOLS).not.toContain(denied);
        }
    });
});

describe("SIDEKICK_ALLOWED_TOOLS", () => {
    it("includes ctx_search but not ctx_memory for retrieval", () => {
        // Sidekick is the /ctx-aug memory retriever. It searches memories without
        // receiving the mutation-capable ctx_memory tool.
        expect(SIDEKICK_ALLOWED_TOOLS).toContain("ctx_search");
        expect(SIDEKICK_ALLOWED_TOOLS).not.toContain("ctx_memory");
    });

    it("includes `aft_outline` and `aft_zoom` for lightweight structural context", () => {
        // Sidekick can pull file outline / symbol body when the user's
        // prompt references a specific file or symbol, without dragging
        // in whole files.
        expect(SIDEKICK_ALLOWED_TOOLS).toContain("aft_outline");
        expect(SIDEKICK_ALLOWED_TOOLS).toContain("aft_zoom");
    });

    it("does NOT include `read` (use aft_outline/aft_zoom for navigation instead)", () => {
        // Sidekick should pull symbol-scoped views, not arbitrary file
        // contents. If it needs full source it can use aft_zoom on a
        // specific symbol.
        expect(SIDEKICK_ALLOWED_TOOLS).not.toContain("read");
    });

    it("does NOT include `task` or any edit / bash / web tool", () => {
        for (const denied of ["task", "bash", "edit", "write", "webfetch", "websearch"]) {
            expect(SIDEKICK_ALLOWED_TOOLS).not.toContain(denied);
        }
    });
});

describe("integration: full hidden-agent permission shape", () => {
    it("historian permission object: `*` denied + read + aft_outline + aft_zoom + aft_search allowed", () => {
        const perm = buildAllowOnlyPermission(HISTORIAN_ALLOWED_TOOLS);
        expect(perm).toEqual({
            "*": "deny",
            read: "allow",
            aft_outline: "allow",
            aft_zoom: "allow",
            aft_search: "allow",
        });
    });

    it("base dreamer (curate) permission object: `*` denied with no allow entry at all", () => {
        // An empty allow-list contributes no keys, so the object is the bare
        // wildcard deny: the curate session inherits none of the primary-agent
        // tool surface, ctx_memory included.
        const perm = buildAllowOnlyPermission(DREAMER_CURATE_ALLOWED_TOOLS);
        expect(perm).toEqual({ "*": "deny" });
        expect(Object.keys(perm)).toEqual(["*"]);
    });

    it("dreamer-docs permission object: `*` denied + repo-exploration + write/edit + aft_* (no memory)", () => {
        const perm = buildAllowOnlyPermission(DREAMER_DOCS_ALLOWED_TOOLS);
        expect(perm).toEqual({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            bash: "allow",
            write: "allow",
            edit: "allow",
            aft_outline: "allow",
            aft_zoom: "allow",
            aft_search: "allow",
        });
    });

    it("sidekick permission object: `*` denied + read-only retrieval/navigation allowed", () => {
        const perm = buildAllowOnlyPermission(SIDEKICK_ALLOWED_TOOLS);
        expect(perm).toEqual({
            "*": "deny",
            ctx_search: "allow",
            aft_outline: "allow",
            aft_zoom: "allow",
        });
    });
});
