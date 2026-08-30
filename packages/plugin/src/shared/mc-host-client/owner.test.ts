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
