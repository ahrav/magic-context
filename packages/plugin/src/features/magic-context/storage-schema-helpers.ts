import type { Database } from "../../shared/sqlite";

/**
 * Schema-mutation helpers shared by storage-db (fresh-DB init) and migrations
 * (versioned upgrades). They live in this leaf module — depending only on the
 * SQLite handle — so storage-db and migrations don't import each other (storage-db
 * imports `runMigrations` from migrations; without this split, migrations would
 * import these back from storage-db and form an import cycle).
 */

/**
 * Body of the value-sensitive `memories_au` FTS maintenance trigger — the
 * text after `CREATE TRIGGER [IF NOT EXISTS] memories_au`. Scoped to the two
 * FTS-indexed columns with a value-comparing WHEN so an UPDATE that changes
 * neither indexed value performs no FTS maintenance (telemetry writes and
 * mirror full-row snapshots that bind unchanged values stay off the FTS
 * path). One definition serves both writers of this trigger — storage-db's
 * initializer fallback (CREATE TRIGGER IF NOT EXISTS) and migration v80's
 * authoritative rebuild (DROP + CREATE) — so the two cannot drift into
 * different FTS-maintenance semantics.
 */
export const MEMORIES_AU_TRIGGER_BODY = `AFTER UPDATE OF content, category ON memories
    WHEN OLD.content IS NOT NEW.content OR OLD.category IS NOT NEW.category
    BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END`;

// Intentional: the definition regex allows single quotes and parens because SQLite column
// defaults use them (e.g. TEXT DEFAULT '', INTEGER DEFAULT 0). All callsites pass hardcoded
// string literals — no user input reaches this function, so the regex is sufficient.
export function ensureColumn(
    db: Database,
    table: string,
    column: string,
    definition: string,
): void {
    if (
        !/^[a-z][a-z0-9_]*$/.test(table) ||
        !/^[a-z][a-z0-9_]*$/.test(column) ||
        !/^[A-Z0-9_"'(),[\]\s]+$/i.test(definition)
    ) {
        throw new Error(`Unsafe schema identifier: ${table}.${column} ${definition}`);
    }
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === column)) {
        return;
    }
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (err) {
        const recheck = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
        if (recheck.some((row) => row.name === column)) {
            return;
        }
        throw err;
    }
}

/**
 * Heal NULL columns added via ensureColumn against pre-existing rows.
 *
 * SQLite does NOT backfill column defaults when ALTER TABLE ADD COLUMN runs
 * on an already-populated table — old rows get NULL regardless of the
 * DEFAULT clause. isSessionMetaRow used to require strict typeof === "string"
 * / "number", which NULL fails, so rows with NULL columns were rejected,
 * getOrCreateSessionMeta returned zeroed defaults (lastResponseTime=0,
 * cacheTtl="5m"), the scheduler returned "execute" forever, and every
 * execute pass mutated message content — a sustained cache-bust cascade.
 *
 * The validator now tolerates NULL, but we normalize the data too so every
 * code path sees well-formed values. A single table-info read excludes absent
 * columns from the combined UPDATE; lock, I/O, and other execution errors must
 * propagate so the surrounding migration rolls back and can retry.
 *
 * Exported so migration v5 can call it. Not exported from any barrel.
 */
export function healAllNullColumns(db: Database): void {
    const existingColumns = getSessionMetaColumns(db);
    const fallbacks: Array<readonly [string, string | number]> = [
        ["cache_ttl", ""],
        ["last_nudge_band", ""],
        ["last_nudge_level", ""],
        ["channel2_nudge_claim_token", ""],
        ["last_transform_error", ""],
        ["nudge_anchor_message_id", ""],
        ["nudge_anchor_text", ""],
        ["sticky_turn_reminder_text", ""],
        ["sticky_turn_reminder_message_id", ""],
        ["note_nudge_trigger_message_id", ""],
        ["note_nudge_sticky_text", ""],
        ["note_nudge_sticky_message_id", ""],
        ["last_todo_state", ""],
        ["todo_synthetic_call_id", ""],
        ["todo_synthetic_anchor_message_id", ""],
        ["todo_synthetic_state_json", ""],
        ["system_prompt_hash", ""],
        ["stripped_placeholder_ids", ""],
        ["stale_reduce_stripped_ids", ""],
        ["processed_image_stripped_ids", ""],
        ["merged_reasoning_stripped_ids", ""],
        ["trailing_blank_decisions", ""],
        ["memory_block_cache", ""],
        ["memory_block_ids", ""],
        ["compaction_marker_state", ""],
        ["key_files", ""],
        ["times_execute_threshold_reached", 0],
        ["compartment_in_progress", 0],
        ["historian_failure_count", 0],
        ["cleared_reasoning_through_tag", 0],
        ["memory_block_count", 0],
        ["system_prompt_tokens", 0],
        ["conversation_tokens", 0],
        ["tool_call_tokens", 0],
        ["note_nudge_trigger_pending", 0],
        ["observed_safe_input_tokens", 0],
        ["cache_alert_sent", 0],
        ["new_work_tokens", 0],
        ["total_input_tokens", 0],
        ["last_emergency_input_sample", 0],
        ["channel2_nudge_claimed_at", 0],
        ["last_usage_context_limit", 0],
        ["prior_boundary_ordinal", 1],
        ["protected_tail_policy_version", 0],
        ["protected_tail_drain_window_started_at", 0],
        ["protected_tail_drain_tokens", 0],
        ["recovery_no_eligible_head_count", 0],
        ["force_emergency_bypass_window_start", 0],
        ["force_emergency_bypass_used", 0],
        ["emergency_drain_active", 0],
        ["historian_drain_failure_at", 0],
    ];
    const presentFallbacks = fallbacks.filter(([column]) => existingColumns.has(column));
    if (presentFallbacks.length > 0) {
        const assignments = presentFallbacks
            .map(([column]) => `${column} = COALESCE(${column}, ?)`)
            .join(", ");
        const nullPredicate = presentFallbacks.map(([column]) => `${column} IS NULL`).join(" OR ");
        db.prepare(`UPDATE session_meta SET ${assignments} WHERE ${nullPredicate}`).run(
            ...presentFallbacks.map(([, fallback]) => fallback),
        );
    }
    healMissingMemoryBlockIds(db, existingColumns);
}

function getSessionMetaColumns(db: Database): Set<string> {
    const rows = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>;
    return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

function healMissingMemoryBlockIds(db: Database, columns: ReadonlySet<string>): void {
    if (
        !columns.has("memory_block_cache") ||
        !columns.has("memory_block_ids") ||
        !columns.has("memory_block_count")
    ) {
        return;
    }
    db.prepare(
        "UPDATE session_meta SET memory_block_cache = '' WHERE memory_block_cache != '' AND (memory_block_ids IS NULL OR memory_block_ids = '') AND memory_block_count > 0",
    ).run();
}
