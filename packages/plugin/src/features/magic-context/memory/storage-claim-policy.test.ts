/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
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

interface Fixture {
    db: Database;
    projectId: number;
    episodeId: number;
}

function fixture(): Fixture {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
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
    fx.db
        .prepare(
            `INSERT INTO claims (project_id, subject, predicate, scope, state, created_at)
             VALUES (?, ?, 'states', '', 'active', 1)`,
        )
        // pi-lens-ignore-next-line: sql-injection
        .run(fx.projectId, `subject-${uniq}`);
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

    test("retained user metadata counts as explicit-user evidence only at or below the seed boundary", () => {
        const fx = fixture();
        try {
            const observationId = addObservation(fx);
            const revisionId = addRevision(fx, [observationId]);
            fx.db
                .prepare(
                    `INSERT INTO claim_revision_memory_metadata
                        (revision_id, category, normalized_hash, importance, memory_scope,
                         shareable, source_type, created_at)
                     VALUES (?, 'CONSTRAINTS', 'hash', 50, 'project', 0, 'user', 1)`,
                )
                .run(revisionId);
            // A fresh database initializes the boundary to 0.
            expect(hasExplicitUserEvidence(fx.db, revisionId)).toBeFalse();
            fx.db
                .prepare(
                    "UPDATE schema_migrations_meta SET value = ? WHERE key = 'claim_policy_seed_boundary_revision_id'",
                )
                .run(String(revisionId));
            expect(hasExplicitUserEvidence(fx.db, revisionId)).toBeTrue();
            // The observation trust class qualifies at any boundary.
            const explicit = addRevision(fx, [addObservation(fx, { trust: "explicit_user" })]);
            expect(hasExplicitUserEvidence(fx.db, explicit)).toBeTrue();
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("pre-boundary rewrite revisions cannot inherit explicit-user trust", () => {
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
            // A v85 rewrite appended revision 2 with the retained `user`
            // stamp on both the observation and the revision metadata even
            // though the replacement bytes were model-authored.
            fx.db
                .prepare(
                    `INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at)
                     VALUES (?, 2, 'model rewrite', ?, 2)`,
                )
                .run(claimId, "c".repeat(64));
            const rewrite = Number(
                (fx.db.prepare("SELECT MAX(id) AS id FROM claim_revisions").get() as { id: number })
                    .id,
            );
            fx.db
                .prepare(
                    "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', 2)",
                )
                .run(rewrite, addObservation(fx, { trust: "explicit_user" }));
            fx.db
                .prepare(
                    `INSERT INTO claim_revision_memory_metadata
                        (revision_id, category, normalized_hash, importance, memory_scope,
                         shareable, source_type, created_at)
                     VALUES (?, 'CONSTRAINTS', 'hash-rewrite', 50, 'project', 0, 'user', 2)`,
                )
                .run(rewrite);
            fx.db
                .prepare(
                    "UPDATE schema_migrations_meta SET value = ? WHERE key = 'claim_policy_seed_boundary_revision_id'",
                )
                .run(String(rewrite));
            // Below the boundary only the claim's first revision keeps its
            // stated user provenance; the rewrite qualifies through neither
            // the observation nor the retained metadata.
            expect(hasExplicitUserEvidence(fx.db, rewrite)).toBeFalse();
            expect(hasExplicitUserEvidence(fx.db, first)).toBeTrue();
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("a dashboard explicit-user edit keeps trust while a copied stamp on the same bytes does not", () => {
        // The dashboard is the one writer that authors NEW user-content
        // revisions, so its stamp must survive a digest change. The producer is
        // the witness: a pre-v86 rewrite copying the trust class onto the same
        // replacement bytes is otherwise indistinguishable.
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

            // A copied legacy stamp on the exact same bytes: right digest,
            // wrong producer.
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
