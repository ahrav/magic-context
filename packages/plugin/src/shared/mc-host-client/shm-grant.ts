/**
 *
 *
 * Decode failures expose only a bounded code and structural field path.
 * Error messages never include grant bytes, PIDs, file descriptors, or identifiers.
 */

/* */
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
 * ShmGrantError paths contain only fixed field names.
 * ShmGrantError messages never include peer-supplied bytes.
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

/* */
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
 * Each grant string must contain exactly 116 lowercase hexadecimal ASCII characters.
 */
const GRANT_HEX_LEN = 116;

/* */
const LAYOUT_VERSION = 2;
/* */
const DESCRIPTOR_DEPTH = 8n;
const ARENA_BYTES = 67_108_864n;
const MAX_LEASES = 8n;
/**
 * MAX_TOTAL_BYTES permits 1 MiB of metadata beyond ARENA_BYTES.
 */
const MAX_TOTAL_BYTES = ARENA_BYTES + 1_048_576n;
/* */
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
 * readOnce converts getter and Proxy exceptions to bounded errors so provider-authored text cannot escape.
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
 * integerParser accepts safe integers other than `-0` within `[min, max]`.
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

/* */
function parseGrantText(value: unknown, path: string): string {
    if (typeof value !== "string") throw new ShmGrantError("invalid_type", path);
    if (!GRANT_TEXT_RE.test(value)) throw new ShmGrantError("malformed_grant", path);
    return value;
}

/** RingGrantFields keeps incarnation internal to this module. */
interface RingGrantFields {
    incarnation: string;
}

/**
 * `validateRingGrant` does not reach fd, mapping, or native operations.
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

/* */
export interface ShmGrantOptions {
    expectedProfile: string;
    /**
     * never replaced.
     */
    previousCandidate?: { pid: number; candidateId: number };
}

/**
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

    // Reading each field once prevents accessors and Proxies from changing a value between validation and use.
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
    if (
        options.previousCandidate !== undefined &&
        pid === options.previousCandidate.pid &&
        candidateId <= options.previousCandidate.candidateId
    ) {
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
    // The duplex pair must name distinct backing objects; equal file descriptors, grants, or incarnations alias one ring across both lanes.
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
