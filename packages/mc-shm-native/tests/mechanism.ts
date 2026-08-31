import { afterAll, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { NativeChannel, probeCapabilities } from "../index.ts";

const scratch = mkdtempSync(join(tmpdir(), "mc-shm-native-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("native mechanism gate", () => {
    test("proves every required runtime mechanism or omits capability", () => {
        const result = probeCapabilities();
        expect(result.napiVersion === null || result.napiVersion >= 1).toBe(
            true,
        );
        if (result.available) {
            expect(result.napiVersion).toBeGreaterThanOrEqual(8);
            expect(result.externalArrayBuffer).toBe(true);
            expect(result.exactBounds).toBe(true);
            expect(result.detachment).toBe(true);
            expect(result.transferPrevention).toBe(true);
            expect(result.cleanupHooks).toBe(true);
        } else {
            expect(typeof result.reason).toBe("string");
            expect(result.reason?.length).toBeGreaterThan(0);
        }
    });

    test("environment cleanup hook runs at runtime exit when addon loads", () => {
        const marker = join(scratch, "cleanup.marker");
        const script = join(scratch, "cleanup.mjs");
        const addon = resolve(
            dirname(fileURLToPath(import.meta.url)),
            "../mc_shm_native.node",
        );
        // The first test tolerates an unbuilt addon via probeCapabilities();
        // this one requires the artifact, so skip rather than fail without it.
        if (!existsSync(addon)) return;
        writeFileSync(
            script,
            `import { createRequire } from "node:module";\n` +
                `const addon = createRequire(import.meta.url)(${JSON.stringify(addon)});\n` +
                `addon.registerCleanupProbe(${JSON.stringify(marker)});\n` +
                `addon.createTestPair();\n`,
        );
        const child = spawnSync(process.execPath, [script], {
            encoding: "utf8",
        });
        expect(child.stderr).toBe("");
        expect(child.status).toBe(0);
        expect(readFileSync(marker, "utf8")).toBe("clean");
    });
});

interface RawAttachAddon {
    attach(descriptor: unknown): number;
    activeChannelCount(): number;
    activeExternalRefCount(): number;
    nativeLeakDiagnostics(): number;
    createTestPair(): { first: number; second: number };
    produce(
        channel: number,
        header: Uint8Array,
        capacity: number,
        timeoutMs: number,
        fill: (segments: Uint8Array[]) => number,
        beforePublish: () => void,
    ): void;
    poll(
        channel: number,
        deliver: (token: number, header: Uint8Array, segments: Uint8Array[]) => void,
    ): boolean;
    watch(channel: number, callback: () => void): void;
    readinessHandled(): boolean;
    release(channel: number, token: number): void;
    close(channel: number): void;
}

function loadRawAddon(): RawAttachAddon | null {
    const path = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../mc_shm_native.node",
    );
    if (!existsSync(path)) {
        if (process.env.MC_SHM_NATIVE_CLAIMED_TARGET === "1") {
            throw new Error("claimed native addon is missing");
        }
        return null;
    }
    return createRequire(import.meta.url)(path) as RawAttachAddon;
}

function supportsMechanismTests(addon: RawAttachAddon | null): addon is RawAttachAddon {
    return addon !== null && process.platform === "linux";
}

/** Geometry of the `mc-host-test-ring-v1` profile (`mc_host_ring_profile`). */
const GRANT_DESCRIPTOR_DEPTH = 8n;
/** `MIN_ARENA_BYTES` == `MAX_FRAME_BYTES` == 64 MiB. */
const GRANT_ARENA_BYTES = 67_108_864n;
const GRANT_MAX_LEASES = 8n;
/**
 * Bytes the ring layout adds around a page-aligned arena: the control
 * region that precedes it (producer, consumer, and reclaim cache lines
 * plus `descriptor_depth` slots, rounded up to a page) and the trailing
 * lifecycle page.
 *
 * `RingGrant::decode` recomputes the layout and rejects any grant whose
 * `total_bytes` disagrees, so this value is not decoration: it must track
 * `Layout::new(GRANT_DESCRIPTOR_DEPTH, GRANT_ARENA_BYTES).total`. Growing
 * a control-region struct past a page boundary changes it, and a stale
 * value surfaces as `invalid shared-memory descriptor` from whichever
 * test needs the grant to be *valid* — see the unresolvable-descriptor
 * test below, which is the only case that gets past decoding.
 */
const GRANT_LAYOUT_OVERHEAD_BYTES = 8_192n;

/**
 * Encodes one RingGrant wire image (layout version 3) as lowercase hex:
 * layout_version u16, incarnation [16], lane u32, descriptor_depth u64,
 * arena_bytes u64, max_leases u64, total_bytes u64, reserved u32 zero —
 * all little-endian.
 */
function testGrantHex(lane: number, incarnation: number): string {
    const bytes = new Uint8Array(58);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 3, true);
    bytes[2] = incarnation;
    view.setUint32(18, lane, true);
    view.setBigUint64(22, GRANT_DESCRIPTOR_DEPTH, true);
    view.setBigUint64(30, GRANT_ARENA_BYTES, true);
    view.setBigUint64(38, GRANT_MAX_LEASES, true);
    view.setBigUint64(
        46,
        GRANT_ARENA_BYTES + GRANT_LAYOUT_OVERHEAD_BYTES,
        true,
    );
    view.setUint32(54, 0, true);
    return [...bytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function validRawDescriptor(): Record<string, unknown> {
    return {
        profile: "mc-host-test-ring-v1",
        hostToPeerFd: 10,
        hostToPeerDataReadyFd: 11,
        hostToPeerCapacityReadyFd: 12,
        hostToPeerGrant: testGrantHex(0, 0xab),
        peerToHostFd: 13,
        peerToHostDataReadyFd: 14,
        peerToHostCapacityReadyFd: 15,
        peerToHostGrant: testGrantHex(1, 0xcd),
    };
}

describe("readiness dispatch", () => {
    test("one channel handler failure does not starve later channels", async () => {
        if (!probeCapabilities().available) return;
        const first = NativeChannel.createTestPair();
        const second = NativeChannel.createTestPair();
        let firstCalls = 0;
        let delivered = false;
        first.first.startReadiness(() => {
            firstCalls += 1;
            throw new Error("first handler failed");
        });
        second.first.startReadiness(() => {
            while (second.first.drainOne((lease) => {
                delivered = true;
                lease.release();
            })) {}
        });
        try {
            const header = new Uint8Array(21);
            const view = new DataView(header.buffer);
            view.setUint32(0, 0, true);
            view.setUint8(4, 2);
            view.setUint8(5, 3);
            view.setUint16(7, 1, true);
            view.setUint32(9, 1, true);
            second.second.produce(header, 0, () => {});
            const deadline = Date.now() + 1_000;
            while (!delivered && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
            expect(firstCalls).toBeGreaterThan(0);
            expect(delivered).toBe(true);
        } finally {
            first.first.close();
            first.second.close();
            second.first.close();
            second.second.close();
        }
    });
});

describe("raw N-API descriptor boundary", () => {
    const DESCRIPTOR_ERROR = /invalid shared-memory descriptor/;

    test("readiness acknowledgement preserves a frame published during callback", async () => {
        const addon = loadRawAddon();
        if (!supportsMechanismTests(addon)) return;
        const pair = addon.createTestPair();
        const received: number[] = [];
        let callbacks = 0;
        let complete!: () => void;
        const completed = new Promise<void>((resolve) => (complete = resolve));
        const publish = (value: number): void => {
            const header = new Uint8Array(21);
            const view = new DataView(header.buffer);
            view.setUint32(0, 1, true);
            view.setUint8(4, 2);
            view.setUint8(5, 3);
            view.setUint16(7, 1, true);
            view.setUint32(9, 1, true);
            view.setBigUint64(13, BigInt(value), true);
            addon.produce(
                pair.first,
                header,
                1,
                0,
                (segments) => {
                    segments[0]![0] = value;
                    return 1;
                },
                () => {},
            );
        };
        const onReady = (): void => {
            try {
                callbacks += 1;
                addon.poll(pair.second, (token, _header, segments) => {
                    received.push(segments[0]![0] ?? 0);
                    addon.release(pair.second, token);
                });
                if (callbacks === 1) {
                    publish(2);
                } else {
                    expect(addon.poll(pair.second, () => {})).toBe(false);
                    complete();
                }
            } finally {
                if (addon.readinessHandled()) queueMicrotask(onReady);
            }
        };
        addon.watch(pair.second, onReady);

        let timeout: ReturnType<typeof setTimeout>;
        try {
            publish(1);
            await Promise.race([
                completed,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error("readiness callback timed out")),
                        5_000,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timeout!);
            addon.close(pair.first);
            addon.close(pair.second);
        }
        expect(received).toEqual([1, 2]);
        expect(callbacks).toBe(2);
    });

    function expectRejectedWithoutEffects(
        addon: RawAttachAddon,
        descriptor: unknown,
        pattern: RegExp = DESCRIPTOR_ERROR,
    ): void {
        const channels = addon.activeChannelCount();
        const refs = addon.activeExternalRefCount();
        const leaks = addon.nativeLeakDiagnostics();
        expect(() => addon.attach(descriptor)).toThrow(pattern);
        expect(addon.activeChannelCount()).toBe(channels);
        expect(addon.activeExternalRefCount()).toBe(refs);
        expect(addon.nativeLeakDiagnostics()).toBe(leaks);
    }

    test("rejects non-object and structurally hostile arguments", () => {
        const addon = loadRawAddon();
        if (!addon || !["linux", "darwin"].includes(process.platform)) return;
        for (const hostile of [
            null,
            undefined,
            42,
            "descriptor",
            true,
            [],
            () => {},
        ]) {
            expectRejectedWithoutEffects(addon, hostile);
        }
        // A missing field and an explicit undefined are both absent.
        const { hostToPeerFd: _fd, ...missingFd } = validRawDescriptor();
        expectRejectedWithoutEffects(addon, missingFd);
        expectRejectedWithoutEffects(addon, {
            ...validRawDescriptor(),
            hostToPeerFd: undefined,
        });
    });

    test("rejects every unsafe numeric representation before narrowing", () => {
        const addon = loadRawAddon();
        if (!addon || !["linux", "darwin"].includes(process.platform)) return;
        const hostileFds = [-1, -0, 2 ** 31, 3.5, Number.NaN, "10"];
        const fields = [
            "hostToPeerFd",
            "hostToPeerDataReadyFd",
            "hostToPeerCapacityReadyFd",
            "peerToHostFd",
            "peerToHostDataReadyFd",
            "peerToHostCapacityReadyFd",
        ];
        for (const fd of hostileFds) {
            for (const field of fields) {
                expectRejectedWithoutEffects(addon, {
                    ...validRawDescriptor(),
                    [field]: fd,
                });
            }
        }
    });

    test("rejects malformed, non-ASCII, and aliased grant text", () => {
        const addon = loadRawAddon();
        if (!addon || !["linux", "darwin"].includes(process.platform)) return;
        const valid = validRawDescriptor();
        const hostileGrants = [
            "\u00e9".repeat(58), // UTF-8 length 116, non-ASCII
            testGrantHex(0, 0xab).toUpperCase(),
            testGrantHex(0, 0xab).slice(0, 115), // truncation
            `${testGrantHex(0, 0xab)}0`, // trailing digit
            `${testGrantHex(0, 0xab).slice(0, 114)}g0`, // non-hex tail
            "SENTINEL_GRANT_TEXT".padEnd(116, "0"),
            "",
            42,
        ];
        for (const grant of hostileGrants) {
            expectRejectedWithoutEffects(addon, {
                ...valid,
                hostToPeerGrant: grant,
            });
        }
        expectRejectedWithoutEffects(addon, {
            ...validRawDescriptor(),
            peerToHostCapacityReadyFd: 10,
        });
        expectRejectedWithoutEffects(addon, {
            ...validRawDescriptor(),
            peerToHostGrant: testGrantHex(0, 0xab),
        });
    });

    test("accessor objects and proxies get one bounded redacted error", () => {
        const addon = loadRawAddon();
        if (!addon || !["linux", "darwin"].includes(process.platform)) return;
        let reads = 0;
        const accessor = {
            ...validRawDescriptor(),
            get hostToPeerFd(): number {
                reads += 1;
                throw new Error("SENTINEL_ACCESSOR_THROW");
            },
        };
        try {
            addon.attach(accessor);
            throw new Error("attach unexpectedly succeeded");
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            expect(message).toBe("invalid shared-memory descriptor");
            expect(message).not.toContain("SENTINEL");
            expect((error as { cause?: unknown }).cause).toBeUndefined();
        }
        expect(reads).toBe(1);
        expect(addon.activeChannelCount()).toBe(0);

        const flipping = new Proxy(validRawDescriptor(), {
            get(target, property, receiver) {
                if (property === "hostToPeerFd") return Number.NaN;
                return Reflect.get(target, property, receiver);
            },
        });
        expectRejectedWithoutEffects(addon, flipping);
    });

    test("a wrong profile is refused before any attachment effect", () => {
        const addon = loadRawAddon();
        if (!addon || !["linux", "darwin"].includes(process.platform)) return;
        expectRejectedWithoutEffects(
            addon,
            { ...validRawDescriptor(), profile: "SENTINEL_PROFILE" },
            /shared-memory profile is unavailable/,
        );
    });

    test("a well-formed but unresolvable descriptor fails without registry effects", () => {
        const addon = loadRawAddon();
        if (!addon || !["linux", "darwin"].includes(process.platform)) return;
        expectRejectedWithoutEffects(
            addon,
            validRawDescriptor(),
            /shared-memory attachment failed/,
        );
    });
});
