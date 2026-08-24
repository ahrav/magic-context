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
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Database } from "../../../shared/sqlite";
import { getAuthorityManagedMarker } from "../context-authority";
import type { EnforcementArtifactKind } from "../storage-claim-policy-schema";
import {
    appendMaturityAssertionInCurrentTransaction,
    currentApprovalActionId,
    currentValidArtifactIds,
    readMaturityHead,
    readPolicySubject,
    recordApprovalActionInCurrentTransaction,
    recordEnforcementArtifactInCurrentTransaction,
    refreshEffectivePolicyInCurrentTransaction,
    revokeEnforcementArtifactInCurrentTransaction,
} from "./storage-claim-policy";
import { sha256Utf8Hex } from "./storage-claims";
import {
    bumpEpochForClaimProjectInCurrentTransaction,
    type MemoryClaimEffect,
    readMemoryClaimLink,
    resolveMemoryClaimProjectInCurrentTransaction,
    runInMemoryClaimsWriteTransaction,
    runMemoryClaimOperationInCurrentTransaction,
    withMemoryClaimGenerationContextInCurrentTransaction,
} from "./storage-memory-claims";
import { isWithin, safeRealpath } from "./verification-paths";

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
     * artifacts and rejects other kinds. Receives the absolute path of an
     * immutable same-directory snapshot of the artifact, not the live
     * artifact path (KTD6). */
    evaluateArtifact?: (
        snapshotPath: string,
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

/** Translate an agent-visible memory id into context row space. Under
 * MODULE memory authority the ids the agent sees are the native store's row
 * ids, and mirror-back may map a module id to a DIFFERENT context row
 * (collision renumbering, module-created rows). Runs ONCE at command entry:
 * `resolveTarget` itself stays context-space pure, so the confirmation-time
 * recheck can re-resolve an already-translated id without a second mapping
 * pass redirecting it to an unrelated row. */
function translateAgentVisibleMemoryId(deps: ClaimCommandDeps, memoryId: number): number {
    if (!getAuthorityManagedMarker(deps.db, deps.projectPath)) return memoryId;
    const mapped = deps.db
        .prepare(
            `SELECT context_row_id AS contextRowId FROM mirror_identity
              WHERE domain = 'memories' AND module_project = ? AND module_row_id = ?`,
        )
        .get(deps.projectPath, memoryId) as { contextRowId?: number } | null | undefined;
    if (mapped != null && Number.isInteger(mapped.contextRowId)) {
        return mapped.contextRowId as number;
    }
    return memoryId;
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
 * and bumps the claim project's memory epoch — across every identity
 * attached to the project, canonical and aliases alike — in the same
 * transaction so no stale m0
 * cache keeps serving the old decision (R27).
 */
async function runConfirmedClaimMutation<T>(
    deps: ClaimCommandDeps,
    args: ConfirmedMutationArgs<T>,
): Promise<{ pending: true } | { pending: false; result: T }> {
    const key = `${deps.host}:${deps.sessionId}:${args.command}`;
    const now = deps.nowMs ?? Date.now();
    // Opportunistic eviction: an abandoned confirmation (started, never
    // repeated) is otherwise only removed by a successful repeat, so a
    // long-lived host would retain an entry per abandoned session forever.
    // The map stays small (two commands per active session), so a full sweep
    // on each command invocation is cheap.
    for (const [staleKey, entry] of pendingByKey) {
        if (now - entry.timestamp >= CONFIRMATION_WINDOW_MS) pendingByKey.delete(staleKey);
    }
    const pendingBefore = pendingByKey.get(key);
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
            bumpEpochForClaimProjectInCurrentTransaction(deps.db, args.target.claimId);
            return operation;
        }),
    );
    return { pending: false, result: outcome.result };
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
    // Strict argument validation: a mistyped flag (`--revok`) must not
    // silently select the OPPOSITE authority action, and a repeat within the
    // confirmation window would then commit it. Exactly one id, and the only
    // supported flag is --revoke.
    const idParts = parts.filter((part) => !part.startsWith("--"));
    const flagParts = parts.filter((part) => part.startsWith("--"));
    if (
        idParts.length !== 1 ||
        flagParts.some((flag) => flag !== "--revoke") ||
        flagParts.length > 1
    ) {
        return { text: `## Claim Approval\n\n${APPROVE_USAGE}`, level: "error" };
    }
    const memoryId = Number(idParts[0]);
    if (!Number.isSafeInteger(memoryId) || memoryId <= 0) {
        return { text: `## Claim Approval\n\n${APPROVE_USAGE}`, level: "error" };
    }
    const target = resolveTarget(deps, translateAgentVisibleMemoryId(deps, memoryId));
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
    "- `/ctx-enforce <memory-id> --revoke` — revoke every valid enforcement artifact",
    'Quote artifact paths that contain spaces: `/ctx-enforce 12 "tests/integration suite/policy.test.ts"`',
].join("\n");

/**
 * Split command arguments on whitespace while honoring double- and
 * single-quoted segments, so an artifact path containing spaces survives as
 * one token. Quotes are removed from the token; there is no escape syntax.
 */
function tokenizeCommandArgs(text: string): string[] {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        tokens.push(match[1] ?? match[2] ?? match[3]);
    }
    return tokens;
}

/** Re-quote a parsed token for a rendered command so copying the generated
 * confirmation reproduces the same tokenization. */
function quoteCommandArg(value: string): string {
    return /\s/.test(value) ? `"${value}"` : value;
}

/** ponytail: the default evaluator only knows `bun test`; policy/config
 * artifact evaluators plug in through `deps.evaluateArtifact` when needed.
 * The child process runs detached from the event loop so a slow or hanging
 * test cannot freeze the host that serves every other hook and transform. */
function defaultEvaluateArtifact(
    snapshotPath: string,
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
        // `detached` puts the runner at the head of its own process group so
        // the timeout can kill the whole tree: a test that spawns servers,
        // watchers, or shell children must not leave them running — holding
        // inherited output descriptors and mutating the project — past the
        // advertised budget.
        const run = spawn("bun", ["test", snapshotPath], { cwd: projectRoot, detached: true });
        // Only the diagnostic tail is ever surfaced; retaining full streams
        // for a noisy 120-second run would grow the shared plugin process
        // without bound.
        const OUTPUT_TAIL_CHARS = 4_096;
        let output = "";
        const appendTail = (chunk: Buffer) => {
            output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
        };
        run.stdout.on("data", appendTail);
        run.stderr.on("data", appendTail);
        const timer = setTimeout(() => {
            if (run.pid != null) {
                try {
                    process.kill(-run.pid, "SIGKILL");
                    return;
                } catch {
                    // Group already gone or unsupported: fall back to the
                    // direct child below.
                }
            }
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
 * inputs, `..` escapes, and symlink escapes are rejected (KTD6). Escape
 * checking reuses the shared predicates in `verification-paths.ts`. */
function canonicalizeArtifactPath(
    projectRoot: string,
    input: string,
): { canonicalPath: string; absolutePath: string } | { error: string } {
    if (isAbsolute(input)) return { error: "Artifact paths must be project-relative." };
    const rootReal = safeRealpath(resolve(projectRoot)) ?? resolve(projectRoot);
    const absolute = resolve(rootReal, input);
    const real = safeRealpath(absolute);
    if (real === null) {
        return { error: `Artifact not found: ${input}` };
    }
    if (!isWithin(rootReal, real)) {
        return { error: "Artifact path escapes the owning project." };
    }
    if (!statSync(real).isFile()) return { error: "Artifact must be a regular file." };
    return { canonicalPath: relative(rootReal, real).split(sep).join("/"), absolutePath: real };
}

function sha256Bytes(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function executeClaimEnforceCommand(
    deps: ClaimCommandDeps,
    argsText: string,
): Promise<ClaimCommandResult> {
    const parts = tokenizeCommandArgs(argsText);
    // Strict flag validation, mirroring /ctx-approve: a mistyped flag
    // (`--revok`) must not silently select a different action — for enforce
    // it would run a full evaluation treating the flag as a path argument.
    // Supported flags: --revoke (revocation) and --kind <value> (artifact
    // kind, value validated by the parser below).
    const unknownFlags = parts.filter(
        (part) => part.startsWith("--") && part !== "--revoke" && part !== "--kind",
    );
    if (unknownFlags.length > 0) {
        return { text: `## Claim Enforcement\n\n${ENFORCE_USAGE}`, level: "error" };
    }
    // At most one occurrence of each flag, and --revoke and --kind never
    // combine: duplicates would silently use the FIRST --kind pair and
    // ignore the rest, committing arguments the user did not confirm.
    if (
        parts.filter((part) => part === "--kind").length > 1 ||
        parts.filter((part) => part === "--revoke").length > 1 ||
        (parts.includes("--revoke") && parts.includes("--kind"))
    ) {
        return { text: `## Claim Enforcement\n\n${ENFORCE_USAGE}`, level: "error" };
    }
    // Artifact revocation is the compromise-response path (KTD6): a revoked
    // approval alone only lowers maturity until the next approval, because
    // supportedMaturity would reuse the still-valid artifact and restore
    // ENFORCED. Revoking covers every valid artifact for the revision so the
    // rung must be re-earned with a fresh evaluation.
    if (parts.includes("--revoke")) {
        const revokeIds = parts.filter((part) => !part.startsWith("--"));
        const revokeMemoryId = revokeIds.length === 1 ? Number(revokeIds[0]) : Number.NaN;
        if (!Number.isSafeInteger(revokeMemoryId) || revokeMemoryId <= 0) {
            return { text: `## Claim Enforcement\n\n${ENFORCE_USAGE}`, level: "error" };
        }
        const revokeTarget = resolveTarget(
            deps,
            translateAgentVisibleMemoryId(deps, revokeMemoryId),
        );
        if ("error" in revokeTarget) {
            return {
                text: `## Claim Enforcement — Failed\n\n${revokeTarget.error}`,
                level: "error",
            };
        }
        const artifactIds = currentValidArtifactIds(deps.db, revokeTarget.revisionId);
        if (artifactIds.length === 0) {
            return {
                text: `## Claim Enforcement — Failed\n\nRevision ${revokeTarget.revisionId} has no currently valid enforcement artifact to revoke.`,
                level: "error",
            };
        }
        let revokeOutcome: Awaited<
            ReturnType<typeof runConfirmedClaimMutation<{ revokedCount: number }>>
        >;
        try {
            revokeOutcome = await runConfirmedClaimMutation(deps, {
                command: "ctx-enforce",
                argsKey: `revoke:${revokeMemoryId}`,
                target: revokeTarget,
                producer: `claim-enforcement:${deps.host}`,
                operationKey: (nonce) => `enforce-revoke:${revokeTarget.revisionId}:${nonce}`,
                request: (nonce) => ({
                    action: "revoke-artifacts",
                    revisionId: revokeTarget.revisionId,
                    digest: revokeTarget.digest,
                    nonce,
                }),
                mutate: (nonce) => {
                    // Re-read inside the transaction: the confirmation window
                    // is not a lock, and an artifact recorded between the two
                    // steps must be revoked with the rest.
                    const liveArtifactIds = currentValidArtifactIds(
                        deps.db,
                        revokeTarget.revisionId,
                    );
                    for (const artifactId of liveArtifactIds) {
                        revokeEnforcementArtifactInCurrentTransaction(
                            deps.db,
                            artifactId,
                            `user-command:${deps.host}:ctx-enforce-revoke:${nonce}`,
                            deps.nowMs,
                        );
                    }
                    refreshEffectivePolicyInCurrentTransaction(deps.db, revokeTarget.revisionId, {
                        nowMs: deps.nowMs,
                    });
                    const effects: MemoryClaimEffect[] = [
                        {
                            effectKey: `policy:${revokeTarget.revisionId}:enforcement`,
                            projectId: revokeTarget.projectId,
                            claimId: revokeTarget.claimId,
                            effectType: "lifecycle",
                        },
                    ];
                    return { result: { revokedCount: liveArtifactIds.length }, effects };
                },
            });
        } catch (error) {
            return {
                text: `## Claim Enforcement — Failed\n\n${error instanceof Error ? error.message : String(error)}`,
                level: "error",
            };
        }
        if (revokeOutcome.pending) {
            return {
                text: confirmationText(
                    `/ctx-enforce ${revokeMemoryId} --revoke`,
                    "Enforcement Revocation",
                    deps,
                    revokeTarget,
                ),
                level: "warning",
            };
        }
        return {
            text: [
                "## Claim Enforcement — Revoked",
                "",
                `Revoked ${revokeOutcome.result.revokedCount} enforcement artifact${revokeOutcome.result.revokedCount === 1 ? "" : "s"} for revision ${revokeTarget.revisionId} (digest \`${revokeTarget.digest.slice(0, 12)}…\`). ENFORCED support must be re-earned with a fresh evaluation.`,
            ].join("\n"),
            level: "info",
        };
    }
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
    // The default evaluator only knows `test`; without a host-supplied
    // evaluator, a policy/config confirmation would walk the two-step flow
    // and then always fail. Refuse up front instead of advertising a mode
    // that cannot succeed.
    if (kind !== "test" && !deps.evaluateArtifact) {
        return {
            text: `## Claim Enforcement — Unavailable\n\nArtifact kind '${kind}' has no evaluator on this host; only 'test' artifacts are supported.`,
            level: "error",
        };
    }
    const [idText, artifactInput] = parts;
    const memoryId = Number(idText);
    // Exactly two positional arguments (id and path): extra tokens would be
    // silently ignored, committing arguments the user did not confirm.
    if (parts.length !== 2 || !Number.isSafeInteger(memoryId) || memoryId <= 0 || !artifactInput) {
        return { text: `## Claim Enforcement\n\n${ENFORCE_USAGE}`, level: "error" };
    }
    const target = resolveTarget(deps, translateAgentVisibleMemoryId(deps, memoryId));
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
                //
                // The evaluator runs an immutable snapshot, never the live
                // path: endpoint hashing alone cannot see a
                // replace-then-restore during the run, which would bind a
                // pass to bytes that were never evaluated (KTD6). The
                // snapshot sits next to the artifact so relative imports and
                // test-runner naming rules resolve identically, and its
                // digest — the bytes that provably ran — is the digest
                // recorded.
                const bytes = readFileSync(canonical.absolutePath);
                bytesDigest = createHash("sha256").update(bytes).digest("hex");
                const snapshotName = `mc-enforce-${randomUUID().slice(0, 8)}.${basename(canonical.absolutePath)}`;
                const snapshotPath = join(dirname(canonical.absolutePath), snapshotName);
                // Bun keys test snapshots by the test file's name, so the
                // copy must carry the artifact's committed `.snap` under its
                // own name — otherwise every committed snapshot reads as
                // newly added and the run passes without comparing (KTD6).
                const snapDir = join(dirname(canonical.absolutePath), "__snapshots__");
                const committedSnap = join(snapDir, `${basename(canonical.absolutePath)}.snap`);
                const copiedSnap = join(snapDir, `${snapshotName}.snap`);
                const carrySnapshots = existsSync(committedSnap);
                // `wx` refuses a pre-existing path (a planted file or symlink
                // under the nonce name), and read-only mode plus the
                // post-run digest re-check below raise the bar against a
                // watcher process replacing the snapshot around the run.
                // This is hardening, not proof: a local adversary with
                // project-directory write access sits in the same trust
                // domain as the artifact and the database themselves.
                // The snapshot write and the carried-copy setup run INSIDE
                // the cleanup region: a failing copy (read-only or removed
                // __snapshots__, full disk) must not strand the read-only
                // mc-enforce-* test where broad test discovery would later
                // execute it.
                let snapshotCreated = false;
                try {
                    writeFileSync(snapshotPath, bytes, { flag: "wx", mode: 0o444 });
                    snapshotCreated = true;
                    if (carrySnapshots) copyFileSync(committedSnap, copiedSnap);
                    const evaluate = deps.evaluateArtifact ?? defaultEvaluateArtifact;
                    evaluation = await evaluate(snapshotPath, kind, deps.projectRoot);
                    // The recorded digest must describe the bytes the
                    // evaluator ran: a snapshot replaced during the run
                    // cannot be recorded.
                    if (sha256Bytes(snapshotPath) !== bytesDigest) {
                        throw new Error(
                            "the evaluation snapshot changed during the run; rerun the command",
                        );
                    }
                } finally {
                    // Remove nothing when the `wx` create itself refused: the
                    // pre-existing path was not ours to delete.
                    if (snapshotCreated) {
                        rmSync(snapshotPath, { force: true });
                        // Remove the carried copy AND any snapshot the run
                        // created fresh under the copy's name.
                        rmSync(copiedSnap, { force: true });
                    }
                }
                // A live artifact that drifted during the run cannot be
                // recorded: the digest would describe bytes no longer on
                // disk.
                if (sha256Bytes(canonical.absolutePath) !== bytesDigest) {
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
                    // Revalidation only rehashes from this checkout: clones
                    // and worktrees share the project identity, and another
                    // checkout legitimately lacks the same relative path.
                    enforcedFromRoot: deps.projectRoot,
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
                `/ctx-enforce ${memoryId} ${quoteCommandArg(artifactInput)}${kind === "test" ? "" : ` --kind ${kind}`}`,
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
