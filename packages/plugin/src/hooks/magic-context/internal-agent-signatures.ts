/**
 *
 */

/**
 * {title,summary,compaction}.txt`):
 *                   `compaction.auto`).
 */
export const INTERNAL_OPENCODE_AGENT_SIGNATURES: readonly string[] = [
    "You are a title generator. You output ONLY a thread title.",
    "Summarize what was done in this conversation. Write like a pull request description.",
    "You are an anchored context summarization assistant for coding sessions.",
];

/**
 */
export const MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES: readonly string[] = [
    "You are Historian — the hippocampus of a long-running coding agent.",
    "for the magic-context system",
    // SIDEKICK_SYSTEM_PROMPT
    "You are Sidekick, a focused memory-retrieval subagent for an AI coding assistant.",
];
