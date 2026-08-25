/**
 * Strict shared-memory grant descriptor schema (U1, KTD2 layer b).
 *
 * The negotiation envelope (layer a, `transport-negotiation.ts`) delivers a
 * duplicate-free plain `descriptor` object. This module owns the second
 * layer: the exact provider shared-memory grant schema, bound to
 * `candidate_id`, validated BEFORE any fd access, mapping, prefault, or
 * native registry mutation can happen.
 *
 * Leaf module: no imports. Decoding is defensive against exotic value
 * shapes — every field is read exactly once into a local primitive
 * (accessor properties and Proxies cannot swap values between validation
 * and use), and any provider-thrown getter error is replaced by a bounded
 * error. Decode failures carry only a bounded code and a structural field
 * path; grant bytes, pids, fds, and identifiers never reach error messages.
 */

/** Bounded grant decode failure taxonomy. */
export type ShmGrantErrorCode =
    | "invalid_type"
    | "missing_field"
    | "unexpected_field"
    | "out_of_range"
    | "profile_mismatch"
    | "malformed_grant"
    | "lane_mismatch"
    | "geometry_mismatch"
    | "aliased_lanes"
    | "stale_candidate";

/**
 * One grant decode failure: a bounded code plus a structural field path
 * built only from documented field names. Peer-supplied bytes never appear
 * here.
 */
export class ShmGrantError extends Error {
    constructor(
        readonly code: ShmGrantErrorCode,
        readonly path: string,
    ) {
        super(`${code} at ${path}`);
        this.name = "ShmGrantError";
    }
}

/** The validated grant: local primitives only, safe to hand to native code. */
export interface ShmGrant {
    profile: string;
    pid: number;
    candidateId: number;
    hostToPeerFd: number;
    hostToPeerGrant: string;
    peerToHostFd: number;
    peerToHostGrant: string;
}

/**
 * Ring grant wire width (`RingGrant::encode` in
 * `crates/mc-shm-transport/src/backend/ring.rs`): 58 bytes, hex-encoded to
 * 116 lowercase ASCII characters by the host.
 */
const GRANT_HEX_LEN = 116;

/** `LAYOUT_VERSION` in `backend/ring.rs`. */
const LAYOUT_VERSION = 2;
/** Exact frozen `mc-host-test-ring-v1` geometry (`profile.rs::ring_profile`). */
const DESCRIPTOR_DEPTH = 32n;
const ARENA_BYTES = 67_108_864n;
const MAX_LEASES = 32n;
/**
 * Absolute cap on the mapping size a grant may request: the exact arena
 * plus a generous 1 MiB metadata allowance. The native side re-derives the
 * exact total from the layout; this bound only stops an over-profile grant
 * from reaching fd access or a huge mmap at all.
 */
const MAX_TOTAL_BYTES = ARENA_BYTES + 1_048_576n;
/** `DuplexRing::create` lane assignment: first (host_to_peer) 0, second 1. */
const HOST_TO_PEER_LANE = 0;
const PEER_TO_HOST_LANE = 1;

const GRANT_FIELDS = [
    "profile",
    "pid",
    "candidate_id",
    "host_to_peer_fd",
    "host_to_peer_grant",
    "peer_to_host_fd",
    "peer_to_host_grant",
] as const;

const GRANT_TEXT_RE = /^[0-9a-f]{116}$/;

/**
 * Reads one property exactly once, replacing any getter/Proxy throw with a
 * bounded error so provider-authored failure text cannot escape.
 */
function readOnce<T>(
    source: Record<string, unknown>,
    key: string,
    path: string,
    parse: (value: unknown, path: string) => T,
): T {
    let value: unknown;
    try {
        value = source[key];
    } catch {
        throw new ShmGrantError("invalid_type", path);
    }
    return parse(value, path);
}

/**
 * A strict integer field: a plain finite number with no fractional part,
 * never `-0`, within `[min, max]`. `NaN`, infinities, and values beyond
 * `Number.MAX_SAFE_INTEGER` all fail `Number.isSafeInteger`.
 */
function integerParser(min: number, max: number): (value: unknown, path: string) => number {
    return (value, path) => {
        if (typeof value !== "number") throw new ShmGrantError("invalid_type", path);
        if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
            throw new ShmGrantError("invalid_type", path);
        }
        if (value < min || value > max) throw new ShmGrantError("out_of_range", path);
        return value;
    };
}

/** Exactly {@link GRANT_HEX_LEN} lowercase hexadecimal ASCII characters. */
function parseGrantText(value: unknown, path: string): string {
    if (typeof value !== "string") throw new ShmGrantError("invalid_type", path);
    if (!GRANT_TEXT_RE.test(value)) throw new ShmGrantError("malformed_grant", path);
    return value;
}

/** Decoded ring-grant metadata; incarnation stays internal to this module. */
interface RingGrantFields {
    incarnation: string;
}

/**
 * Decodes and validates one hex ring grant against the exact frozen
 * profile geometry and the expected lane. Field offsets mirror
 * `RingGrant::encode` (layout version 2). Pure: no fd, mapping, or native
 * call is reachable from here.
 */
function validateRingGrant(hex: string, expectedLane: number, path: string): RingGrantFields {
    const bytes = new Uint8Array(GRANT_HEX_LEN / 2);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    const view = new DataView(bytes.buffer);
    const layoutVersion = view.getUint16(0, true);
    const incarnation = hex.slice(2 * 2, 18 * 2);
    const lane = view.getUint32(18, true);
    const descriptorDepth = view.getBigUint64(22, true);
    const arenaBytes = view.getBigUint64(30, true);
    const maxLeases = view.getBigUint64(38, true);
    const totalBytes = view.getBigUint64(46, true);
    const reserved = view.getUint32(54, true);
    if (
        layoutVersion !== LAYOUT_VERSION ||
        descriptorDepth !== DESCRIPTOR_DEPTH ||
        arenaBytes !== ARENA_BYTES ||
        maxLeases !== MAX_LEASES ||
        reserved !== 0
    ) {
        throw new ShmGrantError("geometry_mismatch", path);
    }
    if (totalBytes < arenaBytes || totalBytes > MAX_TOTAL_BYTES) {
        throw new ShmGrantError("out_of_range", path);
    }
    if (lane !== expectedLane) throw new ShmGrantError("lane_mismatch", path);
    return { incarnation };
}

/** Decode options: the exact expected profile and replay high-water mark. */
export interface ShmGrantOptions {
    expectedProfile: string;
    /**
     * Highest `candidate_id` already attached through this provider; a
     * descriptor at or below it is a replayed or stale candidate. `0`
     * accepts any valid id (host ids start at 1).
     */
    previousCandidateId?: number;
}

/**
 * Decodes and fully validates one shared-memory grant descriptor into
 * local primitives. Closed field set, exact profile, strict integer
 * representations, exact ring geometry per lane, expected lane binding,
 * distinct backing objects across the duplex pair, and candidate
 * monotonicity — all before the caller may touch an fd.
 */
export function decodeShmGrant(value: unknown, options: ShmGrantOptions): ShmGrant {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ShmGrantError("invalid_type", "descriptor");
    }
    let keys: (string | symbol)[];
    try {
        keys = Reflect.ownKeys(value);
    } catch {
        throw new ShmGrantError("invalid_type", "descriptor");
    }
    for (const key of keys) {
        if (typeof key !== "string" || !(GRANT_FIELDS as readonly string[]).includes(key)) {
            // The unknown key itself is peer-supplied and never echoed.
            throw new ShmGrantError("unexpected_field", "descriptor");
        }
    }
    const present = new Set(keys as string[]);
    for (const field of GRANT_FIELDS) {
        if (!present.has(field)) {
            throw new ShmGrantError("missing_field", `descriptor.${field}`);
        }
    }

    // Snapshot every field exactly once — parsed to a primitive at the
    // read — before any validation-then-use gap an accessor or Proxy could
    // exploit.
    const source = value as Record<string, unknown>;
    const parseFd = integerParser(0, 0x7fff_ffff);
    const profile = readOnce(source, "profile", "descriptor.profile", (raw, path) => {
        if (typeof raw !== "string") throw new ShmGrantError("invalid_type", path);
        if (raw !== options.expectedProfile) throw new ShmGrantError("profile_mismatch", path);
        return raw;
    });
    const pid = readOnce(source, "pid", "descriptor.pid", integerParser(1, 0xffff_ffff));
    const candidateId = readOnce(
        source,
        "candidate_id",
        "descriptor.candidate_id",
        integerParser(1, Number.MAX_SAFE_INTEGER),
    );
    if (candidateId <= (options.previousCandidateId ?? 0)) {
        throw new ShmGrantError("stale_candidate", "descriptor.candidate_id");
    }
    const hostToPeerFd = readOnce(source, "host_to_peer_fd", "descriptor.host_to_peer_fd", parseFd);
    const peerToHostFd = readOnce(source, "peer_to_host_fd", "descriptor.peer_to_host_fd", parseFd);
    const hostToPeerGrant = readOnce(
        source,
        "host_to_peer_grant",
        "descriptor.host_to_peer_grant",
        parseGrantText,
    );
    const peerToHostGrant = readOnce(
        source,
        "peer_to_host_grant",
        "descriptor.peer_to_host_grant",
        parseGrantText,
    );

    const hostToPeer = validateRingGrant(
        hostToPeerGrant,
        HOST_TO_PEER_LANE,
        "descriptor.host_to_peer_grant",
    );
    const peerToHost = validateRingGrant(
        peerToHostGrant,
        PEER_TO_HOST_LANE,
        "descriptor.peer_to_host_grant",
    );
    // The duplex pair must name two distinct backing objects: equal fds,
    // equal grants, or equal incarnations all alias one ring across both
    // directions.
    if (
        hostToPeerFd === peerToHostFd ||
        hostToPeerGrant === peerToHostGrant ||
        hostToPeer.incarnation === peerToHost.incarnation
    ) {
        throw new ShmGrantError("aliased_lanes", "descriptor");
    }

    return Object.freeze({
        profile,
        pid,
        candidateId,
        hostToPeerFd,
        hostToPeerGrant,
        peerToHostFd,
        peerToHostGrant,
    });
}
