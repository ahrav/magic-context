/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { APPLICABILITY_STREAM_KEY_PROTOCOL } from "../storage-claim-applicability-schema";
import { createDirectTestDatabase } from "../test-database";
import {
    ApplicabilityWriteError,
    appendApplicabilityAssertionInCurrentTransaction,
    computeApplicabilitySourceDigest,
    ensureApplicabilityStreamInCurrentTransaction,
    readApplicabilityIntervals,
    readCurrentApplicabilityAssertions,
} from "./storage-claim-applicability";
import {
    appendClaimRevision,
    createClaim,
    createEpisode,
    createObservation,
    createSourceSpan,
    ensureProject,
} from "./storage-claims";

function migratedDb(): Database {
    const db = createDirectTestDatabase().db;
    db.exec("PRAGMA foreign_keys=ON");
    return db;
}

interface Fixture {
    db: Database;
    projectId: number;
    claimId: number;
    revisionId: number;
    observationId: number;
}

function fixture(db: Database, identity = "git:applicability-fixture"): Fixture {
    const projectId = ensureProject(db, identity);
    const episodeId = createEpisode(db, { projectId });
    const spanId = createSourceSpan(db, {
        episodeId,
        sourceLocator: "fixture",
        content: "fixture content",
        startOffset: 0,
        endOffset: 15,
    });
    const observationId = createObservation(db, {
        sourceSpanId: spanId,
        extractedText: "fixture content",
        extractor: "fixture",
        extractorVersion: "1",
        extractorRunId: "run-1",
        independenceKey: "key-1",
    });
    const created = createClaim(db, {
        projectId,
        subject: `subject:${identity}`,
        predicate: "states",
        content: "fixture claim",
        evidence: [{ observationId }],
    });
    if (created.status !== "applied") throw new Error(`fixture claim failed: ${created.status}`);
    return {
        db,
        projectId,
        claimId: created.claimId,
        revisionId: created.revisionId,
        observationId,
    };
}

function inTx<T>(db: Database, fn: () => T): T {
    return db.transaction(fn).immediate();
}

describe("claim applicability streams and assertions", () => {
    test("claim create writes a default unknown baseline; a successor closes only its own stream (AE2)", () => {
        const db = migratedDb();
        try {
            const { projectId, revisionId } = fixture(db);
            const heads = readCurrentApplicabilityAssertions(db, revisionId);
            expect(heads).toHaveLength(1);
            expect(heads[0]?.state).toBe("unknown");
            expect(heads[0]?.pathsState).toBe("unknown");
            expect(heads[0]?.seq).toBe(1);

            const other = inTx(db, () =>
                ensureApplicabilityStreamInCurrentTransaction(db, {
                    revisionId,
                    projectId,
                    ownerKind: "source",
                    streamKey: "other-source:v1",
                    keyProtocol: APPLICABILITY_STREAM_KEY_PROTOCOL,
                    sourceDigest: computeApplicabilitySourceDigest({ other: true }),
                }),
            );
            inTx(db, () =>
                appendApplicabilityAssertionInCurrentTransaction(db, {
                    streamId: other.streamId,
                    state: "unknown",
                    paths: { state: "unknown" },
                    knownFrom: 1_000,
                }),
            );

            const baseline = heads[0];
            if (!baseline) throw new Error("baseline head missing");
            inTx(db, () =>
                appendApplicabilityAssertionInCurrentTransaction(db, {
                    streamId: baseline.streamId,
                    state: "historical",
                    paths: { state: "unknown" },
                    knownFrom: (baseline.knownFrom ?? 0) + 5_000,
                }),
            );

            const intervals = readApplicabilityIntervals(db, revisionId);
            const baselineFirst = intervals.find(
                (row) => row.streamId === baseline.streamId && row.seq === 1,
            );
            expect(baselineFirst?.knownUntil).toBe((baseline.knownFrom ?? 0) + 5_000);
            expect(baselineFirst?.recordedUntil).not.toBeNull();
            const otherInterval = intervals.find((row) => row.streamId === other.streamId);
            expect(otherInterval?.knownUntil).toBeNull();
            expect(otherInterval?.recordedUntil).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("stream replay with the stored key verifies the digest instead of duplicating; a mismatch throws", () => {
        const db = migratedDb();
        try {
            const { projectId, revisionId } = fixture(db);
            const input = {
                revisionId,
                projectId,
                ownerKind: "source" as const,
                streamKey: "source-replay:v1",
                keyProtocol: APPLICABILITY_STREAM_KEY_PROTOCOL,
                sourceDigest: computeApplicabilitySourceDigest({ source: "replay" }),
            };
            const first = inTx(db, () => ensureApplicabilityStreamInCurrentTransaction(db, input));
            expect(first.created).toBeTrue();
            const replay = inTx(db, () => ensureApplicabilityStreamInCurrentTransaction(db, input));
            expect(replay).toEqual({ streamId: first.streamId, created: false });
            expect(() =>
                inTx(db, () =>
                    ensureApplicabilityStreamInCurrentTransaction(db, {
                        ...input,
                        sourceDigest: "f".repeat(64),
                    }),
                ),
            ).toThrow(/different source digest/);
            expect(() =>
                inTx(db, () =>
                    ensureApplicabilityStreamInCurrentTransaction(db, {
                        ...input,
                        branchSelector: "main",
                    }),
                ),
            ).toThrow(/different branch selector/);
        } finally {
            closeQuietly(db);
        }
    });

    test("evaluation streams require a context fingerprint at the typed layer", () => {
        const db = migratedDb();
        try {
            const { projectId, revisionId } = fixture(db);
            expect(() =>
                inTx(db, () =>
                    ensureApplicabilityStreamInCurrentTransaction(db, {
                        revisionId,
                        projectId,
                        ownerKind: "evaluation",
                        streamKey: "eval:v1",
                        keyProtocol: APPLICABILITY_STREAM_KEY_PROTOCOL,
                        sourceDigest: computeApplicabilitySourceDigest({ eval: true }),
                    }),
                ),
            ).toThrow(ApplicabilityWriteError);
        } finally {
            closeQuietly(db);
        }
    });

    test("typed validation rejects regressing time, closed intervals without an opening, and mixed symbol protocols", () => {
        const db = migratedDb();
        try {
            const { revisionId } = fixture(db);
            const head = readCurrentApplicabilityAssertions(db, revisionId)[0];
            if (!head) throw new Error("baseline head missing");
            expect(() =>
                inTx(db, () =>
                    appendApplicabilityAssertionInCurrentTransaction(db, {
                        streamId: head.streamId,
                        state: "unknown",
                        paths: { state: "unknown" },
                        knownFrom: (head.knownFrom ?? 2) - 1,
                    }),
                ),
            ).toThrow(/regresses/);
            expect(() =>
                inTx(db, () =>
                    appendApplicabilityAssertionInCurrentTransaction(db, {
                        streamId: head.streamId,
                        state: "unknown",
                        paths: { state: "unknown" },
                        recordedAt: head.recordedAt - 1,
                    }),
                ),
            ).toThrow(/regresses/);
            expect(() =>
                inTx(db, () =>
                    appendApplicabilityAssertionInCurrentTransaction(db, {
                        streamId: head.streamId,
                        state: "historical",
                        paths: { state: "unknown" },
                        validUntilAnchorId: 1,
                    }),
                ),
            ).toThrow(/valid-from anchor/);
            expect(() =>
                inTx(db, () =>
                    appendApplicabilityAssertionInCurrentTransaction(db, {
                        streamId: head.streamId,
                        state: "unknown",
                        paths: { state: "unknown" },
                        symbols: [
                            { protocol: "sym-v1", value: "a()" },
                            { protocol: "sym-v2", value: "b()" },
                        ],
                    }),
                ),
            ).toThrow(/conflicting symbol selector protocols/);
            expect(() =>
                inTx(db, () =>
                    appendApplicabilityAssertionInCurrentTransaction(db, {
                        streamId: head.streamId,
                        state: "unknown",
                        paths: { state: "unknown" },
                        dependencyFingerprint: "abc",
                    }),
                ),
            ).toThrow(/canonicalization protocol/);
        } finally {
            closeQuietly(db);
        }
    });

    test("unknown, known-empty, exact, and glob path states stay distinct through write and read", () => {
        const db = migratedDb();
        try {
            const { projectId, revisionId } = fixture(db);
            const cases: Array<{
                key: string;
                paths: { state: "unknown" } | { state: "known"; exact?: string[]; glob?: string[] };
                expected: { pathsState: string; paths: Array<{ kind: string; value: string }> };
            }> = [
                {
                    key: "case-unknown",
                    paths: { state: "unknown" },
                    expected: { pathsState: "unknown", paths: [] },
                },
                {
                    key: "case-known-empty",
                    paths: { state: "known" },
                    expected: { pathsState: "known", paths: [] },
                },
                {
                    key: "case-exact",
                    paths: { state: "known", exact: ["src/b.ts", "src/a.ts", "src/a.ts"] },
                    expected: {
                        pathsState: "known",
                        paths: [
                            { kind: "exact", value: "src/a.ts" },
                            { kind: "exact", value: "src/b.ts" },
                        ],
                    },
                },
                {
                    key: "case-glob",
                    paths: { state: "known", glob: ["src/**/*.ts"] },
                    expected: {
                        pathsState: "known",
                        paths: [{ kind: "glob", value: "src/**/*.ts" }],
                    },
                },
            ];
            for (const item of cases) {
                const stream = inTx(db, () =>
                    ensureApplicabilityStreamInCurrentTransaction(db, {
                        revisionId,
                        projectId,
                        ownerKind: "source",
                        streamKey: `${item.key}:v1`,
                        keyProtocol: APPLICABILITY_STREAM_KEY_PROTOCOL,
                        sourceDigest: computeApplicabilitySourceDigest(item.key),
                    }),
                );
                inTx(db, () =>
                    appendApplicabilityAssertionInCurrentTransaction(db, {
                        streamId: stream.streamId,
                        state: "unknown",
                        paths: item.paths,
                    }),
                );
                const head = readCurrentApplicabilityAssertions(db, revisionId).find(
                    (candidate) => candidate.streamId === stream.streamId,
                );
                expect(head?.pathsState, item.key).toBe(
                    item.expected.pathsState as "unknown" | "known",
                );
                expect(head?.paths, item.key).toEqual(item.expected.paths as never);
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("appendClaimRevision writes the caller-supplied applicability atomically with the revision", () => {
        const db = migratedDb();
        try {
            const { projectId, claimId, revisionId, observationId } = fixture(db);
            const appended = appendClaimRevision(db, {
                claimId,
                expectedCurrentRevisionId: revisionId,
                content: "updated fixture claim",
                evidence: [{ observationId }],
                applicability: {
                    ownerKind: "source",
                    streamKey: "source-append:v1",
                    keyProtocol: APPLICABILITY_STREAM_KEY_PROTOCOL,
                    sourceDigest: computeApplicabilitySourceDigest({ source: "append" }),
                    assertion: {
                        state: "unknown",
                        paths: { state: "known", exact: ["src/x.ts"] },
                        knownFrom: 9_999_999,
                    },
                },
            });
            if (appended.status !== "applied") throw new Error(appended.status);
            const heads = readCurrentApplicabilityAssertions(db, appended.revisionId);
            expect(heads).toHaveLength(1);
            expect(heads[0]?.streamKey).toBe("source-append:v1");
            expect(heads[0]?.paths).toEqual([{ kind: "exact", value: "src/x.ts" }]);
            expect(projectId).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("a stale append leaves no stream or assertion residue", () => {
        const db = migratedDb();
        try {
            const { claimId, revisionId, observationId } = fixture(db);
            const streams = () =>
                (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM claim_revision_applicability_streams",
                        )
                        .get() as { count: number }
                ).count;
            const before = streams();
            const stale = appendClaimRevision(db, {
                claimId,
                expectedCurrentRevisionId: revisionId + 999,
                content: "stale write",
                evidence: [{ observationId }],
            });
            expect(stale.status).toBe("stale");
            expect(streams()).toBe(before);
        } finally {
            closeQuietly(db);
        }
    });

    test("an applicability failure after the revision insert rolls back the whole append", () => {
        const db = migratedDb();
        try {
            const { claimId, revisionId, observationId } = fixture(db);
            const revisions = () =>
                (
                    db.prepare("SELECT COUNT(*) AS count FROM claim_revisions").get() as {
                        count: number;
                    }
                ).count;
            const before = revisions();
            expect(() =>
                appendClaimRevision(db, {
                    claimId,
                    expectedCurrentRevisionId: revisionId,
                    content: "rolled back revision",
                    evidence: [{ observationId }],
                    applicability: {
                        ownerKind: "evaluation",
                        streamKey: "eval-rollback:v1",
                        keyProtocol: APPLICABILITY_STREAM_KEY_PROTOCOL,
                        sourceDigest: computeApplicabilitySourceDigest({ evalRollback: true }),
                        assertion: { state: "unknown", paths: { state: "unknown" } },
                    },
                }),
            ).toThrow(ApplicabilityWriteError);
            expect(revisions()).toBe(before);
            expect(
                (
                    db
                        .prepare("SELECT current_revision_id AS pointer FROM claims WHERE id = ?")
                        .get(claimId) as { pointer: number }
                ).pointer,
            ).toBe(revisionId);
        } finally {
            closeQuietly(db);
        }
    });

    test("a NULL known_from gap cannot reopen an older knowledge time at the typed layer", () => {
        const db = migratedDb();
        try {
            const { revisionId } = fixture(db);
            const head = readCurrentApplicabilityAssertions(db, revisionId)[0];
            if (!head?.knownFrom) throw new Error("baseline head missing knownFrom");
            const baseKnownFrom = head.knownFrom;
            inTx(db, () =>
                appendApplicabilityAssertionInCurrentTransaction(db, {
                    streamId: head.streamId,
                    state: "unknown",
                    paths: { state: "unknown" },
                }),
            );
            expect(() =>
                inTx(db, () =>
                    appendApplicabilityAssertionInCurrentTransaction(db, {
                        streamId: head.streamId,
                        state: "unknown",
                        paths: { state: "unknown" },
                        knownFrom: baseKnownFrom - 1,
                    }),
                ),
            ).toThrow(/regresses/);
        } finally {
            closeQuietly(db);
        }
    });
});
