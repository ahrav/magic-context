/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createAntiMemory } from "../memory/storage-anti-memory";
import {
    type ProjectMemoryClaimSnapshot,
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../memory/storage-claim-current-state";
import { ensureProject } from "../memory/storage-claims";
import {
    createClaimReaderTestDatabase,
    type SeededProjectMemoryClaim,
    seedProjectMemoryClaim,
} from "../test-claim-database";
import { ensureMuralRendered, muralCoverageGate } from "./render-trigger";
import { resolveMural } from "./resolve-mural";
import { getMural } from "./storage-mural";
import { setClaimMuralCue } from "./storage-mural-cues";

/** The gated pool `ensureMuralRendered` builds a mural from. */
function muralPool(db: Database, projectIdentity: string): ProjectMemoryClaimSnapshot[] {
    const result = readProjectMemoryCurrentState(db, {
        projectIds: resolveProjectIdsForIdentities(db, [projectIdentity]),
        surface: "auto_inject",
    });
    if (result.status !== "ok") throw new Error("mural pool read was stale");
    return result.items;
}

/** Seed one claim with a cue keyed to its current revision locator. */
function seedCuedClaim(
    db: Database,
    project: string,
    category: string,
    content: string,
    importance: number,
): SeededProjectMemoryClaim {
    const claim = seedProjectMemoryClaim(db, {
        projectIdentity: project,
        content,
        category,
        importance,
    });
    setClaimMuralCue(db, {
        publicClaimId: claim.publicClaimId,
        revisionLocator: claim.revisionLocator,
        cue: `cue-${claim.publicClaimId.slice(0, 12)}`,
    });
    return claim;
}

function quarantineClaim(db: Database, claim: SeededProjectMemoryClaim): void {
    const row = db
        .prepare(
            `SELECT claims.current_revision_id AS revisionId, claims.project_id AS projectId
               FROM claim_public_ids
               JOIN claims ON claims.id = claim_public_ids.claim_id
              WHERE claim_public_ids.public_id = ?`,
        )
        .get(claim.publicClaimId) as { revisionId: number; projectId: number };
    db.transaction(() => {
        db.prepare(
            `INSERT INTO claim_disposition_events
                (revision_id, project_id, disposition, action, actor, policy_version, recorded_at)
             VALUES (?, ?, 'quarantined', 'assert', 'user:test', 1, ?)`,
        ).run(row.revisionId, row.projectId, Date.now());
        db.prepare(
            "UPDATE claim_effective_policy SET hard_hidden = 1, auto_eligible = 0, explicit_eligible = 0 WHERE revision_id = ?",
        ).run(row.revisionId);
    }).immediate();
}

describe("resolveMural", () => {
    test("resolves claim entries with canonical locators and no legacy memory read", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:u3-mural-reader";
            const content = "mural projection bytes: café";
            const claim = seedCuedClaim(db, project, "ARCHITECTURE", content, 73);

            const pool = muralPool(db, project);
            const statements: string[] = [];
            const originalPrepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                statements.push(sql);
                return originalPrepare(sql);
            }) as typeof db.prepare;
            let entries: ReturnType<typeof resolveMural>;
            try {
                entries = resolveMural(db, project, 1, pool);
            } finally {
                db.prepare = originalPrepare;
            }

            expect(entries).toEqual([
                {
                    publicClaimId: claim.publicClaimId,
                    revisionLocator: claim.revisionLocator,
                    category: "ARCHITECTURE",
                    importance: 73,
                    cue: `cue-${claim.publicClaimId.slice(0, 12)}`,
                },
            ]);
            expect(
                statements.some((sql) =>
                    /\bmemories\b|\bmemory_stats\b|\bmemory_verifications\b/i.test(sql),
                ),
            ).toBeFalse();
        } finally {
            closeQuietly(db);
        }
    });

    test("selects only the overflow complement of the budget trim", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:p";
            const ids: string[] = [];
            for (let i = 0; i < 30; i++) {
                const claim = seedCuedClaim(
                    db,
                    project,
                    "ARCHITECTURE",
                    `memory number ${i} with enough text to cost tokens in the budget accounting`,
                    50,
                );
                ids.push(claim.publicClaimId);
            }
            const entries = resolveMural(db, project, 200, muralPool(db, project));
            // Some claims fit the 200-token budget (excluded from the mural),
            // the rest overflow (included). So the mural is a strict subset.
            expect(entries.length).toBeGreaterThan(0);
            expect(entries.length).toBeLessThan(ids.length);
        } finally {
            closeQuietly(db);
        }
    });

    test("excludes claims with no cue, a locator-stale cue, or an old renderer epoch", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:p";
            const cued = seedCuedClaim(db, project, "ARCHITECTURE", "cued fact here", 50);
            const unCued = seedProjectMemoryClaim(db, {
                projectIdentity: project,
                content: "uncompressed fact",
                category: "ARCHITECTURE",
                importance: 50,
            });
            // The cue below uses a locator that is not current.
            const stale = seedProjectMemoryClaim(db, {
                projectIdentity: project,
                content: "current content",
                category: "ARCHITECTURE",
                importance: 50,
            });
            setClaimMuralCue(db, {
                publicClaimId: stale.publicClaimId,
                revisionLocator: `${stale.publicClaimId}/r1/${"0".repeat(64)}`,
                cue: "stale cue",
            });
            // Current locator, older renderer epoch.
            const oldEpoch = seedProjectMemoryClaim(db, {
                projectIdentity: project,
                content: "old renderer epoch content",
                category: "ARCHITECTURE",
                importance: 50,
            });
            setClaimMuralCue(db, {
                publicClaimId: oldEpoch.publicClaimId,
                revisionLocator: oldEpoch.revisionLocator,
                cue: "old epoch cue",
            });
            db.prepare(
                `UPDATE claim_mural_cues SET renderer_epoch = renderer_epoch + 1
                  WHERE claim_id = (SELECT claim_id FROM claim_public_ids WHERE public_id = ?)`,
            ).run(oldEpoch.publicClaimId);

            const entries = resolveMural(db, project, 1, muralPool(db, project));
            const idsOut = entries.map((entry) => entry.publicClaimId);
            expect(idsOut).toContain(cued.publicClaimId);
            expect(idsOut).not.toContain(unCued.publicClaimId);
            expect(idsOut).not.toContain(stale.publicClaimId);
            expect(idsOut).not.toContain(oldEpoch.publicClaimId);
        } finally {
            closeQuietly(db);
        }
    });

    test("orders by category band, then importance DESC, then public claim id ASC", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:p";
            const archLow = seedCuedClaim(db, project, "ARCHITECTURE", "arch low imp", 40);
            const archHigh = seedCuedClaim(db, project, "ARCHITECTURE", "arch high imp", 90);
            const naming = seedCuedClaim(db, project, "NAMING", "naming fact", 90);

            const entries = resolveMural(db, project, 1, muralPool(db, project));
            const order = entries.map((entry) => entry.publicClaimId);
            // ARCHITECTURE band first (high before low), then NAMING band.
            expect(order.indexOf(archHigh.publicClaimId)).toBeLessThan(
                order.indexOf(archLow.publicClaimId),
            );
            expect(order.indexOf(archLow.publicClaimId)).toBeLessThan(
                order.indexOf(naming.publicClaimId),
            );

            // Claims with equal importance within a category band sort by
            // public claim ID ascending.
            const archHigh2 = seedCuedClaim(db, project, "ARCHITECTURE", "arch high 2", 90);
            const after = resolveMural(db, project, 1, muralPool(db, project)).map(
                (entry) => entry.publicClaimId,
            );
            const expectedPair = [archHigh.publicClaimId, archHigh2.publicClaimId].sort();
            expect(after.filter((id) => expectedPair.includes(id))).toEqual(expectedPair);
            expect(after.indexOf(archHigh.publicClaimId)).toBeLessThan(
                after.indexOf(archLow.publicClaimId),
            );
        } finally {
            closeQuietly(db);
        }
    });
});

describe("mural coverage gate", () => {
    test("requires 15 cues unless at least half of the active pool is cued", () => {
        expect(muralCoverageGate(14, 100)).toBe(false);
        expect(muralCoverageGate(15, 100)).toBe(true);
        expect(muralCoverageGate(7, 10)).toBe(true);
        expect(muralCoverageGate(6, 13)).toBe(false);
    });

    test("skips rendering and explains a near-empty cue pool", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:coverage-gate";
            for (let i = 0; i < 40; i++) {
                if (i < 10) {
                    seedCuedClaim(db, project, "ARCHITECTURE", `cued fact ${i}`, 50);
                } else {
                    seedProjectMemoryClaim(db, {
                        projectIdentity: project,
                        content: `uncued fact ${i}`,
                        category: "ARCHITECTURE",
                        importance: 50,
                    });
                }
            }
            const result = ensureMuralRendered(db, project, 1);
            expect(result.hasMural).toBe(false);
            expect(result.rerendered).toBe(false);
            expect(result.skipReason).toContain("10/40");
        } finally {
            closeQuietly(db);
        }
    });

    test("a quarantined claim is excluded from the mural pool and its image", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:mural-policy";
            for (let i = 0; i < 6; i++) {
                seedCuedClaim(db, project, "ARCHITECTURE", `visible mural fact ${i}`, 50);
            }
            const hidden = seedCuedClaim(
                db,
                project,
                "ARCHITECTURE",
                "quarantined mural secret",
                99,
            );
            // The mural is an image, so absence has to be asserted on the
            // resolved entries: a hard-hidden row must never reach the render.
            const before = resolveMural(db, project, 1, muralPool(db, project));
            expect(before.map((entry) => entry.publicClaimId)).toContain(hidden.publicClaimId);

            quarantineClaim(db, hidden);

            const after = resolveMural(db, project, 1, muralPool(db, project));
            expect(after.map((entry) => entry.publicClaimId)).not.toContain(hidden.publicClaimId);
            // The PERSISTED manifest is the artifact later renders serve
            // from, so absence must hold on its stored claim ids too.
            const rendered = ensureMuralRendered(db, project, 1);
            expect(rendered.hasMural).toBe(true);
            const persisted = getMural(db, project);
            if (!persisted) throw new Error("expected a persisted mural manifest");
            expect(persisted.memoryIds).not.toContain(hidden.publicClaimId);
        } finally {
            closeQuietly(db);
        }
    });

    test("a verified rejected approach never enters the mural pool", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:mural-anti-memory";
            for (let i = 0; i < 6; i++) {
                seedCuedClaim(db, project, "ARCHITECTURE", `visible mural fact ${i}`, 50);
            }
            const created = createAntiMemory(
                db,
                { producer: "test", operationKey: "mural-anti" },
                {
                    projectId: ensureProject(db, project),
                    payload: {
                        trigger: "cache work",
                        rejectedStrategy: "use Redis",
                        rejectionReason: "operational burden",
                    },
                    provenance: {
                        sourceLocator: "transcript://mural-anti",
                        sourceContent: "user rejected Redis",
                        extractor: "test",
                        extractorVersion: "1",
                        extractorRunId: "mural-anti",
                        independenceKey: "mural-anti",
                        sourceTrustClass: "explicit_user",
                    },
                    actor: "host:user-corroborated",
                    nowMs: 1,
                },
            );
            const antiId = (created.result.payload as { claim: { publicClaimId: string } }).claim
                .publicClaimId;
            const anti = db
                .prepare(
                    `SELECT revisions.revision, revisions.content_sha256 AS contentDigest
                       FROM claim_public_ids public
                       JOIN claims ON claims.id = public.claim_id
                       JOIN claim_revisions revisions ON revisions.id = claims.current_revision_id
                      WHERE public.public_id = ?`,
                )
                .get(antiId) as { revision: number; contentDigest: string };
            setClaimMuralCue(db, {
                publicClaimId: antiId,
                revisionLocator: `${antiId}/r${anti.revision}/${anti.contentDigest}`,
                cue: "rejected Redis",
            });

            expect(muralPool(db, project).map((item) => item.publicClaimId)).not.toContain(antiId);
            const rendered = ensureMuralRendered(db, project, 1);
            expect(rendered.hasMural).toBe(true);
            expect(getMural(db, project)?.memoryIds).not.toContain(antiId);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("ensureMuralRendered (on-demand render + change detection)", () => {
    test("first render stores a row; unchanged pool does not re-render", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:p";
            for (let i = 0; i < 25; i++) {
                seedCuedClaim(
                    db,
                    project,
                    "ARCHITECTURE",
                    `fact ${i} with plenty of words to overflow a tiny budget for sure`,
                    50,
                );
            }
            const first = ensureMuralRendered(db, project, 100);
            expect(first.hasMural).toBe(true);
            expect(first.rerendered).toBe(true);
            expect(first.dataUrl).toBeDefined();
            const stored = getMural(db, project);
            expect(stored?.width).toBe(first.width);
            expect(stored?.height).toBe(first.height);

            // Same pool → same text hash → no re-render, same data URL bytes.
            const second = ensureMuralRendered(db, project, 100);
            expect(second.hasMural).toBe(true);
            expect(second.rerendered).toBe(false);
            expect(second.contentHash).toBe(first.contentHash);
            expect(second.dataUrl).toBe(first.dataUrl);
        } finally {
            closeQuietly(db);
        }
    });

    test("an empty cue pool yields no mural (m0 omits the block)", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:p";
            seedProjectMemoryClaim(db, {
                projectIdentity: project,
                content: "uncompressed",
                category: "ARCHITECTURE",
            });
            const result = ensureMuralRendered(db, project, 1);
            expect(result.hasMural).toBe(false);
            expect(result.rerendered).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("a changed cue pool re-renders with a new content hash", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:p";
            for (let i = 0; i < 25; i++) {
                seedCuedClaim(db, project, "ARCHITECTURE", `fact ${i} padding words here now`, 50);
            }
            const first = ensureMuralRendered(db, project, 100);
            // A new cued overflow claim changes the resolved text and
            // triggers re-rendering.
            seedCuedClaim(db, project, "NAMING", "a brand new naming cue entry appears", 90);
            const second = ensureMuralRendered(db, project, 100);
            expect(second.rerendered).toBe(true);
            expect(second.contentHash).not.toBe(first.contentHash);
        } finally {
            closeQuietly(db);
        }
    });

    test("a generation change during render discards the snapshot", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const project = "git:mural-stale";
            for (let i = 0; i < 20; i++) {
                seedCuedClaim(
                    db,
                    project,
                    "ARCHITECTURE",
                    `stale-check fact ${i} with padding words to overflow`,
                    50,
                );
            }
            // Writing during the coverage cue-state read creates a
            // claim-generation race before post-render revalidation.
            const originalPrepare = db.prepare.bind(db);
            let fired = false;
            db.prepare = ((sql: string) => {
                if (!fired && /claim_mural_cues/.test(sql)) {
                    fired = true;
                    db.prepare = originalPrepare;
                    seedProjectMemoryClaim(db, {
                        projectIdentity: project,
                        content: "concurrent write moving the generation",
                        category: "NAMING",
                    });
                }
                return originalPrepare(sql);
            }) as typeof db.prepare;
            let result: ReturnType<typeof ensureMuralRendered>;
            try {
                result = ensureMuralRendered(db, project, 100);
            } finally {
                db.prepare = originalPrepare;
            }
            expect(result.hasMural).toBe(false);
            expect(result.skipReason).toBe("memory pool changed during render");
        } finally {
            closeQuietly(db);
        }
    });
});
