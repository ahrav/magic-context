import { afterEach, describe, expect, test } from "bun:test";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertCompartmentEvents } from "../compartment-events";
import { readAntiMemory } from "../memory/storage-anti-memory";
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

function seedSession(database: Database, sessionId: string, userText: string): number {
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
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, 1, 'u1', 'user', ?)",
        )
        .run(sessionId, userText);
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
        ...overrides,
    };
}

describe("historian trajectory-correction anti-memory harvest", () => {
    test("corroborates explicit user trust without persisting correction_signal", () => {
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

        const result = db
            .transaction(() =>
                harvestAntiMemoriesFromCorrections({
                    db: db as Database,
                    projectIdentity: PROJECT,
                }),
            )
            .immediate();
        expect(result).toMatchObject({ consumed: 1, skipped: 0 });
        expect(countPendingCorrectionEvents(db, PROJECT)).toBe(0);
        const publicClaimId = (
            db.prepare("SELECT public_id AS id FROM claim_public_ids LIMIT 1").get() as {
                id: string;
            }
        ).id;
        const anti = readAntiMemory(db, publicClaimId);
        expect(anti?.payload.rejectionReason).toBe("The cache must remain offline capable");
        const persisted = db
            .prepare(
                `SELECT o.extracted_text AS extractedText
                   FROM claim_evidence e JOIN observations o ON o.id = e.observation_id
                  WHERE e.revision_id = (SELECT current_revision_id FROM claims LIMIT 1)`,
            )
            .get();
        expect(JSON.stringify(persisted)).not.toContain("Never persist this quote");
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

    test("keeps non-user corrections as model inference despite matching user evidence", () => {
        db = createClaimReaderTestDatabase();
        const compartmentId = seedSession(
            db,
            "ses-tool-source",
            "The cache must remain offline capable, so use SQLite.",
        );
        insertCompartmentEvents(
            db,
            "ses-tool-source",
            [
                {
                    kind: "trajectory_correction",
                    atCompartment: 1,
                    fields: correctionFields({ correction_source: "tool_result" }),
                },
            ],
            [compartmentId],
        );

        db.transaction(() =>
            harvestAntiMemoriesFromCorrections({ db: db as Database, projectIdentity: PROJECT }),
        ).immediate();
        expect(
            db.prepare("SELECT source_trust_class AS trust FROM observations LIMIT 1").get(),
        ).toEqual({ trust: "model_inference" });
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
        const run = () =>
            db
                ?.transaction(() =>
                    harvestAntiMemoriesFromCorrections({
                        db: db as Database,
                        projectIdentity: PROJECT,
                    }),
                )
                .immediate();
        const first = run();
        expect(first).toMatchObject({ consumed: 1, skipped: 1 });
        expect(run()).toEqual({ consumed: 0, skipped: 0, effects: [] });
        expect(db.prepare("SELECT COUNT(*) AS count FROM claim_operation_receipts").get()).toEqual({
            count: 2,
        });
        expect(
            db.prepare("SELECT source_trust_class AS trust FROM observations LIMIT 1").get(),
        ).toEqual({ trust: "model_inference" });
    });

    test("harvests a bounded batch and leaves later events pending", () => {
        db = createClaimReaderTestDatabase();
        const compartmentId = seedSession(db, "ses-batch", "Unrelated user request");
        insertCompartmentEvents(
            db,
            "ses-batch",
            Array.from({ length: 101 }, (_, index) => ({
                kind: "trajectory_correction",
                atCompartment: 1,
                fields: correctionFields({ summary: `Correction ${index}` }),
            })),
            [compartmentId],
        );

        const run = () =>
            db
                ?.transaction(() =>
                    harvestAntiMemoriesFromCorrections({
                        db: db as Database,
                        projectIdentity: PROJECT,
                    }),
                )
                .immediate();
        expect(countPendingCorrectionEvents(db, PROJECT)).toBe(101);
        expect(run()).toMatchObject({ consumed: 100, skipped: 0 });
        expect(countPendingCorrectionEvents(db, PROJECT)).toBe(1);
        expect(run()).toMatchObject({ consumed: 1, skipped: 0 });
        expect(countPendingCorrectionEvents(db, PROJECT)).toBe(0);
    });
});
