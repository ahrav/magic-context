/**
 * Signature lines that identify hidden (non-main-agent) requests by their
 * system-prompt content. Two consumers must agree on these literals: the
 * production system-prompt handler (skips Magic Context injection for hidden
 * agents) and the e2e cache/oracle analysis (excludes hidden-agent requests
 * from main-agent wire assertions). Keeping one list prevents the two
 * classifiers from drifting apart.
 *
 * Detection uses literal substrings rather than fuzzy matching so a small
 * upstream prompt edit doesn't silently disable the skip. If a prompt is ever
 * rewritten, detection fails open (injection resumes, the oracle sees an
 * extra request) — worse than ideal, but not broken.
 */

/**
 * OpenCode's three native hidden agents, identified by stable opening lines
 * from their built-in prompts (`opencode/packages/opencode/src/agent/prompt/
 * {title,summary,compaction}.txt`):
 *   - "title": runs once on the first user turn against `small_model` to
 *              generate a short session title.
 *   - "summary": pull-request-style description of work done in a session.
 *   - "compaction": OpenCode's own auto-compaction summarizer (orthogonal to
 *                   our historian — fires when users haven't disabled
 *                   `compaction.auto`).
 */
export const INTERNAL_OPENCODE_AGENT_SIGNATURES: readonly string[] = [
    // title.txt opens with this exact line
    "You are a title generator. You output ONLY a thread title.",
    // summary.txt opens with this exact line
    "Summarize what was done in this conversation. Write like a pull request description.",
    // compaction.txt opens with this exact line
    "You are an anchored context summarization assistant for coding sessions.",
];

/**
 * Magic Context's OWN hidden child agents (historian/dreamer/sidekick/
 * memory-migration), identified by their system-prompt openers.
 */
export const MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES: readonly string[] = [
    // HISTORIAN_AGENT (also used by memory-migration)
    "You are Historian — the hippocampus of a long-running coding agent.",
    // Every dreamer task prompt (generic base + curate / maintain-docs /
    // review-user-memories / primer-investigator) shares this identity phrase,
    // so one substring covers them all even though their openers differ.
    "for the magic-context system",
    // SIDEKICK_SYSTEM_PROMPT
    "You are Sidekick, a focused memory-retrieval subagent for an AI coding assistant.",
];
