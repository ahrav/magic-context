/**
 * The only place daemon bytes become a `MemoryState`. Every parser here is
 * total: a shape violation yields `invalid(unrecognized_state)` instead of a
 * throw, so a daemon/plugin version skew degrades to a typed state.
 */

import { isRecord } from "../record-type-guard";
import {
    CONFLICT_REASONS,
    type ConflictReason,
    type DaemonInvalidReason,
    type DaemonUnavailableReason,
    INVALID_REASONS,
    invalid,
    type MemoryState,
    UNAVAILABLE_REASONS,
} from "./state";

export const SENSITIVITIES = ["normal", "sensitive", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const VISIBILITIES = ["visible", "labeled", "hidden"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export interface ObjectRow {
    object_id: string;
    object_kind: string;
    domain_id: string;
    source_kind: string;
    source_id: string;
    source_revision: number;
    created_commit_seq: number;
    invalidated_commit_seq: number | null;
    superseded_by: string | null;
    sensitivity: Sensitivity;
}

export interface MutationToken {
    object_id: string;
    known_as_of: number;
}

export interface DecisionPayload {
    summary: string;
    rationale: string;
}

/** The decision row a `decision` object carries; other object kinds carry none. */
export interface ReadDecision {
    decision_kind: string;
    payload: DecisionPayload;
}

export interface ReadRow {
    object: ObjectRow;
    visibility: Visibility;
    labeled: boolean;
    scope_id: string | null;
    token: MutationToken;
    decision?: ReadDecision;
}

export const MEMORY_DOMAIN_ID = "memory";

export function isMemoryDecisionRow(row: ReadRow): boolean {
    return row.decision !== undefined && row.object.domain_id === MEMORY_DOMAIN_ID;
}

export interface ReadPayload {
    known_as_of: number;
    tip: number;
    gated: boolean;
    rows: ReadRow[];
}

export interface CommitPayload {
    receipt: { commit_seq: number; replayed: boolean };
    known_as_of: number;
    tokens: MutationToken[];
}

export interface ParsedResponse {
    state: MemoryState;
    /** The response body minus `state`; empty when the state is not `available`. */
    payload: Record<string, unknown>;
}

const UNRECOGNIZED: MemoryState = invalid("unrecognized_state");

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function oneOf<const T extends readonly string[]>(set: T, value: unknown): value is T[number] {
    return typeof value === "string" && (set as readonly string[]).includes(value);
}

/** The transport hands back either the body or `{result: body}`. */
function responseBody(raw: unknown): Record<string, unknown> | null {
    if (!isRecord(raw)) return null;
    if (isRecord(raw.result) && !("state" in raw)) return raw.result;
    return raw;
}

export function parseKernelState(raw: unknown): MemoryState {
    if (!isRecord(raw) || typeof raw.kind !== "string") return UNRECOGNIZED;
    switch (raw.kind) {
        case "available":
            return { kind: "available" };
        case "stale":
        case "abstained":
            if (
                !isNonNegativeInteger(raw.lag_positions) ||
                !isNonNegativeInteger(raw.oldest_unconsumed_age_ms)
            ) {
                return UNRECOGNIZED;
            }
            return {
                kind: raw.kind,
                lag_positions: raw.lag_positions,
                oldest_unconsumed_age_ms: raw.oldest_unconsumed_age_ms,
            };
        case "unavailable":
            return oneOf(UNAVAILABLE_REASONS, raw.reason)
                ? { kind: "unavailable", reason: raw.reason as DaemonUnavailableReason }
                : UNRECOGNIZED;
        case "conflict":
            return oneOf(CONFLICT_REASONS, raw.reason)
                ? { kind: "conflict", reason: raw.reason as ConflictReason }
                : UNRECOGNIZED;
        case "invalid":
            return oneOf(INVALID_REASONS, raw.reason)
                ? { kind: "invalid", reason: raw.reason as DaemonInvalidReason }
                : UNRECOGNIZED;
        default:
            return UNRECOGNIZED;
    }
}

export function parseKernelResponse(raw: unknown): ParsedResponse {
    const body = responseBody(raw);
    if (!body) return { state: UNRECOGNIZED, payload: {} };
    const state = parseKernelState(body.state);
    const { state: _state, ...payload } = body;
    return { state, payload };
}

function parseToken(raw: unknown): MutationToken | null {
    if (!isRecord(raw)) return null;
    if (typeof raw.object_id !== "string" || !isNonNegativeInteger(raw.known_as_of)) return null;
    return { object_id: raw.object_id, known_as_of: raw.known_as_of };
}

function parseTokens(raw: unknown): MutationToken[] | null {
    if (!Array.isArray(raw)) return null;
    const tokens: MutationToken[] = [];
    for (const item of raw) {
        const token = parseToken(item);
        if (!token) return null;
        tokens.push(token);
    }
    return tokens;
}

function parseObjectRow(raw: unknown): ObjectRow | null {
    if (!isRecord(raw)) return null;
    const strings = ["object_id", "object_kind", "domain_id", "source_kind", "source_id"] as const;
    for (const key of strings) {
        if (typeof raw[key] !== "string") return null;
    }
    if (!Number.isSafeInteger(raw.source_revision)) return null;
    if (!isNonNegativeInteger(raw.created_commit_seq)) return null;
    if (raw.invalidated_commit_seq !== null && !isNonNegativeInteger(raw.invalidated_commit_seq)) {
        return null;
    }
    if (raw.superseded_by !== null && typeof raw.superseded_by !== "string") return null;
    if (!oneOf(SENSITIVITIES, raw.sensitivity)) return null;
    return {
        object_id: raw.object_id as string,
        object_kind: raw.object_kind as string,
        domain_id: raw.domain_id as string,
        source_kind: raw.source_kind as string,
        source_id: raw.source_id as string,
        source_revision: raw.source_revision as number,
        created_commit_seq: raw.created_commit_seq,
        invalidated_commit_seq: raw.invalidated_commit_seq,
        superseded_by: raw.superseded_by,
        sensitivity: raw.sensitivity,
    };
}

/** `undefined` for an absent or null decision; `null` for a malformed one. */
function parseReadDecision(raw: unknown): ReadDecision | undefined | null {
    if (raw === undefined || raw === null) return undefined;
    if (!isRecord(raw) || typeof raw.decision_kind !== "string") return null;
    const payload = raw.payload;
    if (!isRecord(payload)) return null;
    if (typeof payload.summary !== "string" || typeof payload.rationale !== "string") return null;
    return {
        decision_kind: raw.decision_kind,
        payload: { summary: payload.summary, rationale: payload.rationale },
    };
}

function parseReadRow(raw: unknown): ReadRow | null {
    if (!isRecord(raw)) return null;
    const object = parseObjectRow(raw.object);
    const token = parseToken(raw.token);
    if (!object || !token) return null;
    if (!oneOf(VISIBILITIES, raw.visibility) || typeof raw.labeled !== "boolean") return null;
    if (raw.scope_id !== null && typeof raw.scope_id !== "string") return null;
    if (token.object_id !== object.object_id) return null;
    const decision = parseReadDecision(raw.decision);
    if (decision === null) return null;
    // A decision object always carries its decision row; a daemon that omits it
    // predates the field, and the row would otherwise vanish silently.
    if (decision === undefined && object.object_kind === "decision") return null;
    return {
        object,
        visibility: raw.visibility,
        labeled: raw.labeled,
        scope_id: raw.scope_id,
        token,
        ...(decision === undefined ? {} : { decision }),
    };
}

export type Parsed<P> = { state: MemoryState; payload: P | null };

function failed<P>(): Parsed<P> {
    return { state: UNRECOGNIZED, payload: null };
}

export function parseReadResponse(raw: unknown): Parsed<ReadPayload> {
    const { state, payload } = parseKernelResponse(raw);
    if (state.kind !== "available") return { state, payload: null };
    if (!isNonNegativeInteger(payload.known_as_of) || !isNonNegativeInteger(payload.tip)) {
        return failed();
    }
    if (typeof payload.gated !== "boolean" || !Array.isArray(payload.rows)) return failed();
    const rows: ReadRow[] = [];
    for (const item of payload.rows) {
        const row = parseReadRow(item);
        if (!row || row.token.known_as_of !== payload.known_as_of) return failed();
        rows.push(row);
    }
    return {
        state,
        payload: { known_as_of: payload.known_as_of, tip: payload.tip, gated: payload.gated, rows },
    };
}

export function parseCommitResponse(raw: unknown): Parsed<CommitPayload> {
    const { state, payload } = parseKernelResponse(raw);
    if (state.kind !== "available") return { state, payload: null };
    const receipt = payload.receipt;
    if (!isRecord(receipt) || !isNonNegativeInteger(receipt.commit_seq)) return failed();
    if (typeof receipt.replayed !== "boolean") return failed();
    if (!isNonNegativeInteger(payload.known_as_of)) return failed();
    const tokens = parseTokens(payload.tokens);
    if (!tokens) return failed();
    return {
        state,
        payload: {
            receipt: { commit_seq: receipt.commit_seq, replayed: receipt.replayed },
            known_as_of: payload.known_as_of,
            tokens,
        },
    };
}
