/**
 * Host commands own claim approval and enforcement workflows.
 * OpenCode and Pi share the workflows.
 * The first invocation displays the owning project, exact revision, and content digest.
 * Repeating the same command within 60 seconds records one idempotent action.
 * Agent tool schemas cannot invoke either workflow.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Database } from "../../../shared/sqlite";
import type { EnforcementArtifactKind } from "../storage-claim-policy-schema";
import {
    type CanonicalJsonValue,
    type ClaimMutationToken,
    canonicalClaimMutationToken,
    computeClaimOperationRequestDigest,
    formatRevisionLocator,
    isValidPublicClaimId,
} from "./claim-operation-contract";
import {
    type ClaimEffectDescriptor,
    computeProjectMemoryMutationToken,
    getProjectMemoryClaimByPublicId,
    runClaimOperation,
    validateProjectMemoryMutationToken,
} from "./storage-claim-operations";
import {
    appendMaturityAssertionInCurrentTransaction,
    currentApprovalActionId,
    currentValidArtifactIds,
    readMaturityHead,
    readPolicySubject,
    recordApprovalActionInCurrentTransaction,
    recordEnforcementArtifactInCurrentTransaction,
    revokeEnforcementArtifactInCurrentTransaction,
} from "./storage-claim-policy";
import { resolveProjectId } from "./storage-claims";
import { isWithin, safeRealpath, sha256FileSync } from "./verification-paths";

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
    /** The default evaluator runs `bun test` for test artifacts and rejects other kinds.
     * The evaluator receives an absolute path to an immutable same-directory artifact snapshot.
     * */
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
    token: string;
    nonce: string;
}

const CONFIRMATION_WINDOW_MS = 60_000;
const pendingByKey = new Map<string, PendingConfirmation>();

export function clearClaimCommandConfirmationsForTests(): void {
    pendingByKey.clear();
}

interface ResolvedTarget {
    publicClaimId: string;
    claimId: number;
    projectId: number;
    currentRevisionId: number;
    revisionId: number;
    revision: number;
    revisionLocator: string;
    digest: string;
    mutationToken: ClaimMutationToken;
    preview: string;
}

function resolveTarget(
    deps: ClaimCommandDeps,
    publicClaimId: string,
): ResolvedTarget | { error: string } {
    if (!isValidPublicClaimId(publicClaimId)) {
        return { error: "The claim ID is malformed." };
    }
    const projectId = resolveProjectId(deps.db, deps.projectPath);
    const claim = getProjectMemoryClaimByPublicId(deps.db, publicClaimId);
    if (!claim || projectId === null || claim.projectId !== projectId) {
        return { error: "The claim does not belong to the active project." };
    }
    const preview = claim.content.length > 200 ? `${claim.content.slice(0, 200)}…` : claim.content;
    return {
        publicClaimId,
        claimId: claim.claimId,
        projectId,
        currentRevisionId: claim.currentRevisionId,
        revisionId: claim.currentRevisionId,
        revision: claim.revision,
        revisionLocator: formatRevisionLocator(claim),
        digest: claim.contentDigest,
        mutationToken: computeProjectMemoryMutationToken(deps.db, publicClaimId),
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
        `- Claim: \`${target.publicClaimId}\``,
        `- Revision: \`${target.revisionLocator}\``,
        `- Content digest: \`${target.digest}\``,
        "",
        `> ${target.preview.replaceAll("\n", "\n> ")}`,
        "",
        `**To confirm, run \`${command}\` again within 60 seconds.**`,
    ].join("\n");
}

interface ConfirmedMutationValue {
    payload: CanonicalJsonValue;
    effects: ClaimEffectDescriptor[];
    policyRevisionIds: number[];
}

interface ConfirmedMutationArgs<T> {
    command: "ctx-approve" | "ctx-enforce";
    argsKey: string;
    target: ResolvedTarget;
    producer: string;
    operationKey: (nonce: string) => string;
    request: (nonce: string) => CanonicalJsonValue;
    decode: (payload: CanonicalJsonValue | null) => T;
    beforeMutate?: () => void | Promise<void>;
    mutate: (nonce: string) => ConfirmedMutationValue;
}

async function runConfirmedClaimMutation<T>(
    deps: ClaimCommandDeps,
    args: ConfirmedMutationArgs<T>,
): Promise<{ pending: true } | { pending: false; result: T }> {
    const key = `${deps.host}:${deps.sessionId}:${args.command}`;
    const now = deps.nowMs ?? Date.now();
    for (const [staleKey, entry] of pendingByKey) {
        if (now - entry.timestamp >= CONFIRMATION_WINDOW_MS) pendingByKey.delete(staleKey);
    }
    const token = canonicalClaimMutationToken(args.target.mutationToken);
    const pendingBefore = pendingByKey.get(key);
    const confirmed =
        pendingBefore != null &&
        now - pendingBefore.timestamp < CONFIRMATION_WINDOW_MS &&
        pendingBefore.argsKey === args.argsKey &&
        pendingBefore.revisionId === args.target.currentRevisionId &&
        pendingBefore.digest === args.target.digest &&
        pendingBefore.token === token;
    if (!confirmed) {
        pendingByKey.set(key, {
            timestamp: now,
            argsKey: args.argsKey,
            revisionId: args.target.currentRevisionId,
            digest: args.target.digest,
            token,
            nonce: randomUUID(),
        });
        return { pending: true };
    }
    pendingByKey.delete(key);
    const nonce = pendingBefore.nonce;
    await args.beforeMutate?.();
    const operation = runClaimOperation(
        deps.db,
        {
            producer: args.producer,
            operationKey: args.operationKey(nonce),
            requestDigest: computeClaimOperationRequestDigest(args.request(nonce)),
        },
        () => {
            const current = resolveTarget(deps, args.target.publicClaimId);
            if ("error" in current) throw new Error(current.error);
            const validation = validateProjectMemoryMutationToken(
                deps.db,
                args.target.mutationToken,
            );
            if (
                !validation.ok ||
                current.currentRevisionId !== args.target.currentRevisionId ||
                current.revisionLocator !== args.target.revisionLocator ||
                current.digest !== args.target.digest
            ) {
                throw new Error("the claim changed since confirmation; rerun the command");
            }
            const value = args.mutate(nonce);
            return {
                kind: "effects",
                payload: value.payload,
                effects: value.effects,
                policyRevisionIds: value.policyRevisionIds,
            };
        },
        now,
    );
    return { pending: false, result: args.decode(operation.result.payload) };
}

const APPROVE_USAGE = [
    "Usage:",
    "- `/ctx-approve <public-claim-id>` — approve the exact current revision",
    "- `/ctx-approve <public-claim-id> --revoke` — revoke a recorded approval",
].join("\n");

export async function executeClaimApprovalCommand(
    deps: ClaimCommandDeps,
    argsText: string,
): Promise<ClaimCommandResult> {
    const parts = argsText.trim().split(/\s+/).filter(Boolean);
    const revoke = parts.includes("--revoke");
    const targetParts = parts.filter((part) => !part.startsWith("--"));
    const flagParts = parts.filter((part) => part.startsWith("--"));
    if (
        targetParts.length !== 1 ||
        flagParts.some((flag) => flag !== "--revoke") ||
        flagParts.length > 1 ||
        !isValidPublicClaimId(targetParts[0])
    ) {
        return { text: `## Claim Approval\n\n${APPROVE_USAGE}`, level: "error" };
    }
    const publicClaimId = targetParts[0];
    const target = resolveTarget(deps, publicClaimId);
    if ("error" in target) {
        return { text: `## Claim Approval — Failed\n\n${target.error}`, level: "error" };
    }
    const action = revoke ? "revoke" : "approve";
    const currentApproval = currentApprovalActionId(deps.db, target.revisionId);
    if (revoke && currentApproval == null) {
        return {
            text: `## Claim Approval — Failed\n\nRevision \`${target.revisionLocator}\` has no currently effective approval to revoke.`,
            level: "error",
        };
    }
    if (!revoke && currentApproval != null) {
        return {
            text: `## Claim Approval\n\nRevision \`${target.revisionLocator}\` is already approved.`,
            level: "info",
        };
    }
    let outcome: Awaited<ReturnType<typeof runConfirmedClaimMutation<null>>>;
    try {
        outcome = await runConfirmedClaimMutation(deps, {
            command: "ctx-approve",
            argsKey: `${action}:${publicClaimId}`,
            target,
            producer: `claim-approval:${deps.host}`,
            operationKey: (nonce) => `${action}:${publicClaimId}:r${target.revision}:${nonce}`,
            request: (nonce) => ({
                action,
                mutationToken: canonicalClaimMutationToken(target.mutationToken),
                nonce,
                revisionLocator: target.revisionLocator,
            }),
            decode: () => null,
            mutate: (nonce) => {
                const effectiveApprovalId = currentApprovalActionId(deps.db, target.revisionId);
                if (action === "approve" && effectiveApprovalId != null) {
                    throw new Error(
                        "the revision is already approved; another session may have recorded it first",
                    );
                }
                if (action === "revoke" && effectiveApprovalId == null) {
                    throw new Error(
                        "the revision has no active approval to revoke; another session may have revoked it first",
                    );
                }
                const actionOrdinal = Number(
                    (
                        deps.db
                            .prepare(
                                "SELECT COUNT(*) AS count FROM claim_approval_actions WHERE revision_id = ?",
                            )
                            .get(target.revisionId) as { count: number }
                    ).count,
                );
                const commandIdentity = `${action}:${target.revisionLocator}:${actionOrdinal}`;
                if (
                    deps.db
                        .prepare("SELECT 1 FROM claim_approval_actions WHERE command_identity = ?")
                        .get(commandIdentity)
                ) {
                    throw new Error(
                        "another session recorded this action first; rerun the command to view current state",
                    );
                }
                const recorded = recordApprovalActionInCurrentTransaction(deps.db, {
                    revisionId: target.revisionId,
                    projectId: target.projectId,
                    action,
                    host: deps.host,
                    sessionId: deps.sessionId,
                    userCommandEvent: `command:${deps.host}:ctx-approve:${nonce}`,
                    commandIdentity,
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
                return {
                    payload: { actionId: recorded.actionId },
                    effects: [
                        {
                            effectKey: `policy:${publicClaimId}:approval`,
                            projectId: target.projectId,
                            claimId: target.claimId,
                            revisionId: target.revisionId,
                            changeKind: "lifecycle",
                        },
                    ],
                    policyRevisionIds: [target.revisionId],
                };
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
                `/ctx-approve ${publicClaimId}${revoke ? " --revoke" : ""}`,
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
            `Revision \`${target.revisionLocator}\` is now ${revoke ? "no longer approved; effective maturity falls back to its supported rung" : `historically ${head?.maturity ?? "APPROVED"}`}.`,
        ].join("\n"),
        level: "info",
    };
}

const ENFORCE_USAGE = [
    "Usage:",
    "- `/ctx-enforce <public-claim-id> <artifact-path>` — bind a passing in-project test artifact",
    "- `/ctx-enforce <public-claim-id> <artifact-path> --kind test|policy|config`",
    "- `/ctx-enforce <public-claim-id> --revoke` — revoke every valid enforcement artifact",
    'Quote artifact paths that contain spaces: `/ctx-enforce mcm_<32hex> "tests/integration suite/policy.test.ts"`',
].join("\n");

/**
 * The parser preserves quoted artifact paths as one token and supports no escape syntax.
 * The parser removes quotes from tokens and supports no escape syntax.
 */
function tokenizeCommandArgs(text: string): string[] {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        tokens.push(match[1] ?? match[2] ?? match[3]);
    }
    return tokens;
}

/** The renderer re-quotes parsed tokens so copied confirmations preserve tokenization.
 * */
function quoteCommandArg(value: string): string {
    return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * The asynchronous child process prevents a slow or hanging test from blocking the host event loop.
 * */
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
        // The timeout kills the runner's process group so spawned test processes do not outlive the test.
        // advertised budget.
        const run = spawn("bun", ["test", snapshotPath], { cwd: projectRoot, detached: true });
        // The runner retains only diagnostic tails to bound memory used by noisy test output.
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
                    // If process-group termination is unavailable, the timeout kills the direct child process.
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

/**
 * The command accepts artifact paths only inside the owning project and rejects aliases, absolute paths, `..` escapes, and symlink escapes.
 * */
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

/** The evaluator re-resolves the live artifact path before evaluation and requires an in-project regular file.
 * The evaluator re-resolves the path because the artifact or a parent directory can become a symlink after parsing.
 * A replacement after path resolution could make later reads follow bytes outside the owning root.
 * Recording those bytes would grant ENFORCED authority outside the owning root. */
function requireArtifactStillBound(projectRoot: string, absolutePath: string): string {
    const rootReal = safeRealpath(resolve(projectRoot)) ?? resolve(projectRoot);
    const live = safeRealpath(absolutePath);
    let regularFile = false;
    try {
        regularFile = live !== null && statSync(live).isFile();
    } catch {
        regularFile = false;
    }
    if (live === null || !isWithin(rootReal, live) || !regularFile) {
        throw new Error(
            "the artifact path no longer identifies an in-project regular file; rerun the command",
        );
    }
    return live;
}

export async function executeClaimEnforceCommand(
    deps: ClaimCommandDeps,
    argsText: string,
): Promise<ClaimCommandResult> {
    const parts = tokenizeCommandArgs(argsText);
    // A mistyped flag must not silently select a different action.
    // `--revok` must not silently select a different action.
    // For `enforce`, treating an unrecognized flag as an artifact path would run a full evaluation.
    const unknownFlags = parts.filter(
        (part) => part.startsWith("--") && part !== "--revoke" && part !== "--kind",
    );
    if (unknownFlags.length > 0) {
        return { text: `## Claim Enforcement\n\n${ENFORCE_USAGE}`, level: "error" };
    }
    // The parser rejects duplicate flags and the `--revoke --kind` combination.
    // Duplicates would silently use the first `--kind` pair and ignore later arguments.
    // The parser rejects duplicate flags so later arguments cannot be silently ignored.
    if (
        parts.filter((part) => part === "--kind").length > 1 ||
        parts.filter((part) => part === "--revoke").length > 1 ||
        (parts.includes("--revoke") && parts.includes("--kind"))
    ) {
        return { text: `## Claim Enforcement\n\n${ENFORCE_USAGE}`, level: "error" };
    }
    if (parts.includes("--revoke")) {
        const targets = parts.filter((part) => !part.startsWith("--"));
        if (targets.length !== 1 || !isValidPublicClaimId(targets[0])) {
            return { text: `## Claim Enforcement\n\n${ENFORCE_USAGE}`, level: "error" };
        }
        const publicClaimId = targets[0];
        const revokeTarget = resolveTarget(deps, publicClaimId);
        if ("error" in revokeTarget) {
            return {
                text: `## Claim Enforcement — Failed\n\n${revokeTarget.error}`,
                level: "error",
            };
        }
        if (currentValidArtifactIds(deps.db, revokeTarget.revisionId).length === 0) {
            return {
                text: `## Claim Enforcement — Failed\n\nRevision \`${revokeTarget.revisionLocator}\` has no currently valid enforcement artifact to revoke.`,
                level: "error",
            };
        }
        let revokeOutcome: Awaited<
            ReturnType<typeof runConfirmedClaimMutation<{ revokedCount: number }>>
        >;
        try {
            revokeOutcome = await runConfirmedClaimMutation(deps, {
                command: "ctx-enforce",
                argsKey: `revoke:${publicClaimId}`,
                target: revokeTarget,
                producer: `claim-enforcement:${deps.host}`,
                operationKey: (nonce) =>
                    `enforce-revoke:${publicClaimId}:r${revokeTarget.revision}:${nonce}`,
                request: (nonce) => ({
                    action: "revoke-artifacts",
                    mutationToken: canonicalClaimMutationToken(revokeTarget.mutationToken),
                    nonce,
                    revisionLocator: revokeTarget.revisionLocator,
                }),
                decode: (payload) => {
                    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
                        throw new Error("stored enforcement revocation result is malformed");
                    }
                    const revokedCount = payload.revokedCount;
                    if (typeof revokedCount !== "number" || !Number.isSafeInteger(revokedCount)) {
                        throw new Error("stored enforcement revocation result is malformed");
                    }
                    return { revokedCount };
                },
                mutate: (nonce) => {
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
                    return {
                        payload: { revokedCount: liveArtifactIds.length },
                        effects: [
                            {
                                effectKey: `policy:${publicClaimId}:enforcement`,
                                projectId: revokeTarget.projectId,
                                claimId: revokeTarget.claimId,
                                revisionId: revokeTarget.revisionId,
                                changeKind: "lifecycle",
                            },
                        ],
                        policyRevisionIds: [revokeTarget.revisionId],
                    };
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
                    `/ctx-enforce ${publicClaimId} --revoke`,
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
                `Revoked ${revokeOutcome.result.revokedCount} enforcement artifact${revokeOutcome.result.revokedCount === 1 ? "" : "s"} for revision \`${revokeTarget.revisionLocator}\`. ENFORCED support must be re-earned with a fresh evaluation.`,
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
    // Without `deps.evaluateArtifact`, the command rejects `policy` and `config` before confirmation.
    // Without `deps.evaluateArtifact`, only `test` can succeed; reject `policy` and `config` before confirmation.
    if (kind !== "test" && !deps.evaluateArtifact) {
        return {
            text: `## Claim Enforcement — Unavailable\n\nArtifact kind '${kind}' has no evaluator on this host; only 'test' artifacts are supported.`,
            level: "error",
        };
    }
    const [publicClaimId, artifactInput] = parts;
    if (
        parts.length !== 2 ||
        !publicClaimId ||
        !isValidPublicClaimId(publicClaimId) ||
        !artifactInput
    ) {
        return { text: `## Claim Enforcement\n\n${ENFORCE_USAGE}`, level: "error" };
    }
    const target = resolveTarget(deps, publicClaimId);
    if ("error" in target) {
        return { text: `## Claim Enforcement — Failed\n\n${target.error}`, level: "error" };
    }
    if (currentApprovalActionId(deps.db, target.revisionId) == null) {
        return {
            text: `## Claim Enforcement — Failed\n\nRevision \`${target.revisionLocator}\` is not approved; run /ctx-approve first.`,
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
            argsKey: `${publicClaimId}:${canonical.canonicalPath}:${kind}`,
            target,
            producer: `claim-enforcement:${deps.host}`,
            operationKey: (nonce) => `enforce:${publicClaimId}:r${target.revision}:${nonce}`,
            request: (nonce) => ({
                canonicalPath: canonical.canonicalPath,
                kind,
                mutationToken: canonicalClaimMutationToken(target.mutationToken),
                nonce,
                revisionLocator: target.revisionLocator,
            }),
            decode: (payload) => {
                if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
                    throw new Error("stored enforcement result is malformed");
                }
                const artifactId = payload.artifactId;
                const wasEnforced = payload.enforced;
                if (
                    typeof artifactId !== "number" ||
                    !Number.isSafeInteger(artifactId) ||
                    typeof wasEnforced !== "boolean"
                ) {
                    throw new Error("stored enforcement result is malformed");
                }
                return { artifactId, enforced: wasEnforced };
            },
            beforeMutate: async () => {
                // Evaluation runs outside the write transaction so the evaluator's 120-second budget does not block writers.
                //
                // The evaluator runs an immutable snapshot because endpoint hashing cannot detect a replace-then-restore during evaluation.
                // The snapshot sits next to the artifact so relative imports resolve from the artifact's directory.
                // The snapshot digest records the bytes that ran.
                // recorded.
                const liveBeforeRun = requireArtifactStillBound(
                    deps.projectRoot,
                    canonical.absolutePath,
                );
                const bytes = readFileSync(liveBeforeRun);
                bytesDigest = createHash("sha256").update(bytes).digest("hex");
                const snapshotName = `mc-enforce-${randomUUID().slice(0, 8)}.${basename(canonical.absolutePath)}`;
                const snapshotPath = join(dirname(canonical.absolutePath), snapshotName);
                // Bun keys snapshots by test-file name, so the copy carries the artifact's committed `.snap` under the copied test file's name; otherwise, Bun treats it as missing.
                const snapDir = join(dirname(canonical.absolutePath), "__snapshots__");
                const committedSnap = join(snapDir, `${basename(canonical.absolutePath)}.snap`);
                const copiedSnap = join(snapDir, `${snapshotName}.snap`);
                const carrySnapshots = existsSync(committedSnap);
                // `wx` prevents overwriting a pre-existing nonce path.
                // The post-run digest rejects a changed evaluation snapshot.
                // The snapshot write and carried-copy setup run inside `try` so cleanup removes a created snapshot if either operation fails.
                // execute it.
                let snapshotCreated = false;
                try {
                    writeFileSync(snapshotPath, bytes, { flag: "wx", mode: 0o444 });
                    snapshotCreated = true;
                    if (carrySnapshots) copyFileSync(committedSnap, copiedSnap);
                    const evaluate = deps.evaluateArtifact ?? defaultEvaluateArtifact;
                    evaluation = await evaluate(snapshotPath, kind, deps.projectRoot);
                    if (sha256FileSync(snapshotPath) !== bytesDigest) {
                        throw new Error(
                            "the evaluation snapshot changed during the run; rerun the command",
                        );
                    }
                } finally {
                    // `snapshotCreated` remains false when `wx` rejects an existing path, so cleanup does not delete that path.
                    if (snapshotCreated) {
                        rmSync(snapshotPath, { force: true });
                        // Cleanup removes `copiedSnap`, including a snapshot created under that name by the run.
                        rmSync(copiedSnap, { force: true });
                    }
                }
                // disk.
                if (
                    sha256FileSync(
                        requireArtifactStillBound(deps.projectRoot, canonical.absolutePath),
                    ) !== bytesDigest
                ) {
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
                if (
                    sha256FileSync(
                        requireArtifactStillBound(deps.projectRoot, canonical.absolutePath),
                    ) !== bytesDigest
                ) {
                    throw new Error("the artifact changed since evaluation; rerun the command");
                }
                const artifactId = recordEnforcementArtifactInCurrentTransaction(deps.db, {
                    revisionId: target.revisionId,
                    projectId: target.projectId,
                    artifactKind: kind,
                    canonicalPath: canonical.canonicalPath,
                    bytesDigest,
                    enforcedFromRoot:
                        safeRealpath(resolve(deps.projectRoot)) ?? resolve(deps.projectRoot),
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
                return {
                    payload: { artifactId, enforced },
                    effects: [
                        {
                            effectKey: `policy:${publicClaimId}:enforcement`,
                            projectId: target.projectId,
                            claimId: target.claimId,
                            revisionId: target.revisionId,
                            changeKind: "lifecycle",
                        },
                    ],
                    policyRevisionIds: [target.revisionId],
                };
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
                `/ctx-enforce ${publicClaimId} ${quoteCommandArg(artifactInput)}${kind === "test" ? "" : ` --kind ${kind}`}`,
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
            `Revision \`${target.revisionLocator}\` is ENFORCED by ${kind} artifact \`${canonical.canonicalPath}\` (bytes \`${bytesDigest.slice(0, 12)}…\`).`,
        ].join("\n"),
        level: "info",
    };
}
