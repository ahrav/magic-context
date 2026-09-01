import { describe, expect, it } from "bun:test";
import { isDefaultSessionTitle, waitForSafeNotificationTarget } from "./safe-notification-target";

function clientWithTitle(title: string | undefined, calls?: { count: number }) {
    return {
        session: {
            get: async (_input: unknown) => {
                if (calls) calls.count += 1;
                return { data: { title } };
            },
        },
    };
}

describe("isDefaultSessionTitle", () => {
    it("matches OpenCode default titles for parent and child sessions", () => {
        expect(isDefaultSessionTitle("New session - 2026-06-10T15:33:11.538Z")).toBe(true);
        expect(isDefaultSessionTitle("Child session - 2026-01-02T03:04:05.678Z")).toBe(true);
    });

    it("does not match real titles", () => {
        expect(isDefaultSessionTitle("Quick test")).toBe(false);
        expect(isDefaultSessionTitle("New session - notes")).toBe(false);
        expect(isDefaultSessionTitle("New session - 2026-06-10")).toBe(false);
    });
});

describe("waitForSafeNotificationTarget", () => {
    it("returns safe immediately for a titled session", async () => {
        const calls = { count: 0 };
        const result = await waitForSafeNotificationTarget(
            clientWithTitle("Fix tagger collision", calls),
            "ses-titled",
            { attempts: 4, delayMs: 1 },
        );
        expect(result).toBe("safe");
        expect(calls.count).toBe(1);
    });

    it("returns skip after exhausting attempts on a default-titled session", async () => {
        const calls = { count: 0 };
        const result = await waitForSafeNotificationTarget(
            clientWithTitle("New session - 2026-06-10T15:33:11.538Z", calls),
            "ses-fresh",
            { attempts: 3, delayMs: 1 },
        );
        expect(result).toBe("skip");
        expect(calls.count).toBe(3);
    });

    it("returns safe once the title flips to a real one mid-retry", async () => {
        let call = 0;
        const client = {
            session: {
                get: async () => {
                    call += 1;
                    return {
                        data: {
                            title: call < 2 ? "New session - 2026-06-10T15:33:11.538Z" : "Greeting",
                        },
                    };
                },
            },
        };
        const result = await waitForSafeNotificationTarget(client, "ses-flip", {
            attempts: 4,
            delayMs: 1,
        });
        expect(result).toBe("safe");
        expect(call).toBe(2);
    });

    it("fails open when the client cannot report a title", async () => {
        expect(
            await waitForSafeNotificationTarget({}, "ses-no-api", { attempts: 2, delayMs: 1 }),
        ).toBe("safe");
        const throwing = {
            session: {
                get: async () => {
                    throw new Error("transport down");
                },
            },
        };
        expect(
            await waitForSafeNotificationTarget(throwing, "ses-throw", { attempts: 2, delayMs: 1 }),
        ).toBe("safe");
        const direct = {
            session: { get: async () => ({ title: "Real title" }) },
        };
        expect(
            await waitForSafeNotificationTarget(direct, "ses-direct", { attempts: 2, delayMs: 1 }),
        ).toBe("safe");
    });
});
