import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import type { Database as DatabaseType } from "@magic-context/core/shared/sqlite";
import { writeFileAtomic } from "../lib/atomic-write";
import {
    getPersistedSchemaVersion,
    openExistingContextDatabase,
    openExistingContextDatabaseForMutation,
    openExistingDatabase,
} from "../lib/database-access";
import { getOpenCodeDatabasePath, projectPathToPiSessionSlug } from "../lib/migration-paths";
import { getOmpSessionsRoot, getPiSessionsRoot } from "../lib/paths";

export interface MigrateOpenCodeSessionToPiOptions {
    /**
     * The migrator reads OpenCode session, message, and part rows through db.
     * The cortexkit DB owns Magic Context state.
     */
    db?: DatabaseLike;
    /**
     * cortexkitDb accesses Magic Context's shared database at `~/.local/share/cortexkit/magic-context/context.db`.
     * The migrator reads compartments and facts with `harness='opencode'`.
     * The migrator keys source rows by the source `session_id`.
     * The migrator writes copies under `harness='pi'` keyed by the new Pi `session_id`.
     * the migrator opens the canonical path read-write.
     *
     * A null cortexkitDb skips the cortexkit copy; the migrator writes JSONL only.
     */
    cortexkitDb?: DatabaseLike | null;
    fs?: FileSystemLike;
    now?: Date;
    sessionId: string;
    maxMessages?: number;
    dryRun?: boolean;
    opencodeDbPath?: string;
    cortexkitDbPath?: string;
    piSessionsRoot?: string;
    provider?: string;
    modelId?: string;
    /**
     * The migration journal key records targetHarness; targetHarness defaults to "pi".
     * Callers pass "omp" when the session JSONL is written into OMP's sessions root.
     */
    targetHarness?: "pi" | "omp";
}

export interface MigrationResult {
    outputPath: string;
    piSessionId: string;
    messageCount: number;
    byteCount: number;
    sourceMessageCount: number;
    /** compartmentsCopied counts OpenCode compartments copied to the new Pi session_id. */
    compartmentsCopied: number;
    /** factsCopied counts OpenCode session_facts copied to the new Pi session_id. */
    factsCopied: number;
    /** boundariesApproximated counts boundaries remapped to the nearest entry at or before the source boundary instead of exactly matched. */
    boundariesApproximated: number;
    compactionMarkerWritten: boolean;
    compactionBoundaryEntryId?: string;
    compactionFirstKeptEntryId?: string;
    /** cortexkitSchemaVersionBefore and cortexkitSchemaVersionAfter let callers verify that schema versions stay within the plugin's supported limit. */
    cortexkitSchemaVersionBefore?: number;
    cortexkitSchemaVersionAfter?: number;
    /**
     * The journal key hashes the source session and target harness.
     * The key is absent for dry runs.
     * The key is absent for JSONL-only migrations without a cortexkit database.
     */
    migrationKey?: string;
    /** True when a journal row from an earlier interrupted attempt supplied the Pi session identity. */
    journalResumed?: boolean;
    /** The migrator runs the recovery sweep before this migration when the journal is active. */
    recovery?: MigrationSweepReport;
    dryRun: boolean;
}

/**
 * `migration_pending` records in-flight migrations.
 * `source_session_id` lets `clearSession` remove crash-recovery records.
 * crash-recovery records.
 */
export interface MigrationPendingRow {
    migration_key: string;
    source_session_id: string;
    target_harness: string;
    pi_session_id: string;
    final_path: string;
    stage_path: string;
    content_sha256: string;
    phase: "staged" | "db_committed";
    created_at: number;
}

/** MigrationSweepReport reports reconciliation of interrupted migrations by journal phase. */
export interface MigrationSweepReport {
    /** completed counts finished migrations whose journal row outlived the final rename. */
    completed: number;
    /** rolledForward counts db_committed rows whose stage file was renamed to its final path. */
    rolledForward: number;
    /** rolledBack counts staged rows whose stage file was removed after shared state was proven absent. */
    rolledBack: number;
    /**
     * `db_committed` rows with neither stage nor final file have committed shared state but lost session bytes.
     * silently deleted.
     */
    lost: MigrationPendingRow[];
}

export interface MigrateCliOptions {
    from?: string;
    to?: string;
    session?: string;
    maxMessages?: number;
    dryRun?: boolean;
}

type DatabaseLike = Pick<DatabaseType, "prepare" | "close" | "exec">;

type FileSystemLike = {
    writeFileAtomic(path: string, data: string): unknown;
    unlinkSync(path: string): unknown;
    existsSync(path: string): boolean;
    renameSync(from: string, to: string): unknown;
    mkdirSync(path: string, options?: { recursive?: boolean }): unknown;
};

type StatementLike<T = unknown> = {
    get(...params: unknown[]): T | undefined;
    all(...params: unknown[]): T[];
    run(...params: unknown[]): unknown;
};

type OpenCodeSessionRow = {
    id: string;
    title?: string;
    directory?: string;
    path?: string | null;
    time_created: number;
};

type OpenCodeMessageRow = {
    id: string;
    time_created: number;
    data: string;
};

type OpenCodePartRow = {
    id: string;
    message_id: string;
    time_created: number;
    data: string;
};

type PiJson = Record<string, unknown>;

type OpenCodeMessageTokens = {
    input?: number;
    output?: number;
    reasoning?: number;
    total?: number;
    cache?: { read?: number; write?: number };
};

type OpenCodeMessageData = {
    role?: string;
    time?: { created?: number };
    modelID?: string;
    providerID?: string;
    model?: { providerID?: string; modelID?: string };
    tokens?: OpenCodeMessageTokens;
};

type OpenCodePartData = {
    type?: string;
    text?: string;
    filename?: string;
    name?: string;
    tool?: string;
    tool_name?: string;
    callID?: string;
    call_id?: string;
    toolCallId?: string;
    tool_call_id?: string;
    input?: unknown;
    output?: unknown;
    state?: {
        input?: unknown;
        output?: unknown;
        title?: string;
        metadata?: { output?: unknown };
    };
    metadata?: { anthropic?: { signature?: string } };
};

interface CortexkitCompartmentRow {
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    title: string;
    content: string;
    created_at: number;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number | null;
    episode_type: string | null;
    legacy: number;
}

interface CortexkitSessionFactRow {
    category: string;
    content: string;
    created_at: number;
    updated_at: number;
}

const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.5";
const MIGRATION_COMPACTION_SUMMARY =
    "Magic Context compacted prior conversation. See <session-history> block for the structured summary.";
const PART_LOOKUP_CHUNK_SIZE = 900;
/**
 * The migrator creates the staging directory as a sibling of the target sessions root.
 */
const MIGRATION_STAGE_DIRNAME = ".mc-migrations";

function defaultOpenCodeDbPath(): string {
    return getOpenCodeDatabasePath();
}

function defaultCortexkitDbPath(): string {
    return join(getMagicContextStorageDir(), "context.db");
}

function defaultPiSessionsRoot(): string {
    return getPiSessionsRoot();
}

function defaultFs(): FileSystemLike {
    return { writeFileAtomic, unlinkSync, existsSync, renameSync, mkdirSync };
}

function stmt<T>(db: DatabaseLike, sql: string): StatementLike<T> {
    return db.prepare(sql) as unknown as StatementLike<T>;
}

export function projectPathToPiDirSlug(
    projectPath: string,
    platform: NodeJS.Platform = process.platform,
): string {
    return projectPathToPiSessionSlug(projectPath, platform);
}

export function formatPiFilenameTimestamp(date: Date): string {
    return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

export function generateUuidV7(date = new Date()): string {
    const bytes = randomBytes(16);
    let ms = BigInt(date.getTime());
    for (let i = 5; i >= 0; i--) {
        bytes[i] = Number(ms & 0xffn);
        ms >>= 8n;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function shortId(): string {
    return randomBytes(4).toString("hex");
}

/**
 * The SHA-256 hash gives each (source session, target harness) migration a stable identity.
 * The hash fixes the journal PRIMARY KEY size and makes it filesystem-neutral.
 */
export function migrationKeyFor(sourceSessionId: string, targetHarness: string): string {
    return createHash("sha256").update(`${sourceSessionId}\n${targetHarness}`).digest("hex");
}

function hasMigrationJournal(db: DatabaseLike): boolean {
    return Boolean(
        stmt(
            db,
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration_pending'",
        ).get(),
    );
}

/**
 * The reconciler uses each journal row's phase and files to recover interrupted migrations.
 * The reconciler uses no time thresholds.
 *
 * When the final file exists, recovery deletes the journal row because the rename completed before the crash.
 * When phase is `db_committed` and no files exist, recovery retains the row and reports the lost staged bytes.
 *                                    silently delete.
 *
 * Idempotent: running it against an already-clean journal is a no-op.
 */
export function sweepPendingMigrations(
    db: DatabaseLike,
    fs: FileSystemLike = defaultFs(),
): MigrationSweepReport {
    const report: MigrationSweepReport = {
        completed: 0,
        rolledForward: 0,
        rolledBack: 0,
        lost: [],
    };
    if (!hasMigrationJournal(db)) return report;

    const rows = stmt<MigrationPendingRow>(
        db,
        `SELECT migration_key, source_session_id, target_harness, pi_session_id,
               final_path, stage_path, content_sha256, phase, created_at
          FROM migration_pending
      ORDER BY created_at ASC`,
    ).all();

    for (const row of rows) {
        if (fs.existsSync(row.final_path)) {
            // The rename completed, but the journal row remains because deletion did not run.
            stmt(db, "DELETE FROM migration_pending WHERE migration_key = ?").run(
                row.migration_key,
            );
            report.completed += 1;
            continue;
        }
        if (row.phase === "db_committed") {
            if (fs.existsSync(row.stage_path)) {
                // Shared state is committed, so recovery completes the rename.
                fs.mkdirSync(dirname(row.final_path), { recursive: true });
                fs.renameSync(row.stage_path, row.final_path);
                stmt(db, "DELETE FROM migration_pending WHERE migration_key = ?").run(
                    row.migration_key,
                );
                report.rolledForward += 1;
            } else {
                // Committed state has no recoverable session bytes.
                report.lost.push(row);
            }
            continue;
        }
        // Rollback deletes the journal row even when the stage file is missing.
        try {
            fs.unlinkSync(row.stage_path);
        } catch {
            // A failed stage-file deletion does not block rollback.
        }
        stmt(db, "DELETE FROM migration_pending WHERE migration_key = ?").run(row.migration_key);
        report.rolledBack += 1;
    }
    return report;
}

const JOURNAL_SELECT_SQL = `SELECT migration_key, source_session_id, target_harness, pi_session_id,
               final_path, stage_path, content_sha256, phase, created_at
          FROM migration_pending WHERE migration_key = ?`;

function readPendingMigration(
    db: DatabaseLike,
    migrationKey: string,
): MigrationPendingRow | undefined {
    return stmt<MigrationPendingRow>(db, JOURNAL_SELECT_SQL).get(migrationKey);
}

/**
 *
 *
 */
function claimJournalIdentity(args: {
    db: DatabaseLike;
    migrationKey: string;
    sourceSessionId: string;
    targetHarness: string;
    finalPathFor: (piSessionId: string) => string;
    stageDir: string;
    now: number;
}): { row: MigrationPendingRow; resumed: boolean } {
    const existing = readPendingMigration(args.db, args.migrationKey);
    if (existing) {
        return { row: existing, resumed: true };
    }

    const piSessionId = generateUuidV7(new Date(args.now));
    stmt(
        args.db,
        `INSERT INTO migration_pending (
             migration_key, source_session_id, target_harness, pi_session_id,
             final_path, stage_path, content_sha256, phase, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, '', 'staged', ?)
         ON CONFLICT(migration_key) DO NOTHING`,
    ).run(
        args.migrationKey,
        args.sourceSessionId,
        args.targetHarness,
        piSessionId,
        args.finalPathFor(piSessionId),
        join(args.stageDir, `${args.migrationKey}.jsonl`),
        args.now,
    );
    const row = readPendingMigration(args.db, args.migrationKey);
    if (!row) {
        throw new Error("migration journal row disappeared during insert; aborting migration");
    }
    return { row, resumed: row.pi_session_id !== piSessionId };
}

/**
 * Resumed rows update `content_sha256` without changing `phase`.
 * A `db_committed` row must not regress to `staged`.
 * A `db_committed` row must not regress to `staged`, because sweep rollback trusts `staged` to mean no shared state was committed.
 */
function commitStagedChecksum(db: DatabaseLike, migrationKey: string, contentSha256: string): void {
    stmt(db, "UPDATE migration_pending SET content_sha256 = ? WHERE migration_key = ?").run(
        contentSha256,
        migrationKey,
    );
}

function parseJsonObject<T>(text: string): T {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected JSON object");
    }
    return parsed as T;
}

function isoFromMs(ms: number | undefined, fallback: Date): string {
    return new Date(
        typeof ms === "number" && Number.isFinite(ms) ? ms : fallback.getTime(),
    ).toISOString();
}

function textFromUnknown(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
}

function roleFromMessage(row: OpenCodeMessageRow): "user" | "assistant" | undefined {
    const data = parseJsonObject<OpenCodeMessageData>(row.data);
    return data.role === "user" || data.role === "assistant" ? data.role : undefined;
}

function tokensFromMessage(row: OpenCodeMessageRow): OpenCodeMessageTokens {
    try {
        const data = parseJsonObject<OpenCodeMessageData>(row.data);
        return data.tokens ?? {};
    } catch {
        return {};
    }
}

function extractModel(rows: OpenCodeMessageRow[]): {
    provider: string;
    modelId: string;
} {
    for (const row of rows) {
        try {
            const data = parseJsonObject<OpenCodeMessageData>(row.data);
            const provider = data.providerID ?? data.model?.providerID;
            const modelId = data.modelID ?? data.model?.modelID;
            if (provider && modelId) return { provider, modelId };
        } catch {
        }
    }
    return { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL };
}

function normalizeOpenCodeTool(part: OpenCodePartData): {
    callId: string;
    name: string;
    input: unknown;
    output: unknown;
} {
    const callId =
        part.callID ??
        part.call_id ??
        part.toolCallId ??
        part.tool_call_id ??
        `migrated_${shortId()}`;
    const name = part.tool ?? part.tool_name ?? part.name ?? part.state?.title ?? "unknown_tool";
    const input = part.input ?? part.state?.input ?? {};
    const output = part.output ?? part.state?.output ?? part.state?.metadata?.output ?? "";
    return { callId, name, input, output };
}

/**
 *
 * OpenCode exposes usage as `{ total, input, output, reasoning, cache: { read, write } }`.
 * Pi exposes usage as `{ input, output, cacheRead, cacheWrite, totalTokens, cost: {...} }`.
 *
 * Pi's interactive footer reads `entry.message.usage.input` for every assistant render.
 * Without source token counts, `getContextUsage()` reports 0% because Pi sums per-turn input fields.
 * The importer preserves source token counts so scheduler and historian thresholds apply when the session loads.
 *
 * OpenCode message data provides no pricing, so all cost fields are zero.
 */
function tokensToPiUsage(tokens: OpenCodeMessageTokens | undefined): Record<string, unknown> {
    const input = tokens?.input ?? 0;
    const output = tokens?.output ?? 0;
    const cacheRead = tokens?.cache?.read ?? 0;
    const cacheWrite = tokens?.cache?.write ?? 0;
    const total = tokens?.total ?? input + output + cacheRead + cacheWrite;
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: total,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function makeMessageEntry(
    role: "user" | "assistant",
    text: string,
    timestamp: string,
    parentId: string | null,
    usage: Record<string, unknown>,
): PiJson {
    const message: Record<string, unknown> = {
        role,
        content: [{ type: "text", text }],
        timestamp: Date.parse(timestamp),
    };
    if (role === "assistant") {
        message.usage = usage;
    }
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message,
    };
}

function makeThinkingEntry(
    text: string,
    timestamp: string,
    parentId: string | null,
    usage: Record<string, unknown>,
): PiJson {
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: text, thinkingSignature: null }],
            timestamp: Date.parse(timestamp),
            usage,
        },
    };
}

function makeToolCallEntry(
    tool: { callId: string; name: string; input: unknown },
    timestamp: string,
    parentId: string | null,
    usage: Record<string, unknown>,
): PiJson {
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message: {
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: tool.callId,
                    name: tool.name,
                    arguments: tool.input ?? {},
                },
            ],
            timestamp: Date.parse(timestamp),
            usage,
        },
    };
}

function makeToolResultEntry(
    tool: { callId: string; name: string; output: unknown },
    timestamp: string,
    parentId: string | null,
): PiJson {
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message: {
            role: "toolResult",
            toolCallId: tool.callId,
            toolName: tool.name,
            content: [{ type: "text", text: textFromUnknown(tool.output) }],
            isError: false,
            timestamp: Date.parse(timestamp),
        },
    };
}

interface ConvertPartContext {
    role: "user" | "assistant";
    row: OpenCodePartRow;
    timestamp: string;
    parentId: string | null;
    usage: Record<string, unknown>;
}

function convertPartToEntries(ctx: ConvertPartContext): PiJson[] {
    const part = parseJsonObject<OpenCodePartData>(ctx.row.data);
    switch (part.type) {
        case "step-start":
        case "step-finish":
        case "patch":
            return [];
        case "text":
            return part.text
                ? [makeMessageEntry(ctx.role, part.text, ctx.timestamp, ctx.parentId, ctx.usage)]
                : [];
        case "reasoning":
            return part.text
                ? [makeThinkingEntry(part.text, ctx.timestamp, ctx.parentId, ctx.usage)]
                : [];
        case "tool": {
            const tool = normalizeOpenCodeTool(part);
            const call = makeToolCallEntry(tool, ctx.timestamp, ctx.parentId, ctx.usage);
            const result = makeToolResultEntry(tool, ctx.timestamp, call.id as string);
            return [call, result];
        }
        case "file": {
            const name = part.filename ?? part.name ?? "attachment";
            return [
                makeMessageEntry(
                    ctx.role,
                    `<file omitted: ${name}>`,
                    ctx.timestamp,
                    ctx.parentId,
                    ctx.usage,
                ),
            ];
        }
        default:
            return [];
    }
}

interface BuildEntriesResult {
    entries: PiJson[];
    piSessionId: string;
    /**
     * START boundaries use the first derived Pi entry so they include every entry derived from the source message.
     */
    messageIdToFirstPiEntryId: Map<string, string>;
    /**
     * END boundaries use the last derived Pi entry so they include every entry derived from the source message.
     * `messageIdToLastPiEntryId` lets END boundaries include every Pi entry derived from each source message.
     */
    messageIdToLastPiEntryId: Map<string, string>;
    /**
     * `orderedSourceMessageIds` orders source-message IDs chronologically for nearest-at-or-before remapping.
     * `orderedSourceMessageIds` lets a START boundary without an exact source ID remap to the nearest preceding source message.
     */
    orderedSourceMessageIds: string[];
}

function buildPiEntries(params: {
    session: OpenCodeSessionRow;
    messages: OpenCodeMessageRow[];
    parts: OpenCodePartRow[];
    now: Date;
    provider: string;
    modelId: string;
    /**
     * The caller mints `piSessionId` or reuses the migration journal's persisted value so retries retain the same Pi session identity.
     */
    piSessionId: string;
}): BuildEntriesResult {
    const sessionUuid = params.piSessionId;
    const nowIso = params.now.toISOString();
    const entries: PiJson[] = [
        {
            type: "session",
            version: 3,
            id: sessionUuid,
            timestamp: nowIso,
            cwd: params.session.directory ?? params.session.path ?? process.cwd(),
        },
        {
            type: "model_change",
            id: shortId(),
            parentId: null,
            timestamp: nowIso,
            provider: params.provider,
            modelId: params.modelId,
        },
    ];

    // `boundary` uses zero token and cost values because it is synthetic and no LLM produced it.
    const boundary = makeMessageEntry(
        "user",
        `<!-- migrated from OpenCode session ${params.session.id} at ${nowIso} -->\n\nThe following conversation was migrated from a different harness. Reasoning context from prior turns may be incomplete; tool calls reference tools that may not exist in this environment.`,
        nowIso,
        null,
        {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    );
    entries.push(boundary);

    const partsByMessage = new Map<string, OpenCodePartRow[]>();
    for (const part of params.parts) {
        const list = partsByMessage.get(part.message_id) ?? [];
        list.push(part);
        partsByMessage.set(part.message_id, list);
    }

    const messageIdToFirstPiEntryId = new Map<string, string>();
    const messageIdToLastPiEntryId = new Map<string, string>();
    const orderedSourceMessageIds: string[] = [];

    let parentId = boundary.id as string;
    for (const message of params.messages) {
        const role = roleFromMessage(message);
        if (!role) continue;
        const timestamp = isoFromMs(message.time_created, params.now);
        const tokens = tokensFromMessage(message);
        const usage = tokensToPiUsage(tokens);

        let firstEntryIdForMessage: string | null = null;
        let lastEntryIdForMessage: string | null = null;
        for (const part of partsByMessage.get(message.id) ?? []) {
            const newEntries = convertPartToEntries({
                role,
                row: part,
                timestamp,
                parentId,
                usage,
            });
            for (const entry of newEntries) {
                if (entry.parentId === undefined || entry.parentId === parentId)
                    entry.parentId = parentId;
                entries.push(entry);
                parentId = entry.id as string;
                if (firstEntryIdForMessage === null) firstEntryIdForMessage = parentId;
                lastEntryIdForMessage = parentId;
            }
        }
        if (lastEntryIdForMessage !== null && firstEntryIdForMessage !== null) {
            messageIdToFirstPiEntryId.set(message.id, firstEntryIdForMessage);
            messageIdToLastPiEntryId.set(message.id, lastEntryIdForMessage);
            orderedSourceMessageIds.push(message.id);
        }
    }

    return {
        entries,
        piSessionId: sessionUuid,
        messageIdToFirstPiEntryId,
        messageIdToLastPiEntryId,
        orderedSourceMessageIds,
    };
}

function fetchRows(db: DatabaseLike, sessionId: string, maxMessages: number | undefined) {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN DEFERRED");
    try {
        const session = stmt<OpenCodeSessionRow>(
            db,
            "SELECT id, title, directory, path, time_created FROM session WHERE id = ?",
        ).get(sessionId);
        if (!session) throw new Error(`OpenCode session not found: ${sessionId}`);

        const sourceMessageCount =
            stmt<{ count: number }>(
                db,
                "SELECT COUNT(*) AS count FROM message WHERE session_id = ?",
            ).get(sessionId)?.count ?? 0;

        const limitClause = maxMessages ? "LIMIT ?" : "";
        const params = maxMessages ? [sessionId, maxMessages] : [sessionId];
        const newestFirst = stmt<OpenCodeMessageRow>(
            db,
            `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC ${limitClause}`,
        ).all(...params);
        const messages = newestFirst.reverse();
        const ids = messages.map((row) => row.id);
        const parts: OpenCodePartRow[] = [];
        // The deferred transaction performs all lookups and limits each `IN` list to fewer than 999 variables to support SQLite configurations with a 999-variable limit.
        for (let offset = 0; offset < ids.length; offset += PART_LOOKUP_CHUNK_SIZE) {
            const chunk = ids.slice(offset, offset + PART_LOOKUP_CHUNK_SIZE);
            parts.push(
                ...stmt<OpenCodePartRow>(
                    db,
                    `SELECT id, message_id, time_created, data FROM part WHERE message_id IN (${chunk.map(() => "?").join(",")})`,
                ).all(...chunk),
            );
        }
        parts.sort((left, right) => {
            if (left.time_created !== right.time_created) {
                return left.time_created - right.time_created;
            }
            return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        });

        db.exec("COMMIT");
        return { session, sourceMessageCount, messages, parts };
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // A closed transaction causes the deferred read to fail.
        }
        throw error;
    }
}

/**
 *
 * At-or-before uses lexicographic comparison of message IDs.
 *      `orderedSourceMessageIds`.
 *
 * `exact` distinguishes direct mappings from at-or-before fallbacks.
 */
function remapBoundaryId(
    openCodeMessageId: string,
    edge: "start" | "end",
    messageIdToFirstPiEntryId: Map<string, string>,
    messageIdToLastPiEntryId: Map<string, string>,
    orderedSourceMessageIds: readonly string[],
): { piEntryId: string; exact: boolean } | undefined {
    const directMap = edge === "start" ? messageIdToFirstPiEntryId : messageIdToLastPiEntryId;
    const direct = directMap.get(openCodeMessageId);
    if (direct !== undefined) return { piEntryId: direct, exact: true };

    let nearestAtOrBefore: string | undefined;
    for (const id of orderedSourceMessageIds) {
        if (id <= openCodeMessageId) {
            nearestAtOrBefore = id;
        } else {
            break;
        }
    }
    if (nearestAtOrBefore === undefined) return undefined;
    const piEntryId = messageIdToLastPiEntryId.get(nearestAtOrBefore);
    if (piEntryId === undefined) return undefined;
    return { piEntryId, exact: false };
}

interface CopyMagicContextStateResult {
    compartmentsCopied: number;
    factsCopied: number;
    boundariesApproximated: number;
    lastCompartmentEndPiEntryId?: string;
}

interface RemappedCompartment {
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    title: string;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number | null;
    episode_type: string | null;
    legacy: number;
}

/**
 * `commit()` writes state in one transaction only after the Pi JSONL file persists, preventing database rows without a session file after interruption.
 * file.
 *
 * Pass the journal's `migration_key` to `commit()` so it advances that row to `db_committed` in the state-write transaction.
 */
interface CopyMagicContextStatePlan extends CopyMagicContextStateResult {
    /**
     * `remappedCompartments` requires `start_message` and `end_message` ordinals derived after compaction-marker insertion.
     */
    remappedCompartments: RemappedCompartment[];
    commit: (journalKey?: string) => void;
}

interface CompactionMarkerResult {
    written: boolean;
    boundaryEntryId?: string;
    firstKeptEntryId?: string;
}

function insertCompactionMarker(
    entries: PiJson[],
    boundaryEntryId: string | undefined,
): CompactionMarkerResult {
    if (boundaryEntryId === undefined) return { written: false };

    const boundaryIndex = entries.findIndex((entry) => entry.id === boundaryEntryId);
    if (boundaryIndex < 0) return { written: false };

    const firstKept = entries[boundaryIndex + 1];
    if (!firstKept?.id) return { written: false };

    const compactedPrefixChars = entries
        .slice(0, boundaryIndex + 1)
        .reduce((total, entry) => total + JSON.stringify(entry.message ?? "").length, 0);
    const compactionId = shortId();
    const marker: PiJson = {
        type: "compaction",
        id: compactionId,
        parentId: boundaryEntryId,
        timestamp: String(entries[boundaryIndex].timestamp),
        summary: MIGRATION_COMPACTION_SUMMARY,
        firstKeptEntryId: firstKept.id,
        tokensBefore: Math.ceil(compactedPrefixChars / 4),
        fromHook: true,
    };

    firstKept.parentId = compactionId;
    entries.splice(boundaryIndex + 1, 0, marker);
    return {
        written: true,
        boundaryEntryId,
        firstKeptEntryId: firstKept.id as string,
    };
}

/**
 *
 * Magic Context initializes the shared cortexkit DB on first plugin load.
 * The schema migration system owns table creation.
 * lifecycle.
 *
 * Dry runs compute the remap and result counts without writing to the DB.
 */
function copyMagicContextState(args: {
    cortexkitDb: DatabaseLike;
    sourceSessionId: string;
    piSessionId: string;
    messageIdToFirstPiEntryId: Map<string, string>;
    messageIdToLastPiEntryId: Map<string, string>;
    orderedSourceMessageIds: readonly string[];
    now: number;
    dryRun: boolean;
}): CopyMagicContextStatePlan {
    const sourceCompartments = stmt<CortexkitCompartmentRow>(
        args.cortexkitDb,
        `SELECT sequence, start_message, end_message, start_message_id, end_message_id,
              title, content, created_at,
              p1, p2, p3, p4, importance, episode_type, legacy
         FROM compartments
        WHERE session_id = ? AND harness = 'opencode'
     ORDER BY sequence ASC`,
    ).all(args.sourceSessionId);

    const sourceFacts = stmt<CortexkitSessionFactRow>(
        args.cortexkitDb,
        `SELECT category, content, created_at, updated_at
         FROM session_facts
        WHERE session_id = ? AND harness = 'opencode'
     ORDER BY category ASC, id ASC`,
    ).all(args.sourceSessionId);

    let boundariesApproximated = 0;
    const remappedCompartments: RemappedCompartment[] = [];

    for (const c of sourceCompartments) {
        const startRemap = remapBoundaryId(
            c.start_message_id,
            "start",
            args.messageIdToFirstPiEntryId,
            args.messageIdToLastPiEntryId,
            args.orderedSourceMessageIds,
        );
        const endRemap = remapBoundaryId(
            c.end_message_id,
            "end",
            args.messageIdToFirstPiEntryId,
            args.messageIdToLastPiEntryId,
            args.orderedSourceMessageIds,
        );
        if (!startRemap || !endRemap) continue;
        if (!startRemap.exact || !endRemap.exact) boundariesApproximated++;
        remappedCompartments.push({
            sequence: c.sequence,
            start_message: c.start_message,
            end_message: c.end_message,
            start_message_id: startRemap.piEntryId,
            end_message_id: endRemap.piEntryId,
            title: c.title,
            content: c.content,
            p1: c.p1,
            p2: c.p2,
            p3: c.p3,
            p4: c.p4,
            importance: c.importance,
            episode_type: c.episode_type,
            legacy: c.legacy,
        });
    }

    const result: CopyMagicContextStateResult = {
        compartmentsCopied: remappedCompartments.length,
        factsCopied: sourceFacts.length,
        boundariesApproximated,
        lastCompartmentEndPiEntryId: remappedCompartments.at(-1)?.end_message_id,
    };

    if (args.dryRun) {
        return { ...result, remappedCompartments, commit: () => {} };
    }

    // The caller commits all writes in one transaction.
    // Both tables default harness to 'opencode', so migrated rows must set harness='pi'.
    const commit = (journalKey?: string) => {
        const insertCompartment = stmt(
            args.cortexkitDb,
            `INSERT INTO compartments (
       session_id, sequence, start_message, end_message,
       start_message_id, end_message_id, title, content,
       p1, p2, p3, p4, importance, episode_type, legacy,
       created_at, harness
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pi')`,
        );
        const insertFact = stmt(
            args.cortexkitDb,
            `INSERT INTO session_facts (
       session_id, category, content, created_at, updated_at, harness
     ) VALUES (?, ?, ?, ?, ?, 'pi')`,
        );
        args.cortexkitDb.exec("BEGIN IMMEDIATE");
        try {
            // A resumed attempt reuses the journal's pi_session_id.
            // A crash after the transaction commits can leave rows for the journal's Pi session.
            // The transaction replaces prior rows for the Pi session to keep resumed replays idempotent.
            // Replacing prior rows prevents duplicate facts and compartments(session_id, sequence) collisions on resumed replays.
            stmt(
                args.cortexkitDb,
                "DELETE FROM compartments WHERE session_id = ? AND harness = 'pi'",
            ).run(args.piSessionId);
            stmt(
                args.cortexkitDb,
                "DELETE FROM session_facts WHERE session_id = ? AND harness = 'pi'",
            ).run(args.piSessionId);
            for (const c of remappedCompartments) {
                insertCompartment.run(
                    args.piSessionId,
                    c.sequence,
                    c.start_message,
                    c.end_message,
                    c.start_message_id,
                    c.end_message_id,
                    c.title,
                    c.content,
                    c.p1,
                    c.p2,
                    c.p3,
                    c.p4,
                    // v2 metadata preserves renderer tiers and decay for migrated history.
                    // Without v2 metadata, migrated rows use legacy=0 with NULL tiers.
                    // NULL tiers make the renderer use full content for every tier, disabling decay and increasing prompt size.
                    typeof c.importance === "number" ? c.importance : 50,
                    c.episode_type,
                    c.legacy,
                    args.now,
                );
            }
            for (const f of sourceFacts) {
                insertFact.run(args.piSessionId, f.category, f.content, f.created_at, f.updated_at);
            }
            if (journalKey !== undefined) {
                // The transaction advances the journal phase so the sweep can treat db_committed as shared-state committed.
                // The sweep treats `db_committed` as shared-state committed only when the transaction atomically commits the journal phase and shared state.
                // The transaction commits the journal phase and shared state atomically.
                stmt(
                    args.cortexkitDb,
                    "UPDATE migration_pending SET phase = 'db_committed' WHERE migration_key = ?",
                ).run(journalKey);
            }
            args.cortexkitDb.exec("COMMIT");
        } catch (error) {
            args.cortexkitDb.exec("ROLLBACK");
            throw error;
        }
    };

    return { ...result, remappedCompartments, commit };
}

/**
 * derivePiRuntimeOrdinals reproduces the Pi runtime reader's ordinal basis.
 *
 * convertEntriesToRawMessages determines the runtime RawMessage ordinal from JSONL entry order.
 * Non-`message` entries have no runtime ordinal.
 *   - each user or assistant message entry gets its own ordinal;
 * `toolResult` entries share the next user's ordinal, or consume a synthetic user's ordinal before the next assistant entry or at the end.
 *   - unknown roles get their own ordinal without folding pending results.
 *
 */
function derivePiRuntimeOrdinals(entries: readonly PiJson[]): Map<string, number> {
    const ordinalByEntryId = new Map<string, number>();
    let nextOrdinal = 1;
    const pendingToolResultIds: string[] = [];

    const foldPendingInto = (ordinal: number): void => {
        for (const id of pendingToolResultIds) ordinalByEntryId.set(id, ordinal);
        pendingToolResultIds.length = 0;
    };

    for (const entry of entries) {
        const message = entry.message;
        if (
            entry.type !== "message" ||
            typeof entry.id !== "string" ||
            message === null ||
            typeof message !== "object"
        ) {
            // Structural entries never reach the runtime reader's ordinals.
            continue;
        }
        const role = (message as { role?: unknown }).role;

        if (role === "toolResult") {
            pendingToolResultIds.push(entry.id);
            continue;
        }

        if (role === "assistant" && pendingToolResultIds.length > 0) {
            // Before an assistant entry following pending results, the reader emits a synthetic user turn that consumes an ordinal.
            foldPendingInto(nextOrdinal);
            nextOrdinal += 1;
        }

        const ordinal = nextOrdinal;
        nextOrdinal += 1;
        if (role === "user" && pendingToolResultIds.length > 0) {
            // Pending results fold into this user turn and share its ordinal.
            foldPendingInto(ordinal);
        }
        ordinalByEntryId.set(entry.id, ordinal);
    }

    if (pendingToolResultIds.length > 0) {
        // Trailing results fold into a final synthetic user turn.
        foldPendingInto(nextOrdinal);
    }
    return ordinalByEntryId;
}

/**
 * applyRuntimeOrdinals must receive entries whose order matches the Pi runtime reader.
 * the stored ordinals are in the exact basis the Pi runtime reader produces.
 * Each compartment boundary entry ID must have a runtime ordinal.
 * written).
 *
 */
function applyRuntimeOrdinals(
    remappedCompartments: RemappedCompartment[],
    entries: readonly PiJson[],
): void {
    const ordinals = derivePiRuntimeOrdinals(entries);
    for (const compartment of remappedCompartments) {
        const startOrdinal = ordinals.get(compartment.start_message_id);
        const endOrdinal = ordinals.get(compartment.end_message_id);
        if (startOrdinal === undefined || endOrdinal === undefined) {
            const missing =
                startOrdinal === undefined
                    ? compartment.start_message_id
                    : compartment.end_message_id;
            throw new Error(
                `Migration boundary entry ${missing} has no runtime ordinal; migrator invariant violated`,
            );
        }
        compartment.start_message = startOrdinal;
        compartment.end_message = endOrdinal;
    }
}

function ensureValidOptions(
    opts: MigrateCliOptions,
): asserts opts is Required<Pick<MigrateCliOptions, "from" | "to" | "session">> &
    MigrateCliOptions {
    if (!opts.from) throw new Error("Missing required flag: --from <opencode>");
    if (!opts.to) throw new Error("Missing required flag: --to <pi|omp>");
    if (opts.from !== "opencode" || (opts.to !== "pi" && opts.to !== "omp")) {
        if ((opts.from === "pi" || opts.from === "omp") && opts.to === "opencode") {
            throw new Error(
                `Migration ${opts.from} → opencode is not yet supported (supported: opencode → pi|omp)`,
            );
        }
        throw new Error(
            `Unsupported migration: ${opts.from} → ${opts.to} (supported: opencode → pi|omp)`,
        );
    }
    if (!opts.session) throw new Error("Missing required flag: --session <id>");
    if (
        opts.maxMessages !== undefined &&
        (!Number.isInteger(opts.maxMessages) || opts.maxMessages <= 0)
    ) {
        throw new Error("--max-messages must be a positive integer");
    }
}

export function migrateOpenCodeSessionToPi(
    opts: MigrateOpenCodeSessionToPiOptions,
): MigrationResult {
    const fs = opts.fs ?? defaultFs();
    const now = opts.now ?? new Date();
    const opencodeDbPath = opts.opencodeDbPath ?? defaultOpenCodeDbPath();
    const piSessionsRoot = opts.piSessionsRoot ?? defaultPiSessionsRoot();
    const ownsDb = !opts.db;
    const db = opts.db ?? openExistingDatabase(opencodeDbPath, { readonly: true });
    if (db === null) {
        throw new Error(`OpenCode database not found at ${opencodeDbPath}; nothing to migrate.`);
    }

    let cortexkitDb: DatabaseLike | null;
    let ownsCortexkitDb = false;
    let cortexkitSchemaVersionBefore: number | null = null;
    if (opts.cortexkitDb === null) {
        cortexkitDb = null;
    } else if (opts.cortexkitDb !== undefined) {
        cortexkitDb = opts.cortexkitDb;
    } else {
        const cortexkitDbPath = opts.cortexkitDbPath ?? defaultCortexkitDbPath();
        cortexkitDb = opts.dryRun
            ? openExistingContextDatabase(cortexkitDbPath, { readonly: true })
            : openExistingContextDatabaseForMutation(cortexkitDbPath);
        ownsCortexkitDb = cortexkitDb !== null;
        if (cortexkitDb !== null)
            cortexkitSchemaVersionBefore = getPersistedSchemaVersion(cortexkitDb as DatabaseType);
        // If Magic Context has never created context.db, skip the state copy;
        // opening a missing path must not fabricate an empty database.
    }

    try {
        const { session, sourceMessageCount, messages, parts } = fetchRows(
            db,
            opts.sessionId,
            opts.maxMessages,
        );
        const model = extractModel(messages);
        const provider = opts.provider ?? model.provider;
        const modelId = opts.modelId ?? model.modelId;
        const cwd = session.directory ?? session.path ?? process.cwd();
        const outputDir = join(piSessionsRoot, projectPathToPiDirSlug(cwd));
        const targetHarness = opts.targetHarness ?? "pi";

        // Journal-backed runs reconcile interrupted attempts before claiming this migration's identity.
        // Journal-backed runs reconcile interrupted attempts before claiming this migration's identity.
        // The sweep reconciles each phase without time thresholds.
        const journalActive = cortexkitDb !== null && !opts.dryRun;
        let recovery: MigrationSweepReport | undefined;
        let migrationKey: string | undefined;
        let journalResumed = false;
        let piSessionId: string;
        let finalPath: string;
        let stagePath: string;
        if (journalActive && cortexkitDb !== null) {
            if (!hasMigrationJournal(cortexkitDb)) {
                throw new Error(
                    "context.db has no migration_pending journal (shared schema older than v78). Run a harness session once so the plugin can upgrade the schema, then retry doctor migrate.",
                );
            }
            recovery = sweepPendingMigrations(cortexkitDb, fs);
            migrationKey = migrationKeyFor(session.id, targetHarness);
            const claimed = claimJournalIdentity({
                db: cortexkitDb,
                migrationKey,
                sourceSessionId: session.id,
                targetHarness,
                finalPathFor: (id) =>
                    join(outputDir, `${formatPiFilenameTimestamp(now)}_${id}.jsonl`),
                // The migration stores staged files beside the sessions root so harness scans ignore them and stage-to-final renames stay atomic.
                stageDir: join(dirname(piSessionsRoot), MIGRATION_STAGE_DIRNAME),
                now: now.getTime(),
            });
            piSessionId = claimed.row.pi_session_id;
            finalPath = claimed.row.final_path;
            stagePath = claimed.row.stage_path;
            journalResumed = claimed.resumed;
        } else {
            piSessionId = generateUuidV7(now);
            finalPath = join(outputDir, `${formatPiFilenameTimestamp(now)}_${piSessionId}.jsonl`);
            stagePath = "";
        }

        const buildResult = buildPiEntries({
            session,
            messages,
            parts,
            now,
            provider,
            modelId,
            piSessionId,
        });
        let copyResult: CopyMagicContextStateResult = {
            compartmentsCopied: 0,
            factsCopied: 0,
            boundariesApproximated: 0,
        };
        let plan: CopyMagicContextStatePlan | null = null;
        if (cortexkitDb !== null) {
            plan = copyMagicContextState({
                cortexkitDb,
                sourceSessionId: session.id,
                piSessionId,
                messageIdToFirstPiEntryId: buildResult.messageIdToFirstPiEntryId,
                messageIdToLastPiEntryId: buildResult.messageIdToLastPiEntryId,
                orderedSourceMessageIds: buildResult.orderedSourceMessageIds,
                now: now.getTime(),
                dryRun: Boolean(opts.dryRun),
            });
            copyResult = plan;
        }

        const compactionMarker = insertCompactionMarker(
            buildResult.entries,
            copyResult.lastCompartmentEndPiEntryId,
        );

        // applyRuntimeOrdinals uses entries after insertCompactionMarker so DB ordinals match Pi runtime positions.
        // The compaction marker changes entry positions before applyRuntimeOrdinals runs.
        // The DB stores ordinals in the Pi runtime reader's basis.
        // will consume.
        if (plan) applyRuntimeOrdinals(plan.remappedCompartments, buildResult.entries);

        const jsonl = `${buildResult.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

        if (!opts.dryRun) {
            if (journalActive && cortexkitDb !== null && migrationKey !== undefined && plan) {
                const contentSha256 = createHash("sha256").update(jsonl, "utf8").digest("hex");
                // commitStagedChecksum records the staged JSONL checksum while the journal phase is staged.
                commitStagedChecksum(cortexkitDb, migrationKey, contentSha256);
                // The staged JSONL remains outside the sessions root until finalization.
                fs.writeFileAtomic(stagePath, jsonl);
                // plan.commit advances the journal phase to db_committed in the shared-state transaction.
                // stagePath and finalPath share a filesystem, so renameSync is atomic.
                // If staging succeeds but finalization fails, the sweep reconciles the remaining journal row by phase.
                // The sweep rolls back a staged row because shared state is absent.
                // The sweep rolls forward a db_committed row.
                // Crashes and retries use the same reconciliation path.
                plan.commit(migrationKey);
                fs.mkdirSync(dirname(finalPath), { recursive: true });
                fs.renameSync(stagePath, finalPath);
                stmt(cortexkitDb, "DELETE FROM migration_pending WHERE migration_key = ?").run(
                    migrationKey,
                );
            } else {
                // Without a cortexkit DB, the migration writes JSONL directly without a journal.
                fs.writeFileAtomic(finalPath, jsonl);
            }
        }

        return {
            outputPath: finalPath,
            piSessionId,
            // Pi JSONL files begin with session and model_change entries, so messageCount excludes them.
            // messageCount includes boundary markers and migrated message entries.
            // messageCount includes a trailing compaction marker when present.
            messageCount: buildResult.entries.length - 2,
            byteCount: Buffer.byteLength(jsonl, "utf8"),
            sourceMessageCount,
            compartmentsCopied: copyResult.compartmentsCopied,
            factsCopied: copyResult.factsCopied,
            boundariesApproximated: copyResult.boundariesApproximated,
            compactionMarkerWritten: compactionMarker.written,
            compactionBoundaryEntryId: compactionMarker.boundaryEntryId,
            compactionFirstKeptEntryId: compactionMarker.firstKeptEntryId,
            ...(migrationKey !== undefined ? { migrationKey } : {}),
            ...(journalActive ? { journalResumed } : {}),
            ...(recovery !== undefined ? { recovery } : {}),
            ...(cortexkitSchemaVersionBefore !== null && cortexkitDb !== null
                ? {
                      cortexkitSchemaVersionBefore,
                      cortexkitSchemaVersionAfter: getPersistedSchemaVersion(
                          cortexkitDb as DatabaseType,
                      ),
                  }
                : {}),
            dryRun: Boolean(opts.dryRun),
        };
    } finally {
        if (ownsDb) db.close();
        if (ownsCortexkitDb && cortexkitDb !== null) cortexkitDb.close();
    }
}

export function parseMigrateArgs(args: string[]): MigrateCliOptions {
    const opts: MigrateCliOptions = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const readValue = (flag: string): string => {
            const value = args[++i];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
            return value;
        };
        if (arg === "--from") opts.from = readValue(arg);
        else if (arg === "--to") opts.to = readValue(arg);
        else if (arg === "--session") opts.session = readValue(arg);
        else if (arg === "--max-messages") opts.maxMessages = Number(readValue(arg));
        else if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--help" || arg === "-h") throw new Error("HELP");
        else throw new Error(`Unknown migrate flag: ${arg}`);
    }
    return opts;
}

export function printMigrateHelp(): void {
    console.log(`
  Magic Context doctor migrate
  ─────────────────────────────

  Copy OpenCode session message content into a new Pi-compatible JSONL session,
  PLUS the source session's Magic Context state (compartments + facts)
  into the shared cortexkit database under the new session id.

  Supported pairs:
    --from opencode --to pi
    --from opencode --to omp

  Usage:
    npx @cortexkit/magic-context@latest doctor migrate \\
      --from opencode --to <pi|omp> --session ses_xxx [--max-messages N] [--dry-run]

  Fidelity:
    - text, reasoning text, tool calls, and tool results are preserved
    - assistant 'usage' fields carry real input/output/cache token counts
      from the source so Pi's getContextUsage() reports realistic numbers
    - reasoning signatures are stripped; step-start/step-finish are skipped
    - file bytes are replaced with <file omitted: name> markers
    - compartments + session_facts are copied to the new Pi session_id;
      compartment boundary message IDs are remapped to the corresponding
      Pi entry IDs (nearest-at-or-before for boundaries that don't have
      a direct message-level Pi entry), and compartment start/end ordinals
      are recomputed in the ordinal basis the Pi runtime reader produces

  Crash safety:
    - each migration is tracked in the shared DB's migration_pending journal
      and staged outside the sessions tree; an interrupted run is reconciled
      by phase on the next 'doctor migrate' or plain 'doctor' run, reusing the
      original Pi session id instead of minting a second one
`);
}

/* */
export function formatMigrationSweepLines(report: MigrationSweepReport): string[] {
    const lines: string[] = [];
    if (report.rolledForward > 0) {
        lines.push(
            `Recovered ${report.rolledForward} interrupted session migration(s) by completing the staged file rename.`,
        );
    }
    if (report.rolledBack > 0) {
        lines.push(
            `Rolled back ${report.rolledBack} incomplete session migration(s) that never committed shared state.`,
        );
    }
    if (report.completed > 0) {
        lines.push(`Cleared ${report.completed} finished session-migration journal row(s).`);
    }
    for (const row of report.lost) {
        lines.push(
            `LOST session migration content: source ${row.source_session_id} → ${row.target_harness} session ${row.pi_session_id}; expected file ${row.final_path} (sha256 ${row.content_sha256}). Re-run doctor migrate for this session to rebuild it.`,
        );
    }
    return lines;
}

export async function runMigrateCli(args: string[]): Promise<number> {
    try {
        const parsed = parseMigrateArgs(args);
        ensureValidOptions(parsed);
        const target = parsed.to === "omp" ? "OMP" : "Pi";
        const result = migrateOpenCodeSessionToPi({
            sessionId: parsed.session,
            maxMessages: parsed.maxMessages,
            dryRun: parsed.dryRun,
            piSessionsRoot: parsed.to === "omp" ? getOmpSessionsRoot() : undefined,
            targetHarness: parsed.to === "omp" ? "omp" : "pi",
        });
        if (result.recovery) {
            for (const line of formatMigrationSweepLines(result.recovery)) {
                console.log(line);
            }
        }
        const action = result.dryRun ? "Would write" : "Wrote";
        console.log(`${action} ${target} session JSONL:`);
        console.log(`  path: ${result.outputPath}`);
        console.log(`  pi-compatible session id: ${result.piSessionId}`);
        console.log(`  source messages: ${result.sourceMessageCount}`);
        console.log(`  migrated entries: ${result.messageCount}`);
        console.log(`  bytes: ${result.byteCount}`);
        console.log(`  compartments copied: ${result.compartmentsCopied}`);
        console.log(`  session facts copied: ${result.factsCopied}`);
        if (result.cortexkitSchemaVersionBefore !== undefined) {
            console.log(
                `  Magic Context schema: v${result.cortexkitSchemaVersionBefore} → v${result.cortexkitSchemaVersionAfter}`,
            );
        }
        console.log(
            `  compaction marker: ${result.compactionMarkerWritten ? "yes" : "no"}${
                result.compactionMarkerWritten
                    ? ` (boundary: ${result.compactionBoundaryEntryId}, first kept: ${result.compactionFirstKeptEntryId})`
                    : ""
            }`,
        );
        if (result.boundariesApproximated > 0) {
            console.log(
                `  boundaries approximated: ${result.boundariesApproximated} (nearest-at-or-before)`,
            );
        }
        if (result.migrationKey !== undefined) {
            console.log(
                `  journal: ${result.migrationKey.slice(0, 12)}…${
                    result.journalResumed ? " (resumed interrupted attempt)" : ""
                }`,
            );
        }
        if (!result.dryRun) {
            console.log(`${target} may need to be restarted to pick up the new session file.`);
            if (result.cortexkitSchemaVersionBefore !== undefined) {
                console.log(
                    "If OpenCode or another harness is running, restart it before creating new sessions so it reloads the same schema fence.",
                );
            }
        }
        return 0;
    } catch (error) {
        if (error instanceof Error && error.message === "HELP") {
            printMigrateHelp();
            return 0;
        }
        console.error(error instanceof Error ? error.message : String(error));
        console.error("Run `doctor migrate --help` for usage.");
        return 1;
    }
}
