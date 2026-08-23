/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    getClaimPolicySeedStatus,
    reconcileCompatibilityVerificationsAtStartup,
    runClaimPolicySeed,
} from "./claim-policy-backfill";
import { runClaimPolicySeedStartup } from "./claim-policy-backfill-startup";
import { runInMemoryClaimsWriteTransaction } from "./memory/storage-memory-claims";
import { runMigrations } from "./migrations";
import { dropClaimPolicyObjectsForTests } from "./storage-claim-policy-schema";
import { initializeDatabase } from "./storage-db";

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
    dropClaimPolicyObjectsForTests(db);
    const now = 1_000;
    db.prepare(
        "INSERT INTO projects (canonical_identity, created_at) VALUES ('git:seedfx', ?)",
    ).run(now);
    const projectId = Number((db.prepare("SELECT id FROM projects").get() as { id: number }).id);
    db.prepare("INSERT INTO episodes (project_id, created_at) VALUES (?, ?)").run(projectId, now);
    const episodeId = Number(
        (db.prepare("SELECT MAX(id) AS id FROM episodes").get() as { id: number }).id,
    );
    return { db, projectId, episodeId };
}

function addObservation(
    fx: Fixture,
    args: { independenceKey: string; runId: string; content: string; trust: string },
): number {
    const now = 1_000;
    fx.db
        .prepare(
            `INSERT INTO source_spans (episode_id, source_locator, content_sha256, start_offset, end_offset, created_at)
             VALUES (?, 'loc', ?, 0, 1, ?)`,
        )
        .run(fx.episodeId, "a".repeat(64), now);
    const spanId = Number(
        (fx.db.prepare("SELECT MAX(id) AS id FROM source_spans").get() as { id: number }).id,
    );
    fx.db
        .prepare(
            `INSERT INTO observations (source_span_id, extracted_text, content_sha256, extractor,
                extractor_version, extractor_run_id, independence_key, source_trust_class, created_at)
             VALUES (?, ?, ?, 'extractor', '1', ?, ?, ?, ?)`,
        )
        .run(
            spanId,
            args.content,
            args.content.padEnd(64, "0").slice(0, 64),
            args.runId,
            args.independenceKey,
            args.trust,
            now,
        );
    return Number(
        (fx.db.prepare("SELECT MAX(id) AS id FROM observations").get() as { id: number }).id,
    );
}

function addClaimRevision(fx: Fixture, subject: string, observationIds: readonly number[]): number {
    const now = 1_000;
    fx.db
        .prepare(
            `INSERT INTO claims (project_id, subject, predicate, scope, state, created_at)
             VALUES (?, ?, 'states', '', 'active', ?)`,
            // pi-lens-ignore: sql-injection
        )
        .run(fx.projectId, subject, now);
    const claimId = Number(
        (fx.db.prepare("SELECT MAX(id) AS id FROM claims").get() as { id: number }).id,
    );
    fx.db
        .prepare(
            `INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at)
             VALUES (?, 1, ?, ?, ?)`,
            // pi-lens-ignore: sql-injection
        )
        .run(
            claimId,
            // pi-lens-ignore-next-line: sql-injection
            `content of ${subject}`,
            "b".repeat(64),
            now,
        );
    const revisionId = Number(
        (fx.db.prepare("SELECT MAX(id) AS id FROM claim_revisions").get() as { id: number }).id,
    );
    for (const observationId of observationIds) {
        fx.db
            .prepare(
                "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', ?)",
            )
            .run(revisionId, observationId, now);
    }
    fx.db
        .prepare("UPDATE claims SET current_revision_id = ? WHERE id = ?")
        .run(revisionId, claimId);
    return revisionId;
}

/** The AE9 corpus: verified, explicit-user, independently supported, and
 * unsupported revisions. */
function seedAe9Corpus(fx: Fixture): {
    verified: number;
    explicitUser: number;
    corroborated: number;
    unsupported: number;
} {
    const verified = addClaimRevision(fx, "verified", [
        addObservation(fx, {
            independenceKey: "k1",
            runId: "run1",
            content: "x1",
            trust: "model_inference",
        }),
    ]);
    fx.db
        .prepare(
            "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'verified', 'v', 1)",
        )
        .run(verified);
    const explicitUser = addClaimRevision(fx, "explicit-user", [
        addObservation(fx, {
            independenceKey: "k2",
            runId: "run2",
            content: "x2",
            trust: "explicit_user",
        }),
    ]);
    const corroborated = addClaimRevision(fx, "corroborated", [
        addObservation(fx, {
            independenceKey: "k3",
            runId: "run3",
            content: "x3",
            trust: "model_inference",
        }),
        addObservation(fx, {
            independenceKey: "k4",
            runId: "run4",
            content: "x4",
            trust: "model_inference",
        }),
    ]);
    const unsupported = addClaimRevision(fx, "unsupported", [
        addObservation(fx, {
            independenceKey: "k5",
            runId: "run5",
            content: "x5",
            trust: "model_inference",
        }),
    ]);
    return { verified, explicitUser, corroborated, unsupported };
}

function effectivePolicyRows(db: Database): Array<Record<string, unknown>> {
    return db
        .prepare(
            `SELECT revision_id, effective_maturity, origin_taint, auto_eligible,
                    explicit_eligible, hard_hidden
             FROM claim_effective_policy ORDER BY revision_id`,
        )
        .all() as Array<Record<string, unknown>>;
}

describe("claim policy seed", () => {
    test("AE9: verified, explicit-user, corroborated, and unsupported revisions seed the four states", async () => {
        const fx = fixture();
        try {
            const ids = seedAe9Corpus(fx);
            runMigrations(fx.db);
            const summary = await runClaimPolicySeed(fx.db);
            expect(summary.status).toBe("complete");
            expect(summary.seededCounts).toEqual({ CANDIDATE: 1, CORROBORATED: 1, VERIFIED: 2 });
            expect(summary.autoHidden).toBe(2);
            const byRevision = new Map(
                effectivePolicyRows(fx.db).map((row) => [row.revision_id, row]),
            );
            expect(byRevision.get(ids.verified)?.effective_maturity).toBe("VERIFIED");
            expect(byRevision.get(ids.verified)?.auto_eligible).toBe(1);
            expect(byRevision.get(ids.explicitUser)?.effective_maturity).toBe("VERIFIED");
            expect(byRevision.get(ids.explicitUser)?.origin_taint).toBe("USER_EXPLICIT");
            expect(byRevision.get(ids.corroborated)?.effective_maturity).toBe("CORROBORATED");
            expect(byRevision.get(ids.corroborated)?.auto_eligible).toBe(0);
            expect(byRevision.get(ids.corroborated)?.explicit_eligible).toBe(1);
            expect(byRevision.get(ids.unsupported)?.effective_maturity).toBe("CANDIDATE");
            expect(byRevision.get(ids.unsupported)?.auto_eligible).toBe(0);
            // Parent rows keep their exact bytes.
            expect(
                fx.db.prepare("SELECT content FROM claim_revisions WHERE id = ?").get(ids.verified),
            ).toEqual({ content: "content of verified" });
            expect(getClaimPolicySeedStatus(fx.db).phase).toBe("complete");
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("copies of one source stay one independence group and do not corroborate", async () => {
        const fx = fixture();
        try {
            // Two observations from one extractor run: distinct writer keys
            // cannot manufacture independence (KTD4).
            const sameRun = addClaimRevision(fx, "same-run", [
                addObservation(fx, {
                    independenceKey: "ka",
                    runId: "shared-run",
                    content: "ya",
                    trust: "model_inference",
                }),
                addObservation(fx, {
                    independenceKey: "kb",
                    runId: "shared-run",
                    content: "yb",
                    trust: "model_inference",
                }),
            ]);
            // Two mirrored files carrying identical content.
            const mirrored = addClaimRevision(fx, "mirrored", [
                addObservation(fx, {
                    independenceKey: "kc",
                    runId: "run-c",
                    content: "same bytes",
                    trust: "model_inference",
                }),
                addObservation(fx, {
                    independenceKey: "kd",
                    runId: "run-d",
                    content: "same bytes",
                    trust: "model_inference",
                }),
            ]);
            runMigrations(fx.db);
            await runClaimPolicySeed(fx.db);
            const byRevision = new Map(
                effectivePolicyRows(fx.db).map((row) => [row.revision_id, row]),
            );
            expect(byRevision.get(sameRun)?.effective_maturity).toBe("CANDIDATE");
            expect(byRevision.get(mirrored)?.effective_maturity).toBe("CANDIDATE");
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("interruption at any batch cursor resumes to identical results without duplicates", async () => {
        const fx = fixture();
        try {
            seedAe9Corpus(fx);
            runMigrations(fx.db);
            // One bounded batch, then stop: work stays pending.
            const first = await runClaimPolicySeed(fx.db, { batchSize: 1, maxBatches: 2 });
            expect(first.status).toBe("pending");
            expect(getClaimPolicySeedStatus(fx.db).phase).toBe("pending");
            const resumed = await runClaimPolicySeed(fx.db, { batchSize: 1 });
            expect(resumed.status).toBe("complete");
            const counts = getClaimPolicySeedStatus(fx.db).seededCounts;
            expect(counts).toEqual({ CANDIDATE: 1, CORROBORATED: 1, VERIFIED: 2 });
            expect(
                fx.db.prepare("SELECT COUNT(*) AS count FROM claim_revision_policy_subjects").get(),
            ).toEqual({ count: 4 });
            expect(
                fx.db.prepare("SELECT COUNT(*) AS count FROM claim_maturity_streams").get(),
            ).toEqual({ count: 4 });
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("a revision added behind the cursor during reconciliation is seeded before completion", async () => {
        const fx = fixture();
        try {
            seedAe9Corpus(fx);
            runMigrations(fx.db);
            await runClaimPolicySeed(fx.db, { batchSize: 4, maxBatches: 1 });
            // A held-open writer appends a revision without a policy subject
            // while reconciliation is between batches.
            const late = addClaimRevision(fx, "late-writer", [
                addObservation(fx, {
                    independenceKey: "k-late",
                    runId: "run-late",
                    content: "late",
                    trust: "model_inference",
                }),
            ]);
            // It reads as conservative unknown until seeded (R26).
            expect(
                fx.db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM claim_revision_policy_subjects WHERE revision_id = ?",
                    )
                    .get(late),
            ).toEqual({ count: 0 });
            const summary = await runClaimPolicySeed(fx.db);
            expect(summary.status).toBe("complete");
            expect(
                fx.db
                    .prepare(
                        "SELECT effective_maturity FROM claim_effective_policy WHERE revision_id = ?",
                    )
                    .get(late),
            ).toEqual({ effective_maturity: "CANDIDATE" });
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("seeding an auto-eligible linked revision bumps the owning project's memory epoch", async () => {
        const fx = fixture();
        try {
            const ids = seedAe9Corpus(fx);
            const claimId = Number(
                (
                    fx.db
                        .prepare(
                            "SELECT claim_id AS id FROM claim_revisions JOIN claims ON claims.id = claim_revisions.claim_id WHERE claim_revisions.id = ?",
                        )
                        .get(ids.verified) as { id: number }
                ).id,
            );
            runInMemoryClaimsWriteTransaction(fx.db, () => {
                fx.db
                    .prepare(
                        `INSERT INTO memories (project_path, category, content, normalized_hash,
                            first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES ('git:seedfx', 'CONSTRAINTS', 'verified content', 'hash-1', 1, 1, 1, 1)`,
                    )
                    .run();
                const memoryId = Number(
                    (fx.db.prepare("SELECT MAX(id) AS id FROM memories").get() as { id: number })
                        .id,
                );
                const observationId = Number(
                    (
                        fx.db
                            .prepare(
                                "SELECT observation_id AS id FROM claim_evidence WHERE revision_id = ? LIMIT 1",
                            )
                            .get(ids.verified) as { id: number }
                    ).id,
                );
                fx.db
                    .prepare(
                        `INSERT INTO legacy_memory_claims
                            (memory_id, canonical_memory_id, claim_id, project_id, root_observation_id, created_at)
                         VALUES (?, ?, ?, ?, ?, 1)`,
                    )
                    .run(memoryId, memoryId, claimId, fx.projectId, observationId);
            });
            runMigrations(fx.db);
            const epochBefore = Number(
                (
                    fx.db
                        .prepare(
                            "SELECT COALESCE(MAX(project_memory_epoch), 0) AS epoch FROM project_state WHERE project_path = 'git:seedfx'",
                        )
                        .get() as { epoch: number }
                ).epoch,
            );
            const summary = await runClaimPolicySeed(fx.db);
            expect(summary.status).toBe("complete");
            const epochAfter = Number(
                (
                    fx.db
                        .prepare(
                            "SELECT project_memory_epoch AS epoch FROM project_state WHERE project_path = 'git:seedfx'",
                        )
                        .get() as { epoch: number }
                ).epoch,
            );
            expect(epochAfter).toBeGreaterThan(epochBefore);
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("a revision appended after completion is reconciled by the next run", async () => {
        const fx = fixture();
        try {
            seedAe9Corpus(fx);
            runMigrations(fx.db);
            expect((await runClaimPolicySeed(fx.db)).status).toBe("complete");
            // A held-open v85 writer appends a revision AFTER completion
            // published: no policy subject exists and no live writer will
            // create one.
            const straggler = addClaimRevision(fx, "post-completion", [
                addObservation(fx, {
                    independenceKey: "k9",
                    runId: "run9",
                    content: "x9",
                    trust: "model_inference",
                }),
            ]);
            const summary = await runClaimPolicySeed(fx.db);
            expect(summary.status).toBe("complete");
            expect(summary.seeded).toBe(1);
            expect(
                fx.db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM claim_revision_policy_subjects WHERE revision_id = ?",
                    )
                    .get(straggler),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("a raw compatibility verified event reconciles at startup", async () => {
        const fx = fixture();
        try {
            const ids = seedAe9Corpus(fx);
            runMigrations(fx.db);
            expect((await runClaimPolicySeed(fx.db)).status).toBe("complete");
            const eligibility = () =>
                (
                    fx.db
                        .prepare(
                            "SELECT auto_eligible AS auto FROM claim_effective_policy WHERE revision_id = ?",
                        )
                        .get(ids.corroborated) as { auto: number }
                ).auto;
            expect(eligibility()).toBe(0);
            // A held-open v85 writer appends the positive event without
            // running the ladder reducer.
            fx.db
                .prepare(
                    "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'verified', 'held-open-writer', 9000)",
                )
                .run(ids.corroborated);
            expect(eligibility()).toBe(0);
            expect(reconcileCompatibilityVerificationsAtStartup(fx.db)).toBe(1);
            expect(eligibility()).toBe(1);
            // Idempotent: a reconciled projection stops matching the probe.
            expect(reconcileCompatibilityVerificationsAtStartup(fx.db)).toBe(0);
            // Event-watermarked: a projection that reads ineligible while its
            // newest verified event was already examined (the legitimately
            // ineligible shape) never re-matches on later startups...
            fx.db
                .prepare(
                    "UPDATE claim_effective_policy SET auto_eligible = 0 WHERE revision_id = ?",
                )
                .run(ids.corroborated);
            expect(reconcileCompatibilityVerificationsAtStartup(fx.db)).toBe(0);
            expect(eligibility()).toBe(0);
            // ...until a new raw event re-opens examination.
            fx.db
                .prepare(
                    "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'verified', 'held-open-writer', 9100)",
                )
                .run(ids.corroborated);
            expect(reconcileCompatibilityVerificationsAtStartup(fx.db)).toBe(1);
            expect(eligibility()).toBe(1);
        } finally {
            closeQuietly(fx.db);
        }
    });

    test("startup runs the pending seed once and no-ops when complete", async () => {
        const fx = fixture();
        try {
            seedAe9Corpus(fx);
            runMigrations(fx.db);
            const messages: string[] = [];
            const summary = await runClaimPolicySeedStartup(fx.db, {
                log: (message) => messages.push(message),
            });
            expect(summary?.status).toBe("complete");
            expect(
                messages.some((line) => line.includes("moved out of automatic visibility")),
            ).toBe(true);
            // A completed seed still probes for stragglers a held-open v85
            // writer appended after completion; with none, it reports noop.
            expect((await runClaimPolicySeedStartup(fx.db))?.status).toBe("noop");
        } finally {
            closeQuietly(fx.db);
        }
    });
});
