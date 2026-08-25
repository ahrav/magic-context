import { createRequire } from "node:module";
import { markAsUntransferable } from "node:worker_threads";

export const QUALIFIED_TEST_PROFILE = "mc-host-test-ring-v1";

export interface NativeCapabilities {
    available: boolean;
    napiVersion: number | null;
    externalArrayBuffer: boolean;
    exactBounds: boolean;
    detachment: boolean;
    transferPrevention: boolean;
    cleanupHooks: boolean;
    reason?: string;
}

export interface NativeDescriptor {
    profile: string;
    pid: number;
    hostToPeerFd: number;
    hostToPeerGrant: string;
    peerToHostFd: number;
    peerToHostGrant: string;
}

export interface NativeTestPair {
    first: NativeChannel;
    second: NativeChannel;
    descriptorDepth: number;
    arenaBytes: number;
}

interface NativeAddon {
    napiVersion(): number;
    createExternalProbe(length: number): Uint8Array;
    detachArrayBuffer(buffer: ArrayBuffer): boolean;
    registerCleanupProbe(path: string): void;
    nativeLeakDiagnostics(): number;
    activeExternalRefCount(): number;
    setExternalViewFailpoint(call: number): void;
    workerLimit(): number;
    activeChannelCount(): number;
    attach(descriptor: NativeDescriptor): number;
    createTestPair(): {
        first: number;
        second: number;
        descriptorDepth: number;
        arenaBytes: number;
    };
    produce(
        channel: number,
        header: Uint8Array,
        capacity: number,
        timeoutMs: number,
        fill: (segments: Uint8Array[]) => number,
        beforePublish: () => void,
    ): void;
    reserve(
        channel: number,
        capacity: number,
        timeoutMs: number,
        deliver: (token: number, segments: Uint8Array[]) => void,
    ): void;
    commitReservation(
        channel: number,
        token: number,
        header: Uint8Array,
        written: number,
        beforePublish: () => void,
    ): void;
    abortReservation(channel: number, token: number): void;
    poll(
        channel: number,
        deliver: (
            token: number,
            header: Uint8Array,
            segments: Uint8Array[],
        ) => void,
    ): boolean;
    release(channel: number, token: number): void;
    close(channel: number): void;
    forceClose(channel: number): void;
}

let loaded: NativeAddon | null | undefined;

function addon(): NativeAddon | null {
    if (loaded !== undefined) return loaded;
    try {
        loaded = createRequire(import.meta.url)(
            "./mc_shm_native.node",
        ) as NativeAddon;
    } catch {
        loaded = null;
    }
    return loaded;
}

function protect(segments: readonly Uint8Array[]): void {
    for (const segment of segments) {
        if (!(segment.buffer instanceof ArrayBuffer)) {
            throw new Error("external segment lacks ArrayBuffer backing");
        }
        markAsUntransferable(segment.buffer);
    }
}

export function probeCapabilities(): NativeCapabilities {
    const base = {
        napiVersion: null,
        externalArrayBuffer: false,
        exactBounds: false,
        detachment: false,
        transferPrevention: false,
        cleanupHooks: false,
    };
    if (process.platform !== "linux") {
        return { available: false, ...base, reason: "platform_unsupported" };
    }
    if (!("Bun" in globalThis) && process.release.name === "node") {
        return {
            available: false,
            ...base,
            reason: "node_detachment_unavailable",
        };
    }
    const native = addon();
    if (!native)
        return { available: false, ...base, reason: "addon_unavailable" };
    try {
        const napiVersion = native.napiVersion();
        if (napiVersion < 8) {
            return {
                available: false,
                ...base,
                napiVersion,
                reason: "napi_8_unavailable",
            };
        }
        const view = native.createExternalProbe(31);
        const externalArrayBuffer =
            view instanceof Uint8Array && view.byteLength === 31;
        const exactBounds =
            externalArrayBuffer &&
            view.byteOffset === 0 &&
            view.buffer.byteLength === 31;
        if (!exactBounds) {
            return {
                available: false,
                ...base,
                napiVersion,
                externalArrayBuffer,
                reason: "external_exact_bounds_unavailable",
            };
        }
        const arrayBuffer = view.buffer as ArrayBuffer;
        const subarray = view.subarray(1, 30);
        const dataView = new DataView(arrayBuffer, 1, 29);
        const bufferAlias = Buffer.from(arrayBuffer, 0, view.byteLength);
        markAsUntransferable(arrayBuffer);
        let transferPrevention = false;
        try {
            structuredClone(arrayBuffer, { transfer: [arrayBuffer] });
        } catch {
            transferPrevention = arrayBuffer.byteLength === 31;
        }
        if (!transferPrevention) {
            return {
                available: false,
                ...base,
                napiVersion,
                externalArrayBuffer,
                exactBounds,
                reason: "transfer_prevention_unavailable",
            };
        }
        const detachment = native.detachArrayBuffer(arrayBuffer);
        const aliasesDetached =
            detachment &&
            Number(arrayBuffer.byteLength) === 0 &&
            Number(view.byteLength) === 0 &&
            subarray.byteLength === 0 &&
            bufferAlias.byteLength === 0 &&
            (() => {
                try {
                    return dataView.byteLength === 0;
                } catch {
                    return true;
                }
            })();
        if (!aliasesDetached) {
            return {
                available: false,
                ...base,
                napiVersion,
                externalArrayBuffer,
                exactBounds,
                transferPrevention,
                reason: "detachment_unavailable",
            };
        }
        return {
            available: true,
            napiVersion,
            externalArrayBuffer,
            exactBounds,
            detachment: true,
            transferPrevention,
            cleanupHooks: typeof native.registerCleanupProbe === "function",
        };
    } catch {
        return {
            available: false,
            ...base,
            reason: "runtime_mechanism_unavailable",
        };
    }
}

export class ProducerCursor {
    private cursor = 0;

    constructor(
        private readonly segments: readonly Uint8Array[],
        readonly capacity: number,
    ) {
        const available = segments.reduce(
            (sum, segment) => sum + segment.byteLength,
            0,
        );
        if (available !== capacity)
            throw new RangeError("producer spans disagree with reservation");
    }

    get written(): number {
        return this.cursor;
    }

    get remaining(): number {
        return this.capacity - this.cursor;
    }

    view(): Uint8Array {
        let offset = this.cursor;
        for (const segment of this.segments) {
            if (offset < segment.byteLength) return segment.subarray(offset);
            offset -= segment.byteLength;
        }
        return new Uint8Array(0);
    }

    advance(bytes: number): void {
        if (
            !Number.isSafeInteger(bytes) ||
            bytes < 0 ||
            bytes > this.remaining
        ) {
            throw new RangeError("producer overflow");
        }
        this.cursor += bytes;
    }

    write(bytes: Uint8Array): void {
        if (bytes.byteLength > this.remaining)
            throw new RangeError("producer overflow");
        let source = 0;
        let offset = this.cursor;
        for (const segment of this.segments) {
            if (source === bytes.byteLength) break;
            if (offset >= segment.byteLength) {
                offset -= segment.byteLength;
                continue;
            }
            const take = Math.min(
                segment.byteLength - offset,
                bytes.byteLength - source,
            );
            segment.set(bytes.subarray(source, source + take), offset);
            source += take;
            offset = 0;
        }
        this.cursor += bytes.byteLength;
    }
}

export class NativeProducerReservation {
    private active = true;

    constructor(
        private readonly native: NativeAddon,
        private readonly channel: number,
        private readonly token: number,
        readonly segments: readonly Uint8Array[],
    ) {
        protect(segments);
    }

    commit(
        header: Uint8Array,
        written: number,
        beforePublish?: () => void,
    ): void {
        this.assertActive();
        // Spent before the native call: commit_reservation detaches the
        // producer token native-side before its later validation can throw,
        // so a retry (or the abort() in an error path) would target an
        // already-detached token and mask the original error.
        this.active = false;
        this.native.commitReservation(
            this.channel,
            this.token,
            header,
            written,
            beforePublish ?? (() => {}),
        );
    }

    abort(): void {
        if (!this.active) return;
        // Same spent-before-native rule as commit(): never leave a window
        // where a throwing native call can be retried against a detached
        // token. A pre-detach native failure leaves the reservation tracked
        // in the channel registry, which close() aborts.
        this.active = false;
        this.native.abortReservation(this.channel, this.token);
    }

    private assertActive(): void {
        if (!this.active) throw new Error("producer reservation is released");
    }
}

export class NativeReceiveLease {
    private released = false;

    constructor(
        private readonly native: NativeAddon,
        private readonly channel: number,
        private readonly token: number,
        private readonly segments: readonly Uint8Array[],
        readonly header: Uint8Array,
    ) {
        protect(segments);
    }

    get byteLength(): number {
        this.assertActive();
        return this.segments.reduce(
            (sum, segment) => sum + segment.byteLength,
            0,
        );
    }

    get segmentCount(): number {
        this.assertActive();
        return this.segments.length;
    }

    segment(index: number): Uint8Array {
        this.assertActive();
        const segment = this.segments[index];
        if (!segment) throw new RangeError("receive segment does not exist");
        return segment;
    }

    release(): void {
        if (this.released) throw new Error("receive lease is already released");
        // Spent before the native call so a throwing release is never
        // retried against a possibly-detached token. Cleanup of a
        // live-but-failed lease is owned by channel close.
        this.released = true;
        this.native.release(this.channel, this.token);
    }

    [Symbol.dispose](): void {
        // Disposal is idempotent; explicit double release() keeps its throw.
        if (this.released) return;
        this.release();
    }

    private assertActive(): void {
        if (this.released) throw new Error("receive lease is released");
    }
}

export class NativeChannel {
    private closed = false;

    private constructor(
        private readonly native: NativeAddon,
        private readonly id: number,
    ) {}

    static attach(descriptor: NativeDescriptor): NativeChannel {
        const native = addon();
        if (!native || !probeCapabilities().available) {
            throw new Error("shared-memory native capability unavailable");
        }
        return new NativeChannel(native, native.attach(descriptor));
    }

    static createTestPair(): NativeTestPair {
        const native = addon();
        if (!native || !probeCapabilities().available) {
            throw new Error("shared-memory native capability unavailable");
        }
        const pair = native.createTestPair();
        return {
            first: new NativeChannel(native, pair.first),
            second: new NativeChannel(native, pair.second),
            descriptorDepth: pair.descriptorDepth,
            arenaBytes: pair.arenaBytes,
        };
    }

    produce(
        header: Uint8Array,
        capacity: number,
        fill: (cursor: ProducerCursor) => void,
        beforePublish?: () => void,
        timeoutMs = 0,
    ): void {
        this.assertOpen();
        this.native.produce(
            this.id,
            header,
            capacity,
            timeoutMs,
            (segments) => {
                protect(segments);
                const cursor = new ProducerCursor(segments, capacity);
                fill(cursor);
                if (cursor.written !== capacity)
                    throw new RangeError("producer underfill");
                return cursor.written;
            },
            beforePublish ?? (() => {}),
        );
    }

    reserve(capacity: number, timeoutMs = 0): NativeProducerReservation {
        this.assertOpen();
        let token: number | undefined;
        let segments: Uint8Array[] | undefined;
        this.native.reserve(
            this.id,
            capacity,
            timeoutMs,
            (reservedToken, reservedSegments) => {
                token = reservedToken;
                segments = reservedSegments;
            },
        );
        if (token === undefined || segments === undefined) {
            throw new Error("native reservation callback did not run");
        }
        return new NativeProducerReservation(
            this.native,
            this.id,
            token,
            segments,
        );
    }

    poll(deliver: (lease: NativeReceiveLease) => void): boolean {
        this.assertOpen();
        return this.native.poll(this.id, (token, header, segments) => {
            deliver(
                new NativeReceiveLease(
                    this.native,
                    this.id,
                    token,
                    segments,
                    header,
                ),
            );
        });
    }

    close(): void {
        if (this.closed) return;
        this.native.close(this.id);
        this.closed = true;
    }

    forceClose(): void {
        if (this.closed) return;
        this.native.forceClose(this.id);
        this.closed = true;
    }

    private assertOpen(): void {
        if (this.closed) throw new Error("native channel is closed");
    }
}

export function registerCleanupProbe(path: string): boolean {
    const native = addon();
    if (!native) return false;
    native.registerCleanupProbe(path);
    return true;
}

export function nativeLeakDiagnostics(): number {
    return addon()?.nativeLeakDiagnostics() ?? 0;
}

export function activeExternalRefs(): number {
    return addon()?.activeExternalRefCount() ?? 0;
}

export function setExternalViewCreationFailpoint(call: number): void {
    addon()?.setExternalViewFailpoint(call);
}

export function activeNativeChannels(): number {
    return addon()?.activeChannelCount() ?? 0;
}
