/** One-time bridge from the claim-lane SQLite tables to the kernel store, run once per project. commentlint: allow(JUDGE) */

import {
    ANTI_MEMORY_CATEGORY,
    PROMOTABLE_CATEGORIES,
} from "../../features/magic-context/memory/constants";
import {
    hasClaimMemoryFragment,
    type ProjectMemoryClaimSnapshot,
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../../features/magic-context/memory/storage-claim-current-state";
import {
    type DecisionSpecInput,
    isAvailable,
    type KernelClient,
    type ReadRow,
    sha256Hex,
    stateKey,
} from "../../shared/kernel-client";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { CTX_MEMORY_DOMAIN_ID } from "../../tools/ctx-memory/execute";
import { MEMORY_READ_SURFACE } from "./kernel-memory-render";

export const CLAIM_LANE_IMPORT_SOURCE_ID = "claim-lane-import";
export const CLAIM_LANE_IMPORT_ACTOR = "agent:claim-lane-import";
/** The `_v2` suffix distinguishes markers for imports that include legacy categories; a project marked done under the old key imports its legacy-category claims once more. commentlint: allow(JUDGE) */
const MARKER_PREFIX = "kernel_claim_lane_import_v2:";
export const CLAIM_LANE_IMPORT_BATCH = 50;
const RETRY_AFTER_MS = 5 * 60_000;

/** Persisted categories are used verbatim as `decision_kind`. */
const IMPORTED_CATEGORIES: readonly string[] = [...PROMOTABLE_CATEGORIES, ANTI_MEMORY_CATEGORY];

export type ClaimLaneImportOutcome = "skipped" | "done" | "deferred";

/** Checkouts sharing a root commit share `projectPath` but bind distinct kernel scopes, so the marker joins both and each checkout imports into its own scope. commentlint: allow(JUDGE) */
function markerKey(projectPath: string, projectRoot: string): string {
    return `${MARKER_PREFIX}${sha256Hex(`${projectPath}\u001f${projectRoot}`).slice(0, 32)}`;
}

/** The reset counter the done marker is fenced by; `resetClaimLaneImportMarker` bumps it so an importer that started before the reset cannot mark the replay done. commentlint: allow(JUDGE) */
const GENERATION_PREFIX = "kernel_claim_lane_import_gen:";

function generationKey(projectPath: string, projectRoot: string): string {
    return `${GENERATION_PREFIX}${sha256Hex(`${projectPath}\u001f${projectRoot}`).slice(0, 32)}`;
}

export function claimLaneImportGeneration(
    db: Database,
    projectPath: string,
    projectRoot: string,
): number {
    if (!hasMetaTable(db)) return 0;
    const row = db
        .prepare("SELECT value FROM context_store_meta WHERE key = ?")
        .get(generationKey(projectPath, projectRoot)) as { value?: string } | undefined;
    const parsed = Number.parseInt(row?.value ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function hasMetaTable(db: Database): boolean {
    return (
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_store_meta'",
            )
            .get() != null
    );
}

export function claimLaneImportDone(
    db: Database,
    projectPath: string,
    projectRoot: string,
): boolean {
    if (!hasMetaTable(db)) return false;
    return (
        db
            .prepare("SELECT 1 FROM context_store_meta WHERE key = ?")
            .get(markerKey(projectPath, projectRoot)) != null
    );
}

/** Writes the done marker only while the generation still equals `generation`, in one statement, so a reset that lands mid-import wins over the stale importer's completion. Answers whether the marker was written. commentlint: allow(JUDGE) */
function markDone(
    db: Database,
    projectPath: string,
    projectRoot: string,
    generation: number,
    detail: Record<string, unknown>,
): boolean {
    if (!hasMetaTable(db)) return false;
    const changes = db
        .prepare(
            `INSERT INTO context_store_meta(key, value)
             SELECT ?, ?
             WHERE COALESCE((SELECT CAST(value AS INTEGER) FROM context_store_meta WHERE key = ?), 0) = ?
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(
            markerKey(projectPath, projectRoot),
            JSON.stringify({ importedAt: Date.now(), ...detail }),
            generationKey(projectPath, projectRoot),
            generation,
        ).changes;
    return changes > 0;
}

/** Clearing the schedule entry drops the in-process done-pin so the next `scheduleClaimLaneImport` call re-runs the importer; the generation bump invalidates any importer already in flight. commentlint: allow(JUDGE) */
export function resetClaimLaneImportMarker(
    db: Database,
    projectPath: string,
    projectRoot: string,
): void {
    attemptedAt.delete(scheduleKey(projectPath, projectRoot));
    if (!hasMetaTable(db)) return;
    db.prepare(
        "INSERT INTO context_store_meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
    ).run(generationKey(projectPath, projectRoot));
    db.prepare("DELETE FROM context_store_meta WHERE key = ?").run(
        markerKey(projectPath, projectRoot),
    );
}

export function listClaimLaneMemories(
    db: Database,
    projectPath: string,
): ProjectMemoryClaimSnapshot[] {
    if (!hasClaimMemoryFragment(db)) return [];
    const projectIds = resolveProjectIdsForIdentities(db, [projectPath]);
    if (projectIds.length === 0) return [];
    const result = readProjectMemoryCurrentState(db, {
        projectIds,
        workspaceAuthorization: { ownProjectIds: projectIds, sharedCategories: [] },
        surface: "explicit_search",
        lifecycleStates: ["active"],
    });
    if (result.status !== "ok") return [];
    const own = new Set(projectIds);
    return result.items
        .filter(
            (item) =>
                own.has(item.projectId) &&
                item.lifecycleState === "active" &&
                IMPORTED_CATEGORIES.includes(item.category) &&
                item.content.trim().length > 0,
        )
        .sort((left, right) => left.publicClaimId.localeCompare(right.publicClaimId));
}

/** Stable across runs so a partial import resumes; the root keeps ids distinct across kernel scopes because object ids are unique store-wide. commentlint: allow(JUDGE) */
export function importedObjectId(publicClaimId: string, projectRoot: string): string {
    return `mem_${sha256Hex(`${CLAIM_LANE_IMPORT_SOURCE_ID}\u001f${projectRoot}\u001f${publicClaimId}`).slice(0, 32)}`;
}

export function claimLaneImportSpec(
    claim: ProjectMemoryClaimSnapshot,
    projectRoot: string,
): DecisionSpecInput {
    return {
        decision_id: `dec_${sha256Hex(`${CLAIM_LANE_IMPORT_SOURCE_ID}\u001f${projectRoot}\u001f${claim.publicClaimId}\u001f${claim.revisionLocator}`).slice(0, 32)}`,
        object_id: importedObjectId(claim.publicClaimId, projectRoot),
        domain_id: CTX_MEMORY_DOMAIN_ID,
        decision_kind: claim.category,
        payload: { summary: claim.content.trim(), rationale: "" },
        source_id: CLAIM_LANE_IMPORT_SOURCE_ID,
        source_revision: Math.max(1, claim.revision),
    };
}

/** The (kind, summary) identity a memory-domain decision row deduplicates by when writers derive distinct object ids for the same fact. commentlint: allow(JUDGE) */
export function liveMemoryContentKeys(rows: readonly ReadRow[]): Set<string> {
    return new Set(
        rows
            .filter((row) => row.object.domain_id === CTX_MEMORY_DOMAIN_ID && row.decision)
            .map((row) => `${row.decision?.decision_kind}\u001f${row.decision?.payload.summary}`),
    );
}

/** The marker is written only after every batch is `available` and only under the generation the run started at; a partial or fenced run resumes from the kernel's live rows. commentlint: allow(JUDGE) */
export async function importClaimLaneMemories(args: {
    db: Database;
    client: KernelClient;
    projectPath: string;
    /** The checkout root the client's kernel scope is bound to. */
    projectRoot: string;
    sessionId: string;
}): Promise<ClaimLaneImportOutcome> {
    const { db, client, projectPath, projectRoot, sessionId } = args;
    if (claimLaneImportDone(db, projectPath, projectRoot)) return "skipped";
    const generation = claimLaneImportGeneration(db, projectPath, projectRoot);
    const claims = listClaimLaneMemories(db, projectPath);
    if (claims.length === 0) {
        return markDone(db, projectPath, projectRoot, generation, { imported: 0 })
            ? "done"
            : "deferred";
    }
    const existing = await client.read({ surface: MEMORY_READ_SURFACE, gated: false });
    if (!isAvailable(existing)) {
        sessionLog(
            sessionId,
            `claim-lane import deferred: kernel read answered ${stateKey(existing.state)}`,
        );
        return "deferred";
    }
    const present = new Set(existing.rows.map((row) => row.object.object_id));
    // A marker reset replays the whole lane, so claims the historian already
    // promoted under its own derived ids dedupe by (kind, summary) instead of
    // duplicating as import-id rows.
    const presentContent = liveMemoryContentKeys(existing.rows);
    const pending = claims.filter(
        (claim) =>
            !present.has(importedObjectId(claim.publicClaimId, projectRoot)) &&
            !presentContent.has(`${claim.category}\u001f${claim.content.trim()}`),
    );
    let imported = 0;
    for (let start = 0; start < pending.length; start += CLAIM_LANE_IMPORT_BATCH) {
        const batch = pending.slice(start, start + CLAIM_LANE_IMPORT_BATCH);
        const result = await client.commit({
            actor: CLAIM_LANE_IMPORT_ACTOR,
            cause: `import\u001f${sha256Hex(batch.map((claim) => claim.publicClaimId).join("\u001f"))}`,
            sourceKind: "model",
            operations: batch.map((claim) => ({
                op: "insert_decision" as const,
                spec: claimLaneImportSpec(claim, projectRoot),
            })),
        });
        if (!isAvailable(result)) {
            sessionLog(
                sessionId,
                `claim-lane import deferred after ${imported} of ${pending.length} memories: kernel commit answered ${stateKey(result.state)}`,
            );
            return "deferred";
        }
        imported += batch.length;
    }
    if (
        !markDone(db, projectPath, projectRoot, generation, {
            imported,
            alreadyPresent: claims.length - pending.length,
        })
    ) {
        sessionLog(
            sessionId,
            `claim-lane import fenced: a marker reset landed during the run; ${imported} committed memories stay live and the next schedule replays the lane`,
        );
        return "deferred";
    }
    sessionLog(
        sessionId,
        `claim-lane import complete: ${imported} memories committed to the kernel, ${claims.length - pending.length} already present`,
    );
    return "done";
}

const attemptedAt = new Map<string, number>();

function scheduleKey(projectPath: string, projectRoot: string): string {
    return `${projectPath}\u001f${projectRoot}`;
}

export function scheduleClaimLaneImport(args: {
    db: Database;
    client: KernelClient | undefined;
    projectPath: string;
    /** The checkout root the client's kernel scope is bound to. */
    projectRoot: string;
    sessionId: string;
}): void {
    if (!args.client) return;
    const key = scheduleKey(args.projectPath, args.projectRoot);
    const last = attemptedAt.get(key);
    const now = Date.now();
    if (last !== undefined && now - last < RETRY_AFTER_MS) return;
    if (claimLaneImportDone(args.db, args.projectPath, args.projectRoot)) {
        attemptedAt.set(key, Number.POSITIVE_INFINITY);
        return;
    }
    attemptedAt.set(key, now);
    void importClaimLaneMemories({ ...args, client: args.client }).catch((error) => {
        log(`[magic-context] claim-lane import failed for ${args.projectPath}`, error);
    });
}

export function resetClaimLaneImportScheduleForTest(): void {
    attemptedAt.clear();
}
