/**
 *
 * Magic Context spawns historian, dreamer, and sidekick subagents.
 * OpenCode and Pi expose different child-agent APIs.
 *
 * OpenCode creates, prompts, reads, and deletes child sessions through its SDK.
 * OpenCode runs child sessions in process through its SDK client.
 *
 * Pi runs child agents in non-interactive `pi --print --mode=json` subprocesses.
 * Pi emits structured JSON events from the subprocess.
 * Pi stores sessions as JSONL files, optionally selected with `--session <path>`.
 *
 * `SubagentRunner` isolates harness-specific session APIs from subagent business logic.
 * Each harness implements `SubagentRunner`.
 * Agents receive `SubagentRunner` instead of calling `client.session.*`.
 *
 */

/**
 *
 * The configuration contains fields shared by OpenCode session calls and Pi print flags.
 *
 * Fields:
 * `agent` selects an OpenCode agent registry entry.
 * Pi ignores `agent`; only `OpenCodeSubagentRunner` uses it.
 * `systemPrompt` replaces the harness-default system prompt.
 * `userMessage` is the child run's only user-turn prompt.
 * Child runs do not support multi-turn conversations.
 * `model` uses the canonical `provider/model` form.
 * Each runner translates `model` to its harness's native model selection.
 * `fallbackModels` lists models to retry after transient failures of `model`.
 * `timeoutMs` expiry aborts the child and returns `{ ok: false, reason: "timeout" }`.
 * OpenCode passes `cwd` as `query.directory`.
 * Pi uses `cwd` as the spawn cwd.
 * `signal` lets callers cancel an in-flight run.
 * Dreamer uses `signal` to abort lease renewal when it loses the lease.
 */
export interface SubagentRunOptions {
    agent: string;
    systemPrompt: string;
    userMessage: string;
    model?: string | undefined;
    fallbackModels?: readonly string[];
    timeoutMs?: number | undefined;
    cwd?: string | undefined;
    signal?: AbortSignal | undefined;
    /**
     * Pi passes `thinkingLevel` as `--thinking <level>`.
     * Pi uses `thinkingLevel`; OpenCode uses the agent config's `variant` for thinking and reasoning.
     *
     * `thinkingLevel` is required when the configured historian or dreamer model supports reasoning.
     * Pi's default thinking-level resolution can select a value the provider rejects.
     * Set `thinkingLevel` to `"off"` to disable thinking.
     */
    thinkingLevel?: string | undefined;

    /**
     * The runner invokes `onProgress` for run milestones.
     * Historian, dreamer, and sidekick use `onProgress` to write lifecycle entries.
     * They write lifecycle entries to `magic-context.log` without writing them to stdout.
     *
     * Progress callbacks must return promptly and must not throw.
     * The runner swallows progress-callback errors.
     */
    onProgress?: (event: SubagentProgressEvent) => void;

    /** Harness runners persist `subagent_invocations` when accounting metadata is present. */
    accountingSessionId?: string | undefined;
    accountingSubagent?:
        | "historian"
        | "historian_editor"
        | "compressor"
        | "dreamer"
        | "sidekick"
        | "user_memory_review"
        | "recomp"
        | undefined;
    accountingTask?: string | null | undefined;
    accountingParentInvocationId?: number | null | undefined;
}

/**
 * Progress events are emitted before the final `SubagentRunResult`.
 * Raw events let callers write a complete trace to the log when diagnosing hangs.
 *
 * Categories:
 * `first_event` is the first event received from the child and can measure auth and network warmup time.
 * `terminal` identifies the final assistant turn: Pi requires an assistant `message_end` with a terminal `stopReason` and no tool call; OpenCode uses the SDK `agent_end` equivalent.
 *   `agent_end` equivalent).
 * `raw_event` contains every parsed Pi NDJSON or OpenCode SDK event.
 * `raw_event` is emitted unconditionally so debug logs capture the full timeline.
 * `raw_event.event` is harness-shaped; callers must treat it as `unknown` and log it raw.
 */
export type SubagentProgressEvent =
    | { type: "spawned"; argv: readonly string[]; pid: number | undefined }
    | { type: "first_event"; eventType: string; ms: number }
    | {
          type: "raw_event";
          eventType: string | undefined;
          event: unknown;
          ms: number;
      }
    | {
          type: "terminal";
          stopReason: string | undefined;
          textLength: number;
          hasToolCall: boolean;
          ms: number;
      }
    | { type: "stderr"; chunk: string }
    | { type: "child_exit"; code: number | null; signal: string | null; ms: number };

/**
 *
 * Transient errors, timeouts, model failures, and aborts return `{ ok: false, reason }` with machine-readable reasons and human-readable messages.
 * Only programmer errors, such as bad arguments or missing dependencies, throw because agent code cannot cause them.
 *
 * Fields:
 * - `ok`: true iff the child produced a final assistant message.
 * `assistantText` contains trimmed, concatenated text from the final assistant message; empty text returns `ok: false` with reason `"no_assistant"` so callers can try fallback models.
 *     - `"invalid_prompt"`: a known zero-tool child was given no system prompt
 *     - `"timeout"`: hit `timeoutMs` before the child finished
 *     - `"abort"`: caller's `signal` was triggered
 *     - `"model_failed"`: every configured model + fallback returned an error
 *     - `"truncated"`: child stopped because model output hit length limits
 * `"spawn_failed"`: subprocess could not start because the Pi binary is missing or permission was denied.
 *     - `"non_zero_exit"`: child exited unsuccessfully before a final answer
 *     - `"no_assistant"`: child completed without a final assistant message
 * `"parse_failed"`: Pi emitted malformed JSON or events in an unexpected order.
 * `error` contains human-readable failure detail.
 * `durationMs` measures wall-clock time from runner call to return.
 */
export type SubagentRunResult =
    | {
          ok: true;
          assistantText: string;
          durationMs: number;
          /**
           */
          toolCallCount?: number;
          meta?: Record<string, unknown>;
      }
    | {
          ok: false;
          reason:
              | "invalid_prompt"
              | "timeout"
              | "abort"
              | "model_failed"
              | "truncated"
              | "spawn_failed"
              | "non_zero_exit"
              | "no_assistant"
              | "parse_failed";
          error: string;
          durationMs: number;
          /** `retryable` is true when callers should retry the task instead of advancing its schedule. */
          transient?: boolean;
          meta?: Record<string, unknown>;
      };

/**
 *
 */
export interface SubagentRunner {
    /** `harness` identifies the harness in logs (`"opencode"` or `"pi"`). */
    readonly harness: string;

    /**
     *
     * `run` resolves with `SubagentRunResult` for runtime, transport, and model failures.
     * `run` throws when required option fields are missing.
     */
    run(options: SubagentRunOptions): Promise<SubagentRunResult>;
}
