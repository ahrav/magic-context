/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    clearCtxReduceAvailability,
    clearTodowriteAvailability,
    permissionDisabled,
    resetCtxReduceRegisteredGloballyForTest,
    resolveCtxReduceAvailabilityFromMessages,
    resolveTodowriteAvailabilityFromMessages,
    resolveToolPermissionDenied,
    setCtxReduceRegisteredGlobally,
} from "./ctx-reduce-availability";

function userMsg(tools?: Record<string, unknown>) {
    return { info: { role: "user", ...(tools !== undefined ? { tools } : {}) } };
}

describe("ctx_reduce availability (spawn tools map)", () => {
    it("resolves false for an explicit allow-list without ctx_reduce", () => {
        clearCtxReduceAvailability("ses-allow");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-allow", [
            userMsg({ "*": false, read: true, grep: true }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("resolves true when ctx_reduce is explicitly allowed", () => {
        clearCtxReduceAvailability("ses-explicit");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-explicit", [
            userMsg({ "*": false, read: true, ctx_reduce: true }),
        ]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("fails open for sessions without a tools map (normal sessions)", () => {
        clearCtxReduceAvailability("ses-plain");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-plain", [userMsg()]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("resolves false when ctx_reduce is explicitly denied", () => {
        clearCtxReduceAvailability("ses-deny");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-deny", [
            userMsg({ ctx_reduce: false }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("freezes the verdict per session — later, different tool maps cannot flap it", () => {
        clearCtxReduceAvailability("ses-frozen");
        const first = resolveCtxReduceAvailabilityFromMessages("ses-frozen", [
            userMsg({ "*": false, read: true }),
        ]);
        expect(first).toEqual({ callable: false, frozen: true });
        // Same session, contradictory map on a later pass: cached verdict wins
        // (per-turn maps can differ; a flapping verdict would bust the cache).
        const second = resolveCtxReduceAvailabilityFromMessages("ses-frozen", [
            userMsg({ "*": false, ctx_reduce: true }),
        ]);
        expect(second).toEqual({ callable: false, frozen: true });
    });

    it("ignores non-user messages and falls open when the first user message carries no signal", () => {
        clearCtxReduceAvailability("ses-nosignal");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-nosignal", [
            { info: { role: "assistant" } },
            userMsg({}),
        ]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("does not freeze a fail-open verdict from an array with no user message", () => {
        clearCtxReduceAvailability("ses-no-user-yet");
        // No-user scans remain provisional until a user message supplies the session policy.
        const provisional = resolveCtxReduceAvailabilityFromMessages("ses-no-user-yet", [
            { info: { role: "assistant" } },
        ]);
        expect(provisional).toEqual({ callable: true, frozen: false });
        // The first user tools map freezes the session verdict.
        const final = resolveCtxReduceAvailabilityFromMessages("ses-no-user-yet", [
            { info: { role: "assistant" } },
            userMsg({ "*": false, read: true }),
        ]);
        expect(final).toEqual({ callable: false, frozen: true });
    });
});

describe("todowrite availability (generalized resolver)", () => {
    it("resolves false for an explicit allow-list without todowrite", () => {
        clearTodowriteAvailability("ses-td-allow");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-allow", [
            userMsg({ "*": false, read: true, grep: true }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("resolves true when todowrite is explicitly allowed", () => {
        clearTodowriteAvailability("ses-td-explicit");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-explicit", [
            userMsg({ "*": false, read: true, todowrite: true }),
        ]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("resolves false when todowrite is explicitly denied", () => {
        clearTodowriteAvailability("ses-td-deny");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-deny", [
            userMsg({ todowrite: false }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("fails open for sessions without a tools map (normal sessions)", () => {
        clearTodowriteAvailability("ses-td-plain");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-plain", [userMsg()]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("resolves ctx_reduce and todowrite independently for the same session", () => {
        // A tools map can keep ctx_reduce but filter todowrite (or vice versa);
        // the two verdicts must not bleed into each other through the cache.
        clearCtxReduceAvailability("ses-td-mixed");
        clearTodowriteAvailability("ses-td-mixed");
        const map = userMsg({ "*": false, ctx_reduce: true });
        const reduce = resolveCtxReduceAvailabilityFromMessages("ses-td-mixed", [map]);
        const todo = resolveTodowriteAvailabilityFromMessages("ses-td-mixed", [map]);
        expect(reduce).toEqual({ callable: true, frozen: true });
        expect(todo).toEqual({ callable: false, frozen: true });
    });
});

describe("OpenCode todowrite permission evaluator", () => {
    it("denies a top-level agent rule for the whole tool", () => {
        expect(
            permissionDisabled("todowrite", [
                { permission: "todowrite", pattern: "*", action: "deny" },
            ]),
        ).toBe(true);
    });

    it("uses findLast semantics so a later per-agent allow overrides deny", () => {
        expect(
            permissionDisabled("todowrite", [
                { permission: "todowrite", pattern: "*", action: "deny" },
                { permission: "todowrite", pattern: "*", action: "allow" },
            ]),
        ).toBe(false);
    });

    it("applies a session overlay after the merged agent rules", () => {
        expect(
            permissionDisabled("todowrite", [
                { permission: "todowrite", pattern: "*", action: "allow" },
                { permission: "todowrite", pattern: "*", action: "deny" },
            ]),
        ).toBe(true);
    });

    it("fails open when no rule matches", () => {
        expect(permissionDisabled("todowrite", [])).toBe(false);
        expect(
            permissionDisabled("todowrite", [
                { permission: "todowrite", pattern: "src/**", action: "deny" },
            ]),
        ).toBe(false);
    });

    it("treats regex punctuation literally while preserving wildcard segments", () => {
        const deny = (permission: string, toolName: string): boolean =>
            permissionDisabled(toolName, [{ permission, pattern: "*", action: "deny" }]);

        expect(() => deny("to(do*", "to(doThing")).not.toThrow();
        expect(deny("to(do*", "to(doThing")).toBe(true);
        expect(deny("to(do*", "todoThing")).toBe(false);
        expect(deny("todo.rite*", "todo.riteLater")).toBe(true);
        expect(deny("todo.rite*", "todowriteLater")).toBe(false);
        expect(deny("to*write", "todowrite")).toBe(true);
        expect(deny("to*write", "to-something-write")).toBe(true);
        expect(deny("*", "todowrite")).toBe(true);
        expect(deny("todowrite", "todowrite")).toBe(true);
    });

    it("reads the active agent and session overlay through the SDK", async () => {
        const client = {
            app: {
                agents: async () => ({
                    data: [
                        {
                            name: "build",
                            permission: [
                                { permission: "todowrite", pattern: "*", action: "allow" },
                            ],
                        },
                    ],
                }),
            },
            session: {
                get: async () => ({
                    data: {
                        agent: "build",
                        permission: {
                            todowrite: "deny",
                        },
                    },
                }),
            },
        } as never;
        await expect(
            resolveToolPermissionDenied(client, "ses-permission-overlay", "todowrite"),
        ).resolves.toBe(true);
    });
});

describe("ctx_reduce process-global registration override (compaction-off #266 S4)", () => {
    // The override applies process-wide.
    // `afterEach` resets the process-wide override to `true` so later tests cannot inherit `false`.
    // `afterEach` resets the process-wide override to `true` so later tests cannot inherit `false`.
    it("when ctx_reduce is not registered globally, every session resolves callable=false frozen=true", () => {
        setCtxReduceRegisteredGlobally(false);
        try {
            // The override must force `callable=false` so unregistration reaches guidance, nudges, and `§N§` prefix injection.
            // The override must force `callable=false` so unregistration reaches guidance, nudges, and `§N§` prefix injection.
            clearCtxReduceAvailability("ses-plain-off");
            const verdict = resolveCtxReduceAvailabilityFromMessages("ses-plain-off", [userMsg()]);
            expect(verdict).toEqual({ callable: false, frozen: true });

            // Global registration takes precedence over a per-session `ctx_reduce` allow.
            // Global registration takes precedence over a per-session `ctx_reduce` allow.
            // Global unregistration overrides the per-session map.
            clearCtxReduceAvailability("ses-allow-off");
            const verdictAllow = resolveCtxReduceAvailabilityFromMessages("ses-allow-off", [
                userMsg({ "*": false, ctx_reduce: true }),
            ]);
            expect(verdictAllow).toEqual({ callable: false, frozen: true });
        } finally {
            resetCtxReduceRegisteredGloballyForTest();
        }
    });

    it("the override is specific to ctx_reduce — todowrite is unaffected", () => {
        setCtxReduceRegisteredGlobally(false);
        try {
            clearTodowriteAvailability("ses-td-off");
            const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-off", [userMsg()]);
            expect(verdict).toEqual({ callable: true, frozen: true });
        } finally {
            resetCtxReduceRegisteredGloballyForTest();
        }
    });

    it("when ctx_reduce IS registered globally (default), the per-session tools map decides as before", () => {
        // With `registered=true`, the per-session tools map determines `ctx_reduce` availability.
        clearCtxReduceAvailability("ses-plain-on");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-plain-on", [userMsg()]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    // `callable=false` in compaction-off mode closes the nudge gate; no separate mode gate is needed at the nudge site.
    it("nudge gate source: compaction-off resolves callable=false (Channel-1/Channel-2 stay silent)", () => {
        setCtxReduceRegisteredGlobally(false);
        try {
            clearCtxReduceAvailability("ses-nudge-off");
            const verdict = resolveCtxReduceAvailabilityFromMessages("ses-nudge-off", [userMsg()]);
            // `callable=false` prevents the Channel-1 append and Channel-2 claim.
            // `callable=false` prevents the Channel-1 append and Channel-2 claim.
            expect(verdict.callable).toBe(false);
            expect(verdict.frozen).toBe(true);
        } finally {
            resetCtxReduceRegisteredGloballyForTest();
        }
    });
});
