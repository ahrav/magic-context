/**
 *
 *
 *
 * The transcript exposes ordered messages through a uniform part-level mutation API.
 * OpenCode mutates `parts[]` directly; Pi rebuilds `AgentMessage[]` at `commit()`.
 * Shared transforms operate on `TranscriptPart`, not harness-specific part types.
 *
 *
 * The transcript views harness data and defines no canonical message shape.
 *
 * OpenCode flushes mutations immediately; Pi flushes them at `commit()`.
 *
 * Feature modules own compartment storage, ordinals, and raw-history reads.
 *   transcript only models the *current turn's* live message buffer.
 *
 */

/** Filter predicates use `TranscriptPartKind`. */
export type TranscriptPartKind =
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "image"
    | "file"
    | "structural"
    | "unknown";

/**
 *
 * Magic adapters implement `TranscriptPart` against their native part types.
 *
 * Implementations proxy live source data.
 * OpenCode's `setText()` mutates `Part.text`; Pi marks the message dirty.
 * Pi's `commit()` rebuilds each affected `AgentMessage`.
 * `getText()` returns the updated text after `setText()` in both adapters.
 */
export interface TranscriptPart {
    /** The `kind` value remains stable across mutations. */
    readonly kind: TranscriptPartKind;

    /**
     * `id` tracks a part across passes when the harness provides a stable identifier.
     * OpenCode IDs such as `prt_...` remain stable across passes.
     * Pi `tool_use` and `tool_result` parts use the tool-call ID.
     * Synthetic and structural parts have no `id`.
     *
     * Parts without a stable ID are tracked positionally within their containing message instead.
     */
    readonly id: string | undefined;

    /**
     * `getText()` returns the user- or agent-visible text when the part has text.
     * `getText()` returns `undefined` for `image`, `file`, and structural-only parts.
     * `getText()` returns thinking text for `thinking` parts.
     * `getText()` JSON-stringifies `tool_use` arguments for size accounting.
     * `getText()` concatenates text content from `tool_result` results.
     */
    getText(): string | undefined;

    /**
     * `setText()` changes only `text` and `thinking` parts.
     * `setText()` throws unless `kind` is `text` or `thinking`.
     *
     * `setText` returns true only when the underlying source data changes.
     * `setText` returns false when `newText` equals the existing text byte-for-byte.
     */
    setText(newText: string): boolean;

    /**
     * `setToolOutput` replaces text content in `tool_result` parts.
     * `setToolOutput` replaces JSON-serialized arguments in `tool_use` parts.
     * `setToolOutput` throws for parts other than `tool_result` and `tool_use`.
     */
    setToolOutput(newText: string): boolean;

    /**
     * `getToolMetadata` exposes metadata for tagging and drop accounting.
     * `toolName` is undefined for non-tool parts.
     * `inputByteSize` is the serialized argument size used to estimate post-drop savings.
     * `inputTokenCount` is the real-tokenizer count of the serialized argument.
     * `inputTokenCount` is stored on tags so token-budget consumers can sum it without re-tokenizing.
     *
     * For non-tool parts, `inputByteSize` and `inputTokenCount` are 0.
     */
    getToolMetadata(): {
        toolName: string | undefined;
        inputByteSize: number;
        inputTokenCount: number;
    };

    /**
     * `getToolInput` returns the invocation input object, or null for non-tool parts and parts without input.
     * Smart-drops supersession selection reads tool inputs without modifying wire data.
     * Supersession selection reads `ctx_note.action` and edit `filePath` values.
     * `getToolInput` returns a live object reference; callers must not mutate it.
     * mutate it.
     */
    getToolInput?(): Record<string, unknown> | null;

    /**
     * The smart-drops `edit_marker` path uses `setToolInput` to preserve `filePath` while clamping region hints.
     * `setToolInput` returns true only when the part has writable tool input.
     */
    setToolInput?(input: Record<string, unknown>): boolean;

    /**
     * `[dropped §N§]` and `[truncated §N§]` sentinels survive cache-busting.
     * The apply-operations flow invokes `replaceWithSentinel` when a queued drop fires.
     *
     * `replaceWithSentinel` replaces the part in place in its parent message's part array.
     * The replaced part's `kind` becomes `structural`.
     * `kind: "structural"` prevents later transform passes from processing the replacement twice.
     *
     * `replaceWithSentinel` returns false for sentinel and image parts.
     */
    replaceWithSentinel(sentinelText: string): boolean;

    /**
     * `rawByteSize` returns the serialized size of the real payload, including non-text content.
     * Emergency-drop accounting uses `rawByteSize` so image-only tool results are not counted as approximately zero bytes.
     * Adapters that can compute `rawByteSize` should implement it.
     * Size estimation falls back to the text/JSON estimate when `rawByteSize` is absent.
     */
    rawByteSize?(): number;
}

/**
 *
 * A `TranscriptMessage` is valid only within one transform pass.
 * Adapters do not preserve `TranscriptMessage` identity across passes.
 * Callers must use `info.id` for cross-pass correlation, never the message reference.
 */
export interface TranscriptMessage {
    /**
     * `info` supports tagging, sentinel persistence, and cross-pass correlation.
     * Adapters populate `info` from harness-native fields.
     * fields:
     *
     * `info.id` identifies a provider-stable message (`msg_...` in OpenCode; `entryId` in Pi).
     * `info.sessionId` scopes DB writes.
     *
     * Pi `ToolResultMessage` entries have role `"toolResult"`.
     * The transform pipeline must not receive the `"toolResult"` role.
     * (OpenCode folds tool results into the next user message's parts).
     * The Pi adapter exposes tool-result messages as parts of a synthetic `"user"` message.
     * Pi stores tool-result messages as separate top-level entries.
     * The Pi adapter performs no other shape normalization.
     */
    readonly info: { id?: string; role: string; sessionId?: string };

    /* */
    readonly parts: TranscriptPart[];
}

/**
 * `Transcript` defines the adapter contract for the transform pipeline.
 *
 * Harness adapter layers own `Transcript` adapters.
 * The shared transform code accesses transcripts only through `Transcript`.
 * The shared transform code never imports harness SDKs.
 * `@earendil-works/pi-ai`.
 */
export interface Transcript {
    /* */
    readonly messages: TranscriptMessage[];

    /**
     * `harness` selects the logging label (`magic-context[opencode]` or `magic-context[pi]`).
     * `harness` gates compaction marker injection to OpenCode.
     */
    readonly harness: "opencode" | "pi";

    /**
     * `commit` applies accumulated mutations to the underlying source array.
     *
     * `commit` is a no-op for OpenCode because mutations update `Part.text` and `Part.state.output` directly.
     * `OpenCode` reads the same source array after direct mutations.
     *
     * `commit` rebuilds an `AgentMessage[]` from dirty messages for Pi.
     * `commit` stores the rebuilt messages on the adapter so `pi.on("context", ...)` can return `{ messages }`.
     * `commit` is idempotent.
     *
     * The transform pipeline calls `commit` exactly once per pass after it finishes.
     * `Adapters that do not need commit implement it as a no-op.`
     */
    commit(): void;
}
