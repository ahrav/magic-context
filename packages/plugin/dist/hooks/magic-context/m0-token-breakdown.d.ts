import type { ContextDatabase } from "../../features/magic-context/storage";
/**
 * Per-block token attribution for the synthetic m[0] message, shared by BOTH
 * harnesses (OpenCode sidebar/RPC + Pi /ctx-status dialog) so they NEVER
 * diverge on what the categories are or how they're measured.
 *
 * v2 reality this encodes:
 *  - Compartments are DECAY-RENDERED under `## start-end · date · title`
 *    headings — the real on-wire `<session-history>` slice is far smaller than
 *    Σ(full p1 content), so we measure the ACTUAL
 *    slice of the persisted m[0] snapshot (cached_m0_bytes), not Σp1.
 *  - `<project-docs>` and `<user-profile>` moved into m[0] (out of the system
 *    prompt) — they are their own buckets, not Conversation.
 *  - Memories render as the compact v2 `<project-memory>` slice (category groups
 *    containing `#id: fact` lines), not the legacy `memory_block_cache` shape.
 *  - Facts are RETIRED as a render source (promoted to memories) → factTokens
 *    is always 0; the field is kept only for dashboard/back-compat shape.
 *
 * Cold-start fallbacks (no materialized m[0] yet) mirror what WILL be injected
 * on first render: Σp1 for compartments and an on-demand v2 memory render.
 */
export interface M0BlockTokens {
    docsTokens: number;
    profileTokens: number;
    memoryTokens: number;
    /** Anthropic vision cost for the 1092x1092 mural image. */
    muralTokens: number;
    compartmentTokens: number;
    /** Always 0 in v2 (facts promoted to memories); kept for shape stability. */
    factTokens: number;
}
export declare function computeM0BlockTokens(db: ContextDatabase, sessionId: string, args: {
    m0Text: string;
    projectIdentity: string | undefined;
    injectionBudgetTokens: number | undefined;
    memoryBlockCount: number;
    /** Exact history token count managed by the Rust module outside this local database. */
    compartmentTokensOverride?: number;
}): M0BlockTokens;
//# sourceMappingURL=m0-token-breakdown.d.ts.map