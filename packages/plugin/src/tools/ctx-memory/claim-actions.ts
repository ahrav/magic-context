import type { Database } from "../../shared/sqlite";
import {
    type CanonicalJsonValue,
    canonicalJsonEncode,
    canonicalClaimMutationToken,
    type ClaimMutationToken,
    parseRevisionLocator,
} from "../../features/magic-context/memory/claim-operation-contract";
import {
    type ClaimOperationRunResult,
    type ProducerIdentity,
    ClaimOperationInputError,
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
    mergeProjectMemoryClaims,
    reviseProjectMemoryClaim,
    setProjectMemoryClaimLifecycle,
} from "../../features/magic-context/memory/storage-claim-operations";
import {
    type ProjectMemoryClaimSnapshot,
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../../features/magic-context/memory/storage-claim-current-state";
import { ensureProject } from "../../features/magic-context/memory/storage-claims";
import {
    computeWorkspaceEpochFingerprint,
    expandWorkspaceIdentitySetWithAliases,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
} from "../../features/magic-context/workspaces";
import { DEFAULT_SEARCH_LIMIT, GET_MAX_CLAIMS } from "./constants";
import type { CtxMemoryAction, CtxMemoryArgs } from "./types";

export type CtxMemoryHarness = "opencode" | "pi";

export interface CtxMemoryCallIdentity {
    harness: CtxMemoryHarness;
    sessionId: string;
    toolCallId: string;
}

/** Tool-call identity is the durable operation key; actions add no live-row suffix. */
export function createCtxMemoryProducerIdentity(
    identity: CtxMemoryCallIdentity,
): ProducerIdentity {
    const sessionId = identity.sessionId.trim();
    const toolCallId = identity.toolCallId.trim();
    if (!sessionId || !toolCallId) {
        throw new ClaimOperationInputError(
            "ctx_memory mutations require stable session and tool-call identities",
        );
    }
    return {
        producer: "ctx-memory-agent-v1",
        operationKey: `${identity.harness}:${sessionId}:${toolCallId}`,
    };
}

export interface ExecuteCtxMemoryClaimActionArgs {
    db: Database;
    args: CtxMemoryArgs;
    projectIdentity: string;
    identity: CtxMemoryCallIdentity;
    actor: string;
}

interface WorkspaceReadScope {
    projectIds: number[];
    ownProjectIds: number[];
    sharedCategories: string[];
    workspaceEpoch: string;
}

function workspaceReadScope(db: Database, projectIdentity: string): WorkspaceReadScope {
    const workspace = resolveWorkspaceIdentitySet(db, projectIdentity);
    const expanded = expandWorkspaceIdentitySetWithAliases(db, workspace.identities);
    const isWorkspaced = workspace.identities.length > 1;
    const authorizedIdentities = isWorkspaced
        ? expanded.expandedIdentities
        : workspace.identities;
    const ownIdentities = authorizedIdentities.filter(
        (identity) =>
            (expanded.canonicalIdentityByStoredPath.get(identity) ?? identity) === projectIdentity,
    );
    return {
        projectIds: resolveProjectIdsForIdentities(db, authorizedIdentities),
        ownProjectIds: resolveProjectIdsForIdentities(
            db,
            ownIdentities.length > 0 ? ownIdentities : [projectIdentity],
        ),
        sharedCategories: isWorkspaced
            ? (resolveWorkspaceShareCategories(db, projectIdentity) ?? [])
            : [],
        workspaceEpoch: computeWorkspaceEpochFingerprint(db, workspace.identities),
    };
}

function readClaims(
    db: Database,
    request: Parameters<typeof readProjectMemoryCurrentState>[1],
): ProjectMemoryClaimSnapshot[] {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = readProjectMemoryCurrentState(db, request);
        if (result.status === "ok") return result.items;
    }
    throw new Error("claim state changed while reading; retry the tool call");
}

function normalizeLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
    return Math.max(1, Math.min(100, Math.floor(limit)));
}

function uniquePublicClaimIds(ids: readonly string[] | undefined): string[] {
    return [...new Set(ids ?? [])];
}

function requireSingleMutationTarget(args: CtxMemoryArgs): {
    publicClaimId: string;
    token: ClaimMutationToken;
} {
    if (!args.publicClaimId || !args.mutationToken) {
        throw new ClaimOperationInputError(
            `'publicClaimId' and 'mutationToken' are required when action is '${String(args.action)}'`,
        );
    }
    if (args.publicClaimId !== args.mutationToken.publicClaimId) {
        throw new ClaimOperationInputError("publicClaimId does not match mutationToken");
    }
    return { publicClaimId: args.publicClaimId, token: args.mutationToken };
}

function hasOperationReceipt(db: Database, producer: ProducerIdentity): boolean {
    return (
        db
            .prepare(
                "SELECT 1 FROM claim_operation_receipts WHERE producer = ? AND operation_key = ?",
            )
            .get(producer.producer, producer.operationKey) != null
    );
}

function authorizeOwnClaims(
    db: Database,
    publicClaimIds: readonly string[],
    ownProjectId: number,
    lifecycleStates: readonly ("active" | "archived" | "retired")[],
): void {
    const visible = readClaims(db, {
        publicClaimIds,
        projectIds: [ownProjectId],
        workspaceAuthorization: { ownProjectIds: [ownProjectId], sharedCategories: [] },
        surface: "explicit_search",
        lifecycleStates,
    });
    if (visible.length !== new Set(publicClaimIds).size) {
        throw new ClaimOperationInputError("claim not found or not visible from this project");
    }
}

function provenance(
    identity: CtxMemoryCallIdentity,
    producer: ProducerIdentity,
    sourceContent: string,
) {
    return {
        sourceLocator: `tool://ctx_memory/${identity.harness}/${identity.sessionId}/${identity.toolCallId}`,
        sourceContent,
        sourceSessionId: identity.sessionId,
        extractor: "ctx_memory",
        extractorVersion: "1",
        extractorRunId: producer.operationKey,
        independenceKey: producer.operationKey,
        sourceTrustClass: "model_inference" as const,
    };
}

function mutationTokenView(token: ClaimMutationToken): CanonicalJsonValue {
    return {
        applicabilityHeadsDigest: token.applicabilityHeadsDigest,
        contentDigest: token.contentDigest,
        lifecycleSeq: token.lifecycleSeq,
        policyHeadsDigest: token.policyHeadsDigest,
        publicClaimId: token.publicClaimId,
        revision: token.revision,
        tokenVersion: token.tokenVersion,
    };
}

function claimView(item: ProjectMemoryClaimSnapshot): CanonicalJsonValue {
    return {
        category: item.category,
        content: item.content,
        contentDigest: item.contentDigest,
        expiresAt: item.expiresAt,
        importance: item.importance,
        lifecycleState: item.lifecycleState,
        memoryScope: item.memoryScope,
        mutationToken: mutationTokenView(item.mutationToken),
        publicClaimId: item.publicClaimId,
        revision: item.revision,
        revisionLocator: item.revisionLocator,
        sharing: item.sharing,
        trustLabel: item.explicitLabel,
    };
}

function affectedPublicClaimIds(operation: ClaimOperationRunResult): string[] {
    const ids: string[] = [];
    const payload = operation.result.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const claim = payload.claim;
        if (claim && typeof claim === "object" && !Array.isArray(claim)) {
            const publicClaimId = claim.publicClaimId;
            if (typeof publicClaimId === "string") ids.push(publicClaimId);
        }
        const retiredSources = payload.retiredSources;
        if (Array.isArray(retiredSources)) {
            for (const value of retiredSources) {
                if (typeof value === "string") ids.push(value);
            }
        }
    }
    for (const effect of operation.result.effects) {
        if (!effect.revisionLocator) continue;
        const locator = parseRevisionLocator(effect.revisionLocator);
        if (locator) ids.push(locator.publicClaimId);
    }
    return [...new Set(ids)];
}

function mutationResult(
    db: Database,
    action: CtxMemoryAction,
    operation: ClaimOperationRunResult,
): string {
    const affectedClaims: CanonicalJsonValue[] = affectedPublicClaimIds(operation).map(
        (publicClaimId) => {
            const token = computeProjectMemoryMutationToken(db, publicClaimId);
            return {
                mutationToken: mutationTokenView(token),
                publicClaimId,
                revisionLocator: `${publicClaimId}/r${token.revision}/${token.contentDigest}`,
            };
        },
    );
    return canonicalJsonEncode({
        action,
        affectedClaims,
        effects: operation.result.effects.map((effect) => ({
            changeKind: effect.changeKind,
            effectKey: effect.effectKey,
            generation: effect.generation,
            projectId: effect.projectId,
            revisionLocator: effect.revisionLocator,
        })),
        generations: { ...operation.result.generations },
        outcome: operation.outcome,
        replayed: operation.replayed,
        staleReason: operation.result.staleReason,
    });
}

function readResult(
    action: "get" | "list",
    claims: readonly ProjectMemoryClaimSnapshot[],
    missingPublicClaimIds: readonly string[] = [],
): string {
    return canonicalJsonEncode({
        action,
        claims: claims.map(claimView),
        effects: [],
        generations: {},
        missingPublicClaimIds: [...missingPublicClaimIds],
        outcome: "noop",
        replayed: false,
        staleReason: null,
    });
}

function getClaims(
    db: Database,
    projectIdentity: string,
    requested: readonly string[],
): { claims: ProjectMemoryClaimSnapshot[]; missing: string[] } {
    const scope = workspaceReadScope(db, projectIdentity);
    const active = readClaims(db, {
        publicClaimIds: requested,
        projectIds: scope.projectIds,
        workspaceAuthorization: {
            ownProjectIds: scope.ownProjectIds,
            sharedCategories: scope.sharedCategories,
        },
        surface: "explicit_search",
        lifecycleStates: ["active"],
        workspaceEpoch: scope.workspaceEpoch,
    });
    const byId = new Map(active.map((item) => [item.publicClaimId, item]));
    const ownMissing = requested.filter((publicClaimId) => !byId.has(publicClaimId));
    if (ownMissing.length > 0 && scope.ownProjectIds.length > 0) {
        const inactiveOwn = readClaims(db, {
            publicClaimIds: ownMissing,
            projectIds: scope.ownProjectIds,
            workspaceAuthorization: {
                ownProjectIds: scope.ownProjectIds,
                sharedCategories: [],
            },
            surface: "explicit_search",
            lifecycleStates: ["archived", "retired"],
            workspaceEpoch: scope.workspaceEpoch,
        });
        for (const item of inactiveOwn) byId.set(item.publicClaimId, item);
    }
    return {
        claims: requested.flatMap((publicClaimId) => {
            const item = byId.get(publicClaimId);
            return item ? [item] : [];
        }),
        missing: requested.filter((publicClaimId) => !byId.has(publicClaimId)),
    };
}

export function executeCtxMemoryClaimAction(input: ExecuteCtxMemoryClaimActionArgs): string {
    const { db, args, projectIdentity, identity } = input;
    const action = args.action;
    if (!action) throw new ClaimOperationInputError("ctx_memory action is required");
    const ownProjectId = ensureProject(db, projectIdentity);

    if (action === "get") {
        const ids = uniquePublicClaimIds(args.publicClaimIds);
        if (ids.length === 0 || ids.length > GET_MAX_CLAIMS) {
            throw new ClaimOperationInputError(
                `get requires 1-${GET_MAX_CLAIMS} publicClaimIds`,
            );
        }
        const result = getClaims(db, projectIdentity, ids);
        return readResult("get", result.claims, result.missing);
    }

    if (action === "list") {
        const scope = workspaceReadScope(db, projectIdentity);
        const category = args.category?.trim();
        const claims = readClaims(db, {
            projectIds: scope.projectIds,
            workspaceAuthorization: {
                ownProjectIds: scope.ownProjectIds,
                sharedCategories: scope.sharedCategories,
            },
            surface: "explicit_search",
            lifecycleStates: ["active"],
            workspaceEpoch: scope.workspaceEpoch,
        })
            .filter((item) => !category || item.category === category)
            .slice(0, normalizeLimit(args.limit));
        return readResult("list", claims);
    }

    const producer = createCtxMemoryProducerIdentity(identity);
    if (action === "create") {
        const content = args.content?.trim();
        const category = args.category?.trim();
        if (!content || !category) {
            throw new ClaimOperationInputError("create requires non-empty content and category");
        }
        const operation = createProjectMemoryClaim(db, producer, {
            projectId: ownProjectId,
            content,
            category,
            provenance: provenance(identity, producer, content),
            actor: input.actor,
        });
        return mutationResult(db, action, operation);
    }

    if (action === "merge") {
        const tokens = args.mutationTokens ?? [];
        if (tokens.length < 2) {
            throw new ClaimOperationInputError(
                "merge requires mutationTokens ordered [target, ...sources]",
            );
        }
        const publicClaimIds = tokens.map((token) => token.publicClaimId);
        if (new Set(publicClaimIds).size !== publicClaimIds.length) {
            throw new ClaimOperationInputError("merge requires distinct claim tokens");
        }
        if (!hasOperationReceipt(db, producer)) {
            authorizeOwnClaims(db, publicClaimIds, ownProjectId, ["active"]);
        }
        const operation = mergeProjectMemoryClaims(db, producer, {
            targetToken: tokens[0],
            sourceTokens: tokens.slice(1),
            ...(args.content?.trim() ? { mergedContent: args.content.trim() } : {}),
            actor: input.actor,
        });
        return mutationResult(db, action, operation);
    }

    const target = requireSingleMutationTarget(args);
    if (!hasOperationReceipt(db, producer)) {
        authorizeOwnClaims(
            db,
            [target.publicClaimId],
            ownProjectId,
            action === "restore" ? ["archived"] : ["active"],
        );
    }

    if (action === "revise") {
        const content = args.content?.trim();
        const category = args.category?.trim();
        if (!content && !category) {
            throw new ClaimOperationInputError("revise requires content and/or category");
        }
        const operation = reviseProjectMemoryClaim(db, producer, {
            token: target.token,
            ...(content ? { content } : {}),
            ...(category ? { category } : {}),
            provenance: provenance(
                identity,
                producer,
                `revise:${target.publicClaimId}:${target.token.contentDigest}`,
            ),
            actor: input.actor,
        });
        return mutationResult(db, action, operation);
    }

    const operation = setProjectMemoryClaimLifecycle(db, producer, {
        token: target.token,
        state: action === "archive" ? "archived" : "active",
        actor: input.actor,
        reason: args.reason?.trim() || null,
    });
    return mutationResult(db, action, operation);
}

export function claimMutationTokensEqual(
    left: ClaimMutationToken,
    right: ClaimMutationToken,
): boolean {
    return canonicalClaimMutationToken(left) === canonicalClaimMutationToken(right);
}
