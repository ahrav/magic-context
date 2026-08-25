import { extractTiersFromInner } from "../../hooks/magic-context/compartment-parser";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    CLAIMS_BACKFILL_MODE_REASON_META_KEY,
    decideClaimsBackfillMode,
    hitClaimsMigrationFailpoint,
    runEagerClaimsBackfillInMigrationTransaction,
} from "./claims-backfill";
import {
    addObservationSourceTrustClassColumn,
    assertClaimApplicabilitySchemaForeignKeys,
    CLAIM_APPLICABILITY_TABLES,
    createClaimApplicabilitySchema,
    missingClaimApplicabilitySchemaObjects,
    observationSourceTrustClassColumnExists,
    seedApplicabilityBaselines,
} from "./storage-claim-applicability-schema";
import {
    assertClaimPolicySchemaForeignKeys,
    CLAIM_POLICY_SEED_META_KEYS,
    CLAIM_POLICY_TABLES,
    createClaimPolicySchema,
    missingClaimPolicySchemaObjects,
} from "./storage-claim-policy-schema";
import {
    assertClaimsSchemaForeignKeys,
    CLAIMS_AND_EVIDENCE_TABLES,
    createClaimsAndEvidenceSchema,
} from "./storage-claims-schema";
import {
    assertMemoryClaimsSchemaForeignKeys,
    CLAIMS_BACKFILL_META_KEYS,
    createMemoryClaimsCompatSchema,
    installMemoryClaimsWriteGuards,
    MEMORY_CLAIMS_COMPAT_TABLES,
} from "./storage-memory-claims-schema";
import {
    assertProjectRegistrySeed,
    resolveProjectIdentitySeed,
    seedProjectRegistry,
    tableExists,
} from "./storage-project-identities";
import {
    ensureColumn,
    healAllNullColumns,
    MEMORIES_AU_TRIGGER_BODY,
    synapseBatchLedgerDdl,
    synapseBatchLedgerIndexDdl,
} from "./storage-schema-helpers";
import { bumpEpochsForWorkspaceMemberSet } from "./workspaces";

const V22_BACKFILL_META_KEY = "v22_legacy_memory_backfill";

/** First version reserved for downstream migrations; upstream versions stay below it. */
export const FORK_MIGRATION_VERSION_FLOOR = 10_000;

export const DIRECT_FORMAT_SUPERSEDED_MIGRATION_HEAD = 89;

/**
 * Versioned migration framework for magic-context's SQLite database.
 *
 * Each migration is a function that runs inside a transaction.
 * Migrations are applied sequentially on startup — skipping any
 * that have already run. This handles multi-version jumps cleanly
 * (e.g. upgrading from 0.4 to 0.7 runs all intermediate migrations).
 *
 * To add a new migration:
 * 1. Append a new entry to the MIGRATIONS array
 * 2. The version number is the array index + 1
 * 3. The migration runs in a transaction — if it throws, it rolls back
 */

interface Migration {
    version: number;
    description: string;
    up: (db: Database) => void;
}

const MIGRATION_LOCK_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export class MigrationLockBusyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MigrationLockBusyError";
    }
}

function isSqliteLockError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { code?: unknown; message?: unknown };
    if (candidate.code === "SQLITE_BUSY" || candidate.code === "SQLITE_LOCKED") return true;
    return (
        typeof candidate.message === "string" &&
        /database is locked|sqlite_(busy|locked)/i.test(candidate.message)
    );
}

/**
 * Heal compartments stranded by a mismatched tier closing tag (issue #246).
 *
 * Before the lenient parser, a model that closed `<p1>` with `</p2>` made the
 * strict tier regex miss P1 entirely, so the compartment stored as a flat legacy
 * row: the whole tier markup landed in `content`, p1 stayed NULL, and legacy=1
 * (which also trips the false "Historian V2 upgrade" nag). This re-runs the
 * lenient tier extraction over `content`; when P1 comes out non-empty it fills
 * the four tier columns — with the same denser→denser fallbacks the parser uses
 * at ingest — and clears legacy, leaving `content` untouched. Rows that still
 * don't parse keep legacy=1. Idempotent: healed rows no longer match the
 * predicate, and the scan touches only the finite matching set (no full-table
 * rewrite).
 *
 * `hasLegacy` distinguishes `compartments` (has a `legacy` column to clear) from
 * `recomp_compartments` (same tier columns, but no `legacy` column).
 */
function healMismatchedTierClose(db: Database, table: string, hasLegacy: boolean): void {
    if (!tableExists(db, table)) return;
    const columns = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (row) => row.name,
        ),
    );
    for (const required of ["content", "p1", "p2", "p3", "p4"]) {
        if (!columns.has(required)) return;
    }
    if (hasLegacy && !columns.has("legacy")) return;

    const predicate = hasLegacy
        ? "legacy = 1 AND p1 IS NULL AND content LIKE '%<p1%'"
        : "p1 IS NULL AND content LIKE '%<p1%'";
    const rows = db.prepare(`SELECT id, content FROM ${table} WHERE ${predicate}`).all() as Array<{
        id: number;
        content: string;
    }>;

    const update = db.prepare(
        `UPDATE ${table} SET p1 = ?, p2 = ?, p3 = ?, p4 = ?${hasLegacy ? ", legacy = 0" : ""} WHERE id = ?`,
    );
    for (const row of rows) {
        const tiers = extractTiersFromInner(row.content);
        // Only heal when P1 actually extracts; otherwise leave the row legacy.
        if (typeof tiers.p1 !== "string" || tiers.p1.length === 0) continue;
        const p1 = tiers.p1;
        // Mirror the parser's denser→denser fallbacks so a healed row is shaped
        // exactly like one that parsed correctly at ingest.
        const p2 = typeof tiers.p2 === "string" ? tiers.p2 : p1;
        const p3 = typeof tiers.p3 === "string" ? tiers.p3 : p2;
        const p4 = typeof tiers.p4 === "string" ? tiers.p4 : "";
        update.run(p1, p2, p3, p4, row.id);
    }
}

function assertForeignKeyIntegrity(db: Database, table?: string): void {
    // Scope the check to the table just rebuilt. A GLOBAL foreign_key_check after
    // the FIRST rebuild also inspects the OTHER embedding tables, which still
    // carry their pre-v49 schema + any pre-existing orphans (their own orphan
    // pre-clean + rebuild run later in this migration) — a global check would
    // fail the whole migration closed on an orphan we are about to clean anyway.
    const rows = (
        table
            ? db.prepare(`PRAGMA foreign_key_check(${table})`)
            : db.prepare("PRAGMA foreign_key_check")
    ).all() as unknown[];
    if (rows.length > 0) {
        throw new Error(
            `foreign_key_check failed after embedding table rebuild${table ? ` (${table})` : ""} (${rows.length} violation(s))`,
        );
    }
}

/**
 * SQL predicate that guards managed-write triggers fire only for UNPRIVILEGED
 * writers.
 *
 * This must ALWAYS be the durable `context_privilege_state` table check, never a
 * connection-local scalar UDF. Triggers are DURABLE database artifacts: their SQL
 * is stored in the file and re-evaluated on EVERY connection that opens context.db.
 * A UDF such as the former `mc_privileged_writer()` only exists on connections that
 * registered it, so a trigger baked with that reference fails with `no such function`
 * on any connection that did not (older Bun without scalar-UDF support, node:sqlite,
 * the dashboard's rusqlite). The state table is ordinary schema every connection can
 * read, so the guard works identically everywhere. Privileged writers flip
 * `context_privilege_state.enabled` inside their own BEGIN IMMEDIATE transaction
 * (see withPrivilegedWriter), which no second connection can observe.
 */
function authorityPrivilegeCheck(): string {
    return "COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0";
}

function managedAuthorityNoteRow(row: "OLD" | "NEW"): string {
    return `(
        EXISTS (SELECT 1 FROM authority_managed WHERE project_path = ${row}.project_path)
        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = ${row}.project_path)
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_managed am ON am.project_path = sp.project_path
            WHERE sp.session_id = ${row}.session_id
        )
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_repair_pending arp ON arp.project_path = sp.project_path
            WHERE sp.session_id = ${row}.session_id
        )
    )`;
}

/** Install the latest authority fences after historical/recovery migration batches. */
function installLatestAuthorityTriggers(db: Database): void {
    const privilegeCheck = authorityPrivilegeCheck();
    if (tableExists(db, "memories")) {
        // pi-lens-ignore: sql-injection
        db.exec(`
            DROP TRIGGER IF EXISTS memories_authority_guard_insert;
            DROP TRIGGER IF EXISTS memories_authority_guard_update;
            DROP TRIGGER IF EXISTS memories_authority_guard_delete;
            CREATE TRIGGER memories_authority_guard_insert
            BEFORE INSERT ON memories
            WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
              AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
            CREATE TRIGGER memories_authority_guard_update
            BEFORE UPDATE ON memories
            WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
               OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
              AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
            CREATE TRIGGER memories_authority_guard_delete
            BEFORE DELETE ON memories
            WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
              AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
        `);
    }
    if (tableExists(db, "notes")) {
        const managedOld = managedAuthorityNoteRow("OLD");
        const managedNew = managedAuthorityNoteRow("NEW");
        // pi-lens-ignore: sql-injection
        db.exec(`
            DROP TRIGGER IF EXISTS notes_authority_guard_insert;
            DROP TRIGGER IF EXISTS notes_authority_guard_update;
            DROP TRIGGER IF EXISTS notes_authority_guard_delete;
            CREATE TRIGGER notes_authority_guard_insert
            BEFORE INSERT ON notes
            WHEN ${managedNew} AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
            CREATE TRIGGER notes_authority_guard_update
            BEFORE UPDATE ON notes
            WHEN (${managedOld} OR ${managedNew}) AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
            CREATE TRIGGER notes_authority_guard_delete
            BEFORE DELETE ON notes
            WHEN ${managedOld} AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
        `);
    }
}

function noteColumnExists(db: Database, column: string): boolean {
    const rows = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === column);
}

/**
 * Replace `memories_au` with a value-sensitive definition scoped to the two
 * FTS-indexed columns. `UPDATE OF` alone still fires when an unchanged
 * content/category value appears in the SET list (mirror full-row snapshots do
 * exactly that), so the WHEN clause compares old and new values — an update
 * that changes neither indexed value performs no FTS maintenance.
 */
function installValueSensitiveMemoriesFtsUpdateTrigger(db: Database): void {
    db.exec(`
        DROP TRIGGER IF EXISTS memories_au;
        CREATE TRIGGER memories_au ${MEMORIES_AU_TRIGGER_BODY};
    `);
}

interface InvalidTelemetryRow {
    id: number;
    reason: string;
}

const INVALID_TELEMETRY_SAMPLE_LIMIT = 20;

/**
 * Classify v79 telemetry rows that cannot backfill `memory_stats` under its
 * constraints. Fails closed with a bounded, non-sensitive diagnostic — the
 * total count plus at most the first {@link INVALID_TELEMETRY_SAMPLE_LIMIT}
 * `(memory_id, reason)` pairs ordered by id, never content or metadata.
 * Recovery is stopped-writer and backup-first; the migration does not coerce.
 */
function assertValidV79MemoryTelemetry(db: Database): void {
    const classifier = `
        SELECT id, CASE
            WHEN seen_count IS NULL OR typeof(seen_count) != 'integer' OR seen_count < 0
                THEN 'seen_count-not-nonnegative-integer'
            WHEN retrieval_count IS NULL OR typeof(retrieval_count) != 'integer' OR retrieval_count < 0
                THEN 'retrieval_count-not-nonnegative-integer'
            WHEN last_seen_at IS NULL OR typeof(last_seen_at) != 'integer'
                THEN 'last_seen_at-not-integer'
            WHEN last_retrieved_at IS NOT NULL AND typeof(last_retrieved_at) != 'integer'
                THEN 'last_retrieved_at-not-integer-or-null'
            WHEN updated_at IS NULL OR typeof(updated_at) != 'integer'
                THEN 'updated_at-not-integer'
        END AS reason
        FROM memories`;
    const totalRow = db
        .prepare(`SELECT COUNT(*) AS total FROM (${classifier}) WHERE reason IS NOT NULL`)
        .get() as { total?: number } | undefined;
    const total = typeof totalRow?.total === "number" ? totalRow.total : 0;
    if (total === 0) return;
    const sample = db
        .prepare(
            `SELECT id, reason FROM (${classifier}) WHERE reason IS NOT NULL ORDER BY id ASC LIMIT ?`,
        )
        .all(INVALID_TELEMETRY_SAMPLE_LIMIT) as InvalidTelemetryRow[];
    const rendered = sample.map((row) => `(${row.id}, ${row.reason})`).join(", ");
    throw new Error(
        `migration v80 aborted: ${total} memories row(s) carry invalid legacy telemetry; ` +
            `first ${sample.length} as (memory_id, reason): ${rendered}. ` +
            "Correct the rows from known source data or restore a known-good backup with all writers stopped, then rerun.",
    );
}

/** Structural validation for the v80 backfill: one stats row per memory. */
function assertMemoryStatsCardinality(db: Database): void {
    const counts = db
        .prepare(
            `SELECT (SELECT COUNT(*) FROM memories) AS memories,
                    (SELECT COUNT(*) FROM memory_stats) AS stats,
                    (SELECT COUNT(*) FROM memories m
                      WHERE NOT EXISTS (SELECT 1 FROM memory_stats s WHERE s.memory_id = m.id)) AS missing`,
        )
        .get() as { memories: number; stats: number; missing: number } | null;
    if (!counts || counts.memories !== counts.stats || counts.missing !== 0) {
        throw new Error(
            `memory_stats backfill validation failed: ${counts?.memories ?? "?"} memories, ` +
                `${counts?.stats ?? "?"} stats rows, ${counts?.missing ?? "?"} missing`,
        );
    }
    const violations = db.prepare("PRAGMA foreign_key_check(memory_stats)").all() as unknown[];
    if (violations.length > 0) {
        throw new Error(
            `memory_stats foreign_key_check failed (${violations.length} violation(s))`,
        );
    }
}

function noteSearchableTextSql(source: string, withReadyReason: boolean): string {
    if (!withReadyReason) return `${source}.content`;
    return `CASE
                WHEN ${source}.ready_reason IS NOT NULL AND trim(${source}.ready_reason) <> ''
                THEN ${source}.content || char(10) || 'Reason: ' || trim(${source}.ready_reason)
                ELSE ${source}.content
            END`;
}

export function installNotesSearchProjection(db: Database): void {
    if (!tableExists(db, "notes")) return;
    // Legacy `notes` tables can lack `ready_reason`.
    const withReadyReason = noteColumnExists(db, "ready_reason");
    const updateColumns = withReadyReason ? "content, ready_reason" : "content";
    db.exec(`
        DROP TRIGGER IF EXISTS notes_fts_ai;
        DROP TRIGGER IF EXISTS notes_fts_ad;
        DROP TRIGGER IF EXISTS notes_fts_au;
        DROP VIEW IF EXISTS notes_search_view;
        DROP TABLE IF EXISTS notes_fts;

        CREATE VIEW notes_search_view AS
            SELECT id AS id, ${noteSearchableTextSql("notes", withReadyReason)} AS searchable_text
              FROM notes;

        CREATE VIRTUAL TABLE notes_fts USING fts5(
            searchable_text,
            content='notes_search_view',
            content_rowid='id',
            tokenize='trigram'
        );

        INSERT INTO notes_fts(rowid, searchable_text)
            SELECT id, searchable_text FROM notes_search_view;

        CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, searchable_text)
                VALUES (new.id, ${noteSearchableTextSql("new", withReadyReason)});
        END;

        CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, searchable_text)
                VALUES ('delete', old.id, ${noteSearchableTextSql("old", withReadyReason)});
        END;

        CREATE TRIGGER notes_fts_au AFTER UPDATE OF ${updateColumns} ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, searchable_text)
                VALUES ('delete', old.id, ${noteSearchableTextSql("old", withReadyReason)});
            INSERT INTO notes_fts(rowid, searchable_text)
                VALUES (new.id, ${noteSearchableTextSql("new", withReadyReason)});
        END;
    `);
    validateNotesSearchProjection(db);
}

export function validateNotesSearchProjection(db: Database): void {
    // rank 1 compares the index against the content view; the default rank 0 only
    // checks internal consistency and accepts a posting with no content row.
    db.exec("INSERT INTO notes_fts(notes_fts, rank) VALUES('integrity-check', 1)");
    const counts = db
        .prepare(
            `SELECT (SELECT COUNT(*) FROM notes) AS notes,
                    (SELECT COUNT(*) FROM notes_fts) AS projected`,
        )
        .get() as { notes: number; projected: number } | null;
    if (!counts || counts.notes !== counts.projected) {
        throw new Error(
            `notes_fts projection validation failed: expected ${counts?.notes ?? "?"} rows, got ${counts?.projected ?? "?"}`,
        );
    }
}

export const MIGRATIONS: Migration[] = [
    {
        version: 1,
        description: "Merge session_notes + smart_notes into unified notes table",
        up: (db: Database) => {
            // Create the unified notes table
            db.exec(`
				CREATE TABLE IF NOT EXISTS notes (
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
				);
				CREATE INDEX IF NOT EXISTS idx_notes_session_status ON notes(session_id, status);
				CREATE INDEX IF NOT EXISTS idx_notes_project_status ON notes(project_path, status);
				CREATE INDEX IF NOT EXISTS idx_notes_type_status ON notes(type, status);
			`);

            // Migrate session_notes → notes (type='session', status='active')
            const hasSessionNotes = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='session_notes'",
                )
                .get();
            if (hasSessionNotes) {
                db.exec(`
					INSERT INTO notes (type, status, content, session_id, created_at, updated_at)
					SELECT 'session', 'active', content, session_id, created_at, created_at
					FROM session_notes
				`);
            }

            // Migrate smart_notes → notes (type='smart', preserve status)
            const hasSmartNotes = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smart_notes'")
                .get();
            if (hasSmartNotes) {
                db.exec(`
					INSERT INTO notes (type, status, content, session_id, project_path, surface_condition,
						created_at, updated_at, last_checked_at, ready_at, ready_reason)
					SELECT 'smart', status, content, created_session_id, project_path, surface_condition,
						created_at, updated_at, last_checked_at, ready_at, ready_reason
					FROM smart_notes
				`);
            }

            // Drop old tables only after verifying row counts match
            if (hasSessionNotes) {
                const sourceCount = (
                    db.prepare("SELECT COUNT(*) as c FROM session_notes").get() as { c: number }
                ).c;
                const migratedCount = (
                    db.prepare("SELECT COUNT(*) as c FROM notes WHERE type = 'session'").get() as {
                        c: number;
                    }
                ).c;
                if (migratedCount >= sourceCount) {
                    db.exec("DROP TABLE session_notes");
                } else {
                    throw new Error(
                        `session_notes migration verification failed: expected ${sourceCount} rows, got ${migratedCount}`,
                    );
                }
            }
            if (hasSmartNotes) {
                const sourceCount = (
                    db.prepare("SELECT COUNT(*) as c FROM smart_notes").get() as { c: number }
                ).c;
                const migratedCount = (
                    db.prepare("SELECT COUNT(*) as c FROM notes WHERE type = 'smart'").get() as {
                        c: number;
                    }
                ).c;
                if (migratedCount >= sourceCount) {
                    db.exec("DROP TABLE smart_notes");
                } else {
                    throw new Error(
                        `smart_notes migration verification failed: expected ${sourceCount} rows, got ${migratedCount}`,
                    );
                }
            }
        },
    },
    {
        version: 2,
        description: "Add plugin_messages table for TUI ↔ server communication",
        up: (db: Database) => {
            db.exec(`
				CREATE TABLE IF NOT EXISTS plugin_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					direction TEXT NOT NULL,
					type TEXT NOT NULL,
					payload TEXT NOT NULL DEFAULT '{}',
					session_id TEXT,
					created_at INTEGER NOT NULL,
					consumed_at INTEGER
				);
				CREATE INDEX IF NOT EXISTS idx_plugin_messages_direction_consumed
					ON plugin_messages(direction, consumed_at);
				CREATE INDEX IF NOT EXISTS idx_plugin_messages_created
					ON plugin_messages(created_at);
			`);
        },
    },
    {
        version: 3,
        description: "Add user_memory_candidates and user_memories tables",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS user_memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    source_compartment_start INTEGER,
                    source_compartment_end INTEGER,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_umc_created ON user_memory_candidates(created_at);

                CREATE TABLE IF NOT EXISTS user_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    promoted_at INTEGER NOT NULL,
                    source_candidate_ids TEXT DEFAULT '[]',
                    source_candidate_provenance TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_um_status ON user_memories(status);
            `);
        },
    },
    {
        version: 4,
        description: "Add git_commits + git_commit_embeddings + git_commits_fts tables",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS git_commits (
                    sha TEXT PRIMARY KEY,
                    project_path TEXT NOT NULL,
                    short_sha TEXT NOT NULL,
                    message TEXT NOT NULL,
                    author TEXT,
                    committed_at INTEGER NOT NULL,
                    indexed_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_git_commits_project_time
                    ON git_commits(project_path, committed_at DESC);

                CREATE TABLE IF NOT EXISTS git_commit_embeddings (
                    sha TEXT PRIMARY KEY,
                    embedding BLOB NOT NULL,
                    model_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    -- FK-cascade audit (v12): git_commit_embeddings.sha -> git_commits.sha
                    -- uses ON DELETE CASCADE, so SQLite PRAGMA foreign_keys must be ON on
                    -- every connection and v12 cleans historical orphan rows.
                    FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS git_commits_fts USING fts5(
                    sha UNINDEXED,
                    project_path UNINDEXED,
                    message,
                    tokenize = 'porter unicode61'
                );

                -- Mirror writes into FTS. We intentionally rebuild FTS rows on
                -- every INSERT OR REPLACE so amended commits or re-indexed
                -- messages update cleanly.
                CREATE TRIGGER IF NOT EXISTS git_commits_fts_insert
                AFTER INSERT ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = NEW.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;

                CREATE TRIGGER IF NOT EXISTS git_commits_fts_delete
                AFTER DELETE ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                END;

                CREATE TRIGGER IF NOT EXISTS git_commits_fts_update
                AFTER UPDATE OF message, project_path ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;
            `);
        },
    },
    {
        version: 5,
        description: "One-shot heal of NULL session_meta columns",
        // Previous releases ran healNullTextColumns/healNullIntegerColumns/
        // healMissingMemoryBlockIds on every plugin startup — ~25 no-op UPDATE
        // statements per launch, each acquiring a write lock for zero rows on
        // DBs that had already been healed.
        //
        // Moving the heal into the versioned migration system means it runs
        // exactly once: on the v4 → v5 upgrade for existing users, and as part
        // of first-boot schema setup for brand-new DBs (fresh DBs have no NULL
        // columns to heal — the heals are best-effort and short-circuit cheaply
        // when there's nothing to fix, so running v5 on a fresh DB is a no-op).
        //
        // Future schema changes that ADD new columns to session_meta should
        // add a follow-up heal migration if those columns risk NULL on
        // pre-existing rows. ensureColumn() in initializeDatabase() is still
        // the source of truth for column existence; this migration only fixes
        // legacy NULL data.
        up: (db: Database) => {
            healAllNullColumns(db);
        },
    },
    {
        version: 6,
        description: "Heal session_meta.counter drift below MAX(tag_number)",
        // Tagger counter and tags.tag_number can diverge for several reasons,
        // most of them now fixed:
        //   - Pre-v0.15.7 the outer db.transaction in tagMessages would
        //     rollback ALL tag inserts in a pass on a single UNIQUE collision,
        //     leaving inner-savepoint tag inserts already committed but the
        //     counter upsert undone. Net effect: max(tag_number) > counter.
        //   - Multi-process bursts could hit similar races even though tag
        //     numbers were per-session.
        //   - Pre-v0.15.7 ON CONFLICT counter upsert used `excluded.counter`
        //     unconditionally (non-monotonic), so any low writer could undo
        //     a higher writer's update.
        //
        // Once divergence existed, the old initFromDb early-returned when the
        // session was already known in memory, so the counter could never
        // self-heal: every assignTag would propose `counter + 1`, which often
        // collided with a tag_number an old writer had already claimed, and
        // the old recovery (lookup by message_id) returned null for new
        // messages and threw — cascading into the cache-bust loop we shipped
        // a fix for in v0.15.7.
        //
        // This one-shot heal brings every divergent session back into sync.
        // Cheap (one indexed scan over tags + one targeted UPDATE per
        // affected session) and idempotent — a fresh DB or already-healed DB
        // updates zero rows.
        up: (db: Database) => {
            db.prepare(
                `UPDATE session_meta
                 SET counter = (
                     SELECT MAX(tag_number)
                     FROM tags
                     WHERE tags.session_id = session_meta.session_id
                 )
                 WHERE EXISTS (
                     SELECT 1
                     FROM tags
                     WHERE tags.session_id = session_meta.session_id
                       AND tags.tag_number > session_meta.counter
                 )`,
            ).run();
        },
    },
    {
        version: 7,
        description: "Add harness column to notes table for cross-harness sharing",
        // The unified `notes` table was created by migration v1. As of
        // plugin v0.16+ we share `~/.local/share/cortexkit/magic-context/`
        // between OpenCode and Pi, so every session-scoped table needs to
        // record which harness wrote each row. All other session-scoped
        // tables get the column via ensureColumn() in initializeDatabase()
        // (which runs before this migration). `notes` is the only table
        // initializeDatabase() can't touch — it doesn't exist yet at that
        // point because v1 creates it. So we ALTER TABLE here.
        //
        // SQLite physically backfills NOT NULL DEFAULT on existing rows,
        // so all pre-v0.16 notes transparently become harness='opencode'.
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name?: string }>;
            if (!cols.some((c) => c.name === "harness")) {
                db.exec("ALTER TABLE notes ADD COLUMN harness TEXT NOT NULL DEFAULT 'opencode'");
            }
        },
    },
    {
        version: 8,
        description: "Add partial indexes on tags(session_id, tag_number) for active and dropped",
        // Hot-path optimization. The existing index
        // `idx_tags_session_tag_number ON tags(session_id, tag_number)`
        // covers `WHERE session_id = ?` but not the `status = ?` predicate,
        // so SQLite's planner falls back to scanning every tag in a session
        // (~50k rows on long-lived sessions) for the active-only and
        // dropped-only queries that run on every transform pass.
        //
        // Partial indexes restrict the index to rows matching the WHERE
        // clause, so:
        //   - `getActiveTagsBySession` becomes an index-only scan over the
        //     active rows (typically <1% of total tags),
        //   - `getMaxDroppedTagNumber` becomes a single backward index seek.
        //
        // Benchmarked at ~110× speedup on a 49k-tag session (67ms → 0.6ms
        // for the combined per-pass workload). See
        // `packages/plugin/scripts/benchmark-tag-queries.ts`.
        //
        // ANALYZE is run after creation so the planner has stats for the
        // new indexes the first time it sees a query against this DB.
        up: (db: Database) => {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_tags_active_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'active';

                CREATE INDEX IF NOT EXISTS idx_tags_dropped_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'dropped';
            `);
            db.exec("ANALYZE tags;");
        },
    },
    {
        version: 9,
        description: "Persist tool_definition_measurements across plugin restarts",
        // The `tool.definition` plugin hook fires once per tool per
        // `ToolRegistry.tools()` call and produces our per-tool token
        // measurements. Pre-v9 these measurements lived only in an
        // in-process Map, so a plugin restart wiped them and the sidebar's
        // "Tool Defs" segment showed 0 tokens until the next chat.message
        // fired the hook chain again.
        //
        // Persisting to SQLite lets us repopulate the in-memory store at
        // openDatabase() time, so the sidebar shows the correct value
        // immediately after restart. Composite primary key matches the
        // in-memory keying (provider/model/agent/tool) so re-recording the
        // same key is a single INSERT OR REPLACE that updates the token
        // count and recorded_at without growing the table.
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS tool_definition_measurements (
                    provider_id TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    tool_id TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    recorded_at INTEGER NOT NULL,
                    PRIMARY KEY (provider_id, model_id, agent_name, tool_id)
                );
            `);
        },
    },
    {
        version: 10,
        description: "Add tool_owner_message_id column to tags + composite identity indexes",
        // Tag-owner identity fix (plan v3.3.1). Pre-v10 tool tags were
        // keyed solely by (session_id, callID), but OpenCode generates
        // callIDs per-turn rather than per-session. When two assistant
        // turns produce a tool with the same internal counter (e.g.
        // `read:32`), the tagger looked up the existing row by callID
        // and bound the new occurrence to the original tag — replaying
        // the original tag's drop status onto fresh content. Wire-level
        // failures on Kimi/Moonshot followed because the resulting
        // assistant message had reasoning_content stripped but no
        // accompanying tool_use blocks.
        //
        // Persistent identity for tool tags becomes the triple
        // (session_id, callID, tool_owner_message_id). Existing rows get
        // NULL owner; the runtime lazy-adopts them on first observation
        // (one-shot adoption per orphan, defense-in-depth) and a
        // separate backfill pass populates owner from the OpenCode DB
        // (primary correctness mechanism).
        //
        // The partial UNIQUE index prevents duplicate composite identity
        // rows once owner is populated. The lookup index accelerates
        // the lazy-adoption NULL fallback path.
        //
        // SQLite metadata-only ALTER (~5ms on 353MB DB).
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(tags)").all() as Array<{
                name?: string;
            }>;
            if (!cols.some((c) => c.name === "tool_owner_message_id")) {
                db.exec("ALTER TABLE tags ADD COLUMN tool_owner_message_id TEXT DEFAULT NULL");
            }
            db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_tool_composite
                ON tags(session_id, message_id, tool_owner_message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NOT NULL;

                CREATE INDEX IF NOT EXISTS idx_tags_tool_null_owner
                ON tags(session_id, message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NULL;
            `);
        },
    },
    {
        version: 11,
        description: "Add todo state synthesis columns to session_meta",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // Snapshot of the most recent todowrite call's args.todos, written
            // by hook-handlers.ts on tool.execute.after. Source of truth for
            // synthetic injection on cache-busting passes.
            if (!cols.some((c) => c.name === "last_todo_state")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN last_todo_state TEXT DEFAULT ''");
            }
            // Synthetic call_id of the most recently injected todowrite tool
            // part. Deterministic (sha256 of the snapshot JSON) — recorded so
            // defer-pass replay can verify byte-shape stability.
            if (!cols.some((c) => c.name === "todo_synthetic_call_id")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN todo_synthetic_call_id TEXT DEFAULT ''",
                );
            }
            // Assistant message ID where the synthetic todowrite tool part is
            // anchored. Used by defer-pass replay to land at the exact same
            // message; if the anchor message disappears from the visible
            // window, the next cache-busting pass re-anchors.
            if (!cols.some((c) => c.name === "todo_synthetic_anchor_message_id")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN todo_synthetic_anchor_message_id TEXT DEFAULT ''",
                );
            }
            // Snapshot JSON of the todos as they existed at the moment we
            // injected. Defer-pass replay rebuilds the synthetic part from
            // THIS persisted state, not from `last_todo_state`. This keeps
            // T0-cache-bust → T1-defer prefix bytes identical even when a
            // real `todowrite` mutates `last_todo_state` between T0 and T1
            // (defer passes never refresh content; the next cache-busting
            // pass adopts the new state).
            if (!cols.some((c) => c.name === "todo_synthetic_state_json")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN todo_synthetic_state_json TEXT DEFAULT ''",
                );
            }
        },
    },
    {
        version: 12,
        description: "Clean orphan rows from FK-cascade embedding tables",
        up: (db: Database) => {
            const hasTable = (name: string): boolean =>
                Boolean(
                    db
                        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
                        .get(name),
                );

            const memoryEmbeddings = hasTable("memory_embeddings")
                ? db
                      .prepare(
                          `DELETE FROM memory_embeddings
                           WHERE memory_id NOT IN (SELECT id FROM memories)`,
                      )
                      .run().changes
                : 0;
            log(`[migrations] v12 cleaned ${memoryEmbeddings} orphan memory_embeddings row(s)`);

            const gitCommitEmbeddings = hasTable("git_commit_embeddings")
                ? db
                      .prepare(
                          `DELETE FROM git_commit_embeddings
                           WHERE sha NOT IN (SELECT sha FROM git_commits)`,
                      )
                      .run().changes
                : 0;
            log(
                `[migrations] v12 cleaned ${gitCommitEmbeddings} orphan git_commit_embeddings row(s)`,
            );
        },
    },
    {
        version: 13,
        description: "Add pending_compaction_marker_state column for deferred marker drain",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // CAS blob storing the deferred compaction-marker payload between
            // background publish (compartment-runner-incremental) and the
            // next consuming pass (transform-postprocess-phase). Intentionally
            // declared WITHOUT `DEFAULT ''` so absence is signalled as SQL
            // NULL — see `getSessionsWithPendingMarker` and the healAllNullColumns
            // exclusion contract in storage-db.ts. NULL represents an absent marker,
            // so the fallback healer must not populate this column.
            if (!cols.some((c) => c.name === "pending_compaction_marker_state")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN pending_compaction_marker_state TEXT");
            }
        },
    },
    {
        version: 14,
        description: "Add project-scoped key files and version counter",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS project_key_files (
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

                CREATE INDEX IF NOT EXISTS idx_project_key_files_project
                    ON project_key_files(project_path);
                CREATE INDEX IF NOT EXISTS idx_project_key_files_generated_at
                    ON project_key_files(project_path, generated_at);

                CREATE TABLE IF NOT EXISTS project_key_files_version (
                    project_path TEXT    PRIMARY KEY,
                    version      INTEGER NOT NULL DEFAULT 0
                );
            `);
        },
    },
    {
        version: 15,
        description: "Add deferred_execute_state column for boundary execution drain",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // CAS blob storing the deferred-execute payload between a mid-turn
            // scheduler execute decision and the next boundary pass that
            // successfully runs execute work. Intentionally declared WITHOUT
            // `DEFAULT ''` so absence is signalled as SQL NULL, matching
            // pending_compaction_marker_state. Excluded from null-heal lists.
            if (!cols.some((c) => c.name === "deferred_execute_state")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN deferred_execute_state TEXT");
            }
        },
    },
    {
        version: 16,
        description: "Add context-limit cache regression sentinels",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            if (!cols.some((c) => c.name === "observed_safe_input_tokens")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0",
                );
            }
            if (!cols.some((c) => c.name === "cache_alert_sent")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN cache_alert_sent INTEGER NOT NULL DEFAULT 0",
                );
            }
        },
    },
    {
        version: 17,
        description: "Multi-anchor JSON storage for note-nudge and auto-search-hint persistence",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            if (!cols.some((c) => c.name === "note_nudge_anchors")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN note_nudge_anchors TEXT NOT NULL DEFAULT '[]'",
                );
            }
            if (!cols.some((c) => c.name === "auto_search_hint_decisions")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]'",
                );
            }

            // Backfill legacy single-anchor note-nudge state into the append-only
            // multi-anchor column. The NULL arm is required for upgraded rows that
            // predate the NOT NULL default (§3).
            db.exec(`
                UPDATE session_meta
                SET note_nudge_anchors = json_array(
                    json_object(
                        'messageId', note_nudge_sticky_message_id,
                        'text', note_nudge_sticky_text
                    )
                )
                WHERE COALESCE(note_nudge_sticky_text, '') != ''
                  AND COALESCE(note_nudge_sticky_message_id, '') != ''
                  AND (note_nudge_anchors IS NULL OR note_nudge_anchors = '[]')
            `);

            db.exec(`
                UPDATE session_meta SET note_nudge_anchors = '[]'
                WHERE note_nudge_anchors IS NULL
            `);
            db.exec(`
                UPDATE session_meta SET auto_search_hint_decisions = '[]'
                WHERE auto_search_hint_decisions IS NULL
            `);
        },
    },
    {
        version: 18,
        description: "Add pending_pi_compaction_marker_state column for Pi deferred marker drain",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // Pi-native compaction marker queue. Intentionally declared
            // WITHOUT a DEFAULT so SQL NULL remains the absence sentinel,
            // matching pending_compaction_marker_state and excluded from the
            // healAllNullColumns fallback list.
            if (!cols.some((c) => c.name === "pending_pi_compaction_marker_state")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN pending_pi_compaction_marker_state TEXT",
                );
            }
        },
    },
    {
        version: 19,
        description: "Add compartment state lease table",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_state_lease (
                    session_id TEXT PRIMARY KEY NOT NULL,
                    holder_id TEXT NOT NULL,
                    acquired_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_compartment_state_lease_expires
                    ON compartment_state_lease(expires_at);
            `);
        },
    },
    {
        version: 20,
        description: "Add subagent invocation token accounting",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS subagent_invocations (
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
                CREATE INDEX IF NOT EXISTS idx_sai_session_started
                    ON subagent_invocations(session_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_sai_subagent
                    ON subagent_invocations(subagent, started_at DESC);
            `);
        },
    },
    {
        version: 21,
        description: "Add session lifetime work metrics",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            if (!cols.some((c) => c.name === "new_work_tokens")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN new_work_tokens INTEGER NOT NULL DEFAULT 0",
                );
            }
            if (!cols.some((c) => c.name === "total_input_tokens")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0",
                );
            }
        },
    },
    {
        version: 22,
        description: "v2.0 cache architecture schema foundation",
        up: (db: Database) => {
            const hasSessionMetaTable = tableExists(db, "session_meta");
            const hasCompartmentsTable = tableExists(db, "compartments");
            const hasMemoriesTable = tableExists(db, "memories");

            if (hasSessionMetaTable) {
                ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
                ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
                ensureColumn(
                    db,
                    "session_meta",
                    "cached_m0_project_user_profile_version",
                    "INTEGER",
                );
                ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
                ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
                ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
                ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
                ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
                ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
                ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
                ensureColumn(db, "session_meta", "upgrade_reminded_at", "INTEGER");
            }

            if (hasCompartmentsTable) {
                // v2 paraphrase tiers (model B: dedicated columns, not XML-in-content).
                // Deviation from plan §3.4 (tiers-in-content) — see .alfonso/audits/v2-completeness/AUDIT.md.
                ensureColumn(db, "compartments", "p1", "TEXT");
                ensureColumn(db, "compartments", "p2", "TEXT");
                ensureColumn(db, "compartments", "p3", "TEXT");
                ensureColumn(db, "compartments", "p4", "TEXT");
                ensureColumn(db, "compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
                ensureColumn(db, "compartments", "episode_type", "TEXT");
                ensureColumn(db, "compartments", "p1_embedding", "BLOB");
                ensureColumn(db, "compartments", "p1_embedding_model_id", "TEXT");
                ensureColumn(db, "compartments", "legacy", "INTEGER NOT NULL DEFAULT 0");
            }

            const hasRecompCompartmentsTable = tableExists(db, "recomp_compartments");
            if (hasRecompCompartmentsTable) {
                // Tiers must round-trip through recomp staging or /ctx-recomp re-degrades v2 compartments to v1.
                ensureColumn(db, "recomp_compartments", "p1", "TEXT");
                ensureColumn(db, "recomp_compartments", "p2", "TEXT");
                ensureColumn(db, "recomp_compartments", "p3", "TEXT");
                ensureColumn(db, "recomp_compartments", "p4", "TEXT");
                ensureColumn(
                    db,
                    "recomp_compartments",
                    "importance",
                    "INTEGER NOT NULL DEFAULT 50",
                );
                ensureColumn(db, "recomp_compartments", "episode_type", "TEXT");
            }

            if (hasMemoriesTable) {
                ensureColumn(db, "memories", "importance", "INTEGER");
            }

            db.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS project_state (
                    project_path TEXT PRIMARY KEY,
                    project_memory_epoch INTEGER NOT NULL DEFAULT 0,
                    project_user_profile_version INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS m0_mutation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    mutation_type TEXT NOT NULL CHECK (mutation_type IN (
                        'compartment_delete',
                        'compartment_merge',
                        'recomp_boundary_change',
                        'compartment_upgrade'
                    )),
                    target_id INTEGER,
                    queued_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session
                    ON m0_mutation_log(session_id);

                CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
                    old_project_path TEXT PRIMARY KEY,
                    new_project_path TEXT NOT NULL,
                    rekeyed_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS v22_backfill_failures (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    table_name TEXT NOT NULL,
                    row_id INTEGER NOT NULL,
                    raw_project_path TEXT NOT NULL,
                    error_class TEXT NOT NULL CHECK (error_class IN (
                        'not_git_repo',
                        'git_missing',
                        'git_timeout',
                        'permission_denied',
                        'unknown'
                    )),
                    error_message TEXT,
                    failed_at INTEGER NOT NULL,
                    UNIQUE(table_name, row_id)
                );
            `);

            if (hasCompartmentsTable) {
                db.exec(`
                    INSERT OR IGNORE INTO schema_migrations_meta (key, value)
                    SELECT 'v22_legacy_compartment_boundary', CAST(COALESCE(MAX(id), 0) AS TEXT)
                    FROM compartments
                `);

                const boundaryRow = db
                    .prepare(
                        "SELECT value FROM schema_migrations_meta WHERE key = 'v22_legacy_compartment_boundary'",
                    )
                    .get() as { value: string } | undefined;
                const compartmentBoundary = Number.parseInt(boundaryRow?.value ?? "0", 10);
                db.prepare("UPDATE compartments SET legacy = 1 WHERE legacy = 0 AND id <= ?").run(
                    Number.isFinite(compartmentBoundary) ? compartmentBoundary : 0,
                );
            } else {
                db.prepare(
                    "INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES ('v22_legacy_compartment_boundary', '0')",
                ).run();
            }

            db.prepare(
                "INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES (?, 'pending')",
            ).run(V22_BACKFILL_META_KEY);
        },
    },
    {
        version: 23,
        description: "v2 compartment events storage (causal_incident / trajectory_correction)",
        up: (db: Database) => {
            // Historian-extracted events. Stored, not rendered, in v2.0 — a corpus
            // for a future dreamer cross-session aggregation/steering feature.
            // Parsed kind-agnostically: `kind` = element name, `fields_json` =
            // child elements as JSON, so new event kinds/fields need no migration.
            db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    compartment_id INTEGER,
                    kind TEXT NOT NULL,
                    at_compartment INTEGER,
                    fields_json TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode'
                );
                CREATE INDEX IF NOT EXISTS idx_compartment_events_session
                    ON compartment_events(session_id);
            `);
        },
    },
    {
        version: 24,
        description: "historian_runs metrics (per-run quality/cost telemetry)",
        up: (db: Database) => {
            // Per historian invocation: input chunk range, output shape
            // (compartments / facts / events / importance), run kind, and
            // success/failure — for debugging, quality analysis, and the
            // productization/training-data roadmap. Tokens + model come from the
            // FK-linked subagent_invocations row (subagent_invocation_id).
            db.exec(`
                CREATE TABLE IF NOT EXISTS historian_runs (
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
                CREATE INDEX IF NOT EXISTS idx_historian_runs_session
                    ON historian_runs(session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_historian_runs_status
                    ON historian_runs(status, created_at DESC);
            `);
        },
    },
    {
        version: 25,
        description: "pi_stable_id_scheme session_meta column (Pi message-id cutover gate)",
        up: (db: Database) => {
            // Pi-only: tracks which message stable-id scheme a session's persisted
            // tags/source_contents/caveman/placeholder state were keyed under. NULL/0
            // = legacy index-based pi-msg-* ids; >=1 = real-SessionEntry-id scheme.
            // When a session's stored scheme < PI_STABLE_ID_SCHEME, Pi forces one
            // execute+materialize cutover pass (re-tag + re-drop + placeholder
            // rediscovery) then stamps the new scheme. OpenCode never reads/writes
            // it. Guarded ADD COLUMN: session_meta already exists; SQLite sets
            // existing rows to NULL (treated as scheme 0), not the DEFAULT.
            const rows = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            if (!rows.some((row) => row.name === "pi_stable_id_scheme")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN pi_stable_id_scheme INTEGER");
            }
        },
    },
    {
        version: 26,
        description: "memory mutation log and atomic m[1] cache columns",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS memory_mutation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    mutation_type TEXT NOT NULL CHECK (mutation_type IN (
                        'archive',
                        'delete',
                        'update',
                        'superseded'
                    )),
                    target_memory_id INTEGER NOT NULL,
                    superseded_by_id INTEGER,
                    category TEXT,
                    new_content TEXT,
                    queued_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
                    ON memory_mutation_log(project_path, id);
            `);
            ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
            ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_project_user_profile_version", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_max_memory_mutation_id", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
            ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
            ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
            ensureColumn(db, "session_meta", "cached_m1_bytes", "BLOB");
            ensureColumn(db, "session_meta", "last_observed_model_key", "TEXT");
            ensureColumn(db, "session_meta", "memory_block_cache", "TEXT DEFAULT ''");
            ensureColumn(db, "session_meta", "memory_block_count", "INTEGER DEFAULT 0");
            ensureColumn(db, "session_meta", "memory_block_ids", "TEXT DEFAULT ''");
            db.prepare(
                `UPDATE session_meta SET
                    cached_m0_bytes = NULL,
                    cached_m1_bytes = NULL,
                    cached_m0_project_memory_epoch = NULL,
                    cached_m0_project_user_profile_version = NULL,
                    cached_m0_max_compartment_seq = NULL,
                    cached_m0_max_memory_id = NULL,
                    cached_m0_max_mutation_id = NULL,
                    cached_m0_max_memory_mutation_id = NULL,
                    cached_m0_project_docs_hash = NULL,
                    cached_m0_materialized_at = NULL,
                    cached_m0_session_facts_version = NULL,
                    cached_m0_upgrade_state = NULL,
                    memory_block_cache = '',
                    memory_block_count = 0,
                    memory_block_ids = ''`,
            ).run();
        },
    },
    {
        version: 27,
        description: "tags.entry_fingerprint for Pi fallback-tag adoption",
        up: (db: Database) => {
            // Pi tags the in-flight (newest) message under an unstable
            // pi-msg-${index} fallback id, then its real SessionEntry id one
            // pass later — re-tagging it and drifting its §N§ prefix. The
            // fingerprint (computed from the raw message: responseId + ts +
            // role + toolCallId + firstTextHash) lets the next pass find the
            // fallback tag and migrate its message_id in place, keeping the
            // tag_number (hence §N§ and all per-tag state) stable. Nullable:
            // OpenCode never writes it (real id on pass 1), so its rows stay
            // NULL and adoption never fires.
            //
            // Guard on the tags table existing: in production tags is created
            // (migration v1) long before this runs, but partial test fixtures
            // that stamp a mid-ladder version without a tags table must not
            // throw here (ensureColumn's ALTER + the CREATE INDEX both require
            // the table). A DB with no tags table has nothing to index.
            const hasTags = db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tags' LIMIT 1")
                .get();
            if (!hasTags) return;
            ensureColumn(db, "tags", "entry_fingerprint", "TEXT");
            db.exec(
                `CREATE INDEX IF NOT EXISTS idx_tags_pi_adopt
                    ON tags(session_id, entry_fingerprint)
                    WHERE type='message' AND entry_fingerprint IS NOT NULL`,
            );
        },
    },
    {
        version: 28,
        description: "Add git commit sweep coordinator lease/cooldown table",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS git_sweep_coordinator (
                    project_path TEXT PRIMARY KEY,
                    lease_holder TEXT,
                    lease_expires_at INTEGER,
                    last_swept_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_lease_expires
                    ON git_sweep_coordinator(lease_expires_at);
                CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_last_swept
                    ON git_sweep_coordinator(last_swept_at);
            `);
        },
    },
    {
        version: 29,
        description: "Add anchor_ordinal to notes (traceback to the conversation tail)",
        up: (db: Database) => {
            // The notes table is created by migration v1, so the column add lives
            // in a migration (initializeDatabase runs before runMigrations, so an
            // ensureColumn there would precede the table on a fresh DB). Nullable:
            // pre-existing notes keep NULL, which renders without an anchor.
            //
            // Guard on table existence: in the real openDatabase flow `notes`
            // always exists by here (v1 creates it). But isolated migration
            // tests seed a partial schema at a high version (skipping v1), so a
            // bare ALTER would throw "no such table" — skip cleanly in that case.
            const notesExists = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")
                .get();
            if (!notesExists) {
                return;
            }
            const columns = db.prepare("PRAGMA table_info(notes)").all() as Array<{
                name?: string;
            }>;
            if (!columns.some((column) => column.name === "anchor_ordinal")) {
                db.exec("ALTER TABLE notes ADD COLUMN anchor_ordinal INTEGER");
            }
        },
    },
    {
        version: 30,
        description: "HARD-bust m[0] markers: cached system/tool-set/model identity",
        up: (db: Database) => {
            // New persisted markers so the materialization decision can detect
            // provider-side cache-eviction events (system-block change, tools-block
            // change, model switch) and fold m[1] into m[0] "for free" when the
            // cache was already dead. Stored alongside the existing cached_m0_*
            // markers on session_meta.
            //
            // Guard on session_meta existence: in production session_meta is
            // created (migration v1) long before this runs, but partial test
            // fixtures seed a minimal schema at a high version (skipping v1), so a
            // bare ensureColumn/UPDATE would throw "no such table".
            const hasSessionMeta = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1",
                )
                .get();
            if (!hasSessionMeta) return;
            ensureColumn(db, "session_meta", "cached_m0_system_hash", "TEXT");
            ensureColumn(db, "session_meta", "cached_m0_tool_set_hash", "TEXT");
            ensureColumn(db, "session_meta", "cached_m0_model_key", "TEXT");
            // Clear the existing m[0]/m[1] cache once: pre-v30 cached rows have no
            // HARD markers, so the new cachedRowMatchesState identity check would
            // treat them as a permanent mismatch. A one-time clear forces a clean
            // re-materialize on the first pass after upgrade (costs one bust, which
            // a restart already incurs), after which the markers populate normally.
            const columns = new Set(
                (
                    db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>
                ).map((column) => column.name),
            );
            if (columns.has("cached_m0_bytes")) {
                db.prepare(
                    `UPDATE session_meta SET
                        cached_m0_bytes = NULL,
                        cached_m1_bytes = NULL,
                        cached_m0_materialized_at = NULL,
                        cached_m0_system_hash = NULL,
                        cached_m0_tool_set_hash = NULL,
                        cached_m0_model_key = NULL`,
                ).run();
            }
        },
    },
    {
        version: 31,
        description:
            "Nudge redesign: Channel 1 cadence (last_nudge_undropped) + Channel 2 ceiling lease " +
            "(channel2_nudge_state); zero legacy ctx_reduce-nudge sticky/anchor state (startup heal)",
        up: (db: Database) => {
            // Channel 1 (in-turn tool-output nudge) cadence watermark, and Channel 2
            // (synthetic-user-message ceiling) one-shot lease state. Both replace the
            // deleted rolling/iteration/sticky ctx_reduce-nudge paths, whose persisted
            // state (sticky_turn_reminder_*, nudge_anchor_*) is now inert — no code
            // reads it — but we zero it so an upgraded session can never replay a stale
            // anchor (the Bust-B mechanism the redesign removes).
            const hasSessionMeta = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1",
                )
                .get();
            if (!hasSessionMeta) return;
            ensureColumn(db, "session_meta", "last_nudge_undropped", "INTEGER DEFAULT 0");
            ensureColumn(db, "session_meta", "channel2_nudge_state", "TEXT DEFAULT ''");
            const columns = new Set(
                (
                    db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>
                ).map((column) => column.name),
            );
            // Startup heal: blank the retired ctx_reduce-nudge anchor columns. Guarded
            // per-column so a fixture that seeded a partial schema doesn't throw.
            if (columns.has("sticky_turn_reminder_text")) {
                db.prepare(
                    `UPDATE session_meta SET
                        sticky_turn_reminder_text = '',
                        sticky_turn_reminder_message_id = '',
                        nudge_anchor_message_id = '',
                        nudge_anchor_text = ''`,
                ).run();
            }
        },
    },
    {
        version: 32,
        description:
            "Protected tail boundary state, usage resolver fields, recovery escape, and drain quota",
        up: (db: Database) => {
            const hasSessionMeta = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1",
                )
                .get();
            if (!hasSessionMeta) return;
            ensureColumn(
                db,
                "session_meta",
                "prior_boundary_ordinal",
                "INTEGER NOT NULL DEFAULT 1",
            );
            ensureColumn(
                db,
                "session_meta",
                "protected_tail_policy_version",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "protected_tail_drain_window_started_at",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "protected_tail_drain_tokens",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "recovery_no_eligible_head_count",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "force_emergency_bypass_window_start",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "force_emergency_bypass_used",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "last_usage_context_limit",
                "INTEGER NOT NULL DEFAULT 0",
            );
            db.prepare(
                "UPDATE session_meta SET prior_boundary_ordinal = 1 WHERE prior_boundary_ordinal IS NULL OR prior_boundary_ordinal < 1",
            ).run();
            db.prepare(
                "UPDATE session_meta SET protected_tail_policy_version = 0 WHERE protected_tail_policy_version IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET protected_tail_drain_window_started_at = 0 WHERE protected_tail_drain_window_started_at IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET protected_tail_drain_tokens = 0 WHERE protected_tail_drain_tokens IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET recovery_no_eligible_head_count = 0 WHERE recovery_no_eligible_head_count IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET force_emergency_bypass_window_start = 0 WHERE force_emergency_bypass_window_start IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET force_emergency_bypass_used = 0 WHERE force_emergency_bypass_used IS NULL",
            ).run();
            db.prepare(
                "UPDATE session_meta SET last_usage_context_limit = 0 WHERE last_usage_context_limit IS NULL",
            ).run();
        },
    },
    {
        version: 33,
        description: "Compartment chunk embeddings for semantic message-history search",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_chunk_embeddings (
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
                    UNIQUE(compartment_id, window_index)
                );
                CREATE INDEX IF NOT EXISTS idx_cce_session
                    ON compartment_chunk_embeddings(session_id);
                CREATE INDEX IF NOT EXISTS idx_cce_project_model
                    ON compartment_chunk_embeddings(project_path, model_id);
            `);
        },
    },

    {
        version: 34,
        description: "workspace tables and m[0] workspace fingerprint cache reset",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workspace_members (
                    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    project_path TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    display_path TEXT NOT NULL,
                    added_at INTEGER NOT NULL,
                    PRIMARY KEY (workspace_id, project_path)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique
                    ON workspace_members(project_path);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name
                    ON workspace_members(workspace_id, display_name);
            `);

            const hasSessionMeta = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1",
                )
                .get();
            if (!hasSessionMeta) return;

            ensureColumn(db, "session_meta", "cached_m0_workspace_fingerprint", "TEXT");
            const columns = new Set(
                (
                    db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>
                ).map((column) => column.name),
            );
            const clears: Array<[string, string | number | null]> = [
                ["cached_m0_bytes", null],
                ["cached_m1_bytes", null],
                ["cached_m0_project_memory_epoch", null],
                ["cached_m0_workspace_fingerprint", null],
                ["cached_m0_project_user_profile_version", null],
                ["cached_m0_max_compartment_seq", null],
                ["cached_m0_max_memory_id", null],
                ["cached_m0_max_mutation_id", null],
                ["cached_m0_max_memory_mutation_id", null],
                ["cached_m0_project_docs_hash", null],
                ["cached_m0_materialized_at", null],
                ["cached_m0_session_facts_version", null],
                ["cached_m0_upgrade_state", null],
                ["cached_m0_system_hash", null],
                ["cached_m0_tool_set_hash", null],
                ["cached_m0_model_key", null],
                ["cached_m0_last_baseline_end_message_id", null],
                ["memory_block_cache", ""],
                ["memory_block_ids", ""],
                ["memory_block_count", 0],
            ];
            const setClauses: string[] = [];
            const values: Array<string | number | null> = [];
            for (const [column, value] of clears) {
                if (!columns.has(column)) continue;
                setClauses.push(`${column} = ?`);
                values.push(value);
            }
            if (setClauses.length > 0) {
                db.prepare(`UPDATE session_meta SET ${setClauses.join(", ")}`).run(...values);
            }
        },
    },

    {
        version: 35,
        description: "workspace per-category share defaults and epoch refresh",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
                );
            `);
            // ensureColumn (not a guarded raw ALTER): its re-check-on-failure
            // tolerates a concurrent sibling process adding the same column between
            // our existence check and the ALTER (duplicate-column error → re-verify
            // → return). The raw guarded form could throw on that race.
            ensureColumn(
                db,
                "workspaces",
                "share_categories",
                `TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'`,
            );
            db.prepare(
                `UPDATE workspaces
                    SET share_categories = '["CONSTRAINTS"]'
                  WHERE share_categories IS NULL OR share_categories = ''`,
            ).run();

            if (!tableExists(db, "workspace_members")) return;
            const rows = db
                .prepare(
                    `SELECT DISTINCT project_path AS identity
                       FROM workspace_members
                      WHERE project_path IS NOT NULL AND project_path <> ''
                      ORDER BY project_path ASC`,
                )
                .all() as Array<{ identity?: unknown }>;
            const identities = rows
                .map((row) => (typeof row.identity === "string" ? row.identity : ""))
                .filter((identity) => identity.length > 0);
            if (identities.length > 0) {
                bumpEpochsForWorkspaceMemberSet(db, identities, Date.now());
            }
        },
    },

    {
        version: 36,
        description: "session project ownership map for compartment chunk backfill scoping",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS session_projects (
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    project_path TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, harness)
                );
                CREATE INDEX IF NOT EXISTS idx_session_projects_project
                    ON session_projects(project_path);
            `);
            // Seed ownership for sessions that were ALREADY chunk-embedded before
            // this table existed, so their compartments stay visible to the
            // project-scoped backfill/count JOINs (a fresh table would otherwise
            // hide every pre-v36 embedded session until re-observed). The only
            // trustworthy pre-existing source is compartment_chunk_embeddings
            // itself, which already carries (session_id, harness, project_path).
            // NOTE: compartments has no project_path column — do not read from it.
            // Seed ONLY unambiguous sessions (a single distinct project_path);
            // skip any session whose chunks are split across projects (the
            // pre-scope bug) so the heal path, not a coin-flip, decides its owner.
            // Guarded on the source table existing — it is created at v33, so any
            // real upgrade has it, but a partial/older fixture might not.
            const hasChunkTable = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='compartment_chunk_embeddings'",
                )
                .get();
            if (hasChunkTable) {
                db.exec(`
                    INSERT OR IGNORE INTO session_projects (session_id, harness, project_path, updated_at)
                    SELECT session_id, harness, MIN(project_path), 0
                    FROM compartment_chunk_embeddings
                    GROUP BY session_id, harness
                    HAVING COUNT(DISTINCT project_path) = 1;
                `);
            }
        },
    },
    {
        version: 37,
        description: "emergency drain catch-up latch + historian drain failure backoff",
        up: (db: Database) => {
            // emergency_drain_active: ms-timestamp latch (0 = inactive). Set when a
            // session spikes into the emergency band (>=95%) so the historian keeps
            // draining a chunk every pass (bypassing the per-window drain budget)
            // until usage falls back below the safe zone — instead of stalling once
            // the window budget is spent. historian_drain_failure_at: ms of the last
            // genuine historian FAILURE, used to suppress the latch bypass briefly so
            // a broken historian still backs off instead of retry-thrashing.
            // Guarded on session_meta existing: a real upgrade always has it
            // (initializeDatabase creates it before migrations run), but partial
            // test fixtures may not — and initializeDatabase's own ensureColumn pass
            // adds these columns to fresh installs regardless.
            const hasSessionMeta = db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta'")
                .get();
            if (!hasSessionMeta) return;
            ensureColumn(
                db,
                "session_meta",
                "emergency_drain_active",
                "INTEGER NOT NULL DEFAULT 0",
            );
            ensureColumn(
                db,
                "session_meta",
                "historian_drain_failure_at",
                "INTEGER NOT NULL DEFAULT 0",
            );
        },
    },
    {
        version: 38,
        description: "durable transform decisions for cache-event cause attribution",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS transform_decisions (
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
                CREATE INDEX IF NOT EXISTS idx_transform_decisions_session_harness
                    ON transform_decisions(session_id, harness);
            `);
        },
    },
    {
        version: 39,
        description: "persist compaction marker target end message id",
        up: (db: Database) => {
            const hasSessionMeta = db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta'")
                .get();
            if (!hasSessionMeta) return;

            ensureColumn(db, "session_meta", "compaction_marker_state", "TEXT DEFAULT ''");
            ensureColumn(db, "session_meta", "compaction_marker_target_end_message_id", "TEXT");

            // Null-safe backfill for any state written by an intermediate build
            // that serialized targetEndMessageId in the JSON before this column
            // existed. Legacy production rows simply keep NULL and are repaired
            // the next time their marker is moved/re-injected.
            db.exec(`
                UPDATE session_meta
                SET compaction_marker_target_end_message_id = json_extract(compaction_marker_state, '$.targetEndMessageId')
                WHERE compaction_marker_target_end_message_id IS NULL
                  AND COALESCE(compaction_marker_state, '') != ''
                  AND json_valid(compaction_marker_state)
                  AND typeof(json_extract(compaction_marker_state, '$.targetEndMessageId')) = 'text'
            `);
        },
    },
    {
        version: 40,
        description: "index Pi fallback tool owners for stable-id cutover",
        up: (db: Database) => {
            if (!tableExists(db, "tags")) return;
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_tags_pi_fallback_tool_owner
                ON tags(session_id, tool_owner_message_id)
                WHERE type='tool';
            `);
        },
    },
    {
        version: 41,
        description: "key detected context limits by model",
        up: (db: Database) => {
            if (!tableExists(db, "session_meta")) return;
            ensureColumn(db, "session_meta", "detected_context_limit_model_key", "TEXT");
        },
    },
    {
        version: 42,
        description: "per-task dreamer scheduling state (Dreamer v2 A+B)",
        up: (db: Database) => {
            // Create the empty per-task schedule table. last_run_at seeding from
            // the legacy dream_state['last_dream_at:<project>'] happens at
            // scheduler FIRST-SEED time (config-aware — the migration can't know
            // which tasks are enabled). dream_queue is intentionally NOT dropped
            // here: already-open older binaries + the separate dashboard process
            // still read it; it's retired by stopping all plugin reads/writes and
            // dropped in a later migration once those have cycled.
            db.exec(`
                CREATE TABLE IF NOT EXISTS task_schedule_state (
                    project_path  TEXT    NOT NULL,
                    task          TEXT    NOT NULL,
                    last_run_at   INTEGER,
                    next_due_at   INTEGER,
                    schedule      TEXT,
                    last_status   TEXT,
                    last_error    TEXT,
                    retry_count   INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (project_path, task)
                );
                CREATE INDEX IF NOT EXISTS idx_task_schedule_due
                    ON task_schedule_state(next_due_at);
            `);
        },
    },
    {
        version: 43,
        description: "memory verification side table and verify watermarks",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS memory_verifications (
                    memory_id    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                    file_path    TEXT NOT NULL,
                    verified_at  INTEGER NOT NULL,
                    PRIMARY KEY (memory_id, file_path)
                );
                CREATE INDEX IF NOT EXISTS idx_memory_verifications_memory
                    ON memory_verifications(memory_id);
            `);
            if (tableExists(db, "task_schedule_state")) {
                ensureColumn(db, "task_schedule_state", "last_checked_commit", "TEXT");
                ensureColumn(db, "task_schedule_state", "last_broad_run_at", "INTEGER");
            }
        },
    },
    {
        version: 44,
        description: "memory classification scope and shareability columns",
        up: (db: Database) => {
            if (!tableExists(db, "memories")) return;
            ensureColumn(db, "memories", "scope", "TEXT NOT NULL DEFAULT 'project'");
            ensureColumn(db, "memories", "shareable", "INTEGER NOT NULL DEFAULT 0");
        },
    },
    {
        version: 45,
        description: "retrospective content watermark and processed-window idempotence",
        up: (db: Database) => {
            // Content watermark for the retrospective task: the max message ts it
            // has actually scanned, distinct from last_run_at (schedule-completion
            // time). last_run_at as a content cutoff loses messages that arrive
            // mid-run; this column tracks what was truly seen.
            if (tableExists(db, "task_schedule_state")) {
                ensureColumn(db, "task_schedule_state", "retrospective_watermark_ms", "INTEGER");
            }
            // Source-window idempotence: a friction window re-seen across the
            // run-overlap must not re-extract the same learning. Key = project +
            // a stable hash over the flagged user lines' (sessionId:ts) anchors.
            db.exec(`
                CREATE TABLE IF NOT EXISTS retrospective_processed_windows (
                    project_path TEXT NOT NULL,
                    window_key   TEXT NOT NULL,
                    processed_at INTEGER NOT NULL,
                    PRIMARY KEY (project_path, window_key)
                );
            `);
        },
    },
    {
        version: 46,
        description: "Primers v1 candidate and promoted primer storage",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS primer_candidates (
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
                CREATE INDEX IF NOT EXISTS idx_primer_candidates_project_time
                    ON primer_candidates(project_path, source_message_time);
                CREATE INDEX IF NOT EXISTS idx_primer_candidates_session
                    ON primer_candidates(session_id, harness);
                CREATE INDEX IF NOT EXISTS idx_primer_candidates_embedding_model
                    ON primer_candidates(project_path, question_embedding_model_id);

                CREATE TABLE IF NOT EXISTS primers (
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
                CREATE INDEX IF NOT EXISTS idx_primers_project_status_observed
                    ON primers(project_path, status, last_observed_at DESC);
                CREATE INDEX IF NOT EXISTS idx_primers_embedding_model
                    ON primers(project_path, question_embedding_model_id);

                CREATE VIRTUAL TABLE IF NOT EXISTS primers_fts USING fts5(
                    question,
                    answer,
                    project_path UNINDEXED,
                    content='primers',
                    content_rowid='id',
                    tokenize='porter unicode61'
                );
                CREATE TRIGGER IF NOT EXISTS primers_ai AFTER INSERT ON primers BEGIN
                    INSERT INTO primers_fts(rowid, question, answer, project_path)
                    VALUES (new.id, new.question, new.answer, new.project_path);
                END;
                CREATE TRIGGER IF NOT EXISTS primers_ad AFTER DELETE ON primers BEGIN
                    INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
                    VALUES ('delete', old.id, old.question, old.answer, old.project_path);
                END;
                CREATE TRIGGER IF NOT EXISTS primers_au AFTER UPDATE ON primers BEGIN
                    INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
                    VALUES ('delete', old.id, old.question, old.answer, old.project_path);
                    INSERT INTO primers_fts(rowid, question, answer, project_path)
                    VALUES (new.id, new.question, new.answer, new.project_path);
                END;
            `);
        },
    },
    {
        version: 47,
        description: "compiled smart-note checks and runtime policy state",
        up: (db: Database) => {
            if (!tableExists(db, "notes")) return;
            ensureColumn(db, "notes", "compiled_check", "TEXT");
            ensureColumn(db, "notes", "manifest_json", "TEXT");
            ensureColumn(db, "notes", "check_hash", "TEXT");
            ensureColumn(db, "notes", "check_cron", "TEXT");
            ensureColumn(db, "notes", "check_version", "INTEGER NOT NULL DEFAULT 0");
            ensureColumn(db, "notes", "check_status", "TEXT NOT NULL DEFAULT 'uncompiled'");
            ensureColumn(db, "notes", "check_failure_count", "INTEGER NOT NULL DEFAULT 0");
            ensureColumn(db, "notes", "check_network_failure_count", "INTEGER NOT NULL DEFAULT 0");
            ensureColumn(db, "notes", "check_quarantined_until", "INTEGER");
            ensureColumn(db, "notes", "check_next_due_at", "INTEGER");
            ensureColumn(db, "notes", "check_compiled_at", "INTEGER");
            ensureColumn(db, "notes", "check_false_since_at", "INTEGER");
            ensureColumn(db, "notes", "check_last_liveness_at", "INTEGER");
            ensureColumn(db, "notes", "policy_version", "INTEGER NOT NULL DEFAULT 1");
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_notes_smart_checks_due
                    ON notes(project_path, check_status, check_next_due_at)
                    WHERE type = 'smart' AND status = 'pending';
                CREATE INDEX IF NOT EXISTS idx_notes_smart_checks_liveness
                    ON notes(project_path, check_false_since_at, check_last_liveness_at)
                    WHERE type = 'smart' AND status = 'pending';
            `);
        },
    },
    {
        version: 48,
        description: "DreamerV2 rework: memory→file mapping vs verification split, classify marker",
        up: (db: Database) => {
            // map-memories records WHICH files back a memory (mapped_at) WITHOUT
            // content-verifying it; verify sets verified_at when it checks the
            // claim. verified_at=0 = "mapped, not yet content-verified". This lets
            // the verify gate scope per-memory (files changed since THAT memory's
            // verified_at) instead of a single global commit watermark.
            if (tableExists(db, "memory_verifications")) {
                ensureColumn(db, "memory_verifications", "mapped_at", "INTEGER NOT NULL DEFAULT 0");
            }
            // classify-memories run-gate + Stage-3 partition: NULL = unclassified.
            // Cleared on memory content update/merge so a changed fact re-scores.
            if (tableExists(db, "memories")) {
                ensureColumn(db, "memories", "classified_at", "INTEGER");
            }
        },
    },
    {
        version: 49,
        description: "per-model embedding coexistence and active identity tracking",
        up: (db: Database) => {
            if (tableExists(db, "memory_embeddings")) {
                db.exec(`
                    UPDATE memory_embeddings
                    SET model_id = 'legacy:unknown'
                    WHERE model_id IS NULL;
                `);
                // Drop rows orphaned from their parent BEFORE the rebuild. The new
                // table re-declares the FK and assertForeignKeyIntegrity runs
                // after; a pre-existing orphan (parent deleted without the cascade
                // firing) would otherwise fail the migration closed and disable
                // the plugin. Mirrors the v12 orphan pre-clean. Guarded on the
                // parent table existing (minimal test fixtures may omit it).
                if (tableExists(db, "memories")) {
                    db.exec(`
                        DELETE FROM memory_embeddings
                        WHERE memory_id NOT IN (SELECT id FROM memories);
                    `);
                }
                db.exec(`
                    DROP TABLE IF EXISTS memory_embeddings_v49_new;
                    CREATE TABLE memory_embeddings_v49_new (
                        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                        embedding BLOB NOT NULL,
                        model_id TEXT NOT NULL,
                        PRIMARY KEY(memory_id, model_id)
                    );
                    INSERT INTO memory_embeddings_v49_new (memory_id, embedding, model_id)
                    SELECT memory_id, embedding, model_id
                    FROM memory_embeddings;
                    DROP TABLE memory_embeddings;
                    ALTER TABLE memory_embeddings_v49_new RENAME TO memory_embeddings;
                `);
                assertForeignKeyIntegrity(db, "memory_embeddings");
            }

            if (tableExists(db, "git_commit_embeddings")) {
                if (tableExists(db, "git_commits")) {
                    db.exec(`
                        DELETE FROM git_commit_embeddings
                        WHERE sha NOT IN (SELECT sha FROM git_commits);
                    `);
                }
                db.exec(`
                    DROP TABLE IF EXISTS git_commit_embeddings_v49_new;
                    CREATE TABLE git_commit_embeddings_v49_new (
                        sha TEXT NOT NULL,
                        embedding BLOB NOT NULL,
                        model_id TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        PRIMARY KEY(sha, model_id),
                        FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
                    );
                    INSERT INTO git_commit_embeddings_v49_new (sha, embedding, model_id, created_at)
                    SELECT sha, embedding, model_id, created_at
                    FROM git_commit_embeddings;
                    DROP TABLE git_commit_embeddings;
                    ALTER TABLE git_commit_embeddings_v49_new RENAME TO git_commit_embeddings;
                `);
                assertForeignKeyIntegrity(db, "git_commit_embeddings");
            }

            if (tableExists(db, "compartment_chunk_embeddings")) {
                if (tableExists(db, "compartments")) {
                    db.exec(`
                        DELETE FROM compartment_chunk_embeddings
                        WHERE compartment_id NOT IN (SELECT id FROM compartments);
                    `);
                }
                db.exec(`
                    DROP INDEX IF EXISTS idx_cce_session;
                    DROP INDEX IF EXISTS idx_cce_project_model;
                    DROP TABLE IF EXISTS compartment_chunk_embeddings_v49_new;
                    CREATE TABLE compartment_chunk_embeddings_v49_new (
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
                    INSERT INTO compartment_chunk_embeddings_v49_new (
                        id, compartment_id, session_id, project_path, harness, window_index,
                        start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                    )
                    SELECT id, compartment_id, session_id, project_path, harness, window_index,
                           start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                    FROM compartment_chunk_embeddings;
                    DROP TABLE compartment_chunk_embeddings;
                    ALTER TABLE compartment_chunk_embeddings_v49_new RENAME TO compartment_chunk_embeddings;
                    CREATE INDEX IF NOT EXISTS idx_cce_session ON compartment_chunk_embeddings(session_id);
                    CREATE INDEX IF NOT EXISTS idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);
                `);
                assertForeignKeyIntegrity(db, "compartment_chunk_embeddings");
            }

            db.exec(`
                CREATE TABLE IF NOT EXISTS embedding_identity_active (
                    project_path TEXT NOT NULL,
                    scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
                    model_id TEXT NOT NULL,
                    last_active_at INTEGER NOT NULL,
                    PRIMARY KEY(project_path, scope, model_id)
                );
            `);
        },
    },
    {
        version: 50,
        description: "add durable ctx-wrapup session marker",
        up(db: Database): void {
            if (tableExists(db, "session_meta")) {
                ensureColumn(db, "session_meta", "wrapup_in_progress_state", "TEXT");
            }
        },
    },
    {
        version: 51,
        description: "version tool-owner backfill state and repair legacy NULL session metadata",
        up(db: Database): void {
            db.exec(`
                CREATE TABLE IF NOT EXISTS tool_owner_backfill_state (
                    session_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped')),
                    started_at INTEGER,
                    lease_expires_at INTEGER,
                    completed_at INTEGER,
                    last_error TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_tool_owner_backfill_state_status
                    ON tool_owner_backfill_state(status);
            `);
            // v5 used to swallow every UPDATE failure. Re-run the heal so
            // databases that recorded v5 after a transient failure are repaired.
            healAllNullColumns(db);
        },
    },
    {
        version: 52,
        description: "persist emergency recovery origin",
        up(db: Database): void {
            if (tableExists(db, "session_meta")) {
                ensureColumn(db, "session_meta", "emergency_recovery_origin", "TEXT DEFAULT ''");
            }
        },
    },
    {
        version: 53,
        description: "add Synapse batch, shadow, and measurement storage",
        up(db: Database): void {
            db.exec(`
                CREATE TABLE IF NOT EXISTS embedding_registrations (
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
                CREATE TABLE IF NOT EXISTS synapse_batch_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL DEFAULT '',
                    scope TEXT NOT NULL DEFAULT '',
                    manifest_json TEXT NOT NULL DEFAULT '{}',
                    request_key TEXT NOT NULL DEFAULT '',
                    job_id TEXT,
                    cursor TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(session_id, request_key)
                );
                CREATE INDEX IF NOT EXISTS idx_synapse_batch_ledger_session
                    ON synapse_batch_ledger(session_id, updated_at);
                CREATE TABLE IF NOT EXISTS shadow_embedding_registrations (
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
                CREATE TABLE IF NOT EXISTS embedding_measurement_corpus (
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
                CREATE INDEX IF NOT EXISTS idx_embedding_measurement_session
                    ON embedding_measurement_corpus(session_id, created_at);
            `);
        },
    },
    {
        version: 54,
        description: "add authority identity, managed-write guards, and mirror cursors",
        up(db: Database): void {
            const memoriesPresent = tableExists(db, "memories");
            const notesPresent = tableExists(db, "notes");
            db.exec(`
                CREATE TABLE IF NOT EXISTS context_store_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS authority_managed (
                    project_path TEXT PRIMARY KEY,
                    context_store_uuid TEXT NOT NULL,
                    marked_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS authority_repair_pending (
                    project_path TEXT PRIMARY KEY,
                    started_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS mirror_identity (
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    context_row_id INTEGER NOT NULL,
                    PRIMARY KEY(domain, module_project, module_row_id),
                    UNIQUE(domain, context_row_id)
                );
                CREATE TABLE IF NOT EXISTS mirror_cursors (
                    domain TEXT PRIMARY KEY CHECK(domain IN ('memories', 'notes')),
                    cursor INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS context_privilege_state (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
                );
            `);
            // Guard triggers are database-level fences, not conventions at each call site.
            // Session notes remain TS-owned; only smart notes with a project identity are
            // covered by the managed-project or repair-pending marker.
            if (memoriesPresent) {
                db.exec(`
                DROP TRIGGER IF EXISTS memories_authority_guard_insert;
                DROP TRIGGER IF EXISTS memories_authority_guard_update;
                DROP TRIGGER IF EXISTS memories_authority_guard_delete;
                CREATE TRIGGER memories_authority_guard_insert
                BEFORE INSERT ON memories
                 WHEN (
                     EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
                 ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module');
                END;
                CREATE TRIGGER memories_authority_guard_update
                BEFORE UPDATE ON memories
                 WHEN (
                     EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                     OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
                 ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module');
                END;
                CREATE TRIGGER memories_authority_guard_delete
                BEFORE DELETE ON memories
                 WHEN (
                     EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                 ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module');
                END;
                `);
            }
            if (notesPresent) {
                db.exec(`
                DROP TRIGGER IF EXISTS notes_authority_guard_insert;
                DROP TRIGGER IF EXISTS notes_authority_guard_update;
                DROP TRIGGER IF EXISTS notes_authority_guard_delete;
                CREATE TRIGGER notes_authority_guard_insert
                BEFORE INSERT ON notes
                 WHEN NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                   AND (
                       EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
                   ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module');
                END;
                CREATE TRIGGER notes_authority_guard_update
                BEFORE UPDATE ON notes
                WHEN (
                     (OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)))
                     OR
                     (NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)))
                ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module');
                END;
                CREATE TRIGGER notes_authority_guard_delete
                BEFORE DELETE ON notes
                 WHEN OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                   AND (
                       EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                   ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module');
                END;
                `);
            }
        },
    },
    {
        version: 55,
        description: "make managed-write privilege connection-local",
        up(db: Database): void {
            // Guard triggers must never consult a persistent flag: a crashed or second
            // connection must not inherit permission to write module-owned rows.
            const memoriesPresent = tableExists(db, "memories");
            const notesPresent = tableExists(db, "notes");
            // SAFETY: the cast only exposes optional driver methods; typeof
            // checks determine availability before any use.
            const native = db as unknown as {
                function?: unknown;
                createFunction?: unknown;
            };
            const privilegeCheck =
                typeof native.function === "function" || typeof native.createFunction === "function"
                    ? "mc_privileged_writer() = 0"
                    : "COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0";
            if (memoriesPresent) {
                db.exec(`
                    DROP TRIGGER IF EXISTS memories_authority_guard_insert;
                    DROP TRIGGER IF EXISTS memories_authority_guard_update;
                    DROP TRIGGER IF EXISTS memories_authority_guard_delete;
                    CREATE TRIGGER memories_authority_guard_insert
                    BEFORE INSERT ON memories
                    WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                    CREATE TRIGGER memories_authority_guard_update
                    BEFORE UPDATE ON memories
                    WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                    CREATE TRIGGER memories_authority_guard_delete
                    BEFORE DELETE ON memories
                    WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                `);
            }
            if (notesPresent) {
                db.exec(`
                    DROP TRIGGER IF EXISTS notes_authority_guard_insert;
                    DROP TRIGGER IF EXISTS notes_authority_guard_update;
                    DROP TRIGGER IF EXISTS notes_authority_guard_delete;
                    CREATE TRIGGER notes_authority_guard_insert
                    BEFORE INSERT ON notes
                    WHEN NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module'); END;
                    CREATE TRIGGER notes_authority_guard_update
                    BEFORE UPDATE ON notes
                    WHEN ((OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                            AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                              OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)))
                       OR (NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                            AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                              OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module'); END;
                    CREATE TRIGGER notes_authority_guard_delete
                    BEFORE DELETE ON notes
                    WHEN OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module'); END;
                `);
            }
        },
    },
    {
        version: 56,
        description: "record authority capture bounds and pending mirror references",
        up(db: Database): void {
            db.exec(`
                CREATE TABLE IF NOT EXISTS authority_capture_bounds (
                    project_path TEXT NOT NULL,
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    max_rowid INTEGER NOT NULL,
                    data_version INTEGER NOT NULL,
                    captured_at INTEGER NOT NULL,
                    PRIMARY KEY(project_path, domain)
                );
                CREATE TABLE IF NOT EXISTS mirror_pending_references (
                    domain TEXT NOT NULL CHECK(domain = 'memories'),
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    target_module_row_id INTEGER NOT NULL,
                    PRIMARY KEY(domain, module_project, module_row_id)
                );
                CREATE INDEX IF NOT EXISTS idx_mirror_pending_reference_target
                    ON mirror_pending_references(domain, module_project, target_module_row_id);
                CREATE TABLE IF NOT EXISTS mirror_note_revisions (
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    context_row_id INTEGER NOT NULL,
                    status_version INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(module_project, module_row_id),
                    UNIQUE(context_row_id)
                );
            `);
            installLatestAuthorityTriggers(db);
        },
    },
    {
        version: 57,
        description: "domain mutation epoch for authority capture bounds",
        up(db: Database): void {
            // Privileged same-connection writes do not advance PRAGMA data_version, so
            // capture verification tracks an explicit per-domain mutation epoch instead.
            db.exec(`
                CREATE TABLE IF NOT EXISTS domain_mutation_epoch (
                    project_path TEXT NOT NULL,
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    epoch INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(project_path, domain)
                );
            `);
            if (tableExists(db, "authority_capture_bounds")) {
                ensureColumn(
                    db,
                    "authority_capture_bounds",
                    "mutation_epoch",
                    "INTEGER NOT NULL DEFAULT 0",
                );
            }
        },
    },
    {
        version: 58,
        description: "track live module memory identities during mirror replay",
        up(db: Database): void {
            db.exec(`
                CREATE TABLE IF NOT EXISTS mirror_live_memory_rows (
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL,
                    PRIMARY KEY(module_project, module_row_id)
                );
                CREATE INDEX IF NOT EXISTS idx_mirror_live_memory_content
                    ON mirror_live_memory_rows(module_project, category, normalized_hash);
                CREATE TABLE IF NOT EXISTS mirror_resnapshot_state (
                    domain TEXT PRIMARY KEY CHECK(domain = 'memories'),
                    status TEXT NOT NULL CHECK(status IN ('pending_check', 'resnapshotting', 'complete')),
                    updated_at INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO mirror_resnapshot_state(domain, status, updated_at)
                VALUES ('memories', 'pending_check', 0);
            `);
        },
    },
    {
        version: 59,
        description: "stage paged live memory resnapshots before atomic replacement",
        up(db: Database): void {
            db.exec(`
                CREATE TABLE IF NOT EXISTS mirror_live_staging (
                    generation TEXT NOT NULL,
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL,
                    PRIMARY KEY(generation, module_project, module_row_id)
                );
                CREATE INDEX IF NOT EXISTS idx_mirror_live_staging_generation
                    ON mirror_live_staging(generation);
            `);
        },
    },
    {
        version: 60,
        description: "persist the owning live memory resnapshot generation",
        up(db: Database): void {
            // Databases that recorded v58 before its body gained this table never created
            // it (a shipped-migration edit — version rows block re-runs). Recreate it here
            // so both shapes converge; CREATE IF NOT EXISTS makes this a no-op on healthy DBs.
            db.exec(`
                CREATE TABLE IF NOT EXISTS mirror_resnapshot_state (
                    domain TEXT PRIMARY KEY CHECK(domain = 'memories'),
                    status TEXT NOT NULL CHECK(status IN ('pending_check', 'resnapshotting', 'complete')),
                    updated_at INTEGER NOT NULL
                );
            `);
            db.exec(
                "INSERT OR IGNORE INTO mirror_resnapshot_state(domain, status, updated_at) VALUES ('memories', 'pending_check', 0)",
            );
            ensureColumn(db, "mirror_resnapshot_state", "generation", "TEXT");
        },
    },
    {
        version: 61,
        description: "retain complete memory snapshots for mirror healing",
        up(db: Database): void {
            // Existing live identities only retained category/hash, so force one bounded live
            // resnapshot after this migration. The schema_migrations row is the durable one-time
            // marker: direct recovery replay must not re-arm a snapshot already completed at runtime.
            ensureColumn(db, "mirror_live_memory_rows", "full_row_snapshot", "TEXT");
            ensureColumn(db, "mirror_live_staging", "full_row_snapshot", "TEXT");
            db.prepare(
                `UPDATE mirror_resnapshot_state
                    SET status = 'pending_check', generation = NULL, updated_at = ?
                  WHERE domain = 'memories'
                    AND status = 'complete'
                    AND NOT EXISTS (
                        SELECT 1 FROM schema_migrations WHERE version = 61
                    )`,
            ).run(Date.now());
        },
    },
    {
        version: 62,
        description: "durable row-level project identity merge audit log",
        up(db: Database): void {
            db.exec(`
                CREATE TABLE IF NOT EXISTS identity_merge_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_identity TEXT NOT NULL,
                    to_identity TEXT NOT NULL,
                    table_name TEXT NOT NULL,
                    row_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target_row_id TEXT,
                    merged_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_identity_merge_log_identities
                    ON identity_merge_log(from_identity, to_identity, merged_at);
                CREATE INDEX IF NOT EXISTS idx_identity_merge_log_table_row
                    ON identity_merge_log(table_name, row_id);
            `);
        },
    },
    {
        version: 63,
        description: "Add anchor_block_id to notes (module note mirror writes it)",
        up(db: Database): void {
            // Sparse legacy databases may not contain the optional notes table; there
            // is no column to add until normal boot initialization creates that table.
            if (!tableExists(db, "notes")) return;
            // The module-side mc_notes schema carries anchor_block_id (the flat block
            // the note was taken against); the mirror consumer writes it through to
            // context.db so anchors survive a later drain back to TS authority. The
            // column was referenced by the mirror before any migration created it,
            // which broke every mirror apply on upgraded databases.
            const columns = db.prepare("PRAGMA table_info(notes)").all() as Array<{
                name: string;
            }>;
            if (!columns.some((column) => column.name === "anchor_block_id")) {
                db.exec("ALTER TABLE notes ADD COLUMN anchor_block_id TEXT");
            }
        },
    },
    {
        version: 64,
        description: "store project-scoped rendered memory mural",
        up(db: Database): void {
            db.exec(`
                CREATE TABLE IF NOT EXISTS mural_manifest (
                    project_path TEXT PRIMARY KEY,
                    image BLOB NOT NULL,
                    content_hash TEXT NOT NULL,
                    rendered_at INTEGER NOT NULL,
                    model TEXT,
                    memory_ids_json TEXT NOT NULL DEFAULT '[]',
                    width INTEGER NOT NULL DEFAULT 1092,
                    height INTEGER NOT NULL DEFAULT 1092
                );
            `);
            ensureColumn(db, "mural_manifest", "model", "TEXT");
            ensureColumn(db, "mural_manifest", "memory_ids_json", "TEXT NOT NULL DEFAULT '[]'");
            ensureColumn(db, "mural_manifest", "width", "INTEGER NOT NULL DEFAULT 1092");
            ensureColumn(db, "mural_manifest", "height", "INTEGER NOT NULL DEFAULT 1092");
        },
    },
    {
        version: 65,
        description:
            "Add per-memory mural cue columns for the deterministic cue-compression cutover",
        up(db: Database): void {
            // The mural cutover moves cue compression off the single-shot author
            // LLM onto a per-memory cached pure function: the compress-cues dreamer
            // task writes one pidgin cue per memory, and resolveMural + renderMural
            // pack them deterministically at inject time. These three columns cache
            // that cue per memory content version.
            //
            //   mural_cue      — the compressed pidgin cue text (NULL until computed)
            //   mural_cue_hash — sha256 of the memory CONTENT the cue was computed
            //                    FROM, so an edited memory's stale cue is detected
            //                    (mural_cue_hash != sha256(content)) and recompressed
            //   mural_cue_at   — epoch ms the cue was written (telemetry / recency)
            //
            // Sparse legacy databases may not have the memories table yet; boot
            // initialization creates it, and the ensureColumn calls in storage-db
            // heal upgraded DBs that miss a migration row.
            if (!tableExists(db, "memories")) return;
            ensureColumn(db, "memories", "mural_cue", "TEXT");
            ensureColumn(db, "memories", "mural_cue_hash", "TEXT");
            ensureColumn(db, "memories", "mural_cue_at", "INTEGER");
        },
    },
    {
        version: 66,
        description: "bound per-session historian upgrade reminders",
        up(db: Database): void {
            if (!tableExists(db, "session_meta")) return;
            ensureColumn(db, "session_meta", "upgrade_reminder_last_sent_at", "INTEGER");
            ensureColumn(
                db,
                "session_meta",
                "upgrade_reminder_count",
                "INTEGER NOT NULL DEFAULT 0",
            );
        },
    },
    {
        version: 67,
        description: "persist the frozen mural payload with each cached m0 baseline",
        up(db: Database): void {
            if (!tableExists(db, "session_meta")) return;
            ensureColumn(db, "session_meta", "cached_m0_mural_data_url", "TEXT");
            ensureColumn(db, "session_meta", "cached_m0_mural_hash", "TEXT");
        },
    },
    {
        version: 68,
        description: "converge message FTS deletions and same-ID source revisions",
        up(db: Database): void {
            db.exec(`
                CREATE TABLE IF NOT EXISTS message_history_source (
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
                CREATE INDEX IF NOT EXISTS idx_message_history_source_session_ordinal
                    ON message_history_source(session_id, message_ordinal);

                CREATE TABLE IF NOT EXISTS pending_session_cleanup (
                    session_id TEXT PRIMARY KEY,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    requested_at INTEGER NOT NULL,
                    last_attempt_at INTEGER
                );

                CREATE TABLE IF NOT EXISTS message_history_orphan_sweep (
                    harness TEXT PRIMARY KEY,
                    cursor_session_id TEXT NOT NULL DEFAULT '',
                    last_swept_at INTEGER
                );
            `);
            if (tableExists(db, "message_history_index")) {
                const columns = new Set(
                    (
                        db.prepare("PRAGMA table_info(message_history_index)").all() as Array<{
                            name: string;
                        }>
                    ).map((column) => column.name),
                );
                if (
                    columns.has("session_id") &&
                    columns.has("harness") &&
                    columns.has("updated_at")
                ) {
                    db.exec(`
                        CREATE INDEX IF NOT EXISTS idx_message_history_index_orphan_sweep
                            ON message_history_index(harness, session_id, updated_at);
                    `);
                }
            }
        },
    },
    {
        version: 69,
        description: "index visibility mutation discovery and target loading",
        up(db: Database): void {
            if (!tableExists(db, "memory_mutation_log")) return;
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_visibility
                    ON memory_mutation_log(project_path, category, id, target_memory_id);
                CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_target
                    ON memory_mutation_log(project_path, target_memory_id, id);
            `);
        },
    },
    {
        version: 70,
        description:
            "heal legacy compartments stranded by mismatched tier closing tags (issue #246)",
        up(db: Database): void {
            healMismatchedTierClose(db, "compartments", true);
            healMismatchedTierClose(db, "recomp_compartments", false);
        },
    },
    {
        version: 71,
        description:
            "rebuild authority guard triggers to the durable state-table form (issue #253)",
        up(db: Database): void {
            // Earlier migrations baked a connection-local UDF reference
            // (mc_privileged_writer()) into these triggers when the MIGRATING runtime
            // supported scalar UDFs. That reference is only evaluable on connections
            // that registered the UDF, so every other connection opening context.db
            // failed each guarded write with `no such function`. Rebuild all six guards
            // to the durable context_privilege_state predicate. DROP + CREATE is safe on
            // both existing variants (UDF-form and state-form triggers) and on fresh
            // databases. installLatestAuthorityTriggers now emits the state-table form
            // unconditionally.
            installLatestAuthorityTriggers(db);
        },
    },
    {
        version: 72,
        description: "add per-session compaction mode record column (issue #266)",
        up(db: Database): void {
            // This column is added in three places to stay consistent across
            // fresh and migrated databases: (a) this migration, (b) the
            // CREATE TABLE in storage-db.ts, and (c) a boot-time ensureColumn
            // backfill in storage-db.ts. NULL means no record, which the
            // transition logic treats as "on" (compaction enabled) — so
            // pre-existing rows are unambiguously no-record. "on"/"off" are
            // the recorded mode values. This migration only adds the column;
            // no code reads or writes it yet.
            if (tableExists(db, "session_meta")) {
                ensureColumn(db, "session_meta", "compaction_mode_record", "TEXT");
            }
        },
    },
    {
        version: 73,
        description: "persist the last successful todowrite permission verdict",
        up(db: Database): void {
            if (tableExists(db, "session_meta")) {
                ensureColumn(
                    db,
                    "session_meta",
                    "todo_permission_denied",
                    "INTEGER NOT NULL DEFAULT 2",
                );
            }
        },
    },
    {
        version: 74,
        description: "persist detected context-limit provenance",
        up(db: Database): void {
            if (tableExists(db, "session_meta")) {
                ensureColumn(
                    db,
                    "session_meta",
                    "detected_context_limit_provenance",
                    "TEXT NOT NULL DEFAULT 'unknown'",
                );
            }
        },
    },
    {
        version: 75,
        description: "persist mural cue validation rejection latches",
        up(db: Database): void {
            // A NULL cue remains eligible for compression, while this counter
            // remembers repeated validation failures for its current content hash.
            if (!tableExists(db, "memories")) return;
            ensureColumn(db, "memories", "mural_cue_rejection_count", "INTEGER NOT NULL DEFAULT 0");
        },
    },
    {
        version: 76,
        description: "persist retina provider compilation for smart-note conditions",
        up(db: Database): void {
            if (!tableExists(db, "notes")) return;
            ensureColumn(db, "notes", "compiled_provider", "TEXT");
            ensureColumn(db, "notes", "compiled_config", "TEXT");
            ensureColumn(db, "notes", "compiled_at", "INTEGER");
            ensureColumn(
                db,
                "notes",
                "compile_status",
                "TEXT CHECK(compile_status IN ('compiled', 'plain', 'refused'))",
            );
        },
    },
    {
        version: 77,
        description: "persist scoped provenance for promoted user memories and primers",
        up(db: Database): void {
            if (tableExists(db, "user_memories")) {
                ensureColumn(db, "user_memories", "source_candidate_provenance", "TEXT");
            }
            if (tableExists(db, "primers")) {
                ensureColumn(db, "primers", "source_candidate_provenance", "TEXT");
            }
        },
    },
    {
        version: 78,
        description: "add migration_pending journal for crash-safe cross-harness session migration",
        up(db: Database): void {
            // Recovery journal for `doctor migrate` (OpenCode → Pi/OMP). Each row
            // tracks one in-flight session migration through its phases so a crash
            // between staging the JSONL, committing the shared-DB state, and
            // renaming the file into the sessions root can be reconciled by phase
            // on the next doctor/migrate run.
            //
            // Column naming is load-bearing: the Pi session column is named
            // `pi_session_id` (and the source is `source_session_id`) — NEVER
            // `session_id`. The structural clearSession contract test discovers
            // every table with a `session_id` column and requires clearSession to
            // empty it; dragging this journal into that set would make ordinary
            // session deletion destroy crash-recovery records.
            db.exec(`
                CREATE TABLE IF NOT EXISTS migration_pending (
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
            `);
        },
    },
    {
        version: 79,
        description: "add notes_fts trigram candidate projection for note search",
        up(db: Database): void {
            installNotesSearchProjection(db);
        },
    },
    {
        version: 80,
        description: "move mutable memory telemetry into the memory_stats side table",
        up(db: Database): void {
            if (!tableExists(db, "memories")) return;
            if (tableExists(db, "memory_stats")) return;
            const columns = new Set(
                (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map(
                    (row) => row.name,
                ),
            );
            for (const column of [
                "seen_count",
                "retrieval_count",
                "last_seen_at",
                "last_retrieved_at",
                "updated_at",
            ]) {
                if (!columns.has(column)) return;
            }
            // Fail closed before creating any v80 object so a rollback leaves an
            // intact v79 database.
            assertValidV79MemoryTelemetry(db);

            db.exec(`
                CREATE TABLE memory_stats (
                    memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
                    seen_count INTEGER NOT NULL CHECK (typeof(seen_count) = 'integer' AND seen_count >= 0),
                    retrieval_count INTEGER NOT NULL CHECK (typeof(retrieval_count) = 'integer' AND retrieval_count >= 0),
                    last_seen_at INTEGER NOT NULL,
                    last_retrieved_at INTEGER,
                    updated_at INTEGER NOT NULL
                );
            `);
            // Backfill runs before the authority guards are installed: the
            // migration transaction is schema-owned and must copy managed
            // projects' rows too.
            db.exec(`
                INSERT INTO memory_stats (memory_id, seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at)
                SELECT id, seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at FROM memories;
            `);
            assertMemoryStatsCardinality(db);

            const privilegeCheck = authorityPrivilegeCheck();
            const managedStats = (ref: string): string => `(
                EXISTS (SELECT 1 FROM authority_managed am JOIN memories m ON m.project_path = am.project_path WHERE m.id = ${ref}.memory_id)
                OR EXISTS (SELECT 1 FROM authority_repair_pending arp JOIN memories m ON m.project_path = arp.project_path WHERE m.id = ${ref}.memory_id)
            )`;
            db.exec(`
                CREATE TRIGGER memory_stats_authority_guard_insert
                BEFORE INSERT ON memory_stats
                WHEN ${managedStats("NEW")} AND ${privilegeCheck}
                BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                CREATE TRIGGER memory_stats_authority_guard_update
                BEFORE UPDATE ON memory_stats
                WHEN (${managedStats("OLD")} OR ${managedStats("NEW")}) AND ${privilegeCheck}
                BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                CREATE TRIGGER memory_stats_authority_guard_delete
                BEFORE DELETE ON memory_stats
                WHEN ${managedStats("OLD")} AND ${privilegeCheck}
                BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
            `);
            // The frozen-baseline guard applies to every writer, privileged or
            // not: after v80 no path may mutate the retained legacy columns. A
            // full-row UPDATE that binds the old values back is allowed (the
            // WHEN clause compares values), so held-open statements that do not
            // change telemetry keep working.
            db.exec(`
                CREATE TRIGGER memories_telemetry_freeze_guard
                BEFORE UPDATE OF seen_count, retrieval_count, last_seen_at, last_retrieved_at ON memories
                WHEN NEW.seen_count IS NOT OLD.seen_count
                  OR NEW.retrieval_count IS NOT OLD.retrieval_count
                  OR NEW.last_seen_at IS NOT OLD.last_seen_at
                  OR NEW.last_retrieved_at IS NOT OLD.last_retrieved_at
                BEGIN SELECT RAISE(ABORT, 'memories telemetry columns are frozen at v80; write memory_stats instead'); END;
            `);
            // One mechanism for every inserter (held-open v79 statements, v80
            // TypeScript, privileged module mirrors): the base insert's
            // telemetry values are the stats baseline. No OR IGNORE — an
            // invalid tuple aborts the owning insert.
            db.exec(`
                CREATE TRIGGER memories_stats_ai AFTER INSERT ON memories BEGIN
                    INSERT INTO memory_stats (memory_id, seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at)
                    VALUES (NEW.id, COALESCE(NEW.seen_count, 1), COALESCE(NEW.retrieval_count, 0), NEW.last_seen_at, NEW.last_retrieved_at, NEW.updated_at);
                END;
            `);
            installValueSensitiveMemoriesFtsUpdateTrigger(db);
        },
    },
    {
        version: 81,
        description: "smart-note evaluation revisions: source_revision and state_version",
        up(db: Database): void {
            if (!tableExists(db, "notes")) return;
            ensureColumn(db, "notes", "source_revision", "INTEGER NOT NULL DEFAULT 0");
            ensureColumn(db, "notes", "state_version", "INTEGER NOT NULL DEFAULT 0");
        },
    },
    {
        version: 82,
        description:
            "authoritative claims and evidence schema with the numeric project identity registry",
        up(db: Database): void {
            // A replayed v82 must no-op over its own published schema, but a
            // partial or foreign `projects` table is corruption, not a replay.
            if (tableExists(db, "projects")) {
                const missing = CLAIMS_AND_EVIDENCE_TABLES.filter(
                    (table) => !tableExists(db, table),
                );
                if (missing.length > 0) {
                    throw new Error(
                        `v82 replay guard: projects exists but ${missing.join(", ")} missing; refusing to skip or overwrite`,
                    );
                }
                return;
            }
            const seed = resolveProjectIdentitySeed(db);
            if (seed.skippedCycles.length > 0) {
                // Legacy merge flows could store old→new rows with no
                // acyclicity check; a cyclic chain must not permanently fail
                // the migration (and disable the plugin), so those identities
                // stay unregistered until touched by a supported writer.
                log(
                    `[migrations] v82: skipped ${seed.skippedCycles.length} identity chain(s) with rekey cycles: ${seed.skippedCycles.join(", ")}`,
                );
            }
            createClaimsAndEvidenceSchema(db);
            seedProjectRegistry(db, seed, Date.now());
            assertProjectRegistrySeed(db, seed);
            assertClaimsSchemaForeignKeys(db);
        },
    },
    {
        version: 83,
        description: "context-complete synapse batch ledger with versioned CAS state",
        up(db: Database): void {
            if (!tableExists(db, "synapse_batch_ledger")) {
                db.exec(synapseBatchLedgerDdl("synapse_batch_ledger"));
                db.exec(synapseBatchLedgerIndexDdl(false));
                invalidateUnprovenSynapseDestinationRowsV83(db);
                return;
            }
            const columns = new Set(
                (
                    db.prepare("PRAGMA table_info(synapse_batch_ledger)").all() as Array<{
                        name: string;
                    }>
                ).map((row) => row.name),
            );
            if (columns.has("state_version")) {
                const hasInterruptedStaging = tableExists(db, "synapse_batch_ledger_legacy_v81");
                const ledgerIsEmpty =
                    db.prepare("SELECT 1 FROM synapse_batch_ledger LIMIT 1").get() == null;
                // The staging table marks an interrupted replacement. An empty
                // target ledger can also be precreated by database initialization;
                // without any receipt, Synapse destination rows are unproven.
                // A populated target ledger without staging may contain
                // context-complete receipts and must remain untouched on repair reruns.
                if (hasInterruptedStaging || ledgerIsEmpty) {
                    invalidateUnprovenSynapseDestinationRowsV83(db);
                }
                if (hasInterruptedStaging) {
                    db.exec("DROP TABLE synapse_batch_ledger_legacy_v81");
                }
                return;
            }
            const legacyCount = (
                db.prepare("SELECT COUNT(*) AS count FROM synapse_batch_ledger").get() as {
                    count: number;
                }
            ).count;
            // A staging copy can survive a failed prior attempt under
            // transaction adapters that do not honor the requested begin mode;
            // a leftover copy must not wedge every future open (same defense
            // as the v49 staging tables).
            db.exec("DROP TABLE IF EXISTS synapse_batch_ledger_legacy_v81");
            // Stage the legacy rows in a plain copy instead of ALTER RENAME:
            // a rename forces SQLite to re-resolve every trigger in the schema,
            // which fails closed on databases whose memories_au trigger dangles
            // (minimal fixtures without memories_fts).
            db.exec(
                "CREATE TABLE synapse_batch_ledger_legacy_v81 AS SELECT * FROM synapse_batch_ledger",
            );
            db.exec("DROP TABLE synapse_batch_ledger");
            db.exec(synapseBatchLedgerDdl("synapse_batch_ledger"));
            db.exec(synapseBatchLedgerIndexDdl(false));
            // Quarantine every legacy row: the v81 schema stored no lane role,
            // destination model, or application group, so no legacy receipt can
            // prove full context (including rows that claimed 'complete' before
            // destination persistence). Each is retained as a terminal
            // 'obsolete' receipt -- durable and queryable -- and normal domain
            // selectors rebuild the work under fresh context-complete rows.
            db.exec(`
                INSERT INTO synapse_batch_ledger
                    (project_path, session_id, scope, lane_role, destination_model,
                     application_group, request_key, manifest_json, state, state_version,
                     job_id, cursor, deadline_at, restart_count, failure_disposition,
                     created_at, updated_at)
                SELECT project_path, session_id, scope,
                       CASE WHEN session_id LIKE 'shadow:%' THEN 'shadow' ELSE 'primary' END,
                       '', '', request_key, manifest_json, 'obsolete', 0,
                       job_id, cursor, NULL, 0, NULL,
                       created_at, updated_at
                FROM synapse_batch_ledger_legacy_v81
            `);
            const copied = (
                db.prepare("SELECT COUNT(*) AS count FROM synapse_batch_ledger").get() as {
                    count: number;
                }
            ).count;
            if (copied !== legacyCount) {
                throw new Error(
                    `v83 ledger copy postcondition failed: ${copied} of ${legacyCount} rows`,
                );
            }
            invalidateUnprovenSynapseDestinationRowsV83(db);
            db.exec("DROP TABLE synapse_batch_ledger_legacy_v81");
        },
    },
    {
        version: 84,
        description:
            "memories-to-claims compatibility contract: crosswalk, revision metadata, operation envelope, outbox, generations, and semantic write guards",
        up(db: Database): void {
            // A replayed v84 must no-op over its own published schema, but a
            // partial or foreign `legacy_memory_claims` table is corruption.
            if (tableExists(db, "legacy_memory_claims")) {
                const missing = MEMORY_CLAIMS_COMPAT_TABLES.filter(
                    (table) => !tableExists(db, table),
                );
                if (missing.length > 0) {
                    throw new Error(
                        `v84 replay guard: legacy_memory_claims exists but ${missing.join(", ")} missing; refusing to skip or overwrite`,
                    );
                }
                return;
            }
            createMemoryClaimsCompatSchema(db);
            hitClaimsMigrationFailpoint("claims-migration.010.ddl.after");

            // Sparse legacy databases that never ran v22 lack the meta table.
            db.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            `);
            const writeMeta = db.prepare(
                `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            );
            const hasMemories = tableExists(db, "memories");
            const corpus = hasMemories
                ? (db
                      .prepare(
                          "SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS boundary FROM memories",
                      )
                      .get() as { count: number; boundary: number })
                : { count: 0, boundary: 0 };
            // Record the high-water boundary and expected link count BEFORE the
            // guards install: the boundary guard triggers read this meta row.
            writeMeta.run(CLAIMS_BACKFILL_META_KEYS.boundaryMemoryId, String(corpus.boundary));
            writeMeta.run(CLAIMS_BACKFILL_META_KEYS.expectedRowCount, String(corpus.count));
            writeMeta.run(CLAIMS_BACKFILL_META_KEYS.rowsCursor, "0");
            writeMeta.run(CLAIMS_BACKFILL_META_KEYS.relationshipsCursor, "0");
            const v22Status = db
                .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                .get(V22_BACKFILL_META_KEY) as { value: string } | null | undefined;
            const v22Pending =
                v22Status != null &&
                (v22Status.value === "pending" || v22Status.value === "completed_with_failures");
            writeMeta.run(CLAIMS_BACKFILL_META_KEYS.v22Takeover, v22Pending ? "pending" : "none");
            const decision = decideClaimsBackfillMode(db, corpus.count, v22Pending);
            writeMeta.run(CLAIMS_BACKFILL_META_KEYS.mode, decision.mode);
            writeMeta.run(CLAIMS_BACKFILL_META_KEYS.calibrationDigest, decision.calibrationDigest);
            // The reason persists to meta so the doctor status can surface it
            // long after the migration log line scrolls away.
            writeMeta.run(CLAIMS_BACKFILL_MODE_REASON_META_KEY, decision.reason);
            log(`[migrations] v84: claims backfill mode ${decision.mode}: ${decision.reason}`);
            if (decision.mode === "empty") {
                // An empty corpus completes synchronously in the migration
                // (R7): there is nothing to convert, so the completion
                // checkpoint and U8 watermark publish here.
                writeMeta.run(CLAIMS_BACKFILL_META_KEYS.phase, "complete");
                writeMeta.run(CLAIMS_BACKFILL_META_KEYS.reconciliationVersion, "1");
                writeMeta.run(CLAIMS_BACKFILL_META_KEYS.finalOutboxWatermark, "0");
            } else {
                writeMeta.run(CLAIMS_BACKFILL_META_KEYS.phase, "rows");
            }

            if (hasMemories) installMemoryClaimsWriteGuards(db);
            if (decision.mode === "eager") {
                runEagerClaimsBackfillInMigrationTransaction(db);
            }
            assertMemoryClaimsSchemaForeignKeys(db);
        },
    },
    {
        version: 85,
        description:
            "bitemporal claim applicability streams, project-scoped git anchors, and observation source trust",
        up(db: Database): void {
            if (tableExists(db, "git_anchors")) {
                const missing = CLAIM_APPLICABILITY_TABLES.filter(
                    (table) => !tableExists(db, table),
                );
                if (missing.length > 0) {
                    throw new Error(
                        `v85 replay guard: git_anchors exists but ${missing.join(", ")} missing; refusing to skip or overwrite`,
                    );
                }
                if (!observationSourceTrustClassColumnExists(db)) {
                    throw new Error(
                        "v85 replay guard: applicability tables exist but observations.source_trust_class missing; refusing to skip or overwrite",
                    );
                }
                // Tables alone do not prove a complete replay: a database
                // shaped by an earlier draft of this schema could carry the
                // tables without the interval view or the append-only, chain,
                // time, and project guard triggers — accepting it would leave
                // readers without the view and ledger rows mutable.
                const missingObjects = missingClaimApplicabilitySchemaObjects(db);
                if (missingObjects.length > 0) {
                    throw new Error(
                        `v85 replay guard: applicability tables exist but ${missingObjects.join(", ")} missing; refusing to skip or overwrite`,
                    );
                }
                return;
            }
            if (observationSourceTrustClassColumnExists(db)) {
                throw new Error(
                    "v85 replay guard: observations.source_trust_class exists without the applicability tables; refusing to skip or overwrite",
                );
            }
            addObservationSourceTrustClassColumn(db);
            createClaimApplicabilitySchema(db);
            seedApplicabilityBaselines(db, Date.now());
            assertClaimApplicabilitySchemaForeignKeys(db);
        },
    },
    {
        version: 86,
        description:
            "claim trust policy: revision policy subjects, maturity ledger, dispositions, approvals, enforcement artifacts, and the effective-policy projection",
        up(db: Database): void {
            // A replayed v86 must no-op over its own published schema, but a
            // partial shape (tables without the view, indexes, or guard
            // triggers) is refused instead of skipped or overwritten.
            if (tableExists(db, "claim_revision_policy_subjects")) {
                const missing = CLAIM_POLICY_TABLES.filter((table) => !tableExists(db, table));
                if (missing.length > 0) {
                    throw new Error(
                        `v86 replay guard: claim_revision_policy_subjects exists but ${missing.join(", ")} missing; refusing to skip or overwrite`,
                    );
                }
                const missingObjects = missingClaimPolicySchemaObjects(db);
                if (missingObjects.length > 0) {
                    throw new Error(
                        `v86 replay guard: policy tables exist but ${missingObjects.join(", ")} missing; refusing to skip or overwrite`,
                    );
                }
                return;
            }
            createClaimPolicySchema(db);

            // Sparse legacy databases that never ran v22 lack the meta table.
            db.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            `);
            const writeMeta = db.prepare(
                `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            );
            // Record the deterministic seed boundary and fail-closed pending
            // phase (KTD11, R28) BEFORE any reconciliation: missing policy
            // rows read as CANDIDATE / unknown / automatic-hidden by contract.
            const corpus = db
                .prepare(
                    "SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS boundary FROM claim_revisions",
                )
                .get() as { count: number; boundary: number };
            writeMeta.run(CLAIM_POLICY_SEED_META_KEYS.boundaryRevisionId, String(corpus.boundary));
            writeMeta.run(CLAIM_POLICY_SEED_META_KEYS.expectedCount, String(corpus.count));
            writeMeta.run(CLAIM_POLICY_SEED_META_KEYS.cursor, "0");
            if (corpus.count === 0) {
                // An empty corpus completes synchronously in the migration.
                const watermark = tableExists(db, "claim_change_outbox")
                    ? ((
                          db
                              .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM claim_change_outbox")
                              .get() as { id: number }
                      ).id ?? 0)
                    : 0;
                writeMeta.run(CLAIM_POLICY_SEED_META_KEYS.phase, "complete");
                writeMeta.run(CLAIM_POLICY_SEED_META_KEYS.completionWatermark, String(watermark));
                writeMeta.run(
                    CLAIM_POLICY_SEED_META_KEYS.seededCounts,
                    JSON.stringify({ CANDIDATE: 0, CORROBORATED: 0, VERIFIED: 0 }),
                );
            } else {
                writeMeta.run(CLAIM_POLICY_SEED_META_KEYS.phase, "pending");
            }

            // Pre-v86 automatic context was assembled without a policy gate:
            // invalidate derived project-memory blocks and sticky auto-search
            // decisions instead of grandfathering unverified content (R28).
            if (tableExists(db, "project_state")) {
                db.exec("UPDATE project_state SET project_memory_epoch = project_memory_epoch + 1");
            }
            if (tableExists(db, "session_meta")) {
                const columns = new Set(
                    (
                        db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                            name: string;
                        }>
                    ).map((column) => column.name),
                );
                const resets: string[] = [];
                if (columns.has("cached_m0_bytes")) resets.push("cached_m0_bytes = NULL");
                if (columns.has("cached_m1_bytes")) resets.push("cached_m1_bytes = NULL");
                if (columns.has("cached_m0_project_memory_epoch")) {
                    resets.push("cached_m0_project_memory_epoch = NULL");
                }
                if (columns.has("auto_search_hint_decisions")) {
                    // Convert instead of clear: each pre-policy hint decision
                    // becomes a no-hint tombstone that PRESERVES its message
                    // id. The native store may hold an already-seeded copy of
                    // the hint text, its seed apply never deletes omitted
                    // rows, and the seed lane derives block ids from these
                    // decisions — an emptied list would leave pre-policy hint
                    // text (potentially unverified fragments) overlaying
                    // native transforms indefinitely, while a tombstone seeds
                    // the empty no-result shape over it.
                    const hintRows = db
                        .prepare(
                            `SELECT session_id AS sessionId,
                                    auto_search_hint_decisions AS decisions
                               FROM session_meta
                              WHERE auto_search_hint_decisions IS NOT NULL
                                AND auto_search_hint_decisions != ''
                                AND auto_search_hint_decisions != '[]'`,
                        )
                        .all() as Array<{ sessionId: string; decisions: string }>;
                    const updateHints = db.prepare(
                        "UPDATE session_meta SET auto_search_hint_decisions = ? WHERE session_id = ?",
                    );
                    for (const row of hintRows) {
                        let parsed: unknown = null;
                        try {
                            parsed = JSON.parse(row.decisions);
                        } catch {
                            parsed = null;
                        }
                        const tombstones = Array.isArray(parsed)
                            ? parsed.flatMap((value) => {
                                  const messageId =
                                      value !== null && typeof value === "object"
                                          ? (value as { messageId?: unknown }).messageId
                                          : undefined;
                                  return typeof messageId === "string" && messageId.length > 0
                                      ? [
                                            {
                                                messageId,
                                                decision: "no-hint",
                                                reason: "policy-reset",
                                            },
                                        ]
                                      : [];
                              })
                            : [];
                        updateHints.run(JSON.stringify(tombstones), row.sessionId);
                    }
                }
                if (resets.length > 0) {
                    // Interpolation is a compile-time column allowlist, not caller input.
                    // pi-lens-ignore: sql-injection
                    db.exec(`UPDATE session_meta SET ${resets.join(", ")}`);
                }
            }
            assertClaimPolicySchemaForeignKeys(db);
        },
    },
    {
        version: 87,
        description:
            "claim trust policy: the policy-subject origin guard requires SUPPORTING evidence (merged_from lineage no longer selects the origin)",
        up(db: Database): void {
            // The v86 guard accepted any claim_evidence row linking the
            // observation to the revision, including relation='merged_from';
            // merged lineage is provenance of a different observation, not
            // evidence supporting this revision, so an importer or merge
            // path could freeze the merged observation's taint as the
            // revision origin. Recreate the trigger (same name, so the v86
            // replay guard's object inventory is unchanged) with the
            // relation constrained. Databases created after the fix carry
            // the corrected body from createClaimPolicySchema; the
            // drop-and-create replays to identical results there.
            if (!tableExists(db, "claim_revision_policy_subjects")) return;
            db.exec(`
    DROP TRIGGER IF EXISTS claim_policy_subjects_origin_guard;
    CREATE TRIGGER claim_policy_subjects_origin_guard
    BEFORE INSERT ON claim_revision_policy_subjects
    WHEN NEW.origin_observation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM claim_evidence
        WHERE revision_id = NEW.revision_id
          AND observation_id = NEW.origin_observation_id
          AND relation = 'supports'
    )
    BEGIN SELECT RAISE(ABORT, 'claim_revision_policy_subjects origin must be supporting evidence for the same revision'); END;
            `);
        },
    },
    {
        version: 88,
        description:
            "claim trust policy: enforcement artifacts record the checkout root that enforced them (revalidation scopes to it)",
        up(db: Database): void {
            // Clones and worktrees of one repository share a project
            // identity, so artifact revalidation must only rehash from the
            // checkout that ran the enforcement — checkout B legitimately
            // lacks or differs at the same relative path. NULL (legacy rows)
            // reads as "owning checkout unknown" and revalidation skips it.
            if (!tableExists(db, "claim_enforcement_artifacts")) return;
            ensureColumn(db, "claim_enforcement_artifacts", "enforced_from_root", "TEXT");
        },
    },
    {
        version: 89,
        description:
            "claim trust policy: a live policy subject without a named origin only carries an inference taint (seed writes exempt)",
        up(db: Database): void {
            // The v87 guard validated only NAMED origins; with
            // origin_observation_id NULL any taint — including USER_EXPLICIT
            // — could be frozen with nothing backing it. Recreate the
            // trigger (same name, so the v86 replay guard's object inventory
            // is unchanged) with a second branch coupling a NULL origin to
            // inference taints for live writes. Legacy-seed subjects
            // (classification method ':seed') are exempt: the pre-v86 corpus
            // legitimately elevates boundary-gated metadata provenance whose
            // observations were never linked as evidence.
            if (!tableExists(db, "claim_revision_policy_subjects")) return;
            db.exec(`
    DROP TRIGGER IF EXISTS claim_policy_subjects_origin_guard;
    CREATE TRIGGER claim_policy_subjects_origin_guard
    BEFORE INSERT ON claim_revision_policy_subjects
    WHEN (
        NEW.origin_observation_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM claim_evidence
            WHERE revision_id = NEW.revision_id
              AND observation_id = NEW.origin_observation_id
              AND relation = 'supports'
        )
    ) OR (
        NEW.origin_observation_id IS NULL
        AND NEW.classification_method NOT LIKE '%:seed'
        AND NEW.origin_taint NOT IN ('ASSISTANT_INFERENCE', 'DREAMER_INFERENCE')
    )
    BEGIN SELECT RAISE(ABORT, 'claim_revision_policy_subjects origin must be supporting evidence for the same revision, and a live write without a named origin only carries an inference taint'); END;
            `);
        },
    },
];

/**
 * Invalidate Synapse-lane destination vectors whose exact source and lane
 * compatibility cannot be proven from durable state, inside the v83 migration
 * transaction (R24). Coverage, precisely:
 *
 * - `memory_embeddings`: rows under a Synapse lane identity
 *   (`model_id LIKE 'synapse:v1:%'`) carry no per-row source hash and memory
 *   content is mutable, so exact source compatibility is unprovable --
 *   deleted. Normal memory selectors rebuild them on demand.
 * - `git_commit_embeddings`: a commit's source text is fixed by its SHA (rows
 *   cascade-delete with `git_commits`) and `model_id` pins the lane
 *   (model+fingerprint), so source and lane compatibility are provable from
 *   durable state -- retained.
 * - `compartment_chunk_embeddings`: compartment text is mutable, and the
 *   search read path serves stored vectors without reconstructing source
 *   windows. A stored `chunk_hash` therefore cannot prove source compatibility
 *   during migration. All Synapse rows are deleted and normal selectors
 *   rebuild them from current source text.
 * - Rows under any non-Synapse `model_id` (local/openai lanes) are never
 *   touched (R25).
 */
function invalidateUnprovenSynapseDestinationRowsV83(db: Database): void {
    const laneLike = "synapse:v1:%";
    if (tableExists(db, "memory_embeddings")) {
        const deleted = db
            .prepare("DELETE FROM memory_embeddings WHERE model_id LIKE ?")
            .run(laneLike).changes;
        if (deleted > 0) {
            log(`[migrations] v83: invalidated ${deleted} unproven synapse memory embedding(s)`);
        }
    }
    if (tableExists(db, "compartment_chunk_embeddings")) {
        const deleted = db
            .prepare("DELETE FROM compartment_chunk_embeddings WHERE model_id LIKE ?")
            .run(laneLike).changes;
        if (deleted > 0) {
            log(`[migrations] v83: invalidated ${deleted} unproven synapse chunk embedding(s)`);
        }
    }
}

/**
 * Highest version in the MIGRATIONS array. `LATEST_SUPPORTED_VERSION` in
 * storage-db.ts (the schema-fence ceiling) MUST equal this — a stale ceiling
 * makes the DB refuse to open after the new migration applies (a real bug the
 * project hit during v2 work). A unit test asserts the two stay in lockstep.
 */
export const LATEST_MIGRATION_VERSION: number = MIGRATIONS.reduce(
    (max, m) => Math.max(max, m.version),
    0,
);

function ensureMigrationsTable(db: Database): void {
    db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			description TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		)
	`);
}

function getCurrentVersion(db: Database): number {
    const row = db
        .prepare(
            "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version < ?",
        )
        .get(FORK_MIGRATION_VERSION_FLOOR) as { version: number } | null;
    return row?.version ?? 0;
}

function isMigrationApplied(db: Database, version: number): boolean {
    return db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version) != null;
}

/**
 * Detect the specific case where a sibling process already committed the
 * same `schema_migrations` row we're about to insert. BEGIN IMMEDIATE now
 * prevents this race for supported adapters by serializing before the version
 * read. Keep this narrow guard as a secondary backstop for legacy or unusual
 * transaction adapters that do not honor the requested begin mode.
 *
 * Important: only PRIMARY KEY conflicts on `schema_migrations` are
 * swallowed. Any other failure (CREATE TABLE, ALTER TABLE, data heal,
 * etc.) surfaces normally and fail-closes per contract.
 */
export function isSiblingMigrationConflict(db: Database, error: unknown, version: number): boolean {
    if (!(error instanceof Error)) return false;
    // Identify "PRIMARY KEY conflict on schema_migrations(version)" by the SQLite
    // ERROR MESSAGE — which originates from the C library (sqlite3_errmsg) and is
    // identical across bun:sqlite and node:sqlite, e.g.
    // "UNIQUE constraint failed: schema_migrations.version". We deliberately do NOT
    // hard-gate on `error.code`: bun:sqlite reports SQLITE_CONSTRAINT_PRIMARYKEY/
    // _UNIQUE, but node:sqlite (Pi / Desktop) can report a different or absent code
    // for the SAME conflict, and a strict code-only gate would fail-CLOSE a
    // legitimate concurrent-startup race there (the schema-fence incident class).
    // The message guard below already excludes a PK/UNIQUE collision the migration
    // BODY could raise on some other table, and the row-existence check is the
    // authoritative confirmation that a sibling actually applied this version.
    const msg = error.message;
    if (!msg.includes("schema_migrations")) return false;
    if (!msg.toLowerCase().includes("version")) return false;
    // Final guard: confirm the row is actually present now. If something
    // else somehow produced this error shape without the row landing, we
    // want to fall through to fail-closed.
    const confirmed = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
    return confirmed != null;
}

/**
 * Run all pending migrations sequentially.
 * Each migration runs in its own transaction — if it fails, only that migration rolls back.
 * Already-applied migrations are skipped.
 *
 * Migration application re-reads the upstream-lane version under BEGIN IMMEDIATE
 * before choosing one migration. Concurrent starters therefore serialize before
 * taking a read snapshot: one applies the migration and the waiter observes the
 * advanced version instead of failing a deferred read-to-write lock upgrade.
 */
export function runMigrations(db: Database): void {
    try {
        ensureMigrationsTable(db);
    } catch (error) {
        if (isSqliteLockError(error)) {
            throw new MigrationLockBusyError(
                `failed to prepare migration lock: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        throw error;
    }

    let loggedPlan = false;
    let touchedLegacyAuthorityBatch = false;
    while (true) {
        let migration: Migration | undefined;
        let currentVersion = 0;
        try {
            const applied = db
                .transaction(() => {
                    currentVersion = getCurrentVersion(db);
                    // Keep the append-only version boundary for legacy databases whose
                    // bookkeeping contains only a current-version row. Within the pending
                    // range, check each candidate's row directly so downstream rows at or
                    // above the reserved floor cannot make a sibling migration re-select
                    // an already-applied version.
                    migration = MIGRATIONS.find(
                        (candidate) =>
                            candidate.version > currentVersion &&
                            !isMigrationApplied(db, candidate.version),
                    );
                    if (!migration) return false;

                    if (!loggedPlan) {
                        const pendingCount = MIGRATIONS.filter(
                            (candidate) =>
                                candidate.version > currentVersion &&
                                !isMigrationApplied(db, candidate.version),
                        ).length;
                        log(
                            `[migrations] current upstream migration lane: ${currentVersion}, applying ${pendingCount} migration(s)`,
                        );
                        loggedPlan = true;
                    }

                    migration.up(db);
                    db.prepare(
                        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                    ).run(migration.version, migration.description, Date.now());
                    if (migration.version === 84) {
                        hitClaimsMigrationFailpoint("claims-migration.040.version.after");
                    }
                    return true;
                })
                .immediate();

            if (!applied || !migration) break;
            if (migration.version === 84) {
                hitClaimsMigrationFailpoint("claims-migration.050.commit.after");
            }
            if (migration.version <= 61) touchedLegacyAuthorityBatch = true;
            log(`[migrations] applied v${migration.version}: ${migration.description}`);
        } catch (error) {
            if (!migration && isSqliteLockError(error)) {
                throw new MigrationLockBusyError(
                    `failed to acquire migration write lock: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            if (migration && isSiblingMigrationConflict(db, error, migration.version)) {
                // BEGIN IMMEDIATE prevents the normal race, but retain the narrow
                // PK-conflict tolerance for unusual SQLite adapters or callers.
                log(
                    `[migrations] v${migration.version} already applied by sibling instance — resuming with re-read version`,
                );
                const reReadVersion = getCurrentVersion(db);
                if (reReadVersion > currentVersion) continue;
                throw new Error(
                    `Migration v${migration.version} failed: sibling conflict reported but version did not advance. Database may need manual repair.`,
                );
            }

            const version = migration?.version ?? currentVersion + 1;
            const description = migration?.description ?? "acquire migration write lock";
            log(
                `[migrations] FAILED v${version}: ${description} — ${error instanceof Error ? error.message : String(error)}`,
            );
            throw new Error(
                `Migration v${version} failed: ${error instanceof Error ? error.message : String(error)}. Database may need manual repair.`,
            );
        }
    }

    if (touchedLegacyAuthorityBatch) {
        try {
            db.transaction(() => installLatestAuthorityTriggers(db)).immediate();
        } catch (error) {
            throw new Error(
                `Migration authority-trigger postcondition failed: ${error instanceof Error ? error.message : String(error)}. Database may need manual repair.`,
            );
        }
    }

    if (loggedPlan) {
        log(
            `[migrations] upstream migration lane now: ${MIGRATIONS[MIGRATIONS.length - 1].version}`,
        );
    }
}

/**
 * Run migrations without blocking the event loop while a sibling owns SQLite's
 * write lock. Only failures from the lock/check phase are retried; migration
 * body failures continue to fail closed immediately.
 */
export interface MigrationRetryOptions {
    retryDelaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
}

export async function runMigrationsWithRetry(
    db: Database,
    options: MigrationRetryOptions = {},
): Promise<void> {
    const retryDelaysMs = options.retryDelaysMs ?? MIGRATION_LOCK_RETRY_DELAYS_MS;
    const sleep =
        options.sleep ??
        ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    const totalAttempts = retryDelaysMs.length + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        log(`[migrations] migration lock check attempt ${attempt}/${totalAttempts}`);
        try {
            runMigrations(db);
            return;
        } catch (error) {
            if (!(error instanceof MigrationLockBusyError)) throw error;
            const delayMs = retryDelaysMs[attempt - 1];
            if (delayMs === undefined) throw error;
            log(
                `[migrations] migration write lock is busy; retrying attempt ${attempt + 1}/${totalAttempts} in ${delayMs}ms`,
            );
            await sleep(delayMs);
        }
    }
}
