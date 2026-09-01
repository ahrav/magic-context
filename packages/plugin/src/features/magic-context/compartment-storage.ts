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
    /* */
    content: string;
    /* */
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    /* */
    importance: number;
    /* */
    episodeType: string | null;
    /* */
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

interface CompartmentRowShared {
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
    created_at: number;
}

interface CompartmentRow extends CompartmentRowShared {
    legacy: number | null;
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

function isCompartmentRowShared(row: unknown): row is CompartmentRowShared {
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
        typeof candidate.created_at === "number"
    );
}

function isCompartmentRow(row: unknown): row is CompartmentRow {
    if (!isCompartmentRowShared(row)) return false;
    return isNumberOrNullish((row as unknown as Record<string, unknown>).legacy);
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
    /* */
    content: string;
    /* */
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    /* */
    importance?: number | null;
    /* */
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
 *
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
            } catch {}
        }
    }
}

export interface CompartmentDateRanges {
    /* */
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

export interface RecompStaging {
    compartments: CompartmentInput[];
    facts: Array<{ category: string; content: string }>;
    passCount: number;
    lastEndMessage: number;
}

/* */
export function saveRecompStagingPass(
    db: Database,
    sessionId: string,
    passNumber: number,
    compartments: CompartmentInput[],
    facts: Array<{ category: string; content: string }>,
): void {
    const now = Date.now();
    db.transaction(() => {
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

/* */
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

/* */
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
            } catch {}
        }
    }
}

/* */
export function clearRecompStaging(db: Database, sessionId: string): void {
    db.transaction(() => {
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);
        try {
            db.prepare(
                "UPDATE session_meta SET recomp_partial_range_start = 0, recomp_partial_range_end = 0 WHERE session_id = ?",
            ).run(sessionId);
        } catch {}
    })();
}

/**
 *
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
 */
export function setRecompPartialRange(
    db: Database,
    sessionId: string,
    range: { start: number; end: number } | null,
): void {
    const start = range ? range.start : 0;
    const end = range ? range.end : 0;
    db.prepare("INSERT OR IGNORE INTO session_meta (session_id) VALUES (?)").run(sessionId);
    db.prepare(
        "UPDATE session_meta SET recomp_partial_range_start = ?, recomp_partial_range_end = ? WHERE session_id = ?",
    ).run(start, end, sessionId);
}

interface RecompCompartmentRow extends CompartmentRowShared {
    pass_number: number;
}

function isRecompCompartmentRow(row: unknown): row is RecompCompartmentRow {
    if (!isCompartmentRowShared(row)) return false;
    return typeof (row as unknown as Record<string, unknown>).pass_number === "number";
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
