
import { describe, expect, it } from "bun:test";
import { applyEditMarkerToInput, EDIT_REGION_HINT_LEN, isEditTool } from "./edit-marker";

describe("isEditTool", () => {
    it("matches edit and write only", () => {
        expect(isEditTool("edit")).toBe(true);
        expect(isEditTool("write")).toBe(true);
        expect(isEditTool("read")).toBe(false);
        expect(isEditTool("bash")).toBe(false);
        expect(isEditTool(null)).toBe(false);
        expect(isEditTool(undefined)).toBe(false);
    });
});

describe("applyEditMarkerToInput", () => {
    const longDiff = "## SECTION HEADER ".repeat(20); // > region hint

    it("preserves filePath verbatim, clamps diff keys to a region hint", () => {
        const input: Record<string, unknown> = {
            filePath: "/Users/me/project/very/long/path/to/file.ts",
            oldString: longDiff,
            newString: `${longDiff}!`,
        };
        applyEditMarkerToInput(input);
        expect(input.filePath).toBe("/Users/me/project/very/long/path/to/file.ts");
        expect(input.oldString).toBe(`${longDiff.slice(0, EDIT_REGION_HINT_LEN)}...[truncated]`);
        expect((input.newString as string).endsWith("...[truncated]")).toBe(true);
        expect((input.oldString as string).length).toBe(
            EDIT_REGION_HINT_LEN + "...[truncated]".length,
        );
    });

    it("clamps write's content key and preserves snake_case path", () => {
        const input: Record<string, unknown> = { file_path: "a/b.ts", content: longDiff };
        applyEditMarkerToInput(input);
        expect(input.file_path).toBe("a/b.ts");
        expect((input.content as string).endsWith("...[truncated]")).toBe(true);
    });

    it("leaves short diffs and non-diff keys untouched", () => {
        const input: Record<string, unknown> = {
            filePath: "x.ts",
            oldString: "short",
            replaceAll: true,
            occurrence: 2,
        };
        applyEditMarkerToInput(input);
        expect(input.oldString).toBe("short"); // below hint length
        expect(input.replaceAll).toBe(true);
        expect(input.occurrence).toBe(2);
    });

    it("is idempotent: applying twice yields identical bytes, no double sentinel", () => {
        const once: Record<string, unknown> = { filePath: "x.ts", oldString: longDiff };
        applyEditMarkerToInput(once);
        const afterOnce = { ...once };
        applyEditMarkerToInput(once);
        expect(once).toEqual(afterOnce);
        expect((once.oldString as string).match(/\.\.\.\[truncated\]/g)?.length).toBe(1);
    });

    it("does not re-clamp a value already ending in the truncation sentinel", () => {
        const input: Record<string, unknown> = {
            filePath: "x.ts",
            oldString: "already-a-hint...[truncated]",
        };
        applyEditMarkerToInput(input);
        expect(input.oldString).toBe("already-a-hint...[truncated]");
    });
});
