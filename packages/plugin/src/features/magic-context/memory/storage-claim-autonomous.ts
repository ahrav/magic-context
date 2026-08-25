/**
 * Atomic autonomous-producer manifests (direct-claims U9; KTD3-KTD7).
 *
 * Model output never carries database authority by itself. The host binds each
 * parsed item to the exact prompt-time public locator, content digest, and
 * claim-local token, validates the complete batch before the first domain
 * write, then stages every item under one outer operation receipt.
 */

import { isInTransaction, type Database } from "../../../shared/sqlite";
import {
    type CanonicalJsonValue,
    canonicalClaimMutationToken,
    computeClaimOperationRequestDigest,
    formatRevisionLocator,
} from "./claim-operation-contract";
import {
    type ClaimOperationRunResult,
    type ClaimOperationStageOutcome,
    computeProjectMemoryMutationToken,
    getProjectMemoryClaimByPublicId,
    runClaimOperation,
    runClaimOperationInCurrentTransaction,
} from "./storage-claim-operations";
import { sha256Utf8Hex } from "./storage-claims";
import type { ClaimMutationToken } from "./claim-operation-contract";

export interface AutonomousManifestIdentity {
    producer: string;
    task: string;
    runId: string;
    leaseKey: string;
    leaseGeneration: string | number;
    batchId: string;
}

export interface AutonomousManifestBinding {
    publicClaimId: string;
    revisionLocator: string;
    contentDigest: string;
    token: ClaimMutationToken;
}

export interface AutonomousManifestItem<T> {
    binding: AutonomousManifestBinding;
    value: T;
}

export interface AutonomousManifestApplyResult {
    operation: ClaimOperationRunResult;
    appliedItems: number;
    summary: CanonicalJsonValue;
}

function operationKey(identity: AutonomousManifestIdentity): string {
    return [
        identity.task,
        identity.runId,
        identity.leaseKey,
        String(identity.leaseGeneration),
        identity.batchId,
    ].join(":");
}

function assertIdentity(identity: AutonomousManifestIdentity): void {
    if (
        !identity.producer ||
        !identity.task ||
        !identity.runId ||
        !identity.leaseKey ||
        !identity.batchId ||
        (typeof identity.leaseGeneration === "number"
            ? !Number.isSafeInteger(identity.leaseGeneration) || identity.leaseGeneration < 1
            : identity.leaseGeneration.length === 0)
    ) {
        throw new Error("autonomous manifest identity is incomplete");
    }
}

function bindingRequestShape(binding: AutonomousManifestBinding): CanonicalJsonValue {
    return {
        contentDigest: binding.contentDigest,
        publicClaimId: binding.publicClaimId,
        revisionLocator: binding.revisionLocator,
        token: {
            applicabilityHeadsDigest: binding.token.applicabilityHeadsDigest,
            contentDigest: binding.token.contentDigest,
            lifecycleSeq: binding.token.lifecycleSeq,
            policyHeadsDigest: binding.token.policyHeadsDigest,
            publicClaimId: binding.token.publicClaimId,
            revision: binding.token.revision,
            tokenVersion: binding.token.tokenVersion,
        },
    };
}

function validateBindings(
    db: Database,
    bindings: readonly AutonomousManifestBinding[],
): string | null {
    const seen = new Set<string>();
    for (const binding of bindings) {
        if (
            !binding ||
            typeof binding.publicClaimId !== "string" ||
            typeof binding.revisionLocator !== "string" ||
            typeof binding.contentDigest !== "string" ||
            !binding.token
        ) {
            return "manifest item is missing its claim binding or mutation token";
        }
        if (seen.has(binding.publicClaimId)) {
            return `manifest contains duplicate claim ${binding.publicClaimId}`;
        }
        seen.add(binding.publicClaimId);
        if (binding.token.publicClaimId !== binding.publicClaimId) {
            return `manifest token targets ${binding.token.publicClaimId} instead of ${binding.publicClaimId}`;
        }
        const current = getProjectMemoryClaimByPublicId(db, binding.publicClaimId);
        if (!current) return `manifest targets missing claim ${binding.publicClaimId}`;
        const currentLocator = formatRevisionLocator(current);
        if (binding.revisionLocator !== currentLocator) {
            return `manifest locator ${binding.revisionLocator} is stale; current is ${currentLocator}`;
        }
        if (binding.contentDigest !== current.contentDigest) {
            return `manifest content digest is stale for ${binding.publicClaimId}`;
        }
        // Full token comparison fences lifecycle, applicability, and policy
        // heads in addition to the revision checked above.
        const currentToken = computeProjectMemoryMutationToken(db, binding.publicClaimId);
        if (canonicalClaimMutationToken(binding.token) !== canonicalClaimMutationToken(currentToken)) {
            return `manifest token is stale for ${binding.publicClaimId}`;
        }
    }
    return null;
}

function combineStageOutcomes(
    outcomes: readonly ClaimOperationStageOutcome[],
    summary: CanonicalJsonValue,
): ClaimOperationStageOutcome {
    const effects = outcomes.flatMap((outcome) => (outcome.kind === "effects" ? outcome.effects : []));
    const stale = outcomes.find((outcome) => outcome.kind === "stale");
    if (stale?.kind === "stale") return stale;
    if (effects.length === 0) {
        return {
            kind: "noop",
            payload: {
                appliedItems: 0,
                items: outcomes.map((outcome) => outcome.payload ?? null),
                summary,
            },
        };
    }
    return {
        kind: "effects",
        payload: {
            appliedItems: outcomes.length,
            items: outcomes.map((outcome) => outcome.payload ?? null),
            summary,
        },
        effects,
        policyRevisionIds: [
            ...new Set(
                outcomes.flatMap((outcome) =>
                    outcome.kind === "effects" ? (outcome.policyRevisionIds ?? []) : [],
                ),
            ),
        ],
    };
}

/** Apply one fully parsed and host-bound manifest inside its lease transaction. */
export function runAutonomousManifestInCurrentTransaction<T>(args: {
    db: Database;
    identity: AutonomousManifestIdentity;
    items: readonly AutonomousManifestItem<T>[];
    manifest: CanonicalJsonValue;
    resultSummary?: CanonicalJsonValue;
    stageItem: (db: Database, item: AutonomousManifestItem<T>, nowMs: number) => ClaimOperationStageOutcome;
    nowMs?: number;
}): AutonomousManifestApplyResult {
    if (!isInTransaction(args.db)) {
        throw new Error("runAutonomousManifestInCurrentTransaction requires an active transaction");
    }
    assertIdentity(args.identity);
    const nowMs = args.nowMs ?? Date.now();
    const envelope = {
        producer: args.identity.producer,
        operationKey: operationKey(args.identity),
        requestDigest: computeClaimOperationRequestDigest({
            identity: {
                batchId: args.identity.batchId,
                leaseGeneration: String(args.identity.leaseGeneration),
                leaseKey: args.identity.leaseKey,
                runId: args.identity.runId,
                task: args.identity.task,
            },
            items: args.items.map((item) => bindingRequestShape(item.binding)),
            manifest: args.manifest,
            operation: "autonomous-project-memory-manifest",
        }),
    };
    const operation = runClaimOperationInCurrentTransaction(
        args.db,
        envelope,
        () => {
            const invalid = validateBindings(
                args.db,
                args.items.map((item) => item.binding),
            );
            if (invalid) return { kind: "stale", reason: invalid };
            return combineStageOutcomes(
                args.items.map((item) => args.stageItem(args.db, item, nowMs)),
                args.resultSummary ?? null,
            );
        },
        nowMs,
    );
    const payload = operation.result.payload as
        | { appliedItems?: unknown; summary?: CanonicalJsonValue }
        | null;
    return {
        operation,
        appliedItems:
            operation.outcome === "applied" && typeof payload?.appliedItems === "number"
                ? payload.appliedItems
                : 0,
        summary: payload?.summary ?? null,
    };
}

/** Persist a malformed/incomplete provider manifest as one replayable zero-effect result. */
export function recordAutonomousManifestRejection(args: {
    db: Database;
    identity: AutonomousManifestIdentity;
    rawManifest: string;
    reason: string;
    nowMs?: number;
}): ClaimOperationRunResult {
    assertIdentity(args.identity);
    const nowMs = args.nowMs ?? Date.now();
    return runClaimOperation(
        args.db,
        {
            producer: args.identity.producer,
            operationKey: operationKey(args.identity),
            requestDigest: computeClaimOperationRequestDigest({
                identity: {
                    batchId: args.identity.batchId,
                    leaseGeneration: String(args.identity.leaseGeneration),
                    leaseKey: args.identity.leaseKey,
                    runId: args.identity.runId,
                    task: args.identity.task,
                },
                manifestDigest: sha256Utf8Hex(args.rawManifest),
                operation: "reject-autonomous-project-memory-manifest",
            }),
        },
        () => ({ kind: "stale", reason: args.reason }),
        nowMs,
    );
}
