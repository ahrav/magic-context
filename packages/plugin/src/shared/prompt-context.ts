/**
 * The resolver reads recent OpenCode HTTP API messages to determine the agent, model, and variant.
 *
 * A Channel 2 ceiling nudge sends a synthetic user message through `promptAsync`.
 * `promptAsync` with `noReply: false` triggers an assistant turn.
 * `createUserMessage` resolves variants relative to the selected agent.
 * Passing only a model makes OpenCode select the default agent.
 * The default agent's model check fails, bypassing the active variant and invalidating the warmed provider prefix cache.
 * Passing the agent, model, and variant prevents OpenCode from selecting the default agent.
 * notifications.
 *
 * The resolver merges messages newest-to-oldest so older messages fill only missing fields.
 *
 * `query.limit` prevents the legacy endpoint from hydrating the entire session.
 * Without `query.limit`, the legacy endpoint hydrates the entire session, which can contain 30k–45k messages.
 */

export interface ResolvedPromptContext {
    agent?: string;
    model?: { providerID: string; modelID: string };
    variant?: string;
}

interface RawInfo {
    role?: string;
    agent?: string;
    variant?: string;
    providerID?: string;
    modelID?: string;
    model?: { providerID?: string; modelID?: string; variant?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function extractMessages(response: unknown): unknown[] {
    if (Array.isArray(response)) return response;
    if (isRecord(response) && Array.isArray(response.data)) return response.data;
    return [];
}

function extractFromMessage(message: unknown): ResolvedPromptContext | null {
    if (!isRecord(message) || !isRecord(message.info)) return null;
    const info = message.info as RawInfo;
    const modelInfo = isRecord(info.model) ? info.model : undefined;

    const agent = typeof info.agent === "string" ? info.agent : undefined;
    const providerID =
        typeof modelInfo?.providerID === "string"
            ? modelInfo.providerID
            : typeof info.providerID === "string"
              ? info.providerID
              : undefined;
    const modelID =
        typeof modelInfo?.modelID === "string"
            ? modelInfo.modelID
            : typeof info.modelID === "string"
              ? info.modelID
              : undefined;
    const variant =
        typeof modelInfo?.variant === "string"
            ? modelInfo.variant
            : typeof info.variant === "string"
              ? info.variant
              : undefined;

    if (!agent && (!providerID || !modelID) && !variant) return null;
    const out: ResolvedPromptContext = {};
    if (agent) out.agent = agent;
    if (providerID && modelID) out.model = { providerID, modelID };
    if (variant) out.variant = variant;
    return out;
}

function mergeContexts(
    base: ResolvedPromptContext,
    patch: ResolvedPromptContext,
): ResolvedPromptContext {
    return {
        agent: base.agent ?? patch.agent,
        model: base.model ?? patch.model,
        variant: base.variant ?? patch.variant,
    };
}

function isComplete(ctx: ResolvedPromptContext): boolean {
    return Boolean(ctx.agent && ctx.model && ctx.variant);
}

const PROMPT_CONTEXT_MESSAGE_LIMIT = 50;

export async function resolvePromptContext(
    client: unknown,
    sessionId: string,
): Promise<ResolvedPromptContext | null> {
    if (!client || !sessionId) return null;
    const c = client as {
        session?: {
            messages?: (input: {
                path: { id: string };
                query?: { limit?: number };
            }) => Promise<{ data?: unknown[] } | unknown[]>;
        };
    };
    if (typeof c.session?.messages !== "function") return null;

    let messages: unknown[] = [];
    try {
        const response = await c.session.messages({
            path: { id: sessionId },
            query: { limit: PROMPT_CONTEXT_MESSAGE_LIMIT },
        });
        messages = extractMessages(response);
    } catch {
        return null;
    }
    if (messages.length === 0) return null;

    let result: ResolvedPromptContext = {};
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const ctx = extractFromMessage(messages[i]);
        if (!ctx) continue;
        result = mergeContexts(result, ctx);
        if (isComplete(result)) return result;
    }

    if (!result.agent && !result.model && !result.variant) return null;
    return result;
}
