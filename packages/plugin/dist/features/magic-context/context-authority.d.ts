import type { ClaimEffectDeliveryRequest, ClaimEffectDeliveryResponse, ClaimIntentAckRequest, ClaimIntentAckResponse, ClaimIntentInspectRequest, ClaimIntentInspectResponse, ClaimIntentStageRequest, ClaimIntentStageResponse } from "../../hooks/magic-context/module-wire";
import type { Database } from "../../shared/sqlite";
export declare const AUTHORITY_DOMAINS: readonly ["memories", "notes"];
export type AuthorityDomain = (typeof AUTHORITY_DOMAINS)[number];
export type AuthorityState = "TS" | "PREPARING" | "MODULE" | "DRAINING";
export interface AuthorityStatus {
    context_store_uuid: string;
    project: string;
    domain: AuthorityDomain;
    state: AuthorityState;
    generation: number;
    captured_upper_bound?: number | null;
    drain_cursor?: number;
    step_seed?: boolean;
    step_memories?: boolean;
    step_notes?: boolean;
    step_compartments?: boolean;
    step_reconcile?: boolean;
    step_verify?: boolean;
    step_flip?: boolean;
    coordinator_lease?: string | null;
    lease_expires_at?: number | null;
    /** Attempt-unique drain coordinator token minted at begin/takeover. */
    coordinator_token?: string | null;
    checksum_expected?: string | null;
    checksum_actual?: string | null;
    checksum_ok?: number | boolean | null;
}
export interface AuthorityDrainContended {
    code: "authority_drain_contended";
    retryable: true;
    state: "DRAINING";
    attempts: number;
    authority: AuthorityStatus | null;
}
export type AuthorityDrainResult = AuthorityStatus | AuthorityDrainContended;
export interface AuthorityDrainResponse {
    authority?: AuthorityStatus;
    code?: string;
    retryable?: boolean;
}
export interface AuthorityModuleClient {
    authorityStatus(args: {
        context_store_uuid: string;
        project: string;
        projectRoot?: string;
        domain: AuthorityDomain;
    }): Promise<{
        authority: AuthorityStatus | null;
    }>;
    authorityPrepare(args: Record<string, unknown>): Promise<{
        authority: AuthorityStatus;
    }>;
    authorityDrain?(args: Record<string, unknown>): Promise<AuthorityDrainResponse>;
    authoritySeed?(args: Record<string, unknown>): Promise<{
        seeded: number;
        module_row_ids?: number[];
    }>;
    mirrorPull?(args: {
        domain: AuthorityDomain;
        cursor: number;
        limit: number;
        live_only?: boolean;
        projectRoot?: string;
    }): Promise<{
        page: ChangefeedPage;
    }>;
    claimIntentStage?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentStageRequest;
    }): Promise<ClaimIntentStageResponse>;
    claimIntentInspect?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentInspectRequest;
    }): Promise<ClaimIntentInspectResponse>;
    claimIntentAck?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentAckRequest;
    }): Promise<ClaimIntentAckResponse>;
    claimEffectsApply?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimEffectDeliveryRequest;
    }): Promise<ClaimEffectDeliveryResponse>;
}
export interface ContextClaimCommit {
    response: string;
    producer: string;
    operationKey: string;
    requestDigest: string;
    resultJson: string;
}
export declare function commitModuleClaimIntent(args: {
    client: Required<Pick<AuthorityModuleClient, "claimIntentStage" | "claimIntentInspect" | "claimIntentAck">>;
    sessionId: string;
    projectRoot: string;
    request: ClaimIntentStageRequest;
    commitContext: () => ContextClaimCommit;
    settleContext: (commit: ContextClaimCommit) => Promise<void>;
}): Promise<string>;
import type { DrainResult } from "./smart-notes/evaluator-worker";
export interface ModuleNoteEvaluationBridge {
    sync(): Promise<void>;
    drain(args: {
        deadline: number;
        signal?: AbortSignal;
        /** Ask the authority for sandbox-only phases (due, liveness). */
        excludeBillable?: boolean;
        /** Client-side bound on billable claims; absent = legacy per-run cap. */
        maxCompilePerRun?: number;
        maxFallbackPerRun?: number;
    }): Promise<DrainResult>;
    available(): boolean;
    /** Retry a failed or premature evaluator registration; no-op when live. */
    ensureRegistered?(): Promise<void>;
    dispose(): Promise<void>;
}
/**
 * Composite registry key. Worktrees of one repository share a project
 * identity but bind different checkout roots, and each root's bridge closes
 * over its own transport route and filesystem capabilities, so identity alone
 * cannot address a bridge. NUL cannot appear in a filesystem path.
 */
export declare function moduleNoteEvaluationBridgeKey(projectPath: string, projectRoot: string): string;
/** Registers the bridge (one owner) and returns its registry key for later disposal. */
export declare function registerModuleNoteEvaluationBridge(projectPath: string, projectRoot: string, bridge: ModuleNoteEvaluationBridge): string;
/**
 * Record another owner of an already-registered exact bridge and return its
 * registry key, or undefined when no such bridge exists. A second plugin
 * instance serving the same (identity, root) must retain rather than skip:
 * otherwise the first instance's disposal tears down the only registry entry
 * while the second instance still routes conditioned writes through it.
 */
export declare function retainModuleNoteEvaluationBridge(projectPath: string, projectRoot: string): string | undefined;
/**
 * With `projectRoot`: the bridge bound to that exact checkout. Without it: any
 * bridge for the identity, for identity-scoped questions such as "does a live
 * evaluator exist" or "does the module own drains for this project".
 */
export declare function getModuleNoteEvaluationBridge(projectPath: string, projectRoot?: string): ModuleNoteEvaluationBridge | undefined;
/**
 * Bridge lookup for drain paths: exact (identity, root) first — worktrees of
 * one repository share an identity, and each bridge's filesystem capabilities
 * bind to one checkout — then any bridge for the identity, because an
 * undrained module queue is the worse failure: pending notes would sit
 * forever in a process whose exact-root bridge never registered. Claims carry
 * no originating root, so the cross-root exposure already exists in claim
 * selection itself; root-fenced selection is tracked as magic-context-c0c and
 * must land here, once, for every drain caller.
 */
export declare function findModuleNoteEvaluationBridgeForDrain(projectPath: string, projectRoot: string | undefined): ModuleNoteEvaluationBridge | undefined;
/**
 * Release the named owners' claims (registry keys returned by register or
 * retain). The registry is process-global while plugin instances are disposed
 * individually, so an instance passes the keys it owns; a bridge is removed
 * and disposed only when its last owner releases it, and sibling instances'
 * bridges stay live.
 */
export declare function disposeModuleNoteEvaluationBridges(bridgeKeys: Iterable<string>): Promise<void>;
export interface ChangefeedRow {
    feed_seq: number;
    domain: AuthorityDomain;
    op: "insert" | "update" | "tombstone";
    module_row_id: number;
    full_row_snapshot: Record<string, unknown>;
    content_hash: string | null;
}
export interface ChangefeedPage {
    domain: AuthorityDomain;
    cursor: number;
    next_cursor: number;
    has_more: boolean;
    rows: ChangefeedRow[];
}
export declare function getContextStoreUuid(db: Database): string | null;
/** Mint the store identity once. Restoring a database restores this value too,
 * which is what lets the module recognize a regressed marker. */
export declare function ensureContextStoreUuid(db: Database): string;
/**
 * Serialize mirror pulls for one (database, domain) across every caller in
 * the process. Each pull reads the durable cursor before requesting a page,
 * so two concurrent pulls request the same page and the loser throws a
 * cursor mismatch in {@link applyMirrorPage}. Instance-local chains are not
 * enough: several plugin instances can share one database file (the shared
 * evaluator bridge holds one instance's sync while another instance's tool
 * backend syncs the same domain), so the chain is keyed by the store uuid.
 */
export declare function chainMirrorDomainSync(db: Database, domain: "memories" | "notes", run: () => Promise<void>): Promise<void>;
export interface AuthorityManagedMarker {
    project_path: string;
    context_store_uuid: string;
    marked_at: number;
}
export declare function getAuthorityManagedMarker(db: Database, projectPath: string): AuthorityManagedMarker | null;
export declare function listAuthorityManagedMarkers(db: Database): AuthorityManagedMarker[];
export declare function installAuthorityManagedMarker(db: Database, projectPath: string, contextStoreUuid?: string): void;
export declare function removeAuthorityManagedMarker(db: Database, projectPath: string): void;
/**
 * Repair a marker lost by restoring an older context.db snapshot. The write barrier
 * makes the repair atomic with the marker installation; callers keep application
 * writes closed until this function resolves.
 */
export declare function reconcileAuthorityMarker(args: {
    db: Database;
    projectPath: string;
    module: AuthorityModuleClient;
}): Promise<{
    status: "legacy" | "ok" | "repaired";
    authority: AuthorityStatus | null;
}>;
export declare function reconcileAuthorityProject(args: {
    db: Database;
    projectPath: string;
    module: AuthorityModuleClient;
}): Promise<void>;
export interface PrepareAuthorityArgs {
    db: Database;
    projectPath: string;
    domains?: readonly AuthorityDomain[];
    module: AuthorityModuleClient;
    seedPages: (domain: AuthorityDomain) => Promise<readonly Record<string, unknown>[]>;
    /** Test seam for alternate canonical encoders. Production uses the shared row digest. */
    checksum?: (domain: AuthorityDomain, rows: readonly Record<string, unknown>[]) => string;
}
export declare function checksumAuthoritySeedRows(rows: readonly Record<string, unknown>[]): string;
/** Read the transactionally maintained domain mutation epoch (0 when never bumped). */
export declare function readDomainMutationEpoch(db: Database, projectPath: string, domain: AuthorityDomain): number;
/**
 * Bump the domain mutation epoch inside the current privileged write transaction.
 * Same-connection privileged UPDATEs do not advance PRAGMA data_version; this epoch
 * is the capture bound that detects those writes.
 */
export declare function bumpDomainMutationEpoch(db: Database, projectPath: string, domain: AuthorityDomain): void;
export declare function prepareAuthority(args: PrepareAuthorityArgs): Promise<AuthorityStatus[]>;
export declare function drainAuthority(args: {
    db: Database;
    projectPath: string;
    domain: AuthorityDomain;
    module: AuthorityModuleClient;
    checksum: string | (() => string);
    limit?: number;
}): Promise<AuthorityDrainResult>;
export declare function getMirrorCursor(db: Database, domain: AuthorityDomain): number;
export declare function applyMirrorPage(args: {
    db: Database;
    page: ChangefeedPage;
}): number;
//# sourceMappingURL=context-authority.d.ts.map