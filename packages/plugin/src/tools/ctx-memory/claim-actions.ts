import { V2_MEMORY_CATEGORIES } from "../../features/magic-context/memory";
import {
    type CanonicalJsonValue,
    type ClaimMutationToken,
    canonicalJsonEncode,
    formatRevisionLocator,
    isValidPublicClaimId,
} from "../../features/magic-context/memory/claim-operation-contract";
import {
    type ProjectMemoryClaimSnapshot,
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../../features/magic-context/memory/storage-claim-current-state";
import {
    ClaimOperationInputError,
    type ClaimOperationRunResult,
    createProjectMemoryClaim,
    mergeProjectMemoryClaims,
    type ProducerIdentity,
    reviseProjectMemoryClaim,
    setProjectMemoryClaimLifecycle,
} from "../../features/magic-context/memory/storage-claim-operations";
import { ensureProject } from "../../features/magic-context/memory/storage-claims";
import {
    computeWorkspaceEpochFingerprint,
    expandWorkspaceIdentitySetWithAliases,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
} from "../../features/magic-context/workspaces";
import type { Database } from "../../shared/sqlite";
import { DEFAULT_SEARCH_LIMIT, GET_MAX_CLAIMS } from "./constants";
import { CTX_MEMORY_DREAMER_ACTIONS, type CtxMemoryAction, type CtxMemoryArgs } from "./types";

export type CtxMemoryHarness = "opencode" | "pi";

export interface CtxMemoryCallIdentity {
    harness: CtxMemoryHarness;
    sessionId: string;
    toolCallId: string;
    projectIdentity: string;
}

export interface CtxMemoryProducerIdentity extends ProducerIdentity {
    requestScope: string;
}

/** Tool-call identity is the durable operation key; actions add no live-row suffix. */
export function createCtxMemoryProducerIdentity(
    identity: CtxMemoryCallIdentity,
): CtxMemoryProducerIdentity {
    const sessionId = identity.sessionId.trim();
    const toolCallId = identity.toolCallId.trim();
    const projectIdentity = identity.projectIdentity.trim();
    if (!sessionId || !toolCallId || !projectIdentity) {
        throw new ClaimOperationInputError(
            "ctx_memory mutations require stable project, session, and tool-call identities",
        );
    }
    return {
        producer: "ctx-memory-agent-v1",
        operationKey: `${identity.harness}:${sessionId}:${toolCallId}`,
        requestScope: projectIdentity,
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
    /** Identities the epoch and authorization derive from, so the provider can
     *  recompute the fingerprint at publication time. */
    workspaceIdentities: string[];
}

function workspaceReadScope(db: Database, projectIdentity: string): WorkspaceReadScope {
    const workspace = resolveWorkspaceIdentitySet(db, projectIdentity);
    const expanded = expandWorkspaceIdentitySetWithAliases(db, workspace.identities);
    const isWorkspaced = workspace.identities.length > 1;
    const authorizedIdentities = isWorkspaced ? expanded.expandedIdentities : workspace.identities;
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
        workspaceIdentities: [...workspace.identities],
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

/**
 * Enforce the claim category taxonomy at the action boundary.
 *
 * The tool schema already types `category` as an enum, but a parse failure in
 * `createCtxMemoryTool` falls back to executing the raw argument object so that
 * provider-shaped calls keep working. The schema is `passthrough`, so unknown
 * compatibility fields never fail a parse — a failure means an ADVERTISED field
 * is malformed, and the raw value then reaches here. Storage only checks that
 * the category is non-empty, so without this an out-of-taxonomy string would be
 * recorded permanently on a revision.
 */
function requireTaxonomyCategory(category: string | undefined): string | undefined {
    if (category === undefined || category === "") return undefined;
    if (!(V2_MEMORY_CATEGORIES as readonly string[]).includes(category)) {
        throw new ClaimOperationInputError(
            `unknown claim category: ${category} (expected one of ${V2_MEMORY_CATEGORIES.join(", ")})`,
        );
    }
    return category;
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

const SHA256_HEX = /^[0-9a-f]{64}$/;

function mutationTokensFromResult(operation: ClaimOperationRunResult): ClaimMutationToken[] {
    const payload = operation.result.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        if (operation.outcome === "stale") return [];
        throw new Error("stored ctx_memory result has no mutation-token payload");
    }
    const values = payload.mutationTokens;
    if (!Array.isArray(values)) {
        if (operation.outcome === "stale") return [];
        throw new Error("stored ctx_memory result has no mutation tokens");
    }
    return values.map((value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("stored ctx_memory result has a malformed mutation token");
        }
        const {
            tokenVersion,
            publicClaimId,
            revision,
            contentDigest,
            lifecycleSeq,
            applicabilityHeadsDigest,
            policyHeadsDigest,
        } = value;
        if (
            tokenVersion !== 1 ||
            typeof publicClaimId !== "string" ||
            !isValidPublicClaimId(publicClaimId) ||
            typeof revision !== "number" ||
            !Number.isSafeInteger(revision) ||
            revision <= 0 ||
            typeof contentDigest !== "string" ||
            !SHA256_HEX.test(contentDigest) ||
            typeof lifecycleSeq !== "number" ||
            !Number.isSafeInteger(lifecycleSeq) ||
            lifecycleSeq <= 0 ||
            typeof applicabilityHeadsDigest !== "string" ||
            !SHA256_HEX.test(applicabilityHeadsDigest) ||
            typeof policyHeadsDigest !== "string" ||
            !SHA256_HEX.test(policyHeadsDigest)
        ) {
            throw new Error("stored ctx_memory result has a malformed mutation token");
        }
        return {
            tokenVersion,
            publicClaimId,
            revision,
            contentDigest,
            lifecycleSeq,
            applicabilityHeadsDigest,
            policyHeadsDigest,
        };
    });
}

function mutationResult(action: CtxMemoryAction, operation: ClaimOperationRunResult): string {
    const generations = [...new Set(Object.values(operation.result.generations))];
    if (generations.length > 1) {
        throw new Error("ctx_memory operation crossed project generations");
    }
    return canonicalJsonEncode({
        action,
        affectedClaims: mutationTokensFromResult(operation).map((token) => ({
            mutationToken: mutationTokenView(token),
            publicClaimId: token.publicClaimId,
            revisionLocator: formatRevisionLocator(token),
        })),
        effects: operation.result.effects.map((effect) => ({
            changeKind: effect.changeKind,
            effectKey: effect.effectKey,
            generation: effect.generation,
            revisionLocator: effect.revisionLocator,
        })),
        generation: generations[0] ?? null,
        outcome: operation.outcome,
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
        generation: null,
        missingPublicClaimIds: [...missingPublicClaimIds],
        outcome: "noop",
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
        workspaceIdentities: scope.workspaceIdentities,
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
            workspaceIdentities: scope.workspaceIdentities,
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
    if (!CTX_MEMORY_DREAMER_ACTIONS.includes(action)) {
        throw new ClaimOperationInputError(`unsupported ctx_memory action: ${String(action)}`);
    }
    const ownProjectId = ensureProject(db, projectIdentity);

    if (action === "get") {
        const ids = uniquePublicClaimIds(args.publicClaimIds);
        if (ids.length === 0 || ids.length > GET_MAX_CLAIMS) {
            throw new ClaimOperationInputError(`get requires 1-${GET_MAX_CLAIMS} publicClaimIds`);
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
            workspaceIdentities: scope.workspaceIdentities,
        })
            .filter((item) => !category || item.category === category)
            .slice(0, normalizeLimit(args.limit));
        return readResult("list", claims);
    }

    const { requestScope, ...producer } = createCtxMemoryProducerIdentity(identity);
    if (action === "create") {
        const content = args.content?.trim();
        const category = requireTaxonomyCategory(args.category?.trim());
        if (!content || !category) {
            throw new ClaimOperationInputError("create requires non-empty content and category");
        }
        const operation = createProjectMemoryClaim(db, producer, {
            projectId: ownProjectId,
            content,
            category,
            provenance: provenance(identity, producer, content),
            actor: input.actor,
            requestScope,
        });
        return mutationResult(action, operation);
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
            requestScope,
        });
        return mutationResult(action, operation);
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
        const category = requireTaxonomyCategory(args.category?.trim());
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
            requestScope,
        });
        return mutationResult(action, operation);
    }

    const operation = setProjectMemoryClaimLifecycle(db, producer, {
        token: target.token,
        state: action === "archive" ? "archived" : "active",
        actor: input.actor,
        reason: args.reason?.trim() || null,
        requestScope,
    });
    return mutationResult(action, operation);
}
