/**
 *
 * The runner executes each profile case against a reviewed release.
 * The runner seeds production-shaped fixture snapshots before execution.
 * The runner exercises the explicit and automatic retrieval surfaces for every enumerated case.
 * The runner produces one strictly validated report.
 *
 * Contract highlights:
 * Policy latency uses trace-disabled external root timing.
 * A paired trace-enabled pass provides stage decomposition.
 * Trace-enabled passes do not contribute latency samples.
 * Concurrency uses a fixed worker count.
 * Each worker uses its own read-only connection.
 * Each worker issues its next query only after its previous query completes.
 * The runner tracks process-vector, connection/prepared-statement, SQLite-page, and OS-page caches separately.
 * The runner records reset/hit evidence for every cache layer on every sample.
 * A cache-layer transition within a case rejects that case.
 * The runner commits every completed case as an atomic canonical-JSON checkpoint.
 * Resume requires identical release, config, case-set, build, instrumentation, and host identities.
 * Resume fails closed when any required identity differs.
 * A missing required cell leaves the run incomplete.
 *   silently shrunk.
 *
 * Only this module and the seeder import production execution adapters.
 * Pure contract modules use DTOs.
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
    invalidateMemoryVectorCache,
    peekMemoryVectorCache,
    primeMemoryVectorCache,
} from "./memory-vector-store";
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
import { encodePhysicalResultLocator } from "./physical-locator";
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
    buildCorpusTokenWeights,
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

/**
 * */
const BUILD_SOURCE_DIRS = [
    "scripts/retrieval-benchmark",
    "src/features/magic-context",
    "src/hooks/magic-context",
    "src/tools/ctx-search",
    "src/shared",
] as const;
const BUILD_SOURCE_FILES = ["scripts/benchmark-retrieval.ts"] as const;
/**
 * */
const BUILD_DEPENDENCY_FILES = ["bun.lock", "packages/plugin/package.json"] as const;

let cachedBuildFingerprint: string | null = null;

/**
 * */
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

/**
 * */
export const EVALUATION_DEPTH = MAX_SEARCH_RESULT_LIMIT;

/**
 * */
const DEFAULT_AUTO_SCORE_THRESHOLD = 0.15;
const DEFAULT_AUTO_TIMEOUT_MS = 3_000;
const CONSERVATION_TOLERANCE_MS = 1e-6;

export class RunnerError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: string[]) {
        super(diagnostics.join("; "));
        this.diagnostics = diagnostics;
    }
}

/* */
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
    /** `now` must be monotonic because samples, traces, and seed timing measure elapsed durations. */
    now?: () => number;
    /** `epochNow` records wall-clock attempt timestamps; elapsed measurements use `now`. */
    epochNow?: () => number;
    cache?: Partial<CacheHooks>;
    /** Tests throw `RunnerInterrupt` after each case checkpoint commits to simulate a host interruption between cases.
     * */
    onCaseCheckpointed?: (caseId: string) => void;
    /** `hostResources` overrides preflight host detection; otherwise the runner uses the actual host. */
    hostResources?: HostResources;
}

export interface RunBenchmarkOptions {
    release: ReviewedRelease;
    profile: BenchmarkProfile;
    /** The runner uses `workDir` for per-invocation fixture databases. */
    workDir: string;
    /** `checkpointDir` enables atomic case commits and compatible resume; omitting it runs without checkpoints.
     * */
    checkpointDir?: string;
    autoScoreThreshold?: number;
    autoTimeoutMs?: number;
    /** `requireOsPageEvictionProof` defaults to `profile.host.class !== "ci"`; reference hosts require proof and CI records a not-attempted layer.
     * */
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
    /** The candidate pool stores an evaluation-depth ranking for each raw query ID. */
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
        invalidateProcessVector: (projectScope) => invalidateMemoryVectorCache(projectScope),
        peekProcessVector: (projectScope, modelId) => peekMemoryVectorCache(projectScope, modelId),
        primeProcessVector: (db, projectScope, modelId) => {
            primeMemoryVectorCache(db, projectScope, modelId);
        },
        // Controlled hosts must supply a privileged OS cache-eviction mechanism; CI records the layer as not attempted.
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
        // When `statfs` is unavailable, preflight still checks memory.
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
        // The runtime version participates in host identity because latency results from different runtimes are not comparable.
        runtime: typeof Bun !== "undefined" ? `bun/${Bun.version}` : `node/${process.version}`,
        // `hostname` participates in host identity so exact-host latency checks reject reports from different hostnames.
        hostname: hostname(),
    });
}

function atomicWrite(path: string, text: string): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Cache-layer lifecycle.
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
    /**
     * */
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
        if (state.connectionStatement !== state.sqlitePage) {
            throw new RunnerError([
                `case ${profileCase.id}: connectionStatement and sqlitePage states must agree in-process`,
            ]);
        }
        // With concurrency > 1, another worker can repopulate the shared processVector cache between invalidation and measurement, so cold samples require one worker.
        if (state.processVector === "cold" && profileCase.concurrency > 1 && ctx.memoryLaneActive) {
            throw new RunnerError([
                `case ${profileCase.id}: cold processVector requires concurrency 1 (a concurrent worker can re-warm the shared process cache between invalidate and sample)`,
            ]);
        }
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

    /** The runner invokes the reset hook once per measured sample, immediately after opening its connection.
     * Warmups, the evaluation pass, and the traced diagnostic pass also open connections.
     * The runner records reset evidence only for measured samples. */
    measuredConnectionOpened(): void {
        if (this.freshConnectionPerSample) {
            this.layers[1].resets += 1;
            this.layers[2].resets += 1;
        }
    }

    beforeSample(queryTouchesMemory: boolean): void {
        // Warmups and earlier samples repopulate the OS page cache.
        // Cold osPage cases evict the OS page cache before every measured sample.
        // Evicting only at case start does not preserve a cold OS page cache.
        this.evictOsPageIfCold();
        if (this.processVector.status === "not-applicable") return;
        if (this.processVector.declared === "cold") {
            this.cache.invalidateProcessVector(this.ctx.projectScope);
            this.processVector.resets += 1;
            return;
        }
        if (queryTouchesMemory) this.warmVerifyDue = true;
    }

    /** warmSampleReady runs after a connection is available and before timing begins.
     * The production embedding cache expires entries after TTL without extending expiry on hits.
     * Cases that outlive TTL must re-prime the embedding cache to preserve warm state.
     * Without re-priming, the embedding-cache warm-state check can fail mid-case. */
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
    /** Queries and seeded documents must use the same corpus-content IDF weights to share a token-weight space.
     * */
    tokenWeights: ReadonlyMap<string, number>;
    observedEmbedPurposes: Set<"query" | "passage">;
}

function effectiveSources(ctx: QueryExecutionContext): SearchSource[] | undefined {
    const base: readonly SearchSource[] | null =
        ctx.query.mode === "automatic" ? AUTO_SEARCH_SOURCES : ctx.query.sourceFilters;
    // The measured search must run under the declared predicate.
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
        // The production automatic path searches all indexed history.
        // The runner rejects predicates that narrow indexed history because the production automatic path cannot execute them.
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
        // A raw Float32Array bypasses the generation contract because the benchmark project is never registered in the project embedding registry.
        // The purpose argument does not change the returned vector.
        // Reports that differ only in purpose remain quality-comparable.
        embedQuery: async (text, _signal, purpose) => {
            ctx.observedEmbedPurposes.add(purpose ?? "passage");
            return deterministicTextVector(text, dims, ctx.tokenWeights);
        },
        isEmbeddingRuntimeEnabled: () => true,
        candidateDepth: ctx.profileCase.candidateK.effective,
        ...overrides,
    };
    const sources = effectiveSources(ctx);
    if (sources !== undefined) options.sources = sources;
    const cutoff = effectiveMessageCutoff(ctx);
    if (cutoff !== undefined) options.maxMessageOrdinal = cutoff;
    return options;
}

/**
 * A search failure propagates as a thrown error. */
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
            // `packNowMs` uses `referenceTimeMs` so the same fingerprinted scenario renders identical age strings and token counts on different days.
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

/** The evaluation uses fused ranking at the evaluation depth and widens only the returned-result limit to the production ceiling.
 * */
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
    /** The deadline is an absolute now()-domain instant when the attempt's wall-time budget, including seeding, expires; sample loops check it between samples.
     * */
    deadlineAtMs: number;
    cache: CacheHooks;
    autoScoreThreshold: number;
    autoTimeoutMs: number;
    requireOsPageEvictionProof: boolean;
    fixtures: Map<string, FixtureHandle>;
    judged: Map<string, ReadonlyMap<string, JudgedGrade>>;
    tokenWeights: ReadonlyMap<string, number>;
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
    qctx: QueryExecutionContext,
    fixture: FixtureHandle,
    outcome: {
        ranked: string[];
        delivery: DeliveryOutcome;
        latencySamplesMs: number[];
        tracedSpans: SearchTraceSpan[];
    },
): ReportScenario {
    const query = qctx.query;
    const scope: ScenarioScope = query.fixtureScope;
    const judgedGrades = ctx.judged.get(query.id) ?? new Map<string, JudgedGrade>();
    const resolved = resolveRankedLocators(outcome.ranked, scope, ctx.release.aliasIndex);
    const deliveredLocators = outcome.delivery.delivered.map(encodePhysicalResultLocator);
    const deliveredResolved = resolveRankedLocators(
        deliveredLocators,
        scope,
        ctx.release.aliasIndex,
    );
    // Automatic-mode quality uses the thresholded `executeAutoSearchDelivery` outcome.
    // A score change that pushes every result below `autoScoreThreshold` is a quality regression even when it preserves ranking.
    const metricResolved = query.mode === "automatic" ? deliveredResolved : resolved;
    const queryMetrics = computeQueryMetrics({
        queryId: query.id,
        resolved: metricResolved,
        judgedGrades,
    });
    const values = scoredQueryValues(queryMetrics);
    const at50 = queryMetrics.cutoffs.find((cutoff) => cutoff.cutoff === 50);
    if (!at50) throw new RunnerError([`query ${query.id}: missing depth-50 metrics window`]);

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

    const observedPurposes = [...qctx.observedEmbedPurposes].sort();
    if (observedPurposes.length > 1) {
        throw new RunnerError([
            `query ${query.id}: mixed embed purposes observed (${observedPurposes.join(", ")})`,
        ]);
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
        queryEmbedPurpose: observedPurposes[0] ?? null,
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

/** The case scheduler gives each query state to one worker for each warmup or sample, so these fields need no lock.
 * */
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

/**
 * Warmups and connection primers finish before any measured sample is scheduled. */
async function executeWarmupUnit(
    ctx: RunContext,
    profileCase: ProfileCase,
    conn: ConnectionLease,
    state: QueryRunState,
): Promise<boolean> {
    checkCaseDeadline(ctx, profileCase);
    const db = conn.acquire();
    try {
        await executeDelivery(db, state.qctx);
    } finally {
        conn.release(db);
    }
    state.warmupsDone += 1;
    return state.warmupsDone >= ctx.profile.runtime.warmups;
}

/**
 * The case scheduler interleaves queries by sample to maintain declared concurrency until no samples remain.
 * Whole-query scheduling would let the case tail run below the declared concurrency.
 * Whole-query scheduling would pool below-load tail samples into the declared concurrency cell.
 * */
async function executeSampleUnit(
    ctx: RunContext,
    profileCase: ProfileCase,
    controller: CaseCacheController,
    conn: ConnectionLease,
    state: QueryRunState,
): Promise<boolean> {
    checkCaseDeadline(ctx, profileCase);
    const { qctx, queryTouchesMemory } = state;

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
    // Measured samples must have the same delivery reason; otherwise intermittent timeouts could report a normal delivery.
    if (state.firstDelivery === null) {
        state.firstDelivery = delivery;
    } else if (delivery.reason !== state.firstDelivery.reason) {
        throw new RunnerError([
            `query ${qctx.query.id}: measured delivery outcomes disagree (sample 1: ${state.firstDelivery.reason}, sample ${state.latencySamplesMs.length}: ${delivery.reason})`,
        ]);
    }
    return state.latencySamplesMs.length >= ctx.profile.runtime.samples;
}

/** Evaluation and traced-diagnostic passes run after the last measured sample and are not latency-policy samples.
 * */
async function finalizeQueryScenario(
    ctx: RunContext,
    profileCase: ProfileCase,
    controller: CaseCacheController,
    conn: ConnectionLease,
    state: QueryRunState,
): Promise<QueryScenarioOutcome> {
    // The wall-time budget applies to diagnostics; otherwise slow evaluation could run arbitrarily beyond it.
    checkCaseDeadline(ctx, profileCase);
    const { qctx, queryTouchesMemory } = state;
    if (!state.lastDelivery) {
        throw new RunnerError([`query ${qctx.query.id}: no measured sample`]);
    }

    // Each diagnostic pass re-establishes a cold cell's declared cache state because the last measured sample leaves every cache layer warm.
    // A warm process cache lets selectSemanticCandidates widen evaluation ranking beyond the lexical subset.
    // Without re-establishing cold state, stage decomposition would describe a warm execution.
    controller.beforeSample(queryTouchesMemory);
    const evalDb = conn.acquire();
    let ranked: string[];
    try {
        controller.warmSampleReady(evalDb, queryTouchesMemory);
        ranked = await executeEvaluation(evalDb, qctx);
    } finally {
        conn.release(evalDb);
    }

    // The paired trace-enabled diagnostic pass provides stage decomposition only and is not a latency-policy sample.
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

    // Selectivity cells execute through the production message index.
    // Observed cardinalities must match the declared recipe.
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
    // Each query runs under its own fixture scope because scope is the predicate field the executed search cannot merge.
    // A scope mismatch means preflight validated cardinalities for a workload that no query executes.
    // measureMessageSelectivity resolves a null session scope to the concrete fallback session, not a wildcard.
    for (const query of queries) {
        const scopeMismatch =
            predicate.projectScope !== query.fixtureScope.projectScope ||
            predicate.sessionScope !== query.fixtureScope.sessionScope;
        if (scopeMismatch) {
            throw new RunnerError([
                `case ${profileCase.id}: query ${query.id} fixture scope does not match the selectivity predicate scope`,
            ]);
        }
    }
    // The lane axis and predicate sources both narrow the effective execution set.
    // Cache setup and evidence must describe the final effective set.
    // Otherwise, a warm case could prime a memory cache that no executed search can touch.
    const lanes = profileCase.sourceLanes;
    const caseSources = profileCase.selectivity.predicate.sources;
    const laneExecutes = (lane: SearchSource): boolean =>
        (lanes === null || lanes.includes(lane)) &&
        (caseSources === null || caseSources.includes(lane));
    const memoryLaneActive =
        laneExecutes("memory") &&
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

    // Barrier phases prevent measured samples from competing with priming, warmups, evaluation, or traced diagnostics.
    const states: QueryRunState[] = queries.map((query) =>
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
            tokenWeights: ctx.tokenWeights,
            observedEmbedPurposes: new Set(),
        }),
    );
    const scenarios = new Map<string, ReportScenario>();
    const candidateRankings = new Map<string, string[]>();

    const makeWorkerConn = (): { conn: ConnectionLease; close: () => void } => {
        let persistent: Database | null = null;
        return {
            conn: {
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
            },
            close: () => {
                if (persistent) closeQuietly(persistent);
            },
        };
    };

    // Workers share one ConnectionLease set across phases; persistent connections retain phase-1 warming for phase 2.
    const workerConns = Array.from({ length: profileCase.concurrency }, () => makeWorkerConn());
    // Promise.allSettled waits for every worker before propagating a rejection, so cleanup cannot close connections still in use.
    const runPhase = async (worker: (conn: ConnectionLease) => Promise<void>): Promise<void> => {
        const results = await Promise.allSettled(workerConns.map(({ conn }) => worker(conn)));
        const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) throw failure.reason;
    };

    try {
        // Query warmups prime shared caches. When connections persist, each worker primes its own connection with one untimed delivery.
        const warming: QueryRunState[] =
            ctx.profile.runtime.warmups > 0 ? [...states] : [];
        await runPhase(async (conn) => {
            if (!controller.freshConnectionPerSample && states.length > 0) {
                const primer = states[0];
                const db = conn.acquire();
                try {
                    await executeDelivery(db, primer.qctx);
                } finally {
                    conn.release(db);
                }
            }
            for (;;) {
                // Synchronous shift and push give each state exactly one worker owner between dequeue and requeue.
                const state = warming.shift();
                if (!state) return;
                const warmupsComplete = await executeWarmupUnit(ctx, profileCase, conn, state);
                if (!warmupsComplete) warming.push(state);
            }
        });

        const sampling: QueryRunState[] = [...states];
        const readyToFinalize: QueryRunState[] = [];
        await runPhase(async (conn) => {
            for (;;) {
                const state = sampling.shift();
                if (!state) return;
                const samplingComplete = await executeSampleUnit(
                    ctx,
                    profileCase,
                    controller,
                    conn,
                    state,
                );
                if (samplingComplete) {
                    readyToFinalize.push(state);
                } else {
                    sampling.push(state);
                }
            }
        });

        await runPhase(async (conn) => {
            for (;;) {
                const state = readyToFinalize.shift();
                if (!state) return;
                const outcome = await finalizeQueryScenario(
                    ctx,
                    profileCase,
                    controller,
                    conn,
                    state,
                );
                const query = state.qctx.query;
                scenarios.set(
                    query.id,
                    buildScenario(ctx, profileCase, state.qctx, fixture, outcome),
                );
                candidateRankings.set(query.id, outcome.ranked);
            }
        });
    } finally {
        for (const { close } of workerConns) close();
    }

    const cacheLayers = controller.finish();
    const orderedScenarios = queries
        .map((query) => scenarios.get(query.id))
        .filter((scenario): scenario is ReportScenario => scenario !== undefined);
    // The diagnostic summary uses this case's trace-disabled samples; regression percentiles are recomputed from raw samples.
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
    // Lanes narrower than the final effective source set remain diagnostic and are excluded from gate macro-averages.
    const fullLanes: readonly SearchSource[] =
        profileCase.mode === "automatic" ? AUTO_SEARCH_SOURCES : SOURCE_FILTERS;
    const predicateSources = profileCase.selectivity.predicate.sources;
    const effectiveLanes: readonly SearchSource[] | null =
        predicateSources === null
            ? lanes
            : lanes === null
              ? predicateSources
              : lanes.filter((lane) => predicateSources.includes(lane));
    const laneRestricted =
        effectiveLanes !== null && !fullLanes.every((lane) => effectiveLanes.includes(lane));
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
        // Because fixtures are deterministic release derivations, a leftover --work-dir is discarded and re-seeded.
        // seedFixture rejects non-empty directories.
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

    // The wall-time budget includes eager fixture seeding.
    // Setup on a slow host reduces the time available to cases.
    // have.
    const runStartMs = now();
    const deadlineAtMs = runStartMs + options.profile.runtime.maxWallTimeMs;

    // Fixtures are seeded eagerly so the semantic config includes every fixture fingerprint.
    // The semantic config includes every deterministic fixture fingerprint regardless of resume position.
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
        tokenWeights: buildCorpusTokenWeights(options.release.corpus.documents),
    };

    const diagnostics: string[] = [`host:${identity.host}`];
    let attemptStatus: ReportAttempt["status"] = "completed";
    const startedAtEpochMs = epochNow();

    try {
        for (const profileCase of options.profile.cases) {
            if (completed.has(profileCase.id)) continue;
            // Checkpointed cases remain valid for a compatible resume.
            // A compatible resume runs the remaining cases.
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
            // Candidate pooling merges rankings from every eligible case because later full-lane cases can rank candidates that earlier cases did not.
            // Full-lane cases can use different scales, dimensions, cache states, and candidate depths.
            // A lane-restricted case contributes only when no full-lane case ranked the query.
            // The judged pool uses full-lane rankings whenever any full-lane case ranked the query.
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

    // Each eligible case contributes at most EVALUATION_DEPTH results to the merged pool.
    // A locator's pooled rank is its best rank across cases.
    // Ties use case order, then locator text, making the merge deterministic.
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
        // The pool depth must cover the longest per-case top-K union.
        // Otherwise, candidates unique to later cases would be omitted from the artifact.
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
