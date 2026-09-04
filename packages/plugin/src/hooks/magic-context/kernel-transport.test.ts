import { describe, expect, test } from "bun:test";
import {
    isAvailable,
    KernelClient,
    type KernelTransport,
    type KernelTransportCall,
} from "../../shared/kernel-client";
import { createKernelTransport } from "./kernel-transport";
import { type ManagedDemandStart, McHostModuleTransport } from "./module-transport";

const PROJECT = "/repo/project";
const SESSION = "session-a";
const MISSING_CONNECTION_FILE = "/tmp/kernel-transport-test-missing-connection.json";

const demandStartNeverInvoked: ManagedDemandStart = () => {
    throw new Error("demand start must not run during gating");
};

function managedTransport(): McHostModuleTransport {
    return new McHostModuleTransport({ demandStart: demandStartNeverInvoked });
}

function explicitTransport(): McHostModuleTransport {
    return new McHostModuleTransport({
        connectionFile: MISSING_CONNECTION_FILE,
        demandStart: demandStartNeverInvoked,
    });
}

/** Reuses the created transport's gate while scripting `call`, so the client exercises the real reachability answer. */
function recordingTransport(kernelTransport: KernelTransport): {
    transport: KernelTransport;
    calls: KernelTransportCall[];
} {
    const calls: KernelTransportCall[] = [];
    return {
        calls,
        transport: {
            ...kernelTransport,
            async call(args: KernelTransportCall): Promise<unknown> {
                calls.push(args);
                return {
                    state: { kind: "available" },
                    known_as_of: 1,
                    tip: 1,
                    gated: false,
                    rows: [],
                };
            },
        },
    };
}

function client(transport: KernelTransport): KernelClient {
    return new KernelClient({ transport, enabled: true, sessionId: SESSION, projectRoot: PROJECT });
}

describe("createKernelTransport reachability gate", () => {
    test("a managed transport with demand start is reachable before its connection file exists", () => {
        const transport = managedTransport();
        expect(transport.canDemandStart()).toBe(true);
        expect(createKernelTransport(transport).connectionFileExists()).toBe(true);
    });

    test("an explicit connection file never demand-starts, so a missing file is unreachable", () => {
        const transport = explicitTransport();
        expect(transport.canDemandStart()).toBe(false);
        expect(createKernelTransport(transport).connectionFileExists()).toBe(false);
    });

    test("a kernel call on a managed demand-start transport reaches the transport", async () => {
        const { transport, calls } = recordingTransport(createKernelTransport(managedTransport()));
        const result = await client(transport).read({ surface: "auto_inject" });
        expect(isAvailable(result)).toBe(true);
        expect(calls.map((call) => call.method)).toEqual(["kernel.read"]);
    });

    test("a kernel call on an explicit origin with a missing file is daemon_absent without a dial", async () => {
        const { transport, calls } = recordingTransport(createKernelTransport(explicitTransport()));
        const result = await client(transport).read({ surface: "auto_inject" });
        expect(result.state).toEqual({ kind: "unavailable", reason: "daemon_absent" });
        expect(calls).toEqual([]);
    });
});
