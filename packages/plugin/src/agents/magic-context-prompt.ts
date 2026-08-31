/* */

import type { PromptSurfacePreset } from "../shared/prompt-surface";
import { buildPrimaryLanguageDirective } from "./language-directive";

/**
 *      trigger this.
 * Both ctx_reduce variants place LONG_TERM_PARTNER_FRAME before the mechanics so agents read it before scarcity signals.
 */
const LONG_TERM_PARTNER_FRAME = `### You are the user's long-term partner on this project — not a one-off hire

Most AI sessions are disposable: one session per task, discarded when it's done — like hiring a developer for a single bug fix and letting them go the moment they finish. Magic Context changes this completely. This session is a durable working relationship: you carry the full history and accumulated knowledge of this project, and you continue across many tasks, bugs, and features — with memory that persists across restarts. This session may continue for weeks, months, or even years.

Because of this:
- **Your context is continuously managed and effectively unbounded.** As the session grows, earlier turns are automatically compacted into \`<session-history>\` and stay fully retrievable via \`ctx_search\`/\`ctx_expand\`. You will not hit a context wall and you will not lose continuity mid-task.
- **High context usage is normal and fully handled** — never a reason to wrap up, cut scope, rush, or defer work. Keep going at full depth.
- **Finishing a task does not end the session.** Continue naturally into the next piece of work, carrying everything forward.
- **There are no compaction pauses.** Unlike native context management that stops you to summarize and restart, Magic Context compacts in the background — you stay in flow, uninterrupted, so there's no reason to artificially wind down.`;

/* */
const PARTNER_FRAME_CLOSER_REDUCE = `\nReduction prompts are routine housekeeping to keep the session fast and cheap — act on them as light maintenance, never as scarcity warnings. Keep individual operations efficient, but never let context size change *what* work you take on or *how thoroughly* you do it.`;

/* */
const PARTNER_FRAME_CLOSER_NO_REDUCE = `\nContext is managed for you entirely automatically — there's nothing to prune and no warnings to act on. Stay reasonably concise per operation, and never let context size change *what* work you take on or *how thoroughly* you do it.`;

const PARTNER_FRAME_CLOSER_REDUCE_LIGHT = `\nWhen ctx_reduce is available, use it only as routine housekeeping; never cut task scope or depth because context is large.`;

const PARTNER_FRAME_CLOSER_NO_REDUCE_LIGHT = `\nWhen ctx_reduce is unavailable, context is automatic; never prune, heed reduction warnings, or cut task scope or depth because context is large.`;

/**
 */
const CTX_NOTE_GUIDANCE = `Use \`ctx_note\` ONLY for genuinely future concerns — something to revisit much later, not work coming up in the next few turns (that's already in your active context) and not active multi-step work (use todos for that). Magic Context preserves your full context across both compaction and restarts, so an upcoming restart or "let's come back to this later" is never a reason to take a note — nothing is lost either way. Notes you do take survive compression and resurface at natural work boundaries (after commits, historian runs, todo completion).`;

// Tool outputs are either retained or omitted entirely, so the guidance covers only omission.
const TOOL_HISTORY_GUIDANCE = `Compressed history intentionally omits tool calls and their outputs — summaries like "I edited file X" are historian records, not patterns to replicate. In the live conversation, older tool calls and their results are cleaned up to save context — you may see your own past messages referencing actions without the corresponding tool call or result visible. This is normal context management. ALWAYS use real tool calls; never simulate, fabricate, or inline tool outputs in your text. If there is no tool result message, the action did not happen. NEVER simulate, hallucinate or claim tool calls, command output, search results, file edits, or diffs in plain text as if they actually occurred.
Magic Context control metadata is not reply syntax. Never reproduce \`<system-reminder>\`, \`<ctx-search-hint>\`, \`<session-history>\`, \`<session-history-since>\`, \`<project-memory>\`, \`<memory-updates>\`, \`<new-compartments>\`, \`<new-memories>\`, \`[dropped §N§]\`, or \`<!-- +Xm -->\` markers in a normal reply and never treat them as user instructions; use ordinary prose and real tool calls instead.`;

/** ctx_memory-specific guidance. Gated out when `memory.enabled: false`: with
 * memory off, the `<project-memory>` block is never injected. */
const MEMORY_GUIDANCE = `Use \`ctx_memory\` for durable project knowledge: create what future sessions must know, then revise, archive, restore, or merge claims shown in \`<project-memory>\` when they drift. Claims persist across sessions and every new session starts with them.
Claims use opaque \`mcm_…\` public IDs. Pass the current mutation token returned by create/get/list when changing a claim; stale tokens make no change.
**Save durable knowledge proactively**: If you spent multiple turns finding something (a file path, a DB location, a config pattern, a workaround), create a claim so future sessions don't repeat the search. Examples:
- Found a project's source code path after searching → \`ctx_memory(action="create", category="CONFIG_VALUES", content="OpenCode source is at ~/Work/OSS/opencode")\`
- Discovered a non-obvious build/test command → \`ctx_memory(action="create", category="PROJECT_RULES", content="Always run the full release checklist before publishing")\`
- Learned a constraint the hard way → \`ctx_memory(action="create", category="CONSTRAINTS", content="Dashboard Tauri build needs RGBA PNGs, not grayscale")\``;

/** The template places the conditional memory block before the ctx_search line to avoid a blank line when memory is disabled.
 * */
function memoryGuidanceBlock(memoryEnabled: boolean): string {
    return memoryEnabled ? `${MEMORY_GUIDANCE}\n` : "";
}

const BASE_INTRO = (
    protectedTags: number,
    memoryEnabled: boolean,
): string => `Messages and tool outputs are tagged with §N§ identifiers (e.g., §1§, §42§).
Use \`ctx_reduce\` to mark spent tagged content as discardable and reclaim space. Marking is NOT an immediate delete — it queues the content, which stays fully visible until space is actually needed (as soon as the next turn if you're already under pressure, much later if not), so mark a tool output as soon as you're done with it rather than hoarding the call for the end of the turn. The last ${protectedTags} tags are protected (marking one just queues it until it ages out). Syntax: "3-5", "1,2,9", or "1-5,8,12-15".
Do not announce or narrate \`ctx_reduce\` drops — just call the tool silently. Saying "I'll drop these outputs" wastes tokens the user does not care about.
${CTX_NOTE_GUIDANCE}
${memoryGuidanceBlock(memoryEnabled)}Use \`ctx_search\` to search across project memories, indexed git commits, and this session's full conversation history (including compacted parts) from one query.
Use \`ctx_expand\` to recover the raw conversation behind a summary under a \`## start-end · date · title\` heading inside \`<session-history>\` — pass the heading's start/end range when the summary is not enough (exact wording, values, error text).
**Search before asking the user**: If you can't remember or don't know something that might have been discussed before or stored in project memory, use \`ctx_search\` before asking the user. Examples:
- Can't remember where a related codebase or dependency lives → \`ctx_search(query="opencode source code path")\`
- Forgot a prior architectural decision or constraint → \`ctx_search(query="why did we choose SQLite over postgres")\`
- Need a config value, API key location, or environment detail → \`ctx_search(query="embedding provider configuration")\`
- Looking for how something was implemented previously → \`ctx_search(query="how does the dreamer lease work")\`
- Want to recall what was decided in an earlier conversation → \`ctx_search(query="dashboard release signing setup")\`
\`ctx_search\` returns ranked results from memories, git commits, and raw message history. Use message ordinals from results with \`ctx_expand\` to retrieve surrounding conversation context.
${TOOL_HISTORY_GUIDANCE}
NEVER drop large ranges blindly (e.g., "1-50"). Review each tag before deciding.
Keep your user's instructions and intent — never drop a user message for its directive, even an old one. But a large block of pasted content inside a user message (logs, data dumps, long code, attachments) is fair to mark discardable once you've extracted what you need — it stays searchable via \`ctx_search\`.
NEVER drop assistant text messages unless they are exceptionally large. Your conversation messages are lightweight; only large tool outputs are worth dropping.
Before your turn finishes, consider using \`ctx_reduce\` to drop large tool outputs you no longer need.`;

/** Intro when ctx_reduce is unavailable — no drop guidance or tag-system description.
 * When ctx_reduce is unavailable, transform.ts omits §N§ prefixes, so callers omit tag guidance.
 * When ctx_reduce is unavailable, transform.ts omits §N§ prefixes, so callers omit tag guidance.
 * When ctx_reduce is unavailable, transform.ts omits §N§ prefixes, so callers omit tag guidance.
 * When ctx_reduce is unavailable, transform.ts omits §N§ prefixes, so callers omit tag guidance.
 * When ctx_reduce is unavailable, transform.ts omits §N§ prefixes, so callers omit tag guidance. */
const BASE_INTRO_NO_REDUCE = (memoryEnabled: boolean): string => `${CTX_NOTE_GUIDANCE}
${memoryGuidanceBlock(memoryEnabled)}Use \`ctx_search\` to search across project memories, indexed git commits, and this session's full conversation history (including compacted parts) from one query.
Use \`ctx_expand\` to recover the raw conversation behind a summary under a \`## start-end · date · title\` heading inside \`<session-history>\` — pass the heading's start/end range when the summary is not enough (exact wording, values, error text).
**Search before asking the user**: If you can't remember or don't know something that might have been discussed before or stored in project memory, use \`ctx_search\` before asking the user. Examples:
- Can't remember where a related codebase or dependency lives → \`ctx_search(query="opencode source code path")\`
- Forgot a prior architectural decision or constraint → \`ctx_search(query="why did we choose SQLite over postgres")\`
- Need a config value, API key location, or environment detail → \`ctx_search(query="embedding provider configuration")\`
- Looking for how something was implemented previously → \`ctx_search(query="how does the dreamer lease work")\`
- Want to recall what was decided in an earlier conversation → \`ctx_search(query="dashboard release signing setup")\`
\`ctx_search\` returns ranked results from memories, git commits, and raw message history. Use message ordinals from results with \`ctx_expand\` to retrieve surrounding conversation context.
${TOOL_HISTORY_GUIDANCE}`;

const LIGHT_SEARCH_RECOVERY = `Use ctx_search before asking the user about prior project context; it searches memories, commits, and compacted conversation. When a session-history summary lacks exact wording, values, errors, or reasoning, call ctx_expand with its heading range instead of guessing.`;

const BASE_INTRO_LIGHT = (
    protectedTags: number,
    memoryEnabled: boolean,
): string => `In primary sessions with ctx_reduce, the system tags messages and tool outputs as §N§ (for example §1§ and §42§); never imitate these prefixes in replies because only injected tag numbers are valid ctx_reduce handles.
In primary sessions, NEVER narrate ctx_reduce; call it silently after extracting a spent output because it marks content discardable and QUEUES release rather than deleting immediately. The last ${protectedTags} tags stay protected until they age out. Use drop grammar "3-5", "1,2,9", or "1-5,8,12-15".
${CTX_NOTE_GUIDANCE}
${memoryGuidanceBlock(memoryEnabled)}${LIGHT_SEARCH_RECOVERY}
${TOOL_HISTORY_GUIDANCE}
For primary ctx_reduce choices, NEVER blanket-drop a large range because mixed-value evidence may be lost: inspect every tag first. Drop only analyzed reads, searches, diagnostics, or build/test outputs after use. NEVER drop user directives or assistant prose unless exceptionally large; keep requirements, constraints, unresolved errors or decisions, exact wording, raw evidence, and active files or work. Only extracted pasted user payloads may go.
Consider small targeted drops after acted-on reads or searches, completed logical steps, before context switches, and before the turn ends; this keeps the working set tidy without changing task scope.`;

const BASE_INTRO_NO_REDUCE_LIGHT = (memoryEnabled: boolean): string => `${CTX_NOTE_GUIDANCE}
${memoryGuidanceBlock(memoryEnabled)}${LIGHT_SEARCH_RECOVERY}
${TOOL_HISTORY_GUIDANCE}`;

const GENERIC_SECTION = `
### Reduction Triggers
- After reading files or search results you already acted on — drop raw outputs.
- After completing a logical step — drop intermediate outputs from that step.
- Between major context switches — when moving to a new task area.

### What to Drop
- Large file reads, grep results, and tool outputs you already used.
- Large build/test output after you analyzed and acted on it.
- Old diagnostic or exploration results that are no longer relevant.

### What to Keep
- ALL user messages and assistant conversation text — these are cheap and compartmentalized automatically.
- Your current task requirements and constraints.
- Recent errors and unresolved decisions.
- Active work context and files being edited.`;

const SMART_NOTE_GUIDANCE_LIGHT = `\nsurface_condition creates a smart note checked nightly against external signals on ctx_note write.`;

const TEMPORAL_AWARENESS_GUIDANCE = `\n**Temporal awareness**: User messages may be preceded by HTML comments like \`<!-- +12m -->\`, \`<!-- +2h 15m -->\`, or \`<!-- +3d 4h -->\` indicating time elapsed since the previous message's completion. Compartments in \`<session-history>\` carry \`start-date\` and \`end-date\` attributes (YYYY-MM-DD) showing real-time boundaries. Use these when reasoning about workflow pacing, log durations, build times, or how long ago something happened.`;

/**
 * Minimal guidance for SUBAGENT sessions. Subagents are bounded, single-task
 * executors that receive only §N§ and ctx_reduce mechanics.
 * Subagents receive only §N§ and ctx_reduce guidance; `system-prompt-hash.ts` requires `## Magic Context` for injection idempotency.
 * Subagents receive only §N§ and ctx_reduce guidance; `system-prompt-hash.ts` requires `## Magic Context` for injection idempotency.
 * Subagents receive only §N§ and ctx_reduce guidance; `system-prompt-hash.ts` requires `## Magic Context` for injection idempotency.
 * Subagents receive only §N§ and ctx_reduce guidance; `system-prompt-hash.ts` requires `## Magic Context` for injection idempotency.
 * Subagents receive only §N§ and ctx_reduce guidance; `system-prompt-hash.ts` requires `## Magic Context` for injection idempotency.
 * Subagents receive only §N§ and ctx_reduce guidance; `system-prompt-hash.ts` requires `## Magic Context` for injection idempotency.
 */
const SUBAGENT_REDUCE_INTRO = (
    protectedTags: number,
): string => `Messages and tool outputs are tagged with §N§ identifiers (e.g., §1§, §42§).
Use \`ctx_reduce\` to drop tool outputs you have already finished with, keeping your working context lean. Syntax: "3-5", "1,2,9", or "1-5,8,12-15". The last ${protectedTags} tags are protected.
Drop silently — do not narrate it. NEVER drop large ranges blindly (e.g., "1-50"); review each tag first. Do not drop user or assistant text messages — only large tool outputs are worth dropping.
Older tool calls may show \`[dropped §N§]\` sentinels; that is normal context management, not a pattern to copy. ALWAYS make fresh real tool calls when you need data again; never fabricate or inline tool output.`;

const SUBAGENT_REDUCE_INTRO_LIGHT = (
    protectedTags: number,
): string => `In bounded subagent sessions, the system tags messages and tool outputs as §N§; use only those IDs in ctx_reduce drop ranges such as "3-5", "1,2,9", or "1-5,8,12-15". The last ${protectedTags} tags stay protected.
When dropping, do it silently and NEVER choose a large range before reviewing every tag; drop only finished large tool outputs, never user or assistant messages.
If older calls show [dropped §N§], never copy that system sentinel because it is not reply syntax; make a fresh real tool call and never fabricate or inline output.`;

const CAVEMAN_COMPRESSION_WARNING = `\n**BEWARE**: History compression is on; older user AND assistant text — including your own earlier responses — has been deterministically rewritten in a terse caveman style (dropped articles, missing auxiliaries, \`//\` instead of connectives like \`because\`). This is automatic context compression that runs after the fact, not your actual prior wording or the user's. **DO NOT mimic this style in new turns.** Write fresh responses in normal prose. If you notice your output drifting into caveman cadence, that drift is in-context-learning bleeding from the compressed history — consciously revert to full sentences.`;

export function buildMagicContextSection(
    _agent: string | null,
    protectedTags: number,
    ctxReduceCallable = true,
    dreamerEnabled = false,
    temporalAwarenessEnabled = false,
    cavemanTextCompressionEnabled = false,
    subagentMode = false,
    language?: string,
    memoryEnabled = true,
    preset: PromptSurfacePreset = "full",
    primaryOverride?: string,
): string {
    // When ctx_reduce is enabled, subagents receive only §N§ and ctx_reduce guidance; callers omit tag guidance when ctx_reduce is disabled.
    // When ctx_reduce is enabled, subagents receive only §N§ and ctx_reduce guidance; callers omit tag guidance when ctx_reduce is disabled.
    // When ctx_reduce is enabled, subagents receive only §N§ and ctx_reduce guidance; callers omit tag guidance when ctx_reduce is disabled.
    // When ctx_reduce is enabled, subagents receive only §N§ and ctx_reduce guidance; callers omit tag guidance when ctx_reduce is disabled.
    // When ctx_reduce is enabled, subagents receive only §N§ and ctx_reduce guidance; callers omit tag guidance when ctx_reduce is disabled.
    // When ctx_reduce is enabled, subagents receive only §N§ and ctx_reduce guidance; callers omit tag guidance when ctx_reduce is disabled.
    if (subagentMode) {
        const intro =
            preset === "light"
                ? SUBAGENT_REDUCE_INTRO_LIGHT(protectedTags)
                : SUBAGENT_REDUCE_INTRO(protectedTags);
        return `## Magic Context\n\n${intro}`;
    }
    const smartNoteGuidance = dreamerEnabled
        ? preset === "light"
            ? SMART_NOTE_GUIDANCE_LIGHT
            : `\nWhen \`surface_condition\` is provided with \`write\`, the note becomes a project-scoped smart note.\nThe dreamer evaluates smart note conditions during nightly runs and surfaces them when conditions are met.\nExample: \`ctx_note(action="write", content="Implement X because Y", surface_condition="When PR #42 is merged in this repo")\``
        : "";
    const temporalGuidance = temporalAwarenessEnabled ? TEMPORAL_AWARENESS_GUIDANCE : "";
    // Caveman compression is independent of ctx_reduce availability.
    // Both primary guidance variants emit the warning when the primary-session caveman pass is enabled so the agent does not mimic compressed history.
    // Both primary guidance variants emit the warning when the primary-session caveman pass is enabled so the agent does not mimic compressed history.
    const cavemanWarning = cavemanTextCompressionEnabled ? CAVEMAN_COMPRESSION_WARNING : "";
    const languageDirective = buildPrimaryLanguageDirective(language);
    const languageGuidance = languageDirective ? `\n\n${languageDirective}` : "";

    if (primaryOverride !== undefined) {
        // A user override owns the complete primary section.
        // The composer retains runtime clauses so overrides cannot suppress temporal guidance, the anti-compression warning, or the language directive.
        // The composer retains runtime clauses so overrides cannot suppress temporal guidance, the anti-compression warning, or the language directive.
        return `${primaryOverride}${temporalGuidance}${cavemanWarning}${languageGuidance}`;
    }

    if (!ctxReduceCallable) {
        if (preset === "light") {
            return `## Magic Context\n\n${LONG_TERM_PARTNER_FRAME}\n${PARTNER_FRAME_CLOSER_NO_REDUCE_LIGHT}\n\n${BASE_INTRO_NO_REDUCE_LIGHT(memoryEnabled)}${smartNoteGuidance}${temporalGuidance}${cavemanWarning}${languageGuidance}`;
        }
        return `## Magic Context\n\n${LONG_TERM_PARTNER_FRAME}\n${PARTNER_FRAME_CLOSER_NO_REDUCE}\n\n${BASE_INTRO_NO_REDUCE(memoryEnabled)}${smartNoteGuidance}${temporalGuidance}${cavemanWarning}${languageGuidance}`;
    }
    if (preset === "light") {
        return `## Magic Context\n\n${LONG_TERM_PARTNER_FRAME}\n${PARTNER_FRAME_CLOSER_REDUCE_LIGHT}\n\n${BASE_INTRO_LIGHT(protectedTags, memoryEnabled)}${smartNoteGuidance}${temporalGuidance}${cavemanWarning}${languageGuidance}`;
    }
    return `## Magic Context\n\n${LONG_TERM_PARTNER_FRAME}\n${PARTNER_FRAME_CLOSER_REDUCE}\n\n${BASE_INTRO(protectedTags, memoryEnabled)}${smartNoteGuidance}${temporalGuidance}${cavemanWarning}\n${GENERIC_SECTION}\n\nPrefer many small targeted operations over one large blanket operation, and keep the working set tidy as routine maintenance.${languageGuidance}`;
}
