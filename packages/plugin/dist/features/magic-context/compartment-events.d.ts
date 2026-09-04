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
    /**
     * Harness that wrote the event. Required to read anything else keyed by
     * session id: the same session id can belong to a different project per
     * harness, so a consumer joining on session id alone reads another
     * project's rows.
     */
    harness: string;
}
/**
 * Persist historian-extracted events for a publish.
 *
 * @param compartmentIds durable compartment ids for the publish's emitted
 *   compartments, in emission order (index i → the (i+1)-th emitted compartment).
 *   Used to resolve `at_compartment` (1-based) to a durable `compartment_id`.
 */
export declare function insertCompartmentEvents(db: Database, sessionId: string, events: readonly CompartmentEventInput[], compartmentIds: readonly number[]): void;
/** Load all stored events for a session (newest first). For diagnostics / future dreamer aggregation. */
export declare function getCompartmentEvents(db: Database, sessionId: string): StoredCompartmentEvent[];
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
export declare function getProjectCompartmentEvents(db: Database, projectIdentity: string, kind: string, options?: {
    pendingForProducer?: string;
    limit?: number;
}): ProjectCompartmentEvent[];
//# sourceMappingURL=compartment-events.d.ts.map