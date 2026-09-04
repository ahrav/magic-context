import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import type { Memory, MemoryCategory } from "./types";
type AnyFn = (...args: any[]) => Promise<unknown>;
interface MigrationClient {
    session: {
        create: AnyFn;
        prompt: AnyFn;
        messages: AnyFn;
        delete: AnyFn;
    };
}
/**
 * Memory migration (v2 / E3.2): re-evaluate a project's existing memories into
 * the 5-category v2 world taxonomy via a one-shot historian-model prompt.
 *
 * Why this exists: pre-v2 memories use the 9-category taxonomy (ARCHITECTURE_DECISIONS,
 * USER_DIRECTIVES, WORKFLOW_RULES, KNOWN_ISSUES, ENVIRONMENT, USER_PREFERENCES, …)
 * collected under LOOSER definitions. v2's 5 categories (PROJECT_RULES, ARCHITECTURE,
 * CONSTRAINTS, CONFIG_VALUES, NAMING) have STRICTER definitions, so this is a quality
 * re-evaluation (drop stale / demote-to-narrative / merge), not a relabel. USER_* traits
 * leave project memory entirely (they belong in the global user-profile store).
 *
 * Runtime shape (locked):
 *  - Runs on-demand inside `/ctx-session-upgrade`, ONCE per project (idempotent guard).
 *  - Uses the HISTORIAN model/plumbing (not dreamer) so it works even when dreamer is
 *    disabled — the historian model is guaranteed present whenever an upgrade is relevant.
 *  - Project-scoped: operates on the project's memory pool, shared across sessions.
 *
 * This module owns the PURE pieces (prompt builder, parser, apply, guard). The LLM
 * call + child-session orchestration lives in the caller (command-handler), mirroring
 * how the dreamer/historian invoke `promptSyncWithModelSuggestionRetry`.
 */
/** Per-project guard key in `schema_migrations_meta` (precedent: v22 keys). */
export declare function memoryMigrationGuardKey(projectPath: string): string;
/** True if this project's memories were already migrated to the 5-cat taxonomy. */
export declare function isMemoryMigrationDone(db: Database, projectPath: string): boolean;
/** Mark this project's memory migration complete (idempotent). */
export declare function markMemoryMigrationDone(db: Database, projectPath: string): void;
/**
 * Build the migration prompt. Pure + deterministic for a given memory list.
 * The model receives every existing memory (with its legacy category) and the
 * strict 5-category definitions, and must return a single `<migrated>` block.
 */
export declare function buildMemoryMigrationPrompt(memories: readonly Memory[]): string;
export interface MemoryMigrationResult {
    /** Re-categorized project memories (5-cat). */
    memories: Array<{
        category: MemoryCategory;
        content: string;
    }>;
    /** User traits to route to the global user-profile store. */
    userObservations: string[];
    /** True when a well-formed `<migrated>` block was present (even if empty).
     *  Distinguishes "model validly migrated to zero project memories" from
     *  "unparseable output" so the orchestrator never treats a real empty
     *  result as a failure (and never wipes the pool on a parse failure). */
    parsed: boolean;
}
/** Parse the migration output. Pure. Unknown categories are ignored (defensive). */
export declare function parseMemoryMigrationOutput(text: string): MemoryMigrationResult;
/**
 * Apply a parsed migration result to the project's memory pool, atomically:
 * delete the project's current `active`/`permanent` memories and insert the
 * re-categorized set. Returns counts for the result message.
 *
 * Caller is responsible for routing `userObservations` to the user-profile
 * store (done in the orchestrator, gated by the user_memories feature).
 *
 * Row-state safety: only `active` memories are re-evaluated. `permanent`
 * memories are USER-curated (the user explicitly promoted them), so the
 * migration must NOT LLM-rewrite or delete them — that would silently demote
 * curated knowledge to fresh `active`/`unverified` rows and lose seen/retrieval
 * state. Permanent rows are left exactly as-is; the re-categorized set is
 * inserted alongside them.
 *
 * Embeddings cascade-delete with their memory rows (FK ON DELETE CASCADE,
 * migration v12); new rows get embeddings via the normal best-effort sweep.
 */
export declare function applyMemoryMigration(db: Database, projectPath: string, result: MemoryMigrationResult): {
    removed: number;
    inserted: number;
};
export declare const MIGRATION_SYSTEM_PROMPT: string;
export interface MemoryMigrationOutcome {
    /** True when the migration actually ran (vs. skipped because already done / empty / disabled). */
    ran: boolean;
    /** Human-readable summary for the command result message. */
    summary: string;
    removed?: number;
    inserted?: number;
    userObservations?: number;
}
export interface RunMemoryMigrationDeps {
    client: MigrationClient;
    db: Database;
    /** Session directory used to resolve project identity + route the child session. */
    directory: string;
    /** Parent session id (child session is created under it). */
    parentSessionId: string;
    /** Resolved historian fallback chain (forwarded to the prompt helper). */
    fallbackModels?: readonly string[];
    /** Primary model for the migration child session, as "provider/modelID".
     *  When set, this runs FIRST (ahead of the fallback chain) and the historian
     *  agent default is NOT used. The upgrade path passes the session's live main
     *  model here — it's the user's working interactive model (typically stronger
     *  and, unlike a possibly-misconfigured historian model, guaranteed present).
     *  When omitted, the chain starts at the historian agent default. */
    primaryModelId?: string;
    /** Prompt timeout. */
    timeoutMs?: number;
    /** When true, route user_observations into the user-memory candidate pool. */
    userMemoriesEnabled?: boolean;
    language?: string;
}
/**
 * Run the one-shot memory migration for a project.
 *
 * Idempotent: returns `ran: false` immediately if the project's guard is already
 * set, if there are no memories, or if a parse yields nothing. On success it
 * replaces the project's memories with the 5-cat set, routes user observations
 * to the user-memory candidate pool (when enabled), and flips the guard.
 *
 * Uses the HISTORIAN model (via HISTORIAN_AGENT) with a migration-specific system
 * override — works even when the dreamer is disabled.
 */
export declare function runMemoryMigration(deps: RunMemoryMigrationDeps): Promise<MemoryMigrationOutcome>;
export { sessionLog };
//# sourceMappingURL=memory-migration.d.ts.map