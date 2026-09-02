/**
 * The daemon-produced members mirror `crates/mc-module/src/kernel_routes/state.rs`
 * one to one; the literal sets below must stay byte-identical to that file's
 * serde output. The client-only members describe outcomes the daemon never
 * sees: the feature is off, the caller cancelled, or no daemon could be
 * reached. `MEMORY_STATE_GUIDANCE` is total over `StateKey`, so adding a member
 * without guidance is a compile error.
 */

export const UNAVAILABLE_REASONS = [
    "store_starting",
    "store_unavailable",
    "store_unsupported",
    "store_busy",
    "no_required_consumer",
    "snapshot_diverged",
    "queue_full",
] as const;
export type DaemonUnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export const CONFLICT_REASONS = ["known_as_of_advanced", "retracted", "superseded"] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

export const INVALID_REASONS = [
    "project_mismatch",
    "operation_key_reused",
    "class_over_declared",
    "invalid_input",
    "admission_policy",
    "payload_too_large",
    "page_digest",
    "page_index",
    "page_too_large",
    "payload_digest",
    "upload_not_found",
    "ingestion_fail_closed",
    "artifact_unusable",
    "internal",
] as const;
export type DaemonInvalidReason = (typeof INVALID_REASONS)[number];

/** `daemon_absent` is minted by the client; the daemon cannot report its own absence. */
export type UnavailableReason = DaemonUnavailableReason | "daemon_absent";
/** `unrecognized_state` is minted by the client for a `state` it cannot classify. */
export type InvalidReason = DaemonInvalidReason | "unrecognized_state";

export interface LagFacts {
    lag_positions: number;
    oldest_unconsumed_age_ms: number;
}

export type MemoryState =
    | { kind: "available" }
    | ({ kind: "stale" } & LagFacts)
    | ({ kind: "abstained" } & LagFacts)
    | { kind: "unavailable"; reason: UnavailableReason }
    | { kind: "conflict"; reason: ConflictReason }
    | { kind: "invalid"; reason: InvalidReason }
    | { kind: "disabled" }
    | { kind: "cancelled" };

/** `kind` for members without a reason, `kind:reason` for members with one. */
export type StateKey = MemoryState extends infer S
    ? S extends { kind: infer K extends string; reason: infer R extends string }
        ? `${K}:${R}`
        : S extends { kind: infer K extends string }
          ? K
          : never
    : never;

export function stateKey(state: MemoryState): StateKey {
    return ("reason" in state ? `${state.kind}:${state.reason}` : state.kind) as StateKey;
}

export interface Guidance {
    /** One line for an injected context block. */
    marker: string;
    /** One sentence for a tool result. */
    tool: string;
}

export const MEMORY_STATE_GUIDANCE = {
    available: {
        marker: "memory: current",
        tool: "Memory is current.",
    },
    stale: {
        marker: "memory: results may lag recent changes",
        tool: "Memory results may lag recent changes; the projector has not caught up.",
    },
    abstained: {
        marker: "memory: automatic search withheld while the projector catches up",
        tool: "Automatic memory search was withheld because the projector is behind; use explicit search if needed.",
    },
    "unavailable:store_starting": {
        marker: "memory: store is opening",
        tool: "Memory is unavailable while the store opens; it becomes available once opening completes.",
    },
    "unavailable:store_unavailable": {
        marker: "memory: store is unavailable",
        tool: "Memory is unavailable because the store failed or lost its lease.",
    },
    "unavailable:store_unsupported": {
        marker: "memory: store cannot be opened by this build",
        tool: "Memory is unavailable because this build cannot open the store; run the doctor check.",
    },
    "unavailable:store_busy": {
        marker: "memory: store is busy",
        tool: "Memory is unavailable because the store is busy; the next natural request re-probes.",
    },
    "unavailable:no_required_consumer": {
        marker: "memory: freshness cannot be judged (no consumer registered)",
        tool: "Memory freshness cannot be judged because no consumer is registered.",
    },
    "unavailable:snapshot_diverged": {
        marker: "memory: snapshot diverged from the store",
        tool: "Memory is unavailable because the known snapshot is ahead of the store; cached tokens were dropped.",
    },
    "unavailable:queue_full": {
        marker: "memory: upload queue is full",
        tool: "Memory is unavailable because the artifact upload queue is full.",
    },
    "unavailable:daemon_absent": {
        marker: "memory: daemon not running",
        tool: "Memory is unavailable because the daemon is not running.",
    },
    "conflict:known_as_of_advanced": {
        marker: "memory: object changed since it was read",
        tool: "The object changed since it was read; read it again before writing.",
    },
    "conflict:retracted": {
        marker: "memory: object was retracted",
        tool: "The object was retracted; read again and choose a live object.",
    },
    "conflict:superseded": {
        marker: "memory: object was superseded",
        tool: "The object was superseded; read again and target its replacement.",
    },
    "invalid:project_mismatch": {
        marker: "memory: request named a different project",
        tool: "The request named a project other than the bound one.",
    },
    "invalid:operation_key_reused": {
        marker: "memory: operation key reused with different content",
        tool: "The operation key was reused with a different request digest.",
    },
    "invalid:class_over_declared": {
        marker: "memory: asserted class exceeds the derived class",
        tool: "The asserted source or sensitivity class is above what the daemon derives.",
    },
    "invalid:invalid_input": {
        marker: "memory: request rejected as invalid input",
        tool: "The kernel rejected the request as invalid input.",
    },
    "invalid:admission_policy": {
        marker: "memory: request rejected by admission policy",
        tool: "Admission policy rejected the request.",
    },
    "invalid:payload_too_large": {
        marker: "memory: payload too large",
        tool: "The payload exceeds the size the kernel accepts.",
    },
    "invalid:page_digest": {
        marker: "memory: upload page digest mismatch",
        tool: "An upload page did not match its declared digest.",
    },
    "invalid:page_index": {
        marker: "memory: upload page index outside the declared layout",
        tool: "An upload page fell outside the declared layout.",
    },
    "invalid:page_too_large": {
        marker: "memory: upload page too large",
        tool: "An upload page decodes to more bytes than one page may carry.",
    },
    "invalid:payload_digest": {
        marker: "memory: payload digest mismatch",
        tool: "The assembled payload did not hash to the declared digest.",
    },
    "invalid:upload_not_found": {
        marker: "memory: upload not in flight",
        tool: "The named upload is not in flight on this route.",
    },
    "invalid:ingestion_fail_closed": {
        marker: "memory: artifact ingestion is fail-closed",
        tool: "Artifact ingestion is fail-closed until the store reopens.",
    },
    "invalid:artifact_unusable": {
        marker: "memory: artifact unusable",
        tool: "The artifact is not live or holds a secret the redactor cannot rewrite.",
    },
    "invalid:internal": {
        marker: "memory: internal error",
        tool: "Memory hit an internal error; see the plugin log.",
    },
    "invalid:unrecognized_state": {
        marker: "memory: daemon answered with an unrecognized state",
        tool: "The daemon answered with a state this client does not recognize; update the plugin or daemon.",
    },
    disabled: {
        marker: "memory: disabled by configuration",
        tool: "Memory is disabled by configuration (memory.enabled = false).",
    },
    cancelled: {
        marker: "memory: request cancelled",
        tool: "The memory request was cancelled before it completed.",
    },
} as const satisfies Record<StateKey, Guidance>;

export function guidanceFor(state: MemoryState): Guidance {
    return MEMORY_STATE_GUIDANCE[stateKey(state)];
}

export const ALL_STATE_KEYS = Object.keys(MEMORY_STATE_GUIDANCE) as StateKey[];

export const available = (): MemoryState => ({ kind: "available" });
export const unavailable = (reason: UnavailableReason): MemoryState => ({
    kind: "unavailable",
    reason,
});
export const conflict = (reason: ConflictReason): MemoryState => ({ kind: "conflict", reason });
export const invalid = (reason: InvalidReason): MemoryState => ({ kind: "invalid", reason });
export const disabled = (): MemoryState => ({ kind: "disabled" });
export const cancelled = (): MemoryState => ({ kind: "cancelled" });
