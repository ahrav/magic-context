import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";

/**
 * Compartment events storage (v2 / E2).
 *
 * The historian extracts discrete events (`causal_incident`,
 * `trajectory_correction`, and any future kinds) while compartmentalizing. v2.0
 * STORES these events but does NOT render them — they are a corpus for a future
 * dreamer aggregation/steering feature (cross-session pattern detection). Parsed
 * kind-agnostically (`kind` = element name, `fields` = child elements), so a new
 * event kind or field needs no schema change — `fields` round-trips as JSON.
 *
 * Anchoring: `at_compartment="N"` is a 1-based index INTO THE CURRENT PUBLISH's
 * emitted compartment list. We resolve it to the `compartment_id` of the matching
 * persisted row at store time. When resolution fails (out-of-range index, e.g. an
 * event anchored to a discard-last compartment), `compartment_id` is NULL and we
 * keep the raw `at_compartment` for debugging.
 *
 * Durability caveat: `compartment_id` is a bare INTEGER (no FK). It points at the
 * compartment row that existed at store time. Full/partial recomp deletes and
 * re-inserts compartment rows, so a stored `compartment_id` can become stale
 * (dangling) after recomp. This is acceptable for v2.0 because events are
 * STORED-ONLY (not rendered or consumed yet); the future dreamer aggregation
 * feature that reads events must re-anchor or tolerate dangling ids. Do NOT rely
 * on `compartment_id` surviving recomp.
 */

export interface CompartmentEventInput {
    /** Event element name, e.g. "causal_incident" | "trajectory_correction". */
    kind: string;
    /** 1-based index into the publish's emitted compartments; null if absent/invalid. */
    atCompartment: number | null;
    /** Child elements verbatim (e.g. trigger, implication). */
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
}

/**
 * Persist historian-extracted events for a publish.
 *
 * @param compartmentIds durable compartment ids for the publish's emitted
 *   compartments, in emission order (index i → the (i+1)-th emitted compartment).
 *   Used to resolve `at_compartment` (1-based) to a durable `compartment_id`.
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
        // at_compartment is 1-based into the emitted list; map to durable id.
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

/** Load all stored events for a session (newest first). For diagnostics / future dreamer aggregation. */
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
 * Read project-scoped events oldest first for idempotent background consumers.
 *
 * `pendingForProducer` excludes events the producer already receipted under the
 * `event:<id>` operation-key convention, so consumed events are never re-read
 * and per-call cost stays proportional to the unconsumed backlog rather than
 * project lifetime. `limit` bounds one call so a large backlog drains across
 * runs instead of inside one long write transaction.
 *
 * The `session_projects` join must match on harness as well as session id.
 * That table is keyed `(session_id, harness)`, so one session id can carry a
 * different project binding per harness; joining on session id alone attributes
 * an event to BOTH bindings. Since the receipt key is `event:<id>` and is not
 * project-scoped, the first project to harvest such an event writes it into its
 * own durable memory and receipts it globally, so the owning project never sees
 * it. Cross-harness leakage is a correctness bug, not a feature.
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
                    compartments.start_message, compartments.end_message
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
        // corrupt row — return empty rather than throw on a read path
    }
    return {};
}
