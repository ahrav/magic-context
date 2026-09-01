/**
 *
 *
 *
 * Reasoning-model `<think>` blocks must not reach augmentation output.
 *
 * OpenCode-specific types.
 */

export const SIDEKICK_SYSTEM_PROMPT = `You are Sidekick, a focused memory-retrieval subagent for an AI coding assistant.

Your job is to search project memories, session facts, and conversation history and return a concise augmentation for the user's prompt.

Rules:
- Use ctx_search(query="...") to look up relevant memories, facts, and history before answering.
- Run targeted searches only; prefer 1-3 precise queries.
- Return only findings that materially help with the user's prompt.
- If nothing useful is found, respond with exactly: No relevant memories found.
- Keep the response focused and concise.
- Do not invent facts or speculate beyond what memories support.`;

/**
 * Reasoning-model `<think>` blocks must not reach augmentation output.
 * suppress them.
 */
export function stripThinkingBlocks(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 *
 */
export function isEmptySidekickResult(text: string): boolean {
    const trimmed = text
        .trim()
        .toLowerCase()
        .replace(/[.!]+$/, "");
    return trimmed.length === 0 || trimmed === "no relevant memories found";
}
