import { describe, expect, test } from "bun:test";
import { Deadline } from "../../shared/mc-host-client";
import { McHostModuleTransport, __moduleTransportTest } from "./module-transport";
import { WaiterDetachedError } from "../../shared/mc-host-lifecycle/policy";

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

describe("waiter detach is not a connection failure", () => {
    // A detached waiter carries ETIMEDOUT so callers classifying retryability on `code` see a
    // timeout. If that also classified as a connection failure, the `call` catch would
    // invalidate the shared connection and bump the generation, and the still-connecting
    // owner's candidate would be evicted -- one caller's deadline would abort the connect for
    // every caller waiting on the same flight.
    test("a deadline detach does not classify as a connection failure", () => {
        const detached = new WaiterDetachedError("deadline");
        expect(detached.code).toBe("ETIMEDOUT");
        expect(__moduleTransportTest.isConnectionFailure(detached)).toBe(false);
    });

    test("an abort detach does not classify as a connection failure", () => {
        expect(
            __moduleTransportTest.isConnectionFailure(new WaiterDetachedError("aborted")),
        ).toBe(false);
    });

    // The exclusion must be the class, not the code: a genuine ETIMEDOUT still invalidates.
    test("a plain ETIMEDOUT still classifies as a connection failure", () => {
        const error = Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" });
        expect(__moduleTransportTest.isConnectionFailure(error)).toBe(true);
    });
});
