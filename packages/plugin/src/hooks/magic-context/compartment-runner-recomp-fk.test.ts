import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// recomp must link each historian_runs row to the invocation produced by the validated pass.
// recomp records model invocations with subagent='recomp'.
// getLatestHistorianInvocationId() filters for subagent='historian'.
// A recomp historian_runs row must reference the recomp pass invocation, not a historian invocation.
// ValidatedHistorianPassResult carries the successful attempt's invocation ID.

const recompSrc = readFileSync(join(import.meta.dir, "compartment-runner-recomp.ts"), "utf8");
const historianSrc = readFileSync(join(import.meta.dir, "compartment-runner-historian.ts"), "utf8");

test("recomp links historian_runs FK via the threaded validatedPass.invocationId", () => {
    const matches = recompSrc.match(/subagentInvocationId:\s*validatedPass\.invocationId/g);
    expect(matches).not.toBeNull();
    // A success record and a failure record require at least two sites.
    expect((matches ?? []).length).toBeGreaterThanOrEqual(2);
});

test("recomp does NOT use the kind-filtered latest-invocation lookup for the FK", () => {
    // getLatestHistorianInvocationId filters for subagent='historian'.
    // recomp must not call getLatestHistorianInvocationId because it cannot return a recomp invocation.
    expect(recompSrc.includes("getLatestHistorianInvocationId")).toBe(false);
});

test("recomp records a terminal failure row (status failed + reason)", () => {
    // historian_runs records failed runs and their failure reasons.
    expect(recompSrc).toContain('status: "failed"');
    expect(recompSrc).toContain("failureReason: validatedPass.error");
});

test("runValidatedHistorianPass threads invocationId on every success path", () => {
    // The first-pass, repair, editor-accepted, and fallback success returns carry their producing attempt's invocation ID.
    expect(historianSrc).toContain("invocationId: firstRun.invocationId");
    expect(historianSrc).toContain("invocationId: repairRun.invocationId");
    expect(historianSrc).toContain("invocationId: editorRun.invocationId");
    expect(historianSrc).toContain("invocationId: fallbackRun.invocationId");
});
