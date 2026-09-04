/** Runs after the historian's publish transaction commits, so a kernel failure never rolls back a published compartment. commentlint: allow(JUDGE) */

import type {
    HistorianPromotionIdentity,
    PromotedMemoryRef,
} from "../../features/magic-context/memory/promotion";
import {
    type DecisionSpecInput,
    deriveObjectId,
    isAvailable,
    type KernelClient,
    MAX_READ_OBJECT_IDS,
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
    return deriveObjectId(prefix, HISTORIAN_SOURCE_ID, projectRoot, publicClaimId, prefix);
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
    // A truncated snapshot can hide a live row whose (kind, summary) matches a pending fact, so the content dedupe below cannot prove novelty; the batch defers and a later importer replay retries against a complete read. commentlint: allow(JUDGE)
    if (existing.truncated) {
        deferred("truncated", specs.length);
        return;
    }
    // Facts already live under the same (kind, summary) — rows the claim-lane importer holds under its own derived ids — are excluded by content. The snapshot serves only this content check; id presence resolves through the targeted reads below because the snapshot is capped. commentlint: allow(JUDGE)
    const presentContent = liveMemoryContentKeys(existing.rows);
    // A targeted read reaches a claim-stable id past the daemon's row cap.
    const present = new Set<string>();
    const ids = specs.map((spec) => spec.object_id);
    for (let start = 0; start < ids.length; start += MAX_READ_OBJECT_IDS) {
        const read = await args.client.read({
            surface: MEMORY_READ_SURFACE,
            gated: false,
            objectIds: ids.slice(start, start + MAX_READ_OBJECT_IDS),
        });
        if (!isAvailable(read)) {
            deferred(stateKey(read.state), specs.length);
            return;
        }
        // The id filter bypasses the daemon's row cap but not its byte budget; a truncated targeted read cannot prove which derived ids are absent, so the batch defers instead of treating the retained prefix as complete. commentlint: allow(JUDGE)
        if (read.truncated) {
            deferred("truncated", specs.length);
            return;
        }
        for (const row of read.rows) present.add(row.object.object_id);
    }
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
    // One commit per fact, keyed by the claim-stable object id so a rerun of the batch replays each fact. An id the reads could not see — retired, or written by a concurrent promotion — answers `already_exists` for that fact alone instead of aborting the rest of the batch. commentlint: allow(JUDGE)
    let promoted = 0;
    let alreadyPromoted = 0;
    for (const spec of pending) {
        const result = await args.client.commit({
            actor: `agent:${args.identity.producer}`,
            operationId: `${args.identity.runId}\u001f${args.identity.batchId}\u001f${spec.object_id}`,
            cause: `historian promotion ${args.identity.runId}/${args.identity.batchId}`,
            sourceKind: "model",
            operations: [{ op: "insert_decision" as const, spec }],
        });
        if (!isAvailable(result)) {
            if (result.state.kind === "invalid" && result.state.reason === "already_exists") {
                alreadyPromoted += 1;
                continue;
            }
            deferred(stateKey(result.state), pending.length - promoted - alreadyPromoted);
            return;
        }
        promoted += 1;
    }
    sessionLog(
        args.sessionId,
        `historian promoted ${promoted} fact(s) to the kernel; ${
            specs.length - pending.length + alreadyPromoted
        } already present`,
    );
}
