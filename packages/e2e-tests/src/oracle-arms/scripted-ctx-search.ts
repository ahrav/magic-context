import { isValidPublicClaimId } from "../../../plugin/src/features/magic-context/memory/claim-operation-contract";
import { ID_SHAPED_QUERY_MAX_TOKENS } from "../../../plugin/src/features/magic-context/search";
import type { TestHarness } from "../harness";
import { runScriptedToolCall } from "../scripted-tool-call";

/** A claim named either by its public ID or by a snapshot carrying one. */
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
 * Execute one real `ctx_search` tool turn and return its wire `tool_result`
 * text. Claims become one locator-shaped query in caller order — the whole
 * query must be public claim IDs for the exact-locator lane to serve it, so a
 * single non-locator token would demote the turn to an ordinary text search.
 * More than five ids are rejected rather than chunked because chunking would no
 * longer be one tool turn.
 *
 * Candidate rows are searchable. Rows already injected into this session are
 * omitted by the plugin's visible-revision-locator filter. The shared tool
 * driver starts from `mock.reset()`, which wipes every installed matcher and the
 * captured request history; callers must reinstall additional matchers for each
 * subsequent step, and must read any wire observation they need from an earlier
 * turn before scripting this one.
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
