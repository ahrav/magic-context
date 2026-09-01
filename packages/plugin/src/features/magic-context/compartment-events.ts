import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";

/**
 *
 * `kind` stores the element name and `fields` stores child elements as JSON; new kinds and fields require no schema change.
 *
 * `atCompartment` is a 1-based index into the current publish's emitted compartments.
 * `atCompartment` resolves to the durable ID of the matching emitted compartment.
 * `compartmentId` is `null` when `atCompartment` is less than 1 or exceeds the emitted-compartment count.
 * The row retains raw `at_compartment` when resolution fails.
 *
 */

export interface CompartmentEventInput {
    /** `kind` stores the event element name, such as "causal_incident" or "trajectory_correction". */
    kind: string;
    /** `atCompartment` is a 1-based index into the publish's emitted compartments. */
    atCompartment: number | null;
    /** `fields` stores child elements verbatim, such as `trigger` and `implication`. */
    fields: Record<string, string>;
}

export interface StoredCompartmentEvent extends CompartmentEventInput {
    id: number;
    sessionId: string;
    compartmentId: number | null;
    createdAt: number;
}

export interface ProjectCompartmentEvent extends StoredCompartmentEvent {
    compartmentStartMessage: number | null;
    compartmentEndMessage: number | null;
    /**
     * The event's `harness` is required when reading rows keyed by `sessionId`.
     * A `sessionId` can occur in different projects under different harnesses.
     * A join on `sessionId` alone can read rows from another project.
     * project's rows.
     */
    harness: string;
}

/**
 *
 * `compartmentIds` contains durable IDs for the publish's emitted compartments in emission order; index `i` identifies emitted compartment `i + 1`.
 */
export function insertCompartmentEvents(
    db: Database,
    sessionId: string,
    events: readonly CompartmentEventInput[],
    compartmentIds: readonly number[],
): void {
    if (events.length === 0) return;
    const now = Date.now();
    const harness = getHarness();
    const stmt = db.prepare(
        "INSERT INTO compartment_events (session_id, compartment_id, kind, at_compartment, fields_json, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const ev of events) {
        const idx = ev.atCompartment != null && ev.atCompartment >= 1 ? ev.atCompartment - 1 : -1;
        const compartmentId = idx >= 0 && idx < compartmentIds.length ? compartmentIds[idx] : null;
        stmt.run(
            sessionId,
            compartmentId,
            ev.kind,
            ev.atCompartment,
            JSON.stringify(ev.fields ?? {}),
            now,
            harness,
        );
    }
}

/* */
export function getCompartmentEvents(db: Database, sessionId: string): StoredCompartmentEvent[] {
    const rows = db
        .prepare(
            "SELECT id, session_id, compartment_id, kind, at_compartment, fields_json, created_at FROM compartment_events WHERE session_id = ? ORDER BY id DESC",
        )
        .all(sessionId) as Array<{
        id: number;
        session_id: string;
        compartment_id: number | null;
        kind: string;
        at_compartment: number | null;
        fields_json: string;
        created_at: number;
    }>;
    return rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        compartmentId: r.compartment_id,
        kind: r.kind,
        atCompartment: r.at_compartment,
        fields: parseFields(r.fields_json),
        createdAt: r.created_at,
    }));
}

/**
 * `getProjectCompartmentEvents` returns project-scoped events oldest first for idempotent background consumers.
 *
 * `pendingForProducer` excludes events with a matching `event:<id>` receipt for that producer.
 *
 * `event:<id>` receipt keys do not include `projectIdentity`.
 */
export function getProjectCompartmentEvents(
    db: Database,
    projectIdentity: string,
    kind: string,
    options: { pendingForProducer?: string; limit?: number } = {},
): ProjectCompartmentEvent[] {
    const receiptFilter = options.pendingForProducer
        ? `AND NOT EXISTS (
               SELECT 1 FROM claim_operation_receipts receipts
                WHERE receipts.producer = ?
                  AND receipts.operation_key = 'event:' || events.id
           )`
        : "";
    const params: Array<string | number> = [projectIdentity, kind];
    if (options.pendingForProducer) params.push(options.pendingForProducer);
    let limitClause = "";
    if (options.limit !== undefined) {
        limitClause = "LIMIT ?";
        params.push(options.limit);
    }
    const rows = db
        .prepare(
            `SELECT DISTINCT events.id, events.session_id, events.compartment_id, events.kind,
                    events.at_compartment, events.fields_json, events.created_at,
                    events.harness, compartments.start_message, compartments.end_message
               FROM compartment_events events
               JOIN session_projects projects
                 ON projects.session_id = events.session_id
                AND projects.harness = events.harness
               LEFT JOIN compartments
                 ON compartments.id = events.compartment_id
                AND compartments.session_id = events.session_id
                AND compartments.harness = events.harness
              WHERE projects.project_path = ? AND events.kind = ?
                ${receiptFilter}
              ORDER BY events.id ASC
              ${limitClause}`,
        )
        .all(...params) as Array<{
        id: number;
        session_id: string;
        compartment_id: number | null;
        kind: string;
        at_compartment: number | null;
        fields_json: string;
        created_at: number;
        harness: string;
        start_message: number | null;
        end_message: number | null;
    }>;
    return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        compartmentId: row.compartment_id,
        kind: row.kind,
        atCompartment: row.at_compartment,
        fields: parseFields(row.fields_json),
        createdAt: row.created_at,
        harness: row.harness,
        compartmentStartMessage: row.start_message,
        compartmentEndMessage: row.end_message,
    }));
}

function parseFields(json: string): Record<string, string> {
    try {
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === "string") out[k] = v;
            }
            return out;
        }
    } catch {
        // `parseFields` returns `{}` for invalid JSON so event reads do not throw.
    }
    return {};
}
