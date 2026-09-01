/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../../features/magic-context/scheduler";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { createTransform } from "./transform";

type TestPart =
    | { type: "text"; text: string }
    | {
          type: "tool";
          callID: string;
          state: { output: string; tool?: string; input?: Record<string, string> };
      };

type TestMessage = {
    info: { id?: string; role: string; sessionID?: string };
    parts: TestPart[];
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function buildMessages(): TestMessage[] {
    return [
        {
            info: { id: "m-user", role: "user", sessionID: "ses-heuristic-persist" },
            parts: [{ type: "text", text: "continue" }],
        },
        {
            info: { id: "m-tool", role: "assistant" },
            parts: [
                {
                    type: "tool",
                    callID: "call-1",
                    state: {
                        // The 4,200 repetitions make `output` large enough for the tiered emergency drop to reclaim it.
                        output: "const value = compute(input, options); // line\n".repeat(4200),
                        tool: "mcp_read",
                        input: { path: "a.ts" },
                    },
                },
            ],
        },
        {
            info: { id: "m-injection", role: "assistant" },
            parts: [
                {
                    type: "text",
                    text: "[Category+Skill Reminder]\nUse task()\n\nVisible answer",
                },
            ],
        },
        {
            info: { id: "m-tail", role: "assistant" },
            parts: [{ type: "text", text: "Newest assistant message" }],
        },
    ];
}

function buildInjectionOnlyMessages(): TestMessage[] {
    return [
        {
            info: { id: "m-user", role: "user", sessionID: "ses-heuristic-persist-empty" },
            parts: [{ type: "text", text: "continue" }],
        },
        {
            info: { id: "m-injection-only", role: "assistant" },
            parts: [
                {
                    type: "text",
                    text: "[Category+Skill Reminder]\nUse task()",
                },
            ],
        },
        {
            info: { id: "m-tail", role: "assistant" },
            parts: [{ type: "text", text: "Newest assistant message" }],
        },
    ];
}

function getMessage(messages: TestMessage[], id: string): TestMessage | undefined {
    return messages.find((message) => message.info.id === id);
}

function getTextPart(message: TestMessage): Extract<TestPart, { type: "text" }> {
    const part = message.parts[0];
    if (part?.type !== "text") {
        throw new Error(`expected text part for ${message.info.id ?? "unknown message"}`);
    }

    return part;
}

function stripTagPrefix(value: string): string {
    return value.replace(/^§\d+§\s*/, "");
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Cleanup ignores removal errors, including Windows `EBUSY`. */
        }
    }
    tempDirs.length = 0;
});

function makeTestDirectory(prefix: string): string {
    return makeTempDir(prefix);
}

describe("createTransform heuristic cleanup persistence", () => {
    it("keeps execute-time heuristic truncation on the execute pass before later defer replay", async () => {
        useTempDataHome("context-transform-heuristic-persist-");
        const testDirectory = makeTestDirectory("context-transform-heuristic-dir-");

        const schedulerDecision = mock<Scheduler["shouldExecute"]>(() => "defer");
        const scheduler: Scheduler = { shouldExecute: schedulerDecision };
        // `pendingMaterializationSessions` simulates an explicit `/ctx-flush` for this heuristic test.
        // `pendingMaterializationSessions` simulates an explicit `/ctx-flush` for this heuristic test.
        // `flushedHistorySessions` and `flushedSystemSessions` do not affect this heuristic.
        // `flushedHistorySessions` and `flushedSystemSessions` do not affect this heuristic.
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-heuristic-persist",
                    // Estimated usage of at least 85% triggers the tiered emergency drop during execution.
                    { usage: { percentage: 86, inputTokens: 172_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            client: undefined,
            directory: testDirectory,
            getHistorianChunkTokens: () => 20_000,
        });

        await transform({}, { messages: buildMessages() });

        schedulerDecision.mockImplementation(() => "execute");
        pendingMaterializationSessions.add("ses-heuristic-persist");
        const executePass = buildMessages();
        await transform({}, { messages: executePass });

        // The newest-window emergency arm keeps a skeleton for the tool arc.
        expect(getMessage(executePass, "m-tool")).toBeDefined();
        const executeInjection = getMessage(executePass, "m-injection");
        expect(executeInjection).toBeDefined();
        expect(stripTagPrefix(getTextPart(executeInjection!).text)).toBe("Visible answer");

        schedulerDecision.mockImplementation(() => "defer");
        const deferPass = buildMessages();
        await transform({}, { messages: deferPass });

        expect(getMessage(deferPass, "m-tool")).toBeDefined();
        const deferredInjection = getMessage(deferPass, "m-injection");
        expect(deferredInjection).toBeDefined();
        expect(stripTagPrefix(getTextPart(deferredInjection!).text)).toBe("Visible answer");
        expect(getTextPart(deferredInjection!).text).not.toContain("[Category+Skill Reminder]");
    });

    it("keeps injection-only messages dropped across a later defer pass", async () => {
        useTempDataHome("context-transform-heuristic-persist-empty-");
        const testDirectory = makeTestDirectory("context-transform-heuristic-dir-empty-");

        const schedulerDecision = mock<Scheduler["shouldExecute"]>(() => "defer");
        const scheduler: Scheduler = { shouldExecute: schedulerDecision };
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-heuristic-persist-empty",
                    { usage: { percentage: 45, inputTokens: 90_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            client: undefined,
            directory: testDirectory,
            getHistorianChunkTokens: () => 20_000,
        });

        await transform({}, { messages: buildInjectionOnlyMessages() });

        schedulerDecision.mockImplementation(() => "execute");
        pendingMaterializationSessions.add("ses-heuristic-persist-empty");
        const executePass = buildInjectionOnlyMessages();
        await transform({}, { messages: executePass });

        // Sentinel-based stripping preserves array length.
        // The injection-only message remains in the array as a single sentinel.
        // With no `providerID`, dropped text is `[dropped]`.
        const executeInjection = getMessage(executePass, "m-injection-only");
        expect(executeInjection?.parts).toEqual([{ type: "text", text: "[dropped]" }]);

        schedulerDecision.mockImplementation(() => "defer");
        const deferPass = buildInjectionOnlyMessages();
        await transform({}, { messages: deferPass });

        // Deferred replay reuses the neutralized message without mutating the array again.
        const deferredInjection = getMessage(deferPass, "m-injection-only");
        expect(deferredInjection?.parts).toEqual([{ type: "text", text: "[dropped]" }]);
    });
});
