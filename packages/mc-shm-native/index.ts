import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markAsUntransferable } from "node:worker_threads";

export const QUALIFIED_TEST_PROFILE = "mc-host-test-ring-v1";
export const DESCRIPTOR_SCHEMA_VERSION = 2;

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

export type NativeStartupFailureReason =
    | "missing_addon"
    | "unsupported_platform"
    | "missing_manifest"
    | "wrong_platform_payload"
    | "missing_checksum"
    | "checksum_mismatch"
    | "debug_build"
    | "wrong_platform_binary"
    | "capability_unavailable";

/** Bounded startup failure safe for cross-package classification. */
export class NativeStartupError extends Error {
    constructor(readonly reason: NativeStartupFailureReason) {
        super(`shared-memory native startup failed: ${reason}`);
        this.name = "NativeStartupError";
    }
}

export interface NativeDescriptor {
    profile: string;
    hostToPeerFd: number;
    hostToPeerGrant: string;
    peerToHostFd: number;
    peerToHostGrant: string;
}

export interface NativeSetupOptions {
    setupSocket: string;
    key: Uint8Array;
    daemonId: Uint8Array;
    daemonVer: string;
    timeoutMs: number;
}

export interface NativeTestPair {
    first: NativeChannel;
    second: NativeChannel;
    descriptorDepth: number;
    arenaBytes: number;
}

interface NativeAddon {
    napiVersion(): number;
    buildProfile(): string;
    buildTarget(): string;
    createExternalProbe(length: number): Uint8Array;
    detachArrayBuffer(buffer: ArrayBuffer): boolean;
    registerCleanupProbe(path: string): void;
    nativeLeakDiagnostics(): number;
    activeExternalRefCount(): number;
    setExternalViewFailpoint(call: number): void;
    workerLimit(): number;
    activeChannelCount(): number;
    attach(descriptor: NativeDescriptor): number;
    connectSetup(options: NativeSetupOptions): number;
    peerClosed(channel: number): boolean;
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
let loadError: Error | undefined;
let constructorCapability: NativeCapabilities | undefined;

const PLATFORM_PACKAGES = {
    "darwin-arm64": {
        package: "@cortexkit/mc-host-darwin-arm64",
        target: "darwin-arm64",
        nativeTarget: "macos-aarch64",
    },
    "darwin-x64": {
        package: "@cortexkit/mc-host-darwin-x64",
        target: "darwin-x64",
        nativeTarget: "macos-x86_64",
    },
    "linux-x64": {
        package: "@cortexkit/mc-host-linux-x64-gnu",
        target: "linux-x64-gnu",
        nativeTarget: "linux-x86_64",
    },
} as const;

const ADDON_PAYLOAD_PATH = "payload/native/mc_shm_native.node";

type PlatformPackage = (typeof PLATFORM_PACKAGES)[keyof typeof PLATFORM_PACKAGES];

function platformPackage(): PlatformPackage {
    const platform = PLATFORM_PACKAGES[`${process.platform}-${process.arch}` as keyof typeof PLATFORM_PACKAGES];
    if (!platform) throw new NativeStartupError("unsupported_platform");
    return platform;
}

function packageAddonPath(platform: PlatformPackage): string {
    const require = createRequire(import.meta.url);
    let packageJsonPath: string;
    try {
        packageJsonPath = require.resolve(`${platform.package}/package.json`);
    } catch {
        throw new NativeStartupError("missing_addon");
    }
    const packageDir = dirname(packageJsonPath);
    const manifestPath = join(packageDir, "payload-manifest.json");
    if (!existsSync(manifestPath)) {
        throw new NativeStartupError("missing_manifest");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        package?: { name?: string; target?: string };
        files?: { path?: string; sha256?: string }[];
    };
    if (
        manifest.package?.name !== platform.package ||
        manifest.package.target !== platform.target
    ) {
        throw new NativeStartupError("wrong_platform_payload");
    }
    const entry = manifest.files?.find(({ path }) => path === ADDON_PAYLOAD_PATH);
    if (!entry || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) {
        throw new NativeStartupError("missing_checksum");
    }
    const addonPath = join(packageDir, ADDON_PAYLOAD_PATH);
    if (!existsSync(addonPath)) {
        throw new NativeStartupError("missing_addon");
    }
    const actual = createHash("sha256").update(readFileSync(addonPath)).digest("hex");
    if (actual !== entry.sha256) {
        throw new NativeStartupError("checksum_mismatch");
    }
    return addonPath;
}

function requireAddon(): NativeAddon {
    if (loaded) return loaded;
    if (loadError) throw loadError;
    try {
        const platform = platformPackage();
        const localPath = new URL("./mc_shm_native.node", import.meta.url);
        const addonPath = existsSync(localPath)
            ? fileURLToPath(localPath)
            : packageAddonPath(platform);
        const native = createRequire(import.meta.url)(addonPath) as NativeAddon;
        if (native.buildProfile() !== "release") {
            throw new NativeStartupError("debug_build");
        }
        if (native.buildTarget() !== platform.nativeTarget) {
            throw new NativeStartupError("wrong_platform_binary");
        }
        loaded = native;
        return native;
    } catch (error) {
        loadError = error instanceof Error ? error : new Error(String(error));
        loaded = null;
        throw loadError;
    }
}

function capableAddon(): NativeAddon {
    const native = requireAddon();
    const capability = (constructorCapability ??= probeCapabilities());
    if (!capability.available) throw new NativeStartupError("capability_unavailable");
    return native;
}

function addon(): NativeAddon | null {
    try {
        return requireAddon();
    } catch {
        return null;
    }
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
        if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
            return {
                available: false,
                ...base,
                napiVersion,
                reason: "detachment_unavailable",
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
        if (typeof native.registerCleanupProbe !== "function") {
            return {
                available: false,
                ...base,
                napiVersion,
                externalArrayBuffer,
                exactBounds,
                detachment: true,
                transferPrevention,
                reason: "cleanup_hooks_unavailable",
            };
        }
        return {
            available: true,
            napiVersion,
            externalArrayBuffer,
            exactBounds,
            detachment: true,
            transferPrevention,
            cleanupHooks: true,
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
        const native = capableAddon();
        return new NativeChannel(native, native.attach(descriptor));
    }

    static connectSetup(options: NativeSetupOptions): NativeChannel {
        const native = capableAddon();
        return new NativeChannel(native, native.connectSetup(options));
    }

    static createTestPair(): NativeTestPair {
        const native = capableAddon();
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

    /**
     * True once the host has dropped the setup socket that scopes this channel's
     * lifetime. A ring that has simply gone quiet is indistinguishable from a
     * dead peer without this signal. commentlint: allow(JUDGE)
     */
    peerClosed(): boolean {
        if (this.closed) return true;
        return this.native.peerClosed(this.id);
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
