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

    test("forgets a connection attempt that fails before publication", async () => {
        const connectionFile = `/tmp/missing-mc-host-${crypto.randomUUID()}.json`;
        const first = processMcHostClient({ connectionFile });
        await expect(first).rejects.toThrow();

        const second = processMcHostClient({ connectionFile });
        expect(second).not.toBe(first);
        await expect(second).rejects.toThrow();
    });
});
