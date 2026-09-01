import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 *
 * revert.
 */

function codeWithoutComments(path: string): string {
    return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
}

describe("channel 2 fires for subagents", () => {
    it("transform trigger does NOT gate the persisted U/T baseline on fullFeatureMode", () => {
        const src = codeWithoutComments(join(import.meta.dir, "transform.ts"));
        const idx = src.indexOf("const channelBaseline =");
        expect(idx).toBeGreaterThan(-1);
        const triggerBlock = src.slice(idx, src.indexOf("const elapsed", idx));
        expect(triggerBlock).not.toContain("fullFeatureMode");
        expect(triggerBlock).toContain("evaluateChannel2");
        expect(triggerBlock).toContain("channelBaseline.evaluable");
    });

    it("delivery wrapper does NOT early-return for subagents", () => {
        const src = codeWithoutComments(join(import.meta.dir, "event-handler.ts"));
        const fnIdx = src.indexOf("async function deliverChannel2IfPending");
        expect(fnIdx).toBeGreaterThan(-1);
        const fnBody = src.slice(fnIdx, src.indexOf("\n}\n", fnIdx));
        expect(fnBody).not.toContain("isSubagent");
    });
});
