import { afterEach, describe, expect, test } from "bun:test";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertCompartmentEvents } from "../compartment-events";
import { ANTI_MEMORY_DEFAULT_TTL_MS, readAntiMemory } from "../memory/storage-anti-memory";
import { createClaimReaderTestDatabase } from "../test-claim-database";
import {
    countPendingCorrectionEvents,
    harvestAntiMemoriesFromCorrections,
} from "./anti-memory-from-corrections";

const PROJECT = "git:correction-harvest";
let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function seedSession(
    database: Database,
    sessionId: string,
    userText: string,
    userOrdinal = 1,
): number {
    database
        .prepare(
            "INSERT INTO session_projects (session_id, project_path, updated_at, harness) VALUES (?, ?, ?, 'opencode')",
        )
        .run(sessionId, PROJECT, 1);
    database
        .prepare(
            `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
             title, content, p1, p2, p3, p4, importance, episode_type, created_at, harness)
         VALUES (?, 1, 1, 2, 'u1', 'a1', 'pivot', 'pivot', 'pivot', '', '', '', 80, 'design', 1, 'opencode')`,
        )
        .run(sessionId);
    const compartmentId = Number(
        (
            database.prepare("SELECT id FROM compartments WHERE session_id = ?").get(sessionId) as {
                id: number;
            }
        ).id,
    );
    database
        .prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, 'u1', 'user', ?)",
        )
        .run(sessionId, userOrdinal, userText);
    // Production indexes both tables together in `message-index.ts`.
    // Corroboration joins both tables by harness to scope message text.
    // Corroboration finds no user text when the fixture omits `message_history_source`.
    database
        .prepare(
            `INSERT INTO message_history_source
                (session_id, message_id, message_ordinal, source_version,
                 normalized_content_hash, role, harness, updated_at)
             VALUES (?, 'u1', ?, 'v1', ?, 'user', 'opencode', 1)`,
        )
        .run(sessionId, userOrdinal, `hash-${sessionId}-${userOrdinal}`);
    // The index records its reconciled ordinal; corroboration rejects spans beyond it.
    database
        .prepare(
            `INSERT INTO message_history_index
                (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness)
             VALUES (?, ?, 0, 1, 'opencode')
             ON CONFLICT(session_id) DO UPDATE SET
                 last_indexed_ordinal = MAX(message_history_index.last_indexed_ordinal, excluded.last_indexed_ordinal)`,
        )
        // The fixture marks ordinal 2 as indexed because the compartment ends at message 2.
        // The reconciliation check requires the compartment's full 1-2 message span to be searchable.
        .run(sessionId, Math.max(userOrdinal, 2));
    return compartmentId;
}

function correctionFields(overrides: Record<string, string> = {}): Record<string, string> {
    return {
        summary: "Choosing a durable session cache backend",
        before_strategy: "Use Redis for session cache storage",
        correction_source: "user",
        correction_signal: 'U: "Never persist this quote"',
        after_strategy: "Use the existing SQLite store",
        evidence: "The cache must remain offline capable",
        reason_for_change: "Redis would add a network dependency this project cannot assume",
        ...overrides,
    };
}

function runHarvest(nowMs?: number) {
    return db
        ?.transaction(() =>
            harvestAntiMemoriesFromCorrections({
                db: db as Database,
                projectIdentity: PROJECT,
                ...(nowMs === undefined ? {} : { nowMs }),
            }),
        )
        .immediate();
}

describe("historian trajectory-correction anti-memory harvest", () => {
    test("corroborates explicit user trust without persisting correction_signal or the evidence quote", () => {
        db = createClaimReaderTestDatabase();
        const compartmentId = seedSession(
            db,
            "ses-user",
            "The cache must remain offline capable, so use SQLite.",
        );
        insertCompartmentEvents(
            db,
            "ses-user",
            [{ kind: "trajectory_correction", atCompartment: 1, fields: correctionFields() }],
            [compartmentId],
        );
        expect(countPendingCorrectionEvents(db, PROJECT)).toBe(1);

        const result = runHarvest();
        expect(result).toMatchObject({ consumed: 1, skipped: 0 });
        expect(countPendingCorrectionEvents(db, PROJECT)).toBe(0);
        const publicClaimId = (
            db.prepare("SELECT public_id AS id FROM claim_public_ids LIMIT 1").get() as {
                id: string;
            }
        ).id;
        const anti = readAntiMemory(db, publicClaimId);
        expect(anti?.payload.rejectionReason).toBe(
            "Redis would add a network dependency this project cannot assume",
        );
        // The user's words corroborate trust but must never be persisted.
        // The harvester must not persist `correction_signal` or the verbatim `evidence` quote.
        expect(JSON.stringify(anti)).not.toContain("Never persist this quote");
        expect(JSON.stringify(anti)).not.toContain("must remain offline capable");
        expect(
            db
                .prepare(
                    `SELECT o.source_trust_class AS trust
                   FROM claim_evidence e JOIN observations o ON o.id = e.observation_id
                  WHERE e.revision_id = (SELECT current_revision_id FROM claims LIMIT 1)`,
                )
                .get(),
        ).toEqual({ trust: "explicit_user" });
    });

    test("rejects a rejection reason transcribed from the user's own words", () => {
        db = createClaimReaderTestDatabase();
        const compartmentId = seedSession(
            db,
            "ses-transcribed",
            "The cache must remain offline capable, so use SQLite.",
        );
        insertCompartmentEvents(
            db,
            "ses-transcribed",
            [
                {
                    kind: "trajectory_correction",
                    atCompartment: 1,
                    // A present `reason_for_change` lets the payload map before the privacy gate rejects it.
                    // The source-overlap privacy gate must reject the verbatim causal reason.
                    fields: correctionFields({
                        reason_for_change: "The cache must remain offline capable",
                    }),
                },
            ],
            [compartmentId],
        );
        expect(runHarvest()).toEqual({ consumed: 0, skipped: 1, effects: [] });
        expect(db.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });
    });

    test("skips a correction carrying proof of the pivot but no causal reason", () => {
        db = createClaimReaderTestDatabase();
        const compartmentId = seedSession(
            db,
            "ses-no-reason",
            "Some unrelated user message that overlaps nothing.",
        );
        insertCompartmentEvents(
            db,
            "ses-no-reason",
            [
                {
                    kind: "trajectory_correction",
                    atCompartment: 1,
                    // `evidence` proves that the pivot occurred; it does not state why the old strategy was wrong.
                    // Without `reason_for_change`, no causal reason is available to persist.
                    // The harvester must skip an event without `reason_for_change` rather than persist `evidence` as the reason.
                    fields: correctionFields({
                        reason_for_change: "",
                        evidence: "The final implementation now uses the existing SQLite store",
                    }),
                },
            ],
            [compartmentId],
        );
        expect(runHarvest()).toEqual({ consumed: 0, skipped: 1, effects: [] });
        expect(db.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });
        // The harvester must not persist the corroborating user text.
        expect(
            db
                .prepare("SELECT COUNT(*) AS count FROM observations WHERE extracted_text LIKE ?")
                .get("%final implementation now uses%"),
        ).toEqual({ count: 0 });
    });

    test("does not let a forged ord_span widen corroboration beyond the compartment", () => {
        db = createClaimReaderTestDatabase();
        // The corroborating user message is at ordinal 5, outside the compartment's 1-2 range.
        // The compartment's host-recorded message range is 1-2.
        const compartmentId = seedSession(
            db,
            "ses-span",
            "The cache must remain offline capable, so use SQLite.",
            5,
        );
        insertCompartmentEvents(
            db,
            "ses-span",
            [
                {
                    kind: "trajectory_correction",
                    atCompartment: 1,
                    fields: correctionFields({ ord_span: "1-9007199254740991" }),
                },
            ],
            [compartmentId],
        );
        expect(runHarvest()).toMatchObject({ consumed: 1, skipped: 0 });
        expect(
            db.prepare("SELECT source_trust_class AS trust FROM observations LIMIT 1").get(),
        ).toEqual({ trust: "model_inference" });
    });

    test("skips events whose event-anchored TTL already expired", () => {
        db = createClaimReaderTestDatabase();
        const compartmentId = seedSession(db, "ses-expired", "Unrelated user request");
        insertCompartmentEvents(
            db,
            "ses-expired",
            [{ kind: "trajectory_correction", atCompartment: 1, fields: correctionFields() }],
            [compartmentId],
        );
        const afterExpiry = Date.now() + ANTI_MEMORY_DEFAULT_TTL_MS + 1;
        expect(runHarvest(afterExpiry)).toEqual({ consumed: 0, skipped: 1, effects: [] });
        expect(db.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });
        expect(countPendingCorrectionEvents(db, PROJECT)).toBe(0);
    });

    test("downgrades forged user source and receipts poison skips without blocking", () => {
        db = createClaimReaderTestDatabase();
        const compartmentId = seedSession(db, "ses-forged", "Unrelated user request");
        insertCompartmentEvents(
            db,
            "ses-forged",
            [
                {
                    kind: "trajectory_correction",
                    atCompartment: 1,
                    fields: correctionFields({ summary: 'invalid "quoted" summary' }),
                },
                {
                    kind: "trajectory_correction",
                    atCompartment: 1,
                    fields: correctionFields({ summary: "A valid later correction" }),
                },
            ],
            [compartmentId],
        );
        const first = runHarvest();
        expect(first).toMatchObject({ consumed: 1, skipped: 1 });
        expect(runHarvest()).toEqual({ consumed: 0, skipped: 0, effects: [] });
        expect(db.prepare("SELECT COUNT(*) AS count FROM claim_operation_receipts").get()).toEqual({
            count: 2,
        });
        expect(
            db.prepare("SELECT source_trust_class AS trust FROM observations LIMIT 1").get(),
        ).toEqual({ trust: "model_inference" });
    });

    test("skips a correction whose span the message index has not reconciled", () => {
        db = createClaimReaderTestDatabase();
        const userText = "keep the cache offline capable for air-gapped installs";
        const compartmentId = seedSession(db, "ses-unindexed", userText);
        // The fixture omits FTS rows and leaves a dirty floor within the span to model an unreconciled index.
        // The valid span requires reconciliation to reject the unreconciled index state.
        // Without the reconciliation check, an empty source-text list makes source-overlap pass vacuously.
        // A vacuous source-overlap pass would persist the transcription.
        db.prepare("DELETE FROM message_history_fts WHERE session_id = ?").run("ses-unindexed");
        db.prepare("DELETE FROM message_history_source WHERE session_id = ?").run("ses-unindexed");
        db.prepare(
            "UPDATE message_history_index SET dirty_floor_ordinal = 1 WHERE session_id = ?",
        ).run("ses-unindexed");
        insertCompartmentEvents(
            db,
            "ses-unindexed",
            [
                {
                    kind: "trajectory_correction",
                    atCompartment: 1,
                    // The text is verbatim user content without quote marks, a date, or a frustration marker.
                    // Only source-overlap can reject the text.
                    // An unindexed compartment span prevents source-overlap from rejecting verbatim user text.
                    fields: correctionFields({ reason_for_change: userText }),
                },
            ],
            [compartmentId],
        );

        expect(runHarvest()).toEqual({ consumed: 0, skipped: 1, effects: [] });
        expect(db.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });
    });

    test("skips a correction with no authoritative span instead of persisting it unchecked", () => {
        db = createClaimReaderTestDatabase();
        const userText = "We must keep the cache offline capable for air-gapped installs";
        seedSession(db, "ses-dangling", userText);
        // A null `compartment_id` represents an unresolved anchor.
        // A compartment recomputation can leave a dangling `compartment_id`.
        // Unknown compartment bounds provide no source texts.
        // The source-overlap privacy-gate arm cannot run without compartment bounds.
        db.prepare(
            `INSERT INTO compartment_events
                (session_id, compartment_id, kind, at_compartment, fields_json, created_at, harness)
             VALUES (?, NULL, 'trajectory_correction', 1, ?, ?, 'opencode')`,
        ).run(
            "ses-dangling",
            // passes it.
            JSON.stringify(correctionFields({ reason_for_change: userText })),
            Date.now(),
        );

        expect(runHarvest()).toEqual({ consumed: 0, skipped: 1, effects: [] });
        expect(db.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });
        expect(
            db
                .prepare("SELECT COUNT(*) AS count FROM observations WHERE extracted_text LIKE ?")
                .get("%air-gapped installs%"),
        ).toEqual({ count: 0 });
    });

    test("never corroborates trust from another harness's messages on the same session id", () => {
        db = createClaimReaderTestDatabase();
        const evidenceQuote = "the cache must remain offline capable for air-gapped installs";
        // The event belongs to opencode and its own span carries no user message.
        const compartmentId = seedSession(db, "ses-xh", "unrelated opencode chatter", 1);
        db.prepare("DELETE FROM message_history_fts WHERE session_id = ?").run("ses-xh");
        db.prepare("DELETE FROM message_history_source WHERE session_id = ?").run("ses-xh");
        // The `pi` message is in the event's ordinal span, but the `opencode` harvest must not read it.
        db.prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, 1, 'pi1', 'user', ?)",
        ).run("ses-xh", evidenceQuote);
        db.prepare(
            `INSERT INTO message_history_source
                (session_id, message_id, message_ordinal, source_version,
                 normalized_content_hash, role, harness, updated_at)
             VALUES (?, 'pi1', 1, 'v1', 'h', 'user', 'pi', 1)`,
        ).run("ses-xh");
        insertCompartmentEvents(
            db,
            "ses-xh",
            [
                {
                    kind: "trajectory_correction",
                    atCompartment: 1,
                    fields: correctionFields({ evidence: evidenceQuote }),
                },
            ],
            [compartmentId],
        );

        expect(runHarvest()).toMatchObject({ consumed: 1, skipped: 0 });
        // `source_trust_class` remains `model_inference` because only the `pi` message matches `evidenceQuote`.
        expect(
            db.prepare("SELECT source_trust_class AS trust FROM observations LIMIT 1").get(),
        ).toEqual({ trust: "model_inference" });
    });

    test("never harvests an event whose harness binds the session to another project", () => {
        db = createClaimReaderTestDatabase();
        const compartmentId = seedSession(db, "ses-shared", "Unrelated user message.");
        db.prepare(
            "INSERT INTO session_projects (session_id, project_path, updated_at, harness) VALUES (?, ?, ?, 'pi')",
        ).run("ses-shared", "git:someone-elses-project", 1);
        // The event belongs to the pi binding, so it is the other project's event.
        db.prepare(
            `INSERT INTO compartment_events
                (session_id, compartment_id, kind, at_compartment, fields_json, created_at, harness)
             VALUES (?, ?, 'trajectory_correction', 1, ?, 1, 'pi')`,
        ).run("ses-shared", compartmentId, JSON.stringify(correctionFields()));

        expect(countPendingCorrectionEvents(db, PROJECT)).toBe(0);
        expect(runHarvest()).toEqual({ consumed: 0, skipped: 0, effects: [] });
        expect(db.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });
        // Receipts must include the project or harness; a global `event:<id>` receipt would consume the other project's event.
        expect(db.prepare("SELECT COUNT(*) AS count FROM claim_operation_receipts").get()).toEqual({
            count: 0,
        });
        expect(countPendingCorrectionEvents(db, "git:someone-elses-project")).toBe(1);
    });
});
