/**
 * Avoid `bun:test` so non-Bun test suites can import these helpers.
 */

import assert from "node:assert/strict";
import { ShmGrantError, type ShmGrantErrorCode } from "../shm-grant";

// Field offsets mirror RingGrant::encode in backend/ring.rs. commentlint: allow(JUDGE)
export function grantHex(
    overrides: Partial<{
        layoutVersion: number;
        incarnation: number;
        lane: number;
        depth: bigint;
        arena: bigint;
        maxLeases: bigint;
        total: bigint;
        reserved: number;
    }> = {},
): string {
    const bytes = new Uint8Array(58);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, overrides.layoutVersion ?? 2, true);
    bytes[2] = overrides.incarnation ?? 0xab;
    view.setUint32(18, overrides.lane ?? 0, true);
    view.setBigUint64(22, overrides.depth ?? 8n, true);
    const arena = overrides.arena ?? 67_108_864n;
    view.setBigUint64(30, arena, true);
    view.setBigUint64(38, overrides.maxLeases ?? 8n, true);
    view.setBigUint64(46, overrides.total ?? arena + 8_192n, true);
    view.setUint32(54, overrides.reserved ?? 0, true);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Runs `fn`, requiring it to throw a `ShmGrantError` with exactly `code`. */
export function expectGrantCode(fn: () => unknown, code: ShmGrantErrorCode): ShmGrantError {
    let caught: unknown;
    try {
        fn();
    } catch (error) {
        caught = error;
    }
    assert.ok(caught instanceof ShmGrantError, `expected ShmGrantError, got ${String(caught)}`);
    assert.equal(caught.code, code);
    return caught;
}
