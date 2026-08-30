import { DREAMER_REVIEWER_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import {
    childSessionMessagesFetcher,
    createChildSessionWithFence,
} from "../../../hooks/magic-context/child-session-spawn";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { dreamerManifestIdentity, recordDreamerManifestRejection } from "../dreamer/claim-manifest";
import {
    DREAMING_LEASE_KEY,
    type LeaseAcquisition,
    runLeaseGuardedWrite,
    startLeaseHeartbeat,
} from "../dreamer/lease";
import { REVIEW_USER_MEMORIES_SYSTEM_PROMPT } from "../dreamer/task-prompts";
import type { ClaimOperationResultEffect } from "../memory/claim-operation-contract";
import { canonicalJsonEncode } from "../memory/claim-operation-contract";
import {
    type AutonomousManifestIdentity,
    runAutonomousCreationManifestInCurrentTransaction,
} from "../memory/storage-claim-autonomous";
import { stageCreateProjectMemoryClaimInCurrentTransaction } from "../memory/storage-claim-operations";
import { ensureProject, sha256Utf8Hex } from "../memory/storage-claims";
import type { MemoryCategory } from "../memory/types";
import { bumpProjectUserProfileVersion } from "../storage";
import { recordChildInvocation } from "../subagent-token-capture";
import {
    deleteUserMemoryCandidates,
    dismissUserMemory,
    getActiveUserMemories,
    getUserMemoryCandidateProjectIdentities,
    getUserMemoryCandidates,
    insertUserMemory,
    pruneExpiredUserMemoryCandidates,
    USER_MEMORY_CANDIDATE_TTL_MS,
    type UserMemory,
    type UserMemoryCandidate,
    updateUserMemoryContent,
} from "./storage-user-memory";

interface ReviewUserMemoriesArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    holderId: string;
    /** Keyed lease this task holds (Dreamer v2: global user-memories domain).
     *  Defaults to the legacy single lease key for back-compat. */
    leaseKey?: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    promotionThreshold: number;
    /** Per-task model override (Dreamer v2). */
    model?: string;
    /** Resolved dreamer fallback chain. */
    fallbackModels?: readonly string[];
    language?: string;
}

export interface ReviewResult {
    promoted: number;
    projectPromoted: number;
    merged: number;
    dismissed: number;
    candidatesConsumed: number;
    /**
     * Effects of the claim-native project promotions. Reducing the outcome to
     * counts left the dream-run audit with no claim IDs at all while the log
     * reported `project_promoted > 0`; the curate and retrospective paths feed
     * these through `claimEffectMemoryChanges` for the same reason.
     */
    effects: readonly ClaimOperationResultEffect[];
}

interface ReviewCandidateSnapshot extends UserMemoryCandidate {
    projectIdentities: string[];
}

export interface UserMemoryReviewSnapshot {
    candidates: ReviewCandidateSnapshot[];
    stableMemories: UserMemory[];
    digest: string;
}

interface ProfilePromotion {
    content: string;
    candidateIds: number[];
}

interface ProjectPromotion extends ProfilePromotion {
    category: MemoryCategory;
}

interface ProfileUpdate {
    memoryId: number;
    content: string;
    candidateIds: number[];
}

interface ProfileDismissal {
    memoryId: number;
    reason: string | null;
}

export interface UserMemoryReviewManifest {
    promotions: ProfilePromotion[];
    projectPromotions: ProjectPromotion[];
    updates: ProfileUpdate[];
    dismissals: ProfileDismissal[];
    consumeCandidateIds: number[];
}

interface ReviewApplyResult {
    result: ReviewResult;
    replayed: boolean;
    staleReason: string | null;
}

type ReviewAbortSignal = NonNullable<
    NonNullable<Parameters<typeof shared.promptSyncWithModelSuggestionRetry>[2]>["signal"]
>;

const PROJECT_MEMORY_CATEGORIES = new Set<MemoryCategory>([
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
]);

class StaleUserMemoryReviewError extends Error {
    constructor(reason: string) {
        super(`User memory review manifest is stale: ${reason}`);
        this.name = "StaleUserMemoryReviewError";
    }
}

/**
 * Candidates a review running for `projectIdentity` is permitted to act on:
 * unbound candidates (no session→project mapping, so they can only ever feed the
 * global user profile) plus candidates bound to this project.
 *
 * Candidates bound exclusively to OTHER projects are excluded because the two
 * halves of the contract disagree about them: `validateManifestReferences`
 * rejects `promote_project` for a candidate not bound to the run's project,
 * while `consume_candidate_ids` would still hard-delete it
 * (`deleteUserMemoryCandidates`). Since every project runs its own review over
 * one shared candidate table, leaving foreign candidates in the snapshot lets
 * whichever project reviews first delete another project's project-bound
 * observation without promoting it anywhere, and the owning project then finds
 * nothing to review. Keeping them out of the snapshot means the model cannot see
 * them and so can never name them in `consume_candidate_ids`.
 */
function isReviewableInProject(
    projectIdentities: readonly string[],
    projectIdentity: string,
): boolean {
    return projectIdentities.length === 0 || projectIdentities.includes(projectIdentity);
}

function reviewSnapshotDigest(
    candidates: readonly ReviewCandidateSnapshot[],
    stableMemories: readonly UserMemory[],
    projectIdentity: string,
): string {
    return sha256Utf8Hex(
        canonicalJsonEncode({
            // The digest covers the review scope, not just its contents: a
            // snapshot captured for one project must not validate as fresh when
            // applied under another.
            projectIdentity,
            candidates: candidates.map((candidate) => ({
                content: candidate.content,
                createdAt: candidate.createdAt,
                id: candidate.id,
                projectIdentities: candidate.projectIdentities,
                sessionId: candidate.sessionId,
                sourceCompartmentEnd: candidate.sourceCompartmentEnd,
                sourceCompartmentStart: candidate.sourceCompartmentStart,
            })),
            stableMemories: stableMemories.map((memory) => ({
                content: memory.content,
                id: memory.id,
                sourceCandidateIds: memory.sourceCandidateIds,
                sourceProvenance: memory.sourceProvenance,
                status: memory.status,
                updatedAt: memory.updatedAt,
            })),
        }),
    );
}

export function captureUserMemoryReviewSnapshot(
    db: Database,
    projectIdentity: string,
    now: number = Date.now(),
): UserMemoryReviewSnapshot {
    const cutoff = now - USER_MEMORY_CANDIDATE_TTL_MS;
    const fresh = getUserMemoryCandidates(db).filter((candidate) => candidate.createdAt >= cutoff);
    const projectsByCandidate = getUserMemoryCandidateProjectIdentities(
        db,
        fresh.map((candidate) => candidate.id),
    );
    const enriched = fresh
        .map((candidate) => ({
            ...candidate,
            projectIdentities: projectsByCandidate.get(candidate.id) ?? [],
        }))
        .filter((candidate) => isReviewableInProject(candidate.projectIdentities, projectIdentity));
    const stableMemories = getActiveUserMemories(db);
    return {
        candidates: enriched,
        stableMemories,
        digest: reviewSnapshotDigest(enriched, stableMemories, projectIdentity),
    };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function optionalArray(value: unknown, label: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value;
}

function requiredContent(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} content must be a non-empty string`);
    }
    return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive integer`);
    }
    return value;
}

function idArray(value: unknown, label: string, required: boolean): number[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    const ids = value.map((id, index) => positiveInteger(id, `${label}[${index}]`));
    if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate IDs`);
    if (required && ids.length === 0) throw new Error(`${label} must not be empty`);
    return ids;
}

export function parseUserMemoryReviewManifest(value: unknown): UserMemoryReviewManifest {
    const root = requireObject(value, "user memory review");
    const promotions = optionalArray(root.promote, "promote").map((item, index) => {
        const row = requireObject(item, `promote[${index}]`);
        return {
            content: requiredContent(row.content, `promote[${index}]`),
            candidateIds: idArray(row.candidate_ids, `promote[${index}].candidate_ids`, true),
        };
    });
    const projectPromotions = optionalArray(root.promote_project, "promote_project").map(
        (item, index) => {
            const row = requireObject(item, `promote_project[${index}]`);
            if (
                typeof row.category !== "string" ||
                !PROJECT_MEMORY_CATEGORIES.has(row.category as MemoryCategory)
            ) {
                throw new Error(`promote_project[${index}] has an invalid project-memory category`);
            }
            return {
                content: requiredContent(row.content, `promote_project[${index}]`),
                category: row.category as MemoryCategory,
                candidateIds: idArray(
                    row.candidate_ids,
                    `promote_project[${index}].candidate_ids`,
                    true,
                ),
            };
        },
    );
    const updates = optionalArray(root.update_existing, "update_existing").map((item, index) => {
        const row = requireObject(item, `update_existing[${index}]`);
        return {
            memoryId: positiveInteger(row.memory_id, `update_existing[${index}].memory_id`),
            content: requiredContent(row.content, `update_existing[${index}]`),
            candidateIds:
                row.candidate_ids === undefined
                    ? []
                    : idArray(row.candidate_ids, `update_existing[${index}].candidate_ids`, false),
        };
    });
    const dismissals = optionalArray(root.dismiss_existing, "dismiss_existing").map(
        (item, index) => {
            const row = requireObject(item, `dismiss_existing[${index}]`);
            if (row.reason !== undefined && typeof row.reason !== "string") {
                throw new Error(`dismiss_existing[${index}].reason must be a string`);
            }
            return {
                memoryId: positiveInteger(row.memory_id, `dismiss_existing[${index}].memory_id`),
                reason: typeof row.reason === "string" ? row.reason : null,
            };
        },
    );
    const consumeCandidateIds =
        root.consume_candidate_ids === undefined
            ? []
            : idArray(root.consume_candidate_ids, "consume_candidate_ids", false);
    return { promotions, projectPromotions, updates, dismissals, consumeCandidateIds };
}

function validateManifestReferences(args: {
    manifest: UserMemoryReviewManifest;
    snapshot: UserMemoryReviewSnapshot;
    projectIdentity: string;
    /** Minimum corroborating candidates a project promotion must carry. */
    promotionThreshold: number;
}): void {
    const candidateById = new Map(
        args.snapshot.candidates.map((candidate) => [candidate.id, candidate]),
    );
    const stableIds = new Set(args.snapshot.stableMemories.map((memory) => memory.id));
    const consumed = new Set(args.manifest.consumeCandidateIds);
    for (const id of consumed) {
        if (!candidateById.has(id)) throw new Error(`review consumes unknown candidate ${id}`);
    }

    const usedCandidates = new Set<number>();
    const useCandidates = (ids: readonly number[], label: string): void => {
        for (const id of ids) {
            if (!candidateById.has(id))
                throw new Error(`${label} references unknown candidate ${id}`);
            if (!consumed.has(id)) throw new Error(`${label} candidate ${id} is not consumed`);
            if (usedCandidates.has(id))
                throw new Error(`candidate ${id} appears in multiple actions`);
            usedCandidates.add(id);
        }
    };
    for (const [index, promotion] of args.manifest.promotions.entries()) {
        useCandidates(promotion.candidateIds, `promote[${index}]`);
    }
    for (const [index, promotion] of args.manifest.projectPromotions.entries()) {
        useCandidates(promotion.candidateIds, `promote_project[${index}]`);
        // The threshold gates whether the review runs at all and is otherwise
        // stated only in the prompt, so a model that returns a single candidate
        // out of a qualifying snapshot would turn one uncorroborated observation
        // into a durable project claim. A project promotion has to carry its own
        // corroboration.
        //
        // Reject an unusable threshold rather than comparing against it: test
        // files are excluded from typecheck, so a caller that omits the field
        // would otherwise compare against `undefined` — always false — and lose
        // this guard silently, which is the failure mode it exists to prevent.
        if (!Number.isInteger(args.promotionThreshold) || args.promotionThreshold < 1) {
            throw new Error(
                `promote_project[${index}] cannot be validated: promotionThreshold is ${args.promotionThreshold}`,
            );
        }
        if (promotion.candidateIds.length < args.promotionThreshold) {
            throw new Error(
                `promote_project[${index}] carries ${promotion.candidateIds.length} candidate(s); ${args.promotionThreshold} are required for a project claim`,
            );
        }
        for (const id of promotion.candidateIds) {
            const projects = candidateById.get(id)?.projectIdentities ?? [];
            if (projects.length !== 1 || projects[0] !== args.projectIdentity) {
                throw new Error(
                    `promote_project[${index}] candidate ${id} is not bound only to ${args.projectIdentity}`,
                );
            }
        }
    }
    for (const [index, update] of args.manifest.updates.entries()) {
        if (!stableIds.has(update.memoryId)) {
            throw new Error(
                `update_existing[${index}] references unknown memory ${update.memoryId}`,
            );
        }
        useCandidates(update.candidateIds, `update_existing[${index}]`);
    }
    const updatedMemoryIds = new Set(args.manifest.updates.map((update) => update.memoryId));
    const dismissedMemoryIds = new Set<number>();
    for (const [index, dismissal] of args.manifest.dismissals.entries()) {
        if (!stableIds.has(dismissal.memoryId)) {
            throw new Error(
                `dismiss_existing[${index}] references unknown memory ${dismissal.memoryId}`,
            );
        }
        if (updatedMemoryIds.has(dismissal.memoryId)) {
            throw new Error(
                `memory ${dismissal.memoryId} cannot be updated and dismissed together`,
            );
        }
        if (dismissedMemoryIds.has(dismissal.memoryId)) {
            throw new Error(`memory ${dismissal.memoryId} is dismissed more than once`);
        }
        dismissedMemoryIds.add(dismissal.memoryId);
    }
}

function canonicalReviewManifest(manifest: UserMemoryReviewManifest) {
    return {
        consumeCandidateIds: manifest.consumeCandidateIds,
        dismissals: manifest.dismissals.map((item) => ({
            memoryId: item.memoryId,
            reason: item.reason,
        })),
        profiles: manifest.promotions.map((item) => ({
            candidateIds: item.candidateIds,
            content: item.content,
        })),
        projectMemories: manifest.projectPromotions.map((item) => ({
            candidateIds: item.candidateIds,
            category: item.category,
            content: item.content,
        })),
        updates: manifest.updates.map((item) => ({
            candidateIds: item.candidateIds,
            content: item.content,
            memoryId: item.memoryId,
        })),
    };
}

export function applyUserMemoryReviewManifest(args: {
    db: Database;
    projectIdentity: string;
    holderId: string;
    leaseKey: string;
    expectedLeaseGeneration?: number;
    identity: AutonomousManifestIdentity;
    snapshot: UserMemoryReviewSnapshot;
    manifest: UserMemoryReviewManifest;
    /** Minimum corroborating candidates a project promotion must carry. */
    promotionThreshold: number;
    nowMs?: number;
}): ReviewApplyResult {
    validateManifestReferences(args);
    const nowMs = args.nowMs ?? Date.now();
    return runLeaseGuardedWrite(
        args.db,
        args.holderId,
        args.leaseKey,
        () => {
            let checkedSnapshot = false;
            let staleReason: string | null = null;
            let projectId: number | undefined;
            const checkSnapshot = () => {
                if (!checkedSnapshot) {
                    const current = captureUserMemoryReviewSnapshot(
                        args.db,
                        args.projectIdentity,
                        nowMs,
                    );
                    staleReason =
                        current.digest === args.snapshot.digest
                            ? null
                            : "candidate or profile snapshot changed after review started";
                    checkedSnapshot = true;
                }
                return staleReason;
            };
            const candidateById = new Map(
                args.snapshot.candidates.map((candidate) => [candidate.id, candidate]),
            );
            const projectItems = args.manifest.projectPromotions.map((promotion, index) => ({
                key: {
                    candidateIds: promotion.candidateIds,
                    category: promotion.category,
                    contentDigest: sha256Utf8Hex(promotion.content),
                    index,
                    snapshotDigest: args.snapshot.digest,
                },
                value: { promotion, index },
            }));
            const manifestItems: Array<{
                key: Record<string, string | number | number[]>;
                value: { promotion: ProjectPromotion | null; index: number };
            }> =
                projectItems.length === 0
                    ? [
                          {
                              key: { snapshotDigest: args.snapshot.digest },
                              value: { promotion: null, index: -1 },
                          },
                      ]
                    : projectItems;
            const operation = runAutonomousCreationManifestInCurrentTransaction({
                db: args.db,
                identity: args.identity,
                items: manifestItems,
                manifest: canonicalReviewManifest(args.manifest),
                resultSummary: {
                    candidatesConsumed: args.manifest.consumeCandidateIds.length,
                    dismissed: args.manifest.dismissals.length,
                    merged: args.manifest.updates.length,
                    profilePromoted: args.manifest.promotions.length,
                    projectPromoted: args.manifest.projectPromotions.length,
                },
                stageItem: (db, item, stageNowMs) => {
                    const stale = checkSnapshot();
                    if (stale) return { kind: "stale", reason: stale };
                    if (item.value.promotion === null) return { kind: "noop" };
                    projectId ??= ensureProject(db, args.projectIdentity);
                    const sources = item.value.promotion.candidateIds.map((id) => {
                        const candidate = candidateById.get(id);
                        if (!candidate) throw new Error(`missing review candidate ${id}`);
                        return candidate;
                    });
                    const sessionIds = [...new Set(sources.map((source) => source.sessionId))];
                    return stageCreateProjectMemoryClaimInCurrentTransaction(
                        db,
                        {
                            projectId,
                            content: item.value.promotion.content,
                            category: item.value.promotion.category,
                            memoryScope: "project",
                            sharing: "private",
                            provenance: {
                                sourceLocator: `user-profile-review://${args.identity.runId}/${args.identity.batchId}/${item.value.index}`,
                                sourceContent: sources
                                    .map((source) => `candidate:${source.id}:${source.content}`)
                                    .join("\n"),
                                sourceSessionId: sessionIds.length === 1 ? sessionIds[0] : null,
                                extractor: "dreamer-review-user-memories",
                                extractorVersion: "direct-claims-v1",
                                extractorRunId: args.identity.runId,
                                independenceKey: `review-user-memories:${args.identity.leaseGeneration}:${item.value.promotion.candidateIds.join(",")}`,
                                sourceTrustClass: "model_inference",
                            },
                            actor: args.identity.producer,
                            userInferred: true,
                            requestScope: "review-user-memories:project-promotion",
                            nowMs: stageNowMs,
                        },
                        stageNowMs,
                    );
                },
                nowMs,
            });
            if (operation.operation.outcome === "stale") {
                return {
                    result: {
                        promoted: 0,
                        projectPromoted: 0,
                        merged: 0,
                        dismissed: 0,
                        candidatesConsumed: 0,
                        effects: [],
                    },
                    replayed: operation.operation.replayed,
                    staleReason:
                        operation.operation.result.staleReason ??
                        "candidate or profile snapshot changed",
                };
            }
            if (!operation.operation.replayed) {
                for (const promotion of args.manifest.promotions) {
                    insertUserMemory(args.db, promotion.content, promotion.candidateIds);
                }
                for (const update of args.manifest.updates) {
                    updateUserMemoryContent(
                        args.db,
                        update.memoryId,
                        update.content,
                        update.candidateIds,
                    );
                }
                for (const dismissal of args.manifest.dismissals) {
                    dismissUserMemory(args.db, dismissal.memoryId);
                }
                deleteUserMemoryCandidates(args.db, args.manifest.consumeCandidateIds);
                pruneExpiredUserMemoryCandidates(args.db, USER_MEMORY_CANDIDATE_TTL_MS, nowMs);
                if (
                    args.manifest.promotions.length > 0 ||
                    args.manifest.updates.length > 0 ||
                    args.manifest.dismissals.length > 0
                ) {
                    bumpProjectUserProfileVersion(args.db);
                }
            }
            return {
                result: {
                    promoted: args.manifest.promotions.length,
                    projectPromoted: args.manifest.projectPromotions.length,
                    merged: args.manifest.updates.length,
                    dismissed: args.manifest.dismissals.length,
                    candidatesConsumed: args.manifest.consumeCandidateIds.length,
                    effects: operation.operation.result.effects,
                },
                replayed: operation.operation.replayed,
                staleReason: null,
            };
        },
        args.expectedLeaseGeneration,
    );
}

export async function reviewUserMemories(args: ReviewUserMemoriesArgs): Promise<ReviewResult> {
    const emptyResult: ReviewResult = {
        promoted: 0,
        projectPromoted: 0,
        merged: 0,
        dismissed: 0,
        candidatesConsumed: 0,
        effects: [],
    };
    const leaseKey = args.leaseKey ?? DREAMING_LEASE_KEY;
    const snapshotNow = Date.now();
    const snapshot = captureUserMemoryReviewSnapshot(args.db, args.projectIdentity, snapshotNow);
    if (snapshot.candidates.length < args.promotionThreshold) {
        const prunedExpired = runLeaseGuardedWrite(
            args.db,
            args.holderId,
            leaseKey,
            () =>
                pruneExpiredUserMemoryCandidates(
                    args.db,
                    USER_MEMORY_CANDIDATE_TTL_MS,
                    snapshotNow,
                ),
            args.leaseAcquisition?.generation,
        );
        if (prunedExpired > 0) {
            log(`[dreamer] user-memories: decayed ${prunedExpired} expired candidate(s)`);
        }
        log(
            `[dreamer] user-memories: ${snapshot.candidates.length} candidate(s), need ${args.promotionThreshold} — skipping`,
        );
        return emptyResult;
    }

    log(
        `[dreamer] user-memories: reviewing ${snapshot.candidates.length} candidate(s) against ${snapshot.stableMemories.length} stable memorie(s)`,
    );
    const candidateList = snapshot.candidates
        .map((candidate) => {
            const project =
                candidate.projectIdentities.length === 1
                    ? candidate.projectIdentities[0]
                    : candidate.projectIdentities.length === 0
                      ? "unmapped"
                      : "ambiguous";
            return `- Candidate #${candidate.id} [session ${candidate.sessionId.slice(0, 12)}; project ${project}]: "${candidate.content}"`;
        })
        .join("\n");
    const stableList =
        snapshot.stableMemories.length > 0
            ? snapshot.stableMemories
                  .map((memory) => `- Memory #${memory.id}: "${memory.content}"`)
                  .join("\n")
            : "(none)";
    const prompt = `## Task: Review User Memory Candidates

You are reviewing behavioral observations about a human user to decide which patterns are real and persistent.

### Current Stable User Memories
${stableList}

### Candidate Observations (from recent historian runs)
${candidateList}

### Current Project
${args.projectIdentity}

### Instructions

1. Look for **recurring patterns** across multiple candidates — observations that appear independently from different sessions or historian runs indicate a real user trait.
2. A candidate must appear in at least ${args.promotionThreshold} semantically similar variants before promotion.
3. Promote truly universal user traits — communication style, expertise level, review focus, decision-making patterns, working habits — through \`promote\`.
4. Project-specific rules are not user-profile memories. A recurring project fact may use \`promote_project\` only when every supporting candidate is bound to the Current Project. Use one of PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, or NAMING. Never route unmapped or ambiguous candidates into project memory.
5. Do not promote one-off moods or task-local frustrations.
6. If a candidate is semantically equivalent to an existing stable memory, mark it as already covered.
7. If multiple candidates describe the same trait, merge them into one clean statement.
8. If an existing stable memory should be updated based on new evidence, include the update.

### Output Format

Return valid JSON (no markdown fencing):

{
  "promote": [
    { "content": "Clean universal observation text", "candidate_ids": [1, 3, 7] }
  ],
  "promote_project": [
    { "content": "Project-specific durable fact", "category": "PROJECT_RULES", "candidate_ids": [2, 4] }
  ],
  "update_existing": [
    { "memory_id": 5, "content": "Updated text incorporating new evidence", "candidate_ids": [6] }
  ],
  "dismiss_existing": [
    { "memory_id": 3, "reason": "No longer supported by recent observations" }
  ],
  "consume_candidate_ids": [1, 2, 3, 4, 6, 7]
}

- \`promote\`: new stable user-profile memories
- \`promote_project\`: project-memory claims derived from candidates bound only to Current Project
- \`update_existing\`: existing stable user-profile memories to rewrite with new evidence
- \`dismiss_existing\`: existing stable user-profile memories that are no longer valid
- \`consume_candidate_ids\`: all candidate IDs that were reviewed; every candidate used by an action must be included

If no promotions are warranted, return empty arrays. Consume reviewed candidates so they do not accumulate indefinitely.`;

    let agentSessionId: string | null = null;
    let rawManifest = "";
    let manifestFinalized = false;
    const startedAt = Date.now();
    let invocationRecorded = false;
    const recordInvocation = (params: {
        status: "completed" | "failed";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!args.parentSessionId || invocationRecorded) return;
        invocationRecorded = true;
        recordChildInvocation({
            db: args.db,
            parentSessionId: args.parentSessionId,
            harness: "opencode",
            subagent: "dreamer",
            task: "review-user-memories",
            startedAt,
            status: params.status,
            messages: params.messages,
            error: params.error,
        });
    };
    const identity = dreamerManifestIdentity({
        db: args.db,
        holderId: args.holderId,
        leaseKey,
        parentSessionId: args.parentSessionId,
        task: "review-user-memories",
        publicClaimIds: [`snapshot:${snapshot.digest}`],
    });
    // SAFETY: Runtime constructor is consumed only through abort() and signal.
    const AbortControllerConstructor = (
        globalThis as unknown as {
            AbortController: new () => { abort(): void; signal: ReviewAbortSignal };
        }
    ).AbortController;
    const abortController = new AbortControllerConstructor();
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        leaseKey,
        (reason) => {
            log(`[dreamer] user-memories: lease lost (${reason}) — aborting`);
            abortController.abort();
        },
        args.leaseAcquisition,
    );

    try {
        const createResponse = await createChildSessionWithFence({
            client: args.client,
            db: args.db,
            parentSessionId: args.parentSessionId,
            title: "magic-context-dream-user-memories",
            directory: args.sessionDirectory,
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create user memory review session.");

        const childSessionId = agentSessionId;
        log(`[dreamer] user-memories: child session created ${childSessionId}`);
        const remainingMs = Math.max(0, args.deadline - Date.now());
        const reviewRun = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: childSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_REVIEWER_AGENT,
                    system: withContentLanguageDirective(
                        REVIEW_USER_MEMORIES_SYSTEM_PROMPT,
                        args.language,
                    ),
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: remainingMs,
                signal: abortController.signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:user-memories",
                fetchOutput: childSessionMessagesFetcher(
                    args.client,
                    childSessionId,
                    args.sessionDirectory,
                    50,
                ),
                validateOutput: (messages) => {
                    const responseText = extractLatestAssistantText(messages);
                    if (!responseText) throw new Error("User memory review returned no output.");
                    rawManifest = responseText;
                    const jsonMatch =
                        responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ??
                        responseText.match(/(\{[\s\S]*\})/);
                    if (!jsonMatch) throw new Error("User memory review returned no JSON.");
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(jsonMatch[1] ?? "");
                    } catch {
                        throw new Error("User memory review returned invalid JSON.");
                    }
                    const manifest = parseUserMemoryReviewManifest(parsed);
                    validateManifestReferences({
                        manifest,
                        snapshot,
                        projectIdentity: args.projectIdentity,
                        promotionThreshold: args.promotionThreshold,
                    });
                    return manifest;
                },
            },
        );

        const applied = applyUserMemoryReviewManifest({
            db: args.db,
            projectIdentity: args.projectIdentity,
            holderId: args.holderId,
            leaseKey,
            expectedLeaseGeneration: args.leaseAcquisition?.generation,
            identity,
            snapshot,
            manifest: reviewRun.validated,
            promotionThreshold: args.promotionThreshold,
        });
        manifestFinalized = true;
        if (applied.staleReason) throw new StaleUserMemoryReviewError(applied.staleReason);
        recordInvocation({ status: "completed", messages: reviewRun.output });

        for (const promotion of reviewRun.validated.promotions) {
            log(`[dreamer] user-memories: promoted "${promotion.content.slice(0, 60)}..."`);
        }
        for (const promotion of reviewRun.validated.projectPromotions) {
            log(
                `[dreamer] user-memories: promoted project ${promotion.category} "${promotion.content.slice(0, 60)}..."`,
            );
        }
        for (const update of reviewRun.validated.updates) {
            log(`[dreamer] user-memories: updated memory #${update.memoryId}`);
        }
        for (const dismissal of reviewRun.validated.dismissals) {
            log(
                `[dreamer] user-memories: dismissed memory #${dismissal.memoryId} — ${dismissal.reason ?? "no reason"}`,
            );
        }
        if (applied.result.candidatesConsumed > 0) {
            log(
                `[dreamer] user-memories: consumed ${applied.result.candidatesConsumed} candidate(s)`,
            );
        }
        return applied.result;
    } catch (error) {
        if (!manifestFinalized) {
            try {
                recordDreamerManifestRejection({
                    db: args.db,
                    holderId: args.holderId,
                    leaseKey,
                    identity,
                    rawManifest,
                    reason: getErrorMessage(error),
                });
            } catch (recordError) {
                log(
                    `[dreamer] user-memories rejection receipt failed: ${getErrorMessage(recordError)}`,
                );
            }
        }
        const errorDescription = describeError(error);
        log(
            `[dreamer] user-memories: review failed: ${errorDescription.brief}`,
            errorDescription.stackHead ? { stackHead: errorDescription.stackHead } : undefined,
        );
        recordInvocation({ status: "failed", error });
        throw error;
    } finally {
        heartbeat.stop();
        if (agentSessionId) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((error: unknown) => {
                    log(
                        `[dreamer] user-memories: session cleanup failed: ${getErrorMessage(error)}`,
                    );
                });
        }
    }
}
