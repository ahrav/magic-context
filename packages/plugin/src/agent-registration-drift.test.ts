import { describe, expect, test } from "bun:test";
import {
    DREAMER_AGENT,
    DREAMER_CLASSIFIER_AGENT,
    DREAMER_CURATE_ALLOWED_TOOLS,
    DREAMER_DOCS_AGENT,
    DREAMER_DOCS_ALLOWED_TOOLS,
    DREAMER_MEMORY_MAPPER_AGENT,
    DREAMER_MEMORY_MAPPER_ALLOWED_TOOLS,
    DREAMER_PRIMER_INVESTIGATOR_AGENT,
    DREAMER_RETROSPECTIVE_AGENT,
    DREAMER_REVIEWER_AGENT,
} from "./agents/dreamer";
import {
    buildHiddenAgentConfig,
    buildHiddenAgentRegistrations,
    HIDDEN_AGENT_DESCRIPTION_MARKER,
} from "./agents/hidden-agent-registrations";
import {
    HISTORIAN_AGENT,
    HISTORIAN_EDITOR_AGENT,
    HISTORIAN_RECOMP_AGENT,
} from "./agents/historian";
import {
    DREAMER_PRIMER_INVESTIGATOR_ALLOWED_TOOLS,
    DREAMER_RETROSPECTIVE_ALLOWED_TOOLS,
    denyTaskRoutingToAgents,
    denyTaskRoutingToCallerAgents,
    HISTORIAN_ALLOWED_TOOLS,
    SIDEKICK_ALLOWED_TOOLS,
    SMART_NOTE_COMPILER_ALLOWED_TOOLS,
} from "./agents/permissions";
import { SIDEKICK_AGENT } from "./agents/sidekick";
import { SMART_NOTE_COMPILER_AGENT } from "./agents/smart-note-compiler";

/**
 * `buildHiddenAgentRegistrations` deliberately uses INLINE literals for the
 * agent ids / tool allow-lists / step caps instead of the imported module-level
 * consts — because OpenCode Desktop's concurrent per-directory cold boot can
 * leave those `var` consts undefined at config-hook time (the hoisted-function
 * call works, the const args read undefined). See the docs on
 * HiddenAgentRegistration in index.ts.
 *
 * The cost of inlining is drift: someone edits the canonical export but not the
 * inline copy. These tests are the guard — they fail if the two diverge, so the
 * inline literals stay byte-identical to the canonical constants.
 */
describe("hidden-agent registration drift guard", () => {
    const regs = buildHiddenAgentRegistrations({
        dreamerPrompt: "dreamer-prompt",
        historianPrompt: "historian-prompt",
        historianRecompPrompt: "historian-recomp-prompt",
        historianEditorPrompt: "historian-editor-prompt",
        sidekickPrompt: "sidekick-prompt",
        historianDisallowed: [],
    });
    const byId = (id: string) => regs.find((r) => r.id === id);

    test("registers hidden agents with canonical ids", () => {
        expect(regs.map((r) => r.id).sort()).toEqual(
            [
                DREAMER_AGENT,
                DREAMER_DOCS_AGENT,
                DREAMER_REVIEWER_AGENT,
                DREAMER_RETROSPECTIVE_AGENT,
                DREAMER_PRIMER_INVESTIGATOR_AGENT,
                DREAMER_MEMORY_MAPPER_AGENT,
                DREAMER_CLASSIFIER_AGENT,
                SMART_NOTE_COMPILER_AGENT,
                HISTORIAN_AGENT,
                HISTORIAN_EDITOR_AGENT,
                HISTORIAN_RECOMP_AGENT,
                SIDEKICK_AGENT,
            ].sort(),
        );
    });

    test("all Magic Context worker ids are denied through Task routing", () => {
        const permission = denyTaskRoutingToAgents(
            { task: { "*": "allow", "user-reviewer": "ask" } },
            regs.map((reg) => reg.id),
        ) as { task: Record<string, string> };

        for (const reg of regs) {
            expect(permission.task[reg.id]).toBe("deny");
        }
        expect(permission.task["user-reviewer"]).toBe("ask");
    });

    test("Task-routing denies apply only to Task callers", () => {
        const subagentPermission = { "*": "deny", read: "allow" };
        const agentConfigs = {
            "custom-primary": { mode: "primary", permission: { task: { "*": "allow" } } },
            "custom-all": { mode: "all", permission: { "*": "deny" } },
            "custom-no-mode": { permission: subagentPermission },
            "ordinary-subagent": { mode: "subagent", permission: subagentPermission },
            general: { permission: subagentPermission },
            explore: { permission: subagentPermission },
        };
        const configured = denyTaskRoutingToCallerAgents(
            agentConfigs,
            regs.map((reg) => reg.id),
        );

        for (const callerId of ["build", "plan", "custom-primary"]) {
            const task = configured[callerId].permission as { task: Record<string, string> };
            for (const reg of regs) {
                expect(task.task[reg.id]).toBe("deny");
            }
        }
        for (const subagentId of [
            "custom-all",
            "custom-no-mode",
            "ordinary-subagent",
            "general",
            "explore",
        ]) {
            const permission = configured[subagentId].permission as Record<string, unknown>;
            expect(permission).toEqual(
                subagentId === "custom-all" ? { "*": "deny" } : subagentPermission,
            );
            expect(permission.task).toBeUndefined();
        }

        for (const [agentId, mode] of [
            ["build", "all"],
            ["build", "subagent"],
            ["plan", "all"],
            ["plan", "subagent"],
        ] as const) {
            const overridden = denyTaskRoutingToCallerAgents(
                { [agentId]: { mode, permission: subagentPermission } },
                regs.map((reg) => reg.id),
            );
            const permission = overridden[agentId].permission as Record<string, unknown>;
            expect(permission).toEqual(subagentPermission);
            expect(permission.task).toBeUndefined();
        }
    });

    test("Task-routing denies preserve unrelated user permissions and win last", () => {
        const userPermission = {
            "*": "allow",
            bash: { "git status*": "ask" },
            task: {
                [DREAMER_REVIEWER_AGENT]: "allow",
                "*": "allow",
                "custom-worker": "ask",
            },
        };
        const permission = denyTaskRoutingToAgents(userPermission, [DREAMER_REVIEWER_AGENT]);

        expect(permission).toEqual({
            "*": "allow",
            bash: { "git status*": "ask" },
            task: {
                "*": "allow",
                "custom-worker": "ask",
                [DREAMER_REVIEWER_AGENT]: "deny",
            },
        });
        expect(userPermission.task[DREAMER_REVIEWER_AGENT]).toBe("allow");
        expect(Object.keys(permission).at(-1)).toBe("task");
        expect(Object.keys(permission.task).at(-1)).toBe(DREAMER_REVIEWER_AGENT);
    });

    test("Task-routing denies support OpenCode's whole-permission action form", () => {
        expect(denyTaskRoutingToAgents("allow", [DREAMER_REVIEWER_AGENT])).toEqual({
            "*": "allow",
            task: { [DREAMER_REVIEWER_AGENT]: "deny" },
        });
    });

    // Since #285, internal agents register as mode "primary" + hidden (excluded
    // from describeTask); the Task-permission denies in this suite cover the
    // explicit subagent_type bypass that mode/hidden metadata cannot.
    test("internal direct-prompt agent configuration remains hidden from routing", () => {
        const config = buildHiddenAgentConfig(
            "reviewer prompt",
            [],
            4,
            undefined,
            DREAMER_REVIEWER_AGENT,
            true,
        );

        expect(config.prompt).toBe("reviewer prompt");
        expect(config.mode).toBe("primary");
        expect(config.hidden).toBe(true);
        expect(config.permission).toEqual({ "*": "deny" });
    });

    test("every hidden agent has an internal-only task-routing description", () => {
        expect(regs).toHaveLength(12);
        for (const registration of regs) {
            expect(registration.mode, registration.id).toBe("primary");
            expect(registration.hidden, registration.id).toBe(true);
            expect(registration.description, registration.id).toContain(
                HIDDEN_AGENT_DESCRIPTION_MARKER,
            );
            expect(registration.description, registration.id).toContain("do not select");
        }
    });

    test("classifier is a zero-tool locked pure transform", () => {
        expect(byId(DREAMER_CLASSIFIER_AGENT)?.allowedTools).toEqual([]);
        expect(byId(DREAMER_CLASSIFIER_AGENT)?.lockPermissions).toBe(true);
        expect(byId(DREAMER_CLASSIFIER_AGENT)?.maxSteps).toBe(4);
    });

    test("base dreamer (curate) is tool-free and locked", () => {
        expect(byId(DREAMER_AGENT)?.allowedTools).toEqual([...DREAMER_CURATE_ALLOWED_TOOLS]);
        // Curate's only write path is the XML manifest the host applies inside a
        // guarded transaction, so it holds no tools at all — ctx_memory would let
        // a run mutate claims outside that transaction.
        expect(byId(DREAMER_AGENT)?.allowedTools).toEqual([]);
        expect(byId(DREAMER_AGENT)?.lockPermissions).toBe(true);
        expect(byId(DREAMER_AGENT)?.maxSteps).toBe(150);
    });

    test("dreamer-docs inline allow-list matches canonical (file read/write/bash, no memory) and is locked", () => {
        expect(byId(DREAMER_DOCS_AGENT)?.allowedTools).toEqual([...DREAMER_DOCS_ALLOWED_TOOLS]);
        const tools = byId(DREAMER_DOCS_AGENT)?.allowedTools ?? [];
        for (const denied of ["ctx_memory", "ctx_search", "ctx_note", "task"]) {
            expect(tools).not.toContain(denied);
        }
        expect(byId(DREAMER_DOCS_AGENT)?.lockPermissions).toBe(true);
        expect(byId(DREAMER_DOCS_AGENT)?.maxSteps).toBe(60);
    });

    test("dreamer-reviewer is a zero-tool locked JSON reviewer", () => {
        expect(byId(DREAMER_REVIEWER_AGENT)?.allowedTools).toEqual([]);
        expect(byId(DREAMER_REVIEWER_AGENT)?.lockPermissions).toBe(true);
        expect(byId(DREAMER_REVIEWER_AGENT)?.maxSteps).toBe(4);
    });

    test("memory mapper inline allow-list matches canonical (read-only, no write/ctx_memory/ctx_search)", () => {
        expect(byId(DREAMER_MEMORY_MAPPER_AGENT)?.allowedTools).toEqual([
            ...DREAMER_MEMORY_MAPPER_ALLOWED_TOOLS,
        ]);
        const tools = byId(DREAMER_MEMORY_MAPPER_AGENT)?.allowedTools ?? [];
        for (const denied of ["write", "edit", "bash", "ctx_memory", "ctx_note", "ctx_search"]) {
            expect(tools).not.toContain(denied);
        }
        expect(byId(DREAMER_MEMORY_MAPPER_AGENT)?.lockPermissions).toBe(true);
        expect(byId(DREAMER_MEMORY_MAPPER_AGENT)?.maxSteps).toBe(60);
    });

    test("retrospective inline allow-list is ctx_search only", () => {
        expect(byId(DREAMER_RETROSPECTIVE_AGENT)?.allowedTools).toEqual([
            ...DREAMER_RETROSPECTIVE_ALLOWED_TOOLS,
        ]);
    });

    test("primer investigator inline allow-list matches canonical (read-only, no write/ctx_memory)", () => {
        expect(byId(DREAMER_PRIMER_INVESTIGATOR_AGENT)?.allowedTools).toEqual([
            ...DREAMER_PRIMER_INVESTIGATOR_ALLOWED_TOOLS,
        ]);
        // The whole point: the cache-neutral / source-safety guarantee.
        const tools = byId(DREAMER_PRIMER_INVESTIGATOR_AGENT)?.allowedTools ?? [];
        for (const denied of ["write", "edit", "bash", "ctx_memory", "ctx_note"]) {
            expect(tools).not.toContain(denied);
        }
        expect(byId(DREAMER_PRIMER_INVESTIGATOR_AGENT)?.lockPermissions).toBe(true);
        expect(byId(DREAMER_PRIMER_INVESTIGATOR_AGENT)?.maxSteps).toBe(40);
    });

    test("smart-note compiler has no tools and locked permissions", () => {
        expect(byId(SMART_NOTE_COMPILER_AGENT)?.allowedTools).toEqual([
            ...SMART_NOTE_COMPILER_ALLOWED_TOOLS,
        ]);
        expect(byId(SMART_NOTE_COMPILER_AGENT)?.lockPermissions).toBe(true);
    });

    test("every scoped dreamer task agent locks permissions; historian/sidekick do not", () => {
        // All dreamer task agents run unsupervised on a per-task tool budget, so a
        // user `dreamer.tools`/`permission` override must not be able to broaden
        // them. The historian/sidekick/editor are not locked (they take their
        // allow-list as-is and have no per-task scoping to protect).
        const lockedDreamerAgents = new Set<string>([
            DREAMER_AGENT,
            DREAMER_DOCS_AGENT,
            DREAMER_REVIEWER_AGENT,
            DREAMER_RETROSPECTIVE_AGENT,
            DREAMER_PRIMER_INVESTIGATOR_AGENT,
            DREAMER_MEMORY_MAPPER_AGENT,
            DREAMER_CLASSIFIER_AGENT,
            SMART_NOTE_COMPILER_AGENT,
        ]);
        for (const reg of regs) {
            expect(reg.lockPermissions === true).toBe(lockedDreamerAgents.has(reg.id));
        }
    });

    test("a user dreamer permission override cannot broaden the retrospective agent", () => {
        // Simulate a user dreamer config that tries to grant bash/ctx_memory.
        const cfg = buildHiddenAgentConfig(
            "prompt",
            DREAMER_RETROSPECTIVE_ALLOWED_TOOLS,
            40,
            { permission: { bash: "allow", ctx_memory: "allow", edit: "allow" } },
            DREAMER_RETROSPECTIVE_AGENT,
            true,
        ) as { permission: Record<string, string> };
        expect(cfg.permission.bash).not.toBe("allow");
        expect(cfg.permission.ctx_memory).not.toBe("allow");
        expect(cfg.permission.edit).not.toBe("allow");
        expect(cfg.permission.ctx_search).toBe("allow");
    });

    test("a user dreamer tools override cannot re-enable a tool on the locked agent", () => {
        const cfg = buildHiddenAgentConfig(
            "prompt",
            DREAMER_RETROSPECTIVE_ALLOWED_TOOLS,
            40,
            { tools: { bash: true, edit: true, ctx_memory: true } },
            DREAMER_RETROSPECTIVE_AGENT,
            true,
        ) as { tools?: Record<string, boolean> };
        // The user `tools` map is dropped entirely under lockPermissions.
        expect(cfg.tools).toBeUndefined();
    });

    test("an UNLOCKED agent keeps its user tools override", () => {
        const cfg = buildHiddenAgentConfig(
            "prompt",
            ["ctx_search", "ctx_memory"],
            40,
            { tools: { aft_search: false } },
            DREAMER_AGENT,
            false,
        ) as { tools?: Record<string, boolean> };
        expect(cfg.tools).toEqual({ aft_search: false });
    });

    test("sidekick inline allow-list matches canonical SIDEKICK_ALLOWED_TOOLS", () => {
        expect(byId(SIDEKICK_AGENT)?.allowedTools).toEqual([...SIDEKICK_ALLOWED_TOOLS]);
    });

    test("historian + editor inline allow-list matches canonical HISTORIAN_ALLOWED_TOOLS (no disallowed)", () => {
        expect(byId(HISTORIAN_AGENT)?.allowedTools).toEqual([...HISTORIAN_ALLOWED_TOOLS]);
        expect(byId(HISTORIAN_RECOMP_AGENT)?.allowedTools).toEqual([...HISTORIAN_ALLOWED_TOOLS]);
        expect(byId(HISTORIAN_EDITOR_AGENT)?.allowedTools).toEqual([...HISTORIAN_ALLOWED_TOOLS]);
    });

    test("historian disallowed_tools filter is applied to the inline allow-list", () => {
        const filtered = buildHiddenAgentRegistrations({
            dreamerPrompt: "d",
            historianPrompt: "h",
            historianEditorPrompt: "he",
            sidekickPrompt: "s",
            historianDisallowed: ["aft_search"],
        });
        const hist = filtered.find((r) => r.id === HISTORIAN_AGENT);
        expect(hist?.allowedTools).toEqual(
            HISTORIAN_ALLOWED_TOOLS.filter((t) => t !== "aft_search"),
        );
        // "*" removes everything.
        const all = buildHiddenAgentRegistrations({
            dreamerPrompt: "d",
            historianPrompt: "h",
            historianEditorPrompt: "he",
            sidekickPrompt: "s",
            historianDisallowed: ["*"],
        });
        expect(all.find((r) => r.id === HISTORIAN_AGENT)?.allowedTools).toEqual([]);
    });

    test("step caps match the documented values", () => {
        expect(byId(DREAMER_AGENT)?.maxSteps).toBe(150);
        expect(byId(DREAMER_RETROSPECTIVE_AGENT)?.maxSteps).toBe(40);
        expect(byId(SMART_NOTE_COMPILER_AGENT)?.maxSteps).toBe(8);
        expect(byId(HISTORIAN_AGENT)?.maxSteps).toBe(40);
        expect(byId(HISTORIAN_EDITOR_AGENT)?.maxSteps).toBe(40);
        expect(byId(SIDEKICK_AGENT)?.maxSteps).toBe(40);
    });

    test("smart-note compiler uses only its own prompt", () => {
        const regs = buildHiddenAgentRegistrations({
            dreamerPrompt: "dreamer-prompt",
            smartNoteCompilerPrompt: undefined,
            historianPrompt: "historian-prompt",
            historianEditorPrompt: "historian-editor-prompt",
            sidekickPrompt: "sidekick-prompt",
            historianDisallowed: [],
        });
        expect(regs.find((r) => r.id === SMART_NOTE_COMPILER_AGENT)?.prompt).toBeUndefined();
    });

    test("each agent carries its passed-through prompt (undefined-safe)", () => {
        expect(byId(DREAMER_AGENT)?.prompt).toBe("dreamer-prompt");
        // Robustness contract: an undefined prompt is carried through (the config
        // hook skips that agent), not coerced.
        const noPrompts = buildHiddenAgentRegistrations({
            dreamerPrompt: undefined,
            historianPrompt: undefined,
            historianEditorPrompt: undefined,
            sidekickPrompt: undefined,
            historianDisallowed: [],
        });
        expect(noPrompts.every((r) => r.prompt === undefined)).toBe(true);
        // ...but the ids and allow-lists are STILL present (the whole point —
        // they don't depend on module-init timing).
        expect(noPrompts.map((r) => r.id).sort()).toEqual(
            [
                DREAMER_AGENT,
                DREAMER_DOCS_AGENT,
                DREAMER_REVIEWER_AGENT,
                DREAMER_RETROSPECTIVE_AGENT,
                DREAMER_PRIMER_INVESTIGATOR_AGENT,
                DREAMER_MEMORY_MAPPER_AGENT,
                DREAMER_CLASSIFIER_AGENT,
                SMART_NOTE_COMPILER_AGENT,
                HISTORIAN_AGENT,
                HISTORIAN_EDITOR_AGENT,
                HISTORIAN_RECOMP_AGENT,
                SIDEKICK_AGENT,
            ].sort(),
        );
    });
});
