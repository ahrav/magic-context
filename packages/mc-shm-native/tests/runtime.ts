import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import {
    activeExternalRefs,
    activeNativeChannels,
    NativeChannel,
    type NativeDescriptor,
    type NativeReceiveLease,
    probeCapabilities,
    setExternalViewCreationFailpoint,
} from "../index.ts";

const result = probeCapabilities();
assert.ok(result.napiVersion === null || result.napiVersion >= 1);
if (result.available) {
    assert.ok((result.napiVersion ?? 0) >= 8);
    assert.equal(result.externalArrayBuffer, true);
    assert.equal(result.exactBounds, true);
    assert.equal(result.detachment, true);
    assert.equal(result.transferPrevention, true);
    assert.equal(result.cleanupHooks, true);
    runAttachBoundary();
    runNativeLifecycle();
} else {
    assert.ok(result.reason && result.reason.length > 0);
}
console.log(JSON.stringify({ runtime: process.release.name, ...result }));

function runAttachBoundary(): void {
    // Invalid descriptors create no native channels or external views.
    const hostile: unknown[] = [
        { profile: "mc-host-test-ring-v1", hostToPeerFd: Number.NaN },
        { profile: "mc-host-test-ring-v1", hostToPeerFd: 2.5 },
    ];
    for (const descriptor of hostile) {
        const refs = activeExternalRefs();
        assert.throws(
            () => NativeChannel.attach(descriptor as NativeDescriptor),
            /invalid shared-memory descriptor/,
        );
        assert.equal(activeNativeChannels(), 0);
        assert.equal(activeExternalRefs(), refs);
    }
}

function header(length = 0): Uint8Array {
    const bytes = new Uint8Array(21);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, length, true);
    view.setUint8(4, 2);
    view.setUint8(5, 3);
    view.setUint16(7, 1, true);
    view.setUint32(9, 1, true);
    view.setBigUint64(13, 1n, true);
    return bytes;
}

function fill(
    channel: NativeChannel,
    bytes: number,
    value = 1,
    timeoutMs = 0,
): void {
    channel.produce(
        header(bytes),
        bytes,
        (cursor) => {
            while (cursor.remaining > 0) {
                const view = cursor.view();
                view.fill(value);
                cursor.advance(view.byteLength);
            }
        },
        undefined,
        timeoutMs,
    );
}

function receive(channel: NativeChannel): NativeReceiveLease {
    let lease: NativeReceiveLease | undefined;
    assert.equal(
        channel.drainOne((value) => {
            lease = value;
        }),
        true,
    );
    assert.ok(lease);
    return lease;
}

function forceGc(): void {
    const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
    if (bun) {
        bun.gc(true);
        return;
    }
    setFlagsFromString("--expose_gc");
    runInNewContext("gc()") as void;
}

function runNativeLifecycle(): void {
    const direct = NativeChannel.createTestPair();
    const producerAliases: Uint8Array[] = [];
    let publishSawDetached = false;
    direct.first.produce(
        header(5),
        5,
        (cursor) => {
            const alias = cursor.view();
            producerAliases.push(alias);
            alias.set([1, 2, 3, 4, 5]);
            cursor.advance(5);
        },
        () => {
            publishSawDetached = producerAliases.every(
                (alias) => alias.byteLength === 0,
            );
        },
    );
    assert.equal(publishSawDetached, true);
    const lease = receive(direct.second);
    assert.equal(lease.segmentCount, 1);
    const alias = lease.segment(0);
    assert.equal(alias.byteOffset, 0);
    assert.equal(alias.byteLength, alias.buffer.byteLength);
    const subarray = alias.subarray(1);
    const dataView = new DataView(alias.buffer, 1);
    const buffer = Buffer.from(alias.buffer);
    assert.throws(() =>
        structuredClone(alias.buffer, { transfer: [alias.buffer] }),
    );
    lease.release();
    assert.equal(alias.byteLength, 0);
    assert.equal(subarray.byteLength, 0);
    assert.equal(buffer.byteLength, 0);
    assert.throws(() => dataView.byteLength);
    assert.throws(() => lease.release(), /already released/);
    assert.throws(() => lease.segment(0), /released/);

    let thrownAlias: Uint8Array | undefined;
    assert.throws(() =>
        direct.first.produce(header(4), 4, (cursor) => {
            thrownAlias = cursor.view();
            cursor.write(new Uint8Array([1, 2, 3, 4]));
            throw new Error("fill failed");
        }),
    );
    assert.equal(thrownAlias?.byteLength, 0);
    assert.equal(
        direct.second.drainOne(() => {}),
        false,
    );
    direct.first.close();
    direct.second.close();

    const descriptors = NativeChannel.createTestPair();
    const held: NativeReceiveLease[] = [];
    for (let index = 0; index < descriptors.descriptorDepth; index++) {
        fill(descriptors.first, 1, index);
        held.push(receive(descriptors.second));
    }
    assert.throws(() => fill(descriptors.first, 1, 1, 1));
    held.shift()?.release();
    fill(descriptors.first, 1, 2, 1);
    receive(descriptors.second).release();
    for (const active of held) active.release();
    descriptors.first.close();
    descriptors.second.close();

    const arena = NativeChannel.createTestPair();
    fill(arena.first, arena.arenaBytes, 1, 1_000);
    const arenaLease = receive(arena.second);
    assert.throws(() => fill(arena.first, 1, 1, 1));
    arenaLease.release();
    fill(arena.first, 1, 2, 1);
    receive(arena.second).release();
    arena.first.close();
    arena.second.close();

    const partial = NativeChannel.createTestPair();
    partial.first.produce(
        header(partial.arenaBytes - 2),
        partial.arenaBytes - 2,
        (cursor) => {
            cursor.advance(partial.arenaBytes - 2);
        },
    );
    receive(partial.second).release();
    fill(partial.first, 4, 3, 1_000);
    const refsBeforeFailure = activeExternalRefs();
    setExternalViewCreationFailpoint(2);
    assert.throws(
        () => partial.second.drainOne(() => {}),
        /external view creation failpoint/,
    );
    setExternalViewCreationFailpoint(0);
    assert.equal(activeExternalRefs(), refsBeforeFailure);
    fill(partial.first, 1, 4, 1_000);
    receive(partial.second).release();
    partial.first.close();
    partial.second.close();

    const leaked = NativeChannel.createTestPair();
    for (let index = 0; index < leaked.descriptorDepth; index++) {
        fill(leaked.first, 1, index);
        assert.equal(
            leaked.second.drainOne(() => {}),
            true,
        );
    }
    forceGc();
    assert.throws(() => fill(leaked.first, 1, 1, 1));
    leaked.second.forceClose();
    assert.throws(() => fill(leaked.first, 1, 1, 1));
    leaked.first.close();
}
