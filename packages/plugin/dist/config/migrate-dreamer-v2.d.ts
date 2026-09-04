/**
 * In-memory migration of the legacy v1 dreamer config shape to the Dreamer v2
 * per-task shape (shared OpenCode + Pi; runs on every config load, like
 * migrate-experimental). Doctor performs the on-disk equivalent.
 *
 * v1 shape (any subset):
 *   dreamer: {
 *     schedule: "02:00-06:00",            // a TIME WINDOW
 *     tasks: ["consolidate","verify"],    // an ARRAY of agentic task names
 *     task_timeout_minutes: 20,
 *     max_runtime_minutes: 120,
 *     user_memories: { enabled, promotion_threshold },
 *     pin_key_files: { enabled, token_budget, min_reads },
 *   }
 *
 * v2 shape:
 *   dreamer: {
 *     tasks: { <task>: { schedule: "<cron>"|"", model?, timeout_minutes?, ... } }
 *   }
 *
 * Rules (see dreamer-v2-AB-spec.md):
 *  - Base cron derived from the WINDOW START: "02:00-06:00" → "0 2 * * *".
 *  - Legacy `tasks` array PRESENT → it is the user's deliberate selection: each
 *    LISTED agentic task gets the base cron; each OMITTED canonical task gets ""
 *    (disabled). Built-in defaults are used ONLY when `tasks` is absent.
 *  - user_memories.enabled false → review-user-memories "" ; true → base cron
 *    (promotion_threshold carried). A legacy pin_key_files block is dropped
 *    (key-files pinning moved out of Magic Context).
 *  - classify-memories is NEW in v2 and defaults ON daily at 06:00, unless the
 *    whole dreamer block is disabled.
 *  - evaluate-smart-notes → base cron (it always ran on pending notes).
 *  - task_timeout_minutes → each task's timeout_minutes default; max_runtime_minutes dropped.
 *  - Object-shaped A+B configs carrying retired memory task keys are folded into
 *    verify + curate before schema parsing strips unknown keys.
 */
export declare function migrateDreamerV2(rawConfig: Record<string, unknown>, warnings: string[]): Record<string, unknown>;
//# sourceMappingURL=migrate-dreamer-v2.d.ts.map