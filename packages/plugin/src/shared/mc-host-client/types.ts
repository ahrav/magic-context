/**
 * Shared public shapes for the mc-host consumer client.
 *
 * Leaf module: imports nothing from connection or facade code and no npm
 * subc-client code. The shapes mirror the subset of `@cortexkit/subc-client`
 * 0.4.1 that in-repo consumers actually use. Wire semantics
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
    roles: unknown[];
    control_ops: string[];
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

/** Options for `SubcClient.connect()` as used by current repo consumers. */
export interface ConnectOptions {
    connectionFile: string;
    handshakeTimeoutMs?: number;
    /** Default route identity used by managed `call()`; overridable per call. */
    identity?: BindIdentity;
    /** Default managed route target kind; defaults to `management_surface`. */
    targetKind?: ManagedRouteKind;
}

/** Per-request options for the raw routed `request()` path. */
export interface RequestOptions {
    priority?: Priority;
    admissionClass?: AdmissionClass;
    timeoutMs?: number;
    /** The facade attaches `SubcCallError.cleanup` when this signal aborts the request. */
    signal?: AbortSignal;
}

/** Options for the managed `call()` path (embedding-synapse usage). */
export interface ManagedCallOptions extends RequestOptions {
    /** Overrides the per-client identity used for route.open before this call. */
    identity?: BindIdentity;
    /** Defaults to `management_surface`. */
    targetKind?: ManagedRouteKind;
}
