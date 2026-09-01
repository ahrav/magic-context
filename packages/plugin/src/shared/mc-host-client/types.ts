/**
 *
 * The wire-protocol definitions come from `docs/mc-host-wire-protocol.md`.
 */

/**
 * The caller supplies this route identity on `route.open`.
 * `BindIdentity` only scopes routes; it grants no authority.
 */
export interface BindIdentity {
    project_root: string;
    harness: string;
    session: string;
    credential_fingerprints?: Readonly<Record<string, string>>;
}

/** `RouteTarget` serializes with `kind` as its snake_case tag. */
export type RouteTarget =
    | { kind: "tool_provider"; module_id: string }
    | { kind: "management_surface"; module_id: string }
    | { kind: "internal_service"; module_id: string; service_id: string };

/* */
export type ManagedRouteKind = "management_surface" | "tool_provider";

/* */
export interface ConsumerIdentity {
    module_id: string;
    launch_nonce: string;
}

/**
 * `CatalogEntry` represents one tagged `catalog.list` response entry.
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
    /** Ring diagnostics when the host reports them; absent on hosts that do not. */
    sharedMemory?: Record<string, unknown>;
}

/**
 * `AuthenticatedPeer` retains handshake-authenticated identity separately from connection-file metadata.
 * Connection-file `daemon_ver` and `pid` are untrusted metadata.
 *
 * `daemonId` is non-null because every consumer authorizes against it as a fencing identity.
 * A connection whose handshake produces no daemon ID has no authenticated peer.
 * `McHostClient.authenticated` reports null instead of a partial record when the handshake produces no daemon ID.
 */
export interface AuthenticatedPeer {
    daemonVer: string;
    daemonId: Uint8Array;
    proof: "current";
}

/**
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
 * `Priority` uses flags bits 1–2.
 * enum transform.
 */
export const Priority = {
    Passive: 0,
    Interactive: 1,
    Background: 2,
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

/** `AdmissionClass` uses flags bits 4–5. */
export const AdmissionClass = {
    Normal: 0,
    Expedite: 1,
    Sheddable: 2,
} as const;
export type AdmissionClass = (typeof AdmissionClass)[keyof typeof AdmissionClass];

/* */
export interface ConnectOptions {
    connectionFile: string;
    handshakeTimeoutMs?: number;
    /** `ConnectOptions.identity` supplies the default identity for managed `call()` and permits per-call overrides. */
    identity?: BindIdentity;
    /** `ConnectOptions.targetKind` defaults to `management_surface`. */
    targetKind?: ManagedRouteKind;
    /** `credentialSource` contains current provider rows; only connection-keyed fingerprints leave the client. */
    credentialSource?: Record<string, string | undefined>;
}

/* */
export interface RequestOptions {
    priority?: Priority;
    admissionClass?: AdmissionClass;
    timeoutMs?: number;
    /** The facade attaches `McHostCallError.cleanup` when this signal aborts the request. */
    signal?: AbortSignal;
    /** When `expectedDaemonId` is set, the client rejects before publication unless it matches the active authenticated daemon ID. */
    expectedDaemonId?: Uint8Array;
}

/* */
export interface ManagedCallOptions extends RequestOptions {
    /** `ManagedCallOptions.identity` overrides the per-client identity for this `route.open` call. */
    identity?: BindIdentity;
    /** `ManagedCallOptions.targetKind` defaults to `management_surface`. */
    targetKind?: ManagedRouteKind;
}
