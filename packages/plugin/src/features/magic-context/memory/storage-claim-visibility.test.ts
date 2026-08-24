/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { resolveMemoriesByIdsForSearch, unifiedSearch } from "../search";
import { initializeDatabase } from "../storage-db";
import {
    recordDispositionEventInCurrentTransaction,
    refreshEffectivePolicyInCurrentTransaction,
} from "./storage-claim-policy";
import {
    decideMemoryPolicy,
    filterMemoriesByPolicy,
    filterMemoriesForMaintenance,
    readMemoryPolicyRows,
} from "./storage-claim-visibility";
import { sha256Utf8Hex } from "./storage-claims";
import { getMemoriesByProject } from "./storage-memory";
import {
    createMemoryWithClaimsInCurrentTransaction,
    readMemoryClaimLink,
    runInMemoryClaimsWriteTransaction,
    updateMemoryVerificationWithClaimsInCurrentTransaction,
} from "./storage-memory-claims";

const PROJECT = "git:visibility-surfaces";

function migratedDb(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function seedMemory(
    db: Database,
    key: string,
    content: string,
    sourceType = "agent",
): { memoryId: number; claimId: number; revisionId: number; projectId: number } {
    const outcome = runInMemoryClaimsWriteTransaction(db, () =>
        createMemoryWithClaimsInCurrentTransaction(
            db,
            { producer: "vis-test", operationKey: key, requestDigest: sha256Utf8Hex(key) },
            {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content,
                normalizedHash: `hash:${content}`,
                importance: 60,
                sourceSessionId: "ses-vis",
                sourceType,
                nowMs: 1_000,
            },
        ),
    );
    const memoryId = outcome.result.memoryId;
    const link = readMemoryClaimLink(db, memoryId);
    if (!link) throw new Error("seed memory did not link");
    return {
        memoryId,
        claimId: link.claimId,
        revisionId: outcome.result.revisionId as number,
        projectId: link.projectId,
    };
}

function verify(db: Database, memoryId: number): void {
    runInMemoryClaimsWriteTransaction(db, () =>
        updateMemoryVerificationWithClaimsInCurrentTransaction(
            db,
            {
                producer: "vis-test",
                operationKey: `verify:${memoryId}`,
                requestDigest: sha256Utf8Hex(`verify:${memoryId}`),
            },
            { memoryId, verificationStatus: "verified", nowMs: 2_000 },
        ),
    );
}

function quarantine(db: Database, revisionId: number, projectId: number): void {
    runInMemoryClaimsWriteTransaction(db, () => {
        recordDispositionEventInCurrentTransaction(db, {
            revisionId,
            projectId,
            disposition: "quarantined",
            action: "assert",
            actor: "host",
        });
        refreshEffectivePolicyInCurrentTransaction(db, revisionId);
        return undefined;
    });
}

describe("claim policy surface enforcement", () => {
    test("a quarantined memory returns uniform absence on every agent surface", async () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "quarantine-1", "quarantined secret guidance");
            verify(db, seed.memoryId);
            const before = await unifiedSearch(db, "ses-vis", PROJECT, "quarantined secret", {
                limit: 10,
                memoryEnabled: true,
                embeddingEnabled: false,
                sources: ["memory"],
            });
            expect(before.some((r) => r.source === "memory")).toBeTrue();

            quarantine(db, seed.revisionId, seed.projectId);

            // Loaded-list filter: automatic and explicit surfaces both hide.
            const memories = getMemoriesByProject(db, PROJECT);
            expect(
                filterMemoriesByPolicy(db, memories, "auto_inject").memories.map((m) => m.id),
            ).not.toContain(seed.memoryId);
            expect(
                filterMemoriesByPolicy(db, memories, "explicit_search").memories.map((m) => m.id),
            ).not.toContain(seed.memoryId);

            // Explicit text search: absent, without any label or trace.
            const results = await unifiedSearch(db, "ses-vis", PROJECT, "quarantined secret", {
                limit: 10,
                memoryEnabled: true,
                embeddingEnabled: false,
                sources: ["memory"],
            });
            expect(results.filter((r) => r.source === "memory")).toEqual([]);
            expect(JSON.stringify(results)).not.toContain("quarantined secret");

            // Direct-ID lookup: the null fallback sentinel, not a labeled row.
            expect(
                resolveMemoriesByIdsForSearch({
                    db,
                    projectPath: PROJECT,
                    ids: [seed.memoryId],
                    limit: 5,
                }),
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("a candidate memory is auto-hidden but labeled in explicit surfaces", async () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "candidate-1", "candidate exploratory fact");
            const memories = getMemoriesByProject(db, PROJECT);
            expect(
                filterMemoriesByPolicy(db, memories, "auto_inject").memories.map((m) => m.id),
            ).not.toContain(seed.memoryId);
            const explicit = filterMemoriesByPolicy(db, memories, "explicit_search");
            expect(explicit.memories.map((m) => m.id)).toContain(seed.memoryId);
            expect(explicit.labels.get(seed.memoryId)).toContain("candidate");

            const results = await unifiedSearch(db, "ses-vis", PROJECT, "candidate exploratory", {
                limit: 10,
                memoryEnabled: true,
                embeddingEnabled: false,
                sources: ["memory"],
            });
            const hit = results.find((r) => r.source === "memory" && r.memoryId === seed.memoryId);
            expect(hit).toBeDefined();
            expect((hit as { policyLabel?: string }).policyLabel).toContain("candidate");

            verify(db, seed.memoryId);
            expect(
                filterMemoriesByPolicy(
                    db,
                    getMemoriesByProject(db, PROJECT),
                    "auto_inject",
                ).memories.map((m) => m.id),
            ).toContain(seed.memoryId);
        } finally {
            closeQuietly(db);
        }
    });

    test("a quarantine committed between candidate load and merge is dropped by the recheck", async () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "midflight-1", "midflight quarantine target");
            verify(db, seed.memoryId);
            let fired = false;
            const originalPrepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                // The FTS candidate query runs after the pre-limit policy
                // filter and before the post-merge recheck.
                if (!fired && /memories_fts/i.test(sql)) {
                    fired = true;
                    db.prepare = originalPrepare;
                    quarantine(db, seed.revisionId, seed.projectId);
                }
                return originalPrepare(sql);
            }) as typeof db.prepare;
            let results: Awaited<ReturnType<typeof unifiedSearch>>;
            try {
                results = await unifiedSearch(db, "ses-vis", PROJECT, "midflight quarantine", {
                    limit: 10,
                    memoryEnabled: true,
                    embeddingEnabled: false,
                    sources: ["memory"],
                });
            } finally {
                db.prepare = originalPrepare;
            }
            expect(fired).toBeTrue();
            expect(results.filter((r) => r.source === "memory")).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("labels built from stored rows carry no locators, digests, or conflict details", () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "label-1", "labeled candidate with provenance");
            const rows = readMemoryPolicyRows(db, [seed.memoryId]);
            const decision = decideMemoryPolicy(rows.get(seed.memoryId), "explicit_search");
            expect(decision.eligible).toBeTrue();
            const label = decision.label ?? "";
            expect(label.length).toBeGreaterThan(0);
            expect(label).not.toMatch(/[0-9a-f]{16,}/);
            expect(label).not.toContain("operation://");
            expect(label).not.toContain(PROJECT);
            expect(label).not.toContain(String(seed.revisionId));
        } finally {
            closeQuietly(db);
        }
    });

    test("a future policy version fails closed on automatic surfaces", () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "future-1", "future policy version row");
            verify(db, seed.memoryId);
            db.prepare(
                "UPDATE claim_effective_policy SET policy_version = 999 WHERE revision_id = ?",
            ).run(seed.revisionId);
            const memories = getMemoriesByProject(db, PROJECT);
            expect(
                filterMemoriesByPolicy(db, memories, "auto_inject").memories.map((m) => m.id),
            ).not.toContain(seed.memoryId);
            const explicit = filterMemoriesByPolicy(db, memories, "explicit_search");
            expect(explicit.labels.get(seed.memoryId)).toContain("policy:unknown");
        } finally {
            closeQuietly(db);
        }
    });

    test("a raw stale verification outranks a stale projection's eligibility", () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "stale-raw-1", "stale via policy-unaware writer");
            verify(db, seed.memoryId);
            const memories = getMemoriesByProject(db, PROJECT);
            expect(
                filterMemoriesByPolicy(db, memories, "auto_inject").memories.map((m) => m.id),
            ).toContain(seed.memoryId);
            // Reproduce a policy-unaware writer (a pre-v86 binary holding the
            // database open): the raw verification event lands, but nothing
            // refreshes the projection, whose auto_eligible bit stays 1.
            db.prepare(
                "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'stale', 'held-open-writer', 9000)",
            ).run(seed.revisionId);
            const probe = db
                .prepare(
                    "SELECT auto_eligible AS auto FROM claim_effective_policy WHERE revision_id = ?",
                )
                .get(seed.revisionId) as { auto: number };
            expect(probe.auto).toBe(1);
            expect(
                filterMemoriesByPolicy(db, memories, "auto_inject").memories.map((m) => m.id),
            ).not.toContain(seed.memoryId);
            const explicit = filterMemoriesByPolicy(db, memories, "explicit_search");
            expect(explicit.labels.get(seed.memoryId)).toContain("stale");
        } finally {
            closeQuietly(db);
        }
    });

    test("a raw supersedes conflict outranks a stale projection's eligibility", () => {
        const db = migratedDb();
        try {
            const source = seedMemory(db, "super-raw-src", "superseded via raw conflict");
            const target = seedMemory(db, "super-raw-tgt", "surviving replacement row");
            verify(db, source.memoryId);
            const memories = getMemoriesByProject(db, PROJECT);
            expect(
                filterMemoriesByPolicy(db, memories, "auto_inject").memories.map((m) => m.id),
            ).toContain(source.memoryId);
            // A policy-unaware writer inserts the supersedes conflict without
            // refreshing the projection; auto_eligible stays 1.
            db.prepare(
                `INSERT INTO claim_conflicts (relation, left_revision_id, right_revision_id, created_at)
                 VALUES ('supersedes', ?, ?, 9000)`,
            ).run(target.revisionId, source.revisionId);
            const probe = db
                .prepare(
                    "SELECT auto_eligible AS auto FROM claim_effective_policy WHERE revision_id = ?",
                )
                .get(source.revisionId) as { auto: number };
            expect(probe.auto).toBe(1);
            expect(
                filterMemoriesByPolicy(db, memories, "auto_inject").memories.map((m) => m.id),
            ).not.toContain(source.memoryId);
            const explicit = filterMemoriesByPolicy(db, memories, "explicit_search");
            expect(explicit.labels.get(source.memoryId)).toContain("superseded");
        } finally {
            closeQuietly(db);
        }
    });

    test("maintenance lanes keep only the rows they can heal", () => {
        const db = migratedDb();
        try {
            const clean = seedMemory(db, "maint-clean", "clean candidate row");
            const staleSeed = seedMemory(db, "maint-stale", "stale row to re-verify");
            const hidden = seedMemory(db, "maint-hidden", "quarantined row");
            verify(db, staleSeed.memoryId);
            db.prepare(
                "INSERT INTO verification_events (revision_id, outcome, verifier, created_at) VALUES (?, 'stale', 'v', 9000)",
            ).run(staleSeed.revisionId);
            quarantine(db, hidden.revisionId, hidden.projectId);
            const memories = getMemoriesByProject(db, PROJECT);
            const idsFor = (lane: "verification" | "hygiene") =>
                filterMemoriesForMaintenance(db, memories, lane).map((m) => m.id);
            // Verification owns and heals stale outcomes; hygiene does not.
            expect(idsFor("verification").sort()).toEqual(
                [clean.memoryId, staleSeed.memoryId].sort(),
            );
            expect(idsFor("hygiene")).toEqual([clean.memoryId]);
        } finally {
            closeQuietly(db);
        }
    });

    test("maintenance lanes fail closed on missing policy state", () => {
        const db = migratedDb();
        try {
            const clean = seedMemory(db, "maint-fc-clean", "clean candidate stays");
            const unprojected = seedMemory(db, "maint-fc-unproj", "linked but unprojected row");
            // A held-open compat writer can append a revision with no
            // projection row; the maintenance pool must not surface it.
            db.prepare("DELETE FROM claim_effective_policy WHERE revision_id = ?").run(
                unprojected.revisionId,
            );
            // A row whose claims adoption failed has no link at all; the
            // automatic surfaces treat it as unknown and hide it, so the
            // maintenance prompts must too.
            runInMemoryClaimsWriteTransaction(db, () => {
                db.prepare(
                    `INSERT INTO memories (project_path, category, content, normalized_hash,
                        first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?, 'CONSTRAINTS', 'unlinked adoption-failure row', 'maint-fc-unlinked', 1, 1, 1, 1)`,
                ).run(PROJECT);
            });
            const memories = getMemoriesByProject(db, PROJECT);
            expect(memories.length).toBe(3);
            for (const lane of ["verification", "hygiene"] as const) {
                expect(filterMemoriesForMaintenance(db, memories, lane).map((m) => m.id)).toEqual([
                    clean.memoryId,
                ]);
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("a contradicted row with no projection row is absent from explicit search", () => {
        const db = migratedDb();
        try {
            // Two revisions so the symmetric contradiction CHECK is satisfiable.
            const left = seedMemory(db, "contra-left", "contradiction left side");
            const right = seedMemory(db, "contra-right", "contradiction right side");
            verify(db, left.memoryId);
            const [lo, hi] =
                left.revisionId < right.revisionId
                    ? [left.revisionId, right.revisionId]
                    : [right.revisionId, left.revisionId];
            db.prepare(
                `INSERT INTO claim_conflicts (relation, left_revision_id, right_revision_id, created_at)
                 VALUES ('contradicts', ?, ?, ?)`,
            ).run(lo, hi, 3_000);
            // Reproduce the pre-seed window: the projection (rebuildable, not
            // authoritative) carries no row for this revision, so the reader
            // must fall back to the authoritative conflict rows rather than
            // treating absence as "surface it as unknown".
            db.prepare("DELETE FROM claim_effective_policy WHERE revision_id = ?").run(
                left.revisionId,
            );
            // Guard the oracle: if a projection row still existed, its own
            // hard_hidden flag would hide the row and this test would pass
            // without exercising the authoritative fallback at all.
            const probe = readMemoryPolicyRows(db, [left.memoryId]).get(left.memoryId);
            expect(probe?.projected).toBeFalse();
            expect(probe?.contradicted).toBeTrue();

            const memories = getMemoriesByProject(db, PROJECT);
            expect(
                filterMemoriesByPolicy(db, memories, "auto_inject").memories.map((m) => m.id),
            ).not.toContain(left.memoryId);
            const explicit = filterMemoriesByPolicy(db, memories, "explicit_search");
            expect(explicit.memories.map((m) => m.id)).not.toContain(left.memoryId);
            expect(explicit.labels.get(left.memoryId)).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });

    test("a rejected row from an unsupported policy version stays review-only", () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "rejected-future", "rejected under a newer policy");
            verify(db, seed.memoryId);
            runInMemoryClaimsWriteTransaction(db, () => {
                recordDispositionEventInCurrentTransaction(db, {
                    revisionId: seed.revisionId,
                    projectId: seed.projectId,
                    disposition: "rejected",
                    action: "assert",
                    actor: "host",
                });
                refreshEffectivePolicyInCurrentTransaction(db, seed.revisionId);
                return undefined;
            });
            // A newer policy version must not reopen a rejected row: the
            // rejection is an authoritative fact, not a projected opinion.
            db.prepare(
                "UPDATE claim_effective_policy SET policy_version = 999 WHERE revision_id = ?",
            ).run(seed.revisionId);
            const memories = getMemoriesByProject(db, PROJECT);
            const explicit = filterMemoriesByPolicy(db, memories, "explicit_search");
            expect(explicit.memories.map((m) => m.id)).not.toContain(seed.memoryId);
        } finally {
            closeQuietly(db);
        }
    });
});
