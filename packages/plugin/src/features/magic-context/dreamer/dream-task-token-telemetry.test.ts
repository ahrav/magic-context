import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

//
// The dashboard groups dreamer subagent_invocations by task and matches task to the dream_runs row name.
// dream_runs row names use config.task, so each invocation task must equal config.task.
// Each specialized runner must record its own LLM token usage with subagent: "dreamer" and task: config.task.
// Each specialized runner must call recordChildInvocation with subagent: "dreamer" and the canonical task name.
// A mismatched invocation task makes the dashboard show "—" tokens for the LLM call.

const HERE = import.meta.dir;

function read(relFromFeatures: string): string {
    return readFileSync(join(HERE, "..", relFromFeatures), "utf-8");
}

describe("dream-task token telemetry mapping", () => {
    it('user-memory review records a dreamer invocation tagged task:"review-user-memories"', () => {
        const src = read("user-memory/review-user-memories.ts");
        expect(src.includes("recordChildInvocation")).toBe(true);
        expect(src.includes('subagent: "dreamer"')).toBe(true);
        expect(src.includes('task: "review-user-memories"')).toBe(true);
    });

    it('smart-notes records a dreamer invocation tagged task:"evaluate-smart-notes"', () => {
        const src = read("dreamer/evaluate-smart-notes.ts");
        expect(src.includes("recordChildInvocation")).toBe(true);
        expect(src.includes('subagent: "dreamer"')).toBe(true);
        expect(src.includes('task: "evaluate-smart-notes"')).toBe(true);
    });

    it("the agentic executor records invocations under the canonical task name", () => {
        const exec = read("dreamer/task-executor.ts");
        // The agentic path records with `task` = the canonical config.task name
        // (verify/curate/maintain-docs).
        expect(exec.includes("recordChildInvocation")).toBe(true);
        expect(exec.includes('subagent: "dreamer"')).toBe(true);
        expect(exec.includes("task,")).toBe(true);
    });
});
