/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    extractMessageText,
    isInternalOpenCodeAgentRequest,
} from "../src/cache-analysis";
import type { CapturedRequest } from "../src/mock-provider/server";
import { TestHarness, type TestHarnessOptions } from "../src/harness";
import { goldEvidencePrompt } from "../src/oracle-arms/gold-evidence";
import { mcOffOptions, naiveCompactionOptions } from "../src/oracle-arms/presets";
import { scriptedCtxSearchTurn } from "../src/oracle-arms/scripted-ctx-search";
import { seedGoldMemories } from "../src/oracle-arms/seed-gold-memories";

const GOLD_CONTENTS = ["Oracle release channel is amber.", "Oracle retry limit is three."] as const;

interface WireObservation {
    projectMemory: string | null;
    text: string;
    tools: string[];
}

function allStrings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(allStrings);
    if (!value || typeof value !== "object") return [];
    return Object.values(value).flatMap(allStrings);
}

function isMainAgentRequest(request: CapturedRequest, marker: string): boolean {
    return (
        JSON.stringify(request.body.messages).includes(marker) &&
        !isInternalOpenCodeAgentRequest(request)
    );
}

function observeMainRequest(harness: TestHarness, marker: string): WireObservation {
    const requests = harness.mock.requests();
    for (let index = requests.length - 1; index >= 0; index--) {
        const request = requests[index];
        if (request && isMainAgentRequest(request, marker)) return observe(request);
    }
    throw new Error(`no main-agent wire request contained ${marker}`);
}

function observe(request: CapturedRequest): WireObservation {
    const tools = Array.isArray(request.body.tools)
        ? request.body.tools.flatMap((tool) => {
              if (!tool || typeof tool !== "object") return [];
              const name = (tool as { name?: unknown }).name;
              return typeof name === "string" ? [name] : [];
          })
        : [];
    const text = allStrings(request.body.messages ?? []).join("\n");
    const memoryText = extractMessageText(request.body, "<project-memory>");
    return {
        projectMemory:
            memoryText?.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0] ?? null,
        text,
        tools,
    };
}

async function withHarness(
    options: TestHarnessOptions,
    run: (harness: TestHarness) => Promise<void>,
): Promise<void> {
    const harness = await TestHarness.create(options);
    try {
        await run(harness);
    } finally {
        await harness.dispose();
    }
}

function seedGold(harness: TestHarness, verification: "candidate" | "verified") {
    return seedGoldMemories({
        workdir: harness.opencode.env.workdir,
        dbPath: harness.contextDbPath(),
        verification,
        rows: GOLD_CONTENTS.map((content) => ({
            category: "PROJECT_RULES" as const,
            content,
        })),
    });
}

describe("oracle arms demonstration", () => {
    it("R0 observes no oracle gold", async () => {
        await withHarness({}, async (harness) => {
            const marker = "oracle-demo-r0";
            const sessionId = await harness.createSession();
            await harness.sendPrompt(sessionId, marker);

            const wire = observeMainRequest(harness, marker);
            for (const content of GOLD_CONTENTS) expect(wire.text).not.toContain(content);
        });
    }, 120_000);

    it("R1 retrieves candidate gold without project-memory injection", async () => {
        await withHarness({}, async (harness) => {
            const candidates = seedGold(harness, "candidate");
            const sessionId = await harness.createSession();
            const result = await scriptedCtxSearchTurn(harness, sessionId, candidates);

            for (const content of GOLD_CONTENTS) expect(result).toContain(content);
            const wire = observeMainRequest(harness, GOLD_CONTENTS[0]);
            expect(wire.tools).toContain("ctx_search");
            expect(wire.projectMemory).toBeNull();
            for (const content of GOLD_CONTENTS) {
                expect(wire.text).toContain(content);
            }
        });
    }, 120_000);

    it("R2 injects gold inside the exact project-memory block", async () => {
        await withHarness({}, async (harness) => {
            seedGold(harness, "verified");
            const marker = "oracle-demo-r2";
            const sessionId = await harness.createSession();
            await harness.sendPrompt(sessionId, marker);

            const memory = observeMainRequest(harness, marker).projectMemory;
            expect(memory, "project-memory block absent").not.toBeNull();
            if (memory === null) throw new Error("project-memory block absent");
            for (const content of GOLD_CONTENTS) expect(memory).toContain(content);
        });
    }, 120_000);

    it("R3 passes gold evidence through the prompt", async () => {
        await withHarness({}, async (harness) => {
            const prompt = goldEvidencePrompt(
                GOLD_CONTENTS.map((content, index) => ({
                    label: `oracle-${index + 1}`,
                    content,
                })),
            );
            const sessionId = await harness.createSession();
            await harness.sendPrompt(sessionId, prompt);

            expect(observeMainRequest(harness, GOLD_CONTENTS[0]).text).toContain(prompt);
        });
    }, 120_000);

    it("MC-off passes gold evidence without plugin surfaces", async () => {
        await withHarness(mcOffOptions(), async (harness) => {
            const prompt = goldEvidencePrompt([
                { label: "oracle", content: `${GOLD_CONTENTS[0]} mc-off` },
            ]);
            const sessionId = await harness.createSession();
            await harness.sendPrompt(sessionId, prompt);

            const wire = observeMainRequest(harness, "mc-off");
            expect(wire.tools).not.toContain("ctx_search");
            expect(wire.projectMemory).toBeNull();
            expect(wire.text).toContain(prompt);
        });
    }, 120_000);

    it("naive compaction keeps context.db absent after a real prompt", async () => {
        await withHarness(naiveCompactionOptions(), async (harness) => {
            expect(harness.hasContextDb()).toBe(false);
            expect(() =>
                seedGoldMemories({
                    workdir: harness.opencode.env.workdir,
                    dbPath: harness.contextDbPath(),
                    verification: "verified",
                    rows: [{ category: "PROJECT_RULES", content: GOLD_CONTENTS[0] }],
                }),
            ).toThrow("seedGoldMemories: context.db does not exist");
            expect(harness.hasContextDb()).toBe(false);

            const prompt = goldEvidencePrompt([
                { label: "oracle", content: `${GOLD_CONTENTS[0]} compaction` },
            ]);
            const sessionId = await harness.createSession();
            await harness.sendPrompt(sessionId, prompt);

            const wire = observeMainRequest(harness, "compaction");
            expect(wire.tools).not.toContain("ctx_search");
            expect(wire.projectMemory).toBeNull();
            expect(wire.text).toContain(prompt);
            expect(harness.hasContextDb()).toBe(false);
        });
    }, 120_000);
});
