import * as crypto from "node:crypto";
import {
    computeClaimOperationRequestDigest,
    parseRevisionLocator,
    type SnapshotVector,
    sha256HexUtf8,
} from "../../features/magic-context/memory/claim-operation-contract";
import {
    getRawSessionStoredMessageCount,
    readRawSessionMessageOrdinalPage,
} from "./read-session-chunk";
import {
    isRawCompactionSummaryInfo,
    type RawMessageOrdinalAnchor,
    type RawMessageParts,
} from "./read-session-raw";
import type { MessageLike } from "./transform-operations";

/** The maximum request page size accepted by the module facade. */
export const MODULE_PAGE_MAX_BYTES = 512 * 1024;
/** Large individual values are split so one message cannot exceed a page. */
export const MODULE_ITEM_CONTINUATION_CHUNK_BYTES = 64 * 1024;
// The module-side reassembler recognizes this continuation envelope for
// authority state sync and live transform requests.
export const MODULE_ITEM_CONTINUATION_KEY = "__shadow_item_continuation";
export const MODULE_ORDINAL_PAGE_SIZE = 500;
export const CLAIM_INTENT_PROTOCOL_VERSION = 1;
export const CLAIM_REQUEST_ENCODING_VERSION = 1;
export const CLAIM_MIRROR_PROTOCOL_VERSION = 1;
export const CLAIM_MIRROR_VERSION = 1;
// Byte bound shared with the module's `validate_claim` (`claim_mirror.rs`).
// Both sides must measure the same unit or a label can pass here and be
// rejected there, which suppresses the mirror lane.
export const CLAIM_PROVENANCE_LABEL_MAX_BYTES = 512;

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

export type ClaimIntentState =
    | "staged"
    | "context-committed"
    | "acknowledged"
    | "terminal-rejected";

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
export type ClaimMirrorChangeKind =
    | "upsert"
    | "evidence"
    | "lifecycle"
    | "applicability"
    | "verification"
    | "derivation";

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

function wireRecord(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function wireExactKeys(
    record: Record<string, unknown>,
    keys: readonly string[],
    label: string,
): void {
    const expected = new Set(keys);
    const unknown = Object.keys(record).find((key) => !expected.has(key));
    if (unknown) throw new Error(`${label}.${unknown} is unsupported`);
}

function wireString(record: Record<string, unknown>, key: string, label: string): string {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label}.${key} must be a non-empty string`);
    }
    return value;
}

function wireSafeInteger(
    record: Record<string, unknown>,
    key: string,
    label: string,
    minimum = 0,
): number {
    const value = record[key];
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`${label}.${key} must be a safe integer >= ${minimum}`);
    }
    return value as number;
}

function wireIntegerRecord(value: unknown, label: string, minimum = 0): Record<string, number> {
    const record = wireRecord(value, label);
    const decoded: Record<string, number> = {};
    for (const [key, entry] of Object.entries(record)) {
        if (
            !/^[1-9]\d*$/.test(key) ||
            !Number.isSafeInteger(entry) ||
            (entry as number) < minimum
        ) {
            throw new Error(`${label}.${key} must be a safe integer >= ${minimum}`);
        }
        decoded[key] = entry as number;
    }
    return decoded;
}

function validateClaimMirrorVector(value: unknown, label: string): SnapshotVector {
    const record = wireRecord(value, label);
    wireExactKeys(
        record,
        [
            "vectorVersion",
            "databaseIncarnationId",
            "workspaceEpoch",
            "projectGenerations",
            "policyGenerations",
        ],
        label,
    );
    if (record.vectorVersion !== 1) throw new Error(`${label}.vectorVersion is unsupported`);
    const databaseIncarnationId = wireString(record, "databaseIncarnationId", label);
    if (!/^[0-9a-f]{32}$/.test(databaseIncarnationId)) {
        throw new Error(`${label}.databaseIncarnationId must be 32 lowercase hex characters`);
    }
    const workspaceEpoch = wireString(record, "workspaceEpoch", label);
    const projectGenerations = wireIntegerRecord(
        record.projectGenerations,
        `${label}.projectGenerations`,
    );
    const policyGenerations = wireIntegerRecord(
        record.policyGenerations,
        `${label}.policyGenerations`,
    );
    if (Object.keys(projectGenerations).join("\0") !== Object.keys(policyGenerations).join("\0")) {
        throw new Error(`${label} generation vectors must name the same projects in order`);
    }
    return {
        vectorVersion: 1,
        databaseIncarnationId,
        workspaceEpoch,
        projectGenerations,
        policyGenerations,
    };
}

function validateCommittedClaimMirrorRow(
    value: unknown,
    vector: SnapshotVector,
    label: string,
): CommittedClaimMirrorRow {
    const record = wireRecord(value, label);
    wireExactKeys(
        record,
        [
            "publicClaimId",
            "projectId",
            "revisionLocator",
            "content",
            "contentDigest",
            "attributes",
            "lifecycle",
            "applicability",
            "policy",
            "provenanceLabel",
            "projectGeneration",
            "policyGeneration",
        ],
        label,
    );
    const publicClaimId = wireString(record, "publicClaimId", label);
    const projectId = wireSafeInteger(record, "projectId", label, 1);
    const revisionLocator = wireString(record, "revisionLocator", label);
    const locator = parseRevisionLocator(revisionLocator);
    const content = typeof record.content === "string" ? record.content : null;
    const contentDigest = wireString(record, "contentDigest", label);
    if (
        !locator ||
        locator.publicClaimId !== publicClaimId ||
        locator.contentDigest !== contentDigest ||
        content === null ||
        sha256HexUtf8(content) !== contentDigest
    ) {
        throw new Error(`${label} revision identity or content digest is invalid`);
    }
    const lifecycle = record.lifecycle;
    if (lifecycle !== "active" && lifecycle !== "archived" && lifecycle !== "retired") {
        throw new Error(`${label}.lifecycle is unsupported`);
    }
    const projectGeneration = wireSafeInteger(record, "projectGeneration", label);
    const policyGeneration = wireSafeInteger(record, "policyGeneration", label);
    if (
        vector.projectGenerations[String(projectId)] !== projectGeneration ||
        vector.policyGenerations[String(projectId)] !== policyGeneration
    ) {
        throw new Error(`${label} generation does not match vector`);
    }
    const provenanceLabel = record.provenanceLabel;
    // The module validates this bound in BYTES (`claim_mirror.rs` uses `str::len`).
    // Measuring UTF-16 code units here would admit a label the module then rejects,
    // which suppresses the whole mirror lane for the workspace.
    if (
        provenanceLabel !== null &&
        (typeof provenanceLabel !== "string" ||
            provenanceLabel.length === 0 ||
            Buffer.byteLength(provenanceLabel, "utf8") > CLAIM_PROVENANCE_LABEL_MAX_BYTES)
    ) {
        throw new Error(
            `${label}.provenanceLabel must be null or contain 1..=${CLAIM_PROVENANCE_LABEL_MAX_BYTES} bytes`,
        );
    }
    return {
        publicClaimId,
        projectId,
        revisionLocator,
        content,
        contentDigest,
        attributes: wireRecord(record.attributes, `${label}.attributes`),
        lifecycle,
        applicability: wireRecord(record.applicability, `${label}.applicability`),
        policy: wireRecord(record.policy, `${label}.policy`),
        provenanceLabel,
        projectGeneration,
        policyGeneration,
    };
}

function validateClaimMirrorSnapshot(value: unknown): ClaimMirrorSnapshot {
    const record = wireRecord(value, "claim mirror snapshot");
    wireExactKeys(
        record,
        ["mirrorVersion", "vector", "projectCheckpoints", "claims"],
        "claim mirror snapshot",
    );
    if (record.mirrorVersion !== CLAIM_MIRROR_VERSION) {
        throw new Error("claim mirror snapshot.mirrorVersion is unsupported");
    }
    const vector = validateClaimMirrorVector(record.vector, "claim mirror snapshot.vector");
    const projectCheckpoints = wireIntegerRecord(
        record.projectCheckpoints,
        "claim mirror snapshot.projectCheckpoints",
    );
    if (
        Object.keys(projectCheckpoints).join("\0") !==
        Object.keys(vector.projectGenerations).join("\0")
    ) {
        throw new Error(
            "claim mirror snapshot checkpoints must name every vector project in order",
        );
    }
    if (!Array.isArray(record.claims))
        throw new Error("claim mirror snapshot.claims must be an array");
    const claims = record.claims.map((claim, index) =>
        validateCommittedClaimMirrorRow(claim, vector, `claim mirror snapshot.claims[${index}]`),
    );
    if (new Set(claims.map((claim) => claim.publicClaimId)).size !== claims.length) {
        throw new Error("claim mirror snapshot repeats a public claim ID");
    }
    return { mirrorVersion: CLAIM_MIRROR_VERSION, vector, projectCheckpoints, claims };
}

function validateClaimMirrorReceipt(value: unknown): ClaimMirrorReceiptGroup {
    const record = wireRecord(value, "claim mirror receipt");
    wireExactKeys(
        record,
        ["mirrorVersion", "receiptId", "expectedEffectCount", "vector", "effects"],
        "claim mirror receipt",
    );
    if (record.mirrorVersion !== CLAIM_MIRROR_VERSION) {
        throw new Error("claim mirror receipt.mirrorVersion is unsupported");
    }
    const receiptId = wireSafeInteger(record, "receiptId", "claim mirror receipt", 1);
    const expectedEffectCount = wireSafeInteger(
        record,
        "expectedEffectCount",
        "claim mirror receipt",
        1,
    );
    const vector = validateClaimMirrorVector(record.vector, "claim mirror receipt.vector");
    if (!Array.isArray(record.effects) || record.effects.length !== expectedEffectCount) {
        throw new Error("claim mirror receipt effect group is incomplete");
    }
    const effects = record.effects.map((value, index): ClaimMirrorEffect => {
        const label = `claim mirror receipt.effects[${index}]`;
        const effect = wireRecord(value, label);
        wireExactKeys(
            effect,
            [
                "effectId",
                "previousProjectEffectId",
                "effectKey",
                "projectId",
                "generation",
                "changeKind",
                "publicClaimId",
                "revisionLocator",
                "claim",
            ],
            label,
        );
        const effectId = wireSafeInteger(
            effect,
            "effectId",
            `claim mirror receipt.effects[${index}]`,
            1,
        );
        const previousProjectEffectId = wireSafeInteger(
            effect,
            "previousProjectEffectId",
            `claim mirror receipt.effects[${index}]`,
        );
        const projectId = wireSafeInteger(
            effect,
            "projectId",
            `claim mirror receipt.effects[${index}]`,
            1,
        );
        const generation = wireSafeInteger(
            effect,
            "generation",
            `claim mirror receipt.effects[${index}]`,
            1,
        );
        const changeKind = effect.changeKind;
        if (
            changeKind !== "upsert" &&
            changeKind !== "evidence" &&
            changeKind !== "lifecycle" &&
            changeKind !== "applicability" &&
            changeKind !== "verification" &&
            changeKind !== "derivation"
        ) {
            throw new Error(`claim mirror receipt.effects[${index}].changeKind is unsupported`);
        }
        const publicClaimId = wireString(
            effect,
            "publicClaimId",
            `claim mirror receipt.effects[${index}]`,
        );
        const revisionLocator = wireString(
            effect,
            "revisionLocator",
            `claim mirror receipt.effects[${index}]`,
        );
        const locator = parseRevisionLocator(revisionLocator);
        if (
            !locator ||
            locator.publicClaimId !== publicClaimId ||
            vector.projectGenerations[String(projectId)] !== generation
        ) {
            throw new Error(
                `claim mirror receipt.effects[${index}] identity or generation is invalid`,
            );
        }
        return {
            effectId,
            previousProjectEffectId,
            effectKey: wireString(effect, "effectKey", `claim mirror receipt.effects[${index}]`),
            projectId,
            generation,
            changeKind,
            publicClaimId,
            revisionLocator,
            claim:
                effect.claim === null
                    ? null
                    : validateCommittedClaimMirrorRow(
                          effect.claim,
                          vector,
                          `claim mirror receipt.effects[${index}].claim`,
                      ),
        };
    });
    const firstEffectId = effects[0]?.effectId ?? 0;
    for (let index = 0; index < effects.length; index += 1) {
        if (effects[index]?.effectId !== firstEffectId + index) {
            throw new Error("claim mirror receipt effects must have contiguous IDs");
        }
    }
    return {
        mirrorVersion: CLAIM_MIRROR_VERSION,
        receiptId,
        expectedEffectCount,
        vector,
        effects,
    };
}

function decodeClaimIntentBinding(value: unknown): ClaimIntentBinding {
    const record = wireRecord(value, "claim intent binding");
    return {
        databaseIncarnationId: wireString(record, "databaseIncarnationId", "binding"),
        formatEpoch: wireSafeInteger(record, "formatEpoch", "binding", 1),
        authorityProject: wireString(record, "authorityProject", "binding"),
        authorityGeneration: wireSafeInteger(record, "authorityGeneration", "binding", 0),
    };
}

function decodeClaimCommandIdentity(value: unknown): ClaimCommandIdentity {
    const record = wireRecord(value, "claim command identity");
    return {
        producer: wireString(record, "producer", "command"),
        operationKey: wireString(record, "operationKey", "command"),
    };
}

function decodeClaimIntentWireRecord(value: unknown): ClaimIntentWireRecord {
    const record = wireRecord(value, "claim intent");
    const state = record.state;
    if (
        state !== "staged" &&
        state !== "context-committed" &&
        state !== "acknowledged" &&
        state !== "terminal-rejected"
    ) {
        throw new Error("claim intent.state is unsupported");
    }
    const requestDigest = wireString(record, "requestDigest", "claim intent");
    if (!/^[0-9a-f]{64}$/.test(requestDigest)) {
        throw new Error("claim intent.requestDigest must be lowercase SHA-256");
    }
    const resultJson = record.resultJson;
    if (resultJson !== null && typeof resultJson !== "string") {
        throw new Error("claim intent.resultJson must be a string or null");
    }
    return {
        binding: decodeClaimIntentBinding(record.binding),
        command: decodeClaimCommandIdentity(record.command),
        requestDigest,
        state,
        resultJson,
    };
}

function requireIntentProtocol(record: Record<string, unknown>, label: string): void {
    if (record.protocolVersion !== CLAIM_INTENT_PROTOCOL_VERSION) {
        throw new Error(`${label}.protocolVersion is unsupported`);
    }
}

export function buildClaimIntentStageWireBody(
    request: ClaimIntentStageRequest,
): ModuleFacadeWireBody<ClaimIntentStageRequest> {
    return { name: "claim.intent.stage", arguments: request };
}

export function buildClaimIntentInspectWireBody(
    request: ClaimIntentInspectRequest,
): ModuleFacadeWireBody<ClaimIntentInspectRequest> {
    return { name: "claim.intent.inspect", arguments: request };
}

export function buildClaimIntentAckWireBody(
    request: ClaimIntentAckRequest,
): ModuleFacadeWireBody<ClaimIntentAckRequest> {
    return { name: "claim.intent.ack", arguments: request };
}

export function buildClaimEffectDeliveryWireBody(
    request: ClaimEffectDeliveryRequest,
): ModuleFacadeWireBody<ClaimEffectDeliveryRequest> {
    return { name: "claim.effects.apply", arguments: request };
}

export function buildClaimMirrorSnapshotWireBody(
    request: ClaimMirrorSnapshotRequest,
): ModuleFacadeWireBody<ClaimMirrorSnapshotRequest> {
    if (request.protocolVersion !== CLAIM_MIRROR_PROTOCOL_VERSION) {
        throw new Error("claim mirror snapshot request.protocolVersion is unsupported");
    }
    validateClaimMirrorSnapshot(request.snapshot);
    return { name: "claim.mirror.replace", arguments: request };
}

export function buildClaimMirrorReceiptWireBody(
    request: ClaimMirrorReceiptRequest,
): ModuleFacadeWireBody<ClaimMirrorReceiptRequest> {
    if (request.protocolVersion !== CLAIM_MIRROR_PROTOCOL_VERSION) {
        throw new Error("claim mirror receipt request.protocolVersion is unsupported");
    }
    validateClaimMirrorReceipt(request.receipt);
    return { name: "claim.mirror.apply", arguments: request };
}

export function decodeClaimIntentStageResponse(
    value: unknown,
    request: ClaimIntentStageRequest,
): ClaimIntentStageResponse {
    const record = wireRecord(value, "claim intent stage response");
    requireIntentProtocol(record, "claim intent stage response");
    if (typeof record.replayed !== "boolean") {
        throw new Error("claim intent stage response.replayed must be boolean");
    }
    const intent = decodeClaimIntentWireRecord(record.intent);
    const expectedDigest = computeClaimOperationRequestDigest(request.request);
    if (intent.requestDigest !== expectedDigest) {
        throw new Error("claim intent stage response request digest mismatch");
    }
    if (
        intent.command.producer !== request.command.producer ||
        intent.command.operationKey !== request.command.operationKey
    ) {
        throw new Error("claim intent stage response command mismatch");
    }
    if (
        intent.binding.databaseIncarnationId !== request.binding.databaseIncarnationId ||
        intent.binding.formatEpoch !== request.binding.formatEpoch ||
        intent.binding.authorityProject !== request.binding.authorityProject ||
        intent.binding.authorityGeneration !== request.binding.authorityGeneration
    ) {
        throw new Error("claim intent stage response binding mismatch");
    }
    return {
        protocolVersion: CLAIM_INTENT_PROTOCOL_VERSION,
        replayed: record.replayed,
        intent,
    };
}

export function decodeClaimIntentInspectResponse(value: unknown): ClaimIntentInspectResponse {
    const record = wireRecord(value, "claim intent inspect response");
    requireIntentProtocol(record, "claim intent inspect response");
    if (!Array.isArray(record.intents)) {
        throw new Error("claim intent inspect response.intents must be an array");
    }
    return {
        protocolVersion: CLAIM_INTENT_PROTOCOL_VERSION,
        intents: record.intents.map(decodeClaimIntentWireRecord),
    };
}

export function decodeClaimIntentAckResponse(
    value: unknown,
    request: ClaimIntentAckRequest,
): ClaimIntentAckResponse {
    const record = wireRecord(value, "claim intent ack response");
    requireIntentProtocol(record, "claim intent ack response");
    if (typeof record.replayed !== "boolean") {
        throw new Error("claim intent ack response.replayed must be boolean");
    }
    const intent = decodeClaimIntentWireRecord(record.intent);
    if (
        intent.command.producer !== request.command.producer ||
        intent.command.operationKey !== request.command.operationKey ||
        intent.requestDigest !== request.requestDigest
    ) {
        throw new Error("claim intent ack response identity mismatch");
    }
    return {
        protocolVersion: CLAIM_INTENT_PROTOCOL_VERSION,
        replayed: record.replayed,
        intent,
    };
}

export function decodeClaimEffectDeliveryResponse(
    value: unknown,
    expectedEffectId: number,
): ClaimEffectDeliveryResponse {
    const record = wireRecord(value, "claim effect delivery response");
    requireIntentProtocol(record, "claim effect delivery response");
    const ackedEffectId = wireSafeInteger(
        record,
        "ackedEffectId",
        "claim effect delivery response",
        1,
    );
    if (ackedEffectId !== expectedEffectId) {
        throw new Error(
            `claim effect delivery response skipped checkpoint ${expectedEffectId} -> ${ackedEffectId}`,
        );
    }
    return { protocolVersion: CLAIM_INTENT_PROTOCOL_VERSION, ackedEffectId };
}

function requireClaimMirrorResponseVersion(record: Record<string, unknown>, label: string): void {
    if (record.protocolVersion !== CLAIM_MIRROR_PROTOCOL_VERSION) {
        throw new Error(`${label}.protocolVersion is unsupported`);
    }
    if (record.mirrorVersion !== CLAIM_MIRROR_VERSION) {
        throw new Error(`${label}.mirrorVersion is unsupported`);
    }
}

export function decodeClaimMirrorSnapshotResponse(
    value: unknown,
    request: ClaimMirrorSnapshotRequest,
): ClaimMirrorSnapshotResponse {
    const snapshot = validateClaimMirrorSnapshot(request.snapshot);
    const record = wireRecord(value, "claim mirror snapshot response");
    requireClaimMirrorResponseVersion(record, "claim mirror snapshot response");
    const databaseIncarnationId = wireString(
        record,
        "databaseIncarnationId",
        "claim mirror snapshot response",
    );
    const projectCheckpoints = wireIntegerRecord(
        record.projectCheckpoints,
        "claim mirror snapshot response.projectCheckpoints",
    );
    if (
        databaseIncarnationId !== snapshot.vector.databaseIncarnationId ||
        JSON.stringify(projectCheckpoints) !== JSON.stringify(snapshot.projectCheckpoints)
    ) {
        throw new Error("claim mirror snapshot response acknowledgement mismatch");
    }
    return {
        protocolVersion: CLAIM_MIRROR_PROTOCOL_VERSION,
        mirrorVersion: CLAIM_MIRROR_VERSION,
        databaseIncarnationId,
        projectCheckpoints,
    };
}

export function decodeClaimMirrorReceiptResponse(
    value: unknown,
    request: ClaimMirrorReceiptRequest,
): ClaimMirrorReceiptResponse {
    const receipt = validateClaimMirrorReceipt(request.receipt);
    const record = wireRecord(value, "claim mirror receipt response");
    requireClaimMirrorResponseVersion(record, "claim mirror receipt response");
    const receiptId = wireSafeInteger(record, "receiptId", "claim mirror receipt response", 1);
    if (receiptId !== receipt.receiptId || typeof record.replayed !== "boolean") {
        throw new Error("claim mirror receipt response identity is invalid");
    }
    const appliedEffectCount = wireSafeInteger(
        record,
        "appliedEffectCount",
        "claim mirror receipt response",
    );
    const ackedEffectId = wireSafeInteger(
        record,
        "ackedEffectId",
        "claim mirror receipt response",
        1,
    );
    const expectedEffectId = receipt.effects.at(-1)?.effectId;
    const expectedApplied = record.replayed ? 0 : receipt.effects.length;
    if (ackedEffectId !== expectedEffectId || appliedEffectCount !== expectedApplied) {
        throw new Error("claim mirror receipt response acknowledgement mismatch");
    }
    return {
        protocolVersion: CLAIM_MIRROR_PROTOCOL_VERSION,
        mirrorVersion: CLAIM_MIRROR_VERSION,
        receiptId,
        replayed: record.replayed,
        appliedEffectCount,
        ackedEffectId,
    };
}

export interface ModuleNormalizationRecord {
    kind: "tag_prefix" | "ctx_search_hint" | "summary_message";
    message_id: string | null;
    part_index: number;
    field: string;
    tag_number?: number;
    removed: string;
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
            .join(",")}}`;
    }
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
}

function transformPageDigest(arrays: Record<string, unknown[]>): string {
    let wireArrays: Record<string, unknown[]>;
    try {
        wireArrays = JSON.parse(JSON.stringify(arrays)) as Record<string, unknown[]>;
    } catch (error) {
        throw new Error("module transform page is not JSON-serializable", { cause: error });
    }
    return crypto.createHash("sha256").update(canonicalJson(wireArrays)).digest("hex");
}

function getMessageId(message: MessageLike): string | null {
    return typeof message.info.id === "string" && message.info.id.length > 0
        ? message.info.id
        : null;
}

function isSyntheticWireMessage(message: MessageLike): boolean {
    if ((message.info as { synthetic?: unknown }).synthetic === true) return true;
    return message.parts.some(
        (part) =>
            part !== null &&
            typeof part === "object" &&
            (part as { synthetic?: unknown }).synthetic === true,
    );
}

/**
 * Resolve OpenCode message ids to the absolute ordinals used by the module.
 * The module and shadow lanes must see the same provisional suffix behavior, so
 * this is shared rather than reimplemented by the authority adapter.
 */
export async function resolveOrdinalsForModule(args: {
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
}): Promise<
    | {
          ok: true;
          annotatedInput: unknown[];
          memoGeneration: number;
          memoAnchor: RawMessageOrdinalAnchor | null;
          memoStoredCount: number;
          memoCanonicalCount: number;
          normalizations: ModuleNormalizationRecord[];
      }
    | {
          ok: false;
          reason: "unresolved" | "mismatch";
          messageId?: string;
          messageIndex?: number;
          messageRole?: string;
      }
> {
    const memo = args.memo;
    const generationChanged = args.memoGeneration !== args.generation;
    if (generationChanged) memo.clear();

    let anchor = generationChanged ? null : (args.memoAnchor ?? null);
    let storedCount = generationChanged ? null : (args.memoStoredCount ?? null);
    let canonicalCount = generationChanged ? 0 : (args.memoCanonicalCount ?? 0);
    const priming = storedCount === null;
    if (priming) {
        memo.clear();
        anchor = null;
        canonicalCount = 0;
    }

    const newEntries: Array<ReturnType<typeof readRawSessionMessageOrdinalPage>[number]> = [];
    let pageAnchor = anchor;
    while (true) {
        const page = readRawSessionMessageOrdinalPage(
            args.sessionId,
            pageAnchor,
            MODULE_ORDINAL_PAGE_SIZE,
        );
        if (page.length === 0) break;
        newEntries.push(...page);
        const last = page[page.length - 1];
        pageAnchor = { timeCreated: last.timeCreated, id: last.id };
        if (page.length < MODULE_ORDINAL_PAGE_SIZE) break;
        await yieldToEventLoop();
    }

    const currentStoredCount = getRawSessionStoredMessageCount(args.sessionId);
    const expectedStoredCount = (storedCount ?? 0) + newEntries.length;
    if (currentStoredCount !== expectedStoredCount) {
        memo.clear();
        return { ok: false, reason: "mismatch" };
    }

    for (const entry of newEntries) {
        if (!entry.contributesOrdinal) continue;
        canonicalCount += 1;
        const prior = memo.get(entry.id);
        if (prior !== undefined && prior !== canonicalCount) {
            memo.clear();
            return { ok: false, reason: "mismatch", messageId: entry.id };
        }
        memo.set(entry.id, canonicalCount);
    }
    anchor = pageAnchor;
    storedCount = currentStoredCount;

    const normalizations: ModuleNormalizationRecord[] = [];
    const visibleIndexes: number[] = [];
    const visibleMessages = args.messages.filter((message, index) => {
        if (!isRawCompactionSummaryInfo(message.info)) {
            visibleIndexes.push(index);
            return true;
        }
        normalizations.push({
            kind: "summary_message",
            message_id: getMessageId(message),
            part_index: -1,
            field: "input",
            removed: JSON.stringify(message),
        });
        return false;
    });

    // Keep the caller-owned OpenCode objects untouched. A shallow root projection is
    // sufficient because the encoder only reads nested fields; unlike the old JSON clone,
    // this does not walk or duplicate the full message tree on every pass.
    const annotated: Array<Record<string, unknown>> = new Array(visibleMessages.length);
    const resolved: Array<number | undefined> = new Array(annotated.length);
    let firstUnresolved:
        | {
              messageId: string;
              messageIndex: number;
              messageRole: string;
          }
        | undefined;
    for (let index = 0; index < annotated.length; index += 1) {
        const messageId = getMessageId(visibleMessages[index]);
        if (!messageId) {
            return {
                ok: false,
                reason: "unresolved",
                messageIndex: visibleIndexes[index],
                messageRole: visibleMessages[index].info.role ?? "unknown",
            };
        }
        const ordinal = memo.get(messageId);
        if (ordinal === undefined && firstUnresolved === undefined) {
            firstUnresolved = {
                messageId,
                messageIndex: visibleIndexes[index],
                messageRole: visibleMessages[index].info.role ?? "unknown",
            };
        }
        resolved[index] = ordinal;
    }

    /**
     * OpenCode can place an unpersisted synthetic nudge between two persisted
     * messages in one wire snapshot. It is not part of canonical raw history,
     * so it borrows the preceding canonical ordinal instead of consuming a
     * slot. Only explicit synthetic messages get this exception. A genuine
     * persisted-but-unpaged message remains unresolved and is rejected below;
     * the stored-row count and ordinal self-heal checks still catch drift.
     */
    for (let index = 0; index < resolved.length; index += 1) {
        if (resolved[index] !== undefined || !isSyntheticWireMessage(visibleMessages[index])) {
            continue;
        }
        const hasResolvedMessageAfter = resolved
            .slice(index + 1)
            .some((ordinal) => ordinal !== undefined);
        if (!hasResolvedMessageAfter) continue;
        let priorIndex = index - 1;
        while (priorIndex >= 0 && resolved[priorIndex] === undefined) priorIndex -= 1;
        resolved[index] = priorIndex >= 0 ? (resolved[priorIndex] as number) : 0;
    }

    let suffixStart = annotated.length;
    while (suffixStart > 0 && resolved[suffixStart - 1] === undefined) suffixStart -= 1;
    for (let index = 0; index < suffixStart; index += 1) {
        if (resolved[index] === undefined) {
            return { ok: false, reason: "unresolved", ...firstUnresolved };
        }
    }
    if (suffixStart < annotated.length) {
        const base =
            suffixStart > 0
                ? (resolved[suffixStart - 1] as number)
                : Math.max(0, args.provisionalBase ?? canonicalCount);
        for (let index = suffixStart; index < annotated.length; index += 1) {
            resolved[index] = base + (index - suffixStart) + 1;
        }
    }

    for (let index = 0; index < annotated.length; index += 1) {
        const messageId = getMessageId(visibleMessages[index]) as string;
        const ordinal = resolved[index] as number;
        const prior = memo.get(messageId);
        if (prior !== undefined && prior !== ordinal) {
            return {
                ok: false,
                reason: "mismatch",
                messageId,
                messageIndex: visibleIndexes[index],
                messageRole: visibleMessages[index].info.role ?? "unknown",
            };
        }
        memo.set(messageId, ordinal);
        annotated[index] = { ...visibleMessages[index], absolute_ordinal: ordinal };
    }

    return {
        ok: true,
        annotatedInput: annotated,
        memoGeneration: args.generation,
        memoAnchor: anchor,
        memoStoredCount: storedCount,
        memoCanonicalCount: canonicalCount,
        normalizations,
    };
}

/** Flatten the typed builder shape to the module's top-level wire envelope. */
function toFlatModuleWireBody(payload: {
    method: string;
    params: Record<string, unknown>;
}): Record<string, unknown> {
    return { method: payload.method, ...payload.params };
}

export function moduleWireBodyBytes(payload: {
    method: string;
    params: Record<string, unknown>;
}): number {
    return Buffer.byteLength(JSON.stringify(toFlatModuleWireBody(payload)));
}

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

export function buildPagedModuleTransformPayloads(
    body: Record<string, unknown>,
): ModuleTransformWirePage[] {
    // The unpaged path must stringify once to know it fits. Return that length so
    // the transport telemetry does not serialize the same body a second time.
    const unpagedBytes = Buffer.byteLength(JSON.stringify(body));
    if (unpagedBytes <= MODULE_PAGE_MAX_BYTES) return [{ page: body, bytes: unpagedBytes }];

    const arrayFields = [
        "input",
        "messages",
        "native_messages",
        "ts_output",
        "ts_ck_messages",
        "normalizations",
    ].filter((field) => Array.isArray(body[field]));
    if (arrayFields.length === 0) {
        throw new Error("module transform body has no pageable message arrays");
    }
    const scalarFields = { ...body };
    for (const field of arrayFields) delete scalarFields[field];
    const transformPageId = crypto.randomUUID();
    const items = arrayFields.flatMap((field) =>
        (body[field] as unknown[]).map((value, itemIndex) => ({ field, value, itemIndex })),
    );
    const emptyArrays = (): Record<string, unknown[]> =>
        Object.fromEntries(arrayFields.map((field) => [field, []]));
    const makePage = (args: {
        index: number;
        total: number;
        complete: boolean;
        arrays: Record<string, unknown[]>;
    }): ModuleTransformWirePage => {
        const pageArrays = Object.fromEntries(
            arrayFields.map((field) => [field, args.arrays[field] ?? []]),
        );
        const page: Record<string, unknown> = {
            method: body.method,
            session_id: body.session_id,
            shadow_generation: body.shadow_generation,
            transform_page_id: transformPageId,
            // Authority transforms do not carry a shadow generation. A stable
            // transform generation still belongs to the page envelope so both
            // lanes use the same all-or-none paging contract.
            transform_generation: body.shadow_generation ?? 0,
            transform_page_index: args.index,
            transform_page_total: args.total,
            transform_page_complete: args.complete,
            transform_page_digest: transformPageDigest(pageArrays),
            ...pageArrays,
        };
        if (args.complete) Object.assign(page, scalarFields);
        // Admission already counted candidate sizes incrementally. Stringify once
        // here so transport telemetry can reuse the exact UTF-8 length.
        return { page, bytes: Buffer.byteLength(JSON.stringify(page)) };
    };
    const hasItems = (arrays: Record<string, unknown[]>): boolean =>
        Object.values(arrays).some((values) => values.length > 0);

    // Page admission used to clone and canonicalize the entire candidate page for every
    // message. The wire representation is unchanged, so count its UTF-8 bytes incrementally
    // and only build the digest once a page is actually emitted.
    const serializedItemBytes = (value: unknown): number =>
        Buffer.byteLength(JSON.stringify(value) ?? "null");
    const pageByteLength = (args: {
        index: number;
        total: number;
        complete: boolean;
        arrayBytes: Record<string, number>;
    }): number => {
        const skeleton: Record<string, unknown> = {
            method: body.method,
            session_id: body.session_id,
            shadow_generation: body.shadow_generation,
            transform_page_id: transformPageId,
            transform_generation: body.shadow_generation ?? 0,
            transform_page_index: args.index,
            transform_page_total: args.total,
            transform_page_complete: args.complete,
            transform_page_digest: "0".repeat(64),
            ...Object.fromEntries(arrayFields.map((field) => [field, []])),
        };
        if (args.complete) Object.assign(skeleton, scalarFields);
        const emptyArrayBytes = 2 * arrayFields.length;
        const contentsBytes = arrayFields.reduce(
            (sum, field) => sum + (args.arrayBytes[field] ?? 2),
            0,
        );
        return Buffer.byteLength(JSON.stringify(skeleton)) - emptyArrayBytes + contentsBytes;
    };

    let assumedTotal = 1;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const pages: ModuleTransformWirePage[] = [];
        let current = emptyArrays();
        let currentBytes = Object.fromEntries(arrayFields.map((field) => [field, 2]));
        const appendUnit = (field: string, value: unknown): boolean => {
            const valueBytes = serializedItemBytes(value);
            const previousBytes = currentBytes[field] ?? 2;
            current[field].push(value);
            currentBytes[field] = previousBytes + valueBytes + (current[field].length > 1 ? 1 : 0);
            if (
                pageByteLength({
                    index: pages.length,
                    total: assumedTotal,
                    complete: false,
                    arrayBytes: currentBytes,
                }) <= MODULE_PAGE_MAX_BYTES
            ) {
                return true;
            }
            current[field].pop();
            currentBytes[field] = previousBytes;
            if (hasItems(current)) {
                pages.push(
                    makePage({
                        index: pages.length,
                        total: assumedTotal,
                        complete: false,
                        arrays: current,
                    }),
                );
                current = emptyArrays();
                currentBytes = Object.fromEntries(arrayFields.map((name) => [name, 2]));
            }
            current[field].push(value);
            currentBytes[field] = 2 + valueBytes;
            if (
                pageByteLength({
                    index: pages.length,
                    total: assumedTotal,
                    complete: false,
                    arrayBytes: currentBytes,
                }) > MODULE_PAGE_MAX_BYTES
            ) {
                current[field].pop();
                currentBytes[field] = 2;
                return false;
            }
            return true;
        };

        for (const item of items) {
            if (appendUnit(item.field, item.value)) continue;
            const serialized = JSON.stringify(item.value) ?? "null";
            const bytes = Buffer.from(serialized, "utf8");
            const chunks: string[] = [];
            for (let start = 0; start < bytes.length; ) {
                let end = Math.min(start + MODULE_ITEM_CONTINUATION_CHUNK_BYTES, bytes.length);
                while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
                chunks.push(bytes.subarray(start, end).toString("utf8"));
                start = end;
            }
            const chunkTotal = chunks.length;
            for (const [chunkIndex, chunk] of chunks.entries()) {
                const marker = {
                    [MODULE_ITEM_CONTINUATION_KEY]: {
                        field: item.field,
                        item_index: item.itemIndex,
                        chunk_index: chunkIndex,
                        chunk_total: chunkTotal,
                    },
                    chunk,
                };
                if (!appendUnit(item.field, marker)) {
                    throw new Error("module transform continuation exceeds the 512 KiB page limit");
                }
            }
        }

        let finalPage = makePage({
            index: pages.length,
            total: assumedTotal,
            complete: true,
            arrays: current,
        });
        if (finalPage.bytes > MODULE_PAGE_MAX_BYTES) {
            if (!hasItems(current)) {
                throw new Error("module transform scalar tail exceeds the 512 KiB page limit");
            }
            pages.push(
                makePage({
                    index: pages.length,
                    total: assumedTotal,
                    complete: false,
                    arrays: current,
                }),
            );
            current = emptyArrays();
            currentBytes = Object.fromEntries(arrayFields.map((field) => [field, 2]));
            finalPage = makePage({
                index: pages.length,
                total: assumedTotal,
                complete: true,
                arrays: current,
            });
            if (finalPage.bytes > MODULE_PAGE_MAX_BYTES) {
                throw new Error("module transform scalar tail exceeds the 512 KiB page limit");
            }
        }
        pages.push(finalPage);
        if (pages.length === assumedTotal) return pages;
        assumedTotal = pages.length;
    }
    throw new Error("module transform page count did not stabilize");
}

export interface ModuleRawBlockMapping {
    blockIndex: number;
    partIndex: number;
    kind: "text" | "reasoning" | "file" | "tool_call" | "tool_result" | "other";
    callId?: string;
    toolInput?: unknown;
}

function toolCallId(part: Record<string, unknown>, messageId: string, blockIndex: number): string {
    return (
        (typeof part.callID === "string" && part.callID) ||
        (typeof part.callId === "string" && part.callId) ||
        (typeof part.id === "string" && part.id) ||
        `${messageId}#${blockIndex}`
    );
}

/**
 * Map raw OpenCode parts to the CK block indexes used by the Rust module. The
 * drop seed must name the same block the module would reduce; counting raw
 * parts is not enough because ignored parts disappear and completed tools
 * become a call/result pair.
 */
export function moduleRawBlockMappings(message: RawMessageParts | null): ModuleRawBlockMapping[] {
    if (!message) return [];
    const mappings: ModuleRawBlockMapping[] = [];
    let blockIndex = 0;
    for (const [partIndex, partValue] of message.parts.entries()) {
        if (partValue === null || typeof partValue !== "object" || Array.isArray(partValue))
            continue;
        const part = partValue as Record<string, unknown>;
        const type = typeof part.type === "string" ? part.type : "unknown";
        if (type === "text") {
            if (part.ignored === true) continue;
            mappings.push({ blockIndex, partIndex, kind: "text" });
            blockIndex += 1;
            continue;
        }
        if (["reasoning", "thinking", "redacted_thinking"].includes(type)) {
            mappings.push({ blockIndex, partIndex, kind: "reasoning" });
            blockIndex += 1;
            continue;
        }
        if (type === "tool") {
            const callId = toolCallId(part, message.id, blockIndex);
            const state =
                part.state !== null && typeof part.state === "object" && !Array.isArray(part.state)
                    ? (part.state as Record<string, unknown>)
                    : undefined;
            const input = state?.input ?? part.input ?? part.args ?? {};
            mappings.push({ blockIndex, partIndex, kind: "tool_call", callId, toolInput: input });
            blockIndex += 1;
            if (state?.status === "completed" || state?.status === "error") {
                mappings.push({
                    blockIndex,
                    partIndex,
                    kind: "tool_result",
                    callId,
                    toolInput: input,
                });
                blockIndex += 1;
            }
            continue;
        }
        if (type === "file") {
            mappings.push({ blockIndex, partIndex, kind: "file" });
            blockIndex += 1;
            continue;
        }
        if (["image", "step-start", "subtask"].includes(type)) {
            mappings.push({ blockIndex, partIndex, kind: "other" });
            blockIndex += 1;
            continue;
        }
        if (["compaction", "step-finish", "snapshot", "patch", "agent", "retry"].includes(type)) {
            continue;
        }
        mappings.push({ blockIndex, partIndex, kind: "other" });
        blockIndex += 1;
    }
    return mappings;
}

export const __moduleWireTest = {
    buildPagedModuleTransformPayloads,
    encodeOpenCodeMessagesToCk,
    moduleRawBlockMappings,
    moduleWireBodyBytes,
    resolveOrdinalsForModule,
    toFlatModuleWireBody,
};

export function encodeOpenCodeMessagesToCk(messages: unknown[]): Array<{
    mid: string;
    ordinal: number;
    ck: Record<string, unknown>;
}> {
    return messages.map((message, index) => {
        const raw =
            message !== null && typeof message === "object"
                ? (message as Record<string, unknown>)
                : {};
        const info =
            raw.info !== null && typeof raw.info === "object"
                ? (raw.info as Record<string, unknown>)
                : raw;
        const id =
            (typeof info.id === "string" && info.id.length > 0 && info.id) ||
            `opencode-${crypto.createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 24)}`;
        const ordinal =
            (typeof raw.absolute_ordinal === "number" && raw.absolute_ordinal) ||
            (typeof info.absolute_ordinal === "number" && info.absolute_ordinal) ||
            index + 1;
        const role = typeof info.role === "string" ? info.role : "user";
        const parts = Array.isArray(raw.parts) ? raw.parts : [];
        const synthetic =
            parts.length > 0 &&
            parts.every(
                (part) =>
                    part !== null &&
                    typeof part === "object" &&
                    ((part as Record<string, unknown>).synthetic === true ||
                        (part as Record<string, unknown>).syntheticTodoMarker === true),
            );
        const content: Record<string, unknown>[] = [];
        for (const partValue of parts) {
            if (partValue === null || typeof partValue !== "object") continue;
            const part = partValue as Record<string, unknown>;
            const type = typeof part.type === "string" ? part.type : "unknown";
            if (type === "text" && part.ignored !== true) {
                content.push({
                    kind: { type: "text", text: typeof part.text === "string" ? part.text : "" },
                });
            } else if (type === "reasoning" || type === "thinking") {
                const signature = typeof part.signature === "string" ? part.signature : undefined;
                content.push({
                    kind: {
                        type: "reasoning",
                        text:
                            typeof part.text === "string"
                                ? part.text
                                : typeof part.thinking === "string"
                                  ? part.thinking
                                  : "",
                        ...(signature ? { signature } : {}),
                    },
                    ...(part.cache_control !== undefined
                        ? {
                              provider_extras: {
                                  opencode: { cache_control: part.cache_control },
                              },
                          }
                        : {}),
                });
            } else if (type === "redacted_thinking") {
                content.push({
                    kind: {
                        type: "redacted_reasoning",
                        data:
                            typeof part.data === "string"
                                ? part.data
                                : typeof part.redacted === "string"
                                  ? part.redacted
                                  : "",
                    },
                    ...(part.cache_control !== undefined
                        ? {
                              provider_extras: {
                                  opencode: { cache_control: part.cache_control },
                              },
                          }
                        : {}),
                });
            } else if (type === "tool") {
                const state =
                    part.state !== null && typeof part.state === "object"
                        ? (part.state as Record<string, unknown>)
                        : {};
                const callId =
                    (typeof part.callID === "string" && part.callID) ||
                    (typeof part.callId === "string" && part.callId) ||
                    (typeof part.id === "string" && part.id) ||
                    `${id}#${content.length}`;
                const toolName = typeof part.tool === "string" ? part.tool : "unknown";
                const input = state.input ?? part.input ?? part.args ?? {};
                content.push({ kind: { type: "tool_call", id: callId, name: toolName, input } });
                if (state.status === "completed" || state.status === "error") {
                    const output =
                        typeof state.output === "string"
                            ? state.output
                            : typeof state.error === "string"
                              ? state.error
                              : "";
                    content.push({
                        kind: {
                            type: "tool_result",
                            id: callId,
                            tool_name: toolName,
                            output: {
                                kind: {
                                    type: state.status === "error" ? "error_text" : "text",
                                    text: output,
                                },
                            },
                        },
                    });
                }
            } else if (
                !["compaction", "step-finish", "snapshot", "patch", "agent", "retry"].includes(type)
            ) {
                content.push({
                    kind: {
                        type: "opaque",
                        source: "opencode",
                        kind: type,
                        raw: part,
                    },
                });
            }
        }
        return {
            mid: id,
            ordinal,
            ck: {
                role,
                content,
                meta: {
                    harness_id: id,
                    ordinal,
                    synthetic,
                    summary: info.summary === true,
                    errored: info.error !== undefined && info.error !== null,
                    ...(typeof info.finish === "string" ? { finish: info.finish } : {}),
                    ...(typeof info.time_created === "number"
                        ? { created_at_ms: info.time_created }
                        : typeof info.timeCreated === "number"
                          ? { created_at_ms: info.timeCreated }
                          : {}),
                },
            },
        };
    });
}

/**
 * Authority + mirror wire methods the transport routes through its serialized
 * authority lane. `authority.drain_flip` is deliberately absent: the drain
 * flip is issued through the general `call` path, not the authority helper.
 */
export type ModuleAuthorityMethod =
    | "authority.status"
    | "authority.prepare"
    | "authority.seed"
    | "authority.drain.begin"
    | "authority.drain.finish"
    | "authority.drain_seed"
    | "authority.drain_memories"
    | "authority.drain_notes"
    | "authority.drain_compartments"
    | "authority.drain_reconcile"
    | "authority.drain_verify"
    | "authority.drain_finish"
    | "mirror.pull";

/** Every method name the module transport can carry on the wire. */
export type ModuleMethod =
    | ModuleAuthorityMethod
    | "authority.drain_flip"
    | "state_sync"
    | "transform"
    | "session.status"
    | "session.delete"
    | "session.flush"
    | "session.recomp"
    | "session.wrapup"
    | "todo_state.set"
    | "agent_drops.append"
    | "ctx_note"
    | "ctx_memory"
    | "claim.intent.stage"
    | "claim.intent.inspect"
    | "claim.intent.ack"
    | "claim.effects.apply"
    | "claim.mirror.replace"
    | "claim.mirror.apply"
    | "note.evaluate"
    | "note.evaluation.register"
    | "note.evaluation.heartbeat"
    | "note.evaluation.unregister"
    | "note.evaluation.next"
    | "note.evaluation.renew"
    | "note.evaluation.complete"
    | "note.evaluation.abandon"
    | "transform.ack"
    | "transform.nack"
    | "dreamer.run_task"
    | "memory.set_classification";

/**
 * Subset a state-sync client may issue. `Extract` ties each member to
 * {@link ModuleMethod}: a name that leaves the transport union silently drops
 * out of this subset, so client code issuing it fails typecheck instead of
 * the client accepting a method the transport cannot carry.
 */
export type ModuleStateSyncMethod = Extract<
    ModuleMethod,
    | "state_sync"
    | "transform"
    | "session.status"
    | "session.delete"
    | "session.flush"
    | "session.recomp"
    | "session.wrapup"
    | "todo_state.set"
    | "agent_drops.append"
    | "ctx_note"
    | "ctx_memory"
    | "note.evaluate"
    | "transform.ack"
    | "transform.nack"
>;

// Compile-time guards, checked by `tsc --noEmit` because this is a source
// file (test files are excluded from the typecheck project). Erased at
// runtime.
type _MethodUnionAssertTrue<T extends true> = T;
// The state-sync subset admits no authority-lane method.
type _StateSyncExcludesAuthority = _MethodUnionAssertTrue<
    Extract<ModuleStateSyncMethod, ModuleAuthorityMethod> extends never ? true : false
>;
// No expected state-sync member silently dropped out of the `Extract`.
type _StateSyncMembersCarried = _MethodUnionAssertTrue<
        | "state_sync"
        | "transform"
        | "session.status"
        | "session.delete"
        | "session.flush"
        | "session.recomp"
        | "session.wrapup"
        | "todo_state.set"
        | "agent_drops.append"
        | "ctx_note"
        | "ctx_memory"
        | "note.evaluate"
        | "transform.ack"
        | "transform.nack" extends ModuleStateSyncMethod
        ? true
        : false
>;
