/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import type { SourceTrustClass } from "../storage-claim-applicability-schema";
import { createDirectTestDatabase } from "../test-database";
import { computeWorkspaceEpochFingerprint } from "../workspaces";
import { readAuthorizedClaimMemorySnapshot } from "./claim-memory-render";
import { CLAIM_POLICY_VERSION } from "./claim-visibility-policy";
import { createAntiMemory } from "./storage-anti-memory";
import { readProjectMemoryCurrentState } from "./storage-claim-current-state";
import {
    type ClaimEvidenceProvenance,
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
    getProjectMemoryClaimByPublicId,
    recordClaimUsage,
    setProjectMemoryClaimLifecycle,
} from "./storage-claim-operations";
import {
    ClaimGraphCorruptionError,
    createClaimInCurrentTransaction,
    createEpisode,
    createObservation,
    createSourceSpan,
    ensureProject,
} from "./storage-claims";

function provenance(
    independenceKey: string,
    run = "run-1",
    sourceTrustClass: SourceTrustClass = "explicit_user",
): ClaimEvidenceProvenance {
    return {
        sourceLocator: "transcript://u2-current",
        sourceContent: `raw source for ${independenceKey}`,
        extractor: "historian",
        extractorVersion: "2",
        extractorRunId: run,
        independenceKey,
        sourceTrustClass,
    };
}

interface Ctx {
    db: Database;
    projectId: number;
    incarnation: string;
}

function setup(): Ctx {
    const { db, marker } = createDirectTestDatabase();
    const projectId = ensureProject(db, "git:u2-current");
    return { db, projectId, incarnation: marker.databaseIncarnationId };
}

function createClaimOp(ctx: Ctx, key: string, content: string, category = "ARCHITECTURE") {
    return createProjectMemoryClaim(
        ctx.db,
        { producer: "test", operationKey: key },
        {
            projectId: ctx.projectId,
            content,
            category,
            provenance: provenance(`ik-${key}`),
            actor: "user:test",
        },
    );
}

function publicIdOf(result: ReturnType<typeof createProjectMemoryClaim>): string {
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

describe("current-state provider: hydration", () => {
    test("hydrates attributes, evidence, applicability, lifecycle, policy, telemetry, and token under one snapshot", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-a", "Hydration test claim.");
            const publicId = publicIdOf(created);
            recordClaimUsage(ctx.db, { publicClaimIds: [publicId], kind: "retrieved" });

            const result = readProjectMemoryCurrentState(ctx.db, {
                projectIds: [ctx.projectId],
                surface: "explicit_search",
            });
            expect(result.status).toBe("ok");
            if (result.status !== "ok") throw new Error("unreachable");
            expect(result.items).toHaveLength(1);
            const item = result.items[0];
            expect(item.publicClaimId).toBe(publicId);
            expect(item.revision).toBe(1);
            expect(item.content).toBe("Hydration test claim.");
            expect(item.category).toBe("ARCHITECTURE");
            expect(item.sharing).toBe("private");
            expect(item.lifecycleState).toBe("active");
            expect(item.evidence.observationCount).toBe(1);
            expect(item.applicability).toHaveLength(1);
            // Explicit-user first revisions reach VERIFIED automatically.
            expect(item.policy.effectiveMaturity).toBe("VERIFIED");
            expect(item.telemetry.retrievalCount).toBe(1);
            expect(item.mutationToken).toEqual(computeProjectMemoryMutationToken(ctx.db, publicId));
            expect(result.snapshotVector.databaseIncarnationId).toBe(ctx.incarnation);
            expect(result.snapshotVector.projectGenerations[String(ctx.projectId)]).toBe(1);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("resolves exact public locators and rejects malformed requested IDs", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-a", "Locator test claim.");
            const publicId = publicIdOf(created);
            createClaimOp(ctx, "op-b", "Other claim.");
            const result = readProjectMemoryCurrentState(ctx.db, { publicClaimIds: [publicId] });
            expect(result.status).toBe("ok");
            if (result.status !== "ok") throw new Error("unreachable");
            expect(result.items).toHaveLength(1);
            expect(result.items[0].publicClaimId).toBe(publicId);
            expect(() =>
                readProjectMemoryCurrentState(ctx.db, { publicClaimIds: ["not-a-locator"] }),
            ).toThrow(/malformed public claim ID/);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("a fresh write between reads moves the snapshot vector", () => {
        const ctx = setup();
        try {
            createClaimOp(ctx, "op-a", "Vector test claim.");
            const first = readProjectMemoryCurrentState(ctx.db, { projectIds: [ctx.projectId] });
            createClaimOp(ctx, "op-b", "Second claim.");
            const second = readProjectMemoryCurrentState(ctx.db, { projectIds: [ctx.projectId] });
            expect(first.status).toBe("ok");
            expect(second.status).toBe("ok");
            if (first.status !== "ok" || second.status !== "ok") throw new Error("unreachable");
            expect(second.snapshotVector.projectGenerations[String(ctx.projectId)]).toBe(
                (first.snapshotVector.projectGenerations[String(ctx.projectId)] as number) + 1,
            );
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("current-state provider: anti-memory surface exclusion", () => {
    test("denies automatic surfaces while preserving explicit search", () => {
        const ctx = setup();
        try {
            const positive = createClaimOp(ctx, "positive", "Positive fact.");
            const anti = createAntiMemory(
                ctx.db,
                { producer: "test", operationKey: "anti" },
                {
                    projectId: ctx.projectId,
                    payload: {
                        trigger: "cache work",
                        rejectedStrategy: "use Redis",
                        rejectionReason: "operational burden",
                    },
                    provenance: provenance("anti", "run-anti", "explicit_user"),
                    actor: "host:user-corroborated",
                    nowMs: 1,
                },
            );
            const antiId = publicIdOf(anti);

            for (const surface of ["auto_inject", "auto_search"] as const) {
                const automatic = readProjectMemoryCurrentState(ctx.db, {
                    projectIds: [ctx.projectId],
                    surface,
                    nowMs: 2,
                });
                expect(automatic.status).toBe("ok");
                if (automatic.status !== "ok") throw new Error("unreachable");
                expect(automatic.items.map((item) => item.publicClaimId)).toEqual([
                    publicIdOf(positive),
                ]);
            }

            const explicit = readProjectMemoryCurrentState(ctx.db, {
                projectIds: [ctx.projectId],
                surface: "explicit_search",
                nowMs: 2,
            });
            expect(explicit.status).toBe("ok");
            if (explicit.status !== "ok") throw new Error("unreachable");
            expect(explicit.items.map((item) => item.publicClaimId)).toContain(antiId);
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("current-state provider: workspace revalidation", () => {
    test("a workspace epoch change between authorization and publication is stale", () => {
        // The caller authorizes against a snapshot taken before the read. If
        // membership or shared categories are revoked in flight, echoing the
        // caller's epoch made the staleness check compare a value to itself, so
        // a claim from a since-removed project could still be published.
        const ctx = setup();
        try {
            createClaimOp(ctx, "op-a", "Workspace claim content.");
            const identities = ["git:u2-current"];
            // The direct fixture carries claim tables only; the workspace
            // fingerprint reads the project epoch from `project_state`.
            ctx.db.exec(`
                CREATE TABLE IF NOT EXISTS project_state (
                    project_path TEXT PRIMARY KEY,
                    project_memory_epoch INTEGER NOT NULL DEFAULT 0
                );
            `);
            ctx.db
                .prepare(
                    "INSERT OR REPLACE INTO project_state (project_path, project_memory_epoch) VALUES (?, 1)",
                )
                .run("git:u2-current");
            const epochBefore = computeWorkspaceEpochFingerprint(ctx.db, identities);

            // Same state: the read publishes.
            const ok = readProjectMemoryCurrentState(ctx.db, {
                projectIds: [ctx.projectId],
                workspaceEpoch: epochBefore,
                workspaceIdentities: identities,
            });
            expect(ok.status).toBe("ok");

            // Revoke: bump the project's memory epoch, which the fingerprint covers.
            ctx.db
                .prepare(
                    "UPDATE project_state SET project_memory_epoch = project_memory_epoch + 1 WHERE project_path = ?",
                )
                .run("git:u2-current");
            expect(computeWorkspaceEpochFingerprint(ctx.db, identities)).not.toBe(epochBefore);

            const stale = readProjectMemoryCurrentState(ctx.db, {
                projectIds: [ctx.projectId],
                // The epoch the caller authorized against is now out of date.
                workspaceEpoch: epochBefore,
                workspaceIdentities: identities,
            });
            expect(stale.status).toBe("stale");
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("auto-injection lane: workspace revalidation", () => {
    test("a revoked workspace makes the automatic lane refuse to publish", () => {
        // Automatic injection has the least recourse of any surface: nothing
        // downstream re-checks authorization. A workspace mutation bumps
        // project_memory_epoch, not the claim generation in the vector, so the
        // recomputed fingerprint is the only signal that sharing changed.
        const ctx = setup();
        try {
            createClaimOp(ctx, "op-auto", "Auto-injected claim.");
            ctx.db.exec(`
                CREATE TABLE IF NOT EXISTS project_state (
                    project_path TEXT PRIMARY KEY,
                    project_memory_epoch INTEGER NOT NULL DEFAULT 0
                );
            `);
            ctx.db
                .prepare(
                    "INSERT OR REPLACE INTO project_state (project_path, project_memory_epoch) VALUES (?, 1)",
                )
                .run("git:u2-current");
            const identities = ["git:u2-current"];
            const epoch = computeWorkspaceEpochFingerprint(ctx.db, identities);

            const served = readAuthorizedClaimMemorySnapshot(ctx.db, {
                authorizedIdentities: identities,
                ownIdentities: identities,
                sharedCategories: [],
                workspaceEpoch: epoch,
                workspaceIdentities: identities,
            });
            expect(served?.items.length ?? 0).toBeGreaterThan(0);

            // Sharing revoked after the caller authorized.
            ctx.db
                .prepare(
                    "UPDATE project_state SET project_memory_epoch = project_memory_epoch + 1 WHERE project_path = ?",
                )
                .run("git:u2-current");

            const refused = readAuthorizedClaimMemorySnapshot(ctx.db, {
                authorizedIdentities: identities,
                ownIdentities: identities,
                sharedCategories: [],
                workspaceEpoch: epoch,
                workspaceIdentities: identities,
            });
            expect(refused).toBeNull();
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("current-state provider: unsupported policy version", () => {
    test("a future policy version fails closed on auto-inject and is labeled unknown in search", () => {
        // An older process still attached to the database must not trust a
        // projection a newer writer produced: its stored bits were decided under
        // policy semantics this binary cannot interpret. The shared evaluator and
        // the legacy adapter both fail closed here.
        const ctx = setup();
        try {
            const claim = createClaimOp(ctx, "op-future", "Future-policy claim.");
            const claimRef = getProjectMemoryClaimByPublicId(ctx.db, publicIdOf(claim));
            if (!claimRef) throw new Error("unreachable");
            ctx.db
                .prepare(
                    "UPDATE claim_effective_policy SET policy_version = ?, auto_eligible = 1, explicit_eligible = 1 WHERE revision_id = ?",
                )
                .run(CLAIM_POLICY_VERSION + 1, claimRef.currentRevisionId);

            const auto = readProjectMemoryCurrentState(ctx.db, {
                projectIds: [ctx.projectId],
                surface: "auto_inject",
                limit: 10,
            });
            expect(auto.status).toBe("ok");
            if (auto.status !== "ok") throw new Error("unreachable");
            expect(auto.items.map((item) => item.publicClaimId)).not.toContain(publicIdOf(claim));

            // Explicit search may still serve it, but only as a labeled unknown.
            const explicit = readProjectMemoryCurrentState(ctx.db, {
                projectIds: [ctx.projectId],
                surface: "explicit_search",
                limit: 10,
            });
            expect(explicit.status).toBe("ok");
            if (explicit.status !== "ok") throw new Error("unreachable");
            const served = explicit.items.find((item) => item.publicClaimId === publicIdOf(claim));
            expect(served?.explicitLabel ?? "").toContain("policy:unknown");
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("current-state provider: visibility before limits", () => {
    test("policy-hidden claims never consume a candidate slot", () => {
        const ctx = setup();
        try {
            const hidden = createClaimOp(ctx, "op-hidden", "Hidden claim content.");
            const visibleA = createClaimOp(ctx, "op-a", "Visible claim A.");
            const visibleB = createClaimOp(ctx, "op-b", "Visible claim B.");
            // Quarantine hard-hides the first claim's current revision.
            const hiddenRef = getProjectMemoryClaimByPublicId(ctx.db, publicIdOf(hidden));
            if (!hiddenRef) throw new Error("unreachable");
            ctx.db
                .transaction(() => {
                    ctx.db
                        .prepare(
                            `INSERT INTO claim_disposition_events
                            (revision_id, project_id, disposition, action, actor, policy_version, recorded_at)
                         VALUES (?, ?, 'quarantined', 'assert', 'user:test', 1, ?)`,
                        )
                        .run(hiddenRef.currentRevisionId, ctx.projectId, Date.now());
                    ctx.db
                        .prepare(
                            "UPDATE claim_effective_policy SET hard_hidden = 1, auto_eligible = 0, explicit_eligible = 0 WHERE revision_id = ?",
                        )
                        .run(hiddenRef.currentRevisionId);
                })
                .immediate();

            const result = readProjectMemoryCurrentState(ctx.db, {
                projectIds: [ctx.projectId],
                surface: "explicit_search",
                limit: 2,
            });
            expect(result.status).toBe("ok");
            if (result.status !== "ok") throw new Error("unreachable");
            expect(result.items.map((item) => item.publicClaimId).sort()).toEqual(
                [publicIdOf(visibleA), publicIdOf(visibleB)].sort(),
            );
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("lifecycle filtering excludes archived claims from the default view", () => {
        const ctx = setup();
        try {
            const archived = createClaimOp(ctx, "op-archived", "Archived claim.");
            createClaimOp(ctx, "op-live", "Live claim.");
            const token = computeProjectMemoryMutationToken(ctx.db, publicIdOf(archived));
            setProjectMemoryClaimLifecycle(
                ctx.db,
                { producer: "test", operationKey: "op-archive" },
                { token, state: "archived", actor: "user:test" },
            );
            const live = readProjectMemoryCurrentState(ctx.db, { projectIds: [ctx.projectId] });
            expect(live.status).toBe("ok");
            if (live.status !== "ok") throw new Error("unreachable");
            expect(live.items).toHaveLength(1);
            const withArchived = readProjectMemoryCurrentState(ctx.db, {
                projectIds: [ctx.projectId],
                lifecycleStates: ["active", "archived"],
            });
            expect(withArchived.status).toBe("ok");
            if (withArchived.status !== "ok") throw new Error("unreachable");
            expect(withArchived.items).toHaveLength(2);
        } finally {
            closeQuietly(ctx.db);
        }
    });
});

describe("current-state provider: fail-closed corruption (scenario 12)", () => {
    test("a null current-revision pointer fails closed", () => {
        const ctx = setup();
        try {
            ctx.db
                .transaction(() => {
                    ctx.db
                        .prepare(
                            `INSERT INTO claims (project_id, subject, predicate, scope, state, current_revision_id, created_at)
                         VALUES (?, ?, 'states', 'project-memory', 'active', NULL, 0)`,
                        )
                        .run(ctx.projectId, `mcm_${"1".repeat(32)}`);
                    const claimId = (
                        ctx.db.prepare("SELECT MAX(id) AS id FROM claims").get() as { id: number }
                    ).id;
                    ctx.db
                        .prepare(
                            "INSERT INTO claim_public_ids (claim_id, public_id, created_at) VALUES (?, ?, 0)",
                        )
                        .run(claimId, `mcm_${"1".repeat(32)}`);
                })
                .immediate();
            expect(() =>
                readProjectMemoryCurrentState(ctx.db, { projectIds: [ctx.projectId] }),
            ).toThrow(ClaimGraphCorruptionError);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("a missing attributes row fails closed", () => {
        const ctx = setup();
        try {
            // A claim written outside the kernel: revision and evidence exist
            // but the project-memory attribute row does not.
            ctx.db
                .transaction(() => {
                    const episodeId = createEpisode(ctx.db, { projectId: ctx.projectId });
                    const spanId = createSourceSpan(ctx.db, {
                        episodeId,
                        sourceLocator: "transcript://raw",
                        content: "raw",
                        startOffset: 0,
                        endOffset: 3,
                    });
                    const observationId = createObservation(ctx.db, {
                        sourceSpanId: spanId,
                        extractedText: "bare claim",
                        extractor: "test",
                        extractorVersion: "1",
                        extractorRunId: "run",
                        independenceKey: "ik",
                    });
                    const created = createClaimInCurrentTransaction(ctx.db, {
                        projectId: ctx.projectId,
                        subject: `mcm_${"2".repeat(32)}`,
                        predicate: "states",
                        scope: "project-memory",
                        content: "bare claim",
                        evidence: [{ observationId }],
                    });
                    if (created.status !== "applied") throw new Error("create failed");
                    ctx.db
                        .prepare(
                            "INSERT INTO claim_public_ids (claim_id, public_id, created_at) VALUES (?, ?, 0)",
                        )
                        .run(created.claimId, `mcm_${"2".repeat(32)}`);
                })
                .immediate();
            expect(() =>
                readProjectMemoryCurrentState(ctx.db, { projectIds: [ctx.projectId] }),
            ).toThrow(/no attributes row/);
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("missing evidence and a stale current pointer fail closed", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-a", "Corruptible claim.");
            const ref = getProjectMemoryClaimByPublicId(ctx.db, publicIdOf(created));
            if (!ref) throw new Error("unreachable");
            // Direct SQL: a second revision with no evidence, pointer advanced.
            ctx.db
                .transaction(() => {
                    ctx.db
                        .prepare(
                            `INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at)
                         VALUES (?, 2, 'orphan revision', ?, 0)`,
                        )
                        .run(ref.claimId, "3".repeat(64));
                    const revisionId = (
                        ctx.db.prepare("SELECT MAX(id) AS id FROM claim_revisions").get() as {
                            id: number;
                        }
                    ).id;
                    ctx.db
                        .prepare("UPDATE claims SET current_revision_id = ? WHERE id = ?")
                        .run(revisionId, ref.claimId);
                    ctx.db
                        .prepare(
                            `INSERT INTO claim_memory_revision_attributes
                            (revision_id, claim_id, project_id, category, normalized_hash, importance, memory_scope, sharing, expires_at, created_at)
                         VALUES (?, ?, ?, 'ARCHITECTURE', 'orphanhash', 50, 'project', 'private', NULL, 0)`,
                        )
                        .run(revisionId, ref.claimId, ctx.projectId);
                })
                .immediate();
            expect(() =>
                readProjectMemoryCurrentState(ctx.db, { projectIds: [ctx.projectId] }),
            ).toThrow(/no evidence rows/);

            // Rewind the pointer by direct SQL: a stale current pointer.
            const rewound = createDirectTestDatabase().db;
            try {
                const projectId = ensureProject(rewound, "git:u2-current");
                const claim = createProjectMemoryClaim(
                    rewound,
                    { producer: "test", operationKey: "op-a" },
                    {
                        projectId,
                        content: "Pointer test claim.",
                        category: "ARCHITECTURE",
                        provenance: provenance("ik-a"),
                        actor: "user:test",
                    },
                );
                const refB = getProjectMemoryClaimByPublicId(rewound, publicIdOf(claim));
                if (!refB) throw new Error("unreachable");
                rewound
                    .prepare(
                        `INSERT INTO claim_revisions (claim_id, revision, content, content_sha256, created_at)
                         VALUES (?, 2, 'newer revision', ?, 0)`,
                    )
                    .run(refB.claimId, "4".repeat(64));
                expect(() =>
                    readProjectMemoryCurrentState(rewound, { projectIds: [projectId] }),
                ).toThrow(/history reaches/);
            } finally {
                closeQuietly(rewound);
            }
        } finally {
            closeQuietly(ctx.db);
        }
    });

    test("a malformed stored public ID and a broken lifecycle head fail closed", () => {
        const ctx = setup();
        try {
            const created = createClaimOp(ctx, "op-a", "Public id test claim.");
            const ref = getProjectMemoryClaimByPublicId(ctx.db, publicIdOf(created));
            if (!ref) throw new Error("unreachable");
            // Uppercase hex satisfies the CHECK's GLOB but not the contract.
            const malformed = createDirectTestDatabase().db;
            try {
                const projectId = ensureProject(malformed, "git:u2-current");
                malformed
                    .transaction(() => {
                        const episodeId = createEpisode(malformed, { projectId });
                        const spanId = createSourceSpan(malformed, {
                            episodeId,
                            sourceLocator: "transcript://raw",
                            content: "raw",
                            startOffset: 0,
                            endOffset: 3,
                        });
                        const observationId = createObservation(malformed, {
                            sourceSpanId: spanId,
                            extractedText: "malformed id claim",
                            extractor: "test",
                            extractorVersion: "1",
                            extractorRunId: "run",
                            independenceKey: "ik",
                        });
                        const claim = createClaimInCurrentTransaction(malformed, {
                            projectId,
                            subject: "malformed-subject",
                            predicate: "states",
                            scope: "project-memory",
                            content: "malformed id claim",
                            evidence: [{ observationId }],
                        });
                        if (claim.status !== "applied") throw new Error("create failed");
                        malformed
                            .prepare(
                                "INSERT INTO claim_public_ids (claim_id, public_id, created_at) VALUES (?, ?, 0)",
                            )
                            .run(claim.claimId, `mcm_${"ABCDEF012345".repeat(2)}00000000`);
                    })
                    .immediate();
                expect(() =>
                    readProjectMemoryCurrentState(malformed, { projectIds: [projectId] }),
                ).toThrow(/malformed public ID/);
            } finally {
                closeQuietly(malformed);
            }

            // A broken lifecycle head: attributes exist, ledger does not.
            const noLedger = createDirectTestDatabase().db;
            try {
                const projectId = ensureProject(noLedger, "git:u2-current");
                noLedger
                    .transaction(() => {
                        const episodeId = createEpisode(noLedger, { projectId });
                        const spanId = createSourceSpan(noLedger, {
                            episodeId,
                            sourceLocator: "transcript://raw",
                            content: "raw",
                            startOffset: 0,
                            endOffset: 3,
                        });
                        const observationId = createObservation(noLedger, {
                            sourceSpanId: spanId,
                            extractedText: "ledgerless claim",
                            extractor: "test",
                            extractorVersion: "1",
                            extractorRunId: "run",
                            independenceKey: "ik",
                        });
                        const claim = createClaimInCurrentTransaction(noLedger, {
                            projectId,
                            subject: `mcm_${"5".repeat(32)}`,
                            predicate: "states",
                            scope: "project-memory",
                            content: "ledgerless claim",
                            evidence: [{ observationId }],
                        });
                        if (claim.status !== "applied") throw new Error("create failed");
                        noLedger
                            .prepare(
                                "INSERT INTO claim_public_ids (claim_id, public_id, created_at) VALUES (?, ?, 0)",
                            )
                            .run(claim.claimId, `mcm_${"5".repeat(32)}`);
                        noLedger
                            .prepare(
                                `INSERT INTO claim_memory_revision_attributes
                                (revision_id, claim_id, project_id, category, normalized_hash, importance, memory_scope, sharing, expires_at, created_at)
                             VALUES (?, ?, ?, 'ARCHITECTURE', 'ledgerlesshash', 50, 'project', 'private', NULL, 0)`,
                            )
                            .run(claim.revisionId, claim.claimId, projectId);
                    })
                    .immediate();
                expect(() =>
                    readProjectMemoryCurrentState(noLedger, { projectIds: [projectId] }),
                ).toThrow(/no lifecycle head/);
            } finally {
                closeQuietly(noLedger);
            }
            expect(ref.revision).toBe(1);
        } finally {
            closeQuietly(ctx.db);
        }
    });
});
