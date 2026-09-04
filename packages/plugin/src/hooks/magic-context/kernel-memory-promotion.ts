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
import { CTX_MEMORY_DOMAIN_ID } from "../../tools/ctx-memory/execute";

export const HISTORIAN_SOURCE_ID = "historian";

/** Ids derive from the promotion identity and the fact, so a rerun of the same chunk replays instead of minting a second object. */
function derivedId(
    prefix: string,
    identity: HistorianPromotionIdentity,
    ref: PromotedMemoryRef,
): string {
    const seed = [
        identity.producer,
        identity.runId,
        identity.batchId,
        ref.category,
        ref.contentDigest,
        prefix,
    ].join("\u001f");
    return `${prefix}_${sha256Hex(seed).slice(0, 32)}`;
}

export function promotedFactSpecs(
    refs: readonly PromotedMemoryRef[],
    identity: HistorianPromotionIdentity,
): DecisionSpecInput[] {
    return refs
        .filter((ref) => ref.category.length > 0 && ref.content.length > 0)
        .map((ref) => ({
            decision_id: derivedId("dec", identity, ref),
            object_id: derivedId("mem", identity, ref),
            domain_id: CTX_MEMORY_DOMAIN_ID,
            decision_kind: ref.category,
            payload: { summary: ref.content, rationale: "" },
            source_id: HISTORIAN_SOURCE_ID,
            source_revision: 1,
        }));
}

/** A non-`available` answer is logged and dropped: the facts are already durable in the claim lane. */
export async function commitPromotedFactsToKernel(args: {
    client: KernelClient | undefined;
    sessionId: string;
    refs: readonly PromotedMemoryRef[];
    identity: HistorianPromotionIdentity;
}): Promise<void> {
    if (!args.client) return;
    const specs = promotedFactSpecs(args.refs, args.identity);
    if (specs.length === 0) return;
    const result = await args.client.commit({
        actor: `agent:${args.identity.producer}`,
        cause: `${args.identity.runId}\u001f${args.identity.batchId}`,
        sourceKind: "model",
        operations: specs.map((spec) => ({ op: "insert_decision" as const, spec })),
    });
    if (!isAvailable(result)) {
        sessionLog(
            args.sessionId,
            `historian kernel promotion answered ${stateKey(result.state)}; ${specs.length} fact(s) stay in the claim lane only`,
        );
        return;
    }
    sessionLog(
        args.sessionId,
        `historian promoted ${specs.length} fact(s) to the kernel${result.receipt.replayed ? " (replayed)" : ""}`,
    );
}
