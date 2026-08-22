/**
 * Host-owned claim approval and enforcement command workflows shared by the
 * OpenCode and Pi harnesses (KD1; KTD5-KTD6). Two-step stale-safe
 * confirmation: the first invocation shows the owning project, exact
 * revision, and content digest; repeating the same command within the window
 * records exactly one idempotent action. Neither workflow is reachable from
 * any agent tool schema.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Database } from "../../../shared/sqlite";
import type { EnforcementArtifactKind } from "../storage-claim-policy-schema";
import { bumpProjectMemoryEpoch } from "../storage-project-state";
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
    evaluateArtifact?: (canonicalPath: string, kind: EnforcementArtifactKind) => ArtifactEvaluation;
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

function confirmationKey(deps: ClaimCommandDeps, command: string): string {
    return `${deps.host}:${deps.sessionId}:${command}`;
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
    const row = deps.db
        .prepare("SELECT project_path AS projectPath FROM memories WHERE id = ?")
        .get(memoryId) as { projectPath: string } | null | undefined;
    if (!row || row.projectPath !== deps.projectPath) {
        return { error: `Memory ${memoryId} does not belong to the active project.` };
    }
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

function takeConfirmedNonce(
    deps: ClaimCommandDeps,
    command: string,
    argsKey: string,
    target: ResolvedTarget,
): string | null {
    const key = confirmationKey(deps, command);
    const pending = pendingByKey.get(key);
    const now = deps.nowMs ?? Date.now();
    if (
        pending &&
        now - pending.timestamp < CONFIRMATION_WINDOW_MS &&
        pending.argsKey === argsKey &&
        pending.revisionId === target.revisionId &&
        pending.digest === target.digest
    ) {
        pendingByKey.delete(key);
        return pending.nonce;
    }
    pendingByKey.set(key, {
        timestamp: now,
        argsKey,
        revisionId: target.revisionId,
        digest: target.digest,
        nonce: randomUUID(),
    });
    return null;
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
        "> " + target.preview.replaceAll("\n", "\n> "),
        "",
        `**To confirm, run \`${command}\` again within 60 seconds.**`,
    ].join("\n");
}

const APPROVE_USAGE = [
    "Usage:",
    "- `/ctx-approve <memory-id>` — approve the exact current revision",
    "- `/ctx-approve <memory-id> --revoke` — revoke a recorded approval",
].join("\n");

export function executeClaimApprovalCommand(
    deps: ClaimCommandDeps,
    argsText: string,
): ClaimCommandResult {
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
    const nonce = takeConfirmedNonce(deps, "ctx-approve", `${action}:${memoryId}`, target);
    if (nonce === null) {
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

    const operationKey = `${action}:${target.revisionId}:${nonce}`;
    const request = { action, revisionId: target.revisionId, digest: target.digest, nonce };
    runInMemoryClaimsWriteTransaction(deps.db, () =>
        withMemoryClaimGenerationContextInCurrentTransaction(deps.db, () =>
            runMemoryClaimOperationInCurrentTransaction(
                deps.db,
                {
                    producer: `claim-approval:${deps.host}`,
                    operationKey,
                    requestDigest: sha256Utf8Hex(JSON.stringify(request)),
                },
                () => {
                    // Stale-safe recheck inside the write transaction (R10).
                    const current = resolveTarget(deps, memoryId);
                    if ("error" in current) throw new Error(current.error);
                    if (
                        current.revisionId !== target.revisionId ||
                        current.digest !== target.digest
                    ) {
                        throw new Error("the memory changed since confirmation; rerun the command");
                    }
                    const recorded = recordApprovalActionInCurrentTransaction(deps.db, {
                        revisionId: target.revisionId,
                        projectId: target.projectId,
                        action,
                        host: deps.host,
                        sessionId: deps.sessionId,
                        userCommandEvent: `command:${deps.host}:ctx-approve:${nonce}`,
                        commandIdentity: operationKey,
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
            ),
        ),
    );
    // A policy transition changes automatic visibility: force project-memory
    // rematerialization so no stale m0 cache keeps serving the old decision.
    bumpProjectMemoryEpoch(deps.db, deps.projectPath, deps.nowMs);
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
 * artifact evaluators plug in through `deps.evaluateArtifact` when needed. */
function defaultEvaluateArtifact(
    canonicalPath: string,
    kind: EnforcementArtifactKind,
): ArtifactEvaluation {
    if (kind !== "test") {
        return {
            result: "fail",
            evaluator: "unsupported",
            evaluatorVersion: "1",
            detail: `No default evaluator for artifact kind '${kind}'.`,
        };
    }
    const run = spawnSync("bun", ["test", canonicalPath], {
        timeout: 120_000,
        encoding: "utf8",
    });
    return {
        result: run.status === 0 ? "pass" : "fail",
        evaluator: "bun-test",
        evaluatorVersion: "1",
        detail: run.status === 0 ? undefined : (run.stderr || run.stdout || "").slice(-500),
    };
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

export function executeClaimEnforceCommand(
    deps: ClaimCommandDeps,
    argsText: string,
): ClaimCommandResult {
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
    const nonce = takeConfirmedNonce(
        deps,
        "ctx-enforce",
        `${memoryId}:${canonical.canonicalPath}:${kind}`,
        target,
    );
    if (nonce === null) {
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

    const bytes = readFileSync(canonical.absolutePath);
    const bytesDigest = createHash("sha256").update(bytes).digest("hex");
    const evaluate = deps.evaluateArtifact ?? defaultEvaluateArtifact;
    const evaluation = evaluate(canonical.absolutePath, kind);

    const operationKey = `enforce:${target.revisionId}:${nonce}`;
    const request = {
        revisionId: target.revisionId,
        digest: target.digest,
        bytesDigest,
        canonicalPath: canonical.canonicalPath,
        kind,
        nonce,
    };
    let enforced = false;
    runInMemoryClaimsWriteTransaction(deps.db, () =>
        withMemoryClaimGenerationContextInCurrentTransaction(deps.db, () =>
            runMemoryClaimOperationInCurrentTransaction(
                deps.db,
                {
                    producer: `claim-enforcement:${deps.host}`,
                    operationKey,
                    requestDigest: sha256Utf8Hex(JSON.stringify(request)),
                },
                () => {
                    const current = resolveTarget(deps, memoryId);
                    if ("error" in current) throw new Error(current.error);
                    if (
                        current.revisionId !== target.revisionId ||
                        current.digest !== target.digest
                    ) {
                        throw new Error("the memory changed since confirmation; rerun the command");
                    }
                    const approvalId = currentApprovalActionId(deps.db, target.revisionId);
                    if (approvalId == null) {
                        throw new Error("the approval was revoked since confirmation");
                    }
                    const subject = readPolicySubject(deps.db, target.revisionId);
                    if (!subject) {
                        throw new Error(
                            "the revision has no policy subject yet; retry after seeding",
                        );
                    }
                    const artifactId = recordEnforcementArtifactInCurrentTransaction(deps.db, {
                        revisionId: target.revisionId,
                        projectId: target.projectId,
                        artifactKind: kind,
                        canonicalPath: canonical.canonicalPath,
                        bytesDigest,
                        evaluator: evaluation.evaluator,
                        evaluatorVersion: evaluation.evaluatorVersion,
                        evaluatorResult: evaluation.result,
                        nowMs: deps.nowMs,
                    });
                    if (evaluation.result === "pass") {
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
            ),
        ),
    );
    bumpProjectMemoryEpoch(deps.db, deps.projectPath, deps.nowMs);
    if (!enforced) {
        return {
            text: [
                "## Claim Enforcement — Artifact Failed",
                "",
                `The ${kind} artifact \`${canonical.canonicalPath}\` did not pass; no ENFORCED decision was recorded.`,
                evaluation.detail ? `\n\`\`\`\n${evaluation.detail}\n\`\`\`` : "",
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
