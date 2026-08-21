import { HISTORIAN_AGENT } from "../../../agents/historian";
import { withMigrationLanguageDirective } from "../../../agents/language-directive";
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import { normalizeSDKResponse, promptSyncWithModelSuggestionRetry } from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { sessionLog } from "../../../shared/logger";
import { parseProviderModel } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { bumpEpochsForWorkspaceMembers } from "../storage";
import { insertUserMemoryCandidates } from "../user-memory/storage-user-memory";
import { resolveProjectIdentity } from "./project-identity";
import { deleteMemory, getAllActiveMemoriesForMigration, insertMemory } from "./storage-memory";
import { withMemoryClaimGenerationContextInCurrentTransaction } from "./storage-memory-claims";
import type { Memory, MemoryCategory } from "./types";

// Minimal structural client type — avoids importing the heavy PluginContext into
// a feature module. Uses `never[]` arg variance so any concrete OpenCode client
// (whose session methods have specific arg shapes) is assignable here.
// biome-ignore lint/suspicious/noExplicitAny: structural client seam for the SDK.
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
export function memoryMigrationGuardKey(projectPath: string): string {
    return `memory_migration_5cat:${projectPath}`;
}

/** True if this project's memories were already migrated to the 5-cat taxonomy. */
export function isMemoryMigrationDone(db: Database, projectPath: string): boolean {
    try {
        const row = db
            .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
            .get(memoryMigrationGuardKey(projectPath)) as { value?: string } | undefined;
        return row?.value === "done";
    } catch {
        return false;
    }
}

/** Mark this project's memory migration complete (idempotent). */
export function markMemoryMigrationDone(db: Database, projectPath: string): void {
    db.prepare(
        "INSERT INTO schema_migrations_meta (key, value) VALUES (?, 'done') ON CONFLICT(key) DO UPDATE SET value = 'done'",
    ).run(memoryMigrationGuardKey(projectPath));
}

/** The 5 v2 world-taxonomy categories the migration re-evaluates into. */
const V2_CATEGORIES: readonly MemoryCategory[] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];

/**
 * Build the migration prompt. Pure + deterministic for a given memory list.
 * The model receives every existing memory (with its legacy category) and the
 * strict 5-category definitions, and must return a single `<migrated>` block.
 */
export function buildMemoryMigrationPrompt(memories: readonly Memory[]): string {
    const lines: string[] = [];
    lines.push(
        "You are re-organizing a project's long-term memory into a stricter 5-category taxonomy.",
        "",
        "Each existing memory below is a durable fact about THIS project, captured under an older,",
        "looser category system. Re-evaluate every one against the strict v2 definitions and emit a",
        "clean replacement set. This is a QUALITY pass, not a relabel: drop stale or low-value entries,",
        "merge near-duplicates, and demote anything that is not durable world-knowledge.",
        "",
        "## The 5 categories (STRICT)",
        "- PROJECT_RULES: durable process/workflow rules for working in this repo (releases, commits,",
        "  testing conventions). NOT one-off instructions.",
        "- ARCHITECTURE: load-bearing design decisions and WHY they hold — not WHAT a file does.",
        "- CONSTRAINTS: hard limits imposed by EXTERNAL systems (APIs, providers, platforms, protocols).",
        "  NOT descriptions of our own code's behavior.",
        "- CONFIG_VALUES: stable configuration keys/values and conventions. NOT transient measurements",
        "  (test counts, binary sizes, benchmark numbers, dependency versions that change every build).",
        "- NAMING: naming conventions and canonical names. NOT inventories of every tool/component.",
        "",
        "## Drop rules",
        "- Drop memories that describe transient state, one-time completed tasks, or our own code's",
        "  runtime behavior (those are not constraints).",
        "- Drop USER traits entirely (communication style, preferences, review habits, directives aimed",
        "  at the assistant). Those live in a separate user-profile store, NOT project memory. Emit them",
        "  in <user_observations> instead so they can be routed there.",
        "- Merge memories that say the same thing; keep the clearest single phrasing.",
        "",
        "## Output format (XML, nothing else)",
        "<migrated>",
        ...V2_CATEGORIES.map(
            (c) => `<${c}>\n* one fact per line (omit the category entirely if empty)\n</${c}>`,
        ),
        "</migrated>",
        "<user_observations>",
        "* universal user trait, one per line (omit the block if none)",
        "</user_observations>",
        "",
        "## Existing memories",
    );
    for (const m of memories) {
        lines.push(`[${m.category}] ${m.content}`);
    }
    return lines.join("\n");
}

export interface MemoryMigrationResult {
    /** Re-categorized project memories (5-cat). */
    memories: Array<{ category: MemoryCategory; content: string }>;
    /** User traits to route to the global user-profile store. */
    userObservations: string[];
    /** True when a well-formed `<migrated>` block was present (even if empty).
     *  Distinguishes "model validly migrated to zero project memories" from
     *  "unparseable output" so the orchestrator never treats a real empty
     *  result as a failure (and never wipes the pool on a parse failure). */
    parsed: boolean;
}

const MIGRATED_BLOCK_RE = /<migrated>([\s\S]*?)<\/migrated>/;
const USER_OBS_BLOCK_RE = /<user_observations>([\s\S]*?)<\/user_observations>/;
const CATEGORY_BLOCK_RE = (cat: string) => new RegExp(`<${cat}>([\\s\\S]*?)</${cat}>`);

/** Parse the migration output. Pure. Unknown categories are ignored (defensive). */
export function parseMemoryMigrationOutput(text: string): MemoryMigrationResult {
    const memories: MemoryMigrationResult["memories"] = [];
    const migratedMatch = text.match(MIGRATED_BLOCK_RE);
    if (migratedMatch) {
        const body = migratedMatch[1];
        for (const category of V2_CATEGORIES) {
            const block = body.match(CATEGORY_BLOCK_RE(category));
            if (!block) continue;
            for (const line of extractBullets(block[1])) {
                memories.push({ category, content: line });
            }
        }
    }

    const userObservations: string[] = [];
    const obsMatch = text.match(USER_OBS_BLOCK_RE);
    if (obsMatch) {
        userObservations.push(...extractBullets(obsMatch[1]));
    }

    return { memories, userObservations, parsed: migratedMatch !== null };
}

function extractBullets(block: string): string[] {
    return block
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("*"))
        .map((l) => l.replace(/^\*\s?/, "").trim())
        .filter((l) => l.length > 0);
}

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
export function applyMemoryMigration(
    db: Database,
    projectPath: string,
    result: MemoryMigrationResult,
): { removed: number; inserted: number } {
    // SAFETY: never run the destructive delete+reinsert with an empty result.
    // `parseMemoryMigrationOutput` returns parsed:true for ANY <migrated> block,
    // even one with zero recognized v2-category bullets (a truncated / degenerate
    // / empty model response). Applying that would hard-delete the whole active
    // pool and insert NOTHING (root cause, dogfood 2026-05-31: 831 memories wiped,
    // 0 inserted). Callers also guard, but this is the last line of defense.
    if (result.memories.length === 0) {
        return { removed: 0, inserted: 0 };
    }
    // Load the FULL active set (expired rows included) so the delete is total and
    // can't strand expired `active` rows (the 27-survivor bug). See
    // getAllActiveMemoriesForMigration.
    const existing = getAllActiveMemoriesForMigration(db, projectPath);
    let removed = 0;
    let inserted = 0;
    // The generation context spans the whole batch so every per-row claim
    // operation shares one claim project generation, matching the other batch
    // writers (tools, relocation, backfill, identity merge).
    db.transaction(() =>
        withMemoryClaimGenerationContextInCurrentTransaction(db, () => {
            for (const m of existing) {
                deleteMemory(db, m.id);
                removed++;
            }
            for (const m of result.memories) {
                insertMemory(db, {
                    projectPath,
                    category: m.category,
                    content: m.content,
                    sourceType: "historian",
                });
                inserted++;
            }
            // Migration is a NON-ADDITIVE rewrite (delete + reinsert), so the m[0]
            // baseline is now stale for any active session. Bump the project memory
            // epoch in the same transaction so the next pass re-materializes m[0]
            // with the recategorized set (the additive maxMemoryId path would not
            // catch the deletions).
            if (removed > 0 || inserted > 0) {
                bumpEpochsForWorkspaceMembers(db, projectPath);
            }
        }),
    )();
    return { removed, inserted };
}

export const MIGRATION_SYSTEM_PROMPT =
    "You re-organize a software project's long-term memory for the magic-context system into a stricter taxonomy. " +
    "Follow the user instructions exactly. Output ONLY the requested XML blocks, nothing else.";

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
export async function runMemoryMigration(
    deps: RunMemoryMigrationDeps,
): Promise<MemoryMigrationOutcome> {
    const { client, db, directory, parentSessionId } = deps;
    const projectPath = resolveProjectIdentity(directory);

    if (isMemoryMigrationDone(db, projectPath)) {
        return { ran: false, summary: "Memories were already migrated for this project." };
    }

    // Only `active` memories are migrated; `permanent` (user-curated) rows are
    // left untouched (see applyMemoryMigration). Load the EXACT set we mutate —
    // all active rows including expired (getAllActiveMemoriesForMigration), so the
    // prompt and the destructive apply operate on the same set.
    const memories = getAllActiveMemoriesForMigration(db, projectPath);
    if (memories.length === 0) {
        // Nothing to migrate, but mark done so we don't re-check every upgrade.
        markMemoryMigrationDone(db, projectPath);
        return { ran: false, summary: "No project memories to migrate." };
    }

    const prompt = buildMemoryMigrationPrompt(memories);

    // Escalate through the configured fallback chain on EMPTY/UNPARSEABLE output,
    // not just on a thrown error. `promptSyncWithModelSuggestionRetry`'s own
    // fallback only iterates on a THROWN error; a misconfigured primary that
    // returns ok-but-empty (e.g. a disabled provider that 200s with no text)
    // slips through that gate, leaving the migration with no output and the
    // chain (e.g. anthropic/claude-sonnet-4-6) never tried. Mirrors the
    // historian's `runFallbackHistorianPass`: try each model in order (primary
    // first, then fallbacks), validating output, until one parses.
    // Primary = the session's live main model when provided (upgrade path), else
    // the historian agent default (`undefined`). Fallback chain follows either way.
    const modelChain: Array<string | undefined> = [deps.primaryModelId ?? undefined];
    const seenModels = new Set<string>();
    if (deps.primaryModelId) seenModels.add(deps.primaryModelId);
    for (const m of deps.fallbackModels ?? []) {
        if (m && !seenModels.has(m)) {
            seenModels.add(m);
            modelChain.push(m);
        }
    }

    let agentSessionId: string | null = null;
    const cleanupChildSession = async (sid: string | null): Promise<void> => {
        if (!sid) return;
        if (shouldKeepSubagents()) {
            sessionLog(
                parentSessionId,
                `memory-migration: KEEPING child session ${sid} (keep_subagents)`,
            );
            return;
        }
        await client.session.delete({ path: { id: sid } }).catch((e: unknown) => {
            sessionLog(parentSessionId, `memory-migration: child cleanup failed: ${String(e)}`);
        });
    };

    try {
        let result: ReturnType<typeof parseMemoryMigrationOutput> | null = null;

        for (let i = 0; i < modelChain.length; i += 1) {
            const modelId = modelChain[i];
            const modelOverride = modelId ? parseProviderModel(modelId) : null;

            // Fresh child session per model attempt (a prior attempt's session may
            // hold a failed/empty turn). Clean up the previous one first.
            await cleanupChildSession(agentSessionId);
            agentSessionId = null;

            const createResponse = await createChildSessionWithFence({
                client,
                db,
                parentSessionId,
                title: "magic-context-memory-migration",
                directory,
            });
            const created = normalizeSDKResponse(createResponse, null as { id?: string } | null, {
                preferResponseOnMissingData: true,
            });
            agentSessionId = typeof created?.id === "string" ? created.id : null;
            if (!agentSessionId) {
                return {
                    ran: false,
                    summary: "Memory migration could not create its child session.",
                };
            }

            if (i > 0) {
                sessionLog(
                    parentSessionId,
                    `memory-migration: escalating to configured fallback model ${modelId} (${i}/${modelChain.length - 1})`,
                );
            }

            try {
                await promptSyncWithModelSuggestionRetry(
                    client as never,
                    {
                        path: { id: agentSessionId },
                        query: { directory },
                        body: {
                            agent: HISTORIAN_AGENT,
                            system: withMigrationLanguageDirective(
                                MIGRATION_SYSTEM_PROMPT,
                                deps.language,
                            ),
                            ...(modelOverride ? { model: modelOverride } : {}),
                            parts: [{ type: "text", text: prompt, synthetic: true }],
                        },
                    },
                    {
                        timeoutMs: deps.timeoutMs ?? 5 * 60 * 1000,
                        // We drive the chain here (validating each), so don't let the
                        // prompt call re-iterate its own throw-only chain.
                        fallbackModels: undefined,
                        callContext: `memory-migration:${parentSessionId.slice(0, 12)}`,
                    },
                );
            } catch (error) {
                sessionLog(
                    parentSessionId,
                    `memory-migration: model ${modelId ?? "primary"} threw: ${String(error)}`,
                );
                continue; // escalate to the next model
            }

            const messagesResponse = await client.session.messages({
                path: { id: agentSessionId },
                query: { directory, limit: 50 },
            });
            const messages = normalizeSDKResponse(messagesResponse, [] as unknown[], {
                preferResponseOnMissingData: true,
            });
            const responseText = extractLatestAssistantText(messages);
            if (!responseText) {
                sessionLog(
                    parentSessionId,
                    `memory-migration: model ${modelId ?? "primary"} returned no output`,
                );
                continue; // empty → escalate
            }

            const parsed = parseMemoryMigrationOutput(responseText);
            if (!parsed.parsed) {
                sessionLog(
                    parentSessionId,
                    `memory-migration: model ${modelId ?? "primary"} produced no <migrated> block`,
                );
                continue; // unparseable → escalate
            }

            result = parsed; // first usable result wins
            break;
        }

        // Every model returned empty/unparseable — do NOT wipe the pool.
        if (!result) {
            return {
                ran: false,
                summary: "Memory migration produced no usable output; memories unchanged.",
            };
        }

        // SAFETY: a parsed <migrated> block with ZERO recognized v2-category
        // memories is NOT a successful migration — it's a degenerate/truncated
        // response. Applying it would hard-delete the entire active pool and
        // insert nothing (root cause, dogfood 2026-05-31). Refuse the destructive
        // apply AND do NOT set the once-per-project guard, so a later retry with a
        // capable model can still migrate. (User observations may still be present
        // but we don't route them here — a real migration must yield real memories
        // first; the next successful run will re-extract them.)
        if (result.memories.length === 0) {
            sessionLog(
                parentSessionId,
                "memory-migration: parsed result has 0 recognized v2 memories — refusing destructive apply (pool unchanged, guard NOT set)",
            );
            return {
                ran: false,
                summary:
                    "Memory migration skipped: the model returned no usable re-categorized memories (an empty or malformed result). Your memories are unchanged. Point `historian.model` at a capable model and re-run /ctx-session-upgrade.",
            };
        }

        // USER_* safety: the migration prompt routes user traits OUT to
        // <user_observations>. If we cannot durably store them (user_memories
        // disabled) we must NOT delete the active pool — that would permanently
        // drop the USER_* knowledge. Persist observations first; only proceed
        // with the destructive apply once they are safe (or there are none).
        if (result.userObservations.length > 0 && !deps.userMemoriesEnabled) {
            sessionLog(
                parentSessionId,
                `memory-migration: ${result.userObservations.length} user observation(s) but user_memories disabled — aborting to avoid dropping them`,
            );
            return {
                ran: false,
                summary:
                    "Memory migration skipped: the model extracted user traits but user memories are disabled. Enable `dreamer.user_memories` so they can be preserved, then re-run /ctx-session-upgrade.",
            };
        }

        // Persist user observations BEFORE the destructive apply so a failure
        // between the two can never drop them.
        let routed = 0;
        if (deps.userMemoriesEnabled && result.userObservations.length > 0) {
            insertUserMemoryCandidates(
                db,
                result.userObservations.map((content) => ({
                    content,
                    sessionId: parentSessionId,
                })),
            );
            routed = result.userObservations.length;
        }

        // Apply the destructive rewrite AND set the done-guard atomically. If they
        // were separate and a crash landed between them, the project would be left
        // already-migrated-to-v2 but UNGUARDED — a retry would re-migrate v2 rows
        // (new ids/stats/embeddings, possible duplicate observation candidates).
        // A nested db.transaction() runs as a savepoint, so applyMemoryMigration's
        // own inner transaction still works.
        const { removed, inserted } = db.transaction(() => {
            const counts = applyMemoryMigration(db, projectPath, result);
            markMemoryMigrationDone(db, projectPath);
            return counts;
        })();
        return {
            ran: true,
            removed,
            inserted,
            userObservations: routed,
            summary: `Re-evaluated ${removed} memor${removed === 1 ? "y" : "ies"} into ${inserted} v2-taxonomy memor${inserted === 1 ? "y" : "ies"}${routed > 0 ? `, routed ${routed} user trait${routed === 1 ? "" : "s"} to your profile` : ""}.`,
        };
    } finally {
        await cleanupChildSession(agentSessionId);
    }
}

export { sessionLog };
