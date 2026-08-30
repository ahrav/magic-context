/**
 * Shared public shapes for the mc-host consumer client.
 *
 * Leaf module: imports nothing from connection or facade code. Wire semantics
 * come from `docs/mc-host-wire-protocol.md`.
 */

/**
 * Route identity supplied by the caller on `route.open`. Scoping metadata
 * only; it grants no authority (wire doc Section 2).
 */
export interface BindIdentity {
    project_root: string;
    harness: string;
    session: string;
    credential_fingerprints?: Readonly<Record<string, string>>;
}

/** Serde-compatible route target (`tag = "kind"`, snake_case). */
export type RouteTarget =
    | { kind: "tool_provider"; module_id: string }
    | { kind: "management_surface"; module_id: string }
    | { kind: "internal_service"; module_id: string; service_id: string };

/** Target kinds the managed `call()` path can open. */
export type ManagedRouteKind = "management_surface" | "tool_provider";

/** Optional supervised-launch claim sent with `route.open`. */
export interface ConsumerIdentity {
    module_id: string;
    launch_nonce: string;
}

/**
 * One entry of a tagged `catalog.list` response. Consumers read `control_ops`
 * fail-open: only an affirmative capability entry changes behavior.
 */
export interface CatalogEntry {
    module_id: string;
    module_version: string;
    roles: unknown[];
    control_ops: string[];
}

export interface CatalogSnapshot {
    generation: number;
    subcOps: string[];
    modules: CatalogEntry[];
}

export interface HostStatusSnapshot {
    health: "ok" | "degraded" | "failing";
    metrics: Record<string, unknown>;
    sharedMemory?: SharedMemoryDiagnostics;
}

export interface SharedMemoryResourceCounts {
    descriptors: number;
    arena_bytes: number;
    leases: number;
    mappings: number;
    file_descriptors: number;
    workers: number;
    client_instances: number;
    pinned_workers: number;
}

export type SharedMemoryTerminalClass =
    | "missing_addon"
    | "identity_mismatch"
    | "setup_failure"
    | "peer_death"
    | "resource_exhaustion";

export interface SharedMemoryDiagnostics {
    state: "healthy" | "terminal";
    error_class: SharedMemoryTerminalClass | null;
    artifact: {
        profile: "mc-host-test-ring-v1";
        wire_version: 2;
        descriptor_schema: 3;
    };
    bounds: SharedMemoryResourceCounts;
    accounting: {
        active: SharedMemoryResourceCounts;
        quarantined: SharedMemoryResourceCounts;
    } | null;
    attachment: { completed: number };
    activation: { completed: number };
    peer_death: { observed: number };
    reclamation: { completed: number };
    exhaustion: { observed: number };
}

/**
 * AuthenticatedPeer retains handshake-authenticated identity separately from
 * untrusted connection-file `daemon_ver` and `pid` metadata.
 *
 * The daemon id is non-null by construction: it is the fencing identity every
 * consumer authorizes against, so a connection whose handshake produced no
 * daemon id has no authenticated peer at all and `McHostClient.authenticated`
 * reports null instead of a partial record.
 */
export interface AuthenticatedPeer {
    daemonVer: string;
    daemonId: Uint8Array;
    proof: "current";
}

/**
 * Single owner of the daemon-incarnation equality predicate every fence uses.
 * Absent bytes on either side are never equal, so a caller that cannot name an
 * identity cannot accidentally satisfy the comparison.
 */
export function sameDaemonId(
    left: Uint8Array | null | undefined,
    right: Uint8Array | null | undefined,
): boolean {
    if (left === null || left === undefined || right === null || right === undefined) return false;
    if (left.length !== right.length) return false;
    return left.every((byte, index) => byte === right[index]);
}

export interface PublicationDiagnostics {
    daemonVer: string;
    pid: number;
}

/**
 * Scheduling priority carried in flags bits 1-2. Runtime const object plus a
 * union type (never a TypeScript enum) so bundled Node/Bun loading needs no
 * enum transform.
 */
export const Priority = {
    Passive: 0,
    Interactive: 1,
    Background: 2,
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

/** Admission behavior carried in flags bits 4-5. */
export const AdmissionClass = {
    Normal: 0,
    Expedite: 1,
    Sheddable: 2,
} as const;
export type AdmissionClass = (typeof AdmissionClass)[keyof typeof AdmissionClass];

/** Options for `McHostClient.connect()` as used by current repo consumers. */
export interface ConnectOptions {
    connectionFile: string;
    handshakeTimeoutMs?: number;
    /** Default route identity used by managed `call()`; overridable per call. */
    identity?: BindIdentity;
    /** Default managed route target kind; defaults to `management_surface`. */
    targetKind?: ManagedRouteKind;
    /** Current provider rows; only connection-keyed fingerprints leave the client. */
    credentialSource?: Record<string, string | undefined>;
}

/** Per-request options for the raw routed `request()` path. */
export interface RequestOptions {
    priority?: Priority;
    admissionClass?: AdmissionClass;
    timeoutMs?: number;
    /** The facade attaches `McHostCallError.cleanup` when this signal aborts the request. */
    signal?: AbortSignal;
    /** Reject before publication unless the active authenticated generation has this daemon ID. */
    expectedDaemonId?: Uint8Array;
}

/** Options for the managed `call()` path (embedding-synapse usage). */
export interface ManagedCallOptions extends RequestOptions {
    /** Overrides the per-client identity used for route.open before this call. */
    identity?: BindIdentity;
    /** Defaults to `management_surface`. */
    targetKind?: ManagedRouteKind;
}
