import { describe, expect, test } from "bun:test";
import {
    activeExternalRefs,
    activeNativeChannels,
    QUALIFIED_TEST_PROFILE,
} from "@cortexkit/mc-shm-native";
import { ByteBudget, type FrameChannelHandlers } from "./frame-channel";
import { decodeShmGrant, ShmGrantError } from "./shm-grant";
import { createExplicitShmTestProvider } from "./shm-transport-provider";
import { expectGrantCode as expectCode, grantHex } from "./test-support/shm-grant-fixtures";
import type { CandidateChannelArgs } from "./transport-provider";
import { sanitizedCandidateFactory } from "./transport-provider";

function validGrant(candidateId = 1, pid = 1234): Record<string, unknown> {
    return {
        profile: QUALIFIED_TEST_PROFILE,
        pid,
        candidate_id: candidateId,
        host_to_peer_fd: 10,
        host_to_peer_grant: grantHex({ lane: 0, incarnation: 0xab }),
        peer_to_host_fd: 11,
        peer_to_host_grant: grantHex({ lane: 1, incarnation: 0xcd }),
    };
}

const OPTIONS = { expectedProfile: QUALIFIED_TEST_PROFILE };

function channelArgs(daemonId: Uint8Array = new Uint8Array(16)): CandidateChannelArgs {
    const handlers: FrameChannelHandlers = {
        onFrame: () => {},
        onClosed: () => {},
    };
    return { budget: new ByteBudget(1024), maxBodyLen: 1024, handlers, daemonId };
}

describe("grant geometry and duplex-pair binding", () => {
    test("the qualified host profile geometry is accepted", () => {
        const decoded = decodeShmGrant(validGrant(), OPTIONS);
        expect(decoded.hostToPeerGrant).toBe(grantHex({ lane: 0, incarnation: 0xab }));
    });

    test("an internally consistent over-profile grant is rejected", () => {
        const overArena = 1n << 40n;
        const grant = {
            ...validGrant(),
            host_to_peer_grant: grantHex({ lane: 0, arena: overArena, total: overArena + 8_192n }),
        };
        expectCode(() => decodeShmGrant(grant, OPTIONS), "geometry_mismatch");
        const overDepth = {
            ...validGrant(),
            host_to_peer_grant: grantHex({ lane: 0, depth: 1n << 20n }),
        };
        expectCode(() => decodeShmGrant(overDepth, OPTIONS), "geometry_mismatch");
        const overTotal = {
            ...validGrant(),
            host_to_peer_grant: grantHex({ lane: 0, total: 1n << 40n }),
        };
        expectCode(() => decodeShmGrant(overTotal, OPTIONS), "out_of_range");
    });

    test("swapped lanes are rejected", () => {
        const swapped = {
            ...validGrant(),
            host_to_peer_grant: grantHex({ lane: 1, incarnation: 0xab }),
            peer_to_host_grant: grantHex({ lane: 0, incarnation: 0xcd }),
        };
        expectCode(() => decodeShmGrant(swapped, OPTIONS), "lane_mismatch");
    });

    test("mixed generations and profiles across the pair are rejected", () => {
        const oldLayout = {
            ...validGrant(),
            peer_to_host_grant: grantHex({ lane: 1, incarnation: 0xcd, layoutVersion: 1 }),
        };
        expectCode(() => decodeShmGrant(oldLayout, OPTIONS), "geometry_mismatch");
        const otherProfile = {
            ...validGrant(),
            peer_to_host_grant: grantHex({ lane: 1, incarnation: 0xcd, depth: 64n }),
        };
        expectCode(() => decodeShmGrant(otherProfile, OPTIONS), "geometry_mismatch");
        const reservedTail = {
            ...validGrant(),
            peer_to_host_grant: grantHex({ lane: 1, incarnation: 0xcd, reserved: 1 }),
        };
        expectCode(() => decodeShmGrant(reservedTail, OPTIONS), "geometry_mismatch");
    });

    test("aliased backing objects are rejected", () => {
        const sameFd = { ...validGrant(), peer_to_host_fd: 10 };
        expectCode(() => decodeShmGrant(sameFd, OPTIONS), "aliased_lanes");
        const sameGrant = {
            ...validGrant(),
            peer_to_host_grant: grantHex({ lane: 0, incarnation: 0xab }),
        };
        expectCode(() => decodeShmGrant(sameGrant, OPTIONS), "lane_mismatch");
        const sameIncarnation = {
            ...validGrant(),
            peer_to_host_grant: grantHex({ lane: 1, incarnation: 0xab }),
        };
        expectCode(() => decodeShmGrant(sameIncarnation, OPTIONS), "aliased_lanes");
    });

    test("a replayed or stale candidate is rejected within one daemon incarnation", () => {
        const mark = { pid: 1234, candidateId: 5 };
        expect(
            decodeShmGrant(validGrant(5), {
                ...OPTIONS,
                previousCandidate: { pid: 1234, candidateId: 4 },
            }).candidateId,
        ).toBe(5);
        expectCode(
            () => decodeShmGrant(validGrant(5), { ...OPTIONS, previousCandidate: mark }),
            "stale_candidate",
        );
        expectCode(
            () => decodeShmGrant(validGrant(4), { ...OPTIONS, previousCandidate: mark }),
            "stale_candidate",
        );
        // A fresh daemon incarnation (different pid) restarts the host's
        // process-local candidate sequence: id 1 is valid, not a replay.
        expect(
            decodeShmGrant(validGrant(1, 4321), { ...OPTIONS, previousCandidate: mark })
                .candidateId,
        ).toBe(1);
    });
});

describe("accessor and proxy value defense", () => {
    test("every field is read exactly once and the first value wins", () => {
        const reads = new Map<string, number>();
        const source = validGrant();
        const counting: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(source)) {
            Object.defineProperty(counting, key, {
                enumerable: true,
                get() {
                    const count = (reads.get(key) ?? 0) + 1;
                    reads.set(key, count);
                    // Later reads observe a poisoned value, so any
                    // validate-then-reread gap fails this test.
                    return count === 1 ? value : Number.NaN;
                },
            });
        }
        const decoded = decodeShmGrant(counting, OPTIONS);
        for (const key of Object.keys(source)) {
            expect(reads.get(key)).toBe(1);
        }
        expect(decoded.pid).toBe(1234);
        expect(decoded.hostToPeerFd).toBe(10);
        expect(decoded.peerToHostFd).toBe(11);
        expect(decoded.candidateId).toBe(1);
    });

    test("a proxy cannot swap values between validation and use", () => {
        let pidReads = 0;
        const proxied = new Proxy(validGrant(), {
            get(target, property, receiver) {
                if (property === "pid") {
                    pidReads += 1;
                    return pidReads === 1 ? 1234 : 0;
                }
                return Reflect.get(target, property, receiver);
            },
        });
        const decoded = decodeShmGrant(proxied, OPTIONS);
        expect(decoded.pid).toBe(1234);
        expect(pidReads).toBe(1);
    });

    test("a proxy that reports hostile keys or throws is bounded", () => {
        const hostileKeys = new Proxy(validGrant(), {
            ownKeys() {
                throw new Error("SENTINEL_OWNKEYS");
            },
        });
        const error = expectCode(() => decodeShmGrant(hostileKeys, OPTIONS), "invalid_type");
        expect(error.message).not.toContain("SENTINEL");
        const throwingGetter = {
            ...validGrant(),
            get pid(): number {
                throw new Error("SENTINEL_GETTER");
            },
        };
        const getterError = expectCode(
            () => decodeShmGrant(throwingGetter, OPTIONS),
            "invalid_type",
        );
        expect(getterError.message).not.toContain("SENTINEL");
        expect(getterError.cause).toBeUndefined();
    });
});

describe("provider grant handling before any native effect", () => {
    test("rejects a non-qualified profile without registration", () => {
        expect(createExplicitShmTestProvider("production-default")).toBeUndefined();
    });

    test("an over-profile grant never reaches fd access, mapping, or the registry", () => {
        const provider = createExplicitShmTestProvider(QUALIFIED_TEST_PROFILE);
        if (!provider) return;
        const channels = activeNativeChannels();
        const refs = activeExternalRefs();
        const overArena = 1n << 40n;
        const grant = {
            ...validGrant(),
            host_to_peer_grant: grantHex({ lane: 0, arena: overArena, total: overArena + 12_288n }),
        };
        // Seeded-defect detector: if validation ran after attachment
        // effects (inside start()), connect would return a channel and
        // this throw assertion would fail.
        expect(() => provider.connect(grant, channelArgs())).toThrow(ShmGrantError);
        expect(activeNativeChannels()).toBe(channels);
        expect(activeExternalRefs()).toBe(refs);
    });

    test("a replayed old descriptor is rejected after a newer candidate attached", () => {
        const provider = createExplicitShmTestProvider(QUALIFIED_TEST_PROFILE);
        if (!provider) return;
        const channels = activeNativeChannels();
        provider.connect(validGrant(7), channelArgs());
        expectCode(() => provider.connect(validGrant(7), channelArgs()), "stale_candidate");
        expectCode(() => provider.connect(validGrant(3), channelArgs()), "stale_candidate");
        provider.connect(validGrant(8), channelArgs());
        // Construction records no attachment: fd access starts in start().
        expect(activeNativeChannels()).toBe(channels);
    });

    test("a daemon restart resets the replay watermark with the new incarnation", () => {
        const provider = createExplicitShmTestProvider(QUALIFIED_TEST_PROFILE);
        if (!provider) return;
        provider.connect(validGrant(7, 1000), channelArgs());
        // The replacement daemon's process-local sequence restarts at 1;
        // its first grant must attach instead of failing stale_candidate.
        provider.connect(validGrant(1, 2000), channelArgs());
        // Monotonicity now tracks the NEW incarnation.
        expectCode(() => provider.connect(validGrant(1, 2000), channelArgs()), "stale_candidate");
        provider.connect(validGrant(2, 2000), channelArgs());
    });

    test("pid reuse across daemon incarnations does not inherit the watermark", () => {
        const provider = createExplicitShmTestProvider(QUALIFIED_TEST_PROFILE);
        if (!provider) return;
        const firstIncarnation = new Uint8Array(16).fill(1);
        const secondIncarnation = new Uint8Array(16).fill(2);
        provider.connect(validGrant(7, 1000), channelArgs(firstIncarnation));
        // A replacement daemon can receive its predecessor's recycled PID;
        // the authenticated incarnation identity differs, so its candidate
        // sequence restarts at 1 and must attach.
        provider.connect(validGrant(1, 1000), channelArgs(secondIncarnation));
        // Monotonicity now tracks the new incarnation under the same PID.
        expectCode(
            () => provider.connect(validGrant(1, 1000), channelArgs(secondIncarnation)),
            "stale_candidate",
        );
        provider.connect(validGrant(2, 1000), channelArgs(secondIncarnation));
    });

    test("sanitized candidate construction keeps sentinel grant bytes out of errors", () => {
        const provider = createExplicitShmTestProvider(QUALIFIED_TEST_PROFILE);
        if (!provider) return;
        const hostile = {
            ...validGrant(),
            host_to_peer_grant: "SENTINEL_GRANT_BYTES".padEnd(116, "0"),
        };
        let caught: unknown;
        try {
            sanitizedCandidateFactory("shm", provider, hostile, new Uint8Array(16))(channelArgs());
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        const seen = new Set<unknown>();
        for (let error = caught; error instanceof Error && !seen.has(error); ) {
            seen.add(error);
            expect(error.message).not.toContain("SENTINEL");
            expect(error.stack ?? "").not.toContain("SENTINEL");
            error = error.cause;
        }
    });
});
