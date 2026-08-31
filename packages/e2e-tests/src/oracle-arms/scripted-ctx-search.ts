import { isValidPublicClaimId } from "../../../plugin/src/features/magic-context/memory/claim-operation-contract";
import { ID_SHAPED_QUERY_MAX_TOKENS } from "../../../plugin/src/features/magic-context/search";
import type { TestHarness } from "../harness";
import { runScriptedToolCall } from "../scripted-tool-call";

/* */
type GoldMemoryId = string | { readonly publicClaimId: string };

function locatorQuery(claims: readonly GoldMemoryId[]): string {
    if (claims.length === 0) {
        throw new Error("scriptedCtxSearchTurn requires at least one id");
    }
    if (claims.length > ID_SHAPED_QUERY_MAX_TOKENS) {
        throw new Error(
            `scriptedCtxSearchTurn accepts at most ${ID_SHAPED_QUERY_MAX_TOKENS} ids per turn`,
        );
    }
    return claims
        .map((value) => {
            const publicClaimId = typeof value === "string" ? value : value.publicClaimId;
            if (!isValidPublicClaimId(publicClaimId)) {
                throw new Error(
                    `scriptedCtxSearchTurn received invalid memory id: ${publicClaimId}`,
                );
            }
            return publicClaimId;
        })
        .join(" ");
}

/**
 *
 */
export async function scriptedCtxSearchTurn(
    harness: TestHarness,
    sessionId: string,
    idsOrQuery: readonly GoldMemoryId[] | string,
): Promise<string> {
    const query =
        typeof idsOrQuery === "string" ? idsOrQuery : locatorQuery(idsOrQuery);
    const call = await runScriptedToolCall(harness, sessionId, {
        tool: "ctx_search",
        input: { query, sources: ["memory"], limit: 5 },
        prompt: `Search project memory for oracle evidence: ${query}`,
        followUpText: "oracle search complete",
    });
    return call.resultText;
}
