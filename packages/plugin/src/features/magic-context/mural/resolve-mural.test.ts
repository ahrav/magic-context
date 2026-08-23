/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { getMemoriesByProject, insertMemory, setMemoryClassification } from "../memory";
import {
    recordDispositionEventInCurrentTransaction,
    refreshEffectivePolicyInCurrentTransaction,
} from "../memory/storage-claim-policy";
import { filterMemoriesByPolicy } from "../memory/storage-claim-visibility";
import { sha256Utf8Hex } from "../memory/storage-claims";
import {
    getCurrentMemoryClaimByLegacyMemoryId,
    runInMemoryClaimsWriteTransaction,
    updateMemoryVerificationWithClaimsInCurrentTransaction,
} from "../memory/storage-memory-claims";
import type { Memory } from "../memory/types";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { ensureMuralRendered, muralCoverageGate } from "./render-trigger";
import { resolveMural } from "./resolve-mural";
import { getMural } from "./storage-mural";
import { computeCueContentHash, setMuralCue } from "./storage-mural-cues";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** The gated pool `ensureMuralRendered` builds a mural from. */
function muralPool(db: Database, projectIdentity: string) {
    return filterMemoriesByPolicy(
        db,
        getMemoriesByProject(db, projectIdentity, ["active", "permanent"]),
        "auto_inject",
    ).memories;
}

/** Promote a memory to VERIFIED so it passes the auto_inject policy gate. */
function verifyMemory(db: Database, memoryId: number): void {
    runInMemoryClaimsWriteTransaction(db, () =>
        updateMemoryVerificationWithClaimsInCurrentTransaction(
            db,
            {
                producer: "mural-test",
                operationKey: `verify:${memoryId}`,
                requestDigest: sha256Utf8Hex(`verify:${memoryId}`),
            },
            { memoryId, verificationStatus: "verified" },
        ),
    );
}

/**
 * Insert a memory, classify its importance, give it a hash-current cue, and
 * verify it.
 *
 * The mural is an automatic injection channel, so it renders only rows that
 * pass the `auto_inject` policy gate (effective VERIFIED+). A freshly inserted
 * memory projects as CANDIDATE and is correctly invisible to the mural, so the
 * verification step is what makes these fixtures represent a renderable pool.
 */
function seedCuedMemory(
    db: Database,
    project: string,
    category: Memory["category"],
    content: string,
    importance: number,
): Memory {
    const memory = insertMemory(db, {
        projectPath: project,
        category,
        content,
        sourceSessionId: "s",
    });
    setMemoryClassification(db, memory.id, { importance });
    verifyMemory(db, memory.id);
    setMuralCue(
        db,
        memory.projectPath,
        memory.id,
        `cue-${memory.id}`,
        computeCueContentHash(content),
    );
    return memory;
}

/** A verified (policy-eligible) memory with no mural cue. */
function seedUncuedMemory(
    db: Database,
    project: string,
    category: Memory["category"],
    content: string,
): Memory {
    const memory = insertMemory(db, {
        projectPath: project,
        category,
        content,
        sourceSessionId: "s",
    });
    verifyMemory(db, memory.id);
    return memory;
}

describe("resolveMural", () => {
    test("keeps the claim-backed projection reader shape and bytes unchanged", () => {
        const db = freshDb();
        try {
            const project = "git:u6-mural-reader";
            const content = "mural projection bytes: café";
            const memory = seedCuedMemory(db, project, "ARCHITECTURE", content, 73);
            expect(getCurrentMemoryClaimByLegacyMemoryId(db, memory.id)?.content).toBe(content);

            const statements: string[] = [];
            const originalPrepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                statements.push(sql);
                return originalPrepare(sql);
            }) as typeof db.prepare;
            let entries: ReturnType<typeof resolveMural>;
            try {
                entries = resolveMural(db, project, 1);
            } finally {
                db.prepare = originalPrepare;
            }

            const expected = [
                {
                    id: memory.id,
                    category: "ARCHITECTURE",
                    importance: 73,
                    cue: `cue-${memory.id}`,
                },
            ];
            expect(entries).toEqual(expected);
            expect(Buffer.from(JSON.stringify(entries))).toEqual(
                Buffer.from(JSON.stringify(expected)),
            );
            expect(statements.some((sql) => /\bmemories\b/i.test(sql))).toBeTrue();
            expect(
                statements.some((sql) =>
                    /legacy_memory_claims|claim_revisions|\bclaims\b/i.test(sql),
                ),
            ).toBeFalse();
        } finally {
            closeQuietly(db);
        }
    });

    test("selects only the overflow complement of the budget trim", () => {
        const db = freshDb();
        try {
            const project = "git:p";
            // A tiny budget so almost everything overflows. Seed enough memories
            // that the trim keeps a few and drops the rest.
            const ids: number[] = [];
            for (let i = 0; i < 30; i++) {
                const m = seedCuedMemory(
                    db,
                    project,
                    "ARCHITECTURE",
                    `memory number ${i} with enough text to cost tokens in the budget accounting`,
                    50,
                );
                ids.push(m.id);
            }
            const entries = resolveMural(db, project, 200);
            // Some memories fit the 200-token budget (excluded from the mural),
            // the rest overflow (included). So the mural is a strict subset.
            expect(entries.length).toBeGreaterThan(0);
            expect(entries.length).toBeLessThan(ids.length);
        } finally {
            closeQuietly(db);
        }
    });

    test("excludes memories with no cue or a stale cue (absent until compressed)", () => {
        const db = freshDb();
        try {
            const project = "git:p";
            // One cued, one un-cued, both overflow under a tiny budget.
            const cued = seedCuedMemory(db, project, "ARCHITECTURE", "cued fact here", 50);
            const unCued = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: "uncompressed fact",
                sourceSessionId: "s",
            });
            setMemoryClassification(db, unCued.id, { importance: 50 });
            // A stale cue: hash points at different content.
            const stale = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: "current content",
                sourceSessionId: "s",
            });
            setMemoryClassification(db, stale.id, { importance: 50 });
            setMuralCue(
                db,
                stale.projectPath,
                stale.id,
                "stale cue",
                computeCueContentHash("OLD content"),
            );

            const entries = resolveMural(db, project, 1);
            const idsOut = entries.map((entry) => entry.id);
            expect(idsOut).toContain(cued.id);
            expect(idsOut).not.toContain(unCued.id);
            expect(idsOut).not.toContain(stale.id);
        } finally {
            closeQuietly(db);
        }
    });

    test("orders by category band, then importance DESC, then id ASC (append-stable)", () => {
        const db = freshDb();
        try {
            const project = "git:p";
            // NAMING sorts after ARCHITECTURE; within a band, higher importance
            // first, then lower id first.
            const archLow = seedCuedMemory(db, project, "ARCHITECTURE", "arch low imp", 40);
            const archHigh = seedCuedMemory(db, project, "ARCHITECTURE", "arch high imp", 90);
            const naming = seedCuedMemory(db, project, "NAMING", "naming fact", 90);

            const entries = resolveMural(db, project, 1);
            const order = entries.map((entry) => entry.id);
            // ARCHITECTURE band first (high before low), then NAMING band.
            expect(order.indexOf(archHigh.id)).toBeLessThan(order.indexOf(archLow.id));
            expect(order.indexOf(archLow.id)).toBeLessThan(order.indexOf(naming.id));

            // Append-stability: inserting a NEW same-band, same-importance memory
            // (a higher id) must land AFTER the existing one, never reshuffle it.
            const archHigh2 = seedCuedMemory(db, project, "ARCHITECTURE", "arch high 2", 90);
            const after = resolveMural(db, project, 1).map((entry) => entry.id);
            expect(after.indexOf(archHigh.id)).toBeLessThan(after.indexOf(archHigh2.id));
            // The pre-existing relative order (archHigh before archLow) is intact.
            expect(after.indexOf(archHigh.id)).toBeLessThan(after.indexOf(archLow.id));
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
        const db = freshDb();
        try {
            const project = "git:coverage-gate";
            for (let i = 0; i < 40; i++) {
                if (i < 10) {
                    seedCuedMemory(db, project, "ARCHITECTURE", `cued fact ${i}`, 50);
                } else {
                    // Uncued but still policy-eligible: coverage is measured
                    // over the pool the mural may actually render, so these
                    // must pass the auto_inject gate to dilute it.
                    seedUncuedMemory(db, project, "ARCHITECTURE", `uncued fact ${i}`);
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

    test("a quarantined memory is excluded from the mural pool and its image", () => {
        const db = freshDb();
        try {
            const project = "git:mural-policy";
            for (let i = 0; i < 6; i++) {
                seedCuedMemory(db, project, "ARCHITECTURE", `visible mural fact ${i}`, 50);
            }
            const hidden = seedCuedMemory(
                db,
                project,
                "ARCHITECTURE",
                "quarantined mural secret",
                99,
            );
            // The mural is an image, so absence has to be asserted on the
            // resolved entries: a hard-hidden row must never reach the render.
            const before = resolveMural(db, project, 1, muralPool(db, project));
            expect(before.map((entry) => entry.id)).toContain(hidden.id);

            const link = getCurrentMemoryClaimByLegacyMemoryId(db, hidden.id);
            if (!link) throw new Error("expected a claim link for the seeded memory");
            runInMemoryClaimsWriteTransaction(db, () => {
                recordDispositionEventInCurrentTransaction(db, {
                    revisionId: link.revisionId,
                    projectId: link.projectId,
                    disposition: "quarantined",
                    action: "assert",
                    actor: "host",
                });
                refreshEffectivePolicyInCurrentTransaction(db, link.revisionId);
                return undefined;
            });

            const after = resolveMural(db, project, 1, muralPool(db, project));
            expect(after.map((entry) => entry.id)).not.toContain(hidden.id);
            // And the injection path agrees: the PERSISTED manifest is the
            // artifact later renders serve from, so absence must hold on its
            // stored memory ids, not just on a fresh resolver pass.
            const rendered = ensureMuralRendered(db, project, 1);
            expect(rendered.hasMural).toBe(true);
            const persisted = getMural(db, project);
            if (!persisted) throw new Error("expected a persisted mural manifest");
            expect(persisted.memoryIds).not.toContain(hidden.id);
            expect(
                resolveMural(db, project, 1, muralPool(db, project)).some(
                    (entry) => entry.id === hidden.id,
                ),
            ).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("ensureMuralRendered (on-demand render + change detection)", () => {
    test("first render stores a row; unchanged pool does not re-render", () => {
        const db = freshDb();
        try {
            const project = "git:p";
            for (let i = 0; i < 25; i++) {
                seedCuedMemory(
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
        const db = freshDb();
        try {
            // Memories exist but none are cued → resolveMural returns [].
            const project = "git:p";
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: "uncompressed",
                sourceSessionId: "s",
            });
            const result = ensureMuralRendered(db, project, 1);
            expect(result.hasMural).toBe(false);
            expect(result.rerendered).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("a changed cue pool re-renders with a new content hash", () => {
        const db = freshDb();
        try {
            const project = "git:p";
            for (let i = 0; i < 25; i++) {
                seedCuedMemory(db, project, "ARCHITECTURE", `fact ${i} padding words here now`, 50);
            }
            const first = ensureMuralRendered(db, project, 100);
            // Add a new cued overflow memory → resolved text changes → re-render.
            seedCuedMemory(db, project, "NAMING", "a brand new naming cue entry appears", 90);
            const second = ensureMuralRendered(db, project, 100);
            expect(second.rerendered).toBe(true);
            expect(second.contentHash).not.toBe(first.contentHash);
        } finally {
            closeQuietly(db);
        }
    });
});
