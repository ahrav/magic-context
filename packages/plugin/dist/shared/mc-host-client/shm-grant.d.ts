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
export type ShmGrantErrorCode = "invalid_type" | "missing_field" | "unexpected_field" | "out_of_range" | "profile_mismatch" | "malformed_grant" | "lane_mismatch" | "geometry_mismatch" | "aliased_lanes" | "stale_candidate";
/**
 * One grant decode failure: a bounded code plus a structural field path
 * built only from documented field names. Peer-supplied bytes never appear
 * here.
 */
export declare class ShmGrantError extends Error {
    readonly code: ShmGrantErrorCode;
    readonly path: string;
    constructor(code: ShmGrantErrorCode, path: string);
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
/** Decode options: the exact expected profile and replay high-water mark. */
export interface ShmGrantOptions {
    expectedProfile: string;
    /**
     * Replay high-water mark from the last accepted grant: the issuing
     * daemon incarnation's `pid` and the highest `candidate_id` attached
     * from it. Candidate ids are monotonic within one host process
     * (`shm_provider::NEXT_CANDIDATE_ID` is process-local and restarts at
     * 1), so a grant from the same pid at or below the mark is a replayed
     * or stale candidate, while a different pid is a fresh incarnation
     * whose sequence starts over. A verbatim cross-incarnation replay
     * carries the old pid and stays fenced here; a forged descriptor with
     * a fresh pid is stopped downstream at attachment (KTD9: ring
     * incarnation fencing plus fd validity), which this sequence check
     * never replaced.
     */
    previousCandidate?: {
        pid: number;
        candidateId: number;
    };
}
/**
 * Decodes and fully validates one shared-memory grant descriptor into
 * local primitives. Closed field set, exact profile, strict integer
 * representations, exact ring geometry per lane, expected lane binding,
 * distinct backing objects across the duplex pair, and candidate
 * monotonicity — all before the caller may touch an fd.
 */
export declare function decodeShmGrant(value: unknown, options: ShmGrantOptions): ShmGrant;
//# sourceMappingURL=shm-grant.d.ts.map