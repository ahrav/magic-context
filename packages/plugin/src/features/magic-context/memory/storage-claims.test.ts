/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { clearSession } from "../storage-meta-session";
import { isCanonicalProjectIdentity } from "../storage-project-identities";
import {
    addClaimConflict,
    addVerificationEvent,
    appendClaimRevision,
    ClaimGraphCorruptionError,
    createClaim,
    createEpisode,
    createObservation,
    createSourceSpan,
    ensureProject,
    findClaimGraphCorruption,
    getClaimById,
    getCurrentClaimRevision,
    getRevisionEvidence,
    listClaimRevisions,
    resolveProjectId,
    sha256Utf8Hex,
} from "./storage-claims";

function migratedDb(path = ":memory:"): Database {
    const db = new Database(path);
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

interface EvidenceChain {
    projectId: number;
    episodeId: number;
    spanId: number;
    observationId: number;
}

function seedEvidenceChain(
    db: Database,
    identity = "git:claims-project",
    sourceSessionId: string | null = null,
): EvidenceChain {
    const projectId = ensureProject(db, identity);
    const episodeId = createEpisode(db, { projectId, sourceSessionId });
    const spanId = createSourceSpan(db, {
        episodeId,
        sourceLocator: "transcript://claims",
        content: "raw source text for the span",
        startOffset: 10,
        endOffset: 38,
    });
    const observationId = createObservation(db, {
        sourceSpanId: spanId,
        extractedText: "the project uses bun",
        extractor: "historian",
        extractorVersion: "2",
        extractorRunId: "run-a",
        independenceKey: "ik-a",
    });
    return { projectId, episodeId, spanId, observationId };
}

function rowCount(db: Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe("storage-claims: projects", () => {
    test("ensureProject registers a canonical identity once and resolves aliases", () => {
        const db = migratedDb();
        try {
            const id = ensureProject(db, "git:alpha");
            expect(ensureProject(db, "git:alpha")).toBe(id);
            expect(resolveProjectId(db, "git:alpha")).toBe(id);
            expect(resolveProjectId(db, "git:unknown")).toBeNull();
            expect(() => ensureProject(db, "/raw/path")).toThrow(/canonical/);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("storage-claims: create and append", () => {
    test("AE3: creating a claim commits the claim, revision 1, evidence, and pointer in one graph", () => {
        const db = migratedDb();
        try {
            const chain = seedEvidenceChain(db);
            const outcome = createClaim(db, {
                projectId: chain.projectId,
                subject: "runtime",
                predicate: "uses",
                scope: "build",
                content: "the project uses bun for builds",
                evidence: [{ observationId: chain.observationId }],
                sourceSessionId: "ses_create",
            });
            expect(outcome.status).toBe("applied");
            if (outcome.status !== "applied") throw new Error("unreachable");
            expect(outcome.revision).toBe(1);

            const claim = getClaimById(db, outcome.claimId);
            expect(claim?.currentRevisionId).toBe(outcome.revisionId);
            expect(claim?.state).toBe("active");
            const revision = getCurrentClaimRevision(db, outcome.claimId);
            expect(revision?.content).toBe("the project uses bun for builds");
            expect(revision?.contentSha256).toBe(sha256Utf8Hex("the project uses bun for builds"));
            expect(revision?.sourceSessionId).toBe("ses_create");
            expect(getRevisionEvidence(db, outcome.revisionId)).toEqual([
                {
                    revisionId: outcome.revisionId,
                    observationId: chain.observationId,
                    relation: "supports",
                    createdAt: revision?.createdAt as number,
                },
            ]);
            expect(listClaimRevisions(db, outcome.claimId)).toHaveLength(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("invalid evidence sets fail before any authoritative row is written", () => {
        const db = migratedDb();
        try {
            const chain = seedEvidenceChain(db);
            const foreign = seedEvidenceChain(db, "git:other-project");
            const base = {
                projectId: chain.projectId,
                subject: "s",
                predicate: "p",
                content: "c",
            };
            const cases: Array<{ evidence: Parameters<typeof createClaim>[1]["evidence"] }> = [
                { evidence: [] },
                {
                    evidence: [
                        { observationId: chain.observationId, relation: "supports" },
                        { observationId: chain.observationId, relation: "merged_from" },
                    ],
                },
                { evidence: [{ observationId: 999_999 }] },
                { evidence: [{ observationId: foreign.observationId }] },
            ];
            for (const testCase of cases) {
                const outcome = createClaim(db, { ...base, ...testCase });
                expect(outcome.status).toBe("invalid");
            }
            expect(rowCount(db, "claims")).toBe(0);
            expect(rowCount(db, "claim_revisions")).toBe(0);
            expect(rowCount(db, "claim_evidence")).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("duplicate evidence with the same relation deduplicates to one link", () => {
        const db = migratedDb();
        try {
            const chain = seedEvidenceChain(db);
            const outcome = createClaim(db, {
                projectId: chain.projectId,
                subject: "s",
                predicate: "p",
                content: "c",
                evidence: [
                    { observationId: chain.observationId },
                    { observationId: chain.observationId },
                ],
            });
            expect(outcome.status).toBe("applied");
            expect(rowCount(db, "claim_evidence")).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("AE4: appending revision 2 advances the pointer and leaves revision 1 byte-identical", () => {
        const db = migratedDb();
        try {
            const chain = seedEvidenceChain(db);
            const created = createClaim(db, {
                projectId: chain.projectId,
                subject: "s",
                predicate: "p",
                content: "revision one content",
                evidence: [{ observationId: chain.observationId }],
            });
            if (created.status !== "applied") throw new Error("create failed");
            const revisionOneBefore = db
                .prepare("SELECT * FROM claim_revisions WHERE id = ?")
                .get(created.revisionId);
            const snapshotBefore = JSON.stringify(revisionOneBefore);

            const appended = appendClaimRevision(db, {
                claimId: created.claimId,
                expectedCurrentRevisionId: created.revisionId,
                content: "revision two content",
                evidence: [{ observationId: chain.observationId }],
            });
            expect(appended.status).toBe("applied");
            if (appended.status !== "applied") throw new Error("unreachable");
            expect(appended.revision).toBe(2);
            expect(getClaimById(db, created.claimId)?.currentRevisionId).toBe(appended.revisionId);
            expect(
                JSON.stringify(
                    db
                        .prepare("SELECT * FROM claim_revisions WHERE id = ?")
                        .get(created.revisionId),
                ),
            ).toBe(snapshotBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("re-appending identical text still creates a new numbered revision", () => {
        const db = migratedDb();
        try {
            const chain = seedEvidenceChain(db);
            const created = createClaim(db, {
                projectId: chain.projectId,
                subject: "s",
                predicate: "p",
                content: "same content",
                evidence: [{ observationId: chain.observationId }],
            });
            if (created.status !== "applied") throw new Error("create failed");
            const appended = appendClaimRevision(db, {
                claimId: created.claimId,
                expectedCurrentRevisionId: created.revisionId,
                content: "same content",
                evidence: [{ observationId: chain.observationId }],
            });
            expect(appended.status).toBe("applied");
            if (appended.status !== "applied") throw new Error("unreachable");
            expect(appended.revision).toBe(2);
            expect(appended.revisionId).not.toBe(created.revisionId);
        } finally {
            closeQuietly(db);
        }
    });

    test("append against a missing claim reports not_found", () => {
        const db = migratedDb();
        try {
            const chain = seedEvidenceChain(db);
            const outcome = appendClaimRevision(db, {
                claimId: 424_242,
                expectedCurrentRevisionId: 1,
                content: "c",
                evidence: [{ observationId: chain.observationId }],
            });
            expect(outcome).toEqual({ status: "not_found" });
        } finally {
            closeQuietly(db);
        }
    });

    test("AE5: two handles racing the same expected pointer produce one applied and one residue-free stale", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-claims-race-"));
        const dbPath = join(dir, "context.db");
        const writerA = migratedDb(dbPath);
        writerA.exec("PRAGMA journal_mode=WAL");
        const writerB = new Database(dbPath);
        writerB.exec("PRAGMA foreign_keys=ON");
        try {
            const chain = seedEvidenceChain(writerA);
            const created = createClaim(writerA, {
                projectId: chain.projectId,
                subject: "s",
                predicate: "p",
                content: "revision one",
                evidence: [{ observationId: chain.observationId }],
            });
            if (created.status !== "applied") throw new Error("create failed");

            const expected = created.revisionId;
            const first = appendClaimRevision(writerA, {
                claimId: created.claimId,
                expectedCurrentRevisionId: expected,
                content: "winner revision",
                evidence: [{ observationId: chain.observationId }],
            });
            const second = appendClaimRevision(writerB, {
                claimId: created.claimId,
                expectedCurrentRevisionId: expected,
                content: "loser revision",
                evidence: [{ observationId: chain.observationId }],
            });

            expect(first.status).toBe("applied");
            expect(second).toEqual({ status: "stale" });
            if (first.status !== "applied") throw new Error("unreachable");
            expect(rowCount(writerA, "claim_revisions")).toBe(2);
            expect(rowCount(writerA, "claim_evidence")).toBe(2);
            const revisions = listClaimRevisions(writerA, created.claimId);
            expect(revisions.map((revision) => revision.revision)).toEqual([1, 2]);
            expect(revisions[1].content).toBe("winner revision");
            expect(revisions[1].contentSha256).toBe(sha256Utf8Hex("winner revision"));
            expect(getClaimById(writerA, created.claimId)?.currentRevisionId).toBe(
                first.revisionId,
            );

            const third = appendClaimRevision(writerB, {
                claimId: created.claimId,
                expectedCurrentRevisionId: first.revisionId,
                content: "third revision",
                evidence: [{ observationId: chain.observationId }],
            });
            expect(third.status).toBe("applied");
        } finally {
            closeQuietly(writerA);
            closeQuietly(writerB);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a database-guard failure mid-write rolls back the revision and every evidence link", () => {
        const db = migratedDb();
        try {
            const chain = seedEvidenceChain(db);
            const foreign = seedEvidenceChain(db, "git:foreign-project");
            const created = createClaim(db, {
                projectId: chain.projectId,
                subject: "s",
                predicate: "p",
                content: "revision one",
                evidence: [{ observationId: chain.observationId }],
            });
            if (created.status !== "applied") throw new Error("create failed");
            const revisionsBefore = rowCount(db, "claim_revisions");
            const evidenceBefore = rowCount(db, "claim_evidence");

            db.exec("BEGIN IMMEDIATE");
            let guardError: unknown;
            try {
                const revisionId = Number(
                    (
                        db
                            .prepare(
                                `INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at)
                                 VALUES (?, 2, 'tampered', ?, 1)`,
                            )
                            .run(created.claimId, sha256Utf8Hex("tampered")) as {
                            lastInsertRowid: number | bigint;
                        }
                    ).lastInsertRowid,
                );
                db.prepare(
                    "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', 1)",
                ).run(revisionId, foreign.observationId);
                db.exec("COMMIT");
            } catch (error) {
                guardError = error;
                db.exec("ROLLBACK");
            }
            expect(String(guardError)).toMatch(/same project/);
            expect(rowCount(db, "claim_revisions")).toBe(revisionsBefore);
            expect(rowCount(db, "claim_evidence")).toBe(evidenceBefore);
            expect(getClaimById(db, created.claimId)?.currentRevisionId).toBe(created.revisionId);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("storage-claims: conflicts and verification", () => {
    function twoClaims(db: Database): {
        chain: EvidenceChain;
        leftRevisionId: number;
        rightRevisionId: number;
    } {
        const chain = seedEvidenceChain(db);
        const left = createClaim(db, {
            projectId: chain.projectId,
            subject: "left",
            predicate: "p",
            content: "left content",
            evidence: [{ observationId: chain.observationId }],
        });
        const right = createClaim(db, {
            projectId: chain.projectId,
            subject: "right",
            predicate: "p",
            content: "right content",
            evidence: [{ observationId: chain.observationId }],
        });
        if (left.status !== "applied" || right.status !== "applied") {
            throw new Error("claim setup failed");
        }
        return { chain, leftRevisionId: left.revisionId, rightRevisionId: right.revisionId };
    }

    test("contradiction canonicalizes order and deduplicates reverse input", () => {
        const db = migratedDb();
        try {
            const { leftRevisionId, rightRevisionId } = twoClaims(db);
            const first = addClaimConflict(db, {
                relation: "contradicts",
                leftRevisionId: rightRevisionId,
                rightRevisionId: leftRevisionId,
            });
            const reversed = addClaimConflict(db, {
                relation: "contradicts",
                leftRevisionId,
                rightRevisionId,
            });
            expect(reversed).toBe(first);
            expect(rowCount(db, "claim_conflicts")).toBe(1);
            const row = db
                .prepare(
                    "SELECT left_revision_id AS l, right_revision_id AS r FROM claim_conflicts WHERE id = ?",
                )
                .get(first) as { l: number; r: number };
            expect(row.l).toBeLessThan(row.r);
        } finally {
            closeQuietly(db);
        }
    });

    test("supersession preserves direction", () => {
        const db = migratedDb();
        try {
            const { leftRevisionId, rightRevisionId } = twoClaims(db);
            const forward = addClaimConflict(db, {
                relation: "supersedes",
                leftRevisionId: rightRevisionId,
                rightRevisionId: leftRevisionId,
            });
            const row = db
                .prepare(
                    "SELECT left_revision_id AS l, right_revision_id AS r FROM claim_conflicts WHERE id = ?",
                )
                .get(forward) as { l: number; r: number };
            expect(row).toEqual({ l: rightRevisionId, r: leftRevisionId });
            // The reverse edge would make the pair mutually superseding.
            expect(() =>
                addClaimConflict(db, {
                    relation: "supersedes",
                    leftRevisionId,
                    rightRevisionId,
                }),
            ).toThrow(/opposite direction/);
            expect(rowCount(db, "claim_conflicts")).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("conflicts between the same claim or across projects fail", () => {
        const db = migratedDb();
        try {
            const { leftRevisionId } = twoClaims(db);
            const foreign = seedEvidenceChain(db, "git:conflict-foreign");
            const foreignClaim = createClaim(db, {
                projectId: foreign.projectId,
                subject: "f",
                predicate: "p",
                content: "foreign content",
                evidence: [{ observationId: foreign.observationId }],
            });
            if (foreignClaim.status !== "applied") throw new Error("setup failed");
            expect(() =>
                addClaimConflict(db, {
                    relation: "supersedes",
                    leftRevisionId,
                    rightRevisionId: leftRevisionId,
                }),
            ).toThrow(/CHECK|distinct/i);
            expect(() =>
                addClaimConflict(db, {
                    relation: "supersedes",
                    leftRevisionId,
                    rightRevisionId: foreignClaim.revisionId,
                }),
            ).toThrow(/same project/);
        } finally {
            closeQuietly(db);
        }
    });

    test("verification events append without mutating earlier events", () => {
        const db = migratedDb();
        try {
            const { chain, leftRevisionId } = twoClaims(db);
            const first = addVerificationEvent(db, {
                revisionId: leftRevisionId,
                observationId: chain.observationId,
                outcome: "verified",
                verifier: "dreamer",
            });
            addVerificationEvent(db, {
                revisionId: leftRevisionId,
                outcome: "update",
                verifier: "dreamer",
            });
            const rows = db
                .prepare(
                    "SELECT id, outcome FROM verification_events WHERE revision_id = ? ORDER BY id",
                )
                .all(leftRevisionId) as Array<{ id: number; outcome: string }>;
            expect(rows.map((row) => row.outcome)).toEqual(["verified", "update"]);
            expect(rows[0].id).toBe(first);

            const foreign = seedEvidenceChain(db, "git:verify-foreign");
            expect(() =>
                addVerificationEvent(db, {
                    revisionId: leftRevisionId,
                    observationId: foreign.observationId,
                    outcome: "verified",
                    verifier: "dreamer",
                }),
            ).toThrow(/revision project/);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("storage-claims: fail-closed reads and lifecycle", () => {
    test("direct-SQL null pointers and evidence-less revisions are rejected as corruption", () => {
        const db = migratedDb();
        try {
            const chain = seedEvidenceChain(db);
            const now = Date.now();
            const corruptClaimId = Number(
                (
                    db
                        .prepare(
                            "INSERT INTO claims (project_id, subject, predicate, scope, state, created_at) VALUES (?, 'corrupt', 'p', '', 'active', ?)",
                        )
                        .run(chain.projectId, now) as { lastInsertRowid: number | bigint }
                ).lastInsertRowid,
            );
            const orphanRevisionId = Number(
                (
                    db
                        .prepare(
                            "INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at) VALUES (?, 1, 'orphan', ?, ?)",
                        )
                        .run(corruptClaimId, sha256Utf8Hex("orphan"), now) as {
                        lastInsertRowid: number | bigint;
                    }
                ).lastInsertRowid,
            );

            expect(findClaimGraphCorruption(db)).toEqual({
                nullPointerClaimIds: [corruptClaimId],
                evidencelessRevisionIds: [orphanRevisionId],
                stalePointerClaimIds: [],
            });
            expect(() => getClaimById(db, corruptClaimId)).toThrow(ClaimGraphCorruptionError);
            expect(() => listClaimRevisions(db, corruptClaimId)).toThrow(ClaimGraphCorruptionError);
            expect(() => getRevisionEvidence(db, orphanRevisionId)).toThrow(
                ClaimGraphCorruptionError,
            );
            expect(getRevisionEvidence(db, 999_999)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a null pointer fails listClaimRevisions closed even when every revision is evidenced", () => {
        const db = migratedDb();
        try {
            const chain = seedEvidenceChain(db);
            const now = Date.now();
            const claimId = Number(
                (
                    db
                        .prepare(
                            "INSERT INTO claims (project_id, subject, predicate, scope, state, created_at) VALUES (?, 'null-ptr', 'p', '', 'active', ?)",
                        )
                        .run(chain.projectId, now) as { lastInsertRowid: number | bigint }
                ).lastInsertRowid,
            );
            const revisionId = Number(
                (
                    db
                        .prepare(
                            "INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at) VALUES (?, 1, 'evidenced', ?, ?)",
                        )
                        .run(claimId, sha256Utf8Hex("evidenced"), now) as {
                        lastInsertRowid: number | bigint;
                    }
                ).lastInsertRowid,
            );
            db.prepare(
                "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) VALUES (?, ?, 'supports', ?)",
            ).run(revisionId, chain.observationId, now);

            expect(() => listClaimRevisions(db, claimId)).toThrow(ClaimGraphCorruptionError);
            expect(listClaimRevisions(db, 999_999)).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a backward-repointed claim reads as stale-pointer corruption and appends fail typed", () => {
        const db = migratedDb();
        try {
            const chain = seedEvidenceChain(db);
            const created = createClaim(db, {
                projectId: chain.projectId,
                subject: "pointer",
                predicate: "p",
                content: "v1",
                evidence: [{ observationId: chain.observationId }],
            });
            if (created.status !== "applied") throw new Error("createClaim failed");
            const appended = appendClaimRevision(db, {
                claimId: created.claimId,
                expectedCurrentRevisionId: created.revisionId,
                content: "v2",
                evidence: [{ observationId: chain.observationId }],
            });
            if (appended.status !== "applied") throw new Error("appendClaimRevision failed");

            // Direct SQL can move the pointer back to an older same-claim
            // revision; the clear guard and composite FK both permit it.
            db.prepare("UPDATE claims SET current_revision_id = ? WHERE id = ?").run(
                created.revisionId,
                created.claimId,
            );

            expect(findClaimGraphCorruption(db).stalePointerClaimIds).toEqual([created.claimId]);
            expect(() =>
                appendClaimRevision(db, {
                    claimId: created.claimId,
                    expectedCurrentRevisionId: created.revisionId,
                    content: "v3",
                    evidence: [{ observationId: chain.observationId }],
                }),
            ).toThrow(ClaimGraphCorruptionError);
            // Ordinary readers refuse to serve the rolled-back revision as
            // current instead of silently presenting stale history.
            expect(() => getCurrentClaimRevision(db, created.claimId)).toThrow(
                ClaimGraphCorruptionError,
            );
            expect(() => listClaimRevisions(db, created.claimId)).toThrow(
                ClaimGraphCorruptionError,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("the canonical-identity predicate agrees across the writer, the shared helper, and the DDL CHECK", () => {
        const writerDb = migratedDb();
        const ddlDb = migratedDb();
        try {
            const fixtures = [
                "git:abc123",
                "dir:deadbeef",
                "git:a",
                "dir:a b",
                "git:",
                "dir:",
                "git",
                "",
                "/home/user/project",
                "GIT:abc",
                "gitx:abc",
            ];
            for (const identity of fixtures) {
                const shared = isCanonicalProjectIdentity(identity);
                let writerAccepts = true;
                try {
                    ensureProject(writerDb, identity);
                } catch {
                    writerAccepts = false;
                }
                let ddlAccepts = true;
                try {
                    ddlDb
                        .prepare(
                            "INSERT INTO projects (canonical_identity, created_at) VALUES (?, 1)",
                        )
                        .run(identity);
                } catch {
                    ddlAccepts = false;
                }
                expect(`${identity}:${writerAccepts}`).toBe(`${identity}:${shared}`);
                expect(`${identity}:${ddlAccepts}`).toBe(`${identity}:${shared}`);
            }
        } finally {
            closeQuietly(writerDb);
            closeQuietly(ddlDb);
        }
    });

    test("clearSession preserves durable evidence that carries source_session_id provenance", () => {
        const db = migratedDb();
        try {
            const sessionId = "ses_durable";
            db.prepare(
                "INSERT INTO session_meta (session_id, last_response_time) VALUES (?, 1)",
            ).run(sessionId);
            const chain = seedEvidenceChain(db, "git:durable-project", sessionId);
            const created = createClaim(db, {
                projectId: chain.projectId,
                subject: "s",
                predicate: "p",
                content: "durable content",
                evidence: [{ observationId: chain.observationId }],
                sourceSessionId: sessionId,
            });
            if (created.status !== "applied") throw new Error("create failed");
            addVerificationEvent(db, {
                revisionId: created.revisionId,
                outcome: "verified",
                verifier: "dreamer",
            });

            clearSession(db, sessionId);

            expect(rowCount(db, "session_meta")).toBe(0);
            expect(rowCount(db, "episodes")).toBe(1);
            expect(rowCount(db, "source_spans")).toBe(1);
            expect(rowCount(db, "observations")).toBe(1);
            expect(rowCount(db, "claims")).toBe(1);
            expect(rowCount(db, "claim_revisions")).toBe(1);
            expect(rowCount(db, "claim_evidence")).toBe(1);
            expect(rowCount(db, "verification_events")).toBe(1);
            expect(getCurrentClaimRevision(db, created.claimId)?.sourceSessionId).toBe(sessionId);
        } finally {
            closeQuietly(db);
        }
    });
});
