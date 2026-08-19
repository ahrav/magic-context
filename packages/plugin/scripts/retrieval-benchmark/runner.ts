/**
 * Benchmark harness runner and matrix lifecycle (U5).
 *
 * Executes one versioned profile against one reviewed release: seeds the
 * production-shaped fixture snapshots, runs every enumerated case through
 * the REAL explicit and automatic retrieval surfaces, and assembles one
 * strict validated report.
 *
 * Contract highlights:
 * - Policy latency comes from trace-disabled external root timing only; a
 *   paired trace-enabled pass supplies stage decomposition and never enters
 *   the latency samples (KTD15).
 * - Concurrency is closed-loop: a fixed worker count, each worker with its
 *   own read-only connection, issuing the next query only after the
 *   previous one completes (KTD9).
 * - Cache layers (process-vector, connection/prepared-statement,
 *   SQLite-page, OS-page) are tracked separately with per-sample reset/hit
 *   evidence; any transition inside a case rejects the case (KTD9).
 * - Every completed case is committed as an atomic canonical-JSON
 *   checkpoint; resume requires exact release/config/case-set/build/
 *   instrumentation/host identity and fails closed otherwise (KTD11).
 * - A missing required cell leaves the run incomplete; the matrix is never
 *   silently shrunk.
 *
 * Dependency direction (KTD16): only this module and the seeder import
 * production execution adapters; the pure contract modules stay on DTOs.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { join } from "node:path";

import { executeAutoSearchDelivery } from "../../src/hooks/magic-context/auto-search-runner";
import {
    AUTO_SEARCH_RESULT_LIMIT,
    AUTO_SEARCH_SOURCES,
} from "../../src/hooks/magic-context/auto-search-prompt";
import {
    getProjectEmbeddings,
    invalidateProject,
    peekProjectEmbeddings,
} from "../../src/features/magic-context/memory";
import type {
    SearchSource,
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../src/features/magic-context/search";
import { unifiedSearch } from "../../src/features/magic-context/search";
import { MAX_SEARCH_RESULT_LIMIT } from "../../src/features/magic-context/search-bounds";
import {
    assertCandidateDepthSatisfied,
    SEARCH_TRACE_SCHEMA_VERSION,
    type SearchTraceSpan,
} from "../../src/features/magic-context/search-trace";
import { encodePhysicalResultLocator } from "../../src/features/magic-context/search-result-locator";
import { packSearchResults } from "../../src/tools/ctx-search/render";
import type { Database } from "../../src/shared/sqlite";
import { closeQuietly } from "../../src/shared/sqlite-helpers";

import { canonicalFingerprint, canonicalJson } from "./canonical-json";
import { SOURCE_FILTERS, type QueryScenario } from "./contract";
import type { ReviewedRelease } from "./index";
import { resolveRankedLocators, type ScenarioScope } from "./identity";
import {
    contextTokensPerUsefulResult,
    computeQueryMetrics,
    type JudgedGrade,
    judgedGradesByQuery,
    METRIC_POLICY_VERSION,
    scoredQueryValues,
} from "./metrics";
import {
    type BenchmarkProfile,
    checkHostResources,
    type HostResources,
    type ProfileCase,
    profileFingerprint,
    verifySelectivityObservation,
} from "./profiles";
import {
    type BenchmarkReport,
    buildCandidatePool,
    type CandidatePoolArtifact,
    type CaseEvidence,
    computeReportStatus,
    type DeliveryReason,
    evidenceDigest,
    parseReport,
    type ReportAttempt,
    type ReportScenario,
    REPORT_SCHEMA_VERSION,
    semanticFingerprint,
} from "./report";
import {
    BENCHMARK_EMBEDDING_MODEL_ID,
    deterministicTextVector,
    fixtureSessionId,
    measureMessageSelectivity,
    openFixtureSnapshot,
    type SeedResult,
    seedFixture,
} from "./seed";
import { TIMING_POLICY_VERSION, summarizeLatency, traceTimingEvidence } from "./timing";

export const RUNNER_VERSION = "retrieval-benchmark-runner/v1";
export const CHECKPOINT_SCHEMA_VERSION = "retrieval-benchmark-checkpoint/v1";

/** Source directories whose contents determine measured behavior: the
 *  harness itself plus every production module the measured path executes.
 *  Over-approximating (whole directories) errs toward fail-closed resume. */
const BUILD_SOURCE_DIRS = [
    "scripts/retrieval-benchmark",
    "src/features/magic-context",
    "src/hooks/magic-context",
    "src/tools/ctx-search",
    "src/shared",
] as const;
const BUILD_SOURCE_FILES = ["scripts/benchmark-retrieval.ts"] as const;
/** Dependency identity, relative to the workspace root: a lockfile change
 *  (tokenizer, sqlite driver) alters measured behavior without touching
 *  any hashed TypeScript path, so it must invalidate checkpoints too. */
const BUILD_DEPENDENCY_FILES = ["bun.lock", "packages/plugin/package.json"] as const;

let cachedBuildFingerprint: string | null = null;

/** Content identity of the code that produces case evidence (KTD11).
 *  `RUNNER_VERSION` alone is hand-maintained: editing ranking code or the
 *  harness without bumping it would let a resume silently mix stale
 *  checkpointed evidence into one report. Hashing the source surfaces makes
 *  any code change invalidate checkpoints without human discipline. Test
 *  and fixture files are excluded — they cannot change measured behavior. */
function buildFingerprint(): string {
    if (cachedBuildFingerprint !== null) return cachedBuildFingerprint;
    const packageRoot = new URL("../../", import.meta.url).pathname;
    const workspaceRoot = new URL("../../../../", import.meta.url).pathname;
    const fileHashes: Record<string, string> = {};
    const hashFile = (root: string, relPath: string): void => {
        const bytes = readFileSync(join(root, relPath));
        fileHashes[relPath] = createHash("sha256").update(bytes).digest("hex");
    };
    for (const relPath of BUILD_SOURCE_FILES) hashFile(packageRoot, relPath);
    for (const relPath of BUILD_DEPENDENCY_FILES) hashFile(workspaceRoot, relPath);
    for (const dir of BUILD_SOURCE_DIRS) {
        for (const entry of readdirSync(join(packageRoot, dir), { recursive: true })) {
            const normalized = String(entry).replaceAll("\\", "/");
            if (!normalized.endsWith(".ts")) continue;
            if (normalized.endsWith(".test.ts")) continue;
            if (normalized.includes("__fixtures__")) continue;
            hashFile(packageRoot, `${dir}/${normalized}`);
        }
    }
    cachedBuildFingerprint = canonicalFingerprint(fileHashes);
    return cachedBuildFingerprint;
}

/** Fused-ranking evaluation depth (R53). Derived from the production
 *  result-limit ceiling: `normalizeSearchResultLimit` silently clamps
 *  larger limits, so an unlinked literal here would let a production
 *  ceiling change shorten ranked lists while metrics kept evaluating at
 *  the old depth — a manufactured quality regression. */
export const EVALUATION_DEPTH = MAX_SEARCH_RESULT_LIMIT;

const DEFAULT_AUTO_SCORE_THRESHOLD = 0.6;
const DEFAULT_AUTO_TIMEOUT_MS = 3_000;
const CONSERVATION_TOLERANCE_MS = 1e-6;

export class RunnerError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: string[]) {
        super(diagnostics.join("; "));
        this.diagnostics = diagnostics;
    }
}

/** Thrown by test hooks to simulate a host interruption between cases. */
export class RunnerInterrupt extends Error {}

export interface OsPageEvictionOutcome {
    attempted: boolean;
    proof: string | null;
}

export interface CacheHooks {
    invalidateProcessVector: (projectScope: string) => void;
    peekProcessVector: (projectScope: string, modelId: string) => boolean;
    primeProcessVector: (db: Database, projectScope: string, modelId: string) => void;
    evictOsPageCache: (snapshotPath: string) => OsPageEvictionOutcome;
}

export interface RunnerHooks {
    /** Injected monotonic clock for samples, traces, and seed timing. */
    now?: () => number;
    /** Injected wall clock for attempt records. */
    epochNow?: () => number;
    cache?: Partial<CacheHooks>;
    /** Called after each case checkpoint commits; tests throw
     *  `RunnerInterrupt` here to simulate a host stop between cases. */
    onCaseCheckpointed?: (caseId: string) => void;
    /** Preflight override; defaults to the actual host. */
    hostResources?: HostResources;
}

export interface RunBenchmarkOptions {
    release: ReviewedRelease;
    profile: BenchmarkProfile;
    /** Per-invocation scratch directory for fixture databases. */
    workDir: string;
    /** Persistent checkpoint directory; enables atomic case commits and
     *  compatible resume. Omit for a single-shot run without checkpoints. */
    checkpointDir?: string;
    autoScoreThreshold?: number;
    autoTimeoutMs?: number;
    /** Defaults to `profile.host.class !== "ci"`: reference hosts must prove
     *  OS-page eviction, CI records a not-attempted layer instead. */
    requireOsPageEvictionProof?: boolean;
    hooks?: RunnerHooks;
}

export interface RunBenchmarkResult {
    report: BenchmarkReport;
    semanticFingerprint: string;
    evidenceDigest: string;
    candidatePool: CandidatePoolArtifact;
    diagnostics: readonly string[];
}

interface FixtureHandle {
    key: string;
    dims: number;
    scale: number;
    snapshotPath: string;
    manifestFingerprint: string;
    indexBuildMs: number;
    snapshotBytes: number;
}

interface CaseResultRecord {
    caseId: string;
    scenarios: ReportScenario[];
    caseEvidence: CaseEvidence;
    /** Per raw query id: evaluation-depth ranking for the candidate pool. */
    candidateRankings: Array<{ queryId: string; ranked: string[] }>;
}

interface CheckpointCaseFile {
    schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
    identityFingerprint: string;
    caseId: string;
    scenarios: ReportScenario[];
    caseEvidence: CaseEvidence;
    candidateRankings: Array<{ queryId: string; ranked: string[] }>;
}

function defaultCacheHooks(): CacheHooks {
    return {
        invalidateProcessVector: (projectScope) => invalidateProject(projectScope),
        peekProcessVector: (projectScope, modelId) =>
            peekProjectEmbeddings(projectScope, modelId) !== null,
        primeProcessVector: (db, projectScope, modelId) => {
            getProjectEmbeddings(db, projectScope, modelId);
        },
        // No privileged OS cache-eviction mechanism ships with the harness;
        // controlled hosts must supply one, CI records not-attempted.
        evictOsPageCache: () => ({ attempted: false, proof: null }),
    };
}

function detectHostResources(workDir: string): HostResources {
    let availableDiskBytes = Number.MAX_SAFE_INTEGER;
    try {
        const { statfsSync } = require("node:fs") as typeof import("node:fs");
        const stats = statfsSync(workDir);
        availableDiskBytes = stats.bavail * stats.bsize;
    } catch {
        // statfs unavailable on this platform: preflight still checks memory.
    }
    return {
        totalMemoryBytes: totalmem(),
        availableDiskBytes,
        cpuArchitecture: process.arch,
    };
}

function hostFingerprint(): string {
    return canonicalFingerprint({
        arch: process.arch,
        platform: process.platform,
        cpuModel: cpus()[0]?.model ?? "unknown",
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        // Runs under different runtimes are not latency-comparable, so the
        // runtime version participates in host identity.
        runtime: typeof Bun !== "undefined" ? `bun/${Bun.version}` : `node/${process.version}`,
        // Hardware-class attributes alone collide across same-spec machines
        // in a runner group; the hostname pins the actual machine so
        // exact-host latency checks cannot mix physical hosts.
        hostname: hostname(),
    });
}

function atomicWrite(path: string, text: string): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// KTD9 cache-layer lifecycle.
// ---------------------------------------------------------------------------

interface LayerEvidence {
    layer: CaseEvidence["cacheLayers"][number]["layer"];
    declared: "cold" | "warm";
    mechanism: string;
    resets: number;
    verifications: number;
    status: "verified" | "not-attempted" | "not-applicable";
}

class CaseCacheController {
    readonly freshConnectionPerSample: boolean;
    private readonly layers: LayerEvidence[];
    private readonly processVector: LayerEvidence;
    /** Set by beforeSample for warm-declared cases; consumed by
     *  warmSampleReady once a connection exists to re-prime against. */
    private warmVerifyDue = false;

    constructor(
        private readonly profileCase: ProfileCase,
        private readonly cache: CacheHooks,
        private readonly ctx: {
            projectScope: string;
            modelId: string;
            snapshotPath: string;
            memoryLaneActive: boolean;
            requireOsPageEvictionProof: boolean;
        },
    ) {
        const state = profileCase.cacheState;
        // Prepared statements and the SQLite page cache both live on the
        // connection in this runtime, so their declared states must agree:
        // a fresh connection resets both or neither.
        if (state.connectionStatement !== state.sqlitePage) {
            throw new RunnerError([
                `case ${profileCase.id}: connectionStatement and sqlitePage states must agree in-process`,
            ]);
        }
        // With concurrency > 1, another worker can repopulate the shared processVector cache between invalidation and measurement, so cold samples require one worker (KTD9). commentlint: allow(JUDGE)
        // The guard applies only when the memory lane can touch that cache;
        // a case whose lanes exclude memory never reads it, so the race it
        // prevents cannot occur.
        if (state.processVector === "cold" && profileCase.concurrency > 1 && ctx.memoryLaneActive) {
            throw new RunnerError([
                `case ${profileCase.id}: cold processVector requires concurrency 1 (a concurrent worker can re-warm the shared process cache between invalidate and sample)`,
            ]);
        }
        // Same shared-resource race for the OS page cache: every worker
        // reads the same snapshot file, so one worker's eviction is undone
        // by any concurrent worker's read before the measured query runs.
        if (state.osPage === "cold" && profileCase.concurrency > 1) {
            throw new RunnerError([
                `case ${profileCase.id}: cold osPage requires concurrency 1 (a concurrent worker re-warms the shared page cache between eviction and sample)`,
            ]);
        }
        this.freshConnectionPerSample = state.connectionStatement === "cold";
        const connectionMechanism = this.freshConnectionPerSample
            ? "fresh-read-only-connection-per-sample"
            : "persistent-worker-connection";
        this.processVector = {
            layer: "processVector",
            declared: state.processVector,
            mechanism: !ctx.memoryLaneActive
                ? "memory-lane-inactive"
                : state.processVector === "cold"
                  ? "invalidate-project-cache-per-sample"
                  : "primed-project-embedding-cache",
            resets: 0,
            verifications: 0,
            status: ctx.memoryLaneActive ? "verified" : "not-applicable",
        };
        this.layers = [
            this.processVector,
            {
                layer: "connectionStatement",
                declared: state.connectionStatement,
                mechanism: connectionMechanism,
                resets: 0,
                verifications: 0,
                status: "verified",
            },
            {
                layer: "sqlitePage",
                declared: state.sqlitePage,
                mechanism: connectionMechanism,
                resets: 0,
                verifications: 0,
                status: "verified",
            },
            {
                layer: "osPage",
                declared: state.osPage,
                mechanism: state.osPage === "cold" ? "eviction-hook" : "warmed-by-execution",
                resets: 0,
                verifications: 0,
                status: "verified",
            },
        ];
    }

    start(db: Database): void {
        this.evictOsPageIfCold();
        if (
            this.processVector.status !== "not-applicable" &&
            this.processVector.declared === "warm"
        ) {
            // The process vector cache keys on (projectScope, modelId),
            // which every fixture shares: without this invalidation a warm
            // case can inherit the PREVIOUS fixture's vectors (wrong dims)
            // through the cache TTL and score every cosine at zero. Cold
            // cases invalidate before every measured sample instead.
            this.cache.invalidateProcessVector(this.ctx.projectScope);
            this.cache.primeProcessVector(db, this.ctx.projectScope, this.ctx.modelId);
            this.verifyWarmProcessVector("case-start");
        }
    }

    private evictOsPageIfCold(): void {
        if (this.profileCase.cacheState.osPage !== "cold") return;
        const osLayer = this.layers[3];
        const outcome = this.cache.evictOsPageCache(this.ctx.snapshotPath);
        if (outcome.attempted && outcome.proof !== null) {
            osLayer.resets += 1;
            osLayer.mechanism = `eviction-hook:${outcome.proof}`;
        } else if (this.ctx.requireOsPageEvictionProof) {
            throw new RunnerError([
                `case ${this.profileCase.id}: OS-page eviction requires recorded proof`,
            ]);
        } else {
            osLayer.status = "not-attempted";
        }
    }

    /** Called once per measured sample, right after its connection opens.
     *  Warmups, the evaluation pass, and the traced diagnostic pass open
     *  connections too, but only measured samples are reset evidence. */
    measuredConnectionOpened(): void {
        if (this.freshConnectionPerSample) {
            this.layers[1].resets += 1;
            this.layers[2].resets += 1;
        }
    }

    beforeSample(queryTouchesMemory: boolean): void {
        // Warmups and earlier samples repopulate the page cache, so a cold
        // OS-page declaration requires eviction before EVERY measured
        // sample, not just at case start.
        this.evictOsPageIfCold();
        if (this.processVector.status === "not-applicable") return;
        if (this.processVector.declared === "cold") {
            this.cache.invalidateProcessVector(this.ctx.projectScope);
            this.processVector.resets += 1;
            return;
        }
        if (queryTouchesMemory) this.warmVerifyDue = true;
    }

    /** Runs once a connection is available, before the timed section. The
     *  production embedding cache expires entries by TTL without extending
     *  on hits, so a case outliving the TTL must re-prime to keep its
     *  declared warm state instead of failing mid-case. */
    warmSampleReady(db: Database, queryTouchesMemory: boolean): void {
        if (!this.warmVerifyDue) return;
        this.warmVerifyDue = false;
        if (!queryTouchesMemory) return;
        if (!this.cache.peekProcessVector(this.ctx.projectScope, this.ctx.modelId)) {
            this.cache.primeProcessVector(db, this.ctx.projectScope, this.ctx.modelId);
            this.processVector.resets += 1;
            this.processVector.mechanism = "primed-project-embedding-cache:ttl-reprimed";
        }
        this.verifyWarmProcessVector("before-sample");
    }

    afterSample(queryTouchesMemory: boolean): void {
        if (!this.freshConnectionPerSample) {
            this.layers[1].verifications += 1;
            this.layers[2].verifications += 1;
        }
        if (this.processVector.status === "not-applicable") return;
        if (this.processVector.declared === "warm" && queryTouchesMemory) {
            this.verifyWarmProcessVector("after-sample");
        }
    }

    private verifyWarmProcessVector(point: string): void {
        if (!this.cache.peekProcessVector(this.ctx.projectScope, this.ctx.modelId)) {
            throw new RunnerError([
                `case ${this.profileCase.id}: process-vector cache transition inside case (${point}); TTL expiry or invalidation invalidates the case`,
            ]);
        }
        this.processVector.verifications += 1;
    }

    finish(): CaseEvidence["cacheLayers"] {
        return this.layers.map((layer) => ({ ...layer }));
    }
}

// ---------------------------------------------------------------------------
// Mode execution through the production surfaces.
// ---------------------------------------------------------------------------

interface DeliveryOutcome {
    reason: DeliveryReason;
    delivered: UnifiedSearchResult[];
    tokenCount: number;
}

interface QueryExecutionContext {
    query: QueryScenario;
    profileCase: ProfileCase;
    sessionId: string;
    projectScope: string;
    dims: number;
    autoScoreThreshold: number;
    autoTimeoutMs: number;
}

function effectiveSources(ctx: QueryExecutionContext): SearchSource[] | undefined {
    const base: readonly SearchSource[] | null =
        ctx.query.mode === "automatic" ? AUTO_SEARCH_SOURCES : ctx.query.sourceFilters;
    // The case's lane axis and its selectivity predicate both narrow the
    // executed source set: the preflight validates cardinalities for the
    // declared predicate, so the measured search must run under it (R58).
    let sources: readonly SearchSource[] | null = base;
    for (const narrower of [
        ctx.profileCase.sourceLanes,
        ctx.profileCase.selectivity.predicate.sources,
    ]) {
        if (narrower === null) continue;
        const admitted = sources;
        sources = admitted === null ? narrower : narrower.filter((lane) => admitted.includes(lane));
    }
    return sources === null ? undefined : [...sources];
}

function effectiveMessageCutoff(ctx: QueryExecutionContext): number | undefined {
    const caseCutoff = ctx.profileCase.selectivity.predicate.messageOrdinalCutoff;
    const queryCutoff = ctx.query.visibleState.messageOrdinalCutoff;
    if (ctx.query.mode === "automatic") {
        // The production automatic path searches all indexed history; a
        // case predicate that narrows it could not execute through the
        // real surface, so it is rejected instead of silently honored.
        if (caseCutoff !== null) {
            throw new RunnerError([
                `case ${ctx.profileCase.id}: automatic mode cannot narrow the message ordinal`,
            ]);
        }
        return undefined;
    }
    if (queryCutoff === null) return caseCutoff ?? undefined;
    return caseCutoff === null ? queryCutoff : Math.min(queryCutoff, caseCutoff);
}

function buildSearchOptions(
    ctx: QueryExecutionContext,
    overrides: Partial<UnifiedSearchOptions> = {},
): UnifiedSearchOptions {
    const dims = ctx.dims;
    const options: UnifiedSearchOptions = {
        limit: ctx.query.mode === "automatic" ? AUTO_SEARCH_RESULT_LIMIT : ctx.query.resultLimit,
        memoryEnabled: true,
        embeddingEnabled: true,
        gitCommitsEnabled: true,
        explicitSearch: ctx.query.mode === "explicit",
        countRetrievals: false,
        measurementDisabled: true,
        embeddingModelIdOverride: BENCHMARK_EMBEDDING_MODEL_ID,
        chunkModelIdOverride: BENCHMARK_EMBEDDING_MODEL_ID,
        // A raw Float32Array bypasses the generation contract: the benchmark
        // project is never registered in the project embedding registry, so
        // a CapturedQueryEmbedding (generation-bearing) would always compare
        // against a null snapshot and be discarded as stale, silencing every
        // semantic scoring lane. Model ids come from the overrides above.
        embedQuery: async (text) => deterministicTextVector(text, dims),
        isEmbeddingRuntimeEnabled: () => true,
        // The predicate's visibility exclusions execute alongside the
        // query's own: both narrow the eligible memory set the preflight
        // validated cardinalities against.
        visibleMemoryIds: new Set([
            ...ctx.query.visibleState.visibleMemoryIds,
            ...ctx.profileCase.selectivity.predicate.visibleMemoryIds,
        ]),
        candidateDepth: ctx.profileCase.candidateK.effective,
        ...overrides,
    };
    const sources = effectiveSources(ctx);
    if (sources !== undefined) options.sources = sources;
    const cutoff = effectiveMessageCutoff(ctx);
    if (cutoff !== undefined) options.maxMessageOrdinal = cutoff;
    return options;
}

/** One production-shaped delivery execution: search plus packing. A search
 *  failure propagates as a thrown error — incomplete evidence (AE8). */
async function executeDelivery(
    db: Database,
    ctx: QueryExecutionContext,
    trace?: UnifiedSearchOptions["trace"],
): Promise<DeliveryOutcome> {
    if (ctx.query.mode === "automatic") {
        const delivery = await executeAutoSearchDelivery({
            db,
            sessionId: ctx.sessionId,
            projectPath: ctx.projectScope,
            prompt: ctx.query.queryText,
            searchOptions: buildSearchOptions(ctx, trace ? { trace } : {}),
            scoreThreshold: ctx.autoScoreThreshold,
            timeoutMs: ctx.autoTimeoutMs,
            // Pinned pack clock: live Date.now() would render different age
            // strings (and token counts) for the same fingerprinted scenario
            // on different days.
            packNowMs: ctx.query.referenceTimeMs,
        });
        if (delivery.status === "incomplete") {
            throw new RunnerError([
                `query ${ctx.query.id}: automatic search failure (${String(delivery.error)})`,
            ]);
        }
        return {
            reason: delivery.reason,
            delivered: delivery.delivered,
            tokenCount: delivery.tokenCount,
        };
    }
    const results = await unifiedSearch(
        db,
        ctx.sessionId,
        ctx.projectScope,
        ctx.query.queryText,
        buildSearchOptions(ctx, trace ? { trace } : {}),
    );
    const packed = packSearchResults(
        ctx.query.queryText,
        results,
        ctx.sessionId,
        ctx.query.referenceTimeMs,
    );
    return { reason: packed.reason, delivered: packed.delivered, tokenCount: packed.tokenCount };
}

/** Fused ranking at the evaluation depth through the same surface options,
 *  with only the returned-result limit widened to the production ceiling. */
async function executeEvaluation(db: Database, ctx: QueryExecutionContext): Promise<string[]> {
    const results = await unifiedSearch(
        db,
        ctx.sessionId,
        ctx.projectScope,
        ctx.query.queryText,
        buildSearchOptions(ctx, { limit: EVALUATION_DEPTH }),
    );
    return results.map(encodePhysicalResultLocator);
}

// ---------------------------------------------------------------------------
// Case execution.
// ---------------------------------------------------------------------------

interface RunContext {
    release: ReviewedRelease;
    profile: BenchmarkProfile;
    now: () => number;
    /** Absolute now()-domain instant when the attempt's wall-time budget
     *  (seeding included) expires; sample loops check it between samples. */
    deadlineAtMs: number;
    cache: CacheHooks;
    autoScoreThreshold: number;
    autoTimeoutMs: number;
    requireOsPageEvictionProof: boolean;
    fixtures: Map<string, FixtureHandle>;
    judged: Map<string, ReadonlyMap<string, JudgedGrade>>;
}

function fixtureKey(scale: number, dims: number): string {
    return `${scale}x${dims}`;
}

function primaryScope(release: ReviewedRelease): string {
    return release.corpus.queries[0].fixtureScope.projectScope;
}

function scenarioId(caseId: string, queryId: string): string {
    return `${caseId}:${queryId}`;
}

function buildScenario(
    ctx: RunContext,
    profileCase: ProfileCase,
    query: QueryScenario,
    fixture: FixtureHandle,
    outcome: {
        ranked: string[];
        delivery: DeliveryOutcome;
        latencySamplesMs: number[];
        tracedSpans: SearchTraceSpan[];
    },
): ReportScenario {
    const scope: ScenarioScope = query.fixtureScope;
    const judgedGrades = ctx.judged.get(query.id) ?? new Map<string, JudgedGrade>();
    const resolved = resolveRankedLocators(outcome.ranked, scope, ctx.release.aliasIndex);
    const queryMetrics = computeQueryMetrics({ queryId: query.id, resolved, judgedGrades });
    const values = scoredQueryValues(queryMetrics);
    const at50 = queryMetrics.cutoffs.find((cutoff) => cutoff.cutoff === 50);
    if (!at50) throw new RunnerError([`query ${query.id}: missing depth-50 metrics window`]);
    const deliveredLocators = outcome.delivery.delivered.map(encodePhysicalResultLocator);
    const deliveredResolved = resolveRankedLocators(
        deliveredLocators,
        scope,
        ctx.release.aliasIndex,
    );

    let timing: ReportScenario["timing"] = null;
    if (outcome.tracedSpans.length > 0) {
        assertCandidateDepthSatisfied(outcome.tracedSpans, profileCase.candidateK.requested);
        const evidence = traceTimingEvidence(outcome.tracedSpans, {
            indexBuildMs: fixture.indexBuildMs,
            toleranceMs: CONSERVATION_TOLERANCE_MS,
        });
        timing = {
            timingPolicyVersion: TIMING_POLICY_VERSION,
            rootDurationMs: evidence.rootDurationMs,
            coveredMs: evidence.coveredMs,
            uncoveredMs: evidence.uncoveredMs,
            inclusiveSumMs: evidence.inclusiveSumMs,
            overlapMs: evidence.overlapMs,
            criticalPathMs: evidence.criticalPathMs,
            decodedVectorBytes: evidence.work.decodedVectorBytes,
            cachedVectorBytes: evidence.work.cachedVectorBytes,
            indexBuildMs: evidence.work.indexBuildMs,
        };
    }

    return {
        queryId: scenarioId(profileCase.id, query.id),
        mode: query.mode,
        partition: query.partition,
        paraphraseGroup: query.paraphraseGroup,
        rankedPhysical: outcome.ranked,
        deliveredPhysical: deliveredLocators,
        deliveredTokens: outcome.delivery.tokenCount,
        deliveryReason: outcome.delivery.reason,
        latencySamplesMs: outcome.latencySamplesMs,
        metrics: {
            metricPolicyVersion: METRIC_POLICY_VERSION,
            recallAt10: values.recallAt10,
            recallAt50: values.recallAt50,
            reciprocalRank: values.reciprocalRank,
            ndcgAt10: values.ndcgAt10,
            duplicateRateAt50: at50.duplicateRate,
            contextTokensPerUsefulResult: contextTokensPerUsefulResult(
                outcome.delivery.tokenCount,
                deliveredResolved,
                judgedGrades,
            ),
            rerankerLift: { status: "not_applicable" },
            coverageAt50: at50.coverage,
        },
        timing,
    };
}

interface ConnectionLease {
    acquire: () => Database;
    release: (db: Database) => void;
}

interface QueryScenarioOutcome {
    ranked: string[];
    delivery: DeliveryOutcome;
    latencySamplesMs: number[];
    tracedSpans: SearchTraceSpan[];
}

/** Per-query progress owned by exactly one worker at a time: the case
 *  scheduler passes a state between workers one unit (warmup or sample) at a
 *  time, so no lock guards these fields. */
interface QueryRunState {
    qctx: QueryExecutionContext;
    queryTouchesMemory: boolean;
    warmupsDone: number;
    latencySamplesMs: number[];
    firstDelivery: DeliveryOutcome | null;
    lastDelivery: DeliveryOutcome | null;
}

function newQueryRunState(qctx: QueryExecutionContext): QueryRunState {
    const sources = effectiveSources(qctx);
    return {
        qctx,
        queryTouchesMemory: sources === undefined || sources.includes("memory"),
        warmupsDone: 0,
        latencySamplesMs: [],
        firstDelivery: null,
        lastDelivery: null,
    };
}

function checkCaseDeadline(ctx: RunContext, profileCase: ProfileCase): void {
    if (ctx.now() > ctx.deadlineAtMs) {
        throw new RunnerInterrupt(
            `wall-time budget exhausted during case ${profileCase.id} (maxWallTimeMs=${ctx.profile.runtime.maxWallTimeMs})`,
        );
    }
}

/** Execute ONE unit of a query scenario — a single warmup or a single
 *  measured sample. The case scheduler interleaves queries at this
 *  granularity so every worker stays busy for the whole measurement window
 *  and samples are taken at the declared concurrency; whole-query
 *  scheduling would let the case tail run below the declared load while
 *  still pooling those samples into the concurrency cell. Returns true when
 *  the query's sampling is complete. */
async function executeQueryUnit(
    ctx: RunContext,
    profileCase: ProfileCase,
    controller: CaseCacheController,
    conn: ConnectionLease,
    state: QueryRunState,
): Promise<boolean> {
    checkCaseDeadline(ctx, profileCase);
    const { qctx, queryTouchesMemory } = state;

    if (state.warmupsDone < ctx.profile.runtime.warmups) {
        const db = conn.acquire();
        try {
            await executeDelivery(db, qctx);
        } finally {
            conn.release(db);
        }
        state.warmupsDone += 1;
        return false;
    }

    controller.beforeSample(queryTouchesMemory);
    const db = conn.acquire();
    let delivery: DeliveryOutcome;
    try {
        controller.measuredConnectionOpened();
        controller.warmSampleReady(db, queryTouchesMemory);
        const startedAt = ctx.now();
        delivery = await executeDelivery(db, qctx);
        state.latencySamplesMs.push(ctx.now() - startedAt);
    } finally {
        conn.release(db);
    }
    controller.afterSample(queryTouchesMemory);
    state.lastDelivery = delivery;
    // Measured samples must agree on the user-visible outcome: keeping
    // only the last sample's outcome would let a case with intermittent
    // timeouts report a normal delivery.
    if (state.firstDelivery === null) {
        state.firstDelivery = delivery;
    } else if (delivery.reason !== state.firstDelivery.reason) {
        throw new RunnerError([
            `query ${qctx.query.id}: measured delivery outcomes disagree (sample 1: ${state.firstDelivery.reason}, sample ${state.latencySamplesMs.length}: ${delivery.reason})`,
        ]);
    }
    return state.latencySamplesMs.length >= ctx.profile.runtime.samples;
}

/** Evaluation and traced-diagnostic passes after a query's last measured
 *  sample; neither is a latency-policy sample. */
async function finalizeQueryScenario(
    ctx: RunContext,
    profileCase: ProfileCase,
    controller: CaseCacheController,
    conn: ConnectionLease,
    state: QueryRunState,
): Promise<QueryScenarioOutcome> {
    const { qctx, queryTouchesMemory } = state;
    if (!state.lastDelivery) {
        throw new RunnerError([`query ${qctx.query.id}: no measured sample`]);
    }

    const evalDb = conn.acquire();
    let ranked: string[];
    try {
        ranked = await executeEvaluation(evalDb, qctx);
    } finally {
        conn.release(evalDb);
    }

    // Paired trace-enabled diagnostic pass (KTD15): stage
    // decomposition only, never a latency-policy sample. The evaluation
    // pass above left every cache layer warm, so the declared cache state
    // is re-established first or a cold cell's stage decomposition would
    // describe a warm execution.
    controller.beforeSample(queryTouchesMemory);
    const tracedSpans: SearchTraceSpan[] = [];
    const traceDb = conn.acquire();
    let tracedDelivery: DeliveryOutcome;
    try {
        controller.warmSampleReady(traceDb, queryTouchesMemory);
        tracedDelivery = await executeDelivery(traceDb, qctx, {
            sink: { onSpan: (span) => tracedSpans.push(span) },
            now: ctx.now,
            clockDomain: `${profileCase.id}:${qctx.query.id}`,
        });
    } finally {
        conn.release(traceDb);
    }
    if (tracedDelivery.reason === "timeout") tracedSpans.length = 0;

    return {
        ranked,
        delivery: state.lastDelivery,
        latencySamplesMs: state.latencySamplesMs,
        tracedSpans,
    };
}

async function executeCase(ctx: RunContext, profileCase: ProfileCase): Promise<CaseResultRecord> {
    const fixture = ctx.fixtures.get(fixtureKey(profileCase.scale, profileCase.dims));
    if (!fixture) {
        throw new RunnerError([`case ${profileCase.id}: fixture missing`]);
    }
    const projectScope = primaryScope(ctx.release);
    const predicate = profileCase.selectivity.predicate;

    // Selectivity cells execute through the production message index; the
    // observed cardinalities must match the declared recipe (R58).
    let selectivityObserved: { preFilterDenominator: number; eligibleCount: number };
    {
        const db = openFixtureSnapshot(fixture.snapshotPath);
        try {
            const observed = measureMessageSelectivity(db, {
                projectScope: predicate.projectScope,
                sessionScope: predicate.sessionScope,
                messageOrdinalCutoff: predicate.messageOrdinalCutoff,
            });
            const verdict = verifySelectivityObservation(profileCase.selectivity, observed);
            if (!verdict.ok) {
                throw new RunnerError(
                    verdict.diagnostics.map((d) => `case ${profileCase.id}: ${d}`),
                );
            }
            selectivityObserved = observed;
        } finally {
            closeQuietly(db);
        }
    }

    const queries = ctx.release.corpus.queries.filter((query) => query.mode === profileCase.mode);
    // Scope is the one predicate field the executed search cannot merge: a
    // query runs under its own fixture scope, so a mismatch means the
    // preflight validated cardinalities for a workload no query executes.
    for (const query of queries) {
        const scopeMismatch =
            predicate.projectScope !== query.fixtureScope.projectScope ||
            (predicate.sessionScope !== null &&
                predicate.sessionScope !== query.fixtureScope.sessionScope);
        if (scopeMismatch) {
            throw new RunnerError([
                `case ${profileCase.id}: query ${query.id} fixture scope does not match the selectivity predicate scope`,
            ]);
        }
    }
    const lanes = profileCase.sourceLanes;
    const memoryLaneActive =
        (lanes === null || lanes.includes("memory")) &&
        (profileCase.mode === "automatic"
            ? AUTO_SEARCH_SOURCES.includes("memory")
            : queries.some((query) => query.sourceFilters === null || query.sourceFilters.includes("memory")));

    const controller = new CaseCacheController(profileCase, ctx.cache, {
        projectScope,
        modelId: BENCHMARK_EMBEDDING_MODEL_ID,
        snapshotPath: fixture.snapshotPath,
        memoryLaneActive,
        requireOsPageEvictionProof: ctx.requireOsPageEvictionProof,
    });
    {
        const db = openFixtureSnapshot(fixture.snapshotPath);
        try {
            controller.start(db);
        } finally {
            closeQuietly(db);
        }
    }

    // Sample-granularity round-robin: a query re-enters the queue after
    // each unit (one warmup or one measured sample), so all workers stay
    // busy until the case's final units and measured samples run at the
    // declared concurrency. Whole-query scheduling would leave the last
    // queries running with progressively fewer active workers while their
    // samples still pooled into the declared concurrency cell.
    const pending: QueryRunState[] = queries.map((query) =>
        newQueryRunState({
            query,
            profileCase,
            sessionId: fixtureSessionId(
                query.fixtureScope.projectScope,
                query.fixtureScope.sessionScope,
            ),
            projectScope: query.fixtureScope.projectScope,
            dims: profileCase.dims,
            autoScoreThreshold: ctx.autoScoreThreshold,
            autoTimeoutMs: ctx.autoTimeoutMs,
        }),
    );
    const scenarios = new Map<string, ReportScenario>();
    const candidateRankings = new Map<string, string[]>();

    const worker = async (): Promise<void> => {
        let persistent: Database | null = null;
        const conn: ConnectionLease = {
            acquire: () => {
                if (controller.freshConnectionPerSample) {
                    return openFixtureSnapshot(fixture.snapshotPath);
                }
                if (!persistent) {
                    persistent = openFixtureSnapshot(fixture.snapshotPath);
                }
                return persistent;
            },
            release: (db) => {
                if (controller.freshConnectionPerSample) closeQuietly(db);
            },
        };
        try {
            for (;;) {
                // shift/push are synchronous, so a state is owned by exactly
                // one worker between dequeue and requeue.
                const state = pending.shift();
                if (!state) return;
                const samplingComplete = await executeQueryUnit(
                    ctx,
                    profileCase,
                    controller,
                    conn,
                    state,
                );
                if (!samplingComplete) {
                    pending.push(state);
                    continue;
                }
                const outcome = await finalizeQueryScenario(
                    ctx,
                    profileCase,
                    controller,
                    conn,
                    state,
                );
                const query = state.qctx.query;
                scenarios.set(query.id, buildScenario(ctx, profileCase, query, fixture, outcome));
                candidateRankings.set(query.id, outcome.ranked);
            }
        } finally {
            if (persistent) closeQuietly(persistent);
        }
    };

    await Promise.all(
        Array.from({ length: profileCase.concurrency }, () => worker()),
    );

    const cacheLayers = controller.finish();
    const orderedScenarios = queries
        .map((query) => scenarios.get(query.id))
        .filter((scenario): scenario is ReportScenario => scenario !== undefined);
    // R27 diagnostic summary over this case's trace-disabled samples; the
    // regression policy recomputes its percentiles from the raw samples.
    const caseSamplesMs = orderedScenarios.flatMap((scenario) => scenario.latencySamplesMs);
    let latencySummary: CaseEvidence["latencySummary"] = null;
    if (caseSamplesMs.length > 0) {
        const summary = summarizeLatency(caseSamplesMs);
        latencySummary = {
            timingPolicyVersion: summary.timingPolicyVersion,
            sampleCount: summary.sampleCount,
            p50Ms: summary.p50Ms,
            p95Ms: summary.p95Ms,
        };
    }
    // R52: lanes narrower than the mode's full source set stay diagnostic;
    // report aggregation keeps them out of gate macro-averages.
    const fullLanes: readonly SearchSource[] =
        profileCase.mode === "automatic" ? AUTO_SEARCH_SOURCES : SOURCE_FILTERS;
    const laneRestricted =
        lanes !== null && !fullLanes.every((lane) => lanes.includes(lane));
    return {
        caseId: profileCase.id,
        scenarios: orderedScenarios,
        caseEvidence: {
            caseId: profileCase.id,
            workerCount: profileCase.concurrency,
            warmups: ctx.profile.runtime.warmups,
            samplesPerQuery: ctx.profile.runtime.samples,
            fixture: {
                manifestFingerprint: fixture.manifestFingerprint,
                indexBuildMs: fixture.indexBuildMs,
                snapshotBytes: fixture.snapshotBytes,
            },
            selectivityObserved,
            cacheLayers,
            laneRestricted,
            latencySummary,
        },
        candidateRankings: queries
            .map((query) => ({
                queryId: query.id,
                ranked: candidateRankings.get(query.id) ?? [],
            }))
            .filter((entry) => entry.ranked.length > 0 || scenarios.has(entry.queryId)),
    };
}

// ---------------------------------------------------------------------------
// Run lifecycle: identity, checkpoints, resume, and report assembly.
// ---------------------------------------------------------------------------

function seedAllFixtures(
    release: ReviewedRelease,
    profile: BenchmarkProfile,
    workDir: string,
    now: () => number,
): Map<string, FixtureHandle> {
    const fixtures = new Map<string, FixtureHandle>();
    for (const profileCase of profile.cases) {
        const key = fixtureKey(profileCase.scale, profileCase.dims);
        if (fixtures.has(key)) continue;
        const syntheticProfile = release.syntheticProfiles.profiles.find(
            (candidate) => candidate.scale === profileCase.scale,
        );
        if (!syntheticProfile) {
            throw new RunnerError([`fixture ${key}: no synthetic profile for scale`]);
        }
        const fixtureDir = join(workDir, "fixtures", key);
        // Fixtures are deterministic derivations of the release, so a
        // leftover directory (interrupted run resumed with the same
        // --work-dir) is safely discarded and re-seeded; seedFixture
        // refuses to write into a non-empty directory.
        rmSync(fixtureDir, { recursive: true, force: true });
        const result: SeedResult = seedFixture(
            {
                corpus: release.corpus,
                judgments: release.judgments,
                fingerprints: {
                    corpus: release.fingerprints.corpus,
                    judgments: release.fingerprints.judgments,
                },
            },
            {
                fixtureDir,
                dims: profileCase.dims,
                synthetic: { profile: syntheticProfile },
                clock: now,
            },
        );
        fixtures.set(key, {
            key,
            dims: profileCase.dims,
            scale: profileCase.scale,
            snapshotPath: result.snapshotPath,
            manifestFingerprint: result.manifestFingerprint,
            indexBuildMs: result.evidence.indexBuildMs,
            snapshotBytes: result.evidence.snapshotBytes,
        });
    }
    return fixtures;
}

function buildSemanticConfig(
    options: RunBenchmarkOptions,
    fixtures: Map<string, FixtureHandle>,
    autoScoreThreshold: number,
    autoTimeoutMs: number,
): Record<string, unknown> {
    return {
        harness: RUNNER_VERSION,
        profileId: options.profile.id,
        profileFingerprint: profileFingerprint(options.profile),
        caseSetFingerprint: canonicalFingerprint(options.profile.cases),
        evaluationDepth: EVALUATION_DEPTH,
        autoScoreThreshold,
        autoTimeoutMs,
        warmups: options.profile.runtime.warmups,
        samplesPerQuery: options.profile.runtime.samples,
        hostClass: options.profile.host.class,
        embeddingModelId: BENCHMARK_EMBEDDING_MODEL_ID,
        instrumentation: {
            searchTraceSchemaVersion: SEARCH_TRACE_SCHEMA_VERSION,
            timingPolicyVersion: TIMING_POLICY_VERSION,
            metricPolicyVersion: METRIC_POLICY_VERSION,
            reportSchemaVersion: REPORT_SCHEMA_VERSION,
        },
        fixtures: [...fixtures.values()]
            .map((fixture) => ({
                key: fixture.key,
                scale: fixture.scale,
                dims: fixture.dims,
                manifestFingerprint: fixture.manifestFingerprint,
            }))
            .sort((a, b) => a.key.localeCompare(b.key)),
    };
}

interface RunIdentity {
    schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
    release: ReviewedRelease["fingerprints"];
    config: Record<string, unknown>;
    build: string;
    host: string;
}

function loadCheckpoints(
    checkpointDir: string,
    identityFingerprint: string,
): { completed: Map<string, CaseResultRecord>; priorAttempts: ReportAttempt[] } {
    const completed = new Map<string, CaseResultRecord>();
    const priorAttempts: ReportAttempt[] = [];
    let entries: string[];
    try {
        entries = readdirSync(checkpointDir);
    } catch {
        return { completed, priorAttempts };
    }
    if (entries.includes("run.json")) {
        let raw: {
            schemaVersion?: string;
            identityFingerprint?: string;
            attempts?: ReportAttempt[];
        };
        try {
            raw = JSON.parse(readFileSync(join(checkpointDir, "run.json"), "utf8"));
        } catch {
            throw new RunnerError(["checkpoint: unreadable run.json"]);
        }
        if (
            raw.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
            raw.identityFingerprint !== identityFingerprint
        ) {
            // AE10: resume across a different release, config, case set,
            // build, instrumentation, or host fails closed.
            throw new RunnerError(["checkpoint: incompatible-resume"]);
        }
        priorAttempts.push(...(raw.attempts ?? []));
    }
    for (const entry of entries) {
        if (!entry.startsWith("case-") || !entry.endsWith(".json")) continue;
        let raw: CheckpointCaseFile;
        try {
            raw = JSON.parse(readFileSync(join(checkpointDir, entry), "utf8"));
        } catch {
            throw new RunnerError([`checkpoint: unreadable ${entry}`]);
        }
        if (
            raw.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
            raw.identityFingerprint !== identityFingerprint
        ) {
            throw new RunnerError(["checkpoint: incompatible-resume"]);
        }
        completed.set(raw.caseId, {
            caseId: raw.caseId,
            scenarios: raw.scenarios,
            caseEvidence: raw.caseEvidence,
            candidateRankings: raw.candidateRankings,
        });
    }
    return { completed, priorAttempts };
}

export async function runBenchmark(options: RunBenchmarkOptions): Promise<RunBenchmarkResult> {
    const hooks = options.hooks ?? {};
    const now = hooks.now ?? (() => performance.now());
    const epochNow = hooks.epochNow ?? (() => Date.now());
    const cache: CacheHooks = { ...defaultCacheHooks(), ...hooks.cache };
    const autoScoreThreshold = options.autoScoreThreshold ?? DEFAULT_AUTO_SCORE_THRESHOLD;
    const autoTimeoutMs = options.autoTimeoutMs ?? DEFAULT_AUTO_TIMEOUT_MS;
    const requireOsPageEvictionProof =
        options.requireOsPageEvictionProof ?? options.profile.host.class !== "ci";

    mkdirSync(options.workDir, { recursive: true });
    const host = hooks.hostResources ?? detectHostResources(options.workDir);
    const preflight = checkHostResources(options.profile, host);
    if (!preflight.ok) throw new RunnerError([...preflight.diagnostics]);

    // The wall-time budget covers the whole attempt, eager fixture seeding
    // included — setup on a slow host consumes budget the cases no longer
    // have.
    const runStartMs = now();
    const deadlineAtMs = runStartMs + options.profile.runtime.maxWallTimeMs;

    // Fixtures are seeded eagerly for the whole case set so the semantic
    // config carries every deterministic fixture fingerprint regardless of
    // where a resume picks up.
    // ponytail: resume re-seeds all fixtures; skip fixtures whose cases are
    // all checkpointed if reference-scale resume time ever matters.
    const fixtures = seedAllFixtures(options.release, options.profile, options.workDir, now);
    const semanticConfig = buildSemanticConfig(options, fixtures, autoScoreThreshold, autoTimeoutMs);

    const identity: RunIdentity = {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        release: options.release.fingerprints,
        config: semanticConfig,
        build: `${RUNNER_VERSION}@${buildFingerprint()}`,
        host: hostFingerprint(),
    };
    const identityFingerprint = canonicalFingerprint(identity);

    let completed = new Map<string, CaseResultRecord>();
    let priorAttempts: ReportAttempt[] = [];
    if (options.checkpointDir) {
        mkdirSync(options.checkpointDir, { recursive: true });
        const loaded = loadCheckpoints(options.checkpointDir, identityFingerprint);
        completed = loaded.completed;
        priorAttempts = loaded.priorAttempts;
        atomicWrite(
            join(options.checkpointDir, "run.json"),
            canonicalJson({
                schemaVersion: CHECKPOINT_SCHEMA_VERSION,
                identityFingerprint,
                identity,
                attempts: priorAttempts,
            }),
        );
    }

    const ctx: RunContext = {
        release: options.release,
        profile: options.profile,
        now,
        deadlineAtMs,
        cache,
        autoScoreThreshold,
        autoTimeoutMs,
        requireOsPageEvictionProof,
        fixtures,
        judged: judgedGradesByQuery(options.release.judgments),
    };

    const diagnostics: string[] = [`host:${identity.host}`];
    let attemptStatus: ReportAttempt["status"] = "completed";
    const startedAtEpochMs = epochNow();

    try {
        for (const profileCase of options.profile.cases) {
            if (completed.has(profileCase.id)) continue;
            // The declared wall-time budget bounds the whole attempt; cases
            // checkpointed so far stay valid and a compatible resume
            // continues from here.
            if (now() > deadlineAtMs) {
                attemptStatus = "interrupted";
                diagnostics.push(
                    `run: wall-time budget exhausted (maxWallTimeMs=${options.profile.runtime.maxWallTimeMs})`,
                );
                break;
            }
            const record = await executeCase(ctx, profileCase);
            completed.set(profileCase.id, record);
            if (options.checkpointDir) {
                atomicWrite(
                    join(options.checkpointDir, `case-${profileCase.id}.json`),
                    canonicalJson({
                        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
                        identityFingerprint,
                        caseId: record.caseId,
                        scenarios: record.scenarios,
                        caseEvidence: record.caseEvidence,
                        candidateRankings: record.candidateRankings,
                    } satisfies CheckpointCaseFile),
                );
            }
            hooks.onCaseCheckpointed?.(profileCase.id);
        }
    } catch (error) {
        if (error instanceof RunnerInterrupt) {
            attemptStatus = "interrupted";
            diagnostics.push(
                error.message.length > 0 ? `run: ${error.message}` : "run: interrupted between cases",
            );
        } else {
            attemptStatus = "failed";
            diagnostics.push(
                ...(error instanceof RunnerError
                    ? error.diagnostics
                    : [`run: execution failure (${error instanceof Error ? error.message : String(error)})`]),
            );
        }
    }

    const attempt: ReportAttempt = {
        attemptId: `attempt-${priorAttempts.length + 1}`,
        status: attemptStatus,
        startedAtEpochMs,
        endedAtEpochMs: epochNow(),
        workingDirectory: options.workDir,
        diagnostics,
    };
    const attempts = [...priorAttempts, attempt];
    if (options.checkpointDir) {
        atomicWrite(
            join(options.checkpointDir, "run.json"),
            canonicalJson({
                schemaVersion: CHECKPOINT_SCHEMA_VERSION,
                identityFingerprint,
                identity,
                attempts,
            }),
        );
    }

    // Report assembly over profile order, retaining every attempt (R60).
    const expectedQueryIds: string[] = [];
    const scenarios: ReportScenario[] = [];
    const caseEvidences: CaseEvidence[] = [];
    const candidateByQuery = new Map<
        string,
        { queryId: string; rankings: string[][]; laneRestricted: boolean }
    >();
    for (const profileCase of options.profile.cases) {
        const caseQueries = options.release.corpus.queries.filter(
            (query) => query.mode === profileCase.mode,
        );
        for (const query of caseQueries) {
            expectedQueryIds.push(scenarioId(profileCase.id, query.id));
        }
        const record = completed.get(profileCase.id);
        if (!record) continue;
        scenarios.push(...record.scenarios);
        caseEvidences.push(record.caseEvidence);
        for (const entry of record.candidateRankings) {
            // Candidate pooling unions every eligible case's ranking: later
            // full-lane cases run different scales, dims, cache states, and
            // candidate depths, so their top-K can surface identities no
            // earlier case ranked. A lane-restricted case (R52) only stands
            // in when no full-lane case ranked the query, so the judged pool
            // reflects the full source set whenever one exists.
            const laneRestricted = record.caseEvidence.laneRestricted;
            const existing = candidateByQuery.get(entry.queryId);
            if (!existing || (existing.laneRestricted && !laneRestricted)) {
                candidateByQuery.set(entry.queryId, {
                    queryId: entry.queryId,
                    rankings: [entry.ranked],
                    laneRestricted,
                });
            } else if (existing.laneRestricted === laneRestricted) {
                existing.rankings.push(entry.ranked);
            }
        }
    }

    // Aggregation rule for the merged pool ranking: each eligible case
    // contributes at most its top-EVALUATION_DEPTH; a locator's pooled rank
    // is its best rank across cases, tie-broken by earlier case in profile
    // order, then locator text, so the merge is deterministic and keeps
    // case provenance meaningful.
    const pooledByQuery = [...candidateByQuery.values()].map((entry) => {
        const best = new Map<string, { rank: number; caseIndex: number }>();
        entry.rankings.forEach((ranked, caseIndex) => {
            for (const [rank, locator] of ranked.slice(0, EVALUATION_DEPTH).entries()) {
                const current = best.get(locator);
                if (
                    !current ||
                    rank < current.rank ||
                    (rank === current.rank && caseIndex < current.caseIndex)
                ) {
                    best.set(locator, { rank, caseIndex });
                }
            }
        });
        const ranked = [...best.entries()]
            .sort(
                (left, right) =>
                    left[1].rank - right[1].rank ||
                    left[1].caseIndex - right[1].caseIndex ||
                    (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
            )
            .map(([locator]) => locator);
        return { queryId: entry.queryId, ranked };
    });

    const candidatePool = buildCandidatePool({
        // The merged rankings are already bounded to per-case top-K unions;
        // the pool depth must cover the longest union or candidates unique
        // to later cases would fall back out of the artifact.
        topK: Math.max(EVALUATION_DEPTH, ...pooledByQuery.map((entry) => entry.ranked.length)),
        queries: pooledByQuery.map((entry) => {
            const query = options.release.corpus.queries.find(
                (candidate) => candidate.id === entry.queryId,
            );
            if (!query) throw new RunnerError([`candidate pool: unknown query ${entry.queryId}`]);
            return {
                queryId: entry.queryId,
                ranked: entry.ranked,
                resolved: resolveRankedLocators(
                    entry.ranked,
                    query.fixtureScope,
                    options.release.aliasIndex,
                ),
                judgedGrades: ctx.judged.get(entry.queryId) ?? new Map<string, JudgedGrade>(),
            };
        }),
    });

    const status = computeReportStatus({ expectedQueryIds, scenarios, attempts });
    const report = parseReport({
        schemaVersion: REPORT_SCHEMA_VERSION,
        status,
        semantic: {
            metricPolicyVersion: METRIC_POLICY_VERSION,
            timingPolicyVersion: TIMING_POLICY_VERSION,
            releaseFingerprints: options.release.fingerprints,
            config: semanticConfig,
        },
        evidence: { attempts, scenarios, cases: caseEvidences },
        candidatePool,
    });

    return {
        report,
        semanticFingerprint: semanticFingerprint(report),
        evidenceDigest: evidenceDigest(report),
        candidatePool,
        diagnostics,
    };
}
