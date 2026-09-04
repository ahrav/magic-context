/**
 * Detect whether the agent currently has a visible `ctx_note(action="read")`
 * tool call in their conversation context.
 *
 * Scope and timing
 * ----------------
 * Run this AFTER all message-array drops have been materialized in the
 * transform pipeline (i.e. inside `runPostTransformPhase`, not inside
 * `tagMessages`). By that point:
 *   - queued user `ctx_reduce` ops have been applied
 *   - heuristic cleanup (emergency tiered drop, clear_reasoning_age) ran
 *   - sentinel/replay logic neutralized previously-stripped parts
 * So if a `ctx_note` read is still a real, non-sentinel part in the
 * messages array we're about to send, the agent will actually see it.
 *
 * Why this matters
 * ----------------
 * Note nudges are normally suppressed when the agent already ran
 * `ctx_note(read)` since the latest note activity (see `note-nudger.ts`).
 * That suppression is correct ONLY while the read result is still in
 * context. Once the read tool call is dropped (compartmentalized, aged
 * out, or removed by `ctx_reduce`) the agent no longer has visibility
 * into the notes — re-surfacing them at the next work-boundary trigger
 * is the right thing to do.
 *
 * Implementation
 * --------------
 * Single backward pass over the messages array. Scans newest-first because
 * the most recent reads are the ones most likely to still be visible; we
 * can return as soon as one survives.
 *
 * `isSentinel` skips parts that have been neutralized to an empty-text
 * placeholder by the strip/replay pipeline — those parts are present in
 * the array (for cache-key stability) but invisible to the LLM.
 */
import type { MessageLike } from "./tag-messages";
/**
 * Returns true if the messages array contains at least one non-stripped
 * `ctx_note(action="read")` tool call/result pair. Order doesn't matter for
 * correctness — any visible read counts.
 */
export declare function hasVisibleNoteReadCall(messages: MessageLike[]): boolean;
//# sourceMappingURL=note-visibility.d.ts.map