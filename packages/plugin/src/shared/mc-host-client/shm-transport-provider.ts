import {
    type NativeDescriptor,
    probeCapabilities,
    QUALIFIED_TEST_PROFILE,
} from "@magic-context/mc-shm-native";
import { ShmFrameChannel } from "./shm-frame-channel";
import { decodeShmGrant } from "./shm-grant";
import type { ClientTransportProvider } from "./transport-provider";

const PARAMETERS = Object.freeze({
    backend: "ring",
    profile: QUALIFIED_TEST_PROFILE,
    scheduling: "cold_park_wake",
    topology: "fused",
});

/** Explicit test-only provider. commentlint: allow(JUDGE) */
export function createExplicitShmTestProvider(
    profile: string,
): ClientTransportProvider | undefined {
    if (profile !== QUALIFIED_TEST_PROFILE || !probeCapabilities().available) return undefined;
    let lastCandidateId = 0;
    return {
        transport: "shm",
        capabilityVersion: 1,
        parameters: PARAMETERS,
        connect: (grant, args) => {
            // Attachment I/O runs in start(), after this decode. commentlint: allow(JUDGE)
            const decoded = decodeShmGrant(grant, {
                expectedProfile: QUALIFIED_TEST_PROFILE,
                previousCandidateId: lastCandidateId,
            });
            lastCandidateId = decoded.candidateId;
            const descriptor: NativeDescriptor = {
                profile: decoded.profile,
                pid: decoded.pid,
                hostToPeerFd: decoded.hostToPeerFd,
                hostToPeerGrant: decoded.hostToPeerGrant,
                peerToHostFd: decoded.peerToHostFd,
                peerToHostGrant: decoded.peerToHostGrant,
            };
            return new ShmFrameChannel({
                descriptor,
                budget: args.budget,
                maxBodyLen: args.maxBodyLen,
                handlers: args.handlers,
            });
        },
    };
}
