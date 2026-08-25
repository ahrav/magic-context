import {
    probeCapabilities,
    QUALIFIED_TEST_PROFILE,
    type NativeDescriptor,
} from "@magic-context/mc-shm-native";
import { ShmFrameChannel } from "./shm-frame-channel";
import type { ClientTransportProvider } from "./transport-provider";

const PARAMETERS = Object.freeze({
    backend: "ring",
    profile: QUALIFIED_TEST_PROFILE,
    scheduling: "cold_park_wake",
    topology: "fused",
});

function descriptor(value: Record<string, unknown>): NativeDescriptor {
    if (
        value.profile !== QUALIFIED_TEST_PROFILE ||
        typeof value.pid !== "number" ||
        typeof value.host_to_peer_fd !== "number" ||
        typeof value.host_to_peer_grant !== "string" ||
        typeof value.peer_to_host_fd !== "number" ||
        typeof value.peer_to_host_grant !== "string"
    ) {
        throw new Error("invalid shared-memory descriptor");
    }
    return {
        profile: value.profile,
        pid: value.pid,
        hostToPeerFd: value.host_to_peer_fd,
        hostToPeerGrant: value.host_to_peer_grant,
        peerToHostFd: value.peer_to_host_fd,
        peerToHostGrant: value.peer_to_host_grant,
    };
}

/** Explicit test-only provider. commentlint: allow(JUDGE) */
export function createExplicitShmTestProvider(
    profile: string,
): ClientTransportProvider | undefined {
    if (profile !== QUALIFIED_TEST_PROFILE || !probeCapabilities().available) return undefined;
    return {
        transport: "shm",
        capabilityVersion: 1,
        parameters: PARAMETERS,
        connect: (grant, args) =>
            new ShmFrameChannel({
                descriptor: descriptor(grant),
                budget: args.budget,
                handlers: args.handlers,
            }),
    };
}
