import { type SnapshotVector } from "../../features/magic-context/memory/claim-operation-contract";
import { type RawMessageOrdinalAnchor, type RawMessageParts } from "./read-session-raw";
import type { MessageLike } from "./transform-operations";
/** The maximum request page size accepted by the module facade. */
export declare const MODULE_PAGE_MAX_BYTES: number;
/** Large individual values are split so one message cannot exceed a page. */
export declare const MODULE_ITEM_CONTINUATION_CHUNK_BYTES: number;
export declare const MODULE_ITEM_CONTINUATION_KEY = "__shadow_item_continuation";
export declare const MODULE_ORDINAL_PAGE_SIZE = 500;
export declare const CLAIM_INTENT_PROTOCOL_VERSION = 1;
export declare const CLAIM_REQUEST_ENCODING_VERSION = 1;
export declare const CLAIM_MIRROR_PROTOCOL_VERSION = 1;
export declare const CLAIM_MIRROR_VERSION = 1;
export declare const CLAIM_PROVENANCE_LABEL_MAX_BYTES = 512;
export interface ClaimIntentBinding {
    databaseIncarnationId: string;
    formatEpoch: number;
    authorityProject: string;
    authorityGeneration: number;
}
export interface ClaimCommandIdentity {
    producer: string;
    operationKey: string;
}
export type ClaimIntentState = "staged" | "context-committed" | "acknowledged" | "terminal-rejected";
export interface ClaimIntentWireRecord {
    binding: ClaimIntentBinding;
    command: ClaimCommandIdentity;
    requestDigest: string;
    state: ClaimIntentState;
    resultJson: string | null;
}
export interface ClaimIntentStageRequest {
    protocolVersion: number;
    requestEncodingVersion: number;
    binding: ClaimIntentBinding;
    command: ClaimCommandIdentity;
    request: unknown;
}
export interface ClaimIntentInspectRequest {
    protocolVersion: number;
    command: ClaimCommandIdentity | null;
    unresolvedOnly: boolean;
    limit: number;
}
export interface ClaimIntentAckRequest {
    protocolVersion: number;
    binding: ClaimIntentBinding;
    command: ClaimCommandIdentity;
    requestDigest: string;
    kind: "context-committed" | "acknowledged" | "terminal-rejected";
    resultJson: string | null;
}
export interface ClaimIntentStageResponse {
    protocolVersion: number;
    replayed: boolean;
    intent: ClaimIntentWireRecord;
}
export interface ClaimIntentInspectResponse {
    protocolVersion: number;
    intents: ClaimIntentWireRecord[];
}
export interface ClaimIntentAckResponse {
    protocolVersion: number;
    replayed: boolean;
    intent: ClaimIntentWireRecord;
}
export interface ClaimEffectDeliveryEffect {
    id: number;
    effectKey: string;
    projectId: number;
    generation: number;
    changeKind: string;
    revisionLocator: string | null;
}
export interface ClaimEffectDeliveryReceipt {
    receiptId: number;
    producer: string;
    operationKey: string;
    requestDigest: string;
    resultJson: string;
    effects: ClaimEffectDeliveryEffect[];
}
export interface ClaimEffectDeliveryRequest {
    protocolVersion: number;
    consumer: string;
    receipt: ClaimEffectDeliveryReceipt;
}
export interface ClaimEffectDeliveryResponse {
    protocolVersion: number;
    ackedEffectId: number;
}
export type ClaimMirrorLifecycle = "active" | "archived" | "retired";
export type ClaimMirrorChangeKind = "upsert" | "evidence" | "lifecycle" | "applicability" | "verification" | "derivation";
/** Complete authorized provider row. Numeric storage identities never cross this wire. */
export interface CommittedClaimMirrorRow {
    publicClaimId: string;
    projectId: number;
    revisionLocator: string;
    content: string;
    contentDigest: string;
    attributes: Record<string, unknown>;
    lifecycle: ClaimMirrorLifecycle;
    applicability: Record<string, unknown>;
    policy: Record<string, unknown>;
    provenanceLabel: string | null;
    projectGeneration: number;
    policyGeneration: number;
}
export interface ClaimMirrorSnapshot {
    mirrorVersion: number;
    vector: SnapshotVector;
    projectCheckpoints: Record<string, number>;
    claims: CommittedClaimMirrorRow[];
}
export interface ClaimMirrorEffect {
    effectId: number;
    previousProjectEffectId: number;
    effectKey: string;
    projectId: number;
    generation: number;
    changeKind: ClaimMirrorChangeKind;
    publicClaimId: string;
    revisionLocator: string;
    claim: CommittedClaimMirrorRow | null;
}
export interface ClaimMirrorReceiptGroup {
    mirrorVersion: number;
    receiptId: number;
    expectedEffectCount: number;
    vector: SnapshotVector;
    effects: ClaimMirrorEffect[];
}
export interface ClaimMirrorSnapshotRequest {
    protocolVersion: number;
    snapshot: ClaimMirrorSnapshot;
}
export interface ClaimMirrorReceiptRequest {
    protocolVersion: number;
    receipt: ClaimMirrorReceiptGroup;
}
export interface ClaimMirrorSnapshotResponse {
    protocolVersion: number;
    mirrorVersion: number;
    databaseIncarnationId: string;
    projectCheckpoints: Record<string, number>;
}
export interface ClaimMirrorReceiptResponse {
    protocolVersion: number;
    mirrorVersion: number;
    receiptId: number;
    replayed: boolean;
    appliedEffectCount: number;
    ackedEffectId: number;
}
export interface ModuleFacadeWireBody<T> {
    name: string;
    arguments: T;
}
export declare function buildClaimIntentStageWireBody(request: ClaimIntentStageRequest): ModuleFacadeWireBody<ClaimIntentStageRequest>;
export declare function buildClaimIntentInspectWireBody(request: ClaimIntentInspectRequest): ModuleFacadeWireBody<ClaimIntentInspectRequest>;
export declare function buildClaimIntentAckWireBody(request: ClaimIntentAckRequest): ModuleFacadeWireBody<ClaimIntentAckRequest>;
export declare function buildClaimEffectDeliveryWireBody(request: ClaimEffectDeliveryRequest): ModuleFacadeWireBody<ClaimEffectDeliveryRequest>;
export declare function buildClaimMirrorSnapshotWireBody(request: ClaimMirrorSnapshotRequest): ModuleFacadeWireBody<ClaimMirrorSnapshotRequest>;
export declare function buildClaimMirrorReceiptWireBody(request: ClaimMirrorReceiptRequest): ModuleFacadeWireBody<ClaimMirrorReceiptRequest>;
export declare function decodeClaimIntentStageResponse(value: unknown, request: ClaimIntentStageRequest): ClaimIntentStageResponse;
export declare function decodeClaimIntentInspectResponse(value: unknown): ClaimIntentInspectResponse;
export declare function decodeClaimIntentAckResponse(value: unknown, request: ClaimIntentAckRequest): ClaimIntentAckResponse;
export declare function decodeClaimEffectDeliveryResponse(value: unknown, expectedEffectId: number): ClaimEffectDeliveryResponse;
export declare function decodeClaimMirrorSnapshotResponse(value: unknown, request: ClaimMirrorSnapshotRequest): ClaimMirrorSnapshotResponse;
export declare function decodeClaimMirrorReceiptResponse(value: unknown, request: ClaimMirrorReceiptRequest): ClaimMirrorReceiptResponse;
export interface ModuleNormalizationRecord {
    kind: "tag_prefix" | "ctx_search_hint" | "summary_message";
    message_id: string | null;
    part_index: number;
    field: string;
    tag_number?: number;
    removed: string;
}
/**
 * Resolve OpenCode message ids to the absolute ordinals used by the module.
 * The module and shadow lanes must see the same provisional suffix behavior, so
 * this is shared rather than reimplemented by the authority adapter.
 */
export declare function resolveOrdinalsForModule(args: {
    sessionId: string;
    messages: MessageLike[];
    generation: number;
    memoGeneration: number;
    memo: Map<string, number>;
    memoAnchor?: RawMessageOrdinalAnchor | null;
    memoStoredCount?: number | null;
    memoCanonicalCount?: number;
    /** Absolute ordinal immediately before a sliced unresolved tail. */
    provisionalBase?: number;
}): Promise<{
    ok: true;
    annotatedInput: unknown[];
    memoGeneration: number;
    memoAnchor: RawMessageOrdinalAnchor | null;
    memoStoredCount: number;
    memoCanonicalCount: number;
    normalizations: ModuleNormalizationRecord[];
} | {
    ok: false;
    reason: "unresolved" | "mismatch";
    messageId?: string;
    messageIndex?: number;
    messageRole?: string;
}>;
/** Flatten the typed builder shape to the module's top-level wire envelope. */
export declare function toFlatModuleWireBody(payload: {
    method: string;
    params: Record<string, unknown>;
}): Record<string, unknown>;
export declare function moduleWireBodyBytes(payload: {
    method: string;
    params: Record<string, unknown>;
}): number;
/**
 * Page a transform request without changing any message value. Continuation
 * markers are understood by the module and are only used when a single item is
 * larger than the normal page envelope.
 */
export interface ModuleTransformWirePage {
    page: Record<string, unknown>;
    /** UTF-8 byte length of `JSON.stringify(page)`, counted while paging. */
    bytes: number;
}
export declare function buildPagedModuleTransformPayloads(body: Record<string, unknown>): ModuleTransformWirePage[];
export interface ModuleRawBlockMapping {
    blockIndex: number;
    partIndex: number;
    kind: "text" | "reasoning" | "file" | "tool_call" | "tool_result" | "other";
    callId?: string;
    toolInput?: unknown;
}
/**
 * Map raw OpenCode parts to the CK block indexes used by the Rust module. The
 * drop seed must name the same block the module would reduce; counting raw
 * parts is not enough because ignored parts disappear and completed tools
 * become a call/result pair.
 */
export declare function moduleRawBlockMappings(message: RawMessageParts | null): ModuleRawBlockMapping[];
export declare const __moduleWireTest: {
    buildPagedModuleTransformPayloads: typeof buildPagedModuleTransformPayloads;
    encodeOpenCodeMessagesToCk: typeof encodeOpenCodeMessagesToCk;
    moduleRawBlockMappings: typeof moduleRawBlockMappings;
    moduleWireBodyBytes: typeof moduleWireBodyBytes;
    resolveOrdinalsForModule: typeof resolveOrdinalsForModule;
    toFlatModuleWireBody: typeof toFlatModuleWireBody;
};
export declare function encodeOpenCodeMessagesToCk(messages: unknown[]): Array<{
    mid: string;
    ordinal: number;
    ck: Record<string, unknown>;
}>;
//# sourceMappingURL=module-wire.d.ts.map