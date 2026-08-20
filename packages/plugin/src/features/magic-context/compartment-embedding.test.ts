/// <reference types="bun-types" />

import { describe, expect, spyOn, test } from "bun:test";
import * as loggerModule from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { embedAndStoreCompartmentChunks } from "./compartment-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import { runMigrations } from "./migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    getProjectEmbeddingSnapshot,
    registerProjectEmbedding,
} from "./project-embedding-registry";
import { initializeDatabase } from "./storage-db";
import {
    DetailedSynapseTestHost,
    detailedSynapseTestProvider,
    synapseTestConfig,
} from "./synapse-detailed-test-support";

function createDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function registerDetailedChunkProject(
    db: Database,
    projectIdentity: string,
    host: DetailedSynapseTestHost,
): string {
    _setTestProviderFactoryForProject((config) =>
        config.provider === "synapse" ? detailedSynapseTestProvider(host) : null,
    );
    registerProjectEmbedding(
        db,
        projectIdentity,
        synapseTestConfig(),
        { memoryEnabled: true, gitCommitEnabled: false },
        "/tmp/compartment-embedding-detailed",
    );
    return getProjectEmbeddingSnapshot(projectIdentity)?.chunkModelId ?? "off";
}

function seedCompartment(db: Database, sessionId: string): number {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "u1",
            endMessageId: "a2",
            title: "Detailed lane span",
            content: "P1 content",
            p1: "P1 content",
        },
    ]);
    return getCompartments(db, sessionId)[0].id;
}

function chunkRowCount(db: Database, compartmentId: number): number {
    return (
        db
            .prepare(
                "SELECT COUNT(*) AS count FROM compartment_chunk_embeddings WHERE compartment_id = ?",
            )
            .get(compartmentId) as { count: number }
    ).count;
}

function ledgerRows(db: Database): Array<{ application_group: string; state: string }> {
    return db
        .prepare("SELECT application_group, state FROM synapse_batch_ledger ORDER BY id")
        .all() as Array<{ application_group: string; state: string }>;
}

describe("publish path over a journaling synapse lane", () => {
    test("a lane that applies nothing is logged and does not fall back to the legacy path", async () => {
        const db = createDb();
        const sessionLog = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
        try {
            const host = new DetailedSynapseTestHost();
            registerDetailedChunkProject(db, "git:chunk-unapplied", host);
            const compartmentId = seedCompartment(db, "ses-unapplied");
            // Every result page is malformed, so no page yields a receipt and no
            // receipt group covers the compartment's windows.
            host.resultPages = () => {
                const error = new Error("malformed page") as Error & { code: string };
                error.code = "schema_violation";
                return error;
            };

            await embedAndStoreCompartmentChunks(db, "ses-unapplied", "git:chunk-unapplied", [
                {
                    id: compartmentId,
                    startMessage: 1,
                    endMessage: 2,
                    sourceChunkText: "[1] U: hello\n[2] A: world",
                },
            ]);

            expect(
                sessionLog.mock.calls.some(
                    (call) =>
                        call[0] === "ses-unapplied" &&
                        typeof call[1] === "string" &&
                        call[1].includes(`compartment ${compartmentId}`) &&
                        call[1].includes("no receipt group covered its windows"),
                ),
            ).toBe(true);
            // Receipt-less destination rows are the split state the ledger
            // exists to prevent, so the legacy path stays out of this compartment.
            expect(chunkRowCount(db, compartmentId)).toBe(0);
            // The ledger owns the outcome: a page recorded against this
            // compartment is what makes the lane's answer `false` rather than the
            // `null` that hands the compartment to the legacy path.
            expect(ledgerRows(db)).toEqual([
                { application_group: `compartment:${compartmentId}`, state: "failed" },
            ]);
        } finally {
            sessionLog.mockRestore();
            _resetProjectEmbeddingRegistryForTests();
            closeQuietly(db);
        }
    });
});
