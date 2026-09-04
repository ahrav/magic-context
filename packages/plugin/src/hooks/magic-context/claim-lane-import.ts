/** One-time bridge from the claim-lane SQLite tables to the kernel store, run once per project. commentlint: allow(JUDGE) */

import {
    parseAntiMemoryContent,
    renderAntiMemoryContent,
} from "../../features/magic-context/memory/anti-memory-content";
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
import { CLAIM_MEMORY_LIFECYCLE_STATES } from "../../features/magic-context/storage-claim-memory-schema";
import { CLAIM_POLICY_VERSION } from "../../features/magic-context/storage-claim-policy-schema";
import {
    computeWorkspaceEpochFingerprint,
    expandWorkspaceIdentitySetWithAliases,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
} from "../../features/magic-context/workspaces";
import {
    type DecisionSpecInput,
    deriveObjectId,
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

/** Hashes authorization inputs only — sorted member identities and `share_categories`, never per-project write epochs — so the done marker survives ordinary writes and invalidates exactly when membership or sharing policy changes. A non-workspaced project answers a constant. commentlint: allow(JUDGE) */
export function claimLaneAuthorizationFingerprint(db: Database, projectPath: string): string {
    const resolved = resolveWorkspaceIdentitySet(db, projectPath);
    if (resolved.identities.length <= 1) return "none";
    const identities = [...resolved.identities].sort();
    const share = resolveWorkspaceShareCategories(db, projectPath) ?? [];
    return sha256Hex(`${JSON.stringify(identities)}\u001f${JSON.stringify(share)}`);
}

/** Done means done under the current workspace authorization: a marker written before a membership or share-policy change (or one predating the authorization field) answers false, so the next schedule reconciles imports against the new policy. commentlint: allow(JUDGE) */
export function claimLaneImportDone(
    db: Database,
    projectPath: string,
    projectRoot: string,
): boolean {
    if (!hasMetaTable(db)) return false;
    const row = db
        .prepare("SELECT value FROM context_store_meta WHERE key = ?")
        .get(markerKey(projectPath, projectRoot)) as { value?: string } | undefined;
    if (row?.value === undefined) return false;
    try {
        const detail = JSON.parse(row.value) as { authorization?: string };
        return detail.authorization === claimLaneAuthorizationFingerprint(db, projectPath);
    } catch {
        return false;
    }
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
    // One transaction covers the generation bump and the marker delete: a crash between them would leave the stale marker in place and report the import done despite the reset. commentlint: allow(JUDGE)
    db.transaction(() => {
        db.prepare(
            "INSERT INTO context_store_meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
        ).run(generationKey(projectPath, projectRoot));
        db.prepare("DELETE FROM context_store_meta WHERE key = ?").run(
            markerKey(projectPath, projectRoot),
        );
    })();
}

interface ClaimLaneWorkspace {
    /** Expanded read identities: aliases included when workspaced, `[projectPath]` otherwise. */
    identities: string[];
    /** Identities whose canonical project is `projectPath`. */
    ownIdentities: string[];
    isWorkspaced: boolean;
    sharedCategories: string[];
    /** Canonical member set, the input `computeWorkspaceEpochFingerprint` expects. */
    resolvedIdentities: string[];
}

/** The lane served workspace members' shareable rows under `share_categories`, so the bridge reads with the same workspace authorization; importing only the project's own rows would drop foreign shared memories the retired lane paths served. commentlint: allow(JUDGE) */
function claimLaneWorkspace(db: Database, projectPath: string): ClaimLaneWorkspace {
    const resolved = resolveWorkspaceIdentitySet(db, projectPath);
    const isWorkspaced = resolved.identities.length > 1;
    const expanded = expandWorkspaceIdentitySetWithAliases(db, resolved.identities);
    const identities = isWorkspaced ? expanded.expandedIdentities : resolved.identities;
    const ownIdentities = isWorkspaced
        ? identities.filter(
              (identity) => expanded.canonicalIdentityByStoredPath.get(identity) === projectPath,
          )
        : identities;
    const sharedCategories = isWorkspaced
        ? (resolveWorkspaceShareCategories(db, projectPath) ?? [])
        : [];
    return {
        identities,
        ownIdentities,
        isWorkspaced,
        sharedCategories,
        resolvedIdentities: resolved.identities,
    };
}

/** `null` means the claim-lane projection could not publish a snapshot (the reader answered `stale`); the lane's contents are unknown, which is distinct from an empty lane. commentlint: allow(JUDGE) */
export function listClaimLaneMemories(
    db: Database,
    projectPath: string,
): ProjectMemoryClaimSnapshot[] | null {
    if (!hasClaimMemoryFragment(db)) return [];
    const ws = claimLaneWorkspace(db, projectPath);
    const projectIds = resolveProjectIdsForIdentities(db, ws.identities);
    if (projectIds.length === 0) return [];
    const ownProjectIds = resolveProjectIdsForIdentities(db, ws.ownIdentities);
    const result = readProjectMemoryCurrentState(db, {
        projectIds,
        workspaceAuthorization: { ownProjectIds, sharedCategories: ws.sharedCategories },
        // `workspaceIdentities` lets the reader detect membership or share-policy revocation between hydration and publication. commentlint: allow(JUDGE)
        ...(ws.isWorkspaced
            ? {
                  workspaceEpoch: computeWorkspaceEpochFingerprint(db, ws.resolvedIdentities),
                  workspaceIdentities: ws.resolvedIdentities,
              }
            : {}),
        surface: "explicit_search",
        lifecycleStates: ["active"],
    });
    if (result.status !== "ok") return null;
    return result.items
        .filter(
            (item) =>
                item.lifecycleState === "active" &&
                IMPORTED_CATEGORIES.includes(item.category) &&
                item.content.trim().length > 0,
        )
        .sort((left, right) => left.publicClaimId.localeCompare(right.publicClaimId));
}

/** Stable across runs so a partial import resumes; the root keeps ids distinct across kernel scopes because object ids are unique store-wide. commentlint: allow(JUDGE) */
export function importedObjectId(publicClaimId: string, projectRoot: string): string {
    return deriveObjectId("mem", CLAIM_LANE_IMPORT_SOURCE_ID, projectRoot, publicClaimId);
}

/** The lane keeps anti-memory expiry in a column while kernel read surfaces read it from the rendered "Expires at:" line, so the imported summary re-renders the lane payload with the lane's expiry. Content that does not parse as an anti-memory payload imports verbatim instead of aborting the lane. commentlint: allow(JUDGE) */
function claimLaneImportSummary(claim: ProjectMemoryClaimSnapshot): string {
    const summary = claim.content.trim();
    if (claim.category !== ANTI_MEMORY_CATEGORY || claim.expiresAt === null) return summary;
    try {
        return renderAntiMemoryContent({
            ...parseAntiMemoryContent(summary),
            expiresAt: claim.expiresAt,
        });
    } catch {
        return summary;
    }
}

/** Mirrors the claim lane's `auto_inject` eligibility: a supported policy version, an auto-eligible policy row, and no stale, disputed, or superseded disposition. commentlint: allow(JUDGE) */
function claimAutoEligible(claim: ProjectMemoryClaimSnapshot): boolean {
    const softHidden =
        claim.dispositions.stale || claim.dispositions.disputed || claim.dispositions.superseded;
    return (
        claim.policy.policyVersion <= CLAIM_POLICY_VERSION &&
        claim.policy.autoEligible &&
        !softHidden
    );
}

export function claimLaneImportSpec(
    claim: ProjectMemoryClaimSnapshot,
    projectRoot: string,
): DecisionSpecInput {
    return {
        decision_id: deriveObjectId(
            "dec",
            CLAIM_LANE_IMPORT_SOURCE_ID,
            projectRoot,
            claim.publicClaimId,
            claim.revisionLocator,
        ),
        object_id: importedObjectId(claim.publicClaimId, projectRoot),
        domain_id: CTX_MEMORY_DOMAIN_ID,
        decision_kind: claim.category,
        payload: { summary: claimLaneImportSummary(claim), rationale: "" },
        source_id: CLAIM_LANE_IMPORT_SOURCE_ID,
        source_revision: Math.max(1, claim.revision),
        // A claim the lane withheld from automatic surfaces imports as `sensitive`: the kernel and the automatic consumers hide sensitive rows while explicit search still serves them, preserving the lane's eligibility split. Anti-memories get the same treatment — a stale, disputed, superseded, or ineligible warning the lane's auto-search path withheld must not resurface as an automatic warning through the bridge. commentlint: allow(JUDGE)
        ...(claimAutoEligible(claim) ? {} : { sensitivity: "sensitive" as const }),
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

/** Import ids derivable from the project's own lane claims across every lifecycle state. Reconciliation excludes these so a lane lifecycle change on an own claim never reaches back into the kernel copy; `null` means the projection answered stale. commentlint: allow(JUDGE) */
function listOwnClaimImportIds(
    db: Database,
    projectPath: string,
    projectRoot: string,
): Set<string> | null {
    if (!hasClaimMemoryFragment(db)) return new Set();
    const ws = claimLaneWorkspace(db, projectPath);
    const ownProjectIds = resolveProjectIdsForIdentities(db, ws.ownIdentities);
    if (ownProjectIds.length === 0) return new Set();
    const result = readProjectMemoryCurrentState(db, {
        projectIds: ownProjectIds,
        surface: "explicit_search",
        lifecycleStates: CLAIM_MEMORY_LIFECYCLE_STATES,
    });
    if (result.status !== "ok") return null;
    return new Set(result.items.map((item) => importedObjectId(item.publicClaimId, projectRoot)));
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
    const authorization = claimLaneAuthorizationFingerprint(db, projectPath);
    const claims = listClaimLaneMemories(db, projectPath);
    if (claims === null) {
        sessionLog(
            sessionId,
            "claim-lane import deferred: the claim-lane projection answered stale; the lane replays once a snapshot publishes",
        );
        return "deferred";
    }
    // Without lane tables no import ever ran on this store, so there is nothing to insert or reconcile. commentlint: allow(JUDGE)
    if (claims.length === 0 && !hasClaimMemoryFragment(db)) {
        return markDone(db, projectPath, projectRoot, generation, { imported: 0, authorization })
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
    // Reconciliation retires foreign imports the current workspace policy no longer authorizes. Own-claim import ids (every lifecycle state) are excluded so the kernel keeps owning the lifecycle of the project's own bridged rows; a row outside both sets can only be a foreign import whose sharing was revoked or whose member left. commentlint: allow(JUDGE)
    const authorizedIds = new Set(
        claims.map((claim) => importedObjectId(claim.publicClaimId, projectRoot)),
    );
    const ownImportIds = listOwnClaimImportIds(db, projectPath, projectRoot);
    if (ownImportIds === null) {
        sessionLog(
            sessionId,
            "claim-lane import deferred: the own-claim projection answered stale; reconciliation needs a published snapshot",
        );
        return "deferred";
    }
    const revocable = existing.rows.filter(
        (row) =>
            row.object.domain_id === CTX_MEMORY_DOMAIN_ID &&
            row.object.source_id === CLAIM_LANE_IMPORT_SOURCE_ID &&
            !authorizedIds.has(row.object.object_id) &&
            !ownImportIds.has(row.object.object_id),
    );
    let revoked = 0;
    for (const row of revocable) {
        const result = await client.archive(row.object.object_id, {
            actor: CLAIM_LANE_IMPORT_ACTOR,
            // The authorization fingerprint scopes the operation key to this policy change; the same revocation replays, and a later distinct policy change keys fresh operations. commentlint: allow(JUDGE)
            operationId: `revoke\u001f${row.object.object_id}\u001f${authorization}`,
            cause: `claim-lane share revocation ${row.object.object_id}`,
        });
        if (!isAvailable(result)) {
            sessionLog(
                sessionId,
                `claim-lane import deferred after revoking ${revoked} of ${revocable.length} foreign memories: kernel commit answered ${stateKey(result.state)}`,
            );
            return "deferred";
        }
        revoked += 1;
    }
    const present = new Set(existing.rows.map((row) => row.object.object_id));
    // A marker reset replays the whole lane, so claims the historian already
    // promoted under its own derived ids dedupe by (kind, summary) instead of
    // duplicating as import-id rows.
    const presentContent = liveMemoryContentKeys(existing.rows);
    const pending = claims.filter(
        (claim) =>
            !present.has(importedObjectId(claim.publicClaimId, projectRoot)) &&
            !presentContent.has(`${claim.category}\u001f${claimLaneImportSummary(claim)}`),
    );
    let imported = 0;
    let retired = 0;
    // A claim imported and later archived is absent from the read yet
    // re-inserts as `already_exists`. Committing claims individually treats
    // that answer as already imported and keeps it from aborting later claims.
    for (const claim of pending) {
        const result = await client.commit({
            actor: CLAIM_LANE_IMPORT_ACTOR,
            operationId: `import\u001f${claim.publicClaimId}\u001f${claim.revisionLocator}`,
            cause: `claim-lane import ${claim.publicClaimId}`,
            sourceKind: "model",
            operations: [
                { op: "insert_decision" as const, spec: claimLaneImportSpec(claim, projectRoot) },
            ],
        });
        if (!isAvailable(result)) {
            if (result.state.kind === "invalid" && result.state.reason === "already_exists") {
                retired += 1;
                continue;
            }
            sessionLog(
                sessionId,
                `claim-lane import deferred after ${imported} of ${pending.length} memories: kernel commit answered ${stateKey(result.state)}`,
            );
            return "deferred";
        }
        imported += 1;
    }
    if (
        !markDone(db, projectPath, projectRoot, generation, {
            imported,
            retired,
            revoked,
            authorization,
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
        `claim-lane import complete: ${imported} memories committed to the kernel, ${retired} retired in the registry, ${claims.length - pending.length} already present`,
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
    // Another process can clear the shared done marker with `resetClaimLaneImportMarker`; a permanent process-local pin would never observe that reset, so a done answer gets the ordinary cooldown and re-reads the marker after it elapses. commentlint: allow(JUDGE)
    if (claimLaneImportDone(args.db, args.projectPath, args.projectRoot)) {
        attemptedAt.set(key, now);
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
