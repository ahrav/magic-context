/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { replaceAllCompartmentState } from "../features/magic-context/compartment-storage";
import { FORK_MIGRATION_VERSION_FLOOR } from "../features/magic-context/migrations";
import {
    getPersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
} from "../features/magic-context/storage-db";
import { createDirectTestDatabase } from "../features/magic-context/test-database";
import { createLiveSessionState } from "../hooks/magic-context/live-session-state";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import { unavailable } from "../shared/kernel-client";
import { FakeKernel } from "../shared/kernel-client-testing/fake-kernel";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../shared/models-dev-cache";
import { formatMemoryCount } from "../shared/rpc-types";
import type { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import {
    BoundedTtlCache,
    buildSidebarSnapshot,
    buildSidebarSnapshotRpcResponse,
    buildStatusDetail,
} from "./rpc-handlers";
import { resetSidebarSnapshotCache } from "./sidebar-snapshot-cache";

function createTestDb(): Database {
    const db = createDirectTestDatabase().db;
    return db;
}

afterEach(() => {
    resetSidebarSnapshotCache();
    clearModelsDevCache();
});

describe("sidebar snapshot RPC failures", () => {
    test("returns an error envelope when snapshot construction hits SQLITE_BUSY", () => {
        const busyDb = {
            prepare() {
                const error = new Error("database is locked") as Error & { code?: string };
                error.code = "SQLITE_BUSY";
                throw error;
            },
        } as unknown as Database;

        expect(buildSidebarSnapshotRpcResponse(busyDb, "ses_busy", process.cwd())).toEqual({
            error: "sidebar snapshot unavailable",
        });
    });
});

describe("buildStatusDetail — storage version probe", () => {
    test("reports the upstream lane when fork rows share context.db", () => {
        const db = createTestDb();
        try {
            db.prepare(
                "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?), (?, ?, ?)",
            ).run(
                FORK_MIGRATION_VERSION_FLOOR,
                "fork migration 10000",
                0,
                FORK_MIGRATION_VERSION_FLOOR + 1,
                "fork migration 10001",
                0,
            );

            const detail = buildStatusDetail(db, "ses-storage-version", process.cwd());

            expect(detail.storage_versions).toEqual({
                context_db_schema_version: LATEST_SUPPORTED_VERSION,
                plugin_supported_version: LATEST_SUPPORTED_VERSION,
            });
            expect(detail.loggerDiagnostics).toEqual({
                swallowedWriteCount: 0,
                lastErrorMessage: null,
                lastErrorTime: null,
            });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — stale build error state", () => {
    test("surfaces the persisted stale-build failure in the sidebar snapshot", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-stale-build";
            db.prepare(
                "INSERT INTO session_meta (session_id, last_transform_error) VALUES (?, ?)",
            ).run(
                sessionId,
                "Magic Context: plugin build is older than its database — restart OpenCode",
            );

            const snapshot = buildSidebarSnapshot(db, sessionId, process.cwd());

            expect(snapshot.lastTransformError).toBe(
                "Magic Context: plugin build is older than its database — restart OpenCode",
            );
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — persisted tail hygiene", () => {
    test("preserves zero-valued TypeScript baseline fields in the RPC payload", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-hygiene-zero";
            const live = createLiveSessionState();
            live.channel1StateBySession.set(sessionId, {
                baselineU: 0,
                baselineT: 0,
                turnDeltaU: 0,
                turnDeltaT: 0,
                baselineGeneration: 0,
                computedAt: 0,
                evaluable: true,
                generationInvalidated: false,
                baselineParts: [],
                contentSignature: "empty",
                reducedSinceRefresh: false,
                oldestReclaimableToolTags: [],
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, process.cwd(), live);

            expect(snapshot.tailHygiene).toEqual({
                u: 0,
                t: 0,
                severity: 0,
                evaluable: true,
                generationInvalidated: false,
                baselineGeneration: 0,
                computedAt: 0,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("prefers the durable Rust baseline when module authority is active", () => {
        const db = createTestDb();
        try {
            const snapshot = buildSidebarSnapshot(
                db,
                "ses-hygiene-rust",
                process.cwd(),
                createLiveSessionState(),
                undefined,
                undefined,
                {
                    tail_hygiene: {
                        u: 65_100,
                        t: 100_000,
                        severity: 0.651,
                        evaluable: true,
                        generation_invalidated: false,
                        baseline_generation: 7,
                        computed_at_ms: 123,
                    },
                },
            );

            expect(snapshot.tailHygiene).toEqual({
                u: 65_100,
                t: 100_000,
                severity: 0.651,
                evaluable: true,
                generationInvalidated: false,
                baselineGeneration: 7,
                computedAt: 123,
            });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — memory tokens fallback (bug #1)", () => {
    test("reports the kernel's row count and state next to the rendered block count", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-1";
            const directory = process.cwd();
            const kernel = new FakeKernel();
            kernel.seedDecision({
                object_id: `mem_${"a".repeat(32)}`,
                decision_kind: "PROJECT_RULES",
                summary: "Always use Bun for builds",
            });
            kernel.seedDecision({
                object_id: `mem_${"b".repeat(32)}`,
                decision_kind: "ARCHITECTURE",
                summary: "OpenCode source lives at ~/Work/OSS/opencode.",
            });
            // The sidebar count excludes decisions outside the memory domain.
            kernel.seedDecision({
                object_id: `mem_${"c".repeat(32)}`,
                decision_kind: "ARCHITECTURE",
                summary: "A foreign-domain decision.",
                domain_id: "notes",
            });

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 50000, 25, 5000, '', 2)`,
            ).run(sessionId);

            const snapshot = buildSidebarSnapshot(
                db,
                sessionId,
                directory,
                undefined,
                kernel.snapshot("explicit_search"),
            );
            expect(snapshot.memoryBlockCount).toBe(2);
            expect(snapshot.memoryCount).toBe(2);
            expect(snapshot.memoryState).toBe("available");
            // Without a rendered m[0], no memory block was paid for this pass.
            expect(snapshot.memoryTokens).toBe(0);

            const absent = buildSidebarSnapshot(db, sessionId, directory, undefined, {
                state: unavailable("daemon_absent"),
                rows: [],
                knownAsOf: null,
            });
            expect(absent.memoryCount).toBe(0);
            expect(absent.memoryState).toBe("unavailable:daemon_absent");
        } finally {
            closeQuietly(db);
        }
    });

    test("a truncated read flags the count as a lower bound and status formats it approximate", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-truncated";
            const directory = process.cwd();
            const kernel = new FakeKernel();
            kernel.seedDecision({
                object_id: `mem_${"a".repeat(32)}`,
                decision_kind: "PROJECT_RULES",
                summary: "Always use Bun for builds",
            });
            kernel.readTruncated = true;

            const snapshot = buildSidebarSnapshot(
                db,
                sessionId,
                directory,
                undefined,
                kernel.snapshot("explicit_search"),
            );
            expect(snapshot.memoryCount).toBe(1);
            expect(snapshot.memoryTruncated).toBe(true);
            expect(formatMemoryCount(snapshot)).toBe("1+");

            kernel.readTruncated = false;
            const complete = buildSidebarSnapshot(
                db,
                "ses-complete",
                directory,
                undefined,
                kernel.snapshot("explicit_search"),
            );
            expect(complete.memoryTruncated).toBeUndefined();
            expect(formatMemoryCount(complete)).toBe("1");
        } finally {
            closeQuietly(db);
        }
    });

    test("falls back to 0 when cache is empty AND memory_block_count is 0 (truly nothing to render)", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-2";
            const directory = process.cwd();

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 0, 0, 0, '', 0)`,
            ).run(sessionId);

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, undefined);
            expect(snapshot.memoryBlockCount).toBe(0);
            expect(snapshot.memoryTokens).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("omits retired factCount from the RPC sidebar payload", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-no-fact-count";
            const directory = process.cwd();
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 50000, 25, 5000, '', 0)`,
            ).run(sessionId);

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, undefined);
            expect(Object.hasOwn(snapshot as object, "factCount")).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("memory bucket measures the <project-memory> slice ACTUALLY in m[0] (v2 wire), not memory_block_cache", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-3";
            const directory = process.cwd();
            // m[0] carries the compact v2 category-grouped render.
            const m0 =
                "<session-history>\n</session-history>\n\n" +
                "<project-memory>\n<ARCHITECTURE>\n#1: a durable architectural fact about the system\n</ARCHITECTURE>\n</project-memory>";
            // The token calculation ignores memory_block_cache because it stores the legacy v1 shape.
            // The token bucket ignores memory_block_cache because it under-counts the injected cost.
            const v1Cache = "<project-memory>\n- a durable architectural fact\n</project-memory>";

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count, cached_m0_bytes
                ) VALUES (?, 50000, 25, 5000, ?, 1, ?)`,
            ).run(sessionId, v1Cache, Buffer.from(m0, "utf8"));

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, undefined);
            expect(snapshot.memoryBlockCount).toBe(1);
            // Tokens come from the actual m[0] v2 slice, not the stale cache.
            const v2SliceTokens = snapshot.memoryTokens;
            expect(v2SliceTokens).toBeGreaterThan(0);
            expect(
                estimateTokens(m0.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0] ?? ""),
            ).toBe(v2SliceTokens);
            expect(v2SliceTokens).not.toBe(estimateTokens(v1Cache));
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — context limit", () => {
    test("keeps native full-window usage distinct from the reserved budget metric", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-native-full-window";
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 120000, 80, 0, '', 0)`,
            ).run(sessionId);
            await refreshModelLimitsFromApi({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: "test-provider",
                                    models: {
                                        "reserved-model": {
                                            limit: { context: 200_000, output: 64_000 },
                                        },
                                    },
                                },
                            ],
                        },
                    }),
                },
            });
            const live = createLiveSessionState();
            live.liveModelBySession.set(sessionId, {
                providerID: "test-provider",
                modelID: "reserved-model",
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, process.cwd(), live, undefined);

            // Output reserve is capped at 25%: 200K raw -> 150K safe input.
            expect(snapshot.contextLimit).toBe(150_000);
            expect(snapshot.usagePercentage).toBe(80);
            expect(snapshot.native_context_usage_percentage).toBe(60);
            expect(snapshot.native_context_usage_percentage).not.toBe(snapshot.usagePercentage);
        } finally {
            closeQuietly(db);
        }
    });

    test("populates contextLimit from the active session model", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-context-limit";
            const directory = process.cwd();
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 80000, 40, 5000, '', 0)`,
            ).run(sessionId);
            await refreshModelLimitsFromApi({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: "test-provider",
                                    models: {
                                        "test-model": { limit: { context: 200_000 } },
                                    },
                                },
                            ],
                        },
                    }),
                },
            });
            const live = createLiveSessionState();
            live.liveModelBySession.set(sessionId, {
                providerID: "test-provider",
                modelID: "test-model",
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, live, undefined);

            expect(snapshot.contextLimit).toBe(200_000);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — Rust module status merge", () => {
    test("uses module pressure, boundary, coverage, and compartment counts", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-rust-status";
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 1, 1, 5000, '', 0)`,
            ).run(sessionId);

            const snapshot = buildSidebarSnapshot(
                db,
                sessionId,
                process.cwd(),
                undefined,
                undefined,
                undefined,
                {
                    usage: {
                        current_total_input_tokens: 42_000,
                        context_limit_tokens: 100_000,
                    },
                    boundary_present: true,
                    coverage_ordinal: 17,
                    compartment_count: 4,
                    compartment_tokens: 23,
                    pending_drop_count: 2,
                },
            );

            expect(snapshot.inputTokens).toBe(42_000);
            expect(snapshot.usagePercentage).toBe(42);
            expect(snapshot.contextLimit).toBe(100_000);
            expect(snapshot.compartmentCount).toBe(4);
            expect(snapshot.compartmentTokens).toBe(23);
            expect(snapshot.pendingOpsCount).toBe(2);
            expect(snapshot.boundaryPresent).toBe(true);
            expect(snapshot.coverageOrdinal).toBe(17);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("compaction-off sidebar RPC data", () => {
    test("reports the resolved mode and raw native usage independently of threshold fill", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-native-sidebar";
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_count
                ) VALUES (?, 63077, 97, 0, 0)`,
            ).run(sessionId);
            replaceAllCompartmentState(
                db,
                sessionId,
                [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 4,
                        startMessageId: "msg-1",
                        endMessageId: "msg-4",
                        title: "Archived",
                        content: "Historical context retained for later expansion.",
                    },
                ],
                [],
            );

            const snapshot = buildSidebarSnapshot(
                db,
                sessionId,
                process.cwd(),
                undefined,
                undefined,
                { execute_threshold_percentage: 65 },
                {
                    usage: {
                        current_total_input_tokens: 41_000,
                        context_limit_tokens: 100_000,
                    },
                },
                false,
            );
            const detail = buildStatusDetail(
                db,
                sessionId,
                process.cwd(),
                undefined,
                { execute_threshold_percentage: 65 },
                undefined,
                undefined,
                {
                    usage: {
                        current_total_input_tokens: 41_000,
                        context_limit_tokens: 100_000,
                    },
                },
                false,
            );
            const thresholdFillPercentage = (41_000 / (100_000 * 0.65)) * 100;

            expect(snapshot.compaction_enabled).toBe(false);
            expect(detail.compaction_enabled).toBe(false);
            expect(snapshot.native_context_usage_percentage).toBe(41);
            expect(detail.native_context_usage_percentage).toBe(41);
            expect(snapshot.native_context_usage_percentage).not.toBeCloseTo(
                thresholdFillPercentage,
            );
            expect(snapshot.archivedCompartmentCount).toBe(1);

            const enabledDetail = buildStatusDetail(db, "ses-native-sidebar-on", process.cwd());
            expect(enabledDetail.compaction_enabled).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — history token reuse (council audit bg_51106601 #1)", () => {
    test("sets historyBlockTokens from compartmentTokens only (facts retired in v2)", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-history-tokens";
            const directory = process.cwd();

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, conversation_tokens
                ) VALUES (?, 50000, 25, 5000, 0)`,
            ).run(sessionId);
            replaceAllCompartmentState(
                db,
                sessionId,
                [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 4,
                        startMessageId: "msg-1",
                        endMessageId: "msg-4",
                        title: "Setup",
                        content: "User configured the project and installed dependencies.",
                    },
                    {
                        sequence: 1,
                        startMessage: 5,
                        endMessage: 8,
                        startMessageId: "msg-5",
                        endMessageId: "msg-8",
                        title: "Implementation",
                        content: "Assistant implemented the requested performance fix.",
                    },
                ],
                [
                    { category: "preference", content: "Use Bun for plugin commands." },
                    { category: "environment", content: "The workspace is a git repository." },
                ],
            );

            const detail = buildStatusDetail(db, sessionId, directory);

            // In v2, facts are promoted to memories and no longer supply rendered content.
            // In v2, factTokens is 0, and <session-history> renders only compartments.
            // In v2, facts no longer contribute to rendered <session-history> bytes.
            expect(detail.compartmentTokens).toBeGreaterThan(0);
            expect(detail.factTokens).toBe(0);
            expect(detail.historyBlockTokens).toBe(detail.compartmentTokens);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — storage versions probe", () => {
    test("reports the live context.db schema version and the plugin fence", () => {
        const db = createTestDb();
        try {
            const detail = buildStatusDetail(db, "ses-storage-versions", process.cwd());

            // The probe uses the live MAX(schema_migrations) value and this build's fence.
            // A fully migrated test database has MAX(schema_migrations) equal to the fence.
            expect(detail.storage_versions.context_db_schema_version).toBe(
                getPersistedSchemaVersion(db),
            );
            expect(detail.storage_versions.plugin_supported_version).toBe(LATEST_SUPPORTED_VERSION);
            expect(detail.storage_versions.context_db_schema_version).toBe(
                LATEST_SUPPORTED_VERSION,
            );
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — cacheNeverExpires with 'never' TTL", () => {
    test("sets cacheNeverExpires: true when cache_ttl is 'never'", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-never";
            const directory = process.cwd();

            // The test force-creates the session meta row so the UPDATE lands on an existing row.
            db.prepare(`INSERT INTO session_meta (session_id) VALUES (?)`).run(sessionId);
            // The test seeds last_response_time because cacheNeverExpires runs only when lastResponseTime > 0.
            // Without a positive lastResponseTime, the test would not detect Infinity in cacheRemainingMs.
            db.prepare(
                "UPDATE session_meta SET cache_ttl = ?, last_response_time = ? WHERE session_id = ?",
            ).run("never", Date.now() - 60_000, sessionId);

            const detail = buildStatusDetail(db, sessionId, directory);

            expect(detail.cacheNeverExpires).toBe(true);
            expect(detail.cacheExpired).toBe(false);
            // Infinity must not reach the numeric RPC field because JSON.stringify converts it to null.
            // JSON.stringify converts Infinity to null, violating the StatusDetail contract.
            // -1 is the never-expires sentinel: distinguishable from 0 (expired)
            // -1 distinguishes never-expiring entries from expired entries (0), so consumers need not read a separate flag.
            // -1 distinguishes never-expiring entries from expired entries (0).
            expect(detail.cacheRemainingMs).toBe(-1);
            expect(detail.cacheTtlMs).toBe(-1);
            const roundTripped = JSON.parse(JSON.stringify(detail));
            expect(roundTripped.cacheRemainingMs).toBe(-1);
            expect(roundTripped.cacheRemainingMs).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});

describe("BoundedTtlCache", () => {
    test("serves a fresh entry and drops an expired one on read", () => {
        const cache = new BoundedTtlCache<string>(2_000, 32);
        cache.set("a", "alpha", 1_000);
        expect(cache.get("a", 2_500)).toBe("alpha");
        expect(cache.get("a", 3_000)).toBeUndefined();
        expect(cache.size).toBe(0);
    });

    test("set sweeps every expired entry, not only the written key", () => {
        const cache = new BoundedTtlCache<string>(2_000, 32);
        cache.set("a", "alpha", 1_000);
        cache.set("b", "beta", 1_000);
        cache.set("c", "gamma", 5_000);
        expect(cache.size).toBe(1);
        expect(cache.get("c", 5_000)).toBe("gamma");
    });

    test("a full cache evicts its oldest entry before inserting", () => {
        const cache = new BoundedTtlCache<string>(60_000, 2);
        cache.set("a", "alpha", 1_000);
        cache.set("b", "beta", 2_000);
        cache.set("c", "gamma", 3_000);
        expect(cache.size).toBe(2);
        expect(cache.get("a", 3_000)).toBeUndefined();
        expect(cache.get("b", 3_000)).toBe("beta");
        expect(cache.get("c", 3_000)).toBe("gamma");
    });

    test("rewriting a live key refreshes it without evicting another entry", () => {
        const cache = new BoundedTtlCache<string>(60_000, 2);
        cache.set("a", "alpha", 1_000);
        cache.set("b", "beta", 2_000);
        cache.set("a", "alpha-2", 3_000);
        expect(cache.size).toBe(2);
        expect(cache.get("a", 3_000)).toBe("alpha-2");
        expect(cache.get("b", 3_000)).toBe("beta");
    });
});
