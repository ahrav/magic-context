import assert from "node:assert/strict";
import {
    NativeChannel,
    probeCapabilities,
    QUALIFIED_TEST_PROFILE,
} from "@cortexkit/mc-shm-native";
import { ByteBudget, ReceiveLease } from "../src/shared/mc-host-client/frame-channel.ts";
import { FrameType, PROTOCOL_VERSION, encodeHeader } from "../src/shared/mc-host-client/protocol.ts";
import { ShmFrameChannel } from "../src/shared/mc-host-client/shm-frame-channel.ts";
import { createExplicitShmTestProvider } from "../src/shared/mc-host-client/shm-transport-provider.ts";

assert.equal(createExplicitShmTestProvider("production-default"), undefined);
const capability = probeCapabilities();
const provider = createExplicitShmTestProvider(QUALIFIED_TEST_PROFILE);
assert.equal(provider === undefined, !capability.available);

if (!capability.available) {
    console.log(
        JSON.stringify({
            pluginCapabilityOutcome: "OMITTED",
            runtime: process.release.name,
            reason: capability.reason,
        }),
    );
    process.exit(0);
}

assert.equal(provider?.transport, "shm");
const pair = NativeChannel.createTestPair();
let resolveBody: ((body: ReceiveLease) => void) | undefined;
let rejectBody: ((error: unknown) => void) | undefined;
const received = new Promise<ReceiveLease>((resolve, reject) => {
    resolveBody = resolve;
    rejectBody = reject;
});
const channel = new ShmFrameChannel({
    nativeChannel: pair.first,
    budget: new ByteBudget(1024),
    maxBodyLen: 1 << 20,
    handlers: {
        onFrame: (frame) => resolveBody?.(frame.body),
        onClosed: (_reason, error) => rejectBody?.(error ?? new Error("channel closed")),
    },
});
channel.beginFrames();
const body = Buffer.from([1, 2, 3, 4]);
pair.second.produce(
    encodeHeader({
        len: body.byteLength,
        ver: PROTOCOL_VERSION,
        ty: FrameType.Response,
        flags: 1,
        channel: 7,
        epoch: 1,
        corr: 3n,
    }),
    body.byteLength,
    (cursor) => cursor.write(body),
);
const lease = await Promise.race([
    received,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lease timeout")), 2_000)),
]);
const alias = lease.segment(0);
const backing = alias.buffer;
assert.ok(backing instanceof ArrayBuffer);
assert.equal(alias.byteLength, backing.byteLength);
assert.throws(() => structuredClone(backing, { transfer: [backing] }));
assert.equal(lease.release(), true);
assert.equal(alias.byteLength, 0);
assert.equal(channel.stats().activeReceiveLeases, 0);
channel.close();
pair.second.close();
console.log(JSON.stringify({ pluginCapabilityOutcome: "ACTIVATED", runtime: process.release.name }));
