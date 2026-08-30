/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { createScheduler, parseCacheTtl } from "./scheduler";
import type { ContextUsage, SessionMeta } from "./types";

const BASE_TIME = 1_000_000;

function createSessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
    return {
        sessionId: "ses-1",
        lastResponseTime: BASE_TIME,
        cacheTtl: "5m",
        counter: 0,
        lastNudgeTokens: 0,
        lastNudgeBand: null,
        lastTransformError: null,
        isSubagent: false,
        lastContextPercentage: 0,
        lastInputTokens: 0,
        timesExecuteThresholdReached: 0,
        compartmentInProgress: false,
        systemPromptHash: "",
        systemPromptTokens: 0,
        clearedReasoningThroughTag: 0,
        ...overrides,
    };
}

function createContextUsage(percentage: number): ContextUsage {
    return {
        percentage,
        inputTokens: 1000,
    };
}

describe("createScheduler", () => {
    // Each row runs the default 65% scheduler against one session shape and
    // asserts the decision. TTL rows move `lastResponseTime` (400s beats the
    // 5m TTL; 10s stays warm); threshold rows move the usage percentage.
    it.each([
        [
            "returns execute when cache is expired",
            { lastResponseTime: BASE_TIME - 400_000 },
            50,
            "execute",
        ],
        [
            "returns execute when context usage is at or above the configured threshold",
            { lastResponseTime: BASE_TIME - 10_000 },
            65,
            "execute",
        ],
        [
            "returns defer when cache is warm and context usage is below the configured threshold",
            { lastResponseTime: BASE_TIME - 10_000 },
            50,
            "defer",
        ],
        // An unparseable TTL falls back to the 5m default in both directions.
        [
            "falls back to 5m default when cacheTtl is invalid",
            { cacheTtl: "bad-format", lastResponseTime: BASE_TIME - 400_000 },
            50,
            "execute",
        ],
        [
            "falls back to 5m default when cacheTtl is invalid and cache would be warm",
            { cacheTtl: "not-a-ttl", lastResponseTime: BASE_TIME - 10_000 },
            50,
            "defer",
        ],
        // Last response 10 days ago, percentage below threshold: the only path
        // to "execute" would be TTL expiry, which "never" disables.
        [
            "never executes from TTL idle when cacheTtl is 'never'",
            { cacheTtl: "never", lastResponseTime: BASE_TIME - 10 * 24 * 60 * 60 * 1000 },
            50,
            "defer",
        ],
    ] as Array<
        [string, Partial<SessionMeta>, number, string]
    >)("%s", (_title, overrides, percentage, expected) => {
        const scheduler = createScheduler({ executeThresholdPercentage: 65 });
        const sessionMeta = createSessionMeta(overrides);

        const decision = scheduler.shouldExecute(
            sessionMeta,
            createContextUsage(percentage),
            BASE_TIME,
        );

        expect(decision).toBe(expected);
    });

    it("uses a custom execute threshold", () => {
        const scheduler = createScheduler({ executeThresholdPercentage: 70 });
        const sessionMeta = createSessionMeta({ lastResponseTime: BASE_TIME - 10_000 });

        expect(scheduler.shouldExecute(sessionMeta, createContextUsage(69), BASE_TIME)).toBe(
            "defer",
        );
        expect(scheduler.shouldExecute(sessionMeta, createContextUsage(70), BASE_TIME)).toBe(
            "execute",
        );
    });

    it("uses a model-specific execute threshold when modelKey is provided", () => {
        const scheduler = createScheduler({
            executeThresholdPercentage: { default: 70, "openai/gpt-4o": 60 },
        });
        const sessionMeta = createSessionMeta({ lastResponseTime: BASE_TIME - 10_000 });

        expect(
            scheduler.shouldExecute(
                sessionMeta,
                createContextUsage(65),
                BASE_TIME,
                undefined,
                "openai/gpt-4o",
            ),
        ).toBe("execute");
    });

    it("still executes on threshold when cacheTtl is 'never'", () => {
        const scheduler = createScheduler({ executeThresholdPercentage: 65 });
        const sessionMeta = createSessionMeta({
            cacheTtl: "never",
            lastResponseTime: BASE_TIME - 10_000,
        });
        // At threshold — should still execute.
        const contextUsage = createContextUsage(65);

        const decision = scheduler.shouldExecute(sessionMeta, contextUsage, BASE_TIME);

        expect(decision).toBe("execute");
    });
});

describe("parseCacheTtl", () => {
    it("parses minutes, hours, and seconds", () => {
        const minutes = parseCacheTtl("5m");
        const hours = parseCacheTtl("1h");
        const seconds = parseCacheTtl("30s");

        expect(minutes).toBe(300_000);
        expect(hours).toBe(3_600_000);
        expect(seconds).toBe(30_000);
    });

    it("passes through raw millisecond strings", () => {
        const milliseconds = parseCacheTtl("300000");

        expect(milliseconds).toBe(300_000);
    });

    it("returns Infinity for 'never' regardless of casing and whitespace", () => {
        expect(parseCacheTtl("never")).toBe(Number.POSITIVE_INFINITY);
        expect(parseCacheTtl("NEVER")).toBe(Number.POSITIVE_INFINITY);
        expect(parseCacheTtl(" never ")).toBe(Number.POSITIVE_INFINITY);
        expect(parseCacheTtl("Never")).toBe(Number.POSITIVE_INFINITY);
    });

    it("throws on invalid ttl format", () => {
        expect(() => parseCacheTtl("bad-format")).toThrow();
    });
});
