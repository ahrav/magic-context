import { Buffer } from "node:buffer";
import type { Database } from "../../shared/sqlite";
import type { SessionMeta } from "./types";
export interface SessionMetaRow {
    session_id: string;
    last_response_time: number;
    cache_ttl: string;
    counter: number;
    last_nudge_tokens: number;
    last_nudge_band: string;
    last_transform_error: string;
    is_subagent: number;
    last_context_percentage: number;
    last_input_tokens: number;
    observed_safe_input_tokens: number;
    cache_alert_sent: number;
    times_execute_threshold_reached: number;
    compartment_in_progress: number;
    system_prompt_hash: string | number;
    system_prompt_tokens: number;
    conversation_tokens: number;
    tool_call_tokens: number;
    cleared_reasoning_through_tag: number;
    tool_reclaim_watermark: number | null;
    last_todo_state: string;
    cached_m0_bytes: Buffer | Uint8Array | null;
    cached_m0_mural_data_url: string | null;
    cached_m0_mural_hash: string | null;
    cached_m1_bytes: Buffer | Uint8Array | null;
    cached_m0_claim_format_epoch: number | null;
    cached_m0_claim_snapshot_vector: string | null;
    cached_m0_rendered_revision_locators: string | null;
    cached_m0_project_memory_epoch: number | null;
    cached_m0_workspace_fingerprint: string | null;
    cached_m0_project_user_profile_version: number | null;
    cached_m0_max_compartment_seq: number | null;
    cached_m0_max_mutation_id: number | null;
    cached_m0_project_docs_hash: string | null;
    cached_m0_materialized_at: number | null;
    cached_m0_session_facts_version: number | null;
    cached_m0_upgrade_state: string | null;
    cached_m0_system_hash: string | null;
    cached_m0_tool_set_hash: string | null;
    cached_m0_model_key: string | null;
    cached_m0_project_identity: string | null;
    last_observed_model_key: string | null;
    last_usage_context_limit: number | null;
    prior_boundary_ordinal: number | null;
    protected_tail_policy_version: number | null;
    protected_tail_drain_window_started_at: number | null;
    protected_tail_drain_tokens: number | null;
    recovery_no_eligible_head_count: number | null;
    force_emergency_bypass_window_start: number | null;
    force_emergency_bypass_used: number | null;
    emergency_drain_active: number | null;
    historian_drain_failure_at: number | null;
    upgrade_reminded_at: number | null;
    upgrade_reminder_last_sent_at: number | null;
    upgrade_reminder_count: number | null;
    pi_stable_id_scheme: number | null;
}
export declare const SESSION_META_SELECT_COLUMNS: readonly ["session_id", "last_response_time", "cache_ttl", "counter", "last_nudge_tokens", "last_nudge_band", "last_transform_error", "is_subagent", "last_context_percentage", "last_input_tokens", "observed_safe_input_tokens", "cache_alert_sent", "times_execute_threshold_reached", "compartment_in_progress", "system_prompt_hash", "system_prompt_tokens", "conversation_tokens", "tool_call_tokens", "cleared_reasoning_through_tag", "tool_reclaim_watermark", "last_todo_state", "cached_m0_bytes", "cached_m0_mural_data_url", "cached_m0_mural_hash", "cached_m1_bytes", "cached_m0_claim_format_epoch", "cached_m0_claim_snapshot_vector", "cached_m0_rendered_revision_locators", "cached_m0_project_memory_epoch", "cached_m0_workspace_fingerprint", "cached_m0_project_user_profile_version", "cached_m0_max_compartment_seq", "cached_m0_max_mutation_id", "cached_m0_project_docs_hash", "cached_m0_materialized_at", "cached_m0_session_facts_version", "cached_m0_upgrade_state", "cached_m0_system_hash", "cached_m0_tool_set_hash", "cached_m0_model_key", "cached_m0_project_identity", "last_observed_model_key", "last_usage_context_limit", "prior_boundary_ordinal", "protected_tail_policy_version", "protected_tail_drain_window_started_at", "protected_tail_drain_tokens", "recovery_no_eligible_head_count", "force_emergency_bypass_window_start", "force_emergency_bypass_used", "emergency_drain_active", "historian_drain_failure_at", "upgrade_reminded_at", "upgrade_reminder_last_sent_at", "upgrade_reminder_count", "pi_stable_id_scheme"];
export declare const META_COLUMNS: Record<string, string>;
export declare const BOOLEAN_META_KEYS: Set<string>;
export declare const NULL_BIND_META_KEYS: Set<string>;
export declare function isSessionMetaRow(row: unknown): row is SessionMetaRow;
export declare function getDefaultSessionMeta(sessionId: string): SessionMeta;
export declare function ensureSessionMetaRow(db: Database, sessionId: string): void;
/**
 * Increment the session facts version after a wholesale session_facts replacement.
 *
 * Transaction contract: callers must invoke this inside the same write transaction
 * that deletes/inserts the session_facts rows. This helper deliberately does not
 * create its own transaction so there is no race window between the data write
 * and the version bump.
 */
export declare function bumpSessionFactsVersion(db: Database, sessionId: string): void;
export declare function toSessionMeta(row: SessionMetaRow): SessionMeta;
export interface PersistCachedM0Payload {
    m0Bytes: Buffer;
    muralDataUrl?: string | null;
    muralHash?: string | null;
    claimFormatEpoch?: number | null;
    claimSnapshotVector?: string | null;
    renderedRevisionLocators?: string | null;
    projectMemoryEpoch?: number | null;
    workspaceFingerprint?: string | null;
    projectUserProfileVersion: number | null;
    maxCompartmentSeq: number;
    maxMutationId: number | null;
    m1Bytes?: Buffer | null;
    projectDocsHash: string | null;
    materializedAt: number;
    sessionFactsVersion: number;
    upgradeState: string | null;
    systemHash?: string | null;
    modelKey?: string | null;
    projectIdentity?: string | null;
}
export declare function persistCachedM0(db: Database, sessionId: string, payload: PersistCachedM0Payload): void;
export declare function clearCachedM0M1(db: Database, sessionId: string): void;
export declare function clearCachedM0(db: Database, sessionId: string): void;
//# sourceMappingURL=storage-meta-shared.d.ts.map