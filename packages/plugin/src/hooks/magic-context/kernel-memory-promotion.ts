/** Runs after the historian's publish transaction commits, so a kernel failure never rolls back a published compartment. commentlint: allow(JUDGE) */

import type {
    HistorianPromotionIdentity,
    PromotedMemoryRef,
} from "../../features/magic-context/memory/promotion";
import {
    type DecisionSpecInput,
    isAvailable,
    type KernelClient,
    sha256Hex,
    stateKey,
} from "../../shared/kernel-client";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { CTX_MEMORY_DOMAIN_ID } from "../../tools/ctx-memory/execute";
import { liveMemoryContentKeys, resetClaimLaneImportMarker } from "./claim-lane-import";
import { MEMORY_READ_SURFACE } from "./kernel-memory-render";

export const HISTORIAN_SOURCE_ID = "historian";

/** Ids derive from the claim's public identity and the checkout root: the claim lane hands a re-emitted fact its existing `publicClaimId`, so every run resolves the same fact to the same object instead of minting a run-keyed twin. commentlint: allow(JUDGE) */
function derivedId(prefix: string, projectRoot: string, publicClaimId: string): string {
    const seed = [HISTORIAN_SOURCE_ID, projectRoot, publicClaimId, prefix].join("\u001f");
    return `${prefix}_${sha256Hex(seed).slice(0, 32)}`;
}

export function promotedObjectId(publicClaimId: string, projectRoot: string): string {
    return derivedId("mem", projectRoot, publicClaimId);
}

export function promotedFactSpecs(
    refs: readonly PromotedMemoryRef[],
    projectRoot: string,
): DecisionSpecInput[] {
    return refs
        .filter((ref) => ref.category.length > 0 && ref.content.length > 0)
        .map((ref) => ({
            decision_id: derivedId("dec", projectRoot, ref.publicClaimId),
            object_id: promotedObjectId(ref.publicClaimId, projectRoot),
            domain_id: CTX_MEMORY_DOMAIN_ID,
            decision_kind: ref.category,
            payload: { summary: ref.content, rationale: "" },
            source_id: HISTORIAN_SOURCE_ID,
            source_revision: 1,
        }));
}

/** A non-`available` answer resets the claim-lane import marker: the facts are durable in the claim lane, and reopening the importer replays them into the kernel later. commentlint: allow(JUDGE) */
export async function commitPromotedFactsToKernel(args: {
    client: KernelClient | undefined;
    db: Database;
    projectPath: string;
    /** The checkout root the client's kernel scope is bound to; ids and the import marker are keyed by it. */
    projectRoot: string;
    sessionId: string;
    refs: readonly PromotedMemoryRef[];
    identity: HistorianPromotionIdentity;
}): Promise<void> {
    // Promotion runs after the caller's claim-lane transaction commits, and the facts are already durable there, so a thrown marker reset or transport failure logs instead of failing the committed run. commentlint: allow(JUDGE)
    try {
        await commitPromotedFacts(args);
    } catch (error) {
        sessionLog(
            args.sessionId,
            `historian kernel promotion failed post-commit; facts stay in the claim lane: ${String(error)}`,
        );
    }
}

async function commitPromotedFacts(args: {
    client: KernelClient | undefined;
    db: Database;
    projectPath: string;
    projectRoot: string;
    sessionId: string;
    refs: readonly PromotedMemoryRef[];
    identity: HistorianPromotionIdentity;
}): Promise<void> {
    if (!args.client) return;
    const specs = promotedFactSpecs(args.refs, args.projectRoot);
    if (specs.length === 0) return;
    const deferred = (state: string, count: number): void => {
        if (args.projectPath.length > 0) {
            resetClaimLaneImportMarker(args.db, args.projectPath, args.projectRoot);
        }
        sessionLog(
            args.sessionId,
            `historian kernel promotion answered ${state}; ${count} fact(s) stay in the claim lane; import marker reset for replay`,
        );
    };
    const existing = await args.client.read({ surface: MEMORY_READ_SURFACE, gated: false });
    if (!isAvailable(existing)) {
        deferred(stateKey(existing.state), specs.length);
        return;
    }
    // Facts already live in the kernel — under the claim-stable id or, for
    // rows written before ids were claim-stable, under the same (kind,
    // summary) — are excluded so the envelope never re-inserts an existing
    // object id, which would fail the whole commit.
    const present = new Set(existing.rows.map((row) => row.object.object_id));
    const presentContent = liveMemoryContentKeys(existing.rows);
    const pending = specs.filter(
        (spec) =>
            !present.has(spec.object_id) &&
            !presentContent.has(`${spec.decision_kind}\u001f${spec.payload.summary}`),
    );
    if (pending.length === 0) {
        sessionLog(
            args.sessionId,
            `historian promoted 0 fact(s) to the kernel; ${specs.length} already present`,
        );
        return;
    }
    const result = await args.client.commit({
        actor: `agent:${args.identity.producer}`,
        operationId: `${args.identity.runId}\u001f${args.identity.batchId}`,
        cause: `historian promotion ${args.identity.runId}/${args.identity.batchId}`,
        sourceKind: "model",
        operations: pending.map((spec) => ({ op: "insert_decision" as const, spec })),
    });
    if (!isAvailable(result)) {
        deferred(stateKey(result.state), pending.length);
        return;
    }
    sessionLog(
        args.sessionId,
        `historian promoted ${pending.length} fact(s) to the kernel${result.receipt.replayed ? " (replayed)" : ""}`,
    );
}
