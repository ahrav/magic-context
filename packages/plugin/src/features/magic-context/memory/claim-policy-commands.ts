/**
 * Host-owned claim approval and enforcement command workflows shared by the
 * OpenCode and Pi harnesses (KD1; KTD5-KTD6). Two-step stale-safe
 * confirmation: the first invocation shows the owning project, exact
 * revision, and content digest; repeating the same command within the window
 * records exactly one idempotent action. Neither workflow is reachable from
 * any agent tool schema.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Database } from "../../../shared/sqlite";
import type { EnforcementArtifactKind } from "../storage-claim-policy-schema";
import {
    appendMaturityAssertionInCurrentTransaction,
    currentApprovalActionId,
    readMaturityHead,
    readPolicySubject,
    recordApprovalActionInCurrentTransaction,
    recordEnforcementArtifactInCurrentTransaction,
    refreshEffectivePolicyInCurrentTransaction,
} from "./storage-claim-policy";
import { sha256Utf8Hex } from "./storage-claims";
import {
    type MemoryClaimEffect,
    readMemoryClaimLink,
    resolveMemoryClaimProjectInCurrentTransaction,
    runInMemoryClaimsWriteTransaction,
    runMemoryClaimOperationInCurrentTransaction,
    withMemoryClaimGenerationContextInCurrentTransaction,
} from "./storage-memory-claims";

export interface ClaimCommandResult {
    text: string;
    level: "info" | "warning" | "error";
}

export interface ArtifactEvaluation {
    result: "pass" | "fail";
    evaluator: string;
    evaluatorVersion: string;
    detail?: string;
}

export interface ClaimCommandDeps {
    db: Database;
    /** Active project identity as stored in `memories.project_path`. */
    projectPath: string;
    /** Filesystem root of the active project, for artifact canonicalization. */
    projectRoot: string;
    host: "opencode" | "pi";
    sessionId: string;
    nowMs?: number;
    /** Injectable artifact evaluator; the default runs `bun test` for test
     * artifacts and rejects other kinds. */
    evaluateArtifact?: (
        canonicalPath: string,
        kind: EnforcementArtifactKind,
        projectRoot: string,
    ) => ArtifactEvaluation | Promise<ArtifactEvaluation>;
}

interface PendingConfirmation {
    timestamp: number;
    argsKey: string;
    revisionId: number;
    digest: string;
    nonce: string;
}

const CONFIRMATION_WINDOW_MS = 60_000;
const pendingByKey = new Map<string, PendingConfirmation>();

export function clearClaimCommandConfirmationsForTests(): void {
    pendingByKey.clear();
}

interface ResolvedTarget {
    memoryId: number;
    claimId: number;
    projectId: number;
    revisionId: number;
    digest: string;
    preview: string;
}

/** Resolve a memory id to its claim revision INSIDE the active project only:
 * foreign and workspace-shared rows are rejected before any confirmation
 * detail is revealed (R10). */
function resolveTarget(
    deps: ClaimCommandDeps,
    memoryId: number,
): ResolvedTarget | { error: string } {
    const link = readMemoryClaimLink(deps.db, memoryId);
    if (!link) return { error: `Memory ${memoryId} has no claim link in this project.` };
    // Membership is decided by resolved project id, not stored-path bytes: a
    // legacy raw path or an older alias maps to the same numeric project
    // through `project_aliases`, and the crosswalk's project id carries that
    // resolution. Foreign and workspace-shared rows still fail the id
    // comparison (R10).
    const projectId = runInMemoryClaimsWriteTransaction(deps.db, () =>
        resolveMemoryClaimProjectInCurrentTransaction(deps.db, deps.projectPath),
    );
    if (projectId === null || projectId !== link.projectId) {
        return { error: `Memory ${memoryId} does not belong to the active project.` };
    }
    const revision = deps.db
        .prepare(
            `SELECT claim_revisions.id AS revisionId, claim_revisions.content_sha256 AS digest,
                    claim_revisions.content AS content
             FROM claims JOIN claim_revisions ON claim_revisions.id = claims.current_revision_id
             WHERE claims.id = ?`,
        )
        .get(link.claimId) as
        | { revisionId: number; digest: string; content: string }
        | null
        | undefined;
    if (!revision) return { error: `Claim ${link.claimId} has no current revision.` };
    const preview =
        revision.content.length > 200 ? `${revision.content.slice(0, 200)}…` : revision.content;
    return {
        memoryId,
        claimId: link.claimId,
        projectId,
        revisionId: revision.revisionId,
        digest: revision.digest,
        preview,
    };
}

function confirmationText(
    command: string,
    action: string,
    deps: ClaimCommandDeps,
    target: ResolvedTarget,
): string {
    return [
        `## ⚠️ ${action} Confirmation Required`,
        "",
        `- Project: \`${deps.projectPath}\``,
        `- Memory: ${target.memoryId} (claim ${target.claimId}, revision ${target.revisionId})`,
        `- Content digest: \`${target.digest}\``,
        "",
        `> ${target.preview.replaceAll("\n", "\n> ")}`,
        "",
        `**To confirm, run \`${command}\` again within 60 seconds.**`,
    ].join("\n");
}

interface ConfirmedMutationArgs<T> {
    command: "ctx-approve" | "ctx-enforce";
    argsKey: string;
    target: ResolvedTarget;
    producer: string;
    operationKey: (nonce: string) => string;
    request: (nonce: string) => unknown;
    /** Runs on the confirming invocation BEFORE the write transaction opens:
     * expensive work (artifact evaluation runs a test process with a
     * 120-second budget) must not hold the immediate transaction that every
     * memory, claim, and backfill writer serializes on — and must not block
     * the host event loop that serves every other hook. `mutate` re-verifies
     * its inputs transactionally afterwards. */
    beforeMutate?: () => void | Promise<void>;
    /** Runs inside the write transaction after the stale-safe recheck. */
    mutate: (nonce: string) => { result: T; effects: MemoryClaimEffect[] };
}

/**
 * Shared two-step confirmed mutation: the first invocation stores a nonce
 * bound to session, args, revision, and digest and returns `pending`; a
 * matching repeat within the window rechecks the target inside the write
 * transaction, runs the mutation under the idempotent operation envelope,
 * and bumps the project-memory epoch in the same transaction so no stale m0
 * cache keeps serving the old decision (R27).
 */
async function runConfirmedClaimMutation<T>(
    deps: ClaimCommandDeps,
    args: ConfirmedMutationArgs<T>,
): Promise<{ pending: true } | { pending: false; result: T }> {
    const key = `${deps.host}:${deps.sessionId}:${args.command}`;
    const pendingBefore = pendingByKey.get(key);
    const now = deps.nowMs ?? Date.now();
    const confirmed =
        pendingBefore != null &&
        now - pendingBefore.timestamp < CONFIRMATION_WINDOW_MS &&
        pendingBefore.argsKey === args.argsKey &&
        pendingBefore.revisionId === args.target.revisionId &&
        pendingBefore.digest === args.target.digest;
    if (!confirmed) {
        pendingByKey.set(key, {
            timestamp: now,
            argsKey: args.argsKey,
            revisionId: args.target.revisionId,
            digest: args.target.digest,
            nonce: randomUUID(),
        });
        return { pending: true };
    }
    pendingByKey.delete(key);
    const nonce = pendingBefore.nonce;
    await args.beforeMutate?.();
    const outcome = runInMemoryClaimsWriteTransaction(deps.db, () =>
        withMemoryClaimGenerationContextInCurrentTransaction(deps.db, () => {
            const operation = runMemoryClaimOperationInCurrentTransaction(
                deps.db,
                {
                    producer: args.producer,
                    operationKey: args.operationKey(nonce),
                    requestDigest: sha256Utf8Hex(JSON.stringify(args.request(nonce))),
                },
                () => {
                    // Stale-safe recheck inside the write transaction (R10).
                    const current = resolveTarget(deps, args.target.memoryId);
                    if ("error" in current) throw new Error(current.error);
                    if (
                        current.revisionId !== args.target.revisionId ||
                        current.digest !== args.target.digest
                    ) {
                        throw new Error("the memory changed since confirmation; rerun the command");
                    }
                    return args.mutate(nonce);
                },
            );
            bumpProjectMemoryEpochInCurrentTransaction(deps);
            return operation;
        }),
    );
    return { pending: false, result: outcome.result };
}

function bumpProjectMemoryEpochInCurrentTransaction(deps: ClaimCommandDeps): void {
    deps.db
        .prepare(
            `INSERT INTO project_state
                (project_path, project_memory_epoch, project_user_profile_version, updated_at)
             VALUES (?, 1, 0, ?)
             ON CONFLICT(project_path) DO UPDATE SET
                project_memory_epoch = project_memory_epoch + 1,
                updated_at = excluded.updated_at`,
        )
        .run(deps.projectPath, deps.nowMs ?? Date.now());
}

const APPROVE_USAGE = [
    "Usage:",
    "- `/ctx-approve <memory-id>` — approve the exact current revision",
    "- `/ctx-approve <memory-id> --revoke` — revoke a recorded approval",
].join("\n");

export async function executeClaimApprovalCommand(
    deps: ClaimCommandDeps,
    argsText: string,
): Promise<ClaimCommandResult> {
    const parts = argsText.trim().split(/\s+/).filter(Boolean);
    const revoke = parts.includes("--revoke");
    const idText = parts.find((part) => !part.startsWith("--"));
    const memoryId = idText != null ? Number(idText) : Number.NaN;
    if (!Number.isSafeInteger(memoryId) || memoryId <= 0) {
        return { text: `## Claim Approval\n\n${APPROVE_USAGE}`, level: "error" };
    }
    const target = resolveTarget(deps, memoryId);
    if ("error" in target) {
        return { text: `## Claim Approval — Failed\n\n${target.error}`, level: "error" };
    }
    const action = revoke ? "revoke" : "approve";
    const currentApproval = currentApprovalActionId(deps.db, target.revisionId);
    if (revoke && currentApproval == null) {
        return {
            text: `## Claim Approval — Failed\n\nRevision ${target.revisionId} has no currently effective approval to revoke.`,
            level: "error",
        };
    }
    if (!revoke && currentApproval != null) {
        return {
            text: `## Claim Approval\n\nRevision ${target.revisionId} is already approved.`,
            level: "info",
        };
    }
    let outcome: Awaited<ReturnType<typeof runConfirmedClaimMutation<{ actionId: number }>>>;
    try {
        outcome = await runConfirmedClaimMutation(deps, {
            command: "ctx-approve",
            argsKey: `${action}:${memoryId}`,
            target,
            producer: `claim-approval:${deps.host}`,
            operationKey: (nonce) => `${action}:${target.revisionId}:${nonce}`,
            request: (nonce) => ({
                action,
                revisionId: target.revisionId,
                digest: target.digest,
                nonce,
            }),
            mutate: (nonce) => {
                const recorded = recordApprovalActionInCurrentTransaction(deps.db, {
                    revisionId: target.revisionId,
                    projectId: target.projectId,
                    action,
                    host: deps.host,
                    sessionId: deps.sessionId,
                    userCommandEvent: `command:${deps.host}:ctx-approve:${nonce}`,
                    commandIdentity: `${action}:${target.revisionId}:${nonce}`,
                    confirmationNonce: nonce,
                    nowMs: deps.nowMs,
                });
                if (action === "approve") {
                    appendMaturityAssertionInCurrentTransaction(deps.db, {
                        revisionId: target.revisionId,
                        projectId: target.projectId,
                        maturity: "APPROVED",
                        actor: `user-command:${deps.host}`,
                        approvalActionId: recorded.actionId,
                        nowMs: deps.nowMs,
                    });
                }
                refreshEffectivePolicyInCurrentTransaction(deps.db, target.revisionId, {
                    nowMs: deps.nowMs,
                });
                const effects: MemoryClaimEffect[] = [
                    {
                        effectKey: `policy:${target.revisionId}:approval`,
                        projectId: target.projectId,
                        claimId: target.claimId,
                        effectType: "lifecycle",
                    },
                ];
                return { result: { actionId: recorded.actionId }, effects };
            },
        });
    } catch (error) {
        return {
            text: `## Claim Approval — Failed\n\n${error instanceof Error ? error.message : String(error)}`,
            level: "error",
        };
    }
    if (outcome.pending) {
        return {
            text: confirmationText(
                `/ctx-approve ${memoryId}${revoke ? " --revoke" : ""}`,
                revoke ? "Approval Revocation" : "Claim Approval",
                deps,
                target,
            ),
            level: "warning",
        };
    }
    const head = readMaturityHead(deps.db, target.revisionId);
    return {
        text: [
            `## Claim Approval — ${revoke ? "Revoked" : "Recorded"}`,
            "",
            `Revision ${target.revisionId} (digest \`${target.digest.slice(0, 12)}…\`) is now ${revoke ? "no longer approved; effective maturity falls back to its supported rung" : `historically ${head?.maturity ?? "APPROVED"}`}.`,
        ].join("\n"),
        level: "info",
    };
}

const ENFORCE_USAGE = [
    "Usage:",
    "- `/ctx-enforce <memory-id> <artifact-path>` — bind a passing in-project test artifact",
    "- `/ctx-enforce <memory-id> <artifact-path> --kind test|policy|config`",
].join("\n");

/** ponytail: the default evaluator only knows `bun test`; policy/config
 * artifact evaluators plug in through `deps.evaluateArtifact` when needed.
 * The child process runs detached from the event loop so a slow or hanging
 * test cannot freeze the host that serves every other hook and transform. */
function defaultEvaluateArtifact(
    canonicalPath: string,
    kind: EnforcementArtifactKind,
    projectRoot: string,
): Promise<ArtifactEvaluation> {
    if (kind !== "test") {
        return Promise.resolve({
            result: "fail",
            evaluator: "unsupported",
            evaluatorVersion: "1",
            detail: `No default evaluator for artifact kind '${kind}'.`,
        });
    }
    return new Promise((resolve) => {
        const run = spawn("bun", ["test", canonicalPath], { cwd: projectRoot });
        let output = "";
        run.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
        });
        run.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
        });
        const timer = setTimeout(() => {
            run.kill("SIGKILL");
        }, 120_000);
        const settle = (result: "pass" | "fail", detail?: string) => {
            clearTimeout(timer);
            resolve({
                result,
                evaluator: "bun-test",
                evaluatorVersion: "1",
                detail,
            });
        };
        run.on("error", (error) => {
            settle("fail", String(error).slice(-500));
        });
        run.on("close", (status) => {
            if (status === 0) settle("pass");
            else settle("fail", output.slice(-500) || `exit status ${status}`);
        });
    });
}

/** Canonicalize an artifact path inside the owning project: aliases, absolute
 * inputs, `..` escapes, and symlink escapes are rejected (KTD6). */
function canonicalizeArtifactPath(
    projectRoot: string,
    input: string,
): { canonicalPath: string; absolutePath: string } | { error: string } {
    if (isAbsolute(input)) return { error: "Artifact paths must be project-relative." };
    const rootReal = realpathSync(resolve(projectRoot));
    const absolute = resolve(rootReal, input);
    let real: string;
    try {
        real = realpathSync(absolute);
    } catch {
        return { error: `Artifact not found: ${input}` };
    }
    const rel = relative(rootReal, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        return { error: "Artifact path escapes the owning project." };
    }
    if (!statSync(real).isFile()) return { error: "Artifact must be a regular file." };
    return { canonicalPath: rel.split(sep).join("/"), absolutePath: real };
}

function sha256Bytes(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function executeClaimEnforceCommand(
    deps: ClaimCommandDeps,
    argsText: string,
): Promise<ClaimCommandResult> {
    const parts = argsText.trim().split(/\s+/).filter(Boolean);
    const kindFlagIndex = parts.indexOf("--kind");
    let kind: EnforcementArtifactKind = "test";
    if (kindFlagIndex >= 0) {
        const value = parts[kindFlagIndex + 1];
        if (value !== "test" && value !== "policy" && value !== "config") {
            return { text: `## Claim Enforcement\n\n${ENFORCE_USAGE}`, level: "error" };
        }
        kind = value;
        parts.splice(kindFlagIndex, 2);
    }
    const [idText, artifactInput] = parts;
    const memoryId = Number(idText);
    if (!Number.isSafeInteger(memoryId) || memoryId <= 0 || !artifactInput) {
        return { text: `## Claim Enforcement\n\n${ENFORCE_USAGE}`, level: "error" };
    }
    const target = resolveTarget(deps, memoryId);
    if ("error" in target) {
        return { text: `## Claim Enforcement — Failed\n\n${target.error}`, level: "error" };
    }
    if (currentApprovalActionId(deps.db, target.revisionId) == null) {
        return {
            text: `## Claim Enforcement — Failed\n\nRevision ${target.revisionId} is not approved; run /ctx-approve first.`,
            level: "error",
        };
    }
    const canonical = canonicalizeArtifactPath(deps.projectRoot, artifactInput);
    if ("error" in canonical) {
        return { text: `## Claim Enforcement — Failed\n\n${canonical.error}`, level: "error" };
    }

    let evaluation: ArtifactEvaluation | null = null;
    let bytesDigest = "";
    let enforced = false;
    let outcome: Awaited<
        ReturnType<typeof runConfirmedClaimMutation<{ artifactId: number; enforced: boolean }>>
    >;
    try {
        outcome = await runConfirmedClaimMutation(deps, {
            command: "ctx-enforce",
            argsKey: `${memoryId}:${canonical.canonicalPath}:${kind}`,
            target,
            producer: `claim-enforcement:${deps.host}`,
            operationKey: (nonce) => `enforce:${target.revisionId}:${nonce}`,
            request: (nonce) => ({
                revisionId: target.revisionId,
                digest: target.digest,
                canonicalPath: canonical.canonicalPath,
                kind,
                nonce,
            }),
            beforeMutate: async () => {
                // Evaluation happens outside the write transaction AND off
                // the event loop: the default evaluator runs a test process
                // with a 120-second budget, and holding BEGIN IMMEDIATE (or
                // the harness thread) that long would block every other
                // memory/claim/backfill writer and hook.
                const digestBefore = sha256Bytes(canonical.absolutePath);
                const evaluate = deps.evaluateArtifact ?? defaultEvaluateArtifact;
                evaluation = await evaluate(canonical.absolutePath, kind, deps.projectRoot);
                // The recorded digest must be the bytes the evaluator actually
                // ran: a concurrent rewrite between hash and evaluation would
                // otherwise bind a result to bytes that never passed (KTD6).
                bytesDigest = sha256Bytes(canonical.absolutePath);
                if (bytesDigest !== digestBefore) {
                    throw new Error("the artifact changed during evaluation; rerun the command");
                }
            },
            mutate: () => {
                const approvalId = currentApprovalActionId(deps.db, target.revisionId);
                if (approvalId == null) {
                    throw new Error("the approval was revoked since confirmation");
                }
                const subject = readPolicySubject(deps.db, target.revisionId);
                if (!subject) {
                    throw new Error("the revision has no policy subject yet; retry after seeding");
                }
                const evaluated = evaluation;
                if (!evaluated) throw new Error("artifact evaluation did not run");
                // Transactional recheck: the artifact bytes recorded must
                // still be the bytes the pre-transaction evaluation ran on.
                if (sha256Bytes(canonical.absolutePath) !== bytesDigest) {
                    throw new Error("the artifact changed since evaluation; rerun the command");
                }
                const artifactId = recordEnforcementArtifactInCurrentTransaction(deps.db, {
                    revisionId: target.revisionId,
                    projectId: target.projectId,
                    artifactKind: kind,
                    canonicalPath: canonical.canonicalPath,
                    bytesDigest,
                    evaluator: evaluated.evaluator,
                    evaluatorVersion: evaluated.evaluatorVersion,
                    evaluatorResult: evaluated.result,
                    nowMs: deps.nowMs,
                });
                if (evaluated.result === "pass") {
                    appendMaturityAssertionInCurrentTransaction(deps.db, {
                        revisionId: target.revisionId,
                        projectId: target.projectId,
                        maturity: "ENFORCED",
                        actor: `user-command:${deps.host}`,
                        approvalActionId: approvalId,
                        artifactId,
                        nowMs: deps.nowMs,
                    });
                    enforced = true;
                }
                refreshEffectivePolicyInCurrentTransaction(deps.db, target.revisionId, {
                    nowMs: deps.nowMs,
                });
                const effects: MemoryClaimEffect[] = [
                    {
                        effectKey: `policy:${target.revisionId}:enforcement`,
                        projectId: target.projectId,
                        claimId: target.claimId,
                        effectType: "lifecycle",
                    },
                ];
                return { result: { artifactId, enforced }, effects };
            },
        });
    } catch (error) {
        return {
            text: `## Claim Enforcement — Failed\n\n${error instanceof Error ? error.message : String(error)}`,
            level: "error",
        };
    }
    if (outcome.pending) {
        return {
            text: confirmationText(
                `/ctx-enforce ${memoryId} ${artifactInput}${kind === "test" ? "" : ` --kind ${kind}`}`,
                "Claim Enforcement",
                deps,
                target,
            ),
            level: "warning",
        };
    }
    enforced = outcome.result.enforced;
    if (!enforced) {
        const detail = (evaluation as ArtifactEvaluation | null)?.detail;
        return {
            text: [
                "## Claim Enforcement — Artifact Failed",
                "",
                `The ${kind} artifact \`${canonical.canonicalPath}\` did not pass; no ENFORCED decision was recorded.`,
                detail ? `\n\`\`\`\n${detail}\n\`\`\`` : "",
            ].join("\n"),
            level: "error",
        };
    }
    return {
        text: [
            "## Claim Enforcement — Recorded",
            "",
            `Revision ${target.revisionId} is ENFORCED by ${kind} artifact \`${canonical.canonicalPath}\` (bytes \`${bytesDigest.slice(0, 12)}…\`).`,
        ].join("\n"),
        level: "info",
    };
}
