/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import {
    type EmergencyDropTag,
    planEmergencyDrop,
    resolveToolTier,
    TARGET_FRACTION,
} from "./emergency-drop";

function planWithFloor(
    input: Omit<Parameters<typeof planEmergencyDrop>[0], "floorTags"> & {
        floorTags?: readonly EmergencyDropTag[];
    },
) {
    return planEmergencyDrop({ ...input, floorTags: input.floorTags ?? input.tags });
}

function tag(
    tagNumber: number,
    toolName: string | null,
    byteSize: number,
    opts: Partial<EmergencyDropTag> = {},
): EmergencyDropTag {
    return {
        tagNumber,
        type: "tool",
        status: "active",
        toolName,
        byteSize,
        inputByteSize: 0,
        reasoningByteSize: 0,
        ...opts,
    };
}

describe("resolveToolTier", () => {
    it("classifies T1 navigation/structure tools", () => {
        for (const name of ["read", "todowrite", "task", "aft_outline", "aft_zoom"]) {
            expect(resolveToolTier(name)).toBe(1);
        }
    });

    it("classifies T2 edit/search tools", () => {
        for (const name of ["edit", "write", "apply_patch", "grep", "glob", "aft_search"]) {
            expect(resolveToolTier(name)).toBe(2);
        }
    });

    it("classifies everything else as T3 (drop-first default)", () => {
        for (const name of ["bash", "ctx_reduce", "aft_inspect", "webfetch", "unknown_tool"]) {
            expect(resolveToolTier(name)).toBe(3);
        }
    });

    it("normalizes mcp_ prefix and case so prefixed names still tier correctly", () => {
        expect(resolveToolTier("mcp_read")).toBe(1);
        expect(resolveToolTier("MCP_Edit")).toBe(2);
        expect(resolveToolTier("Bash")).toBe(3);
    });

    it("treats null tool name as T3", () => {
        expect(resolveToolTier(null)).toBe(3);
    });
});

describe("planEmergencyDrop — guards", () => {
    const base = {
        maxTag: 10,
        protectedTags: 0,
        hasPriorDrop: false,
        priorInputSample: 0,
    };

    it("skips when the ceiling is unknown/invalid", () => {
        const plan = planWithFloor({
            ...base,
            tags: [tag(1, "bash", 4000)],
            currentTotalInputTokens: 100_000,
            ceilingTokens: 0,
        });
        expect(plan.shouldDrop).toBe(false);
        expect(plan.reason).toBe("unknown-ceiling");
    });

    it("no-ops when already at/under target (reclaim <= min)", () => {
        const plan = planWithFloor({
            ...base,
            tags: [tag(1, "bash", 4000)],
            currentTotalInputTokens: 1_000,
            ceilingTokens: 100_000,
        });
        expect(plan.shouldDrop).toBe(false);
    });
});

describe("planEmergencyDrop — floorTags/tags split", () => {
    it("reclaims to the true target when substantial non-tool tail exists (audit repro)", () => {
        // With 170k total tokens and a 130k ceiling, the 60k non-tool tail leaves a 30k fixed floor.
        // The 60k non-tool tail contributes to the floor but is not a drop candidate.
        // The 59,500-token reclaim requirement fits within the 80,000-token droppable-tool total.
        const TOKENS_PER_BYTE = 0.25; // mirror of emergency-drop internal ratio
        const toTokens = (bytes: number) => Math.round(bytes * TOKENS_PER_BYTE);

        const toolTags = Array.from({ length: 8 }, (_, i) =>
            tag(i + 1, "bash", 10_000 / TOKENS_PER_BYTE),
        );
        const messageTags = Array.from({ length: 6 }, (_, i) =>
            tag(i + 101, null, 10_000 / TOKENS_PER_BYTE, { type: "message" }),
        );
        expect(toolTags.reduce((s, t) => s + toTokens(t.byteSize), 0)).toBe(80_000);
        expect(messageTags.reduce((s, t) => s + toTokens(t.byteSize), 0)).toBe(60_000);

        const plan = planEmergencyDrop({
            tags: toolTags,
            floorTags: [...toolTags, ...messageTags],
            maxTag: 200,
            protectedTags: 0,
            currentTotalInputTokens: 170_000,
            ceilingTokens: 130_000,
            priorInputSample: 0,
            hasPriorDrop: false,
        });

        expect(plan.shouldDrop).toBe(true);
        expect(plan.reclaimTokens).toBe(110_000);
        expect(plan.tagNumbers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("never selects non-tool tags even when they dominate the floor set", () => {
        const toolTags = [tag(1, "bash", 40_000)];
        const messageTags = [
            tag(50, null, 400_000, { type: "message" }),
            tag(51, null, 400_000, { type: "file" }),
        ];
        const plan = planEmergencyDrop({
            tags: toolTags,
            floorTags: [...toolTags, ...messageTags],
            maxTag: 60,
            protectedTags: 0,
            currentTotalInputTokens: 300_000,
            ceilingTokens: 200_000,
            priorInputSample: 0,
            hasPriorDrop: false,
        });
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([1]);
    });
});

describe("planEmergencyDrop — target math", () => {
    it("computes target = fixedFloor + 0.30 × (ceiling − fixedFloor)", () => {
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "bash", 4000));
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedTags: 0,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 30_000,
            ceilingTokens: 160_000,
        });
        expect(TARGET_FRACTION).toBe(0.3);
        expect(plan.shouldDrop).toBe(false); // already under the 62k target
    });

    it("reclaims down toward target, dropping oldest T3 first", () => {
        const tags = Array.from({ length: 20 }, (_, i) => tag(i + 1, "bash", 2000));
        const plan = planWithFloor({
            tags,
            maxTag: 20,
            protectedTags: 2,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 10_000,
            ceilingTokens: 6_000,
        });
        expect(plan.shouldDrop).toBe(true);
        // oldest first
        expect(plan.tagNumbers[0]).toBe(1);
        expect(plan.tagNumbers).not.toContain(19);
        expect(plan.tagNumbers).not.toContain(20);
    });

    it("is idempotent across consecutive ≥85% passes on the same usage sample (no over-drop)", () => {
        const tags = Array.from({ length: 20 }, (_, i) => tag(i + 1, "bash", 1000));
        const first = planWithFloor({
            tags,
            maxTag: 20,
            protectedTags: 0,
            currentTotalInputTokens: 100_000,
            ceilingTokens: 60_000,
            hasPriorDrop: false,
            priorInputSample: 0,
        });
        expect(first.shouldDrop).toBe(true);
        // When the same input sample remains at or above 85% of the ceiling, the latch suppresses another drop.
        const second = planWithFloor({
            tags,
            maxTag: 20,
            protectedTags: 0,
            currentTotalInputTokens: 100_000, // unchanged — provider hasn't re-measured
            ceilingTokens: 60_000,
            hasPriorDrop: true,
            priorInputSample: 100_000, // latched from the first drop
        });
        expect(second.shouldDrop).toBe(false);
        expect(second.reason).toContain("same-input-sample");
        // A sample below 85% of the ceiling releases the latch and permits another evaluation.
        const third = planWithFloor({
            tags,
            maxTag: 20,
            protectedTags: 0,
            currentTotalInputTokens: 95_000, // new measured pressure
            ceilingTokens: 60_000,
            hasPriorDrop: true,
            priorInputSample: 100_000,
        });
        expect(third.reason).not.toContain("same-input-sample");
    });

    it("counts tool input + reasoning bytes in BOTH floor and reclaim (no under-evict)", () => {
        // Reclaim accounting must include input bytes because dropping a tag removes both its input and output.
        // Otherwise, output-only accounting exposes only 300 reclaimable tokens and the planner no-ops despite overflow.
        const big = tag(1, "write", 400, { inputByteSize: 40_000, reasoningByteSize: 8_000 });
        const small = tag(2, "bash", 800);
        const plan = planWithFloor({
            tags: [big, small],
            maxTag: 2,
            protectedTags: 0,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 20_000,
            ceilingTokens: 12_000,
        });
        expect(plan.shouldDrop).toBe(true);
        // The planner selects T3 `small` before T2 `big`, regardless of their sizes.
        // The plan must include `small` before `big` and count `big`'s input and reasoning bytes toward reclaim.
        expect(plan.tagNumbers).toContain(2); // T3 dropped first
        // The reclaim target (~11,010 tokens) exceeds the 300 tokens visible to output-only accounting.
        expect(plan.reclaimTokens).toBeGreaterThan(10_000);
    });
});

describe("planEmergencyDrop — tier ordering", () => {
    it("protects newest ctx_reduce exemplars in the emergency band instead of evicting them as T3", () => {
        const tags = Array.from({ length: 5 }, (_, index) => tag(index + 1, "ctx_reduce", 4_000));
        const plan = planWithFloor({
            tags,
            maxTag: 5,
            protectedTags: 0,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 6_000,
            ceilingTokens: 1_000,
        });

        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([1, 2]);
        expect(CTX_REDUCE_KEEP).toBe(3);
    });

    it("drops T3 before T2 before T1", () => {
        const tags = [
            tag(1, "read", 4000), // T1
            tag(2, "edit", 4000), // T2
            tag(3, "bash", 4000), // T3
            tag(4, "read", 4000), // T1
            tag(5, "edit", 4000), // T2
            tag(6, "bash", 4000), // T3
        ];
        const plan = planWithFloor({
            tags,
            maxTag: 6,
            protectedTags: 0,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 6_000,
            ceilingTokens: 1_000,
        });
        expect(plan.shouldDrop).toBe(true);
        const firstTwo = plan.tagNumbers.slice(0, 2).sort((a, b) => a - b);
        expect(firstTwo).toEqual([3, 6]);
    });

    it("reserves the newest 20% of T1/T2 tiers (ceil), never T3", () => {
        // Ten T2 edits reserve the two newest tags (9 and 10): ceil(0.2 × 10) = 2.
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "edit", 8000));
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedTags: 0,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 20_000, // tail = 10×2000 = 20000
            ceilingTokens: 1_000, // target ≈ 300 → reclaim huge
        });
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).not.toContain(9);
        expect(plan.tagNumbers).not.toContain(10);
        // The planner may evict tags 1–8.
        expect(plan.tagNumbers).toContain(1);
    });

    it("a tiny T1/T2 tier reserves all of it (ceil keeps >=1)", () => {
        const tags = [tag(1, "read", 8000), tag(2, "bash", 8000)];
        const plan = planWithFloor({
            tags,
            maxTag: 2,
            protectedTags: 0,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 4_000,
            ceilingTokens: 500,
        });
        // T1 read (tag 1) is the entire T1 tier → reserved (ceil(0.2×1)=1).
        expect(plan.tagNumbers).not.toContain(1);
        // T3 bash is fully depletable.
        expect(plan.tagNumbers).toContain(2);
    });
});

describe("planEmergencyDrop — idempotence via status='active' (no scalar watermark)", () => {
    it("re-considers ALL still-active tags (no scalar-watermark exclusion of lower tags)", () => {
        // Active tags 6–10 remain eligible after tags 1–5 have status `dropped`.
        // Tags 1–5 have status `dropped`, so the status guard skips them.
        const tags = [
            ...Array.from({ length: 5 }, (_, i) =>
                tag(i + 1, "bash", 4000, { status: "dropped" as const }),
            ),
            ...Array.from({ length: 5 }, (_, i) => tag(i + 6, "bash", 4000)),
        ];
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedTags: 0,
            hasPriorDrop: true,
            priorInputSample: 0, // fresh sample (0) ≠ current → latch released
            currentTotalInputTokens: 10_000,
            ceilingTokens: 1_000,
        });
        for (const n of [1, 2, 3, 4, 5]) expect(plan.tagNumbers).not.toContain(n);
        // Every still-active tag is eligible oldest-first.
        expect(plan.tagNumbers[0]).toBe(6);
    });

    it("no-ops when every active tag is already dropped", () => {
        const tags = Array.from({ length: 5 }, (_, i) =>
            tag(i + 1, "bash", 4000, { status: "dropped" as const }),
        );
        const plan = planWithFloor({
            tags,
            maxTag: 5,
            protectedTags: 0,
            hasPriorDrop: true,
            priorInputSample: 0,
            currentTotalInputTokens: 10_000,
            ceilingTokens: 1_000,
        });
        // No active tags leave no drop candidates.
        expect(plan.shouldDrop).toBe(false);
        expect(plan.tagNumbers).toEqual([]);
    });

    it("ignores already-dropped tags (status='dropped' is the re-selection guard)", () => {
        const tags = [
            tag(1, "bash", 4000, { status: "dropped" }),
            tag(2, "bash", 4000),
            tag(3, "bash", 4000),
        ];
        const plan = planWithFloor({
            tags,
            maxTag: 3,
            protectedTags: 0,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 3_000,
            ceilingTokens: 200,
        });
        expect(plan.tagNumbers).not.toContain(1);
    });
});
