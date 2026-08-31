import {
    type NativeDescriptor,
    probeCapabilities,
    QUALIFIED_TEST_PROFILE,
} from "@magic-context/mc-shm-native";
import { ShmFrameChannel } from "./shm-frame-channel";
import { decodeShmGrant } from "./shm-grant";
import type { ClientTransportProvider } from "./transport-provider";
import { sameDaemonId } from "./types";

const PARAMETERS = Object.freeze({
    backend: "ring",
    profile: QUALIFIED_TEST_PROFILE,
    scheduling: "cold_park_wake",
    topology: "fused",
});

/* */
export function createExplicitShmTestProvider(
    profile: string,
): ClientTransportProvider | undefined {
    if (profile !== QUALIFIED_TEST_PROFILE || !probeCapabilities().available) return undefined;
    // Scope the replay watermark by authenticated daemon identity because candidate IDs reset per daemon incarnation and PIDs can be reused.
    let previousCandidate: { daemonId: Uint8Array; pid: number; candidateId: number } | undefined;
    return {
        transport: "shm",
        capabilityVersion: 1,
        parameters: PARAMETERS,
        connect: (grant, args) => {
            const watermark =
                previousCandidate !== undefined &&
                sameDaemonId(previousCandidate.daemonId, args.daemonId)
                    ? { pid: previousCandidate.pid, candidateId: previousCandidate.candidateId }
                    : undefined;
            const decoded = decodeShmGrant(grant, {
                expectedProfile: QUALIFIED_TEST_PROFILE,
                ...(watermark !== undefined ? { previousCandidate: watermark } : {}),
            });
            previousCandidate = {
                daemonId: args.daemonId,
                pid: decoded.pid,
                candidateId: decoded.candidateId,
            };
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
