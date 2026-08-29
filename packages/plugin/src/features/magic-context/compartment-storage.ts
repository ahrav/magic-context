import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { isCompartmentLeaseHeld } from "./compartment-lease";
import { getIncrementDepthStatement } from "./compression-depth-storage";
import { clearCachedM0M1 } from "./storage-meta-shared";

const insertCompartmentStatements = new WeakMap<Database, PreparedStatement>();
const insertFactStatements = new WeakMap<Database, PreparedStatement>();

function getInsertCompartmentStatement(db: Database): PreparedStatement {
    let stmt = insertCompartmentStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        insertCompartmentStatements.set(db, stmt);
    }
    return stmt;
}

function getInsertFactStatement(db: Database): PreparedStatement {
    let stmt = insertFactStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness) VALUES (?, ?, ?, ?, ?, ?)",
        );
        insertFactStatements.set(db, stmt);
    }
    return stmt;
}

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

interface CompartmentRow {
    id: number;
    session_id: string;
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    title: string;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number | null;
    episode_type: string | null;
    legacy: number | null;
    created_at: number;
}

interface SessionFactRow {
    id: number;
    session_id: string;
    category: string;
    content: string;
    created_at: number;
    updated_at: number;
}

function isStringOrNullish(v: unknown): v is string | null | undefined {
    return v === null || v === undefined || typeof v === "string";
}

function isNumberOrNullish(v: unknown): v is number | null | undefined {
    return v === null || v === undefined || typeof v === "number";
}

function isCompartmentRow(row: unknown): row is CompartmentRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.sequence === "number" &&
        typeof candidate.start_message === "number" &&
        typeof candidate.end_message === "number" &&
        typeof candidate.start_message_id === "string" &&
        typeof candidate.end_message_id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.content === "string" &&
        // v2 tier columns are nullable (legacy rows store NULL). Tolerate absence
        // so a row is never rejected just for missing/null tier metadata.
        isStringOrNullish(candidate.p1) &&
        isStringOrNullish(candidate.p2) &&
        isStringOrNullish(candidate.p3) &&
        isStringOrNullish(candidate.p4) &&
        isNumberOrNullish(candidate.importance) &&
        isStringOrNullish(candidate.episode_type) &&
        isNumberOrNullish(candidate.legacy) &&
        typeof candidate.created_at === "number"
    );
}

function isSessionFactRow(row: unknown): row is SessionFactRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.category === "string" &&
        typeof candidate.content === "string" &&
        typeof candidate.created_at === "number" &&
        typeof candidate.updated_at === "number"
    );
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

function insertCompartmentRows(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
    now: number,
): void {
    const stmt = getInsertCompartmentStatement(db);
    for (const compartment of compartments) {
        // A compartment is v2 (legacy=0) iff it carries at least the P1 tier.
        // Compressor/legacy inserts pass no tiers → stored NULL + legacy=1.
        const hasTiers = typeof compartment.p1 === "string" && compartment.p1.length > 0;
        stmt.run(
            sessionId,
            compartment.sequence,
            compartment.startMessage,
            compartment.endMessage,
            compartment.startMessageId,
            compartment.endMessageId,
            compartment.title,
            compartment.content,
            compartment.p1 ?? null,
            compartment.p2 ?? null,
            compartment.p3 ?? null,
            compartment.p4 ?? null,
            typeof compartment.importance === "number" ? compartment.importance : 50,
            compartment.episodeType ?? null,
            hasTiers ? 0 : 1,
            now,
            getHarness(),
        );
    }
}

function insertFactRows(
    db: Database,
    sessionId: string,
    facts: Array<{ category: string; content: string }>,
    now: number,
): void {
    const stmt = getInsertFactStatement(db);
    for (const fact of facts) {
        stmt.run(sessionId, fact.category, fact.content, now, now, getHarness());
    }
}

function toCompartment(row: CompartmentRow): Compartment {
    return {
        id: row.id,
        sessionId: row.session_id,
        sequence: row.sequence,
        startMessage: row.start_message,
        endMessage: row.end_message,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        title: row.title,
        content: row.content,
        p1: row.p1 ?? null,
        p2: row.p2 ?? null,
        p3: row.p3 ?? null,
        p4: row.p4 ?? null,
        importance: typeof row.importance === "number" ? row.importance : 50,
        episodeType: row.episode_type ?? null,
        legacy: typeof row.legacy === "number" ? row.legacy : 0,
        createdAt: row.created_at,
    };
}

function toSessionFact(row: SessionFactRow): SessionFact {
    return {
        id: row.id,
        sessionId: row.session_id,
        category: row.category,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function getCompartments(db: Database, sessionId: string): Compartment[] {
    const rows = db
        // Audit note: SELECT * is intentional — compartments table is owned by this plugin, columns are
        // validated by isCompartmentRow(), and all columns are needed for rendering and validation.
        .prepare("SELECT * FROM compartments WHERE session_id = ? ORDER BY sequence ASC")
        .all(sessionId)
        .filter(isCompartmentRow);
    return rows.map(toCompartment);
}

export function getLastCompartmentEndMessage(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT MAX(end_message) as max_end FROM compartments WHERE session_id = ?")
        .get(sessionId) as { max_end: number | null } | null;
    return row?.max_end ?? -1;
}

/**
 * The OpenCode message id at the boundary of the highest-sequence compartment —
 * i.e. the last raw message the compartment history (m[0]+m[1]) covers. Returns
 * null when there are no compartments or the latest one has no stored boundary
 * (legacy rows). Used to persist the m[1]-coverage boundary so a cold post-
 * restart pass trims the live tail to what the cached summary actually covers,
 * not to the latest compartment (which may be newer than the cached m[1]).
 */
export function getLastCompartmentEndMessageId(db: Database, sessionId: string): string | null {
    const row = db
        .prepare(
            "SELECT end_message_id FROM compartments WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(sessionId) as { end_message_id: string | null } | undefined;
    const id = row?.end_message_id;
    return id && id.length > 0 ? id : null;
}

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
export function getCompartmentsByEndMessageId(
    db: Database,
    sessionId: string,
    endMessageId: string,
): Compartment[] {
    const rows = db
        .prepare(
            "SELECT * FROM compartments WHERE session_id = ? AND end_message_id = ? ORDER BY sequence ASC",
        )
        .all(sessionId, endMessageId)
        .filter(isCompartmentRow);
    return rows.map(toCompartment);
}

export function replaceAllCompartments(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        insertCompartmentRows(db, sessionId, compartments, now);
    })();
}

/**
 * Append new compartments without deleting existing ones.
 * Used by the incremental runner where existing compartments are preserved
 * and only new compartments for the latest chunk are added.
 */
export function appendCompartments(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
): void {
    if (compartments.length === 0) return;
    const now = Date.now();
    db.transaction(() => {
        insertCompartmentRows(db, sessionId, compartments, now);
    })();
}

export function getSessionFacts(db: Database, sessionId: string): SessionFact[] {
    const rows = db
        .prepare("SELECT * FROM session_facts WHERE session_id = ? ORDER BY category ASC, id ASC")
        .all(sessionId)
        .filter(isSessionFactRow);
    return rows.map(toSessionFact);
}

export function replaceAllCompartmentState(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
    facts: Array<{ category: string; content: string }>,
): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);

        insertCompartmentRows(db, sessionId, compartments, now);
        insertFactRows(db, sessionId, facts, now);

        clearCachedM0M1(db, sessionId);
    })();
}

export function replaceAllCompartmentStateAndBumpDepth(
    db: Database,
    holderId: string,
    sessionId: string,
    compartments: CompartmentInput[],
    facts: Array<{ category: string; content: string }>,
    depthStartOrdinal: number,
    depthEndOrdinal: number,
): boolean {
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
            db.exec("ROLLBACK");
            finished = true;
            return false;
        }

        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);

        insertCompartmentRows(db, sessionId, compartments, now);
        insertFactRows(db, sessionId, facts, now);

        clearCachedM0M1(db, sessionId);

        if (depthEndOrdinal >= depthStartOrdinal) {
            const stmt = getIncrementDepthStatement(db);
            for (let ordinal = depthStartOrdinal; ordinal <= depthEndOrdinal; ordinal += 1) {
                stmt.run(sessionId, ordinal, getHarness());
            }
        }

        db.exec("COMMIT");
        finished = true;
        return true;
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Transaction may already be closed by SQLite after an error.
            }
        }
    }
}

export interface CompartmentDateRanges {
    /** Map compartment id → `{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" }` */
    byId: Map<number, { start: string; end: string }>;
}

export function buildCompartmentBlock(
    compartments: Compartment[],
    facts: SessionFact[],
    memoryBlock?: string,
    dateRanges?: CompartmentDateRanges,
): string {
    const lines: string[] = [];

    if (memoryBlock) {
        lines.push(memoryBlock);
        lines.push("");
    }

    for (const c of compartments) {
        const dates = dateRanges?.byId.get(c.id);
        const dateAttr = dates ? ` start-date="${dates.start}" end-date="${dates.end}"` : "";
        lines.push(
            `<compartment start="${c.startMessage}" end="${c.endMessage}"${dateAttr} title="${escapeXmlAttr(c.title)}">`,
        );
        lines.push(escapeXmlContent(c.content));
        lines.push("</compartment>");
        lines.push("");
    }

    const factsByCategory = new Map<string, string[]>();
    for (const f of facts) {
        const existing = factsByCategory.get(f.category) ?? [];
        existing.push(f.content);
        factsByCategory.set(f.category, existing);
    }

    for (const [category, items] of factsByCategory) {
        lines.push(`${category}:`);
        for (const item of items) {
            lines.push(`* ${escapeXmlContent(item)}`);
        }
        lines.push("");
    }

    return lines.join("\n").trimEnd();
}

// ── Recomp staging ──────────────────────────────────────────────────────────

export interface RecompStaging {
    compartments: CompartmentInput[];
    facts: Array<{ category: string; content: string }>;
    passCount: number;
    lastEndMessage: number;
}

/** Append one pass's results to the staging tables. */
export function saveRecompStagingPass(
    db: Database,
    sessionId: string,
    passNumber: number,
    compartments: CompartmentInput[],
    facts: Array<{ category: string; content: string }>,
): void {
    const now = Date.now();
    db.transaction(() => {
        // Facts are replaced wholesale each pass (historian rewrites full fact list)
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);

        const compartmentStmt = db.prepare(
            "INSERT OR REPLACE INTO recomp_compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, pass_number, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const c of compartments) {
            compartmentStmt.run(
                sessionId,
                c.sequence,
                c.startMessage,
                c.endMessage,
                c.startMessageId,
                c.endMessageId,
                c.title,
                c.content,
                c.p1 ?? null,
                c.p2 ?? null,
                c.p3 ?? null,
                c.p4 ?? null,
                typeof c.importance === "number" ? c.importance : 50,
                c.episodeType ?? null,
                passNumber,
                now,
                getHarness(),
            );
        }

        const factStmt = db.prepare(
            "INSERT INTO recomp_facts (session_id, category, content, pass_number, created_at, harness) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const f of facts) {
            factStmt.run(sessionId, f.category, f.content, passNumber, now, getHarness());
        }
    })();
}

/** Read existing staging data for resume. Returns null if no staging exists. */
export function getRecompStaging(db: Database, sessionId: string): RecompStaging | null {
    const compartmentRows = db
        .prepare("SELECT * FROM recomp_compartments WHERE session_id = ? ORDER BY sequence ASC")
        .all(sessionId)
        .filter(isRecompCompartmentRow);

    if (compartmentRows.length === 0) return null;

    const compartments: CompartmentInput[] = compartmentRows.map((row) => ({
        sequence: row.sequence,
        startMessage: row.start_message,
        endMessage: row.end_message,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        title: row.title,
        content: row.content,
        p1: row.p1 ?? null,
        p2: row.p2 ?? null,
        p3: row.p3 ?? null,
        p4: row.p4 ?? null,
        importance: typeof row.importance === "number" ? row.importance : 50,
        episodeType: row.episode_type ?? null,
    }));

    const factRows = db
        .prepare("SELECT category, content FROM recomp_facts WHERE session_id = ?")
        .all(sessionId)
        .filter(isRecompFactRow);

    const maxPass = compartmentRows.reduce((m, r) => Math.max(m, r.pass_number), 0);
    const lastEnd = compartmentRows[compartmentRows.length - 1]?.end_message ?? 0;

    return {
        compartments,
        facts: factRows,
        passCount: maxPass,
        lastEndMessage: lastEnd,
    };
}

/** Atomically promote staging → real tables, then clear staging. */
export function promoteRecompStaging(
    db: Database,
    sessionId: string,
    holderId?: string,
): {
    compartments: CompartmentInput[];
    facts: Array<{ category: string; content: string }>;
} | null {
    const now = Date.now();
    if (!holderId) {
        return db.transaction(() => {
            const staging = getRecompStaging(db, sessionId);
            if (!staging || staging.compartments.length === 0) return null;

            db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
            db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
            insertCompartmentRows(db, sessionId, staging.compartments, now);
            insertFactRows(db, sessionId, staging.facts, now);
            db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
            db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);
            clearCachedM0M1(db, sessionId);
            return { compartments: staging.compartments, facts: staging.facts };
        })();
    }

    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }

        const staging = getRecompStaging(db, sessionId);
        if (!staging || staging.compartments.length === 0) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }
        // Replace real tables
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);

        insertCompartmentRows(db, sessionId, staging.compartments, now);
        insertFactRows(db, sessionId, staging.facts, now);

        // Clear staging
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);

        clearCachedM0M1(db, sessionId);

        db.exec("COMMIT");
        finished = true;
        return { compartments: staging.compartments, facts: staging.facts };
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Transaction may already be closed by SQLite after an error.
            }
        }
    }
}

/** Clear staging tables for a session (on cancel/abandon or after successful promote). */
export function clearRecompStaging(db: Database, sessionId: string): void {
    db.transaction(() => {
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);
        // Clear the partial-range marker so a future full recomp doesn't
        // resume under a partial range. Best-effort — column may not exist
        // in very old test DBs.
        try {
            db.prepare(
                "UPDATE session_meta SET recomp_partial_range_start = 0, recomp_partial_range_end = 0 WHERE session_id = ?",
            ).run(sessionId);
        } catch {
            // column missing in very old schemas — ignore
        }
    })();
}

// ── Partial recomp range marker ─────────────────────────────────────────────

/**
 * Returns the stored partial recomp range for this session, or null when the
 * active staging (if any) is for a full recomp.
 *
 * A zero-valued row means "no partial range recorded" — either no staging or
 * full-recomp staging.
 */
export function getRecompPartialRange(
    db: Database,
    sessionId: string,
): { start: number; end: number } | null {
    try {
        const row = db
            .prepare(
                "SELECT recomp_partial_range_start AS start, recomp_partial_range_end AS end FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { start?: number; end?: number } | null;
        const start = typeof row?.start === "number" ? row.start : 0;
        const end = typeof row?.end === "number" ? row.end : 0;
        if (start <= 0 || end <= 0) return null;
        return { start, end };
    } catch {
        return null;
    }
}

/**
 * Record the active partial recomp range. Must be called inside or alongside
 * saveRecompStagingPass so staging and range marker stay in sync.
 */
export function setRecompPartialRange(
    db: Database,
    sessionId: string,
    range: { start: number; end: number } | null,
): void {
    const start = range ? range.start : 0;
    const end = range ? range.end : 0;
    // Ensure the session_meta row exists so UPDATE takes effect. Mirrors the
    // pattern used elsewhere in this module.
    db.prepare("INSERT OR IGNORE INTO session_meta (session_id) VALUES (?)").run(sessionId);
    db.prepare(
        "UPDATE session_meta SET recomp_partial_range_start = ?, recomp_partial_range_end = ? WHERE session_id = ?",
    ).run(start, end, sessionId);
}

interface RecompCompartmentRow {
    id: number;
    session_id: string;
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    title: string;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number | null;
    episode_type: string | null;
    pass_number: number;
    created_at: number;
}

function isRecompCompartmentRow(row: unknown): row is RecompCompartmentRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.sequence === "number" &&
        typeof candidate.start_message === "number" &&
        typeof candidate.end_message === "number" &&
        typeof candidate.start_message_id === "string" &&
        typeof candidate.end_message_id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.content === "string" &&
        isStringOrNullish(candidate.p1) &&
        isStringOrNullish(candidate.p2) &&
        isStringOrNullish(candidate.p3) &&
        isStringOrNullish(candidate.p4) &&
        isNumberOrNullish(candidate.importance) &&
        isStringOrNullish(candidate.episode_type) &&
        typeof candidate.pass_number === "number" &&
        typeof candidate.created_at === "number"
    );
}

function isRecompFactRow(row: unknown): row is { category: string; content: string } {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.category === "string" && typeof candidate.content === "string";
}

export function escapeXmlAttr(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function escapeXmlContent(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
