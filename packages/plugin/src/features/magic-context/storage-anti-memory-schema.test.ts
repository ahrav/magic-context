/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { computeClaimOperationRequestDigest } from "./memory/claim-operation-contract";
import {
    runClaimOperation,
    stageCreateProjectMemoryClaimInCurrentTransaction,
} from "./memory/storage-claim-operations";
import { ensureProject } from "./memory/storage-claims";
import { createDirectTestDatabase } from "./test-database";

const INSERT_PAYLOAD = `INSERT INTO claim_anti_memory_revision_payloads
    (revision_id, claim_id, trigger, rejected_strategy, rejection_reason,
     safer_alternative, preconditions, attempted_approach, observed_failure,
     root_cause, recovery, non_applicable_when, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function claimIds(db: ReturnType<typeof createDirectTestDatabase>["db"], publicClaimId: string) {
    return db
        .prepare(
            `SELECT claims.id AS claimId, claims.current_revision_id AS revisionId
               FROM claims JOIN claim_public_ids ON claim_public_ids.claim_id = claims.id
              WHERE claim_public_ids.public_id = ?`,
        )
        .get(publicClaimId) as { claimId: number; revisionId: number };
}

function payloadValues(revisionId: number, claimId: number): unknown[] {
    return [
        revisionId,
        claimId,
        "session caching work",
        "use Redis",
        "operational cost exceeds the benefit",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        100,
    ];
}

let seedCounter = 0;
function seedBareAntiClaim(
    db: ReturnType<typeof createDirectTestDatabase>["db"],
    content: string,
): string {
    seedCounter += 1;
    const projectId = ensureProject(db, "git:anti-schema");
    const operationKey = `anti-schema-${seedCounter}`;
    const result = runClaimOperation(
        db,
        {
            producer: "schema-test",
            operationKey,
            requestDigest: computeClaimOperationRequestDigest({ operationKey }),
        },
        () =>
            stageCreateProjectMemoryClaimInCurrentTransaction(
                db,
                {
                    projectId,
                    category: "REJECTED_APPROACH",
                    content,
                    provenance: {
                        sourceLocator: `test://${operationKey}`,
                        sourceContent: content,
                        extractor: "schema-test",
                        extractorVersion: "1",
                        extractorRunId: operationKey,
                        independenceKey: operationKey,
                    },
                    actor: "schema-test",
                },
                seedCounter,
            ),
        seedCounter,
    );
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

describe("anti-memory payload schema", () => {
    test("stores required warning fields and nullable reserved fields", () => {
        const { db } = createDirectTestDatabase();
        try {
            const publicClaimId = seedBareAntiClaim(db, "Rejected Redis for session caching.");
            const ids = claimIds(db, publicClaimId);
            db.prepare(INSERT_PAYLOAD).run(...payloadValues(ids.revisionId, ids.claimId));

            expect(
                db
                    .prepare(
                        `SELECT trigger, rejected_strategy AS rejectedStrategy,
                                rejection_reason AS rejectionReason, safer_alternative AS saferAlternative,
                                preconditions, attempted_approach AS attemptedApproach,
                                observed_failure AS observedFailure, root_cause AS rootCause,
                                recovery, non_applicable_when AS nonApplicableWhen
                           FROM claim_anti_memory_revision_payloads`,
                    )
                    .get(),
            ).toEqual({
                trigger: "session caching work",
                rejectedStrategy: "use Redis",
                rejectionReason: "operational cost exceeds the benefit",
                saferAlternative: null,
                preconditions: null,
                attemptedApproach: null,
                observedFailure: null,
                rootCause: null,
                recovery: null,
                nonApplicableWhen: null,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects missing warning core and cross-claim revision bindings", () => {
        const { db } = createDirectTestDatabase();
        try {
            const first = seedBareAntiClaim(db, "First rejection.");
            const second = seedBareAntiClaim(db, "Second rejection.");
            const firstIds = claimIds(db, first);
            const secondIds = claimIds(db, second);
            const missingReason = payloadValues(firstIds.revisionId, firstIds.claimId);
            missingReason[4] = null;
            expect(() => db.prepare(INSERT_PAYLOAD).run(...missingReason)).toThrow();

            expect(() =>
                db
                    .prepare(INSERT_PAYLOAD)
                    .run(...payloadValues(firstIds.revisionId, secondIds.claimId)),
            ).toThrow();
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects updates and deletes", () => {
        const { db } = createDirectTestDatabase();
        try {
            const publicClaimId = seedBareAntiClaim(db, "Immutable rejection.");
            const ids = claimIds(db, publicClaimId);
            db.prepare(INSERT_PAYLOAD).run(...payloadValues(ids.revisionId, ids.claimId));

            expect(() =>
                db
                    .prepare(
                        "UPDATE claim_anti_memory_revision_payloads SET rejection_reason = 'changed'",
                    )
                    .run(),
            ).toThrow(/append-only/);
            expect(() =>
                db.prepare("DELETE FROM claim_anti_memory_revision_payloads").run(),
            ).toThrow(/append-only/);
        } finally {
            closeQuietly(db);
        }
    });
});
