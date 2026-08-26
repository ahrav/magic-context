/**
 * U8 direct-cutover activation (KTD1): the session-runtime schema component.
 *
 * This is the exact final shape of every non-claim harness table the plugin
 * uses (tags, compartments, session metadata, notes, primers, historian and
 * dreamer state, module authority/mirror bookkeeping, workspaces, identity
 * bookkeeping, and the direct-format migration fence). It was captured from
 * the last legacy bootstrap (initializeDatabase + migration chain head v89)
 * and is now the only way these objects are created: there is no legacy
 * migration chain and no v87+ data migration. Schema changes bump the
 * component manifest digest, which changes the direct-format identity.
 *
 * The retired memory-era objects (memories, memories_fts, memory_embeddings,
 * memory_stats, memory_verifications, memory_mutation_log, the
 * legacy_memory_claims crosswalk, and the v84 claim compatibility tables) are
 * deliberately absent: project memory lives in the registered claim
 * components (R18).
 *
 * Dependency-light on purpose: runtime imports use explicit `.ts` extensions
 * so the Node smoke scripts can load this module under Node's type-stripping
 * loader.
 */

import type { Database } from "../../shared/sqlite";
import {
    DIRECT_FORMAT_FENCE_MIGRATION_VERSION,
    FORK_MIGRATION_VERSION_FLOOR,
} from "./migrations.ts";

/**
 * Every table this component owns, including FTS5 shadow tables (they are
 * real tables in `sqlite_schema`, so the composition validator and the
 * format classifier must account for them).
 */
export const SESSION_RUNTIME_TABLES: readonly string[] = [
    "authority_capture_bounds",
    "authority_managed",
    "authority_repair_pending",
    "compartment_chunk_embeddings",
    "compartment_events",
    "compartment_state_lease",
    "compartments",
    "compression_depth",
    "context_privilege_state",
    "context_store_meta",
    "domain_mutation_epoch",
    "dream_queue",
    "dream_runs",
    "dream_state",
    "embedding_identity_active",
    "embedding_measurement_corpus",
    "embedding_registrations",
    "git_commit_embeddings",
    "git_commits",
    "git_commits_fts",
    "git_commits_fts_config",
    "git_commits_fts_content",
    "git_commits_fts_data",
    "git_commits_fts_docsize",
    "git_commits_fts_idx",
    "git_sweep_coordinator",
    "historian_runs",
    "identity_merge_log",
    "m0_mutation_log",
    "message_history_fts",
    "message_history_fts_config",
    "message_history_fts_content",
    "message_history_fts_data",
    "message_history_fts_docsize",
    "message_history_fts_idx",
    "message_history_index",
    "message_history_orphan_sweep",
    "message_history_source",
    "migration_pending",
    "mirror_cursors",
    "mirror_identity",
    "mirror_live_memory_rows",
    "mirror_live_staging",
    "mirror_note_revisions",
    "mirror_pending_references",
    "mirror_resnapshot_state",
    "mural_manifest",
    "notes",
    "notes_fts",
    "notes_fts_config",
    "notes_fts_data",
    "notes_fts_docsize",
    "notes_fts_idx",
    "notes_search_view",
    "pending_ops",
    "pending_session_cleanup",
    "plugin_messages",
    "primer_candidates",
    "primers",
    "primers_fts",
    "primers_fts_config",
    "primers_fts_data",
    "primers_fts_docsize",
    "primers_fts_idx",
    "project_key_files",
    "project_key_files_version",
    "project_state",
    "recomp_compartments",
    "recomp_facts",
    "retrospective_processed_windows",
    "schema_migrations",
    "schema_migrations_meta",
    "session_facts",
    "session_meta",
    "session_projects",
    "shadow_embedding_registrations",
    "source_contents",
    "subagent_invocations",
    "synapse_batch_ledger",
    "tags",
    "task_schedule_state",
    "tool_definition_measurements",
    "tool_owner_backfill_state",
    "transform_decisions",
    "user_memories",
    "user_memory_candidates",
    "v22_backfill_failures",
    "v22_identity_rekey_map",
    "workspace_members",
    "workspaces",
] as const;

/**
 * Stamp the post-legacy migration fence (R21). A pre-cutover binary reads
 * `MAX(version) FROM schema_migrations WHERE version < 10000` and refuses to
 * open any database whose lane is newer than its own fence, so this single
 * row makes every legacy build fail closed against a direct-format database
 * without mutating it.
 */
export function stampDirectFormatFence(db: Database, nowMs: number = Date.now()): void {
    if (DIRECT_FORMAT_FENCE_MIGRATION_VERSION >= FORK_MIGRATION_VERSION_FLOOR) {
        throw new Error("direct-format fence version must stay below the downstream floor");
    }
    db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
    ).run(
        DIRECT_FORMAT_FENCE_MIGRATION_VERSION,
        "direct-format fence: this database uses the registered direct format, not the legacy migration lane",
        nowMs,
    );
}

/** Create every session-runtime object and stamp the legacy-lane fence row. */
export function createSessionRuntimeSchema(db: Database): void {
    db.exec(SESSION_RUNTIME_SCHEMA_DDL);
    stampDirectFormatFence(db);
}

const SESSION_RUNTIME_SCHEMA_DDL = `
CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      byte_size INTEGER,
      tag_number INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode',
      entry_fingerprint TEXT,
      token_count INTEGER,
      input_token_count INTEGER,
      reasoning_token_count INTEGER, reasoning_byte_size INTEGER DEFAULT 0, drop_mode TEXT DEFAULT 'full', tool_name TEXT, input_byte_size INTEGER DEFAULT 0, caveman_depth INTEGER DEFAULT 0, tool_owner_message_id TEXT DEFAULT NULL,
      UNIQUE(session_id, tag_number)
    );

CREATE TABLE pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

CREATE TABLE source_contents (
      tag_id INTEGER,
      session_id TEXT,
      content TEXT,
      created_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode',
      PRIMARY KEY(session_id, tag_id)
    );

CREATE TABLE compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      start_message_id TEXT DEFAULT '',
      end_message_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      p1 TEXT,
      p2 TEXT,
      p3 TEXT,
      p4 TEXT,
      importance INTEGER NOT NULL DEFAULT 50,
      episode_type TEXT,
      p1_embedding BLOB,
      p1_embedding_model_id TEXT,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      UNIQUE(session_id, sequence)
    );

CREATE TABLE session_projects (
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      project_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, harness)
    );

CREATE TABLE compartment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      compartment_id INTEGER,
      kind TEXT NOT NULL,
      at_compartment INTEGER,
      fields_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

CREATE TABLE compartment_state_lease (
      session_id TEXT PRIMARY KEY NOT NULL,
      holder_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

CREATE TABLE compression_depth (
      session_id TEXT NOT NULL,
      message_ordinal INTEGER NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode',
      PRIMARY KEY(session_id, message_ordinal)
    );

CREATE TABLE session_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

CREATE TABLE primer_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      normalized_question TEXT NOT NULL,
      source_compartment_start INTEGER,
      source_compartment_end INTEGER,
      source_start_message_id TEXT NOT NULL DEFAULT '',
      source_end_message_id TEXT NOT NULL DEFAULT '',
      source_message_time INTEGER NOT NULL,
      question_embedding BLOB,
      question_embedding_model_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(project_path, harness, session_id, source_start_message_id, source_end_message_id)
    );

CREATE TABLE primers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      question TEXT NOT NULL,
      question_embedding BLOB,
      question_embedding_model_id TEXT,
      answer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      total_support INTEGER NOT NULL DEFAULT 0,
      last_observed_at INTEGER,
      answer_refreshed_at INTEGER,
      source_candidate_ids TEXT NOT NULL DEFAULT '[]',
      source_candidate_provenance TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE VIRTUAL TABLE primers_fts USING fts5(
      question,
      answer,
      project_path UNINDEXED,
      content='primers',
      content_rowid='id',
      tokenize='porter unicode61'
    );

CREATE TABLE embedding_identity_active (
      project_path TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
      model_id TEXT NOT NULL,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY(project_path, scope, model_id)
    );

CREATE TABLE embedding_registrations (
      project_path TEXT PRIMARY KEY,
      provider_identity TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      chunk_model_id TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL DEFAULT '',
      table_epoch INTEGER NOT NULL DEFAULT 0,
      dims INTEGER NOT NULL DEFAULT 0,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      generation INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE synapse_batch_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL DEFAULT '',
            session_id TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT '',
            lane_role TEXT NOT NULL DEFAULT 'primary' CHECK(lane_role IN ('primary', 'shadow')),
            destination_model TEXT NOT NULL DEFAULT '',
            application_group TEXT NOT NULL DEFAULT '',
            request_key TEXT NOT NULL DEFAULT '',
            manifest_json TEXT NOT NULL DEFAULT '[]',
            state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'polling', 'ready', 'complete', 'failed', 'obsolete')),
            state_version INTEGER NOT NULL DEFAULT 0,
            attempt_id TEXT,
            job_id TEXT,
            cursor TEXT,
            deadline_at INTEGER,
            restart_count INTEGER NOT NULL DEFAULT 0,
            failure_disposition TEXT CHECK(failure_disposition IS NULL OR failure_disposition IN ('retryable', 'permanent')),
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );

CREATE TABLE shadow_embedding_registrations (
      project_path TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
      model_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT NOT NULL DEFAULT '',
      table_epoch INTEGER NOT NULL DEFAULT 0,
      dims INTEGER NOT NULL DEFAULT 0,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_path, scope, model_id)
    );

CREATE TABLE embedding_measurement_corpus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      dedup_key TEXT NOT NULL DEFAULT '',
      cohort_key TEXT NOT NULL DEFAULT '',
      query_text_hash TEXT NOT NULL DEFAULT '',
      primary_result_ids_json TEXT NOT NULL DEFAULT '[]',
      shadow_result_ids_json TEXT NOT NULL DEFAULT '[]',
      primary_latency_ms INTEGER,
      shadow_latency_ms INTEGER,
      primary_failed INTEGER NOT NULL DEFAULT 0,
      shadow_failed INTEGER NOT NULL DEFAULT 0,
      primary_model_id TEXT NOT NULL DEFAULT '',
      shadow_model_id TEXT NOT NULL DEFAULT '',
      primary_fingerprint TEXT NOT NULL DEFAULT '',
      shadow_fingerprint TEXT NOT NULL DEFAULT '',
      primary_epoch INTEGER NOT NULL DEFAULT 0,
      shadow_epoch INTEGER NOT NULL DEFAULT 0,
      corpus_hash TEXT NOT NULL DEFAULT '',
      coverage_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(dedup_key, cohort_key)
    );

CREATE TABLE dream_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE dream_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      reason TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      started_at INTEGER,
      retry_count INTEGER DEFAULT 0
    );

CREATE TABLE dream_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      holder_id TEXT NOT NULL,
      tasks_json TEXT NOT NULL,
      tasks_succeeded INTEGER NOT NULL DEFAULT 0,
      tasks_failed INTEGER NOT NULL DEFAULT 0,
      smart_notes_surfaced INTEGER NOT NULL DEFAULT 0,
      smart_notes_pending INTEGER NOT NULL DEFAULT 0,
      memory_changes_json TEXT,
      parent_session_id TEXT
    );

CREATE TABLE task_schedule_state (
      project_path  TEXT    NOT NULL,
      task          TEXT    NOT NULL,
      last_run_at   INTEGER,
      next_due_at   INTEGER,
      schedule      TEXT,
      last_status   TEXT,
      last_error    TEXT,
      last_checked_commit TEXT,
      last_broad_run_at INTEGER,
      retrospective_watermark_ms INTEGER,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_path, task)
    );

CREATE TABLE retrospective_processed_windows (
      project_path TEXT NOT NULL,
      window_key   TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      PRIMARY KEY (project_path, window_key)
    );

CREATE TABLE project_key_files (
      project_path           TEXT    NOT NULL,
      path                   TEXT    NOT NULL,
      content                TEXT    NOT NULL,
      content_hash           TEXT    NOT NULL,
      local_token_estimate   INTEGER NOT NULL,
      generated_at           INTEGER NOT NULL,
      generated_by_model     TEXT,
      generation_config_hash TEXT    NOT NULL,
      stale_reason           TEXT,
      PRIMARY KEY (project_path, path)
    );

CREATE TABLE project_key_files_version (
      project_path TEXT    PRIMARY KEY,
      version      INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE schema_migrations_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE project_state (
      project_path TEXT PRIMARY KEY,
      project_memory_epoch INTEGER NOT NULL DEFAULT 0,
      project_user_profile_version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE git_sweep_coordinator (
      project_path TEXT PRIMARY KEY,
      lease_holder TEXT,
      lease_expires_at INTEGER,
      last_swept_at INTEGER
    );

CREATE TABLE m0_mutation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      mutation_type TEXT NOT NULL CHECK (mutation_type IN (
        'compartment_delete', 'compartment_merge', 'recomp_boundary_change', 'compartment_upgrade'
      )),
      target_id INTEGER,
      queued_at INTEGER NOT NULL
    );

CREATE TABLE v22_identity_rekey_map (
      old_project_path TEXT PRIMARY KEY,
      new_project_path TEXT NOT NULL,
      rekeyed_at INTEGER NOT NULL
    );

CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
    );

CREATE TABLE workspace_members (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      display_path TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, project_path)
    );

CREATE TABLE v22_backfill_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      raw_project_path TEXT NOT NULL,
      error_class TEXT NOT NULL CHECK (error_class IN ('not_git_repo', 'git_missing', 'git_timeout', 'permission_denied', 'unknown')),
      error_message TEXT,
      failed_at INTEGER NOT NULL,
      UNIQUE(table_name, row_id)
    );

CREATE VIRTUAL TABLE message_history_fts USING fts5(
      session_id UNINDEXED,
      message_ordinal UNINDEXED,
      message_id UNINDEXED,
      role,
      content,
      tokenize='porter unicode61'
    );

CREATE TABLE message_history_index (
      session_id TEXT PRIMARY KEY,
      last_indexed_ordinal INTEGER NOT NULL DEFAULT 0,
      dirty_floor_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

CREATE TABLE message_history_source (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_ordinal INTEGER NOT NULL,
      source_version TEXT NOT NULL,
      normalized_content_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, message_id)
    );

CREATE TABLE pending_session_cleanup (
      session_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL DEFAULT 'opencode',
      requested_at INTEGER NOT NULL,
      last_attempt_at INTEGER
    );

CREATE TABLE message_history_orphan_sweep (
      harness TEXT PRIMARY KEY,
      cursor_session_id TEXT NOT NULL DEFAULT '',
      last_swept_at INTEGER
    );

CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL DEFAULT 'opencode',
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_nudge_undropped INTEGER DEFAULT 0,
      last_nudge_level TEXT DEFAULT '',
      channel2_nudge_state TEXT DEFAULT '',
      channel2_nudge_claimed_at INTEGER DEFAULT 0,
      channel2_nudge_claim_token TEXT DEFAULT '',
      last_emergency_input_sample INTEGER DEFAULT 0,
      last_transform_error TEXT DEFAULT '',
      nudge_anchor_message_id TEXT DEFAULT '',
      nudge_anchor_text TEXT DEFAULT '',
      sticky_turn_reminder_text TEXT DEFAULT '',
      sticky_turn_reminder_message_id TEXT DEFAULT '',
      note_nudge_trigger_pending INTEGER DEFAULT 0,
      note_nudge_trigger_message_id TEXT DEFAULT '',
      note_nudge_sticky_text TEXT DEFAULT '',
      note_nudge_sticky_message_id TEXT DEFAULT '',
      note_nudge_anchors TEXT NOT NULL DEFAULT '[]',
      auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]',
      last_todo_state TEXT DEFAULT '',
      todo_permission_denied INTEGER NOT NULL DEFAULT 2,
      todo_synthetic_call_id TEXT DEFAULT '',
      todo_synthetic_anchor_message_id TEXT DEFAULT '',
      todo_synthetic_state_json TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
      detected_context_limit_provenance TEXT NOT NULL DEFAULT 'unknown',
      observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_alert_sent INTEGER NOT NULL DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      historian_failure_count INTEGER DEFAULT 0,
      historian_last_error TEXT DEFAULT NULL,
      historian_last_failure_at INTEGER DEFAULT NULL,
      system_prompt_hash TEXT DEFAULT '',
      memory_block_cache TEXT DEFAULT '',
      memory_block_count INTEGER DEFAULT 0,
      memory_block_ids TEXT DEFAULT '',
      memory_block_hashes TEXT DEFAULT '',
      -- memory_block_epoch: intentionally NULLABLE. NULL means "no epoch
      -- stamp" (legacy row or never snapshotted); it never equals a real
      -- epoch, so such rows rebuild once and then carry a stamp.
      memory_block_epoch INTEGER,
      -- pending_compaction_marker_state: intentionally NULLABLE without a
      -- default. Absence of a deferred marker is SQL NULL; presence is a
      -- valid JSON blob written via setPendingCompactionMarkerState.
      -- Excluded from the healAllNullColumns fallback list. Readers filter
      -- IS NOT NULL AND != empty-string defensively. Plan v6 section 3.
      pending_compaction_marker_state TEXT,
      -- Target OpenCode message id used to inject the current compaction marker.
      -- Nullable for legacy persisted markers; repaired on the next marker move.
      compaction_marker_target_end_message_id TEXT,
      -- pending_pi_compaction_marker_state: intentionally NULLABLE without a
      -- default. Absence of a deferred Pi-native marker is SQL NULL; presence
      -- is a valid JSON blob written via setPendingPiCompactionMarkerState.
      -- Excluded from the healAllNullColumns fallback list.
      pending_pi_compaction_marker_state TEXT,
      new_work_tokens INTEGER NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      -- deferred_execute_state: intentionally NULLABLE without a default.
      -- Absence is SQL NULL; presence is a JSON blob written via
      -- setDeferredExecutePendingIfAbsent. Excluded from the
      -- healAllNullColumns fallback list.
      deferred_execute_state TEXT,
      cached_m0_bytes BLOB,
      cached_m0_claim_format_epoch INTEGER,
      cached_m0_claim_snapshot_vector TEXT,
      cached_m0_rendered_revision_locators TEXT,
      cached_m0_project_memory_epoch INTEGER,
      cached_m0_workspace_fingerprint TEXT,
      cached_m0_project_user_profile_version INTEGER,
      cached_m0_max_compartment_seq INTEGER,
      cached_m0_max_memory_id INTEGER,
      cached_m0_max_mutation_id INTEGER,
      cached_m0_max_memory_mutation_id INTEGER,
      cached_m0_project_docs_hash TEXT,
      cached_m1_bytes BLOB,
      last_observed_model_key TEXT,
      last_usage_context_limit INTEGER NOT NULL DEFAULT 0,
      prior_boundary_ordinal INTEGER NOT NULL DEFAULT 1,
      protected_tail_policy_version INTEGER NOT NULL DEFAULT 0,
      protected_tail_drain_window_started_at INTEGER NOT NULL DEFAULT 0,
      protected_tail_drain_tokens INTEGER NOT NULL DEFAULT 0,
      recovery_no_eligible_head_count INTEGER NOT NULL DEFAULT 0,
      force_emergency_bypass_window_start INTEGER NOT NULL DEFAULT 0,
      force_emergency_bypass_used INTEGER NOT NULL DEFAULT 0,
      emergency_drain_active INTEGER NOT NULL DEFAULT 0,
      historian_drain_failure_at INTEGER NOT NULL DEFAULT 0,
      wrapup_in_progress_state TEXT,
      compaction_mode_record TEXT,
      cached_m0_materialized_at INTEGER,
      cached_m0_session_facts_version INTEGER,
      cached_m0_upgrade_state TEXT,
      cached_m0_system_hash TEXT,
      cached_m0_tool_set_hash TEXT,
      cached_m0_model_key TEXT,
      cached_m0_project_identity TEXT,
      cached_m0_last_baseline_end_message_id TEXT,
       upgrade_reminded_at INTEGER,
       pi_stable_id_scheme INTEGER
    , note_last_read_at INTEGER DEFAULT 0, cleared_reasoning_through_tag INTEGER DEFAULT 0, tool_reclaim_watermark INTEGER DEFAULT 0, stripped_placeholder_ids TEXT DEFAULT '', stale_reduce_stripped_ids TEXT DEFAULT '', processed_image_stripped_ids TEXT DEFAULT '', merged_reasoning_stripped_ids TEXT DEFAULT '', trailing_blank_decisions TEXT DEFAULT '', system_prompt_tokens INTEGER DEFAULT 0, compaction_marker_state TEXT DEFAULT '', key_files TEXT DEFAULT '', conversation_tokens INTEGER DEFAULT 0, tool_call_tokens INTEGER DEFAULT 0, recomp_partial_range_start INTEGER DEFAULT 0, recomp_partial_range_end INTEGER DEFAULT 0, detected_context_limit INTEGER DEFAULT 0, detected_context_limit_model_key TEXT, needs_emergency_recovery INTEGER DEFAULT 0, emergency_recovery_origin TEXT DEFAULT '', upgrade_reminder_last_sent_at INTEGER, upgrade_reminder_count INTEGER NOT NULL DEFAULT 0, cached_m0_mural_data_url TEXT, cached_m0_mural_hash TEXT);

CREATE TABLE tool_owner_backfill_state (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped')),
      started_at INTEGER,
      lease_expires_at INTEGER,
      completed_at INTEGER,
      last_error TEXT
    );

CREATE TABLE subagent_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      subagent TEXT NOT NULL,
      task TEXT,
      provider_id TEXT,
      model_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      parent_invocation_id INTEGER
    );

CREATE TABLE historian_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      subagent_invocation_id INTEGER,
      run_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT,
      chunk_start_ordinal INTEGER,
      chunk_end_ordinal INTEGER,
      unprocessed_from INTEGER,
      compartments_produced INTEGER NOT NULL DEFAULT 0,
      compartment_id_min INTEGER,
      compartment_id_max INTEGER,
      facts_emitted INTEGER NOT NULL DEFAULT 0,
      facts_by_category_json TEXT,
      events_emitted INTEGER NOT NULL DEFAULT 0,
      importance_min INTEGER,
      importance_max INTEGER,
      importance_avg REAL,
      discarded_last INTEGER NOT NULL DEFAULT 0,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

CREATE TABLE transform_decisions (
      session_id         TEXT    NOT NULL,
      harness            TEXT    NOT NULL DEFAULT 'opencode',
      message_id         TEXT    NOT NULL,
      ts_ms              INTEGER NOT NULL,
      decision           TEXT    NOT NULL,
      materialized       INTEGER NOT NULL DEFAULT 0,
      materialize_reason TEXT,
      emergency          INTEGER NOT NULL DEFAULT 0,
      dropped_tokens     INTEGER NOT NULL DEFAULT 0,
      dropped_count      INTEGER NOT NULL DEFAULT 0,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, harness, message_id)
    );

CREATE TABLE recomp_compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      start_message_id TEXT DEFAULT '',
      end_message_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      p1 TEXT,
      p2 TEXT,
      p3 TEXT,
      p4 TEXT,
      importance INTEGER NOT NULL DEFAULT 50,
      episode_type TEXT,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      UNIQUE(session_id, sequence)
    );

CREATE TABLE recomp_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

CREATE TABLE identity_merge_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         from_identity TEXT NOT NULL,
         to_identity TEXT NOT NULL,
         table_name TEXT NOT NULL,
         row_id TEXT NOT NULL,
         action TEXT NOT NULL,
         target_row_id TEXT,
         merged_at INTEGER NOT NULL
       );

CREATE TABLE schema_migrations (
			version INTEGER PRIMARY KEY,
			description TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		);

CREATE TABLE notes (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					type TEXT NOT NULL DEFAULT 'session',
					status TEXT NOT NULL DEFAULT 'active',
					content TEXT NOT NULL,
					session_id TEXT,
					project_path TEXT,
					surface_condition TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					last_checked_at INTEGER,
					ready_at INTEGER,
					ready_reason TEXT,
					compiled_provider TEXT,
					compiled_config TEXT,
					compiled_at INTEGER,
					compile_status TEXT CHECK(compile_status IN ('compiled', 'plain', 'refused'))
				, harness TEXT NOT NULL DEFAULT 'opencode', anchor_ordinal INTEGER, compiled_check TEXT, manifest_json TEXT, check_hash TEXT, check_cron TEXT, check_version INTEGER NOT NULL DEFAULT 0, check_status TEXT NOT NULL DEFAULT 'uncompiled', check_failure_count INTEGER NOT NULL DEFAULT 0, check_network_failure_count INTEGER NOT NULL DEFAULT 0, check_quarantined_until INTEGER, check_next_due_at INTEGER, check_compiled_at INTEGER, check_false_since_at INTEGER, check_last_liveness_at INTEGER, policy_version INTEGER NOT NULL DEFAULT 1, anchor_block_id TEXT, source_revision INTEGER NOT NULL DEFAULT 0, state_version INTEGER NOT NULL DEFAULT 0);

CREATE TABLE plugin_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					direction TEXT NOT NULL,
					type TEXT NOT NULL,
					payload TEXT NOT NULL DEFAULT '{}',
					session_id TEXT,
					created_at INTEGER NOT NULL,
					consumed_at INTEGER
				);

CREATE TABLE user_memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    source_compartment_start INTEGER,
                    source_compartment_end INTEGER,
                    created_at INTEGER NOT NULL
                );

CREATE TABLE user_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    promoted_at INTEGER NOT NULL,
                    source_candidate_ids TEXT DEFAULT '[]',
                    source_candidate_provenance TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

CREATE TABLE git_commits (
                    sha TEXT PRIMARY KEY,
                    project_path TEXT NOT NULL,
                    short_sha TEXT NOT NULL,
                    message TEXT NOT NULL,
                    author TEXT,
                    committed_at INTEGER NOT NULL,
                    indexed_at INTEGER NOT NULL
                );

CREATE VIRTUAL TABLE git_commits_fts USING fts5(
                    sha UNINDEXED,
                    project_path UNINDEXED,
                    message,
                    tokenize = 'porter unicode61'
                );

CREATE TABLE tool_definition_measurements (
                    provider_id TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    tool_id TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    recorded_at INTEGER NOT NULL,
                    PRIMARY KEY (provider_id, model_id, agent_name, tool_id)
                );

CREATE TABLE "git_commit_embeddings" (
                        sha TEXT NOT NULL,
                        embedding BLOB NOT NULL,
                        model_id TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        PRIMARY KEY(sha, model_id),
                        FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
                    );

CREATE TABLE "compartment_chunk_embeddings" (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
                        session_id TEXT NOT NULL,
                        project_path TEXT NOT NULL,
                        harness TEXT NOT NULL DEFAULT 'opencode',
                        window_index INTEGER NOT NULL DEFAULT 0,
                        start_ordinal INTEGER NOT NULL,
                        end_ordinal INTEGER NOT NULL,
                        chunk_hash TEXT NOT NULL,
                        model_id TEXT NOT NULL,
                        dims INTEGER NOT NULL,
                        vector BLOB NOT NULL,
                        created_at INTEGER NOT NULL,
                        UNIQUE(compartment_id, model_id, window_index)
                    );

CREATE TABLE context_store_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

CREATE TABLE authority_managed (
                    project_path TEXT PRIMARY KEY,
                    context_store_uuid TEXT NOT NULL,
                    marked_at INTEGER NOT NULL
                );

CREATE TABLE authority_repair_pending (
                    project_path TEXT PRIMARY KEY,
                    started_at INTEGER NOT NULL
                );

CREATE TABLE mirror_identity (
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    context_row_id INTEGER NOT NULL,
                    PRIMARY KEY(domain, module_project, module_row_id),
                    UNIQUE(domain, context_row_id)
                );

CREATE TABLE mirror_cursors (
                    domain TEXT PRIMARY KEY CHECK(domain IN ('memories', 'notes')),
                    cursor INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );

CREATE TABLE context_privilege_state (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
                );

CREATE TABLE authority_capture_bounds (
                    project_path TEXT NOT NULL,
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    max_rowid INTEGER NOT NULL,
                    data_version INTEGER NOT NULL,
                    captured_at INTEGER NOT NULL, mutation_epoch INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(project_path, domain)
                );

CREATE TABLE mirror_pending_references (
                    domain TEXT NOT NULL CHECK(domain = 'memories'),
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    target_module_row_id INTEGER NOT NULL,
                    PRIMARY KEY(domain, module_project, module_row_id)
                );

CREATE TABLE mirror_note_revisions (
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    context_row_id INTEGER NOT NULL,
                    status_version INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(module_project, module_row_id),
                    UNIQUE(context_row_id)
                );

CREATE TABLE domain_mutation_epoch (
                    project_path TEXT NOT NULL,
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    epoch INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(project_path, domain)
                );

CREATE TABLE mirror_live_memory_rows (
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL, full_row_snapshot TEXT,
                    PRIMARY KEY(module_project, module_row_id)
                );

CREATE TABLE mirror_resnapshot_state (
                    domain TEXT PRIMARY KEY CHECK(domain = 'memories'),
                    status TEXT NOT NULL CHECK(status IN ('pending_check', 'resnapshotting', 'complete')),
                    updated_at INTEGER NOT NULL
                , generation TEXT);

CREATE TABLE mirror_live_staging (
                    generation TEXT NOT NULL,
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL, full_row_snapshot TEXT,
                    PRIMARY KEY(generation, module_project, module_row_id)
                );

CREATE TABLE mural_manifest (
                    project_path TEXT PRIMARY KEY,
                    image BLOB NOT NULL,
                    content_hash TEXT NOT NULL,
                    rendered_at INTEGER NOT NULL,
                    model TEXT,
                    memory_ids_json TEXT NOT NULL DEFAULT '[]',
                    width INTEGER NOT NULL DEFAULT 1092,
                    height INTEGER NOT NULL DEFAULT 1092
                );

CREATE TABLE migration_pending (
                    migration_key TEXT PRIMARY KEY,
                    source_session_id TEXT NOT NULL,
                    target_harness TEXT NOT NULL,
                    pi_session_id TEXT NOT NULL,
                    final_path TEXT NOT NULL,
                    stage_path TEXT NOT NULL,
                    content_sha256 TEXT NOT NULL,
                    phase TEXT NOT NULL CHECK (phase IN ('staged', 'db_committed')),
                    created_at INTEGER NOT NULL
                );

CREATE VIRTUAL TABLE notes_fts USING fts5(
            searchable_text,
            content='notes_search_view',
            content_rowid='id',
            tokenize='trigram'
        );

CREATE INDEX idx_compartments_session ON compartments(session_id);

CREATE INDEX idx_session_projects_project
      ON session_projects(project_path);

CREATE INDEX idx_compartment_events_session
      ON compartment_events(session_id);

CREATE INDEX idx_compartment_state_lease_expires
      ON compartment_state_lease(expires_at);

CREATE INDEX idx_compression_depth_session ON compression_depth(session_id);

CREATE INDEX idx_primer_candidates_project_time
      ON primer_candidates(project_path, source_message_time);

CREATE INDEX idx_primer_candidates_session
      ON primer_candidates(session_id, harness);

CREATE INDEX idx_primer_candidates_embedding_model
      ON primer_candidates(project_path, question_embedding_model_id);

CREATE INDEX idx_primers_project_status_observed
      ON primers(project_path, status, last_observed_at DESC);

CREATE INDEX idx_primers_embedding_model
      ON primers(project_path, question_embedding_model_id);

CREATE INDEX idx_embedding_measurement_session
      ON embedding_measurement_corpus(session_id, created_at);

CREATE INDEX idx_dream_queue_project ON dream_queue(project_path);

CREATE INDEX idx_dream_queue_pending ON dream_queue(started_at, enqueued_at);

CREATE INDEX idx_dream_runs_project ON dream_runs(project_path, finished_at DESC);

CREATE INDEX idx_task_schedule_due ON task_schedule_state(next_due_at);

CREATE INDEX idx_project_key_files_project ON project_key_files(project_path);

CREATE INDEX idx_project_key_files_generated_at ON project_key_files(project_path, generated_at);

CREATE INDEX idx_git_sweep_coordinator_lease_expires
      ON git_sweep_coordinator(lease_expires_at);

CREATE INDEX idx_git_sweep_coordinator_last_swept
      ON git_sweep_coordinator(last_swept_at);

CREATE INDEX idx_m0_mutation_log_session ON m0_mutation_log(session_id);

CREATE UNIQUE INDEX idx_workspace_member_unique ON workspace_members(project_path);

CREATE UNIQUE INDEX idx_workspace_member_name ON workspace_members(workspace_id, display_name);

CREATE INDEX idx_message_history_index_orphan_sweep
      ON message_history_index(harness, session_id, updated_at);

CREATE INDEX idx_message_history_source_session_ordinal
      ON message_history_source(session_id, message_ordinal);

CREATE INDEX idx_tool_owner_backfill_state_status
      ON tool_owner_backfill_state(status);

CREATE INDEX idx_sai_session_started
      ON subagent_invocations(session_id, started_at DESC);

CREATE INDEX idx_sai_subagent
      ON subagent_invocations(subagent, started_at DESC);

CREATE INDEX idx_historian_runs_session
      ON historian_runs(session_id, created_at DESC);

CREATE INDEX idx_historian_runs_status
      ON historian_runs(status, created_at DESC);

CREATE INDEX idx_transform_decisions_session_harness
      ON transform_decisions(session_id, harness);

CREATE INDEX idx_tags_session_tag_number ON tags(session_id, tag_number);

CREATE INDEX idx_tags_session_message_id ON tags(session_id, message_id);

CREATE INDEX idx_pending_ops_session ON pending_ops(session_id);

CREATE INDEX idx_pending_ops_session_tag_id ON pending_ops(session_id, tag_id);

CREATE INDEX idx_source_contents_session ON source_contents(session_id);

CREATE INDEX idx_session_facts_session ON session_facts(session_id);

CREATE INDEX idx_recomp_compartments_session ON recomp_compartments(session_id);

CREATE INDEX idx_recomp_facts_session ON recomp_facts(session_id);

CREATE INDEX idx_message_history_index_updated_at ON message_history_index(updated_at);

CREATE UNIQUE INDEX idx_primer_candidates_occurrence
        ON primer_candidates(project_path, harness, session_id, source_start_message_id, source_end_message_id);

CREATE UNIQUE INDEX idx_synapse_batch_ledger_identity
            ON synapse_batch_ledger(project_path, session_id, scope, lane_role, destination_model, application_group, request_key)
            WHERE state != 'obsolete';

CREATE INDEX idx_synapse_batch_ledger_session
            ON synapse_batch_ledger(session_id, updated_at);

CREATE INDEX idx_tags_pi_adopt
            ON tags(session_id, entry_fingerprint)
            WHERE type='message' AND entry_fingerprint IS NOT NULL;

CREATE INDEX idx_tags_pi_fallback_tool_owner
            ON tags(session_id, tool_owner_message_id)
            WHERE type='tool';

CREATE INDEX idx_identity_merge_log_identities
         ON identity_merge_log(from_identity, to_identity, merged_at);

CREATE INDEX idx_identity_merge_log_table_row
         ON identity_merge_log(table_name, row_id);

CREATE INDEX idx_notes_session_status ON notes(session_id, status);

CREATE INDEX idx_notes_project_status ON notes(project_path, status);

CREATE INDEX idx_notes_type_status ON notes(type, status);

CREATE INDEX idx_plugin_messages_direction_consumed
					ON plugin_messages(direction, consumed_at);

CREATE INDEX idx_plugin_messages_created
					ON plugin_messages(created_at);

CREATE INDEX idx_umc_created ON user_memory_candidates(created_at);

CREATE INDEX idx_um_status ON user_memories(status);

CREATE INDEX idx_git_commits_project_time
                    ON git_commits(project_path, committed_at DESC);

CREATE INDEX idx_tags_active_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'active';

CREATE INDEX idx_tags_dropped_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'dropped';

CREATE UNIQUE INDEX idx_tags_tool_composite
                ON tags(session_id, message_id, tool_owner_message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NOT NULL;

CREATE INDEX idx_tags_tool_null_owner
                ON tags(session_id, message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NULL;

CREATE INDEX idx_notes_smart_checks_due
                    ON notes(project_path, check_status, check_next_due_at)
                    WHERE type = 'smart' AND status = 'pending';

CREATE INDEX idx_notes_smart_checks_liveness
                    ON notes(project_path, check_false_since_at, check_last_liveness_at)
                    WHERE type = 'smart' AND status = 'pending';

CREATE INDEX idx_cce_session ON compartment_chunk_embeddings(session_id);

CREATE INDEX idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);

CREATE INDEX idx_mirror_pending_reference_target
                    ON mirror_pending_references(domain, module_project, target_module_row_id);

CREATE INDEX idx_mirror_live_memory_content
                    ON mirror_live_memory_rows(module_project, category, normalized_hash);

CREATE INDEX idx_mirror_live_staging_generation
                    ON mirror_live_staging(generation);

CREATE TRIGGER primers_ai AFTER INSERT ON primers BEGIN
      INSERT INTO primers_fts(rowid, question, answer, project_path)
      VALUES (new.id, new.question, new.answer, new.project_path);
    END;

CREATE TRIGGER primers_ad AFTER DELETE ON primers BEGIN
      INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
      VALUES ('delete', old.id, old.question, old.answer, old.project_path);
    END;

CREATE TRIGGER primers_au AFTER UPDATE ON primers BEGIN
      INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
      VALUES ('delete', old.id, old.question, old.answer, old.project_path);
      INSERT INTO primers_fts(rowid, question, answer, project_path)
      VALUES (new.id, new.question, new.answer, new.project_path);
    END;

CREATE TRIGGER git_commits_fts_insert
                AFTER INSERT ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = NEW.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;

CREATE TRIGGER git_commits_fts_delete
                AFTER DELETE ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                END;

CREATE TRIGGER git_commits_fts_update
                AFTER UPDATE OF message, project_path ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;

CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, searchable_text)
                VALUES (new.id, CASE
                WHEN new.ready_reason IS NOT NULL AND trim(new.ready_reason) <> ''
                THEN new.content || char(10) || 'Reason: ' || trim(new.ready_reason)
                ELSE new.content
            END);
        END;

CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, searchable_text)
                VALUES ('delete', old.id, CASE
                WHEN old.ready_reason IS NOT NULL AND trim(old.ready_reason) <> ''
                THEN old.content || char(10) || 'Reason: ' || trim(old.ready_reason)
                ELSE old.content
            END);
        END;

CREATE TRIGGER notes_fts_au AFTER UPDATE OF content, ready_reason ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, searchable_text)
                VALUES ('delete', old.id, CASE
                WHEN old.ready_reason IS NOT NULL AND trim(old.ready_reason) <> ''
                THEN old.content || char(10) || 'Reason: ' || trim(old.ready_reason)
                ELSE old.content
            END);
            INSERT INTO notes_fts(rowid, searchable_text)
                VALUES (new.id, CASE
                WHEN new.ready_reason IS NOT NULL AND trim(new.ready_reason) <> ''
                THEN new.content || char(10) || 'Reason: ' || trim(new.ready_reason)
                ELSE new.content
            END);
        END;

CREATE TRIGGER notes_authority_guard_insert
            BEFORE INSERT ON notes
            WHEN (
        EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_managed am ON am.project_path = sp.project_path
            WHERE sp.session_id = NEW.session_id
        )
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_repair_pending arp ON arp.project_path = sp.project_path
            WHERE sp.session_id = NEW.session_id
        )
    ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;

CREATE TRIGGER notes_authority_guard_update
            BEFORE UPDATE ON notes
            WHEN ((
        EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_managed am ON am.project_path = sp.project_path
            WHERE sp.session_id = OLD.session_id
        )
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_repair_pending arp ON arp.project_path = sp.project_path
            WHERE sp.session_id = OLD.session_id
        )
    ) OR (
        EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_managed am ON am.project_path = sp.project_path
            WHERE sp.session_id = NEW.session_id
        )
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_repair_pending arp ON arp.project_path = sp.project_path
            WHERE sp.session_id = NEW.session_id
        )
    )) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;

CREATE TRIGGER notes_authority_guard_delete
            BEFORE DELETE ON notes
            WHEN (
        EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_managed am ON am.project_path = sp.project_path
            WHERE sp.session_id = OLD.session_id
        )
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_repair_pending arp ON arp.project_path = sp.project_path
            WHERE sp.session_id = OLD.session_id
        )
    ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;

CREATE VIEW notes_search_view AS
            SELECT id AS id, CASE
                WHEN notes.ready_reason IS NOT NULL AND trim(notes.ready_reason) <> ''
                THEN notes.content || char(10) || 'Reason: ' || trim(notes.ready_reason)
                ELSE notes.content
            END AS searchable_text
              FROM notes;
`;
