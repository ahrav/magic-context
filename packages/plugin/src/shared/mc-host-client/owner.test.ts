import { afterEach, describe, expect, test } from "bun:test";
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
});
