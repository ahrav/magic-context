/**
 *
 * The seed provides orientation, not answer content.
 *
 * TC: lines include tool-call inputs, not outputs.
 *
 * The builder uses the origin compartment's P1 when the raw range is empty.
 */
import {
    cleanUserText,
    readRawSessionMessages,
} from "../../../hooks/magic-context/read-session-chunk";
import {
    estimateTokens,
    extractTexts,
    extractToolCallSummaries,
    hasMeaningfulUserText,
    normalizeText,
} from "../../../hooks/magic-context/read-session-formatting";
import type { RawMessage } from "../../../hooks/magic-context/read-session-raw";
import type { Database } from "../../../shared/sqlite";
import { getPrimerCandidatesByIds, type Primer } from "../storage-primers";

/**
 * */
export const PRIMER_SEED_CAP_TOKENS = 4000;

export interface PrimerSeed {
    /** `"raw"` uses U:/TC: orientation from the origin compartment.
     * `"closed-book"` uses the origin compartment's P1 when raw data is unavailable. */
    kind: "raw" | "closed-book";
    /* */
    orientation: string;
    /** `prePost` stores P1, or content when P1 is null, from adjacent sequence numbers. */
    prePost: string;
    /* */
    sessionId: string | null;
}

interface CompartmentP1Row {
    sequence: number;
    start_message: number;
    end_message: number;
    title: string;
    p1: string | null;
    content: string | null;
}

/**
 * The renderer appends a truncation notice when adding a noninitial line would exceed capTokens.
 * The renderer structurally excludes assistant narrative.
 */
function renderUserAndToolOrientation(
    messages: RawMessage[],
    startOrdinal: number,
    endOrdinal: number,
    capTokens: number,
): string {
    const lines: string[] = [];
    let tokens = 0;
    for (const msg of messages) {
        if (msg.ordinal < startOrdinal || msg.ordinal > endOrdinal) continue;
        const out: string[] = [];
        if (msg.role === "user" && hasMeaningfulUserText(msg.parts)) {
            const text = extractTexts(msg.parts)
                .map((t) => cleanUserText(t))
                .map(normalizeText)
                .filter((t) => t.length > 0)
                .join(" / ");
            if (text) out.push(`U: ${text}`);
        }
        // TC: lines include tool-call inputs from assistant tool-use and tool-result user messages, not outputs.
        for (const tc of extractToolCallSummaries(msg.parts)) out.push(tc);
        for (const line of out) {
            const lineTokens = estimateTokens(line);
            if (tokens + lineTokens > capTokens && lines.length > 0) {
                lines.push("… (orientation truncated; investigate the current source directly)");
                return lines.join("\n");
            }
            lines.push(line);
            tokens += lineTokens;
        }
    }
    return lines.join("\n");
}

function loadPrePostP1(db: Database, sessionId: string, originStartMessage: number): string {
    const origin = db
        .prepare(
            "SELECT sequence FROM compartments WHERE session_id = ? AND start_message = ? ORDER BY sequence ASC LIMIT 1",
        )
        .get(sessionId, originStartMessage) as { sequence?: number } | undefined;
    if (typeof origin?.sequence !== "number") return "";
    const originSeq = origin.sequence;
    const rows = db
        .prepare(
            `SELECT sequence, start_message, end_message, title, p1, content
             FROM compartments
             WHERE session_id = ? AND sequence IN (?, ?)
             ORDER BY sequence ASC`,
        )
        .all(sessionId, originSeq - 1, originSeq + 1) as CompartmentP1Row[];
    if (rows.length === 0) return "";
    return rows
        .map((r) => {
            const body = (r.p1 ?? r.content ?? "").slice(0, 1200);
            const label = r.sequence < originSeq ? "before" : "after";
            return `- (${label}) ${r.title}: ${body}`;
        })
        .join("\n");
}

function closedBookOriginP1(
    db: Database,
    sessionId: string,
    originStartMessage: number,
): { orientation: string; sessionId: string } {
    const row = db
        .prepare(
            "SELECT title, p1, content FROM compartments WHERE session_id = ? AND start_message = ? ORDER BY sequence ASC LIMIT 1",
        )
        .get(sessionId, originStartMessage) as
        | { title?: string; p1?: string | null; content?: string | null }
        | undefined;
    const body = (row?.p1 ?? row?.content ?? "").slice(0, 2000);
    const orientation = row?.title ? `${row.title}: ${body}` : body;
    return { orientation, sessionId };
}

/**
 * The builder uses the primer's most-recent occurrence's origin compartment for its orientation seed.
 * Callers must invoke this function within a `withRawSessionMessageCache` scope.
 * Callers on Pi must register a RawMessageProvider for the session so the scope can cache raw-message reads.
 * A `withRawSessionMessageCache` scope caches raw-message reads for all calls within its callback.
 */
export function buildPrimerSeed(db: Database, primer: Primer): PrimerSeed {
    const candidates = getPrimerCandidatesByIds(db, primer.sourceCandidateIds);
    // Most-recent occurrence drives the seed.
    const mostRecent = candidates
        .slice()
        .sort((a, b) => b.sourceMessageTime - a.sourceMessageTime || b.id - a.id)[0];
    if (
        !mostRecent ||
        typeof mostRecent.sourceCompartmentStart !== "number" ||
        typeof mostRecent.sourceCompartmentEnd !== "number"
    ) {
        return { kind: "closed-book", orientation: "", prePost: "", sessionId: null };
    }

    const sessionId = mostRecent.sessionId;
    const start = mostRecent.sourceCompartmentStart;
    const end = mostRecent.sourceCompartmentEnd;

    let raw: RawMessage[] = [];
    try {
        raw = readRawSessionMessages(sessionId);
    } catch {
        raw = [];
    }
    const inRange = raw.some((m) => m.ordinal >= start && m.ordinal <= end);
    if (!inRange) {
        // For deleted sessions or Pi sessions without a registered provider, the builder falls back to the origin compartment's P1 instead of returning an empty orientation.
        const closed = closedBookOriginP1(db, sessionId, start);
        return {
            kind: "closed-book",
            orientation: closed.orientation,
            prePost: loadPrePostP1(db, sessionId, start),
            sessionId,
        };
    }

    const orientation = renderUserAndToolOrientation(raw, start, end, PRIMER_SEED_CAP_TOKENS);
    return {
        kind: "raw",
        orientation,
        prePost: loadPrePostP1(db, sessionId, start),
        sessionId,
    };
}
