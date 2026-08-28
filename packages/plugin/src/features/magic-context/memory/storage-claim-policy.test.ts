/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createDirectTestDatabase } from "../test-database";
import { createAntiMemory } from "./storage-anti-memory";
import { recordClaimUsage } from "./storage-claim-operations";
import {
    advanceProjectorWatermarkInCurrentTransaction,
    appendMaturityAssertionInCurrentTransaction,
    computePolicyDecisionForRevision,
    countIndependentEvidenceGroups,
    createPolicySubjectInCurrentTransaction,
    currentApprovalActionId,
    currentValidArtifactId,
    EXPLICIT_USER_REVISION_PRODUCER,
    hasExplicitUserEvidence,
    readActiveDispositions,
    readMaturityHead,
    readPolicySubject,
    readProjectorWatermark,
    recordApprovalActionInCurrentTransaction,
    recordDispositionEventInCurrentTransaction,
    recordEnforcementArtifactInCurrentTransaction,
    refreshEffectivePolicyInCurrentTransaction,
    revokeEnforcementArtifactInCurrentTransaction,
} from "./storage-claim-policy";
import { ensureProject } from "./storage-claims";

interface Fixture {
    db: Database;
    projectId: number;
    episodeId: number;
}

function fixture(): Fixture {
    const db = createDirectTestDatabase().db;
    db.exec("PRAGMA foreign_keys=ON");
    const now = 1_000;
    db.prepare("INSERT INTO projects (canonical_identity, created_at) VALUES ('git:pol', ?)").run(
        now,
    );
    const projectId = Number((db.prepare("SELECT id FROM projects").get() as { id: number }).id);
    db.prepare("INSERT INTO episodes (project_id, created_at) VALUES (?, ?)").run(projectId, now);
    const episodeId = Number(
        (db.prepare("SELECT MAX(id) AS id FROM episodes").get() as { id: number }).id,
    );
    return { db, projectId, episodeId };
}

let uniq = 0;

function addObservation(
    fx: Fixture,
    args: Partial<{
        independenceKey: string;
        runId: string;
        content: string;
        trust: string;
        extractor: string;
        contentSha256: string;
    }> = {},
): number {
    uniq += 1;
    const key = args.independenceKey ?? `key-${uniq}`;
    const runId = args.runId ?? `run-${uniq}`;
    const content = args.content ?? `content-${uniq}`;
    fx.db
        .prepare(
            `INSERT INTO source_spans (episode_id, source_locator, content_sha256, start_offset, end_offset, created_at)
             VALUES (?, 'loc', ?, 0, 1, 1)`,
        )
        .run(fx.episodeId, "a".repeat(64));
    const spanId = Number(
        (fx.db.prepare("SELECT MAX(id) AS id FROM source_spans").get() as { id: number }).id,
    );
    fx.db
        .prepare(
            `INSERT INTO observations (source_span_id, extracted_text, content_sha256, extractor,
                extractor_version, extractor_run_id, independence_key, source_trust_class, created_at)
             VALUES (?, ?, ?, ?, '1', ?, ?, ?, 1)`,
        )
        .run(
            spanId,
            content,
            args.contentSha256 ?? content.padEnd(64, "0").slice(0, 64),
            args.extractor ?? "extractor",
            runId,
            key,
            args.trust ?? "model_inference",
        );
    return Number(
        (fx.db.prepare("SELECT MAX(id) AS id FROM observations").get() as { id: number }).id,
    );
}

function addRevision(fx: Fixture, observationIds: readonly number[]): number {
    uniq += 1;
    const subject = `subject-${uniq}`;
    fx.db
        .prepare(
            `INSERT INTO claims (project_id, subject, predicate, scope, state, created_at)
             VALUES (?, ?, 'states', '', 'active', 1)`,
        )
        .run(fx.projectId, subject);
    const claimId = Number(
        (fx.db.prepare("SELECT MAX(id) AS id FROM claims").get() as { id: number }).id,
    );
    fx.db
        .prepare(
            `INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at)
             VALUES (?, 1, 'rev content', ?, 1)`,
        )
        .run(claimId, "b".repeat(64));
    const revisionId = Number(
        (fx.db.prepare("SELECT MAX(id) AS id FROM claim_revisions").get() as { id: number }).id,
    );
    for (const observationId of observationIds) {
        fx.db
            .prepare(
                "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', 1)",
            )
            .run(revisionId, observationId);
    }
    fx.db
        .prepare("UPDATE claims SET current_revision_id = ? WHERE id = ?")
        .run(revisionId, claimId);
    return revisionId;
}

function subjectFor(fx: Fixture, revisionId: number, originObservationId: number | null): void {
    createPolicySubjectInCurrentTransaction(fx.db, {
        revisionId,
        projectId: fx.projectId,
        claimKind: "unknown",
        originObservationId,
        originTaint: "ASSISTANT_INFERENCE",
        classificationMethod: "test",
        nowMs: 1,
    });
}

function approve(fx: Fixture, revisionId: number, identity: string) {
    return recordApprovalActionInCurrentTransaction(fx.db, {
        revisionId,
        projectId: fx.projectId,
        action: "approve",
        host: "opencode",
        sessionId: "ses",
        userCommandEvent: "evt",
        commandIdentity: identity,
        confirmationNonce: "nonce",
        nowMs: 1,
    });
}

describe("claim policy storage kernel", () => {
    test("anti-memory rejected disposition remains joinable to usage", () => {
        const db = createDirectTestDatabase().db;
        try {
            const result = createAntiMemory(
                db,
                { producer: "policy-test", operationKey: "seed-retirement" },
                {
                    projectId: ensureProject(db, "git:retirement"),
                    payload: {
                        trigger: "session caching",
                        rejectedStrategy: "Redis",
                        rejectionReason: "split ownership",
                    },
                    provenance: {
                        sourceLocator: "test://retirement",
                        sourceContent: "Redis rejected",
                        extractor: "test",
                        extractorVersion: "1",
                        extractorRunId: "seed",
                        independenceKey: "retirement",
                        sourceTrustClass: "explicit_user",
                    },
                    actor: "user:test",
                },
            );
            const publicClaimId = (result.result.payload as { claim: { publicClaimId: string } })
                .claim.publicClaimId;
            const target = db
                .prepare(
                    `SELECT claims.current_revision_id AS revisionId, claims.project_id AS projectId
                       FROM claim_public_ids public
                       JOIN claims ON claims.id = public.claim_id
                      WHERE public.public_id = ?`,
                )
                .get(publicClaimId) as { revisionId: number; projectId: number };

            recordClaimUsage(db, { publicClaimIds: [publicClaimId], kind: "retrieved" });
            const eventId = db
                .transaction(() => {
                    const id = recordDispositionEventInCurrentTransaction(db, {
                        revisionId: target.revisionId,
                        projectId: target.projectId,
                        disposition: "rejected",
                        action: "assert",
                        actor: "user:test",
                        reason: "false warning",
                    });
                    refreshEffectivePolicyInCurrentTransaction(db, target.revisionId);
                    return id;
                })
                .immediate();
            expect(eventId).toBeGreaterThan(0);
            expect(
                db
                    .prepare(
                        `SELECT usage.retrieval_count AS deliveries, dispositions.reason
                           FROM claim_usage_stats usage
                           JOIN claims ON claims.id = usage.claim_id
                           JOIN claim_disposition_events dispositions
                             ON dispositions.revision_id = claims.current_revision_id
                          WHERE claims.id = (SELECT claim_id FROM claim_public_ids WHERE public_id = ?)
                            AND dispositions.disposition = 'rejected'`,
                    )
                    .get(publicClaimId),
            ).toEqual({ deliveries: 1, reason: "false warning" });
        } finally {
            closeQuietly(db);
        }
    });

    test("policy subjects freeze once and replay idempotently", () => {
        const fx = fixture();
        try {
            const observationId = addObservation(fx);
            const revisionId = addRevision(fx, [observationId]);
            subjectFor(fx, revisionId, observationId);
            const first = readPolicySubject(fx.db, revisionId);
            subjectFor(fx, revisionId, observationId);
            expect(readPolicySubject(fx.db, revisionId)).toEqual(first);
            expect(first?.sourceDigest).toBe("b".repeat(64));
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("maturity appends consume the head, no-op at or below it, and never fork", () => {
        const fx = fixture();
        try {
            const observationId = addObservation(fx);
            const revisionId = addRevision(fx, [observationId]);
            subjectFor(fx, revisionId, observationId);
            const first = appendMaturityAssertionInCurrentTransaction(fx.db, {
                revisionId,
                projectId: fx.projectId,
                maturity: "CANDIDATE",
                actor: "test",
            });
            expect(first).toBeGreaterThan(0);
            expect(
                appendMaturityAssertionInCurrentTransaction(fx.db, {
                    revisionId,
                    projectId: fx.projectId,
                    maturity: "CANDIDATE",
                    actor: "test",
                }),
            ).toBeNull();
            appendMaturityAssertionInCurrentTransaction(fx.db, {
                revisionId,
                projectId: fx.projectId,
                maturity: "VERIFIED",
                actor: "test",
            });
            expect(readMaturityHead(fx.db, revisionId)?.maturity).toBe("VERIFIED");
            expect(readMaturityHead(fx.db, revisionId)?.seq).toBe(2);
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("approval replay returns the original action; identity reuse for another target fails", () => {
        const fx = fixture();
        try {
            const observationId = addObservation(fx);
            const revisionId = addRevision(fx, [observationId]);
            const otherRevision = addRevision(fx, [addObservation(fx)]);
            subjectFor(fx, revisionId, observationId);
            const first = approve(fx, revisionId, "cmd-1");
            expect(first.replayed).toBeFalse();
            const replay = approve(fx, revisionId, "cmd-1");
            expect(replay).toEqual({ actionId: first.actionId, replayed: true });
            expect(() =>
                recordApprovalActionInCurrentTransaction(fx.db, {
                    revisionId: otherRevision,
                    projectId: fx.projectId,
                    action: "approve",
                    host: "opencode",
                    sessionId: "ses",
                    userCommandEvent: "evt",
                    commandIdentity: "cmd-1",
                    confirmationNonce: "nonce",
                }),
            ).toThrow(/different target/);
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("approval revocation keeps APPROVED history and lowers effective maturity to VERIFIED", () => {
        const fx = fixture();
        try {
            const observationId = addObservation(fx);
            const revisionId = addRevision(fx, [observationId]);
            subjectFor(fx, revisionId, observationId);
            fx.db
                .prepare(
                    "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'verified', 'v', 1)",
                )
                .run(revisionId);
            const approval = approve(fx, revisionId, "cmd-appr");
            appendMaturityAssertionInCurrentTransaction(fx.db, {
                revisionId,
                projectId: fx.projectId,
                maturity: "VERIFIED",
                actor: "test",
            });
            appendMaturityAssertionInCurrentTransaction(fx.db, {
                revisionId,
                projectId: fx.projectId,
                maturity: "APPROVED",
                actor: "user",
                approvalActionId: approval.actionId,
            });
            expect(computePolicyDecisionForRevision(fx.db, revisionId).effectiveMaturity).toBe(
                "APPROVED",
            );
            recordApprovalActionInCurrentTransaction(fx.db, {
                revisionId,
                projectId: fx.projectId,
                action: "revoke",
                host: "opencode",
                sessionId: "ses",
                userCommandEvent: "evt2",
                commandIdentity: "cmd-revoke",
                confirmationNonce: "nonce2",
            });
            expect(currentApprovalActionId(fx.db, revisionId)).toBeNull();
            const decision = computePolicyDecisionForRevision(fx.db, revisionId);
            expect(readMaturityHead(fx.db, revisionId)?.maturity).toBe("APPROVED");
            expect(decision.effectiveMaturity).toBe("VERIFIED");
            expect(decision.surfaces.auto_inject.eligible).toBeTrue();
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("artifact validity requires a pass result and no revocation", () => {
        const fx = fixture();
        try {
            const observationId = addObservation(fx);
            const revisionId = addRevision(fx, [observationId]);
            subjectFor(fx, revisionId, observationId);
            approve(fx, revisionId, "cmd-a");
            const failing = recordEnforcementArtifactInCurrentTransaction(fx.db, {
                revisionId,
                projectId: fx.projectId,
                artifactKind: "test",
                canonicalPath: "tests/gate.test.ts",
                bytesDigest: "d".repeat(64),
                evaluator: "bun-test",
                evaluatorVersion: "1",
                evaluatorResult: "fail",
            });
            expect(failing).toBeGreaterThan(0);
            expect(currentValidArtifactId(fx.db, revisionId)).toBeNull();
            const passing = recordEnforcementArtifactInCurrentTransaction(fx.db, {
                revisionId,
                projectId: fx.projectId,
                artifactKind: "test",
                canonicalPath: "tests/gate.test.ts",
                bytesDigest: "e".repeat(64),
                evaluator: "bun-test",
                evaluatorVersion: "1",
                evaluatorResult: "pass",
            });
            expect(currentValidArtifactId(fx.db, revisionId)).toBe(passing);
            revokeEnforcementArtifactInCurrentTransaction(fx.db, passing, "rotated");
            expect(currentValidArtifactId(fx.db, revisionId)).toBeNull();
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("disposition events assert and clear idempotently and feed the reducer", () => {
        const fx = fixture();
        try {
            const observationId = addObservation(fx);
            const revisionId = addRevision(fx, [observationId]);
            subjectFor(fx, revisionId, observationId);
            expect(
                recordDispositionEventInCurrentTransaction(fx.db, {
                    revisionId,
                    projectId: fx.projectId,
                    disposition: "quarantined",
                    action: "assert",
                    actor: "host",
                }),
            ).toBeGreaterThan(0);
            expect(
                recordDispositionEventInCurrentTransaction(fx.db, {
                    revisionId,
                    projectId: fx.projectId,
                    disposition: "quarantined",
                    action: "assert",
                    actor: "host",
                }),
            ).toBeNull();
            expect(readActiveDispositions(fx.db, revisionId).quarantined).toBeTrue();
            const decision = computePolicyDecisionForRevision(fx.db, revisionId);
            expect(decision.hardHidden).toBeTrue();
            expect(decision.surfaces.explicit_search.eligible).toBeFalse();
            expect(decision.surfaces.review.eligible).toBeTrue();
            recordDispositionEventInCurrentTransaction(fx.db, {
                revisionId,
                projectId: fx.projectId,
                disposition: "quarantined",
                action: "clear",
                actor: "host",
            });
            expect(readActiveDispositions(fx.db, revisionId).quarantined).toBeFalse();
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("verification stale/flagged outcomes and conflicts derive dispositions", () => {
        const fx = fixture();
        try {
            const observationId = addObservation(fx);
            const revisionId = addRevision(fx, [observationId]);
            const rival = addRevision(fx, [addObservation(fx)]);
            subjectFor(fx, revisionId, observationId);
            fx.db
                .prepare(
                    "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'stale', 'v', 1)",
                )
                .run(revisionId);
            expect(readActiveDispositions(fx.db, revisionId).stale).toBeTrue();
            // A later positive verification clears the derived stale fact.
            fx.db
                .prepare(
                    "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'verified', 'v', 2)",
                )
                .run(revisionId);
            expect(readActiveDispositions(fx.db, revisionId).stale).toBeFalse();
            const [left, right] = revisionId < rival ? [revisionId, rival] : [rival, revisionId];
            fx.db
                .prepare(
                    "INSERT INTO claim_conflicts (relation, left_revision_id, right_revision_id, created_at) VALUES ('contradicts', ?, ?, 1)",
                )
                .run(left, right);
            expect(readActiveDispositions(fx.db, revisionId).contradicted).toBeTrue();
            const decision = computePolicyDecisionForRevision(fx.db, revisionId);
            expect(decision.hardHidden).toBeTrue();
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("a stale/flagged transition supersedes the earlier outcome instead of stacking both", () => {
        const fx = fixture();
        try {
            const observationId = addObservation(fx);
            const revisionId = addRevision(fx, [observationId]);
            subjectFor(fx, revisionId, observationId);
            fx.db
                .prepare(
                    "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'stale', 'v', 1)",
                )
                .run(revisionId);
            fx.db
                .prepare(
                    "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'flagged', 'v', 2)",
                )
                .run(revisionId);
            let dispositions = readActiveDispositions(fx.db, revisionId);
            expect(dispositions.disputed).toBeTrue();
            expect(dispositions.stale).toBeFalse();
            fx.db
                .prepare(
                    "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'stale', 'v', 3)",
                )
                .run(revisionId);
            dispositions = readActiveDispositions(fx.db, revisionId);
            expect(dispositions.stale).toBeTrue();
            expect(dispositions.disputed).toBeFalse();
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("independence groups collapse shared keys, runs, and mirrored content", () => {
        const fx = fixture();
        try {
            const revisionId = addRevision(fx, [
                addObservation(fx, { independenceKey: "shared" }),
                addObservation(fx, { independenceKey: "shared" }),
            ]);
            expect(countIndependentEvidenceGroups(fx.db, revisionId)).toBe(1);
            const sameRun = addRevision(fx, [
                addObservation(fx, { runId: "one-run" }),
                addObservation(fx, { runId: "one-run" }),
            ]);
            expect(countIndependentEvidenceGroups(fx.db, sameRun)).toBe(1);
            const mirrored = addRevision(fx, [
                addObservation(fx, { content: "same bytes" }),
                addObservation(fx, { content: "same bytes" }),
            ]);
            expect(countIndependentEvidenceGroups(fx.db, mirrored)).toBe(1);
            const independent = addRevision(fx, [addObservation(fx), addObservation(fx)]);
            expect(countIndependentEvidenceGroups(fx.db, independent)).toBe(2);
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("a dashboard explicit-user edit keeps trust while a copied stamp on the same bytes does not", () => {
        const fx = fixture();
        try {
            const first = addRevision(fx, [addObservation(fx, { trust: "explicit_user" })]);
            const claimId = Number(
                (
                    fx.db
                        .prepare("SELECT claim_id AS id FROM claim_revisions WHERE id = ?")
                        .get(first) as { id: number }
                ).id,
            );
            const editedSha = "d".repeat(64);
            fx.db
                .prepare(
                    `INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at)
                     VALUES (?, 2, 'user rewrote this in the dashboard', ?, 2)`,
                )
                .run(claimId, editedSha);
            const edited = Number(
                (fx.db.prepare("SELECT MAX(id) AS id FROM claim_revisions").get() as { id: number })
                    .id,
            );

            // Matching bytes are insufficient when the producer cannot attest
            // that a user authored the revision.
            const copied = addObservation(fx, {
                trust: "explicit_user",
                extractor: "historian",
                contentSha256: editedSha,
            });
            fx.db
                .prepare(
                    "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', 2)",
                )
                .run(edited, copied);
            expect(hasExplicitUserEvidence(fx.db, edited)).toBeFalse();

            // The dashboard's own observation for those bytes qualifies.
            const dashboard = addObservation(fx, {
                trust: "explicit_user",
                extractor: EXPLICIT_USER_REVISION_PRODUCER,
                contentSha256: editedSha,
            });
            fx.db
                .prepare(
                    "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', 2)",
                )
                .run(edited, dashboard);
            expect(hasExplicitUserEvidence(fx.db, edited)).toBeTrue();
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("a dashboard stamp cannot credit bytes it did not observe", () => {
        const fx = fixture();
        try {
            const first = addRevision(fx, [addObservation(fx, { trust: "explicit_user" })]);
            const claimId = Number(
                (
                    fx.db
                        .prepare("SELECT claim_id AS id FROM claim_revisions WHERE id = ?")
                        .get(first) as { id: number }
                ).id,
            );
            fx.db
                .prepare(
                    `INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at)
                     VALUES (?, 2, 'model rewrite', ?, 2)`,
                )
                .run(claimId, "e".repeat(64));
            const rewrite = Number(
                (fx.db.prepare("SELECT MAX(id) AS id FROM claim_revisions").get() as { id: number })
                    .id,
            );
            // Correct producer, but the observation describes different bytes.
            fx.db
                .prepare(
                    "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', 2)",
                )
                .run(
                    rewrite,
                    addObservation(fx, {
                        trust: "explicit_user",
                        extractor: EXPLICIT_USER_REVISION_PRODUCER,
                        contentSha256: "f".repeat(64),
                    }),
                );
            expect(hasExplicitUserEvidence(fx.db, rewrite)).toBeFalse();
        } finally {
            closeQuietly(fx.db);
        }
    });
    test("the effective projection materializes the pure decision and rebuilds identically", () => {
        const fx = fixture();
        try {
            const observationId = addObservation(fx, { trust: "explicit_user" });
            const revisionId = addRevision(fx, [observationId]);
            subjectFor(fx, revisionId, observationId);
            appendMaturityAssertionInCurrentTransaction(fx.db, {
                revisionId,
                projectId: fx.projectId,
                maturity: "VERIFIED",
                actor: "test",
            });
            refreshEffectivePolicyInCurrentTransaction(fx.db, revisionId, { nowMs: 5 });
            const row = fx.db
                .prepare("SELECT * FROM claim_effective_policy WHERE revision_id = ?")
                .get(revisionId) as Record<string, unknown>;
            expect(row.effective_maturity).toBe("VERIFIED");
            expect(row.auto_eligible).toBe(1);
            // Rebuild from authoritative rows reproduces identical fields.
            refreshEffectivePolicyInCurrentTransaction(fx.db, revisionId, { nowMs: 5 });
            expect(
                fx.db
                    .prepare("SELECT * FROM claim_effective_policy WHERE revision_id = ?")
                    .get(revisionId),
            ).toEqual(row);
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("projector watermarks advance monotonically and reject regression", () => {
        const fx = fixture();
        try {
            advanceProjectorWatermarkInCurrentTransaction(fx.db, "native", fx.projectId, 5, 2);
            expect(readProjectorWatermark(fx.db, "native", fx.projectId)).toEqual({
                watermark: 5,
                generation: 2,
            });
            advanceProjectorWatermarkInCurrentTransaction(fx.db, "native", fx.projectId, 7, 3);
            expect(() =>
                advanceProjectorWatermarkInCurrentTransaction(fx.db, "native", fx.projectId, 6, 3),
            ).toThrow(/cannot regress/);
            expect(() =>
                advanceProjectorWatermarkInCurrentTransaction(fx.db, "native", fx.projectId, 8, 2),
            ).toThrow(/cannot regress/);
        } finally {
            closeQuietly(fx.db);
        }
    });
});
