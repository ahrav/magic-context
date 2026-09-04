import type { Database } from "../../shared/sqlite";
export interface Compartment {
    id: number;
    sessionId: string;
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    /** v2: P1 tier text (fullest). Legacy rows: flat v1 content. Always present (NOT NULL). */
    content: string;
    /** v2 paraphrase tiers (model B). NULL for legacy=1 rows. */
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    /** Decay-rate signal (1-100). Defaults to 50. */
    importance: number;
    /** Comma-separated activity types (e.g. "design,feature"). NULL for legacy rows. */
    episodeType: string | null;
    /** 1 = pre-v2 flat compartment (no tiers); 0 = v2 tiered. */
    legacy: number;
    createdAt: number;
}
export interface SessionFact {
    id: number;
    sessionId: string;
    category: string;
    content: string;
    createdAt: number;
    updatedAt: number;
}
export interface CompartmentInput {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    /** v2: P1 tier text. Legacy/compressor inserts: flat content. */
    content: string;
    /** v2 paraphrase tiers (model B). Omitted/null for legacy or compressor inserts → stored NULL. */
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    /** Decay-rate signal (1-100). Omitted → stored 50. */
    importance?: number | null;
    /** Comma-separated activity types. Omitted/null → stored NULL. */
    episodeType?: string | null;
}
export declare function getCompartments(db: Database, sessionId: string): Compartment[];
export declare function getLastCompartmentEndMessage(db: Database, sessionId: string): number;
/**
 * The OpenCode message id at the boundary of the highest-sequence compartment —
 * i.e. the last raw message the compartment history (m[0]+m[1]) covers. Returns
 * null when there are no compartments or the latest one has no stored boundary
 * (legacy rows). Used to persist the m[1]-coverage boundary so a cold post-
 * restart pass trims the live tail to what the cached summary actually covers,
 * not to the latest compartment (which may be newer than the cached m[1]).
 */
export declare function getLastCompartmentEndMessageId(db: Database, sessionId: string): string | null;
/**
 * Look up compartments whose stored `end_message_id` matches the given
 * OpenCode message id. Returns an ARRAY — schema only enforces
 * `UNIQUE(session_id, sequence)`, NOT `(session_id, end_message_id)`, so
 * a future bug could in principle leave two rows sharing a boundary. The
 * marker drain's `validatePendingTarget` treats `length > 1` as a schema
 * invariant violation and bails to stale-skip (plan v6 section 5).
 *
 * Normal path: exactly one match → caller treats it as the target row.
 */
export declare function getCompartmentsByEndMessageId(db: Database, sessionId: string, endMessageId: string): Compartment[];
export declare function replaceAllCompartments(db: Database, sessionId: string, compartments: CompartmentInput[]): void;
/**
 * Append new compartments without deleting existing ones.
 * Used by the incremental runner where existing compartments are preserved
 * and only new compartments for the latest chunk are added.
 */
export declare function appendCompartments(db: Database, sessionId: string, compartments: CompartmentInput[]): void;
/**
 * Replace session facts without touching compartments.
 * Facts are fully re-normalized by the historian on each pass,
 * so they always need a full replacement.
 */
export declare function replaceSessionFacts(db: Database, sessionId: string, facts: Array<{
    category: string;
    content: string;
}>): void;
export declare function getSessionFacts(db: Database, sessionId: string): SessionFact[];
export declare function replaceAllCompartmentState(db: Database, sessionId: string, compartments: CompartmentInput[], facts: Array<{
    category: string;
    content: string;
}>): void;
export declare function replaceAllCompartmentStateAndBumpDepth(db: Database, holderId: string, sessionId: string, compartments: CompartmentInput[], facts: Array<{
    category: string;
    content: string;
}>, depthStartOrdinal: number, depthEndOrdinal: number): boolean;
export interface CompartmentDateRanges {
    /** Map compartment id → `{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" }` */
    byId: Map<number, {
        start: string;
        end: string;
    }>;
}
export declare function buildCompartmentBlock(compartments: Compartment[], facts: SessionFact[], memoryBlock?: string, dateRanges?: CompartmentDateRanges): string;
export interface RecompStaging {
    compartments: CompartmentInput[];
    facts: Array<{
        category: string;
        content: string;
    }>;
    passCount: number;
    lastEndMessage: number;
}
/** Append one pass's results to the staging tables. */
export declare function saveRecompStagingPass(db: Database, sessionId: string, passNumber: number, compartments: CompartmentInput[], facts: Array<{
    category: string;
    content: string;
}>): void;
/** Read existing staging data for resume. Returns null if no staging exists. */
export declare function getRecompStaging(db: Database, sessionId: string): RecompStaging | null;
/** Atomically promote staging → real tables, then clear staging. */
export declare function promoteRecompStaging(db: Database, sessionId: string, holderId?: string): {
    compartments: CompartmentInput[];
    facts: Array<{
        category: string;
        content: string;
    }>;
} | null;
/** Clear staging tables for a session (on cancel/abandon or after successful promote). */
export declare function clearRecompStaging(db: Database, sessionId: string): void;
/**
 * Returns the stored partial recomp range for this session, or null when the
 * active staging (if any) is for a full recomp.
 *
 * A zero-valued row means "no partial range recorded" — either no staging or
 * full-recomp staging.
 */
export declare function getRecompPartialRange(db: Database, sessionId: string): {
    start: number;
    end: number;
} | null;
/**
 * Record the active partial recomp range. Must be called inside or alongside
 * saveRecompStagingPass so staging and range marker stay in sync.
 */
export declare function setRecompPartialRange(db: Database, sessionId: string, range: {
    start: number;
    end: number;
} | null): void;
export declare function escapeXmlAttr(s: string): string;
export declare function escapeXmlContent(s: string): string;
//# sourceMappingURL=compartment-storage.d.ts.map