import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { McHostClient } from "./client";
import { processMcHostClient, resetProcessMcHostClientsForTest } from "./owner";

afterEach(() => {
    resetProcessMcHostClientsForTest();
});

describe("processMcHostClient", () => {
    test("shares one connection attempt per publication path", async () => {
        const connectionFile = `/tmp/missing-mc-host-${crypto.randomUUID()}.json`;
        const first = processMcHostClient({ connectionFile });
        const second = processMcHostClient({ connectionFile });

        expect(first).toBe(second);
        await expect(first).rejects.toThrow();
    });

    test("callers with different construction options do not share a client", async () => {
        const connectionFile = `/tmp/missing-mc-host-${crypto.randomUUID()}.json`;
        // A probe that presents no credentials must not hand its client to a
        // caller that depends on credential fingerprints reaching route.open.
        const probe = processMcHostClient({ connectionFile, requestTimeoutMs: 2_000 });
        const withCredentials = processMcHostClient({
            connectionFile,
            credentialSource: { EXAMPLE_API_KEY: "value" },
        });
        const differentTimeout = processMcHostClient({
            connectionFile,
            requestTimeoutMs: 30_000,
        });

        expect(withCredentials).not.toBe(probe);
        expect(differentTimeout).not.toBe(probe);
        await expect(probe).rejects.toThrow();
        await expect(withCredentials).rejects.toThrow();
        await expect(differentTimeout).rejects.toThrow();
    });

    test("owners keyed by handshake budget keep a generous lane off a tight one", async () => {
        // Clients with different handshake budgets must not share an owner:
        // whichever dialed first would fix the budget for the other.
        const connectionFile = `/tmp/missing-mc-host-${crypto.randomUUID()}.json`;
        const provider = processMcHostClient({ connectionFile, handshakeTimeoutMs: 10_000 });
        const hook = processMcHostClient({ connectionFile, handshakeTimeoutMs: 2_000 });

        expect(provider).not.toBe(hook);
        await expect(provider).rejects.toThrow();
        await expect(hook).rejects.toThrow();
    });

    test("an identical option set still shares one attempt", async () => {
        const connectionFile = `/tmp/missing-mc-host-${crypto.randomUUID()}.json`;
        const credentialSource = { EXAMPLE_API_KEY: "value" };
        const first = processMcHostClient({
            connectionFile,
            credentialSource,
            requestTimeoutMs: 2_000,
        });
        const second = processMcHostClient({
            connectionFile,
            credentialSource,
            requestTimeoutMs: 2_000,
        });

        expect(first).toBe(second);
        await expect(first).rejects.toThrow();
    });

    test("keeps owners for distinct publication paths separate", async () => {
        const firstClient = { isClosed: false, closeAsync: async () => {} } as McHostClient;
        const secondClient = { isClosed: false, closeAsync: async () => {} } as McHostClient;
        const connect = spyOn(McHostClient, "connect")
            .mockResolvedValueOnce(firstClient)
            .mockResolvedValueOnce(secondClient);
        const firstPath = `/tmp/mc-host-${crypto.randomUUID()}.json`;
        const secondPath = `/tmp/mc-host-${crypto.randomUUID()}.json`;

        const first = processMcHostClient({ connectionFile: firstPath });
        const second = processMcHostClient({ connectionFile: secondPath });

        expect(first).not.toBe(second);
        expect(await first).toBe(firstClient);
        expect(await second).toBe(secondClient);
        expect(connect).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ connectionFile: firstPath }),
        );
        expect(connect).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ connectionFile: secondPath }),
        );
        connect.mockRestore();
    });

    test("forgets a connection attempt that fails before publication", async () => {
        const connectionFile = `/tmp/missing-mc-host-${crypto.randomUUID()}.json`;
        const first = processMcHostClient({ connectionFile });
        await expect(first).rejects.toThrow();

        const second = processMcHostClient({ connectionFile });
        expect(second).not.toBe(first);
        await expect(second).rejects.toThrow();
    });

    test("evicts an irreversibly closed owner without splitting live owners", async () => {
        const firstClient = { isClosed: false, closeAsync: async () => {} } as McHostClient;
        const secondClient = { isClosed: false, closeAsync: async () => {} } as McHostClient;
        const connect = spyOn(McHostClient, "connect")
            .mockResolvedValueOnce(firstClient)
            .mockResolvedValueOnce(secondClient);
        const connectionFile = `/tmp/mc-host-${crypto.randomUUID()}.json`;

        const first = processMcHostClient({ connectionFile });
        expect(processMcHostClient({ connectionFile })).toBe(first);
        await first;
        Object.defineProperty(firstClient, "isClosed", { value: true });

        expect(await processMcHostClient({ connectionFile })).toBe(secondClient);
        expect(connect).toHaveBeenCalledTimes(2);
        connect.mockRestore();
    });
});
