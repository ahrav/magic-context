import { type ClaimOperationResult, type SnapshotVector } from "../../features/magic-context/memory/claim-operation-contract";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { type ClaimEffectDeliveryReceipt, type ClaimMirrorReceiptRequest, type ClaimMirrorReceiptResponse, type ClaimMirrorSnapshot, type ClaimMirrorSnapshotRequest, type ClaimMirrorSnapshotResponse } from "./module-wire";
import type { RawMessageParts } from "./read-session-raw";
export interface ModuleWatermarks {
    compartment_sequence: number;
    m0_mutation_id: number;
    last_todo_state_hash: string;
    project_memory_epoch: number;
    project_user_profile_version: number;
    /** Fingerprint of the current workspace epoch, used to determine whether cached
     * state-sync markers are still valid. */
    workspace_fingerprint?: string | null;
    reasoning_cleared_through_tag?: number;
}
export interface ModuleWorkspacePayload {
    fingerprint: string;
    members: Array<{
        project_path: string;
        share_categories: string[];
    }>;
}
export type ModuleDropMode = "full" | "truncated" | "edit_marker";
export interface ModuleDropSeed {
    block_id: string;
    /** Paired result blocks for a tool tag; they use the module's drop kind. */
    related_block_ids?: string[];
    drop_mode: ModuleDropMode;
    /** Canonical edit-marker input, when the source tool carries one. */
    payload?: string;
}
export interface ModulePendingDropSeed {
    block_id: string;
    queued_at_ms: number;
}
export interface ModuleNoteNudgeAnchorSeed {
    message_id: string;
    text: string;
}
export interface ModuleAutoSearchHintSeed {
    block_id: string;
    /** Empty text is a durable no-hint decision. */
    hint_text: string;
}
export interface ModuleTodoSyntheticAnchorSeed {
    call_id: string;
    message_id: string;
    state_json: string;
}
export interface ModuleEmergencyLatchSeed {
    last_input_sample: number;
    has_prior_drop: boolean;
    last_execute_ordinal: number;
}
export interface ModulePendingCompactionMarkerSeed {
    ordinal: number;
    end_message_id: string;
    published_at: number;
}
export interface ModuleDeferredExecuteSeed {
    id: string;
    reason: string;
    recorded_at: number;
}
export type ModuleStripKind = "placeholder" | "system_injected" | "stale_reduce" | "processed_image";
/** TypeScript-owned message strips to replay while the module warms up. */
export interface ModuleStripSeed {
    message_id: string;
    strip_kind: ModuleStripKind;
}
export interface ModuleStateSyncPayload {
    method: "state_sync";
    params: {
        session_id?: string;
        shadow_generation: number;
        expected_shadow_seq: number;
        seed_id?: string;
        seed_generation?: number;
        seed_batch_index?: number;
        seed_batch_total?: number;
        seed_complete?: boolean;
        seed_boundary_id?: string | null;
        compartments: unknown[];
        user_profile?: string[];
        workspace?: ModuleWorkspacePayload | null;
        last_todo_state?: string;
        project_memory_epoch?: number;
        user_profile_version?: number;
        acked_watermarks?: ModuleWatermarks;
        drop_seeds?: ModuleDropSeed[];
        drop_seed_skipped?: number;
        pending_agent_drops?: ModulePendingDropSeed[];
        pending_agent_drops_skipped?: number;
        note_nudge_anchors?: ModuleNoteNudgeAnchorSeed[];
        auto_search_hint_decisions?: ModuleAutoSearchHintSeed[];
        auto_search_hint_skipped?: number;
        /** True when auto_search_hint_decisions is the COMPLETE decision
         * list for the session: the native store deletes stored hint blocks
         * absent from the list (no backing decision the host can still
         * validate — e.g. a pre-policy hint whose raw message is gone). */
        user_hints_replace_session?: boolean;
        todo_synthetic_anchor?: ModuleTodoSyntheticAnchorSeed | null;
        emergency_latches?: ModuleEmergencyLatchSeed;
        pending_compaction_marker?: ModulePendingCompactionMarkerSeed | null;
        deferred_execute_state?: ModuleDeferredExecuteSeed | null;
        channel2_nudge_state?: string;
        strip_seeds?: ModuleStripSeed[];
        strip_seed_skipped?: number;
        reasoning_cleared_through_tag?: number;
    };
    watermarks: ModuleWatermarks;
    wireBatches?: ModuleStateSyncPayload[];
}
/** The subset of sender state needed to serialize a state-sync payload. */
export interface ModuleStateSyncState {
    moduleGeneration: number;
    lastAckedSeq: number;
    lastAckedWatermarks: ModuleWatermarks | null;
    idOrdinalMemoGeneration: number;
    idOrdinalMemo: Map<string, number>;
    seedPassPending?: boolean;
    /** Host-side proof that the claim mirror has been seeded. */
    claimMirrorSeeded?: boolean;
    claimMirrorSuppressed?: boolean;
    claimMirrorVector?: SnapshotVector | null;
}
export interface ModuleStateSyncPass {
    db: ContextDatabase;
    sessionId: string;
    projectPath?: string;
    nowMs: number;
}
export interface ModuleStateSyncOptions {
    beforeSerializeCompartment?: () => void;
    yieldEveryCompartments?: number;
    shouldAbortSeed?: () => boolean;
    /** Cached authority state used only to avoid sending rows the module already owns. */
    authorityState?: "TS" | "PREPARING" | "MODULE" | "DRAINING";
    /** Enable the authority sender's one-time durable-sequence adoption. */
    authority?: boolean;
    /** Set only after the module status/hello advertises state_sync_deltas. */
    stateSyncDeltas?: boolean;
    /** Share adoption state across every authority sync attempt in one transform pass. */
    authoritySeqAdoption?: {
        used: boolean;
    };
}
export interface ModuleCompartmentMirrorRow {
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episode_type?: string | null;
    legacy?: number | null;
    created_at?: number;
}
export interface ModuleCompartmentMirrorResponse {
    max_sequence: number;
    compartments: ModuleCompartmentMirrorRow[];
    /** Present on session.status; a count of 0 after a non-empty cursor is a set wipe. */
    compartment_count?: number;
    /** Incremented when the published set is rebuilt, recomputed, or restored. Those rewrites can replace existing rows without advancing max_sequence. */
    revert_epoch?: number;
    /** Optional flag that the published set was rewritten in place. Older responses omit it. */
    set_changed?: boolean;
}
/**
 * The module owns its SQLite file, so TS cannot read rows directly. This narrow
 * reader is the seam for the module's future `session.status` compartment page.
 * It deliberately returns typed rows instead of pretending the TS database is
 * authoritative for module-published content.
 */
export interface ModuleCompartmentReader {
    getCompartmentsAfter(sessionId: string, afterSequence: number): Promise<ModuleCompartmentMirrorResponse>;
}
export declare function clearCompartmentMirrorCursor(sessionId: string): void;
export declare function resetCompartmentMirrorCursorsForTest(): void;
export declare function mirrorModuleCompartments(args: {
    db: ContextDatabase;
    sessionId: string;
    reader: ModuleCompartmentReader;
}): Promise<number>;
interface ModuleWorkspaceContext {
    workspace: ModuleWorkspacePayload | null;
    expandedIdentities: string[];
    ownIdentities: string[];
    shareCategories: string[] | null;
}
export declare function loadModuleWatermarks(args: {
    db: ContextDatabase;
    sessionId: string;
    projectPath?: string;
    /** Reuse the workspace resolved by the enclosing payload build. */
    workspace?: ModuleWorkspaceContext;
}): ModuleWatermarks;
export declare function moduleWatermarksEqual(left: ModuleWatermarks | null, right: ModuleWatermarks): boolean;
/**
 * Compartment rows retain ordinals from the TS storage basis, which can include
 * synthetic summary rows. Resolve module boundaries from the summary-excluding
 * basis so the shared memo compares one canonical value everywhere.
 */
export declare function canonicalOrdinalForMessageId(args: {
    sessionId: string;
    raw: RawMessageParts | null;
    messageId: string;
    generation: number;
    state: ModuleStateSyncState;
}): number | null | "mismatch";
export declare function buildPagedModuleStateSyncPayloads(args: {
    moduleGeneration: number;
    expectedShadowSeq: number;
    seedId: string;
    seedBoundaryId: string | null;
    compartments: unknown[];
    dropSeeds?: ModuleDropSeed[];
    dropSeedSkipped?: number;
    pendingDropSeeds?: ModulePendingDropSeed[];
    pendingDropSkipped?: number;
    noteNudgeAnchors?: ModuleNoteNudgeAnchorSeed[];
    autoSearchHintSeeds?: ModuleAutoSearchHintSeed[];
    autoSearchHintSkipped?: number;
    todoSyntheticAnchor?: ModuleTodoSyntheticAnchorSeed | null;
    emergencyLatches?: ModuleEmergencyLatchSeed;
    pendingCompactionMarker?: ModulePendingCompactionMarkerSeed | null;
    deferredExecuteState?: ModuleDeferredExecuteSeed | null;
    channel2NudgeState?: string;
    stripSeeds?: ModuleStripSeed[];
    stripSeedSkipped?: number;
    reasoningClearedThroughTag?: number;
    userProfile: string[];
    workspace: ModuleWorkspacePayload | null;
    lastTodoState: string;
    watermarks: ModuleWatermarks;
}): ModuleStateSyncPayload[];
export declare function buildModuleStateSyncPayload(args: {
    state: ModuleStateSyncState;
    pass: ModuleStateSyncPass;
    force: boolean;
    options?: ModuleStateSyncOptions;
    seedId?: string;
}): Promise<ModuleStateSyncPayload | null | "m0_mutation" | "mismatch" | "unresolved" | "seed_budget" | "frame_budget">;
export declare const MODULE_CLAIM_MIRROR_CONSUMER = "rust-module-claim-mirror-v1";
export declare const MODULE_CLAIM_EFFECTS_CONSUMER = "rust-module-claims-v1";
export type ModuleClaimMirrorSyncResult = {
    status: "active";
    seeded: boolean;
    appliedReceipts: number;
} | {
    status: "unavailable";
} | {
    status: "suppressed";
    reason: string;
};
/** Return a snapshot only when its vector stays fixed while reading effect checkpoints. */
export declare function buildAuthorizedClaimMirrorSnapshot(args: {
    db: ContextDatabase;
    projectPath: string;
    nowMs?: number;
}): ClaimMirrorSnapshot | null;
export declare function syncModuleClaimMirror(args: {
    client: ModuleStateSyncClient;
    state: ModuleStateSyncState;
    pass: ModuleStateSyncPass;
    projectRoot: string;
}): Promise<ModuleClaimMirrorSyncResult>;
export interface ClaimOperationDurabilityProof {
    receiptId: number;
    requestDigest: string;
    resultJson: string;
    result: ClaimOperationResult;
    effects: ClaimEffectDeliveryReceipt["effects"];
}
export declare function proveClaimOperationDurable(args: {
    db: ContextDatabase;
    producer: string;
    operationKey: string;
    resultJson?: string;
}): ClaimOperationDurabilityProof;
export interface ClaimEffectPrefixDrainResult {
    deliveredReceipts: number;
    deliveredEffects: number;
    lastEffectId: number;
    reachedReceipt: boolean;
}
export declare function drainClaimEffectPrefix(args: {
    db: ContextDatabase;
    consumer: string;
    deliver: (receipt: ClaimEffectDeliveryReceipt) => Promise<{
        ackedEffectId: number;
    }>;
    throughReceiptId?: number;
    maxReceipts?: number;
}): Promise<ClaimEffectPrefixDrainResult>;
export interface ModuleStateSyncClient {
    /** Synchronously exposes capabilities cached for the transport's live connection generation. */
    getCachedStateSyncCapabilities?(): {
        state_sync_deltas?: boolean;
    } | undefined;
    /** Clears a capability snapshot when the module reports a restart-like signal. */
    invalidateStateSyncCapabilities?(): void;
    /** Capability probe is optional so older/test transports retain legacy wire semantics. */
    stateSyncCapabilities?(args: {
        sessionId: string;
        projectRoot: string;
    }): Promise<{
        state_sync_deltas?: boolean;
    }>;
    claimMirrorReplace?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimMirrorSnapshotRequest;
    }): Promise<ClaimMirrorSnapshotResponse>;
    claimMirrorApply?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimMirrorReceiptRequest;
    }): Promise<ClaimMirrorReceiptResponse>;
    call(args: {
        sessionId: string;
        projectRoot: string;
        method: "state_sync" | "transform" | "session.status" | "session.delete" | "session.flush" | "session.recomp" | "session.wrapup" | "todo_state.set" | "agent_drops.append" | "ctx_note" | "ctx_memory" | "note.evaluate" | "transform.ack" | "transform.nack";
        body: unknown;
        signal?: AbortSignal;
        generationSensitive?: boolean;
    }): Promise<unknown>;
}
/**
 * Mode-neutral state synchronization: the same watermark-triggered assembly is
 * used by the mirror sender and the Rust authority path. Callers own retries and
 * lineage handling because shadow and authority have different failure policy.
 */
export type ModuleStateSyncResult = {
    status: "acked";
    watermarks: ModuleWatermarks;
} | {
    status: "no_change";
} | {
    status: "retry_busy";
};
export declare function syncModuleState(args: {
    client: ModuleStateSyncClient;
    state: ModuleStateSyncState;
    pass: ModuleStateSyncPass;
    projectRoot: string;
    force: boolean;
    options?: ModuleStateSyncOptions;
}): Promise<ModuleStateSyncResult>;
export declare const __moduleStateSyncTest: {
    buildModuleStateSyncPayload: typeof buildModuleStateSyncPayload;
    buildPagedModuleStateSyncPayloads: typeof buildPagedModuleStateSyncPayloads;
    canonicalOrdinalForMessageId: typeof canonicalOrdinalForMessageId;
    loadModuleWatermarks: typeof loadModuleWatermarks;
    moduleWatermarksEqual: typeof moduleWatermarksEqual;
    syncModuleState: typeof syncModuleState;
};
export {};
//# sourceMappingURL=module-state-sync.d.ts.map