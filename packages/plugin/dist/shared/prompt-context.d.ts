/**
 * Resolve the newest effective prompt context (agent + model + variant) for a
 * session by reading recent messages from the OpenCode HTTP API.
 *
 * WHY: a Channel 2 ceiling nudge sends a synthetic user message via
 * `promptAsync` with `noReply:false` (it DOES trigger an assistant turn).
 * OpenCode's `createUserMessage` resolves variant relative to the chosen
 * agent; passing model alone makes OpenCode pick the default agent whose model
 * check then fails, bypassing the active variant and busting the provider
 * prefix cache the prior turn warmed. So we pass agent + model + variant
 * explicitly, mirroring the resolution AFT/opencode-xtra use for their wake
 * notifications.
 *
 * Walk newest→oldest and merge field-by-field so the newest context-bearing
 * message wins while older messages only fill fields it did not provide. Read
 * BOTH the flat shape (`info.providerID`) used by AssistantMessage and the
 * nested shape (`info.model.providerID`) used by UserMessage.
 *
 * Bounded via `query.limit` — the legacy `/session/{id}/message` endpoint
 * hydrates the ENTIRE session without it (30k-45k messages on large sessions).
 */
export interface ResolvedPromptContext {
    agent?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    variant?: string;
}
export declare function resolvePromptContext(client: unknown, sessionId: string): Promise<ResolvedPromptContext | null>;
//# sourceMappingURL=prompt-context.d.ts.map