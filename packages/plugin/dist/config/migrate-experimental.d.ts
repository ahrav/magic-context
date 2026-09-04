/**
 * Startup-time shim for graduated experimental features (shared OpenCode + Pi).
 *
 * Features have graduated out of the `experimental.*` namespace across releases:
 *  - v0.14: `experimental.user_memories` / `experimental.pin_key_files` →
 *    `dreamer.user_memories` / `dreamer.pin_key_files`.
 *  - this release: `experimental.temporal_awareness` / `caveman_text_compression`
 *    → top-level keys; `experimental.auto_search` / `git_commit_indexing` →
 *    `memory.auto_search` / `memory.git_commit_indexing`; and
 *    `experimental.mural` → top-level `mural`.
 *
 * Doctor runs an on-disk migration, but users who never run doctor would
 * otherwise lose their opt-in/opt-out because the graduated keys are no longer
 * in the schema — Zod silently strips unknown keys. This shim runs in-memory on
 * every load: if the user has legacy `experimental.<graduated-key>` blocks, it
 * reshapes the raw config so the new schema sees them at their graduated path.
 * The on-disk file stays untouched (doctor is the tool that cleans it up), and
 * the user's explicit intent is preserved for this session's runtime behavior.
 *
 * Primitive values (e.g., `experimental.user_memories: true`) are coerced to
 * `{ enabled: <bool> }` object form so Zod accepts them. Without this coercion,
 * the primitive would fail schema validation and fall back to the graduated
 * default — silently flipping a user's explicit `false` to the new `true`
 * default, or vice versa.
 *
 * Idempotent: if the destination path already has a value, the destination wins
 * (the user has started graduating), merging sub-fields so nothing is lost.
 */
export declare function migrateLegacyExperimental(rawConfig: Record<string, unknown>, warnings: string[]): Record<string, unknown>;
//# sourceMappingURL=migrate-experimental.d.ts.map