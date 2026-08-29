#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const DASHBOARD_FORMULA_SOURCE =
    "packages/dashboard/src-tauri/src/db.rs:1505-1523,1581-1592,1704-1763 @ 6a4efb07 (retired dashboard; resolve via git history)";
const ALTERNATIVE_FORMULA_SOURCE =
    "packages/dashboard/src/lib/cache-format.ts:105-120 @ 6a4efb07 (retired dashboard; resolve via git history)";
const LOW_CACHE_THRESHOLD = 90;
const DASHBOARD_WARNING_THRESHOLD = 95;
const DASHBOARD_BUST_THRESHOLD = 80;
const SESSION_SEPARATOR = "\u241f";

type Harness = "opencode" | "pi";

type Args = {
    harness: Harness;
    sessionId?: string;
    minPasses: number;
    json: boolean;
};

type DecisionRow = {
    sessionId: string;
    messageId: string;
    tsMs: number;
    decision: string;
    materialized: boolean;
    materializeReason: string | null;
    emergency: boolean;
    droppedTokens: number;
    droppedCount: number;
    inputTokens: number;
    projectPath: string | null;
};

type CacheEvent = {
    messageId: string;
    sessionId: string;
    timestamp: number;
    inputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
};

type SessionLabel = {
    title: string | null;
    directory: string | null;
};

type PassPair = {
    decision: DecisionRow;
    current: CacheEvent;
    previous: CacheEvent;
    cachePercent: number;
    promptCachePercent: number;
};

type CountBreakdown = Record<string, number>;

type LandingBreakdown = {
    onHardFold: number;
    onM1Rerender: number;
    reclaimOnlyStrict: number;
    reclaimOnlyCoarseCandidate: number;
    reclaimOnlyStrictBelow90: number;
    reclaimOnlyCoarseCandidateBelow90: number;
};

type Metrics = {
    passCount: number;
    decisionRows: number;
    cacheJoinedRows: number;
    missingCacheRows: number;
    m0StableCount: number;
    m0StableRate: number | null;
    foldCount: number;
    foldsPer100Passes: number | null;
    bustsBelow95Per200Passes: number | null;
    bustsBelow80Per200Passes: number | null;
    alternativeBustsBelow95Per200Passes: number | null;
    alternativeBustsBelow80Per200Passes: number | null;
    medianCachePercentM0Stable: number | null;
    medianCachePercentFold: number | null;
    alternativeMedianPromptCachePercentM0Stable: number | null;
    alternativeMedianPromptCachePercentFold: number | null;
    below90OnM0StableCount: number;
    below90OnM0StableRate: number | null;
    alternativeBelow90OnM0StableCount: number;
    alternativeBelow90OnM0StableRate: number | null;
    stableRuns: {
        count: number;
        medianPasses: number | null;
        maxPasses: number | null;
    };
    foldTriggerBreakdown: CountBreakdown;
    below90AttributionBreakdown: CountBreakdown;
    allPassMutationBreakdown: CountBreakdown;
    reclaimLandingBreakdown: LandingBreakdown;
};

type SessionResult = {
    sessionId: string;
    projectPath: string | null;
    title: string | null;
    directory: string | null;
    metrics: Metrics;
};

type ModuleTrace = {
    sessionId: string;
    receiveCount: number;
    rejectCount: number;
    lastReceivedAtMs: number;
    lastCompletedAtMs: number;
    lastDivergenceClass: string | null;
};

type SpotCheck = {
    sessionId: string;
    messageId: string;
    previousMessageId: string;
    materialized: boolean;
    materializeReason: string | null;
    cacheRead: number;
    previousCacheRead: number;
    cachePercent: number;
    mutationClass: string;
};

type Output = {
    generatedAt: string;
    harness: Harness;
    filters: { sessionId: string | null; minPasses: number };
    sources: {
        contextDb: string;
        usage: string;
        moduleStore: string | null;
        readOnly: true;
    };
    cachePercentFormula: {
        primary: string;
        source: string;
        fallback: string;
        alternative: string;
        alternativeSource: string;
    };
    aggregate: Metrics;
    sessions: SessionResult[];
    spotChecks: SpotCheck[];
    telemetry: {
        qualifyingSessions: number;
        piCacheTelemetry: "MEASURABLE" | "NOT MEASURABLE" | "NOT APPLICABLE";
        notes: string[];
    };
    moduleStore: {
        available: boolean;
        materializeReasonDistribution: string;
        sampledHarnessTraces: ModuleTrace[];
        claudeCompositeTraces: ModuleTrace[];
        claudeLatestDivergenceBreakdown: CountBreakdown;
        claudeIdentity: {
            cacheStateRows: number;
            emptyModelKey: number;
            emptyProviderId: number;
        } | null;
    };
};

type PiFile = {
    sessionId: string;
    path: string;
    parentPath: string | null;
    title: string | null;
    directory: string | null;
    ownEvents: CacheEvent[];
};

function usage(): never {
    throw new Error(
        "Usage: bun packages/plugin/scripts/cache-parity-baseline.ts --harness opencode|pi [--session <id>] [--min-passes N] [--json]",
    );
}

function parseArgs(argv: string[]): Args {
    let harness: Harness | undefined;
    let sessionId: string | undefined;
    let minPasses = 50;
    let json = false;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--harness") {
            const value = argv[++index];
            if (value !== "opencode" && value !== "pi") usage();
            harness = value;
        } else if (arg === "--session") {
            sessionId = argv[++index];
            if (!sessionId) usage();
        } else if (arg === "--min-passes") {
            const value = Number(argv[++index]);
            if (!Number.isSafeInteger(value) || value < 1) usage();
            minPasses = value;
        } else if (arg === "--json") {
            json = true;
        } else {
            usage();
        }
    }
    if (!harness) usage();
    return { harness, sessionId, minPasses, json };
}

function dataHome(): string {
    return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

function openRequiredReadOnly(path: string, description: string): Database {
    if (!existsSync(path)) throw new Error(`${description} does not exist: ${path}`);
    try {
        const db = new Database(path, { readonly: true, strict: true });
        db.query("SELECT 1 AS ok").get();
        return db;
    } catch (error) {
        throw new Error(`refusing to run: cannot open ${description} read-only at ${path}: ${error}`);
    }
}

function openOptionalReadOnly(path: string, description: string): Database | null {
    if (!existsSync(path)) return null;
    return openRequiredReadOnly(path, description);
}

function numberValue(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function loadDecisions(db: Database, args: Args): Map<string, DecisionRow[]> {
    const clauses = ["td.harness = ?"];
    const parameters: Array<string | number> = [args.harness];
    if (args.sessionId) {
        clauses.push("td.session_id = ?");
        parameters.push(args.sessionId);
    }
    const rows = db
        .query(
            `SELECT td.session_id, td.message_id, td.ts_ms, td.decision, td.materialized,
                    td.materialize_reason, td.emergency, td.dropped_tokens, td.dropped_count,
                    td.input_tokens, sp.project_path
             FROM transform_decisions td
             JOIN session_meta sm
               ON sm.session_id = td.session_id AND sm.harness = td.harness
             LEFT JOIN session_projects sp
               ON sp.session_id = td.session_id AND sp.harness = td.harness
             WHERE COALESCE(sm.is_subagent, 0) = 0 AND ${clauses.join(" AND ")}
             ORDER BY td.session_id, td.ts_ms, td.rowid`,
        )
        .all(...parameters) as Array<Record<string, unknown>>;
    const bySession = new Map<string, DecisionRow[]>();
    for (const row of rows) {
        const sessionId = String(row.session_id);
        const list = bySession.get(sessionId) ?? [];
        list.push({
            sessionId,
            messageId: String(row.message_id),
            tsMs: numberValue(row.ts_ms),
            decision: String(row.decision),
            materialized: numberValue(row.materialized) !== 0,
            materializeReason: stringValue(row.materialize_reason),
            emergency: numberValue(row.emergency) !== 0,
            droppedTokens: numberValue(row.dropped_tokens),
            droppedCount: numberValue(row.dropped_count),
            inputTokens: numberValue(row.input_tokens),
            projectPath: stringValue(row.project_path),
        });
        bySession.set(sessionId, list);
    }
    return bySession;
}

const OPENCODE_CACHE_EVENT_SQL = `
    SELECT CAST(id AS TEXT) AS message_id, session_id, time_created,
           COALESCE(CAST(json_extract(data, '$.tokens.input') AS INTEGER), 0) AS input_tokens,
           COALESCE(CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER), 0) AS cache_read,
           COALESCE(CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER), 0) AS cache_write,
           COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) AS total_tokens
    FROM message
    WHERE session_id = ?
      AND json_extract(data, '$.role') = 'assistant'
      AND COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) > 0
    ORDER BY time_created, id`;

function loadOpenCodeEvents(
    db: Database,
    sessionId: string,
): { events: CacheEvent[]; label: SessionLabel } {
    const rows = db.query(OPENCODE_CACHE_EVENT_SQL).all(sessionId) as Array<Record<string, unknown>>;
    const labelRow = db
        .query("SELECT title, directory FROM session WHERE id = ?")
        .get(sessionId) as Record<string, unknown> | null;
    return {
        events: rows.map((row) => ({
            messageId: String(row.message_id),
            sessionId: String(row.session_id),
            timestamp: numberValue(row.time_created),
            inputTokens: numberValue(row.input_tokens),
            cacheRead: numberValue(row.cache_read),
            cacheWrite: numberValue(row.cache_write),
            totalTokens: numberValue(row.total_tokens),
        })),
        label: {
            title: stringValue(labelRow?.title),
            directory: stringValue(labelRow?.directory),
        },
    };
}

function getAnyNumber(value: unknown, keys: string[]): number {
    if (!value || typeof value !== "object") return 0;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
        const candidate = record[key];
        if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
            return candidate;
        }
    }
    return 0;
}

function parseTimestamp(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
}

function parsePiFile(path: string): PiFile | null {
    let lines: string[];
    try {
        lines = readFileSync(path, "utf8").split("\n");
    } catch {
        return null;
    }
    let header: Record<string, unknown> | null = null;
    const events: CacheEvent[] = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue;
        }
        if (!header && entry.type === "session") {
            header = entry;
            continue;
        }
        if (entry.type !== "message") continue;
        const message = entry.message;
        if (!message || typeof message !== "object") continue;
        const messageRecord = message as Record<string, unknown>;
        if (messageRecord.role !== "assistant") continue;
        const usage = messageRecord.usage ?? messageRecord.tokens;
        if (!usage || typeof usage !== "object") continue;
        const usageRecord = usage as Record<string, unknown>;
        const cache = usageRecord.cache;
        const input = getAnyNumber(usage, ["input", "inputTokens"]);
        const output = getAnyNumber(usage, ["output", "outputTokens"]);
        const cacheRead = cache
            ? getAnyNumber(cache, ["read", "cacheRead", "cache_read"])
            : getAnyNumber(usage, ["cache_read", "cacheRead"]);
        const cacheWrite = cache
            ? getAnyNumber(cache, ["write", "cacheWrite", "cache_write"])
            : getAnyNumber(usage, ["cache_write", "cacheWrite"]);
        const reportedTotal = getAnyNumber(usage, ["total", "totalTokens"]);
        const total = Math.max(reportedTotal, input + output + cacheRead + cacheWrite);
        if (total === 0) continue;
        const entryId = stringValue(entry.id);
        if (!entryId) continue;
        const timestamp = parseTimestamp(messageRecord.timestamp) || parseTimestamp(entry.timestamp);
        events.push({
            messageId: entryId,
            sessionId: "",
            timestamp,
            inputTokens: input,
            cacheRead,
            cacheWrite,
            totalTokens: total,
        });
    }
    if (!header) return null;
    const sessionId = stringValue(header.id);
    if (!sessionId) return null;
    for (const event of events) event.sessionId = sessionId;
    const parentRaw = stringValue(header.parentSession);
    const parentPath = parentRaw
        ? isAbsolute(parentRaw)
            ? parentRaw
            : resolve(dirname(path), parentRaw)
        : null;
    return {
        sessionId,
        path,
        parentPath,
        title: stringValue(header.name),
        directory: stringValue(header.cwd),
        ownEvents: events,
    };
}

async function scanPiFiles(root: string): Promise<Map<string, PiFile>> {
    if (!existsSync(root)) throw new Error(`Pi session directory does not exist: ${root}`);
    const files = new Map<string, PiFile>();
    const glob = new Bun.Glob("**/*.jsonl");
    for await (const relativePath of glob.scan({ cwd: root, onlyFiles: true })) {
        const parsed = parsePiFile(join(root, relativePath));
        if (parsed) files.set(parsed.sessionId, parsed);
    }
    return files;
}

function loadPiEvents(
    file: PiFile,
    filesById: Map<string, PiFile>,
    visited = new Set<string>(),
): CacheEvent[] {
    if (!visited.add(file.path)) return [];
    let parentEvents: CacheEvent[] = [];
    if (file.parentPath) {
        const parent = [...filesById.values()].find((candidate) => candidate.path === file.parentPath);
        const parsedParent = parent ?? parsePiFile(file.parentPath);
        if (parsedParent) parentEvents = loadPiEvents(parsedParent, filesById, visited);
    }
    return [...parentEvents, ...file.ownEvents].sort(
        (left, right) => left.timestamp - right.timestamp || left.messageId.localeCompare(right.messageId),
    );
}

function cachePercent(current: CacheEvent, previous: CacheEvent): number {
    if (previous.cacheRead > 0) {
        const previousOutput = Math.max(
            0,
            previous.totalTokens -
                previous.inputTokens -
                previous.cacheRead -
                previous.cacheWrite,
        );
        const growth =
            previous.cacheWrite > 0
                ? previous.cacheWrite
                : previous.inputTokens + previousOutput;
        const expected = previous.cacheRead + growth;
        return expected > 0 ? (current.cacheRead / expected) * 100 : 0;
    }
    return promptCachePercent(current);
}

function promptCachePercent(event: CacheEvent): number {
    const prompt = event.cacheRead + event.cacheWrite + event.inputTokens;
    return prompt > 0 ? (event.cacheRead / prompt) * 100 : 0;
}

function joinPairs(decisions: DecisionRow[], events: CacheEvent[]): {
    pairs: PassPair[];
    cacheJoinedRows: number;
    missingCacheRows: number;
} {
    const indexByMessage = new Map<string, number>();
    events.forEach((event, index) => indexByMessage.set(event.messageId, index));
    const pairs: PassPair[] = [];
    let cacheJoinedRows = 0;
    let missingCacheRows = 0;
    for (const decision of decisions) {
        const eventIndex = indexByMessage.get(decision.messageId);
        if (eventIndex === undefined) {
            missingCacheRows += 1;
            continue;
        }
        cacheJoinedRows += 1;
        if (eventIndex === 0) continue;
        const current = events[eventIndex];
        const previous = events[eventIndex - 1];
        pairs.push({
            decision,
            current,
            previous,
            cachePercent: cachePercent(current, previous),
            promptCachePercent: promptCachePercent(current),
        });
    }
    return { pairs, cacheJoinedRows, missingCacheRows };
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function rate(numerator: number, denominator: number): number | null {
    return denominator > 0 ? numerator / denominator : null;
}

function increment(counts: CountBreakdown, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

function isM1Rerender(pair: PassPair): boolean {
    return (
        !pair.decision.materialized &&
        (pair.decision.materializeReason === "m1_delta" ||
            pair.decision.materializeReason === "coverage_fold")
    );
}

function mutationClass(pair: PassPair): string {
    const decision = pair.decision;
    if (decision.materialized) return `m0-fold:${decision.materializeReason ?? "unknown"}`;
    if (isM1Rerender(pair)) return `m1-rerender:${decision.materializeReason}`;
    if (decision.materializeReason === "selection") return "reclaim-only:selection";
    if (decision.droppedCount > 0 && decision.emergency) return "drop-landing:emergency-coarse";
    if (decision.droppedCount > 0) return "drop-landing:coarse-unresolved";
    if (decision.decision === "execute") return "soft-execute:unattributed";
    if (decision.decision === "error") return "transform-error";
    return "no-recorded-byte-mutation";
}

function stableRuns(pairs: PassPair[]): number[] {
    const runs: number[] = [];
    let current = 0;
    for (const pair of pairs) {
        if (pair.decision.materialized) {
            if (current > 0) runs.push(current);
            current = 0;
        } else {
            current += 1;
        }
    }
    if (current > 0) runs.push(current);
    return runs;
}

function computeMetrics(
    pairs: PassPair[],
    decisionRows: number,
    cacheJoinedRows: number,
    missingCacheRows: number,
): Metrics {
    const stable = pairs.filter((pair) => !pair.decision.materialized);
    const folds = pairs.filter((pair) => pair.decision.materialized);
    const below90Stable = stable.filter((pair) => pair.cachePercent < LOW_CACHE_THRESHOLD);
    const alternativeBelow90Stable = stable.filter(
        (pair) => pair.promptCachePercent < LOW_CACHE_THRESHOLD,
    );
    const foldTriggerBreakdown: CountBreakdown = {};
    const below90AttributionBreakdown: CountBreakdown = {};
    const allPassMutationBreakdown: CountBreakdown = {};
    for (const pair of folds) {
        increment(foldTriggerBreakdown, pair.decision.materializeReason ?? "unknown");
    }
    for (const pair of below90Stable) increment(below90AttributionBreakdown, mutationClass(pair));
    for (const pair of pairs) increment(allPassMutationBreakdown, mutationClass(pair));

    const landing: LandingBreakdown = {
        onHardFold: 0,
        onM1Rerender: 0,
        reclaimOnlyStrict: 0,
        reclaimOnlyCoarseCandidate: 0,
        reclaimOnlyStrictBelow90: 0,
        reclaimOnlyCoarseCandidateBelow90: 0,
    };
    for (const pair of pairs) {
        const hasCoarseDrop = pair.decision.droppedCount > 0;
        if (pair.decision.materialized && hasCoarseDrop) landing.onHardFold += 1;
        if (isM1Rerender(pair) && hasCoarseDrop) landing.onM1Rerender += 1;
        if (!pair.decision.materialized && pair.decision.materializeReason === "selection") {
            landing.reclaimOnlyStrict += 1;
            if (pair.cachePercent < LOW_CACHE_THRESHOLD) landing.reclaimOnlyStrictBelow90 += 1;
        } else if (
            !pair.decision.materialized &&
            !isM1Rerender(pair) &&
            hasCoarseDrop
        ) {
            landing.reclaimOnlyCoarseCandidate += 1;
            if (pair.cachePercent < LOW_CACHE_THRESHOLD) {
                landing.reclaimOnlyCoarseCandidateBelow90 += 1;
            }
        }
    }
    const runs = stableRuns(pairs);
    const below95 = pairs.filter((pair) => pair.cachePercent < DASHBOARD_WARNING_THRESHOLD).length;
    const below80 = pairs.filter((pair) => pair.cachePercent < DASHBOARD_BUST_THRESHOLD).length;
    const alternativeBelow95 = pairs.filter(
        (pair) => pair.promptCachePercent < DASHBOARD_WARNING_THRESHOLD,
    ).length;
    const alternativeBelow80 = pairs.filter(
        (pair) => pair.promptCachePercent < DASHBOARD_BUST_THRESHOLD,
    ).length;
    return {
        passCount: pairs.length,
        decisionRows,
        cacheJoinedRows,
        missingCacheRows,
        m0StableCount: stable.length,
        m0StableRate: rate(stable.length, pairs.length),
        foldCount: folds.length,
        foldsPer100Passes: rate(folds.length * 100, pairs.length),
        bustsBelow95Per200Passes: rate(below95 * 200, pairs.length),
        bustsBelow80Per200Passes: rate(below80 * 200, pairs.length),
        alternativeBustsBelow95Per200Passes: rate(alternativeBelow95 * 200, pairs.length),
        alternativeBustsBelow80Per200Passes: rate(alternativeBelow80 * 200, pairs.length),
        medianCachePercentM0Stable: median(stable.map((pair) => pair.cachePercent)),
        medianCachePercentFold: median(folds.map((pair) => pair.cachePercent)),
        alternativeMedianPromptCachePercentM0Stable: median(
            stable.map((pair) => pair.promptCachePercent),
        ),
        alternativeMedianPromptCachePercentFold: median(
            folds.map((pair) => pair.promptCachePercent),
        ),
        below90OnM0StableCount: below90Stable.length,
        below90OnM0StableRate: rate(below90Stable.length, stable.length),
        alternativeBelow90OnM0StableCount: alternativeBelow90Stable.length,
        alternativeBelow90OnM0StableRate: rate(alternativeBelow90Stable.length, stable.length),
        stableRuns: {
            count: runs.length,
            medianPasses: median(runs),
            maxPasses: runs.length > 0 ? Math.max(...runs) : null,
        },
        foldTriggerBreakdown,
        below90AttributionBreakdown,
        allPassMutationBreakdown,
        reclaimLandingBreakdown: landing,
    };
}

function divergenceClass(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw) as {
            divergence?: { block_id_old?: unknown; block_id_new?: unknown; kind?: unknown };
        };
        const divergence = parsed.divergence;
        if (!divergence) return "unknown";
        const oldId = stringValue(divergence.block_id_old);
        const newId = stringValue(divergence.block_id_new);
        const block = oldId === "mc_m0" || newId === "mc_m0"
            ? "m0"
            : oldId === "mc_m1" || newId === "mc_m1"
              ? "m1"
              : oldId?.startsWith("served_message:") || newId?.startsWith("served_message:")
                ? "message"
                : "other";
        return `${block}:${stringValue(divergence.kind) ?? "unknown"}`;
    } catch {
        return "malformed";
    }
}

function loadModuleStore(
    db: Database | null,
    sampledSessionIds: Set<string>,
    minPasses: number,
): Output["moduleStore"] {
    const notMeasurable =
        "NOT MEASURABLE: mc_cache_state.meta stores current cache state but no materialize-reason history, and mc_pass_trace stores receive/reject counters plus only the latest divergence; historical CC reason counts are not persisted.";
    if (!db) {
        return {
            available: false,
            materializeReasonDistribution: notMeasurable,
            sampledHarnessTraces: [],
            claudeCompositeTraces: [],
            claudeLatestDivergenceBreakdown: {},
            claudeIdentity: null,
        };
    }
    const rows = db
        .query(
            `SELECT session_id, receive_count, reject_count, last_received_at_ms,
                    last_completed_at_ms, last_divergence
             FROM mc_pass_trace`,
        )
        .all() as Array<Record<string, unknown>>;
    const mapTrace = (row: Record<string, unknown>): ModuleTrace => ({
        sessionId: String(row.session_id),
        receiveCount: numberValue(row.receive_count),
        rejectCount: numberValue(row.reject_count),
        lastReceivedAtMs: numberValue(row.last_received_at_ms),
        lastCompletedAtMs: numberValue(row.last_completed_at_ms),
        lastDivergenceClass: divergenceClass(row.last_divergence),
    });
    const sampledHarnessTraces = rows
        .filter((row) => sampledSessionIds.has(String(row.session_id)))
        .map(mapTrace)
        .sort((left, right) => right.receiveCount - left.receiveCount);
    const claudeCompositeTraces = rows
        .filter(
            (row) =>
                String(row.session_id).includes(SESSION_SEPARATOR) &&
                numberValue(row.receive_count) >= minPasses,
        )
        .map(mapTrace)
        .sort((left, right) => right.receiveCount - left.receiveCount);
    const divergenceBreakdown: CountBreakdown = {};
    for (const trace of claudeCompositeTraces) {
        increment(divergenceBreakdown, trace.lastDivergenceClass ?? "none-recorded");
    }
    const identity = db
        .query(
            `SELECT COUNT(*) AS rows,
                    SUM(CASE WHEN COALESCE(json_extract(meta, '$.last_model_key'), '') = '' THEN 1 ELSE 0 END) AS empty_model,
                    SUM(CASE WHEN COALESCE(json_extract(meta, '$.last_provider_id'), '') = '' THEN 1 ELSE 0 END) AS empty_provider
             FROM mc_cache_state
             WHERE instr(session_id, ?) > 0`,
        )
        .get(SESSION_SEPARATOR) as Record<string, unknown>;
    return {
        available: true,
        materializeReasonDistribution: notMeasurable,
        sampledHarnessTraces,
        claudeCompositeTraces,
        claudeLatestDivergenceBreakdown: divergenceBreakdown,
        claudeIdentity: {
            cacheStateRows: numberValue(identity.rows),
            emptyModelKey: numberValue(identity.empty_model),
            emptyProviderId: numberValue(identity.empty_provider),
        },
    };
}

function percentage(value: number | null): string {
    return value === null ? "NOT MEASURABLE" : `${(value * 100).toFixed(1)}%`;
}

function decimal(value: number | null, suffix = ""): string {
    return value === null ? "NOT MEASURABLE" : `${value.toFixed(1)}${suffix}`;
}

function breakdown(value: CountBreakdown): string {
    const entries = Object.entries(value).sort((left, right) => right[1] - left[1]);
    return entries.length === 0 ? "none" : entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

function printHuman(output: Output): void {
    console.log(`Cache parity baseline — ${output.harness}`);
    console.log(`Generated: ${output.generatedAt}`);
    console.log(`READ-ONLY sources: ${output.sources.contextDb}; ${output.sources.usage}`);
    console.log(`Cache% formula: ${output.cachePercentFormula.primary}`);
    console.log(`Formula provenance: ${output.cachePercentFormula.source}`);
    console.log(`Fallback: ${output.cachePercentFormula.fallback}`);
    console.log(
        `Alternative (reported alongside): ${output.cachePercentFormula.alternative} — ${output.cachePercentFormula.alternativeSource}`,
    );
    console.log("");
    const metrics = output.aggregate;
    console.log("Aggregate reference table");
    console.log(`  consecutive pass pairs: ${metrics.passCount}`);
    console.log(`  BUSTS/200 (<95%, dashboard warning+): ${decimal(metrics.bustsBelow95Per200Passes)}`);
    console.log(`  hard busts/200 (<80%, dashboard bust): ${decimal(metrics.bustsBelow80Per200Passes)}`);
    console.log(
        `  alternative prompt-share busts/200 (<95% / <80%): ${decimal(metrics.alternativeBustsBelow95Per200Passes)} / ${decimal(metrics.alternativeBustsBelow80Per200Passes)}`,
    );
    console.log(`  m0-stable rate: ${percentage(metrics.m0StableRate)}`);
    console.log(`  median cache% on m0-stable: ${decimal(metrics.medianCachePercentM0Stable, "%")}`);
    console.log(`  median cache% on folds: ${decimal(metrics.medianCachePercentFold, "%")}`);
    console.log(
        `  below-90% on m0-stable: ${percentage(metrics.below90OnM0StableRate)} (${metrics.below90OnM0StableCount}/${metrics.m0StableCount})`,
    );
    console.log(
        `  alternative prompt-share below-90% on m0-stable: ${percentage(metrics.alternativeBelow90OnM0StableRate)} (${metrics.alternativeBelow90OnM0StableCount}/${metrics.m0StableCount})`,
    );
    console.log(`  folds/100 passes: ${decimal(metrics.foldsPer100Passes)}`);
    console.log(`  fold triggers: ${breakdown(metrics.foldTriggerBreakdown)}`);
    console.log(`  below-90 attribution: ${breakdown(metrics.below90AttributionBreakdown)}`);
    console.log(
        `  reclaim-only strict: ${metrics.reclaimLandingBreakdown.reclaimOnlyStrict} (${metrics.reclaimLandingBreakdown.reclaimOnlyStrictBelow90} below 90%)`,
    );
    console.log(
        `  reclaim-only coarse candidates: ${metrics.reclaimLandingBreakdown.reclaimOnlyCoarseCandidate} (${metrics.reclaimLandingBreakdown.reclaimOnlyCoarseCandidateBelow90} below 90%)`,
    );
    console.log(
        `  stable runs: count=${metrics.stableRuns.count}, median=${decimal(metrics.stableRuns.medianPasses)}, max=${metrics.stableRuns.maxPasses ?? "NOT MEASURABLE"}`,
    );
    console.log("");
    console.log("Per session");
    for (const session of output.sessions) {
        const value = session.metrics;
        console.log(
            `  ${session.sessionId} | pairs=${value.passCount} | busts/200=${decimal(value.bustsBelow95Per200Passes)} | stable=${percentage(value.m0StableRate)} | stable-cache=${decimal(value.medianCachePercentM0Stable, "%")} | folds/100=${decimal(value.foldsPer100Passes)} | low-stable=${percentage(value.below90OnM0StableRate)} | ${session.directory ?? session.projectPath ?? "unknown project"}`,
        );
    }
    console.log("");
    console.log("Join spot checks");
    for (const check of output.spotChecks) {
        console.log(
            `  ${check.sessionId} ${check.previousMessageId} -> ${check.messageId} | materialized=${check.materialized} reason=${check.materializeReason ?? "none"} cache=${check.cachePercent.toFixed(1)}% class=${check.mutationClass}`,
        );
    }
    console.log("");
    console.log(`Module-store reason history: ${output.moduleStore.materializeReasonDistribution}`);
    if (output.telemetry.notes.length > 0) {
        console.log("Notes:");
        for (const note of output.telemetry.notes) console.log(`  - ${note}`);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const root = dataHome();
    const contextPath = join(root, "cortexkit", "magic-context", "context.db");
    const storePath = join(root, "cortexkit", "magic-context", "store.db");
    const contextDb = openRequiredReadOnly(contextPath, "Magic Context database");
    const storeDb = openOptionalReadOnly(storePath, "Magic Context module store");
    let usageSource: string;
    let openCodeDb: Database | null = null;
    let piFiles: Map<string, PiFile> | null = null;
    try {
        if (args.harness === "opencode") {
            const openCodePath = join(root, "opencode", "opencode.db");
            openCodeDb = openRequiredReadOnly(openCodePath, "OpenCode database");
            usageSource = openCodePath;
        } else {
            const piRoot = join(homedir(), ".pi", "agent", "sessions");
            piFiles = await scanPiFiles(piRoot);
            usageSource = `${piRoot}/**/*.jsonl`;
        }

        const decisionsBySession = loadDecisions(contextDb, args);
        const sessionResults: SessionResult[] = [];
        const allPairs: PassPair[] = [];
        let allDecisionRows = 0;
        let allCacheJoinedRows = 0;
        let allMissingCacheRows = 0;
        let piHasCacheTelemetry = false;

        for (const [sessionId, decisions] of decisionsBySession) {
            let events: CacheEvent[];
            let label: SessionLabel;
            if (args.harness === "opencode") {
                const loaded = loadOpenCodeEvents(openCodeDb!, sessionId);
                events = loaded.events;
                label = loaded.label;
            } else {
                const file = piFiles!.get(sessionId);
                if (!file) continue;
                events = loadPiEvents(file, piFiles!);
                label = { title: file.title, directory: file.directory };
                if (events.some((event) => event.cacheRead > 0 || event.cacheWrite > 0)) {
                    piHasCacheTelemetry = true;
                }
            }
            const joined = joinPairs(decisions, events);
            if (joined.pairs.length < args.minPasses) continue;
            const metrics = computeMetrics(
                joined.pairs,
                decisions.length,
                joined.cacheJoinedRows,
                joined.missingCacheRows,
            );
            sessionResults.push({
                sessionId,
                projectPath: decisions.find((decision) => decision.projectPath)?.projectPath ?? null,
                title: label.title,
                directory: label.directory,
                metrics,
            });
            allPairs.push(...joined.pairs);
            allDecisionRows += decisions.length;
            allCacheJoinedRows += joined.cacheJoinedRows;
            allMissingCacheRows += joined.missingCacheRows;
        }

        sessionResults.sort(
            (left, right) =>
                right.metrics.passCount - left.metrics.passCount ||
                left.sessionId.localeCompare(right.sessionId),
        );
        const aggregate = computeMetrics(
            allPairs,
            allDecisionRows,
            allCacheJoinedRows,
            allMissingCacheRows,
        );
        const notes = [
            "transform_decisions is migration 38's durable cause-attribution table and is capped at the newest 2,000 rows per session/harness.",
            "Pass metrics use only primary managed sessions (session_meta.is_subagent=0) and decision rows joined by exact assistant message id to a usage row with a real immediately preceding usage event.",
            "materialize_reason=selection is the strict reclaim-only signal: Rust reason precedence records m1_delta/coverage_fold before selection, so selection did not ride an m1 re-render. Legacy TypeScript rows with dropped_count>0 and no reason are reported separately as coarse candidates because the table cannot prove they were the only mutation.",
            "The table does not distinguish tool-argument supersession, agent drop, age reclaim, overlay, and tail mutations within legacy coarse drop rows; those subclasses are reported as NOT MEASURABLE rather than inferred.",
            "Historical fold fill is NOT MEASURABLE: transform_decisions stores input_tokens but no per-pass context limit.",
        ];
        if (args.harness === "pi" && !piHasCacheTelemetry) {
            notes.push(
                "NOT MEASURABLE: qualifying Pi JSONL entries contain no positive cache_read/cache_write telemetry.",
            );
        }
        const sampledSessionIds = new Set(sessionResults.map((session) => session.sessionId));
        const spotCandidates = [
            allPairs.find((pair) => pair.decision.materialized),
            allPairs.find(
                (pair) => !pair.decision.materialized && pair.cachePercent < LOW_CACHE_THRESHOLD,
            ),
            allPairs.find(
                (pair) => !pair.decision.materialized && pair.cachePercent >= DASHBOARD_WARNING_THRESHOLD,
            ),
        ].filter((pair): pair is PassPair => pair !== undefined);
        const seenSpotMessages = new Set<string>();
        const spotChecks: SpotCheck[] = [];
        for (const pair of spotCandidates) {
            if (!seenSpotMessages.add(pair.decision.messageId)) continue;
            spotChecks.push({
                sessionId: pair.decision.sessionId,
                messageId: pair.decision.messageId,
                previousMessageId: pair.previous.messageId,
                materialized: pair.decision.materialized,
                materializeReason: pair.decision.materializeReason,
                cacheRead: pair.current.cacheRead,
                previousCacheRead: pair.previous.cacheRead,
                cachePercent: pair.cachePercent,
                mutationClass: mutationClass(pair),
            });
        }
        const output: Output = {
            generatedAt: new Date().toISOString(),
            harness: args.harness,
            filters: { sessionId: args.sessionId ?? null, minPasses: args.minPasses },
            sources: {
                contextDb: contextPath,
                usage: usageSource,
                moduleStore: storeDb ? storePath : null,
                readOnly: true,
            },
            cachePercentFormula: {
                primary:
                    "For a classified consecutive pair: current.cache_read / (previous.cache_read + growth) × 100, where growth = previous.cache_write when positive, otherwise previous.input + max(previous.total - previous.input - previous.cache_read - previous.cache_write, 0).",
                source: DASHBOARD_FORMULA_SOURCE,
                fallback:
                    "When the preceding pass has no cache_read baseline, use current.cache_read / (current.input + current.cache_read + current.cache_write) × 100, matching the dashboard's retained single-row hit_ratio.",
                alternative:
                    "current.cache_read / (current.input + current.cache_read + current.cache_write) × 100 on every pass",
                alternativeSource: ALTERNATIVE_FORMULA_SOURCE,
            },
            aggregate,
            sessions: sessionResults,
            spotChecks,
            telemetry: {
                qualifyingSessions: sessionResults.length,
                piCacheTelemetry:
                    args.harness === "pi"
                        ? piHasCacheTelemetry
                            ? "MEASURABLE"
                            : "NOT MEASURABLE"
                        : "NOT APPLICABLE",
                notes,
            },
            moduleStore: loadModuleStore(storeDb, sampledSessionIds, args.minPasses),
        };
        if (args.json) console.log(JSON.stringify(output, null, 2));
        else printHuman(output);
    } finally {
        openCodeDb?.close();
        storeDb?.close();
        contextDb.close();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
