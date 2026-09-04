/**
 * Tool-definition token measurement store.
 *
 * OpenCode's `tool.definition` hook fires once per tool per
 * `ToolRegistry.tools()` call, with `{ toolID }` as input and
 * `{ description, parameters }` as output. Crucially the hook input does NOT
 * carry `sessionID` — the tool set is computed per
 * `{providerID, modelID, agent}` combination, independent of session.
 *
 * We measure each tool's description + JSON-schema parameters, tokenize with
 * the same Claude tokenizer used everywhere else in the plugin, and store
 * per-tool totals keyed by `${providerID}/${modelID}/${agentName}`. Inner map
 * keys on `toolID` so every hook fire idempotently overwrites its own slot
 * (same tool set on each turn → same key → same measured total).
 *
 * Consumers (RPC sidebar/status handlers) look up the active session's
 * measurement via `getMeasuredToolDefinitionTokens(providerID, modelID,
 * agentName)`. Returns `undefined` when the key has never been measured — the
 * caller is expected to fall back to residual math or show zero.
 *
 * Persistence (v9+): measurements are also written to SQLite so that a
 * plugin restart can repopulate the in-memory map without waiting for the
 * next chat.message → tool.definition hook chain. The in-memory Map remains
 * the hot read path; SQLite is a write-through mirror that backs cold starts.
 * If `setDatabase()` hasn't been called yet (cold path before openDatabase
 * completes), `recordToolDefinition` still updates the in-memory map and
 * silently skips persistence — first measurement after init lands both.
 *
 * Hot-path optimization: `tool.definition` fires once per tool per LLM
 * flight (~58 tools × 5–18ms SQLite write = ~1.4s of redundant work per
 * flight on large MC databases). Tool descriptions and parameters almost
 * never change between flights, so we keep a per-key content-fingerprint
 * Map and bail out at the top of `recordToolDefinition` when the new fire
 * carries the same fingerprint as the previous one. This collapses
 * steady-state hook overhead from ~1.4s to <1ms while still re-measuring
 * any tool whose description/schema actually changed (e.g. MCP server
 * restart, OpenCode upgrade). Cached prepared statement avoids repeated
 * `db.prepare()` compile cost on first-flight rebuilds.
 */
import type { Database } from "../../shared/sqlite";
/**
 * Register the database used to persist measurements. Called by
 * openDatabase() after runMigrations() has ensured the
 * `tool_definition_measurements` table exists. Subsequent
 * recordToolDefinition() calls will write through to SQLite.
 */
export declare function setDatabase(db: Database): void;
/**
 * Populate the in-memory measurements map from the
 * `tool_definition_measurements` table. Called once at startup after
 * setDatabase(), before the first sidebar snapshot or status query, so the
 * sidebar's "Tool Defs" segment shows the correct value immediately on
 * restart instead of 0.
 *
 * Idempotent: re-running over the same DB reapplies the same values; the
 * inner-map key (toolID) ensures duplicates overwrite rather than accumulate.
 */
export declare function loadToolDefinitionMeasurements(db: Database): void;
/**
 * Tokenize a single tool's schema and store it under the given key. Called
 * from the `tool.definition` plugin hook once per tool per flight. Same
 * toolID on a later flight overwrites its slot — the total for the key stays
 * consistent even if descriptions or parameters drift between turns.
 */
export declare function recordToolDefinition(providerID: string, modelID: string, agentName: string | undefined, toolID: string, description: string, parameters: unknown): void;
/**
 * Returns the summed measured tokens for a `{provider, model, agent}` key,
 * or `undefined` when never measured (e.g. fresh session before first turn).
 */
export declare function getMeasuredToolDefinitionTokens(providerID: string, modelID: string, agentName: string | undefined): number | undefined;
/** Test helper: reset the store so suites don't leak measurements. */
export declare function __resetToolDefinitionMeasurements(): void;
/** Inspection helper: snapshot the current store (for debug logging/tests). */
export declare function getToolDefinitionSnapshot(): Array<{
    key: string;
    totalTokens: number;
    toolCount: number;
}>;
//# sourceMappingURL=tool-definition-tokens.d.ts.map