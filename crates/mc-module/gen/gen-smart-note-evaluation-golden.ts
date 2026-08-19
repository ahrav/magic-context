/**
 * Generate the frozen smart-note evaluation characterization golden.
 *
 * Captures CURRENT file-authority lifecycle behavior (transition writes,
 * schedule math, phase selection) by driving the live TS helpers against an
 * in-memory SQLite notes table with a frozen clock and pinned timezone. The
 * TypeScript reducer (evaluation-state.ts) and the Rust reducer
 * (crates/mc-module/src/smart_note_evaluation.rs) both replay this fixture.
 *
 * Run: bun crates/mc-module/gen/gen-smart-note-evaluation-golden.ts
 *
 * Regenerating must produce no diff; any semantic change requires review.
 */
// Pin the timezone BEFORE any Date use — cron matching reads local civil time.
process.env.TZ = "America/Los_Angeles";

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const genDir = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(genDir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);

const storage = await import(resolve("./src/features/magic-context/smart-notes/storage"));
const storageNotes = await import(resolve("./src/features/magic-context/storage-notes"));
const schedule = await import(resolve("./src/features/magic-context/smart-notes/schedule"));
const types = await import(resolve("./src/features/magic-context/smart-notes/types"));

const { getDueCompiledSmartNoteChecks, getSmartNotesNeedingCompilation, getStaleCompiledSmartNotes } =
    storage;
const { getPendingSmartNotes } = storageNotes;
const { nextSmartNoteCheckDueAt } = schedule;
const { parseSmartNoteManifest } = types;

// Do not edit the legacy writers below: reducers must match this behavior,
// never the reverse.

const SMART_NOTE_CHECK_POLICY_VERSION = types.SMART_NOTE_CHECK_POLICY_VERSION as number;

function legacyBackoffMs(failureCount: number): number {
    const minutes = Math.min(24 * 60, 5 * 2 ** Math.max(0, failureCount - 1));
    return minutes * 60 * 1000;
}

function legacyReadFailureCount(db: Database, noteId: number, column: string): number {
    const row = db.prepare(`SELECT ${column} AS count FROM notes WHERE id = ?`).get(noteId) as
        | { count?: number | null }
        | undefined;
    return row?.count ?? 0;
}

function storeCompiledSmartNoteCheck(
    db: Database,
    args: {
        noteId: number;
        compiledCheck: string;
        manifest: unknown;
        checkHash: string;
        checkCron: string;
        nextDueAt: number;
        now: number;
    },
): void {
    db.prepare(
        `UPDATE notes
         SET compiled_check = ?,
             manifest_json = ?,
             check_hash = ?,
             check_cron = ?,
             check_version = 1,
             check_status = 'compiled',
             check_failure_count = 0,
             check_network_failure_count = 0,
             check_quarantined_until = NULL,
             check_next_due_at = ?,
             check_compiled_at = ?,
             check_false_since_at = COALESCE(check_false_since_at, ?),
             check_last_liveness_at = NULL,
             policy_version = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`,
    ).run(
        args.compiledCheck,
        JSON.stringify(args.manifest),
        args.checkHash,
        args.checkCron,
        args.nextDueAt,
        args.now,
        args.now,
        SMART_NOTE_CHECK_POLICY_VERSION,
        args.now,
        args.noteId,
    );
}

function markCompiledCheckFalse(db: Database, noteId: number, nextDueAt: number, now: number): void {
    db.prepare(
        `UPDATE notes
         SET last_checked_at = ?,
             updated_at = ?,
             check_next_due_at = ?,
             check_failure_count = 0,
             check_network_failure_count = 0,
             check_false_since_at = COALESCE(check_false_since_at, ?)
         WHERE id = ? AND type = 'smart'`,
    ).run(now, now, nextDueAt, now, noteId);
}

function markCompiledCheckLogicFailure(
    db: Database,
    noteId: number,
    now: number,
    maxFailures: number,
): void {
    const failureCount = legacyReadFailureCount(db, noteId, "check_failure_count") + 1;
    const status = failureCount >= maxFailures ? "failing" : "compiled";
    db.prepare(
        `UPDATE notes
         SET check_failure_count = ?,
             check_status = ?,
             check_next_due_at = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`,
    ).run(failureCount, status, now + legacyBackoffMs(failureCount), now, noteId);
}

function markCompiledCheckNetworkFailure(
    db: Database,
    noteId: number,
    now: number,
    maxFailures: number,
): void {
    const failureCount = legacyReadFailureCount(db, noteId, "check_network_failure_count") + 1;
    const quarantinedUntil = now + legacyBackoffMs(failureCount);
    const status = failureCount >= maxFailures ? "failing" : "compiled";
    db.prepare(
        `UPDATE notes
         SET check_network_failure_count = ?,
             check_status = ?,
             check_next_due_at = ?,
             check_quarantined_until = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`,
    ).run(failureCount, status, quarantinedUntil, quarantinedUntil, now, noteId);
}

function markSmartNoteLivenessChecked(db: Database, noteId: number, now: number): void {
    db.prepare(
        `UPDATE notes
         SET check_last_liveness_at = ?, updated_at = ?
         WHERE id = ? AND type = 'smart'`,
    ).run(now, now, noteId);
}

function markSmartNoteCheckStatus(db: Database, noteId: number, status: string, now: number): void {
    db.prepare(
        `UPDATE notes SET check_status = ?, updated_at = ? WHERE id = ? AND type = 'smart'`,
    ).run(status, now, noteId);
}

function markSmartNoteCompilationFailure(
    db: Database,
    noteId: number,
    now: number,
    maxFailures: number,
): void {
    const failureCount = legacyReadFailureCount(db, noteId, "check_failure_count") + 1;
    const status = failureCount >= maxFailures ? "fallback" : "uncompiled";
    db.prepare(
        `UPDATE notes
         SET check_failure_count = ?,
             check_status = ?,
             check_next_due_at = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`,
    ).run(failureCount, status, now + legacyBackoffMs(failureCount), now, noteId);
}

function markNoteReady(db: Database, noteId: number, reason?: string): void {
    const now = Date.now();
    db.prepare(
        "UPDATE notes SET status = 'ready', ready_at = ?, ready_reason = ?, updated_at = ?, last_checked_at = ? WHERE id = ? AND type = 'smart'",
    ).run(now, reason ?? null, now, now, noteId);
}

function markNoteChecked(db: Database, noteId: number): void {
    const now = Date.now();
    db.prepare(
        "UPDATE notes SET last_checked_at = ?, updated_at = ? WHERE id = ? AND type = 'smart'",
    ).run(now, now, noteId);
}

// ---------------------------------------------------------------------------
// Constants frozen into the fixture. Values that live as private consts in
// evaluate-smart-notes.ts / runner.ts are recorded literally here; the Rust
// port asserts equality against these.
const CONSTANTS = {
    policy_version: types.SMART_NOTE_CHECK_POLICY_VERSION as number,
    floor_ms: types.SMART_NOTE_CHECK_FLOOR_MS as number,
    ceiling_ms: types.SMART_NOTE_CHECK_CEILING_MS as number,
    default_interval_ms: types.SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS as number,
    max_staleness_ms: types.SMART_NOTE_CHECK_MAX_STALENESS_MS as number,
    liveness_recheck_ms: types.SMART_NOTE_CHECK_LIVENESS_RECHECK_MS as number,
    // evaluate-smart-notes.ts private caps
    max_compile_per_run: 5,
    max_fallback_per_run: 3,
    max_compilation_failures: 3,
    // runner.ts private caps
    default_max_checks: 10,
    max_failures_before_reauthor: 3,
    // storage.ts backoffMs(n) = min(24h, 5 * 2^(n-1) minutes)
    backoff_minutes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
        Math.min(24 * 60, 5 * 2 ** Math.max(0, n - 1)),
    ),
};

// ---------------------------------------------------------------------------
// In-memory notes table covering every column the live helpers touch.
function newDb(): Database {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE notes (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        session_id TEXT,
        project_path TEXT,
        surface_condition TEXT,
        compiled_provider TEXT,
        compiled_config TEXT,
        compiled_at INTEGER,
        compile_status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_checked_at INTEGER,
        ready_at INTEGER,
        ready_reason TEXT,
        anchor_ordinal INTEGER,
        compiled_check TEXT,
        manifest_json TEXT,
        check_hash TEXT,
        check_cron TEXT,
        check_version INTEGER NOT NULL DEFAULT 0,
        check_status TEXT NOT NULL DEFAULT 'uncompiled',
        check_failure_count INTEGER NOT NULL DEFAULT 0,
        check_network_failure_count INTEGER NOT NULL DEFAULT 0,
        check_quarantined_until INTEGER,
        check_next_due_at INTEGER,
        check_compiled_at INTEGER,
        check_false_since_at INTEGER,
        check_last_liveness_at INTEGER,
        policy_version INTEGER NOT NULL DEFAULT 1,
        harness TEXT NOT NULL DEFAULT 'golden'
    )`);
    return db;
}

// Lifecycle projection captured for pre/expected state.
const LIFECYCLE_COLUMNS = [
    "status",
    "ready_at",
    "ready_reason",
    "last_checked_at",
    "updated_at",
    "compiled_check",
    "manifest_json",
    "check_hash",
    "check_cron",
    "check_version",
    "check_status",
    "check_failure_count",
    "check_network_failure_count",
    "check_quarantined_until",
    "check_next_due_at",
    "check_compiled_at",
    "check_false_since_at",
    "check_last_liveness_at",
    "policy_version",
] as const;

type Lifecycle = Record<(typeof LIFECYCLE_COLUMNS)[number], unknown>;

interface NoteSeed {
    id: number;
    status?: string;
    content?: string;
    surface_condition?: string | null;
    compile_status?: string | null;
    created_at?: number;
    updated_at?: number;
    last_checked_at?: number | null;
    ready_at?: number | null;
    ready_reason?: string | null;
    compiled_check?: string | null;
    manifest_json?: string | null;
    check_hash?: string | null;
    check_cron?: string | null;
    check_version?: number;
    check_status?: string;
    check_failure_count?: number;
    check_network_failure_count?: number;
    check_quarantined_until?: number | null;
    check_next_due_at?: number | null;
    check_compiled_at?: number | null;
    check_false_since_at?: number | null;
    check_last_liveness_at?: number | null;
    policy_version?: number;
}

const PROJECT = "/golden/project";
const BASE = Date.parse("2026-06-15T17:00:00Z");

function insertNote(db: Database, seed: NoteSeed): void {
    db.prepare(
        `INSERT INTO notes (
            id, type, status, content, session_id, project_path, surface_condition,
            compile_status, created_at, updated_at, last_checked_at, ready_at, ready_reason,
            compiled_check, manifest_json, check_hash, check_cron, check_version,
            check_status, check_failure_count, check_network_failure_count,
            check_quarantined_until, check_next_due_at, check_compiled_at,
            check_false_since_at, check_last_liveness_at, policy_version
        ) VALUES (?, 'smart', ?, ?, 'sess-golden', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        seed.id,
        seed.status ?? "pending",
        seed.content ?? `note content #${seed.id}`,
        PROJECT,
        seed.surface_condition ?? `condition #${seed.id}`,
        seed.compile_status ?? null,
        seed.created_at ?? BASE - 1_000_000,
        seed.updated_at ?? BASE - 1_000_000,
        seed.last_checked_at ?? null,
        seed.ready_at ?? null,
        seed.ready_reason ?? null,
        seed.compiled_check ?? null,
        seed.manifest_json ?? null,
        seed.check_hash ?? null,
        seed.check_cron ?? null,
        seed.check_version ?? 0,
        seed.check_status ?? "uncompiled",
        seed.check_failure_count ?? 0,
        seed.check_network_failure_count ?? 0,
        seed.check_quarantined_until ?? null,
        seed.check_next_due_at ?? null,
        seed.check_compiled_at ?? null,
        seed.check_false_since_at ?? null,
        seed.check_last_liveness_at ?? null,
        seed.policy_version ?? 1,
    );
}

function readLifecycle(db: Database, id: number): Lifecycle {
    const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Record<string, unknown>;
    const out = {} as Lifecycle;
    for (const col of LIFECYCLE_COLUMNS) out[col] = row[col] ?? null;
    return out;
}

const realNow = Date.now;
function withFrozenClock<T>(now: number, fn: () => T): T {
    Date.now = () => now;
    try {
        return fn();
    } finally {
        Date.now = realNow;
    }
}

// ---------------------------------------------------------------------------
// Transition cases. Each case replays the exact helper sequence production
// code (evaluate-smart-notes.ts / runner.ts) runs for one phase outcome.

interface TransitionCase {
    id: string;
    phase: "compile" | "due" | "liveness" | "fallback";
    outcome: Record<string, unknown>;
    note_id: number;
    now: number;
    pre: Lifecycle;
    expected: Lifecycle;
}

const ARTIFACT_MANIFEST = {
    capabilities: ["readFile"],
    readFiles: ["docs/x.md"],
    signals: ["docs/x.md mentions release"],
    summary: "watch docs/x.md",
};
const ARTIFACT = {
    compiled_check: "function check(cap) { return { met: false }; }",
    manifest_json: JSON.stringify(ARTIFACT_MANIFEST),
    check_hash: "a".repeat(64),
    // Transition vectors use the test process's timezone, so check_cron must
    // be timezone-invariant.
    check_cron: "* * * * *",
};

const transitionCases: TransitionCase[] = [];

function transitionCase(args: {
    id: string;
    phase: TransitionCase["phase"];
    outcome: Record<string, unknown>;
    seed: NoteSeed;
    now?: number;
    apply: (db: Database, noteId: number, now: number) => void;
}): void {
    const now = args.now ?? BASE;
    const db = newDb();
    insertNote(db, args.seed);
    const pre = readLifecycle(db, args.seed.id);
    withFrozenClock(now, () => args.apply(db, args.seed.id, now));
    const expected = readLifecycle(db, args.seed.id);
    transitionCases.push({
        id: args.id,
        phase: args.phase,
        outcome: args.outcome,
        note_id: args.seed.id,
        now,
        pre,
        expected,
    });
    db.close();
}

function applyCompileSuccess(db: Database, noteId: number, now: number, met: boolean): void {
    const nextDueAt = nextSmartNoteCheckDueAt(ARTIFACT.check_cron, {
        now,
        noteId,
        hash: ARTIFACT.check_hash,
    });
    storeCompiledSmartNoteCheck(db, {
        noteId,
        compiledCheck: ARTIFACT.compiled_check,
        manifest: ARTIFACT_MANIFEST,
        checkHash: ARTIFACT.check_hash,
        checkCron: ARTIFACT.check_cron,
        nextDueAt,
        now,
    });
    if (met) {
        markNoteReady(db, noteId, `Smart note #${noteId}: compiled check returned met=true`);
    } else {
        markCompiledCheckFalse(db, noteId, nextDueAt, now);
    }
}

// runner.ts hostGeneratedReadyReason
function dueReadyReason(noteId: number, manifestJson: string | null): string {
    const manifest = parseSmartNoteManifest(manifestJson);
    const signal = manifest.signals?.[0] ?? manifest.summary ?? "compiled check returned met=true";
    return `Smart note #${noteId}: ${signal}`.slice(0, 240);
}

const compileOutcomeMet = {
    kind: "compiled_met",
    compiled_check: ARTIFACT.compiled_check,
    manifest_json: ARTIFACT.manifest_json,
    check_hash: ARTIFACT.check_hash,
    check_cron: ARTIFACT.check_cron,
};
const compileOutcomeFalse = { ...compileOutcomeMet, kind: "compiled_false" };

// --- compile phase
transitionCase({
    id: "compile_met_fresh",
    phase: "compile",
    outcome: compileOutcomeMet,
    seed: { id: 1 },
    apply: (db, id, now) => applyCompileSuccess(db, id, now, true),
});
transitionCase({
    id: "compile_false_fresh",
    phase: "compile",
    outcome: compileOutcomeFalse,
    seed: { id: 2 },
    apply: (db, id, now) => applyCompileSuccess(db, id, now, false),
});
transitionCase({
    id: "compile_false_preserves_false_since",
    phase: "compile",
    outcome: compileOutcomeFalse,
    seed: { id: 3, check_false_since_at: BASE - 3_600_000 },
    apply: (db, id, now) => applyCompileSuccess(db, id, now, false),
});
transitionCase({
    id: "compile_met_recompile_resets_counters",
    phase: "compile",
    outcome: compileOutcomeMet,
    seed: {
        id: 4,
        check_status: "failing",
        compiled_check: "function check(cap) { return { met: false }; } // old",
        manifest_json: JSON.stringify({ capabilities: [] }),
        check_hash: "b".repeat(64),
        check_cron: "0 * * * *",
        check_version: 1,
        check_failure_count: 3,
        check_network_failure_count: 2,
        check_quarantined_until: BASE + 60_000,
        check_next_due_at: BASE - 60_000,
        check_compiled_at: BASE - 86_400_000,
        check_last_liveness_at: BASE - 7_200_000,
    },
    apply: (db, id, now) => applyCompileSuccess(db, id, now, true),
});
transitionCase({
    id: "compile_failed_first",
    phase: "compile",
    outcome: { kind: "compilation_failed" },
    seed: { id: 5 },
    apply: (db, id, now) => markSmartNoteCompilationFailure(db, id, now, 3),
});
transitionCase({
    id: "compile_failed_second",
    phase: "compile",
    outcome: { kind: "compilation_failed" },
    seed: { id: 6, check_failure_count: 1 },
    apply: (db, id, now) => markSmartNoteCompilationFailure(db, id, now, 3),
});
transitionCase({
    id: "compile_failed_third_enters_fallback",
    phase: "compile",
    outcome: { kind: "compilation_failed" },
    seed: { id: 7, check_failure_count: 2 },
    apply: (db, id, now) => markSmartNoteCompilationFailure(db, id, now, 3),
});

// --- due phase
const dueSeed = (id: number, extra: Partial<NoteSeed> = {}): NoteSeed => ({
    id,
    compiled_check: ARTIFACT.compiled_check,
    manifest_json: ARTIFACT.manifest_json,
    check_hash: ARTIFACT.check_hash,
    check_cron: ARTIFACT.check_cron,
    check_version: 1,
    check_status: "compiled",
    check_compiled_at: BASE - 86_400_000,
    check_next_due_at: BASE - 60_000,
    check_false_since_at: BASE - 43_200_000,
    ...extra,
});

transitionCase({
    id: "due_met_manifest_signal_reason",
    phase: "due",
    outcome: { kind: "met" },
    seed: dueSeed(10),
    apply: (db, id) => markNoteReady(db, id, dueReadyReason(id, ARTIFACT.manifest_json)),
});
transitionCase({
    id: "due_met_summary_fallback_reason",
    phase: "due",
    outcome: { kind: "met" },
    seed: dueSeed(11, {
        manifest_json: JSON.stringify({ capabilities: [], summary: "watch the release page" }),
    }),
    apply: (db, id) =>
        markNoteReady(
            db,
            id,
            dueReadyReason(
                id,
                JSON.stringify({ capabilities: [], summary: "watch the release page" }),
            ),
        ),
});
transitionCase({
    id: "due_false_resets_counters_preserves_false_since",
    phase: "due",
    outcome: { kind: "false" },
    seed: dueSeed(12, { check_failure_count: 2, check_network_failure_count: 1 }),
    apply: (db, id, now) => {
        const nextDueAt = nextSmartNoteCheckDueAt(ARTIFACT.check_cron, {
            now,
            noteId: id,
            hash: ARTIFACT.check_hash,
        });
        markCompiledCheckFalse(db, id, nextDueAt, now);
    },
});
transitionCase({
    id: "due_false_first_sets_false_since",
    phase: "due",
    outcome: { kind: "false" },
    seed: dueSeed(13, { check_false_since_at: null }),
    apply: (db, id, now) => {
        const nextDueAt = nextSmartNoteCheckDueAt(ARTIFACT.check_cron, {
            now,
            noteId: id,
            hash: ARTIFACT.check_hash,
        });
        markCompiledCheckFalse(db, id, nextDueAt, now);
    },
});
transitionCase({
    id: "due_false_no_cron_default_interval",
    phase: "due",
    outcome: { kind: "false" },
    seed: dueSeed(14, { check_cron: null }),
    apply: (db, id, now) => {
        const nextDueAt = nextSmartNoteCheckDueAt(null, {
            now,
            noteId: id,
            hash: ARTIFACT.check_hash,
        });
        markCompiledCheckFalse(db, id, nextDueAt, now);
    },
});
transitionCase({
    id: "due_logic_failed_first",
    phase: "due",
    outcome: { kind: "logic_failed" },
    seed: dueSeed(15),
    apply: (db, id, now) => markCompiledCheckLogicFailure(db, id, now, 3),
});
transitionCase({
    id: "due_logic_failed_third_enters_failing",
    phase: "due",
    outcome: { kind: "logic_failed" },
    seed: dueSeed(16, { check_failure_count: 2 }),
    apply: (db, id, now) => markCompiledCheckLogicFailure(db, id, now, 3),
});
transitionCase({
    id: "due_network_failed_first_quarantines",
    phase: "due",
    outcome: { kind: "network_failed" },
    seed: dueSeed(17),
    apply: (db, id, now) => markCompiledCheckNetworkFailure(db, id, now, 3),
});
transitionCase({
    id: "due_network_failed_third_enters_failing",
    phase: "due",
    outcome: { kind: "network_failed" },
    seed: dueSeed(18, { check_network_failure_count: 2 }),
    apply: (db, id, now) => markCompiledCheckNetworkFailure(db, id, now, 3),
});
transitionCase({
    id: "due_counters_independent",
    phase: "due",
    outcome: { kind: "network_failed" },
    seed: dueSeed(19, { check_failure_count: 2, check_network_failure_count: 1 }),
    apply: (db, id, now) => markCompiledCheckNetworkFailure(db, id, now, 3),
});

// --- liveness phase
const livenessSeed = (id: number, extra: Partial<NoteSeed> = {}): NoteSeed =>
    dueSeed(id, {
        check_false_since_at: BASE - CONSTANTS.max_staleness_ms - 3_600_000,
        check_last_liveness_at: null,
        ...extra,
    });

transitionCase({
    id: "liveness_met",
    phase: "liveness",
    outcome: { kind: "met" },
    seed: livenessSeed(20),
    apply: (db, id, now) => {
        markSmartNoteLivenessChecked(db, id, now);
        markNoteReady(db, id, `Smart note #${id}: max-staleness liveness check returned met=true`);
    },
});
transitionCase({
    id: "liveness_false_reschedules",
    phase: "liveness",
    outcome: { kind: "false" },
    seed: livenessSeed(21, { check_failure_count: 1, check_network_failure_count: 1 }),
    apply: (db, id, now) => {
        const nextDueAt = nextSmartNoteCheckDueAt(ARTIFACT.check_cron, {
            now,
            noteId: id,
            hash: ARTIFACT.check_hash,
        });
        markSmartNoteLivenessChecked(db, id, now);
        markCompiledCheckFalse(db, id, nextDueAt, now);
    },
});
transitionCase({
    id: "liveness_logic_failed_enters_failing",
    phase: "liveness",
    outcome: { kind: "logic_failed" },
    seed: livenessSeed(22),
    apply: (db, id, now) => {
        markSmartNoteLivenessChecked(db, id, now);
        markSmartNoteCheckStatus(db, id, "failing", now);
    },
});
transitionCase({
    id: "liveness_network_failed_records_attempt_only",
    phase: "liveness",
    outcome: { kind: "network_failed" },
    seed: livenessSeed(23),
    apply: (db, id, now) => {
        markSmartNoteLivenessChecked(db, id, now);
    },
});

// --- fallback phase
transitionCase({
    id: "fallback_met",
    phase: "fallback",
    outcome: { kind: "met" },
    seed: { id: 30, check_status: "fallback", check_failure_count: 3 },
    apply: (db, id) =>
        markNoteReady(
            db,
            id,
            `Smart note #${id}: read-only confirmation evaluator returned met=true`,
        ),
});
transitionCase({
    id: "fallback_false_stays_fallback",
    phase: "fallback",
    outcome: { kind: "false" },
    seed: { id: 31, check_status: "fallback", check_failure_count: 3 },
    apply: (db, id, now) => {
        markNoteChecked(db, id);
        markSmartNoteCheckStatus(db, id, "fallback", now);
    },
});

// ---------------------------------------------------------------------------
// Schedule cases: nextSmartNoteCheckDueAt in the pinned timezone, including
// DST spring-forward / fall-back boundaries, clamps, and jitter determinism.

interface ScheduleCase {
    id: string;
    cron: string | null;
    now_ms: number;
    note_id: number;
    hash: string | null;
    expected_due_at: number;
}

const scheduleCases: ScheduleCase[] = [];
function scheduleCase(
    id: string,
    cron: string | null,
    nowIso: string,
    noteId: number,
    hash: string | null,
): void {
    const nowMs = Date.parse(nowIso);
    scheduleCases.push({
        id,
        cron,
        now_ms: nowMs,
        note_id: noteId,
        hash,
        expected_due_at: nextSmartNoteCheckDueAt(cron, { now: nowMs, noteId, hash }),
    });
}

scheduleCase("hourly_baseline", "0 * * * *", "2026-06-15T17:23:45Z", 42, "c".repeat(64));
scheduleCase(
    "every_five_minutes_floor_clamp",
    "*/5 * * * *",
    "2026-06-15T17:23:45Z",
    42,
    "c".repeat(64),
);
scheduleCase("every_minute_floor_clamp", "* * * * *", "2026-06-15T17:23:45Z", 7, "d".repeat(64));
scheduleCase("daily_ceiling_clamp", "0 3 * * *", "2026-06-15T11:00:00Z", 9, "e".repeat(64));
scheduleCase("no_cron_default_interval", null, "2026-06-15T17:23:45Z", 42, "c".repeat(64));
scheduleCase("empty_cron_default_interval", "", "2026-06-15T17:23:45Z", 42, "c".repeat(64));
scheduleCase(
    "invalid_cron_default_interval",
    "99 * * * *",
    "2026-06-15T17:23:45Z",
    42,
    "c".repeat(64),
);
// America/Los_Angeles spring-forward day: the 02:00 local hour does not exist,
// so a 02:30 schedule must land on the next day's real 02:30.
scheduleCase(
    "dst_spring_forward_skipped_hour",
    "30 2 * * *",
    "2026-03-08T09:00:00Z",
    42,
    "c".repeat(64),
);
scheduleCase("dst_spring_forward_cross", "0 3 * * *", "2026-03-08T09:30:00Z", 42, "c".repeat(64));
// America/Los_Angeles fall-back day: the 01:00 local hour repeats; the search
// must return the first matching instant, not double-fire the repeated hour.
scheduleCase(
    "dst_fall_back_repeated_hour",
    "30 1 * * *",
    "2026-11-01T08:00:00Z",
    42,
    "c".repeat(64),
);
scheduleCase(
    "dst_fall_back_after_first_pass",
    "30 1 * * *",
    "2026-11-01T08:45:00Z",
    42,
    "c".repeat(64),
);
// Rare schedules.
scheduleCase("feb29_beyond_ceiling_clamps", "0 0 29 2 *", "2026-06-15T17:00:00Z", 42, "c".repeat(64));
scheduleCase("vixie_dom_dow_or", "0 12 15 * 3", "2026-06-10T17:00:00Z", 42, "c".repeat(64));
// Jitter determinism across ids/hashes.
scheduleCase("jitter_varies_by_note_id", "0 * * * *", "2026-06-15T17:23:45Z", 43, "c".repeat(64));
scheduleCase("jitter_varies_by_hash", "0 * * * *", "2026-06-15T17:23:45Z", 42, "f".repeat(64));
scheduleCase("jitter_null_hash", "0 * * * *", "2026-06-15T17:23:45Z", 42, null);

// ---------------------------------------------------------------------------
// Selection cases: phase eligibility, ordering, caps, retina handoff.

interface SelectionCase {
    id: string;
    phase: "due" | "compile" | "liveness" | "fallback";
    now: number;
    limit: number;
    retina_handoff: boolean;
    notes: NoteSeed[];
    expected_ids: number[];
}

const selectionCases: SelectionCase[] = [];

function selectionCase(args: {
    id: string;
    phase: SelectionCase["phase"];
    now?: number;
    limit: number;
    retinaHandoff?: boolean;
    notes: NoteSeed[];
    select: (db: Database, now: number) => Array<{ id: number }>;
}): void {
    const now = args.now ?? BASE;
    const db = newDb();
    for (const seed of args.notes) insertNote(db, seed);
    const selected = withFrozenClock(now, () => args.select(db, now));
    selectionCases.push({
        id: args.id,
        phase: args.phase,
        now,
        limit: args.limit,
        retina_handoff: args.retinaHandoff ?? false,
        notes: args.notes.map((seed) => ({ ...seed })),
        expected_ids: selected.map((note) => note.id),
    });
    db.close();
}

selectionCase({
    id: "due_ordering_and_filters",
    phase: "due",
    limit: 10,
    notes: [
        dueSeed(1, { check_next_due_at: BASE - 5_000 }),
        dueSeed(2, { check_next_due_at: BASE - 10_000 }),
        dueSeed(3, { check_next_due_at: BASE + 60_000 }), // not due yet
        dueSeed(4, { check_next_due_at: BASE - 10_000, check_quarantined_until: BASE + 60_000 }), // quarantined
        dueSeed(5, { check_next_due_at: BASE - 1_000, policy_version: 0 }), // policy mismatch
        dueSeed(6, { check_next_due_at: BASE - 1_000, check_status: "failing" }), // not compiled
        dueSeed(7, { check_next_due_at: null }), // null due date = due
        dueSeed(8, { check_next_due_at: BASE - 10_000, status: "ready" }), // not pending
    ],
    select: (db, now) => getDueCompiledSmartNoteChecks(db, PROJECT, now, 10),
});
selectionCase({
    id: "due_cap_prefers_earliest",
    phase: "due",
    limit: 2,
    notes: [
        dueSeed(1, { check_next_due_at: BASE - 5_000 }),
        dueSeed(2, { check_next_due_at: BASE - 10_000 }),
        dueSeed(3, { check_next_due_at: BASE - 1_000 }),
    ],
    select: (db, now) => getDueCompiledSmartNoteChecks(db, PROJECT, now, 2),
});
selectionCase({
    id: "due_retina_handoff_excludes_provider_compiled",
    phase: "due",
    limit: 10,
    retinaHandoff: true,
    notes: [
        dueSeed(1, { check_next_due_at: BASE - 5_000, compile_status: "compiled" }),
        dueSeed(2, { check_next_due_at: BASE - 10_000, compile_status: "plain" }),
        dueSeed(3, { check_next_due_at: BASE - 1_000 }),
    ],
    select: (db, now) => getDueCompiledSmartNoteChecks(db, PROJECT, now, 10, true),
});
selectionCase({
    id: "compile_ordering_by_created_at",
    phase: "compile",
    limit: 5,
    notes: [
        { id: 1, created_at: BASE - 5_000 },
        { id: 2, created_at: BASE - 10_000 },
        { id: 3, created_at: BASE - 10_000 }, // created_at tie -> id order
        dueSeed(4, { check_next_due_at: BASE - 1_000 }), // compiled + current policy: not a candidate
        dueSeed(5, { check_next_due_at: BASE - 1_000, check_status: "failing" }), // failing -> recompile
        dueSeed(6, { check_next_due_at: BASE - 1_000, policy_version: 0 }), // policy mismatch -> recompile
        { id: 7, check_next_due_at: BASE + 60_000 }, // backoff not elapsed
        // The compile predicate matches fallback rows with NULL compiled_check.
        { id: 8, check_status: "fallback", check_failure_count: 3 },
    ],
    select: (db, now) => getSmartNotesNeedingCompilation(db, PROJECT, now, 5),
});
selectionCase({
    id: "compile_cap",
    phase: "compile",
    limit: 2,
    notes: [
        { id: 1, created_at: BASE - 3_000 },
        { id: 2, created_at: BASE - 2_000 },
        { id: 3, created_at: BASE - 1_000 },
    ],
    select: (db, now) => getSmartNotesNeedingCompilation(db, PROJECT, now, 2),
});
selectionCase({
    id: "liveness_ordering_and_recheck_window",
    phase: "liveness",
    limit: 3,
    notes: [
        livenessSeed(1, { check_false_since_at: BASE - CONSTANTS.max_staleness_ms - 7_200_000 }),
        livenessSeed(2, { check_false_since_at: BASE - CONSTANTS.max_staleness_ms - 3_600_000 }),
        livenessSeed(3, { check_false_since_at: BASE - 3_600_000 }), // not stale
        livenessSeed(4, {
            check_false_since_at: BASE - CONSTANTS.max_staleness_ms - 3_600_000,
            check_last_liveness_at: BASE - 60_000, // rechecked recently
        }),
        livenessSeed(5, {
            check_false_since_at: BASE - CONSTANTS.max_staleness_ms - 3_600_000,
            check_last_liveness_at: BASE - CONSTANTS.liveness_recheck_ms - 60_000, // due again
        }),
    ],
    select: (db, now) => getStaleCompiledSmartNotes(db, PROJECT, now, 3),
});
selectionCase({
    id: "fallback_pending_filter_and_cap",
    phase: "fallback",
    limit: 3,
    notes: [
        { id: 1, check_status: "fallback", check_failure_count: 3, created_at: BASE - 5_000 },
        { id: 2, check_status: "uncompiled", created_at: BASE - 4_000 },
        { id: 3, check_status: "fallback", check_failure_count: 3, created_at: BASE - 3_000 },
        { id: 4, check_status: "fallback", check_failure_count: 3, created_at: BASE - 2_000 },
        { id: 5, check_status: "fallback", check_failure_count: 3, created_at: BASE - 1_000 },
        { id: 6, check_status: "fallback", check_failure_count: 3, status: "ready" },
    ],
    // evaluate-smart-notes.ts: pendingNotes().filter(checkStatus === 'fallback').slice(0, 3)
    select: (db) =>
        getPendingSmartNotes(db, PROJECT)
            .filter((note: { checkStatus: string | null }) => note.checkStatus === "fallback")
            .slice(0, 3),
});
selectionCase({
    id: "fallback_retina_handoff_excluded",
    phase: "fallback",
    limit: 3,
    retinaHandoff: true,
    notes: [
        { id: 1, check_status: "fallback", check_failure_count: 3, compile_status: "compiled" },
        { id: 2, check_status: "fallback", check_failure_count: 3 },
    ],
    select: (db) =>
        getPendingSmartNotes(db, PROJECT)
            .filter(
                (note: { checkStatus: string | null; compileStatus: string | null }) =>
                    note.compileStatus !== "compiled" && note.checkStatus === "fallback",
            )
            .slice(0, 3),
});

// ---------------------------------------------------------------------------

const golden = {
    schema: "smart-note-evaluation-golden",
    provenance: {
        generator: "crates/mc-module/gen/gen-smart-note-evaluation-golden.ts",
        captured_from:
            "pre-extraction file-authority helpers (storage.ts, storage-notes.ts, schedule.ts)",
        timezone: "America/Los_Angeles",
    },
    constants: CONSTANTS,
    transition_cases: transitionCases,
    schedule_cases: scheduleCases,
    selection_cases: selectionCases,
};

const outPath = join(genDir, "..", "testdata", "smart-note-evaluation-golden.json");
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
console.log(
    `wrote ${outPath}: ${transitionCases.length} transition, ${scheduleCases.length} schedule, ${selectionCases.length} selection cases`,
);
