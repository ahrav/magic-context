import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CALIBRATION_SCOPE, CALIBRATION_WORKFLOW_PATH } from "./calibration-scope";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

function workflowScopePaths(): string[] {
    const workflow = readFileSync(resolve(REPO_ROOT, CALIBRATION_WORKFLOW_PATH), "utf8");
    const digestLine = workflow
        .split("\n")
        .find((line) => line.includes("SCOPE_DIGEST:") && line.includes("hashFiles("));
    if (digestLine === undefined) {
        throw new Error(`${CALIBRATION_WORKFLOW_PATH} has no SCOPE_DIGEST hashFiles line`);
    }
    const args = /hashFiles\(([^)]*)\)/.exec(digestLine)?.[1];
    if (args === undefined) throw new Error("SCOPE_DIGEST hashFiles arguments did not parse");
    return [...args.matchAll(/'([^']+)'/g)].map(([, glob]) => glob!.replace(/\/\*\*$/, ""));
}

describe("paired-delta calibration scope", () => {
    it("matches the workflow's cache-key glob set path for path", () => {
        // A runner-only path can restore a cached record the workflow would not invalidate.
        expect([...workflowScopePaths()].sort()).toEqual([...CALIBRATION_SCOPE].sort());
    });

    it("names every scope path as tracked content", () => {
        for (const path of CALIBRATION_SCOPE) {
            const object = Bun.spawnSync(["git", "rev-parse", `HEAD:${path}`], { cwd: REPO_ROOT });
            expect(object.exitCode, path).toBe(0);
        }
    });
});
