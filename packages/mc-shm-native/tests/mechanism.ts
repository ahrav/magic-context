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
import { probeCapabilities } from "../index.ts";

const scratch = mkdtempSync(join(tmpdir(), "mc-shm-native-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const claimedTarget = process.env.MC_SHM_NATIVE_CLAIMED_TARGET === "1";

function requiredAddonPath(): string | null {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), "../mc_shm_native.node");
    if (existsSync(path)) return path;
    if (claimedTarget) throw new Error(`claimed native target is missing addon: ${path}`);
    return null;
}

describe("native mechanism gate", () => {
    test("proves every required runtime mechanism or omits capability", () => {
        const result = probeCapabilities();
        if (claimedTarget) expect(result.available).toBe(true);
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
        const addon = requiredAddonPath();
        if (!addon) return;
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
}

function loadRawAddon(): RawAttachAddon | null {
    const path = requiredAddonPath();
    if (!path) return null;
    return createRequire(import.meta.url)(path) as RawAttachAddon;
}

function supportsMechanismTests(addon: RawAttachAddon | null): addon is RawAttachAddon {
    const supportedPlatform = ["linux", "darwin"].includes(process.platform);
    if (addon && supportedPlatform) return true;
    if (claimedTarget) {
        throw new Error(`claimed native target is unsupported: ${process.platform}`);
    }
    return false;
}

/** Geometry of the `mc-host-test-ring-v1` profile (`ring_profile`). */
const GRANT_DESCRIPTOR_DEPTH = 32n;
/** `MIN_ARENA_BYTES` == `MAX_FRAME_BYTES` == 64 MiB. */
const GRANT_ARENA_BYTES = 67_108_864n;
const GRANT_MAX_LEASES = 32n;
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
const GRANT_LAYOUT_OVERHEAD_BYTES = 16_384n;

/**
 * Encodes one RingGrant wire image (layout version 2) as lowercase hex:
 * layout_version u16, incarnation [16], lane u32, descriptor_depth u64,
 * arena_bytes u64, max_leases u64, total_bytes u64, reserved u32 zero —
 * all little-endian.
 */
function testGrantHex(lane: number, incarnation: number): string {
    const bytes = new Uint8Array(58);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 2, true);
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
        hostToPeerGrant: testGrantHex(0, 0xab),
        peerToHostFd: 11,
        peerToHostGrant: testGrantHex(1, 0xcd),
    };
}

describe("raw N-API descriptor boundary", () => {
    const DESCRIPTOR_ERROR = /invalid shared-memory descriptor/;

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
        if (!supportsMechanismTests(addon)) return;
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
        if (!supportsMechanismTests(addon)) return;
        const hostileFds = [-1, -0, 2 ** 31, 3.5, Number.NaN, "10"];
        for (const fd of hostileFds) {
            expectRejectedWithoutEffects(addon, {
                ...validRawDescriptor(),
                hostToPeerFd: fd,
            });
            expectRejectedWithoutEffects(addon, {
                ...validRawDescriptor(),
                peerToHostFd: fd,
            });
        }
    });

    test("rejects malformed, non-ASCII, and aliased grant text", () => {
        const addon = loadRawAddon();
        if (!supportsMechanismTests(addon)) return;
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
        // One fd or one grant backing both lanes aliases the duplex pair.
        expectRejectedWithoutEffects(addon, {
            ...validRawDescriptor(),
            peerToHostFd: 10,
        });
        expectRejectedWithoutEffects(addon, {
            ...validRawDescriptor(),
            peerToHostGrant: testGrantHex(0, 0xab),
        });
    });

    test("accessor objects and proxies get one bounded redacted error", () => {
        const addon = loadRawAddon();
        if (!supportsMechanismTests(addon)) return;
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
        if (!supportsMechanismTests(addon)) return;
        expectRejectedWithoutEffects(
            addon,
            { ...validRawDescriptor(), profile: "SENTINEL_PROFILE" },
            /shared-memory profile is unavailable/,
        );
    });

    test("a well-formed but unresolvable descriptor fails without registry effects", () => {
        const addon = loadRawAddon();
        if (!supportsMechanismTests(addon)) return;
        expectRejectedWithoutEffects(
            addon,
            validRawDescriptor(),
            /shared-memory attachment failed/,
        );
    });
});
