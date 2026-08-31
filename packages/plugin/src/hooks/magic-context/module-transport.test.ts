import { describe, expect, test } from "bun:test";
import { Deadline } from "../../shared/mc-host-client";
import { McHostModuleTransport } from "./module-transport";

type TransportInternals = {
    connectionPromise: Promise<unknown> | null;
    ensureConnected(deadline: Deadline, signal?: AbortSignal): Promise<unknown>;
};

function internals(transport: McHostModuleTransport): TransportInternals {
    return transport as unknown as TransportInternals;
}

describe("McHostModuleTransport shared connection wait", () => {
    test("each caller stops waiting at its own deadline without cancelling the shared flight", async () => {
        const transport = internals(new McHostModuleTransport("/tmp/unused-mc-host.json"));
        const shared = new Promise<never>(() => {});
        transport.connectionPromise = shared;

        const outcome = await Promise.race([
            transport.ensureConnected(Deadline.start(5)).catch((error: unknown) => error),
            Bun.sleep(50).then(() => "still_waiting"),
        ]);

        expect(outcome).toMatchObject({ code: "ETIMEDOUT" });
        expect(transport.connectionPromise).toBe(shared);
    });

    test("each caller aborts its own wait without cancelling the shared flight", async () => {
        const transport = internals(new McHostModuleTransport("/tmp/unused-mc-host.json"));
        const shared = new Promise<never>(() => {});
        transport.connectionPromise = shared;
        const controller = new AbortController();
        const reason = new Error("caller aborted");

        const waiting = transport.ensureConnected(Deadline.start(1_000), controller.signal);
        controller.abort(reason);

        await expect(waiting).rejects.toBe(reason);
        expect(transport.connectionPromise).toBe(shared);
    });
});
