import {
    type NativeDescriptor,
    probeCapabilities,
    QUALIFIED_TEST_PROFILE,
} from "@cortexkit/mc-shm-native";
import { ShmFrameChannel } from "./shm-frame-channel";
import { decodeShmGrant } from "./shm-grant";
import type { ClientTransportProvider } from "./transport-provider";

const PARAMETERS = Object.freeze({
    backend: "ring",
    profile: QUALIFIED_TEST_PROFILE,
    scheduling: "cold_park_wake",
    topology: "fused",
});

function sameDaemonId(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/** Explicit test-only provider. commentlint: allow(JUDGE) */
export function createExplicitShmTestProvider(
    profile: string,
): ClientTransportProvider | undefined {
    if (profile !== QUALIFIED_TEST_PROFILE || !probeCapabilities().available) return undefined;
    // Replay watermark scoped to one daemon incarnation by the
    // authenticated daemon identity: the host's candidate sequence is
    // process-local, and a PID is reusable across incarnations, so a
    // replacement daemon — even one that received its predecessor's
    // recycled PID — legitimately starts over at 1 and must not be
    // rejected against the previous incarnation's high-water mark.
    let previousCandidate: { daemonId: Uint8Array; pid: number; candidateId: number } | undefined;
    return {
        transport: "shm",
        capabilityVersion: 1,
        parameters: PARAMETERS,
        connect: (grant, args) => {
            // Attachment I/O runs in start(), after this decode. commentlint: allow(JUDGE)
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
