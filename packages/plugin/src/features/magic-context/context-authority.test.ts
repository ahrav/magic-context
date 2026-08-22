import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, withPrivilegedWriter } from "../../shared/sqlite";
import { inspectClaimsBackfillReconciliation } from "./claims-backfill";
import type { AuthorityModuleClient, AuthorityStatus, ChangefeedPage } from "./context-authority";
import {
    applyMirrorPage,
    bumpDomainMutationEpoch,
    drainAuthority,
    ensureContextStoreUuid,
    ensureLiveMemoryResnapshot,
    getAuthorityManagedMarker,
    getMirrorCursor,
    getModuleNoteEvaluationBridge,
    installAuthorityManagedMarker,
    prepareAuthority,
    pullAndApplyMirrorPage,
    reconcileAuthorityProject,
    registerModuleNoteEvaluationBridge,
} from "./context-authority";
import { getMemoriesByProjects, insertMemory, isMemoryRow } from "./memory/storage-memory";
import {
    clearMemoryClaimFailpoints,
    computeClaimRequestDigest,
    createMemoryWithClaimsInCurrentTransaction,
    deleteMemoryWithClaimsInCurrentTransaction,
    readMemoryClaimLink,
    runInMemoryClaimsWriteTransaction,
    setMemoryClaimFailpoint,
} from "./memory/storage-memory-claims";
import { getMemoryVerifications } from "./memory/storage-memory-verifications";
import { runMigrations } from "./migrations";
import { resolveMemoriesByIdsForSearch, unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";

function db(): Database {
    const value = new Database(":memory:");
    initializeDatabase(value);
    runMigrations(value);
    return value;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function authority(state: AuthorityStatus["state"], generation: number): AuthorityStatus {
    return { context_store_uuid: "store", project: "/repo", domain: "memories", state, generation };
}

function protocol(seedCalls: { bytes: number[] }): AuthorityModuleClient {
    let generation = 1;
    return {
        authorityStatus: async () => ({ authority: null }),
        authorityPrepare: async (args) => {
            if (args.phase === "begin") return { authority: authority("PREPARING", generation) };
            if (args.phase === "abort") return { authority: authority("TS", ++generation) };
            if (args.phase === "ack") return { authority: authority("MODULE", ++generation) };
            return {
                authority: {
                    ...authority("PREPARING", generation),
                    checksum_expected: String(args.checksum_expected),
                    checksum_actual: String(args.checksum_expected),
                    checksum_ok: 1,
                },
            };
        },
        authoritySeed: async (args) => {
            seedCalls.bytes.push(new TextEncoder().encode(JSON.stringify(args.rows)).byteLength);
            return { seeded: Array.isArray(args.rows) ? args.rows.length : 0, module_row_ids: [] };
        },
        mirrorPull: async (args) => ({
            page: {
                domain: args.domain,
                cursor: args.cursor,
                next_cursor: args.cursor,
                has_more: false,
                rows: [],
            },
        }),
    };
}

describe("memory authority protocol", () => {
    test("historical sparse note feed rows preserve rich local columns", () => {
        const database = db();
        const localStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    `INSERT INTO notes (id, type, status, content, project_path, session_id,
                     manifest_json, compiled_check, check_status, check_version, policy_version,
                     created_at, updated_at)
                     VALUES (41, 'smart', 'ready', 'rich note', '/repo', 'session',
                     '{"condition":"pr"}', 'compiled', 'compiled', 7, 3, 100, 200)`,
                )
                .run();
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "notes",
                        op: "insert",
                        module_row_id: 9,
                        full_row_snapshot: {
                            context_store_uuid: localStoreUuid,
                            context_row_id: 41,
                            project_path: "/repo",
                            session_id: "session",
                            content: "updated by module",
                            status: "active",
                            updated_at_ms: 300,
                        },
                        content_hash: null,
                    },
                ],
            },
        });
        expect(
            database
                .prepare(
                    "SELECT content, manifest_json, compiled_check, check_version, policy_version FROM notes WHERE id = 41",
                )
                .get(),
        ).toEqual({
            content: "updated by module",
            manifest_json: '{"condition":"pr"}',
            compiled_check: "compiled",
            check_version: 7,
            policy_version: 3,
        });
    });

    test("privileged mirror writes keep the note search projection synchronized", () => {
        const database = db();
        const localStoreUuid = ensureContextStoreUuid(database);
        const projected = (query: string) =>
            (
                database
                    .prepare("SELECT rowid AS id FROM notes_fts WHERE notes_fts MATCH ?")
                    .all(query) as Array<{ id: number }>
            ).map((row) => row.id);

        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    `INSERT INTO notes (id, type, status, content, project_path, session_id,
                     created_at, updated_at)
                     VALUES (61, 'smart', 'ready', 'mirrored note about sharding', '/repo',
                     'session', 100, 200)`,
                )
                .run();
        });
        expect(projected('"sharding"')).toEqual([61]);

        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "notes",
                        op: "insert",
                        module_row_id: 9,
                        full_row_snapshot: {
                            context_store_uuid: localStoreUuid,
                            context_row_id: 61,
                            project_path: "/repo",
                            session_id: "session",
                            content: "mirrored note about compaction",
                            status: "active",
                            updated_at_ms: 300,
                        },
                        content_hash: null,
                    },
                ],
            },
        });

        expect(projected('"sharding"')).toEqual([]);
        expect(projected('"compaction"')).toEqual([61]);

        withPrivilegedWriter(database, () => {
            database.prepare("DELETE FROM notes WHERE id = ?").run(61);
        });
        expect(projected('"compaction"')).toEqual([]);
    });

    test("repeated note drains replace a re-minted module row for the same context note", async () => {
        const database = db();
        const contextStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO notes (id, type, status, content, project_path, session_id, created_at, updated_at) VALUES (41, 'smart', 'active', 'local note', '/repo', 'session', 10, 20)",
                )
                .run();
        });
        installAuthorityManagedMarker(database, "/repo");

        let feedSeq = 1;
        let moduleRowId = 9;
        let statusVersion = 1;
        let state: AuthorityStatus["state"] = "MODULE";
        const module: AuthorityModuleClient = {
            authorityStatus: async (args) => ({
                authority: {
                    ...authority(args.domain === "notes" ? state : "TS", 1),
                    domain: args.domain,
                },
            }),
            authorityPrepare: async () => ({ authority: authority("MODULE", 1) }),
            authorityDrain: async (args) => {
                state = args.action === "finish" ? "TS" : "DRAINING";
                return {
                    authority: {
                        ...authority(state, 1),
                        domain: args.domain as "memories" | "notes",
                        captured_upper_bound: feedSeq,
                        coordinator_token: "note-drain-token",
                    },
                };
            },
            mirrorPull: async (args) => ({
                page: {
                    domain: "notes",
                    cursor: args.cursor,
                    next_cursor: feedSeq,
                    has_more: false,
                    rows:
                        args.cursor < feedSeq
                            ? [
                                  {
                                      feed_seq: feedSeq,
                                      domain: "notes",
                                      op: "insert",
                                      module_row_id: moduleRowId,
                                      full_row_snapshot: {
                                          context_store_uuid: contextStoreUuid,
                                          context_row_id: 41,
                                          project_path: "/repo",
                                          session_id: "session",
                                          content: `module note revision ${statusVersion}`,
                                          status: "active",
                                          status_version: statusVersion,
                                          created_at_ms: 10,
                                          updated_at_ms: 20 + statusVersion,
                                      },
                                      content_hash: null,
                                  },
                              ]
                            : [],
                },
            }),
        };

        await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "notes",
            module,
            checksum: "same",
        });

        moduleRowId = 10;
        feedSeq = 2;
        statusVersion = 2;
        state = "MODULE";
        installAuthorityManagedMarker(database, "/repo");
        await expect(
            drainAuthority({
                db: database,
                projectPath: "/repo",
                domain: "notes",
                module,
                checksum: "same",
            }),
        ).resolves.toMatchObject({ state: "TS" });

        expect(
            database
                .prepare(
                    "SELECT module_project, module_row_id, context_row_id, status_version FROM mirror_note_revisions",
                )
                .all(),
        ).toEqual([
            {
                module_project: "/repo",
                module_row_id: 10,
                context_row_id: 41,
                status_version: 2,
            },
        ]);
        expect(
            database
                .prepare(
                    "SELECT module_row_id, context_row_id FROM mirror_identity WHERE domain = 'notes'",
                )
                .all(),
        ).toEqual([{ module_row_id: 10, context_row_id: 41 }]);
        database.close();
    });

    test("foreign-store note ids allocate a fresh row without clobbering a local collision", () => {
        const database = db();
        const localStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO notes (id, type, status, content, project_path, session_id, created_at, updated_at) VALUES (41, 'smart', 'ready', 'local note', '/repo', 'local-session', 10, 20)",
                )
                .run();
        });

        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "notes",
                        op: "insert",
                        module_row_id: 9,
                        full_row_snapshot: {
                            context_store_uuid: `${localStoreUuid}-foreign`,
                            context_row_id: 41,
                            project_path: "/repo",
                            session_id: "foreign-session",
                            content: "foreign note",
                            status: "active",
                            compiled_provider: "local-fs",
                            compiled_config: '{"kind":"path_exists","path":"/tmp/result"}',
                            compiled_at: 35,
                            compile_status: "compiled",
                            created_at_ms: 30,
                            updated_at_ms: 40,
                        },
                        content_hash: null,
                    },
                ],
            },
        });

        expect(
            database
                .prepare(
                    `SELECT id, content, session_id, compiled_provider, compiled_config,
                            compiled_at, compile_status
                       FROM notes ORDER BY id`,
                )
                .all(),
        ).toEqual([
            {
                id: 41,
                content: "local note",
                session_id: "local-session",
                compiled_provider: null,
                compiled_config: null,
                compiled_at: null,
                compile_status: null,
            },
            {
                id: 42,
                content: "foreign note",
                session_id: "foreign-session",
                compiled_provider: "local-fs",
                compiled_config: '{"kind":"path_exists","path":"/tmp/result"}',
                compiled_at: 35,
                compile_status: "compiled",
            },
        ]);
        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'notes' AND module_project = '/repo' AND module_row_id = 9",
                )
                .get(),
        ).toEqual({ context_row_id: 42 });
    });

    test("mirrors module compilation metadata onto the context note row", () => {
        const database = db();
        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "notes",
                        op: "insert",
                        module_row_id: 12,
                        full_row_snapshot: {
                            project_path: "/repo",
                            session_id: "session",
                            content: "guard secret",
                            surface_condition: "when path /tmp/project-binding-key exists",
                            status: "pending",
                            compiled_provider: null,
                            compiled_config: null,
                            compiled_at: null,
                            compile_status: "refused",
                            created_at_ms: 10,
                            updated_at_ms: 10,
                        },
                        content_hash: null,
                    },
                ],
            },
        });

        expect(
            database
                .prepare("SELECT compile_status FROM notes WHERE content = 'guard secret'")
                .get(),
        ).toEqual({ compile_status: "refused" });
    });

    test("matching-store note ids reuse the source row and mapped tombstones remove it", () => {
        const database = db();
        const localStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO notes (id, type, status, content, project_path, session_id, created_at, updated_at) VALUES (51, 'smart', 'active', 'before mirror', '/repo', 'session', 10, 20)",
                )
                .run();
        });
        const snapshot = {
            context_store_uuid: localStoreUuid,
            context_row_id: 51,
            project_path: "/repo",
            session_id: "session",
            content: "after mirror",
            status: "ready",
            created_at_ms: 10,
            updated_at_ms: 30,
        };

        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "notes",
                        op: "update",
                        module_row_id: 11,
                        full_row_snapshot: snapshot,
                        content_hash: null,
                    },
                ],
            },
        });

        expect(database.prepare("SELECT id, content FROM notes").all()).toEqual([
            { id: 51, content: "after mirror" },
        ]);
        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'notes' AND module_project = '/repo' AND module_row_id = 11",
                )
                .get(),
        ).toEqual({ context_row_id: 51 });

        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 1,
                next_cursor: 2,
                has_more: false,
                rows: [
                    {
                        feed_seq: 2,
                        domain: "notes",
                        op: "tombstone",
                        module_row_id: 11,
                        full_row_snapshot: snapshot,
                        content_hash: null,
                    },
                ],
            },
        });

        expect(database.prepare("SELECT COUNT(*) AS count FROM notes").get()).toEqual({ count: 0 });
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS count FROM mirror_identity WHERE domain = 'notes' AND module_project = '/repo' AND module_row_id = 11",
                )
                .get(),
        ).toEqual({ count: 0 });
    });

    test("mapping feed rows round-trip into the verification side table", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        const contextMemory = insertMemory(database, {
            projectPath: "/repo",
            category: "CONSTRAINTS",
            content: "mapped memory",
            sourceSessionId: "session",
            sourceType: "dreamer",
        });
        const page: ChangefeedPage = {
            domain: "memories",
            cursor: 0,
            next_cursor: 1,
            has_more: false,
            rows: [
                {
                    feed_seq: 1,
                    domain: "memories",
                    op: "update",
                    module_row_id: 41,
                    content_hash: "module-hash",
                    full_row_snapshot: {
                        id: 41,
                        project_path: "/repo",
                        category: "CONSTRAINTS",
                        content: "mapped memory",
                        normalized_hash: "module-hash",
                        status: "active",
                        verified_at: 1234,
                        mapping: ["src/lib.rs", "src/lib.rs"],
                        context_store_uuid: storeUuid,
                        context_row_id: contextMemory.id,
                    },
                },
            ],
        };
        applyMirrorPage({ db: database, page });
        const verification = getMemoryVerifications(database, [contextMemory.id]).get(
            contextMemory.id,
        );
        expect(verification?.files).toEqual(["src/lib.rs"]);
        expect(verification?.verifiedAt).toBe(1234);

        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 1,
                next_cursor: 2,
                has_more: false,
                rows: [
                    {
                        ...page.rows[0]!,
                        feed_seq: 2,
                        full_row_snapshot: {
                            ...page.rows[0]!.full_row_snapshot,
                            mapping: null,
                            verified_at: 2000,
                        },
                    },
                ],
            },
        });
        expect(getMemoryVerifications(database, [contextMemory.id]).has(contextMemory.id)).toBe(
            false,
        );
    });
    test("preserves source metadata across the historical 9397 mapping sequence", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    `INSERT INTO memories(
                        id, project_path, category, content, normalized_hash, importance, scope, shareable,
                        source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
                        last_seen_at, status, verification_status
                     ) VALUES (9397, '/repo', 'CONSTRAINTS', 'rig memory', 'rig-hash', 66, 'project', 0,
                               'agent', 1, 0, 1, 1, 1, 1, 'active', 'unverified')`,
                )
                .run();
        });
        const fullSnapshot = {
            id: 9397,
            project_path: "/repo",
            category: "CONSTRAINTS",
            content: "rig memory",
            normalized_hash: "rig-hash",
            importance: 66,
            scope: "project",
            shareable: 0,
            source_session_id: null,
            source_type: "agent",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 1,
            created_at: 1,
            updated_at: 1,
            last_seen_at: 1,
            last_retrieved_at: null,
            status: "active",
            expires_at: null,
            verification_status: "unverified",
            verified_at: null,
            classified_at: null,
            superseded_by_memory_id: null,
            merged_from: null,
            metadata_json: null,
            context_store_uuid: storeUuid,
            context_row_id: 9397,
        };
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1321,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1321,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 9397,
                        full_row_snapshot: fullSnapshot,
                        content_hash: "rig-hash",
                    },
                ],
            },
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 1321,
                next_cursor: 1322,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1322,
                        domain: "memories",
                        op: "update",
                        module_row_id: 9397,
                        full_row_snapshot: {
                            id: 9397,
                            project_path: "/repo",
                            category: "CONSTRAINTS",
                            content: "rig memory",
                            normalized_hash: "rig-hash",
                            status: "active",
                            mapping: ["src/lib.rs"],
                        },
                        content_hash: "rig-hash",
                    },
                ],
            },
        });
        const memories = getMemoriesByProjects(database, ["/repo"]);
        expect(memories).toHaveLength(1);
        expect(memories[0]?.sourceType).toBe("agent");
        expect(memories[0]?.importance).toBe(66);
        expect(isMemoryRow(memories[0])).toBe(true);
    });

    test("heals pre-clobbered source metadata from the retained live snapshot", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        installAuthorityManagedMarker(database, "/repo", storeUuid);
        const snapshot = {
            id: 9397,
            project_path: "/repo",
            category: "CONSTRAINTS",
            content: "rig memory",
            normalized_hash: "rig-hash",
            importance: 66,
            scope: "project",
            shareable: 0,
            source_session_id: null,
            source_type: "agent",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 1,
            created_at: 1,
            updated_at: 1,
            last_seen_at: 1,
            last_retrieved_at: null,
            status: "active",
            expires_at: null,
            verification_status: "unverified",
            verified_at: null,
            classified_at: null,
            superseded_by_memory_id: null,
            merged_from: null,
            metadata_json: null,
            context_store_uuid: storeUuid,
            context_row_id: 9397,
        };
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    `INSERT INTO memories(
                        id, project_path, category, content, normalized_hash, importance, source_type,
                        first_seen_at, created_at, updated_at, last_seen_at
                     ) VALUES (9397, '/repo', 'CONSTRAINTS', 'rig memory', 'rig-hash', NULL, NULL, 1, 1, 1, 1)`,
                )
                .run();
            database
                .prepare(
                    "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/repo', 9397, 9397)",
                )
                .run();
            database
                .prepare(
                    "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash, full_row_snapshot) VALUES ('/repo', 9397, 'CONSTRAINTS', 'rig-hash', ?)",
                )
                .run(JSON.stringify(snapshot));
        });
        applyMirrorPage({
            db: database,
            page: { domain: "memories", cursor: 0, next_cursor: 0, has_more: false, rows: [] },
        });
        expect(
            database.prepare("SELECT source_type, importance FROM memories WHERE id = 9397").get(),
        ).toEqual({ source_type: "agent", importance: 66 });
    });

    test("bounds authority seed frames below the management frame cap", async () => {
        const database = db();
        const seedCalls = { bytes: [] as number[] };
        const rows = Array.from({ length: 3 }, (_, id) => ({
            source_row_id: id + 1,
            snapshot: { id: id + 1, content: "x".repeat(400_000) },
        }));
        await prepareAuthority({
            db: database,
            projectPath: "/repo",
            domains: ["memories"],
            module: protocol(seedCalls),
            seedPages: async () => rows,
        });
        expect(seedCalls.bytes.length).toBeGreaterThan(1);
        expect(Math.max(...seedCalls.bytes)).toBeLessThan(1024 * 1024);
    });

    test("records the last source row when a seed frame coalesces duplicate module ids", async () => {
        const database = db();
        const module = protocol({ bytes: [] });
        module.authoritySeed = async () => ({ seeded: 2, module_row_ids: [900, 900] });

        await prepareAuthority({
            db: database,
            projectPath: "/repo",
            domains: ["memories"],
            module,
            seedPages: async () => [
                {
                    source_row_id: 100,
                    snapshot: { id: 100, project_path: "/repo", normalized_hash: "same" },
                },
                {
                    source_row_id: 200,
                    snapshot: { id: 200, project_path: "/repo", normalized_hash: "same" },
                },
            ],
        });

        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'memories' AND module_project = '/repo' AND module_row_id = 900",
                )
                .get(),
        ).toEqual({ context_row_id: 200 });
    });

    test("module checksum mismatch aborts, removes the marker, and restores TS writes", async () => {
        const database = db();
        const seedCalls = { bytes: [] as number[] };
        const module = protocol(seedCalls);
        const prepare = module.authorityPrepare;
        module.authorityPrepare = async (args) => {
            const response = await prepare(args);
            if (args.phase === "complete") {
                return {
                    authority: {
                        ...response.authority,
                        checksum_actual: "module-digest-does-not-match",
                        checksum_ok: 0,
                    },
                };
            }
            return response;
        };
        await expect(
            prepareAuthority({
                db: database,
                projectPath: "/repo",
                domains: ["memories"],
                module,
                seedPages: async () => [
                    { source_row_id: 1, snapshot: { id: 1, project_path: "/repo" } },
                ],
            }),
        ).rejects.toThrow("verification failed");
        expect(getAuthorityManagedMarker(database, "/repo")).toBeNull();
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'ts works', 'h', 0, 0, 0, 0)",
                )
                .run("/repo");
        });
        expect(database.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({
            count: 1,
        });
    });

    test("mirror updates delete stale vectors and translate references atomically", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run("/repo", "CONSTRAINTS", "old", "h1");
            database
                .prepare(
                    "INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES (1, ?, ?)",
                )
                .run(Buffer.from([1]), "test");
        });
        const snapshot = (
            id: number,
            content: string,
            hash: string,
            extra: Record<string, unknown> = {},
        ) => ({
            id,
            project_path: "/repo",
            category: "CONSTRAINTS",
            content,
            normalized_hash: hash,
            importance: 50,
            scope: "project",
            shareable: 0,
            source_session_id: null,
            source_type: "agent",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 0,
            created_at: 0,
            updated_at: 1,
            last_seen_at: 1,
            last_retrieved_at: null,
            status: "active",
            expires_at: null,
            verification_status: "unverified",
            verified_at: null,
            classified_at: null,
            superseded_by_memory_id: null,
            merged_from: null,
            metadata_json: null,
            context_store_uuid: storeUuid,
            context_row_id: id,
            ...extra,
        });
        const page = (
            cursor: number,
            next_cursor: number,
            rows: ChangefeedPage["rows"],
        ): ChangefeedPage => ({ domain: "memories", cursor, next_cursor, has_more: false, rows });
        applyMirrorPage({
            db: database,
            page: page(0, 1, [
                {
                    feed_seq: 1,
                    domain: "memories",
                    op: "insert",
                    module_row_id: 1,
                    full_row_snapshot: snapshot(1, "old", "h1"),
                    content_hash: "h1",
                },
            ]),
        });
        applyMirrorPage({
            db: database,
            page: page(1, 2, [
                {
                    feed_seq: 2,
                    domain: "memories",
                    op: "update",
                    module_row_id: 1,
                    full_row_snapshot: snapshot(1, "new", "h2"),
                    content_hash: "h2",
                },
            ]),
        });
        expect(database.prepare("SELECT content FROM memories WHERE id = 1").get()).toEqual({
            content: "new",
        });
        applyMirrorPage({
            db: database,
            page: page(2, 3, [
                {
                    feed_seq: 3,
                    domain: "memories",
                    op: "update",
                    module_row_id: 1,
                    full_row_snapshot: snapshot(1, "new", "h2", {
                        mural_cue: "cue → anchor",
                        mural_cue_hash: "cue-content-sha",
                        mural_cue_at: 42,
                        mural_cue_rejection_count: 0,
                    }),
                    content_hash: "h2",
                },
            ]),
        });
        expect(
            database
                .prepare(
                    "SELECT mural_cue, mural_cue_hash, mural_cue_at, mural_cue_rejection_count FROM memories WHERE id = 1",
                )
                .get(),
        ).toEqual({
            mural_cue: "cue → anchor",
            mural_cue_hash: "cue-content-sha",
            mural_cue_at: 42,
            mural_cue_rejection_count: 0,
        });
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = 1")
                .get(),
        ).toEqual({ count: 0 });
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES (1, ?, ?)",
                )
                .run(Buffer.from([2]), "test");
        });
        applyMirrorPage({
            db: database,
            page: page(3, 4, [
                {
                    feed_seq: 4,
                    domain: "memories",
                    op: "tombstone",
                    module_row_id: 1,
                    full_row_snapshot: snapshot(1, "new", "h2"),
                    content_hash: "h2",
                },
            ]),
        });
        expect(
            database.prepare("SELECT COUNT(*) AS count FROM memories WHERE id = 1").get(),
        ).toEqual({ count: 0 });
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = 1")
                .get(),
        ).toEqual({ count: 0 });
    });

    test("telemetry-only mirror snapshots update memory_stats without touching the base row", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        const snapshot = (extra: Record<string, unknown> = {}) => ({
            id: 1,
            project_path: "/repo",
            category: "CONSTRAINTS",
            content: "stable content",
            normalized_hash: "h1",
            importance: 50,
            scope: "project",
            shareable: 0,
            source_session_id: null,
            source_type: "agent",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 0,
            created_at: 0,
            updated_at: 1,
            last_seen_at: 1,
            last_retrieved_at: null,
            status: "active",
            expires_at: null,
            verification_status: "unverified",
            verified_at: null,
            classified_at: null,
            superseded_by_memory_id: null,
            merged_from: null,
            metadata_json: null,
            context_store_uuid: storeUuid,
            context_row_id: 1,
            ...extra,
        });
        const page = (
            cursor: number,
            next_cursor: number,
            rows: ChangefeedPage["rows"],
        ): ChangefeedPage => ({ domain: "memories", cursor, next_cursor, has_more: false, rows });
        applyMirrorPage({
            db: database,
            page: page(0, 1, [
                {
                    feed_seq: 1,
                    domain: "memories",
                    op: "insert",
                    module_row_id: 1,
                    full_row_snapshot: snapshot(),
                    content_hash: "h1",
                },
            ]),
        });
        const contextId = (
            database
                .prepare(
                    "SELECT context_row_id AS id FROM mirror_identity WHERE domain = 'memories' AND module_row_id = 1",
                )
                .get() as { id: number }
        ).id;
        const baseBefore = database
            .prepare(
                "SELECT content, updated_at, seen_count, retrieval_count FROM memories WHERE id = ?",
            )
            .get(contextId);
        database.exec(`
            CREATE TABLE test_base_update_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER);
            CREATE TRIGGER test_memories_update_audit AFTER UPDATE ON memories BEGIN
                INSERT INTO test_base_update_audit (memory_id) VALUES (NEW.id);
            END;
        `);

        applyMirrorPage({
            db: database,
            page: page(1, 2, [
                {
                    feed_seq: 2,
                    domain: "memories",
                    op: "update",
                    module_row_id: 1,
                    full_row_snapshot: snapshot({
                        seen_count: 6,
                        retrieval_count: 2,
                        last_seen_at: 9,
                        last_retrieved_at: 8,
                        updated_at: 9,
                    }),
                    content_hash: "h1",
                },
            ]),
        });

        expect(database.prepare("SELECT COUNT(*) AS n FROM test_base_update_audit").get()).toEqual({
            n: 0,
        });
        expect(
            database
                .prepare(
                    "SELECT content, updated_at, seen_count, retrieval_count FROM memories WHERE id = ?",
                )
                .get(contextId),
        ).toEqual(baseBefore);
        expect(
            database
                .prepare(
                    "SELECT seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at FROM memory_stats WHERE memory_id = ?",
                )
                .get(contextId),
        ).toEqual({
            seen_count: 6,
            retrieval_count: 2,
            last_seen_at: 9,
            last_retrieved_at: 8,
            updated_at: 9,
        });

        // A content change still updates the base row (and fires the audit).
        applyMirrorPage({
            db: database,
            page: page(2, 3, [
                {
                    feed_seq: 3,
                    domain: "memories",
                    op: "update",
                    module_row_id: 1,
                    full_row_snapshot: snapshot({
                        content: "replaced content",
                        normalized_hash: "h2",
                        seen_count: 6,
                        retrieval_count: 2,
                        last_seen_at: 9,
                        last_retrieved_at: 8,
                        updated_at: 12,
                    }),
                    content_hash: "h2",
                },
            ]),
        });
        expect(
            database.prepare("SELECT content FROM memories WHERE id = ?").get(contextId),
        ).toEqual({ content: "replaced content" });
        expect(database.prepare("SELECT COUNT(*) AS n FROM test_base_update_audit").get()).toEqual({
            n: 1,
        });
    });

    test("replaying an already-applied module feed page leaves rows and cursor byte-identical", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        const insertRow = {
            feed_seq: 1,
            domain: "memories" as const,
            op: "insert" as const,
            module_row_id: 7,
            full_row_snapshot: {
                id: 7,
                project_path: "/repo",
                category: "CONSTRAINTS",
                content: "module replay fact",
                normalized_hash: "replay-h1",
                importance: 50,
                scope: "project",
                shareable: 0,
                source_session_id: null,
                source_type: "agent",
                seen_count: 1,
                retrieval_count: 0,
                first_seen_at: 0,
                created_at: 0,
                updated_at: 1,
                last_seen_at: 1,
                last_retrieved_at: null,
                status: "active",
                expires_at: null,
                verification_status: "unverified",
                verified_at: null,
                classified_at: null,
                superseded_by_memory_id: null,
                merged_from: null,
                metadata_json: null,
                context_store_uuid: storeUuid,
                context_row_id: 7,
            },
            content_hash: "replay-h1",
        };
        const applied = applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [insertRow],
            },
        });
        expect(applied).toBe(1);
        const snapshotTables = () =>
            JSON.stringify({
                memories: database.prepare("SELECT * FROM memories ORDER BY id").all(),
                stats: database.prepare("SELECT * FROM memory_stats ORDER BY memory_id").all(),
                identity: database
                    .prepare("SELECT * FROM mirror_identity ORDER BY domain, module_row_id")
                    .all(),
                cursor: database
                    .prepare("SELECT domain, cursor FROM mirror_cursors ORDER BY domain")
                    .all(),
                claimOperations: database
                    .prepare("SELECT producer, operation_key FROM claim_operations ORDER BY id")
                    .all(),
                claimOutbox: database
                    .prepare("SELECT effect_key, effect_type FROM claim_change_outbox ORDER BY id")
                    .all(),
                claimGenerations: database
                    .prepare(
                        "SELECT project_id, generation FROM claim_project_generations ORDER BY project_id",
                    )
                    .all(),
                crosswalk: database
                    .prepare("SELECT * FROM legacy_memory_claims ORDER BY memory_id")
                    .all(),
            });
        const before = snapshotTables();

        // Replay: the module re-sends the applied row from the durable cursor.
        const replayed = applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 1,
                next_cursor: 1,
                has_more: false,
                rows: [insertRow],
            },
        });
        expect(replayed).toBe(1);
        expect(snapshotTables()).toBe(before);

        // A page at a cursor other than the durable one is rejected instead
        // of being applied twice.
        expect(() =>
            applyMirrorPage({
                db: database,
                page: {
                    domain: "memories",
                    cursor: 0,
                    next_cursor: 1,
                    has_more: false,
                    rows: [insertRow],
                },
            }),
        ).toThrow(/mirror cursor mismatch/);
        expect(snapshotTables()).toBe(before);
    });

    test("mirror-back keeps same content in separate project rows", () => {
        const database = db();
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run(9395, "project-a", "PROJECT_RULES", "shared fact", "H");
        });
        const before = database.prepare("SELECT * FROM memories WHERE id = 9395").get();

        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 8214,
                        full_row_snapshot: {
                            id: 8214,
                            project_path: "project-b",
                            category: "PROJECT_RULES",
                            content: "shared fact",
                            normalized_hash: "H",
                            status: "active",
                        },
                        content_hash: "H",
                    },
                ],
            },
        });

        expect(database.prepare("SELECT * FROM memories WHERE id = 9395").get()).toEqual(before);
        expect(
            database
                .prepare(
                    "SELECT id, project_path, category, normalized_hash FROM memories ORDER BY id",
                )
                .all(),
        ).toEqual([
            {
                id: 9395,
                project_path: "project-a",
                category: "PROJECT_RULES",
                normalized_hash: "H",
            },
            {
                id: 9396,
                project_path: "project-b",
                category: "PROJECT_RULES",
                normalized_hash: "H",
            },
        ]);
        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'memories' AND module_project = 'project-b' AND module_row_id = 8214",
                )
                .get(),
        ).toEqual({ context_row_id: 9396 });
    });

    test("mirror-back adopts an unambiguous legacy facade row by same-project content", () => {
        const database = db();
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run(9395, "project-a", "PROJECT_RULES", "shared fact", "H");
        });

        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 8214,
                        full_row_snapshot: {
                            id: 8214,
                            project_path: "project-a",
                            category: "PROJECT_RULES",
                            content: "updated shared fact",
                            normalized_hash: "H",
                            status: "active",
                        },
                        content_hash: "H",
                    },
                ],
            },
        });

        expect(database.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({
            count: 1,
        });
        expect(database.prepare("SELECT id, project_path, content FROM memories").get()).toEqual({
            id: 9395,
            project_path: "project-a",
            content: "updated shared fact",
        });
        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'memories' AND module_project = 'project-a' AND module_row_id = 8214",
                )
                .get(),
        ).toEqual({ context_row_id: 9395 });
    });

    test("mirror-back skips an adopted row whose project ownership differs", () => {
        const database = db();
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, importance, source_type, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run(9395, "project-a", "PROJECT_RULES", "owned by A", "A-hash", 75, "agent");
            database
                .prepare(
                    "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', 'project-b', 8214, 9395)",
                )
                .run();
        });
        const before = database.prepare("SELECT * FROM memories WHERE id = 9395").get();

        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "update",
                        module_row_id: 8214,
                        full_row_snapshot: {
                            id: 8214,
                            project_path: "project-b",
                            category: "PROJECT_RULES",
                            content: "owned by B",
                            normalized_hash: "B-hash",
                            status: "active",
                        },
                        content_hash: "B-hash",
                    },
                ],
            },
        });

        expect(database.prepare("SELECT * FROM memories WHERE id = 9395").get()).toEqual(before);
    });

    test("mirror-back pins row-id adoption to the local context store UUID", () => {
        const database = db();
        const localStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run(9395, "project-a", "PROJECT_RULES", "local fact", "local-hash");
        });

        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 9395,
                        full_row_snapshot: {
                            id: 9395,
                            project_path: "project-a",
                            category: "PROJECT_RULES",
                            content: "foreign fact",
                            normalized_hash: "foreign-hash",
                            context_store_uuid: `${localStoreUuid}-foreign`,
                            context_row_id: 9395,
                            status: "active",
                        },
                        content_hash: "foreign-hash",
                    },
                ],
            },
        });

        expect(database.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({
            count: 2,
        });
        expect(
            database
                .prepare("SELECT id, project_path, normalized_hash FROM memories ORDER BY id")
                .all(),
        ).toEqual([
            { id: 9395, project_path: "project-a", normalized_hash: "local-hash" },
            { id: 9396, project_path: "project-a", normalized_hash: "foreign-hash" },
        ]);
        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'memories' AND module_project = 'project-a' AND module_row_id = 9395",
                )
                .get(),
        ).toEqual({ context_row_id: 9396 });
    });

    test("canonical mapping survives legacy-first normalization tombstone ordering", () => {
        const database = db();
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run(9395, "git:identity", "CONFIG_VALUES", "drive model", "same-hash");
        });

        const row = (id: number, project_path: string) => ({
            id,
            project_path,
            category: "CONFIG_VALUES",
            content: "drive model",
            normalized_hash: "same-hash",
            status: "active",
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 3,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 100,
                        full_row_snapshot: row(100, "/repo"),
                        content_hash: "same-hash",
                    },
                    {
                        feed_seq: 2,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 200,
                        full_row_snapshot: row(200, "git:identity"),
                        content_hash: "same-hash",
                    },
                    {
                        feed_seq: 3,
                        domain: "memories",
                        op: "tombstone",
                        module_row_id: 100,
                        full_row_snapshot: row(100, "/repo"),
                        content_hash: "same-hash",
                    },
                ],
            },
        });

        expect(database.prepare("SELECT id, project_path FROM memories").get()).toEqual({
            id: 9395,
            project_path: "git:identity",
        });
        expect(
            database
                .prepare(
                    "SELECT module_project, module_row_id, context_row_id FROM mirror_identity WHERE domain = 'memories'",
                )
                .all(),
        ).toEqual([{ module_project: "git:identity", module_row_id: 200, context_row_id: 9395 }]);
    });

    test("schema-57 mirror upgrades resnapshot before either tombstone order", async () => {
        const row = (id: number, projectPath: string) => ({
            id,
            project_path: projectPath,
            category: "CONFIG_VALUES",
            content: "drive model",
            normalized_hash: "same-hash",
            status: "active",
        });
        const scenarios = [
            {
                name: "legacy cleanup leaves canonical live",
                live: [row(200, "git:identity")],
                tombstones: [row(100, "/repo")],
                survives: true,
            },
            {
                name: "canonical cleanup leaves legacy live",
                live: [row(100, "/repo")],
                tombstones: [row(200, "git:identity")],
                survives: true,
            },
            {
                name: "both deleted legacy first",
                live: [],
                tombstones: [row(100, "/repo"), row(200, "git:identity")],
                survives: false,
            },
            {
                name: "both deleted canonical first",
                live: [],
                tombstones: [row(200, "git:identity"), row(100, "/repo")],
                survives: false,
            },
        ];

        for (const scenario of scenarios) {
            const database = db();
            database.exec(`
                DROP TABLE mirror_live_staging;
                DROP TABLE mirror_resnapshot_state;
                DROP TABLE mirror_live_memory_rows;
                DELETE FROM schema_migrations WHERE version >= 58;
            `);
            withPrivilegedWriter(database, () => {
                database
                    .prepare(
                        "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (9395, 'git:identity', 'CONFIG_VALUES', 'drive model', 'same-hash', 0, 0, 0, 0)",
                    )
                    .run();
                database
                    .prepare(
                        "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/repo', 100, 9395)",
                    )
                    .run();
                database
                    .prepare(
                        "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES ('memories', 20, 0)",
                    )
                    .run();
            });
            runMigrations(database);
            const calls: Array<{ live_only?: boolean }> = [];
            const module: AuthorityModuleClient = {
                authorityStatus: async () => ({ authority: null }),
                authorityPrepare: async () => ({ authority: authority("PREPARING", 1) }),
                mirrorPull: async (args) => {
                    calls.push(args);
                    if (args.live_only) {
                        return {
                            page: {
                                domain: "memories",
                                cursor: args.cursor,
                                next_cursor: scenario.live.at(-1)?.id ?? args.cursor,
                                has_more: false,
                                rows: scenario.live.map((snapshot) => ({
                                    feed_seq: 0,
                                    domain: "memories" as const,
                                    op: "insert" as const,
                                    module_row_id: snapshot.id,
                                    full_row_snapshot: snapshot,
                                    content_hash: "same-hash",
                                })),
                            },
                        };
                    }
                    return {
                        page: {
                            domain: "memories",
                            cursor: args.cursor,
                            next_cursor: args.cursor + scenario.tombstones.length,
                            has_more: false,
                            rows: scenario.tombstones.map((snapshot, index) => ({
                                feed_seq: args.cursor + index + 1,
                                domain: "memories" as const,
                                op: "tombstone" as const,
                                module_row_id: snapshot.id,
                                full_row_snapshot: snapshot,
                                content_hash: "same-hash",
                            })),
                        },
                    };
                },
            };

            await pullAndApplyMirrorPage({ db: database, module, domain: "memories" });
            expect(calls[0]?.live_only, scenario.name).toBe(true);
            expect(
                database.prepare("SELECT id FROM memories WHERE id = 9395").get() != null,
                scenario.name,
            ).toBe(scenario.survives);
            expect(
                database
                    .prepare("SELECT status FROM mirror_resnapshot_state WHERE domain = 'memories'")
                    .get(),
                scenario.name,
            ).toEqual({ status: "complete" });
            database.close();
        }
    });

    test("repairs a partially populated live mirror before replay", async () => {
        const database = db();
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', 'git:partial', 1, 100)",
                )
                .run();
            database
                .prepare(
                    "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', 'git:partial', 2, 101)",
                )
                .run();
            database
                .prepare(
                    "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash) VALUES ('git:partial', 1, 'ARCHITECTURE', 'hash-1')",
                )
                .run();
        });
        const calls: boolean[] = [];
        const module: AuthorityModuleClient = {
            authorityStatus: async () => ({ authority: null }),
            authorityPrepare: async () => ({ authority: authority("PREPARING", 1) }),
            mirrorPull: async (args) => {
                calls.push(args.live_only === true);
                if (args.live_only) {
                    return {
                        page: {
                            domain: "memories",
                            cursor: 0,
                            next_cursor: 2,
                            has_more: false,
                            rows: [1, 2].map((moduleRowId) => ({
                                feed_seq: 0,
                                domain: "memories" as const,
                                op: "insert" as const,
                                module_row_id: moduleRowId,
                                full_row_snapshot: {
                                    project_path: "git:partial",
                                    category: "ARCHITECTURE",
                                    normalized_hash: `hash-${moduleRowId}`,
                                },
                                content_hash: `hash-${moduleRowId}`,
                            })),
                        },
                    };
                }
                return {
                    page: {
                        domain: "memories",
                        cursor: 0,
                        next_cursor: 0,
                        has_more: false,
                        rows: [],
                    },
                };
            },
        };

        await pullAndApplyMirrorPage({ db: database, module, domain: "memories" });

        expect(calls).toEqual([true, false]);
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS count FROM mirror_live_memory_rows WHERE module_project = 'git:partial'",
                )
                .get(),
        ).toEqual({ count: 2 });
        database.close();
    });

    test("DRAINING recovery resnapshots schema-57 memory identities before tombstones", async () => {
        const row = (id: number, projectPath: string) => ({
            id,
            project_path: projectPath,
            category: "CONFIG_VALUES",
            content: "drive model",
            normalized_hash: "same-hash",
            status: "active",
        });
        for (const interruptedStatus of ["pending_check", "resnapshotting"] as const) {
            const database = db();
            database.exec(`
                DROP TABLE mirror_live_staging;
                DROP TABLE mirror_resnapshot_state;
                DROP TABLE mirror_live_memory_rows;
                DELETE FROM schema_migrations WHERE version >= 58;
            `);
            withPrivilegedWriter(database, () => {
                database
                    .prepare(
                        "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (9395, 'git:identity', 'CONFIG_VALUES', 'drive model', 'same-hash', 0, 0, 0, 0)",
                    )
                    .run();
                database
                    .prepare(
                        "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/repo', 100, 9395)",
                    )
                    .run();
                database
                    .prepare(
                        "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES ('memories', 20, 0)",
                    )
                    .run();
            });
            runMigrations(database);
            if (interruptedStatus === "resnapshotting") {
                database
                    .prepare(
                        "UPDATE mirror_resnapshot_state SET status = 'resnapshotting' WHERE domain = 'memories'",
                    )
                    .run();
                database
                    .prepare(
                        "INSERT INTO mirror_live_staging VALUES ('abandoned', '/stale', 1, 'CONSTRAINTS', 'stale', NULL)",
                    )
                    .run();
            }

            const calls: Array<{ live_only?: boolean; cursor: number }> = [];
            let state: AuthorityStatus["state"] = "DRAINING";
            const module: AuthorityModuleClient = {
                authorityStatus: async (args) => ({
                    authority: { ...authority(state, 3), domain: args.domain },
                }),
                authorityPrepare: async () => ({ authority: authority("MODULE", 3) }),
                mirrorPull: async (args) => {
                    calls.push({ live_only: args.live_only, cursor: args.cursor });
                    return args.live_only
                        ? {
                              page: {
                                  domain: "memories",
                                  cursor: 0,
                                  next_cursor: 200,
                                  has_more: false,
                                  rows: [
                                      {
                                          feed_seq: 0,
                                          domain: "memories",
                                          op: "insert",
                                          module_row_id: 200,
                                          full_row_snapshot: row(200, "git:identity"),
                                          content_hash: "same-hash",
                                      },
                                  ],
                              },
                          }
                        : {
                              page: {
                                  domain: "memories",
                                  cursor: args.cursor,
                                  next_cursor: 21,
                                  has_more: false,
                                  rows: [
                                      {
                                          feed_seq: 21,
                                          domain: "memories",
                                          op: "tombstone",
                                          module_row_id: 100,
                                          full_row_snapshot: row(100, "/repo"),
                                          content_hash: "same-hash",
                                      },
                                  ],
                              },
                          };
                },
                authorityDrain: async (args) => {
                    if (args.action === "finish") state = "TS";
                    return {
                        authority: {
                            ...authority(state, 3),
                            captured_upper_bound: 21,
                            coordinator_token: "recovery-token",
                        },
                    };
                },
            };

            const result = await drainAuthority({
                db: database,
                projectPath: "git:identity",
                domain: "memories",
                module,
                checksum: "same",
            });
            expect(calls.map((call) => call.live_only)).toEqual([true, undefined]);
            expect(
                database
                    .prepare("SELECT cursor FROM mirror_cursors WHERE domain = 'memories'")
                    .get(),
            ).toEqual({
                cursor: 21,
            });
            expect(database.prepare("SELECT id FROM memories WHERE id = 9395").get()).toEqual({
                id: 9395,
            });
            expect(database.prepare("SELECT status FROM mirror_resnapshot_state").get()).toEqual({
                status: "complete",
            });
            expect(
                database.prepare("SELECT COUNT(*) AS count FROM mirror_live_staging").get(),
            ).toEqual({
                count: 0,
            });
            expect(result.state).toBe("TS");
            database.close();
        }
    });

    test("stages paged live resnapshots and swaps only after the final page", async () => {
        const database = db();
        database
            .prepare(
                "UPDATE mirror_resnapshot_state SET status = 'resnapshotting' WHERE domain = 'memories'",
            )
            .run();
        database
            .prepare(
                "INSERT INTO mirror_live_memory_rows VALUES ('old', 9, 'CONSTRAINTS', 'old-hash', NULL)",
            )
            .run();
        database
            .prepare(
                "INSERT INTO mirror_live_staging VALUES ('abandoned', 'stale', 8, 'CONSTRAINTS', 'stale-hash', NULL)",
            )
            .run();
        let calls = 0;
        const module: AuthorityModuleClient = {
            authorityStatus: async () => ({ authority: null }),
            authorityPrepare: async () => ({ authority: authority("MODULE", 1) }),
            mirrorPull: async (args) => {
                calls += 1;
                expect(args.limit).toBe(1);
                expect(
                    database.prepare("SELECT module_project FROM mirror_live_memory_rows").get(),
                ).toEqual({
                    module_project: "old",
                });
                const id = args.cursor + 1;
                return {
                    page: {
                        domain: "memories",
                        cursor: args.cursor,
                        next_cursor: id,
                        has_more: calls < 3,
                        rows: [
                            {
                                feed_seq: 0,
                                domain: "memories",
                                op: "insert",
                                module_row_id: id,
                                full_row_snapshot: {
                                    project_path: `project-${id}`,
                                    category: "CONSTRAINTS",
                                    normalized_hash: `hash-${id}`,
                                },
                                content_hash: `hash-${id}`,
                            },
                        ],
                    },
                };
            },
        };

        await ensureLiveMemoryResnapshot({ db: database, module, limit: 1 });
        expect(calls).toBe(3);
        expect(
            database
                .prepare(
                    "SELECT module_project FROM mirror_live_memory_rows ORDER BY module_row_id",
                )
                .all(),
        ).toEqual([
            { module_project: "project-1" },
            { module_project: "project-2" },
            { module_project: "project-3" },
        ]);
        expect(database.prepare("SELECT COUNT(*) AS count FROM mirror_live_staging").get()).toEqual(
            {
                count: 0,
            },
        );
    });

    test("a stale paged resnapshot cannot replace a newer completed generation", async () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-resnapshot-owner-"));
        const path = join(directory, "context.db");
        const first = new Database(path);
        const second = new Database(path);
        try {
            initializeDatabase(first);
            runMigrations(first);
            initializeDatabase(second);
            runMigrations(second);
            first
                .prepare(
                    "UPDATE mirror_resnapshot_state SET status = 'resnapshotting', generation = 'bootstrap' WHERE domain = 'memories'",
                )
                .run();

            const waitingForA2 = deferred();
            const releaseA2 = deferred();
            const snapshot = (project: string, id: number): ChangefeedPage["rows"][number] => ({
                feed_seq: 0,
                domain: "memories",
                op: "insert",
                module_row_id: id,
                full_row_snapshot: {
                    project_path: project,
                    category: "CONSTRAINTS",
                    normalized_hash: `${project}-hash`,
                },
                content_hash: `${project}-hash`,
            });
            const moduleA: AuthorityModuleClient = {
                authorityStatus: async () => ({ authority: null }),
                authorityPrepare: async () => ({ authority: authority("MODULE", 1) }),
                mirrorPull: async (args) => {
                    if (args.cursor === 0) {
                        return {
                            page: {
                                domain: "memories",
                                cursor: 0,
                                next_cursor: 1,
                                has_more: true,
                                rows: [snapshot("A-1", 1)],
                            },
                        };
                    }
                    waitingForA2.resolve();
                    await releaseA2.promise;
                    return {
                        page: {
                            domain: "memories",
                            cursor: 1,
                            next_cursor: 2,
                            has_more: false,
                            rows: [snapshot("A-2", 2)],
                        },
                    };
                },
            };
            const moduleB: AuthorityModuleClient = {
                authorityStatus: async () => ({ authority: null }),
                authorityPrepare: async () => ({ authority: authority("MODULE", 1) }),
                mirrorPull: async () => ({
                    page: {
                        domain: "memories",
                        cursor: 0,
                        next_cursor: 2,
                        has_more: false,
                        rows: [snapshot("B-1", 1), snapshot("B-2", 2)],
                    },
                }),
            };

            const staleAttempt = ensureLiveMemoryResnapshot({
                db: first,
                module: moduleA,
                limit: 1,
            });
            await waitingForA2.promise;
            await ensureLiveMemoryResnapshot({ db: second, module: moduleB, limit: 2 });
            releaseA2.resolve();
            await staleAttempt;

            expect(
                first
                    .prepare(
                        "SELECT module_project FROM mirror_live_memory_rows ORDER BY module_row_id",
                    )
                    .all(),
            ).toEqual([{ module_project: "B-1" }, { module_project: "B-2" }]);
            expect(
                first.prepare("SELECT status, generation FROM mirror_resnapshot_state").get(),
            ).toEqual({
                status: "complete",
                generation: expect.any(String),
            });
            expect(
                first.prepare("SELECT COUNT(*) AS count FROM mirror_live_staging").get(),
            ).toEqual({ count: 0 });
        } finally {
            first.close();
            second.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("pull and drain resnapshots honor the same file-backed generation owner", async () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-resnapshot-entrypoints-"));
        const path = join(directory, "context.db");
        const pullDb = new Database(path);
        const drainDb = new Database(path);
        try {
            initializeDatabase(pullDb);
            runMigrations(pullDb);
            initializeDatabase(drainDb);
            runMigrations(drainDb);
            pullDb
                .prepare(
                    "UPDATE mirror_resnapshot_state SET status = 'resnapshotting', generation = 'bootstrap' WHERE domain = 'memories'",
                )
                .run();

            const waitingForA2 = deferred();
            const releaseA2 = deferred();
            const snapshot = (project: string, id: number): ChangefeedPage["rows"][number] => ({
                feed_seq: 0,
                domain: "memories",
                op: "insert",
                module_row_id: id,
                full_row_snapshot: {
                    project_path: project,
                    category: "CONSTRAINTS",
                    normalized_hash: `${project}-hash`,
                },
                content_hash: `${project}-hash`,
            });
            const pullModule: AuthorityModuleClient = {
                authorityStatus: async () => ({ authority: null }),
                authorityPrepare: async () => ({ authority: authority("MODULE", 1) }),
                mirrorPull: async (args) => {
                    if (!args.live_only) {
                        return {
                            page: {
                                domain: "memories",
                                cursor: args.cursor,
                                next_cursor: args.cursor,
                                has_more: false,
                                rows: [],
                            },
                        };
                    }
                    if (args.cursor === 0) {
                        return {
                            page: {
                                domain: "memories",
                                cursor: 0,
                                next_cursor: 1,
                                has_more: true,
                                rows: [snapshot("A-1", 1)],
                            },
                        };
                    }
                    waitingForA2.resolve();
                    await releaseA2.promise;
                    return {
                        page: {
                            domain: "memories",
                            cursor: 1,
                            next_cursor: 2,
                            has_more: false,
                            rows: [snapshot("A-2", 2)],
                        },
                    };
                },
            };
            let state: AuthorityStatus["state"] = "DRAINING";
            const drainModule: AuthorityModuleClient = {
                authorityStatus: async (args) => ({
                    authority: {
                        ...authority(args.domain === "memories" ? state : "TS", 3),
                        domain: args.domain,
                    },
                }),
                authorityPrepare: async () => ({ authority: authority("MODULE", 3) }),
                mirrorPull: async (args) => ({
                    page: args.live_only
                        ? {
                              domain: "memories",
                              cursor: 0,
                              next_cursor: 2,
                              has_more: false,
                              rows: [snapshot("B-1", 1), snapshot("B-2", 2)],
                          }
                        : {
                              domain: "memories",
                              cursor: args.cursor,
                              next_cursor: args.cursor,
                              has_more: false,
                              rows: [],
                          },
                }),
                authorityDrain: async (args) => {
                    if (args.action === "finish") state = "TS";
                    return {
                        authority: {
                            ...authority(state, 3),
                            captured_upper_bound: 0,
                            coordinator_token: "drain-owner",
                        },
                    };
                },
            };

            const stalePull = pullAndApplyMirrorPage({
                db: pullDb,
                module: pullModule,
                domain: "memories",
                limit: 1,
            });
            await waitingForA2.promise;
            const drained = await drainAuthority({
                db: drainDb,
                projectPath: "/repo",
                domain: "memories",
                module: drainModule,
                checksum: "same",
            });
            releaseA2.resolve();
            await stalePull;

            expect(drained.state).toBe("TS");
            expect(
                pullDb
                    .prepare(
                        "SELECT module_project FROM mirror_live_memory_rows ORDER BY module_row_id",
                    )
                    .all(),
            ).toEqual([{ module_project: "B-1" }, { module_project: "B-2" }]);
            expect(pullDb.prepare("SELECT status FROM mirror_resnapshot_state").get()).toEqual({
                status: "complete",
            });
        } finally {
            pullDb.close();
            drainDb.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("re-captures and replays when drain finish reports a later feed head", async () => {
        const database = db();
        let begins = 0;
        let finishes = 0;
        let state: AuthorityStatus["state"] = "DRAINING";
        const module: AuthorityModuleClient = {
            authorityStatus: async (args) => ({
                authority: { ...authority(state, 2), domain: args.domain },
            }),
            authorityPrepare: async () => ({ authority: authority("MODULE", 2) }),
            mirrorPull: async (args) => ({
                page: {
                    domain: "memories",
                    cursor: args.cursor,
                    next_cursor: 1,
                    has_more: false,
                    rows: [
                        {
                            feed_seq: 1,
                            domain: "memories",
                            op: "insert",
                            module_row_id: 1,
                            full_row_snapshot: {
                                id: 1,
                                project_path: "/repo",
                                category: "CONSTRAINTS",
                                content: "late memory",
                                normalized_hash: "late-hash",
                                status: "active",
                            },
                            content_hash: "late-hash",
                        },
                    ],
                },
            }),
            authorityDrain: async (args) => {
                if (args.action === "begin") begins += 1;
                if (args.action === "finish") {
                    finishes += 1;
                    if (finishes === 1) {
                        const error = new Error("authority_feed_head_advanced") as Error & {
                            code: string;
                        };
                        error.code = "authority_feed_head_advanced";
                        throw error;
                    }
                    state = "TS";
                }
                return {
                    authority: {
                        ...authority(state, 2),
                        domain: "memories",
                        captured_upper_bound: begins === 1 ? 0 : 1,
                        coordinator_token: `token-${begins}`,
                    },
                };
            },
        };

        const result = await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "memories",
            module,
            checksum: "same",
        });
        expect({ begins, finishes, state: result.state }).toEqual({
            begins: 2,
            finishes: 2,
            state: "TS",
        });
        expect(
            database.prepare("SELECT cursor FROM mirror_cursors WHERE domain = 'memories'").get(),
        ).toEqual({ cursor: 1 });
    });

    test("bounds steady drain contention and leaves a retryable durable DRAINING state", async () => {
        const database = db();
        let begins = 0;
        let finishes = 0;
        let keepContending = true;
        let state: AuthorityStatus["state"] = "DRAINING";
        const module: AuthorityModuleClient = {
            authorityStatus: async (args) => ({
                authority: { ...authority(state, 2), domain: args.domain },
            }),
            authorityPrepare: async () => ({ authority: authority("MODULE", 2) }),
            mirrorPull: async (args) => ({
                page: {
                    domain: args.domain,
                    cursor: args.cursor,
                    next_cursor: args.cursor,
                    has_more: false,
                    rows: [],
                },
            }),
            authorityDrain: async (args) => {
                if (args.action === "begin") begins += 1;
                if (args.action === "finish") {
                    finishes += 1;
                    if (keepContending) {
                        const error = new Error("authority_feed_head_advanced") as Error & {
                            code: string;
                        };
                        error.code = "authority_feed_head_advanced";
                        throw error;
                    }
                    state = "TS";
                }
                return {
                    authority: {
                        ...authority(state, 2),
                        captured_upper_bound: 0,
                        coordinator_token: `token-${begins}`,
                    },
                };
            },
        };

        const contended = await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "memories",
            module,
            checksum: "same",
        });
        expect(contended).toMatchObject({
            code: "authority_drain_contended",
            retryable: true,
            state: "DRAINING",
            attempts: 5,
        });
        expect({ begins, finishes }).toEqual({ begins: 6, finishes: 6 });
        expect(
            (
                await module.authorityStatus({
                    context_store_uuid: "store",
                    project: "/repo",
                    domain: "memories",
                })
            ).authority?.state,
        ).toBe("DRAINING");

        keepContending = false;
        const resumed = await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "memories",
            module,
            checksum: "same",
        });
        expect(resumed.state).toBe("TS");
        expect({ begins, finishes }).toEqual({ begins: 7, finishes: 7 });
    });

    test("drain finish removes the marker only after module ownership returns to TS", async () => {
        const database = db();
        installAuthorityManagedMarker(database, "/repo");
        let generation = 1;
        let memoryState: AuthorityStatus["state"] = "MODULE";
        const module: AuthorityModuleClient = {
            authorityStatus: async (args) => ({
                authority:
                    args.domain === "memories"
                        ? { ...authority(memoryState, generation), domain: args.domain }
                        : { ...authority("TS", generation), domain: args.domain },
            }),
            authorityPrepare: async () => ({ authority: authority("MODULE", generation) }),
            authoritySeed: async () => ({ seeded: 0 }),
            mirrorPull: async () => ({
                page: { domain: "memories", cursor: 0, next_cursor: 0, has_more: false, rows: [] },
            }),
            authorityDrain: async (args) => {
                memoryState = args.action === "finish" ? "TS" : "DRAINING";
                return {
                    authority: {
                        ...authority(memoryState, ++generation),
                        coordinator_token: "tok-live",
                    },
                };
            },
        };
        const result = await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "memories",
            module,
            checksum: "same",
        });
        expect(result.state).toBe("TS");
        expect(getAuthorityManagedMarker(database, "/repo")).toBeNull();
    });

    test("installs the marker before reading the stable seed set", async () => {
        const database = db();
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'before marker', 'h1', 0, 0, 0, 0)",
                )
                .run("/repo");
        });
        let seededIds: number[] = [];
        await prepareAuthority({
            db: database,
            projectPath: "/repo",
            domains: ["memories"],
            module: protocol({ bytes: [] }),
            seedPages: async () => {
                expect(() =>
                    database
                        .prepare(
                            "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'after marker', 'h2', 0, 0, 0, 0)",
                        )
                        .run("/repo"),
                ).toThrow("managed by the Rust module");
                const rows = database
                    .prepare("SELECT * FROM memories WHERE project_path = ? ORDER BY id")
                    .all("/repo") as Array<Record<string, unknown>>;
                seededIds = rows.map((row) => Number(row.id));
                return rows.map((snapshot) => ({ source_row_id: snapshot.id, snapshot }));
            },
        });
        expect(seededIds).toEqual([1]);
    });

    test("does not hold a SQLite transaction while module transport is delayed", async () => {
        const database = db();
        database.exec("CREATE TABLE unrelated_writer_probe(id INTEGER PRIMARY KEY, value TEXT)");
        let releaseBegin: (() => void) | undefined;
        const beginGate = new Promise<void>((resolve) => {
            releaseBegin = resolve;
        });
        const module = protocol({ bytes: [] });
        const ordinaryPrepare = module.authorityPrepare;
        module.authorityPrepare = async (args) => {
            if (args.phase === "begin") await beginGate;
            return ordinaryPrepare(args);
        };
        const preparation = prepareAuthority({
            db: database,
            projectPath: "/repo",
            domains: ["memories"],
            module,
            seedPages: async () => [],
        });
        await Promise.resolve();
        database
            .prepare("INSERT INTO unrelated_writer_probe(value) VALUES ('writer was not blocked')")
            .run();
        releaseBegin?.();
        await preparation;
        expect(
            database.prepare("SELECT COUNT(*) AS count FROM unrelated_writer_probe").get(),
        ).toEqual({
            count: 1,
        });
    });

    test("restart reconciliation reinstalls a missing marker before tools can write", async () => {
        const database = db();
        const module = protocol({ bytes: [] });
        module.authorityStatus = async (args) => ({
            authority: { ...authority("MODULE", 2), domain: args.domain },
        });
        await reconcileAuthorityProject({ db: database, projectPath: "/repo", module });
        expect(getAuthorityManagedMarker(database, "/repo")).not.toBeNull();
        expect(() =>
            database
                .prepare(
                    "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'blocked', 'h', 0, 0, 0, 0)",
                )
                .run("/repo"),
        ).toThrow("managed by the Rust module");
    });

    test("resolves superseded references introduced on a later mirror page", () => {
        const database = db();
        const memory = (id: number, supersededBy: number | null) => ({
            id,
            project_path: "/repo",
            category: "CONSTRAINTS",
            content: `memory ${id}`,
            normalized_hash: `h${id}`,
            scope: "project",
            shareable: 0,
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 0,
            created_at: 0,
            updated_at: 0,
            last_seen_at: 0,
            status: "active",
            verification_status: "unverified",
            superseded_by_memory_id: supersededBy,
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: true,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 10,
                        full_row_snapshot: memory(10, 20),
                        content_hash: "h10",
                    },
                ],
            },
        });
        expect(database.prepare("SELECT superseded_by_memory_id FROM memories").get()).toEqual({
            superseded_by_memory_id: null,
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 1,
                next_cursor: 2,
                has_more: false,
                rows: [
                    {
                        feed_seq: 2,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 20,
                        full_row_snapshot: memory(20, null),
                        content_hash: "h20",
                    },
                ],
            },
        });
        const rows = database
            .prepare("SELECT id, superseded_by_memory_id FROM memories ORDER BY id")
            .all() as Array<{ id: number; superseded_by_memory_id: number | null }>;
        expect(rows[0]?.superseded_by_memory_id).toBe(rows[1]?.id);
    });

    test("privileged same-connection UPDATE between capture and verify aborts prepare", async () => {
        const database = db();
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'seed', 'h1', 0, 0, 0, 0)",
                )
                .run("/repo");
        });
        const module = protocol({ bytes: [] });
        const ordinaryPrepare = module.authorityPrepare;
        module.authorityPrepare = async (args) => {
            if (args.phase === "complete") {
                withPrivilegedWriter(database, () => {
                    database
                        .prepare("UPDATE memories SET content = 'drifted' WHERE project_path = ?")
                        .run("/repo");
                    bumpDomainMutationEpoch(database, "/repo", "memories");
                });
            }
            return ordinaryPrepare(args);
        };
        await expect(
            prepareAuthority({
                db: database,
                projectPath: "/repo",
                domains: ["memories"],
                module,
                seedPages: async () => {
                    const rows = database
                        .prepare("SELECT * FROM memories WHERE project_path = ? ORDER BY id")
                        .all("/repo") as Array<Record<string, unknown>>;
                    return rows.map((snapshot) => ({ source_row_id: snapshot.id, snapshot }));
                },
            }),
        ).rejects.toThrow("authority capture bound changed");
        expect(getAuthorityManagedMarker(database, "/repo")).toBeNull();
    });

    test("unmapped tombstone clears pending references without resurrecting the source", () => {
        const database = db();
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: true,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 10,
                        full_row_snapshot: {
                            id: 10,
                            project_path: "/repo",
                            category: "CONSTRAINTS",
                            content: "source",
                            normalized_hash: "h10",
                            scope: "project",
                            shareable: 0,
                            seen_count: 1,
                            retrieval_count: 0,
                            first_seen_at: 0,
                            created_at: 0,
                            updated_at: 0,
                            last_seen_at: 0,
                            status: "active",
                            verification_status: "unverified",
                            superseded_by_memory_id: 99,
                        },
                        content_hash: "h10",
                    },
                ],
            },
        });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get() as {
                c: number;
            },
        ).toEqual({ c: 1 });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 1,
                next_cursor: 2,
                has_more: false,
                rows: [
                    {
                        feed_seq: 2,
                        domain: "memories",
                        op: "tombstone",
                        module_row_id: 99,
                        full_row_snapshot: {
                            id: 99,
                            project_path: "/repo",
                            category: "CONSTRAINTS",
                            content: "",
                            normalized_hash: "",
                        },
                        content_hash: null,
                    },
                ],
            },
        });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get() as {
                c: number;
            },
        ).toEqual({ c: 0 });
        expect(
            database.prepare("SELECT superseded_by_memory_id FROM memories WHERE id = 1").get(),
        ).toEqual({ superseded_by_memory_id: null });
    });

    test("foreign archived expired and unshareable rows stay hidden on the id search path", () => {
        const database = db();
        const now = Date.now();
        database
            .prepare(
                "INSERT INTO workspaces(id, name, created_at, updated_at, share_categories) VALUES (1, 'ws', 0, 0, ?)",
            )
            .run(JSON.stringify(["CONSTRAINTS"]));
        database
            .prepare(
                "INSERT INTO workspace_members(workspace_id, project_path, display_name, display_path, added_at) VALUES (1, '/own', 'own', '/own', 0), (1, '/foreign', 'foreign', '/foreign', 0)",
            )
            .run();
        runInMemoryClaimsWriteTransaction(database, () => {
            database
                .prepare(
                    `INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, status, shareable, scope, expires_at)
                 VALUES
                 ('/own', 'CONSTRAINTS', 'own archived', 'h1', 0, 0, 0, 0, 'archived', 0, 'project', NULL),
                 ('/foreign', 'CONSTRAINTS', 'foreign archived', 'h2', 0, 0, 0, 0, 'archived', 1, 'project', NULL),
                 ('/foreign', 'CONSTRAINTS', 'foreign expired', 'h3', 0, 0, 0, 0, 'active', 1, 'project', ?),
                 ('/foreign', 'CONSTRAINTS', 'foreign private', 'h4', 0, 0, 0, 0, 'active', 0, 'project', NULL),
                 ('/foreign', 'CONSTRAINTS', 'foreign visible', 'h5', 0, 0, 0, 0, 'active', 1, 'project', NULL)`,
                )
                .run(now - 1);
        });
        const rows = getMemoriesByProjects(
            database,
            ["/own", "/foreign"],
            ["active", "permanent", "archived"],
            now,
            ["/own"],
            ["CONSTRAINTS"],
        );
        const contents = rows.map((row) => row.content).sort();
        expect(contents).toEqual(["foreign visible", "own archived"]);
        const idPath = resolveMemoriesByIdsForSearch({
            db: database,
            projectPath: "/own",
            ids: [1, 2, 3, 4, 5],
            limit: 10,
        });
        expect(idPath?.map((hit) => hit.content).sort()).toEqual([
            "foreign visible",
            "own archived",
        ]);
    });

    test("note evaluation bridges are scoped per project", async () => {
        const calls: string[] = [];
        registerModuleNoteEvaluationBridge("/project-a", "/checkout-a", {
            sync: async () => {
                calls.push("sync-a");
            },
            drain: async () => {
                calls.push("drain-a");
                return { claimed: 0, completed: 0, abandoned: 0, surfaced: 0, drained: true };
            },
            available: () => true,
            dispose: async () => {},
        });
        expect(getModuleNoteEvaluationBridge("/project-a")).toBeDefined();
        expect(getModuleNoteEvaluationBridge("/project-a", "/checkout-a")).toBeDefined();
        expect(getModuleNoteEvaluationBridge("/project-a", "/checkout-b")).toBeUndefined();
        expect(getModuleNoteEvaluationBridge("/project-b")).toBeUndefined();
        await getModuleNoteEvaluationBridge("/project-a")?.drain({ deadline: Date.now() + 1000 });
        expect(calls).toEqual(["drain-a"]);
    });

    test("worktrees sharing an identity hold distinct bridges per checkout root", async () => {
        const drained: string[] = [];
        const bridge = (label: string) => ({
            sync: async () => {},
            drain: async () => {
                drained.push(label);
                return { claimed: 0, completed: 0, abandoned: 0, surfaced: 0, drained: true };
            },
            available: () => true,
            dispose: async () => {},
        });
        const keyA = registerModuleNoteEvaluationBridge("/shared-id", "/worktree-a", bridge("a"));
        const keyB = registerModuleNoteEvaluationBridge("/shared-id", "/worktree-b", bridge("b"));
        expect(keyA).not.toBe(keyB);
        await getModuleNoteEvaluationBridge("/shared-id", "/worktree-b")?.drain({
            deadline: Date.now() + 1000,
        });
        expect(drained).toEqual(["b"]);
        // Disposing one checkout's bridge leaves the sibling registered.
        await import("./context-authority").then((m) =>
            m.disposeModuleNoteEvaluationBridges([keyA]),
        );
        expect(getModuleNoteEvaluationBridge("/shared-id", "/worktree-a")).toBeUndefined();
        expect(getModuleNoteEvaluationBridge("/shared-id", "/worktree-b")).toBeDefined();
    });

    test("module-managed memory search skips retrieval_count writes", async () => {
        const database = db();
        installAuthorityManagedMarker(database, "/repo");
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, status) VALUES (?, 'CONSTRAINTS', 'search me unique-token-xyz', 'h', 0, 0, 0, 0, 'active')",
                )
                .run("/repo");
        });
        const before = database
            .prepare("SELECT retrieval_count AS c FROM memories WHERE id = 1")
            .get() as { c: number };
        const results = await unifiedSearch(database, "session", "/repo", "unique-token-xyz", {
            memoryEnabled: true,
            embeddingEnabled: false,
            countRetrievals: true,
        });
        expect(results.some((result) => result.source === "memory")).toBe(true);
        const after = database
            .prepare("SELECT retrieval_count AS c FROM memories WHERE id = 1")
            .get() as { c: number };
        expect(after.c).toBe(before.c);
    });

    test("sparse mirror update preserves an advanced stats timestamp", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    `INSERT INTO memories(
                        id, project_path, category, content, normalized_hash,
                        seen_count, retrieval_count, first_seen_at, created_at, updated_at,
                        last_seen_at, status
                     ) VALUES (7, '/repo', 'CONSTRAINTS', 'sparse memory', 'sparse-hash',
                               1, 0, 100, 100, 100, 100, 'active')`,
                )
                .run();
            // Telemetry has advanced the stats clock past the frozen base row.
            database.prepare("UPDATE memory_stats SET updated_at = 500 WHERE memory_id = 7").run();
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "update",
                        module_row_id: 70,
                        content_hash: "sparse-hash",
                        // Sparse legacy snapshot: bumps a telemetry field but
                        // omits updated_at ("unchanged").
                        full_row_snapshot: {
                            id: 70,
                            project_path: "/repo",
                            category: "CONSTRAINTS",
                            normalized_hash: "sparse-hash",
                            seen_count: 3,
                            context_store_uuid: storeUuid,
                            context_row_id: 7,
                        },
                    },
                ],
            },
        });
        expect(
            database
                .prepare("SELECT seen_count, updated_at FROM memory_stats WHERE memory_id = 7")
                .get(),
        ).toEqual({ seen_count: 3, updated_at: 500 });
    });

    test("a mirror telemetry write onto a missing stats row surfaces as corruption", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    `INSERT INTO memories(
                        id, project_path, category, content, normalized_hash,
                        seen_count, retrieval_count, first_seen_at, created_at, updated_at,
                        last_seen_at, status
                     ) VALUES (8, '/repo', 'CONSTRAINTS', 'orphan memory', 'orphan-hash',
                               1, 0, 100, 100, 100, 100, 'active')`,
                )
                .run();
            database.prepare("DELETE FROM memory_stats WHERE memory_id = 8").run();
        });
        expect(() =>
            applyMirrorPage({
                db: database,
                page: {
                    domain: "memories",
                    cursor: 0,
                    next_cursor: 1,
                    has_more: false,
                    rows: [
                        {
                            feed_seq: 1,
                            domain: "memories",
                            op: "update",
                            module_row_id: 80,
                            content_hash: "orphan-hash",
                            full_row_snapshot: {
                                id: 80,
                                project_path: "/repo",
                                category: "CONSTRAINTS",
                                normalized_hash: "orphan-hash",
                                seen_count: 5,
                                context_store_uuid: storeUuid,
                                context_row_id: 8,
                            },
                        },
                    ],
                },
            }),
        ).toThrow(/memory_stats row missing for memory 8/);
    });
});

describe("module mirror claims (v84)", () => {
    const MODULE_PROJECT = "git:mirror-module";

    function moduleSnapshot(
        id: number,
        content: string,
        hash: string,
        extra: Record<string, unknown> = {},
    ): Record<string, unknown> {
        return {
            id,
            project_path: MODULE_PROJECT,
            category: "CONSTRAINTS",
            content,
            normalized_hash: hash,
            importance: 50,
            scope: "project",
            shareable: 0,
            source_session_id: null,
            source_type: "agent",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 0,
            created_at: 0,
            updated_at: 1,
            last_seen_at: 1,
            last_retrieved_at: null,
            status: "active",
            expires_at: null,
            verification_status: "unverified",
            verified_at: null,
            classified_at: null,
            superseded_by_memory_id: null,
            merged_from: null,
            metadata_json: null,
            context_store_uuid: null,
            context_row_id: null,
            mural_cue: null,
            mural_cue_hash: null,
            mural_cue_at: null,
            mural_cue_rejection_count: 0,
            ...extra,
        };
    }

    function page(
        cursor: number,
        rows: Array<{
            feedSeq: number;
            op: "insert" | "update" | "tombstone";
            moduleRowId: number;
            snapshot: Record<string, unknown>;
        }>,
    ): ChangefeedPage {
        return {
            domain: "memories",
            cursor,
            next_cursor: rows.at(-1)?.feedSeq ?? cursor,
            has_more: false,
            rows: rows.map((row) => ({
                feed_seq: row.feedSeq,
                domain: "memories" as const,
                op: row.op,
                module_row_id: row.moduleRowId,
                full_row_snapshot: row.snapshot,
                content_hash: String(row.snapshot.normalized_hash ?? ""),
            })),
        };
    }

    function claimState(database: Database) {
        return {
            revisions: (
                database.prepare("SELECT COUNT(*) AS c FROM claim_revisions").get() as {
                    c: number;
                }
            ).c,
            crosswalk: database
                .prepare(
                    "SELECT memory_id, canonical_memory_id, claim_id FROM legacy_memory_claims ORDER BY memory_id",
                )
                .all() as Array<{ memory_id: number; canonical_memory_id: number }>,
            outbox: database
                .prepare(
                    "SELECT effect_key, effect_type, generation FROM claim_change_outbox ORDER BY id",
                )
                .all() as Array<{ effect_key: string; effect_type: string; generation: number }>,
            generations: database
                .prepare(
                    "SELECT project_id, generation FROM claim_project_generations ORDER BY project_id",
                )
                .all() as Array<{ project_id: number; generation: number }>,
            conflicts: (
                database.prepare("SELECT COUNT(*) AS c FROM claim_conflicts").get() as {
                    c: number;
                }
            ).c,
        };
    }

    function resetCursorForReplay(database: Database): void {
        withPrivilegedWriter(database, () => {
            database
                .prepare("UPDATE mirror_cursors SET cursor = 0 WHERE domain = 'memories'")
                .run();
        });
    }

    test("a module insert commits claim, projection, outbox, generation, and feed cursor in one transaction", () => {
        const database = db();
        applyMirrorPage({
            db: database,
            page: page(0, [
                {
                    feedSeq: 1,
                    op: "insert",
                    moduleRowId: 11,
                    snapshot: moduleSnapshot(11, "module fact", "mm-h1"),
                },
            ]),
        });

        const memory = database
            .prepare(
                "SELECT id, content, project_path FROM memories WHERE normalized_hash = 'mm-h1'",
            )
            .get() as { id: number; content: string; project_path: string };
        expect(memory.content).toBe("module fact");
        expect(memory.project_path).toBe(MODULE_PROJECT);

        const state = claimState(database);
        expect(state.revisions).toBe(1);
        expect(state.crosswalk).toEqual([
            expect.objectContaining({ memory_id: memory.id, canonical_memory_id: memory.id }),
        ]);
        expect(state.outbox).toEqual([
            { effect_key: `memory:${memory.id}:upsert`, effect_type: "upsert", generation: 1 },
        ]);
        expect(state.generations).toEqual([expect.objectContaining({ generation: 1 })]);
        expect(
            database
                .prepare("SELECT producer, operation_key FROM claim_operations ORDER BY id")
                .all(),
        ).toEqual([
            { producer: "module-mirror", operation_key: `memories:${MODULE_PROJECT}:11:1` },
        ]);
        const metadata = database
            .prepare(
                `SELECT meta.category, meta.normalized_hash FROM claim_revision_memory_metadata meta`,
            )
            .get();
        expect(metadata).toEqual({ category: "CONSTRAINTS", normalized_hash: "mm-h1" });
        expect(getMirrorCursor(database, "memories")).toBe(1);
    });

    test("a multi-row page and relationship envelope share one project generation", () => {
        const database = db();
        const relationshipPage = page(0, [
            {
                feedSeq: 1,
                op: "insert",
                moduleRowId: 1,
                snapshot: moduleSnapshot(1, "relationship source", "mm-rel-1", {
                    superseded_by_memory_id: 2,
                }),
            },
            {
                feedSeq: 2,
                op: "insert",
                moduleRowId: 2,
                snapshot: moduleSnapshot(2, "relationship target", "mm-rel-2", {
                    merged_from: "[1]",
                }),
            },
        ]);
        applyMirrorPage({ db: database, page: relationshipPage });

        const generations = database
            .prepare("SELECT generation FROM claim_project_generations")
            .all() as Array<{ generation: number }>;
        expect(generations).toEqual([{ generation: 1 }]);
        expect(
            database.prepare("SELECT DISTINCT generation FROM claim_change_outbox").all(),
        ).toEqual([{ generation: 1 }]);
        expect(database.prepare("SELECT COUNT(*) AS count FROM claim_conflicts").get()).toEqual({
            count: 1,
        });
        expect(
            database
                .prepare(
                    `SELECT reason_code, disposition FROM claim_backfill_failures
                      WHERE item_kind = 'lineage' ORDER BY id DESC LIMIT 1`,
                )
                .get(),
        ).toEqual({ reason_code: "translated-lineage", disposition: "resolved" });
        expect(
            database
                .prepare(
                    "SELECT merged_from FROM claim_memory_relationship_sources WHERE memory_id = 2 ORDER BY id DESC LIMIT 1",
                )
                .get(),
        ).toEqual({ merged_from: "[1]" });

        const before = JSON.stringify(claimState(database));
        resetCursorForReplay(database);
        applyMirrorPage({ db: database, page: relationshipPage });
        expect(JSON.stringify(claimState(database))).toBe(before);
        expect(database.prepare("SELECT generation FROM claim_project_generations").get()).toEqual({
            generation: 1,
        });
    });

    test("a content-changing snapshot appends one revision; telemetry-only and exact replay append none", () => {
        const database = db();
        const insertPage = page(0, [
            {
                feedSeq: 1,
                op: "insert",
                moduleRowId: 11,
                snapshot: moduleSnapshot(11, "v1", "mm-h1"),
            },
        ]);
        applyMirrorPage({ db: database, page: insertPage });

        const contentPage = page(1, [
            {
                feedSeq: 2,
                op: "update",
                moduleRowId: 11,
                snapshot: moduleSnapshot(11, "v2", "mm-h2"),
            },
        ]);
        applyMirrorPage({ db: database, page: contentPage });
        const afterContent = claimState(database);
        expect(afterContent.revisions).toBe(2);
        expect(afterContent.outbox).toHaveLength(2);
        expect(afterContent.generations).toEqual([expect.objectContaining({ generation: 2 })]);

        // Telemetry-only: new feed sequence, unchanged semantic state.
        const telemetryPage = page(2, [
            {
                feedSeq: 3,
                op: "update",
                moduleRowId: 11,
                snapshot: moduleSnapshot(11, "v2", "mm-h2", {
                    seen_count: 7,
                    last_seen_at: 900,
                    updated_at: 900,
                }),
            },
        ]);
        applyMirrorPage({ db: database, page: telemetryPage });
        const afterTelemetry = claimState(database);
        expect(afterTelemetry.revisions).toBe(2);
        expect(afterTelemetry.outbox).toHaveLength(2);
        expect(afterTelemetry.generations).toEqual([expect.objectContaining({ generation: 2 })]);
        expect(database.prepare("SELECT seen_count FROM memory_stats").get()).toEqual({
            seen_count: 7,
        });

        // Exact replay of every applied page from cursor zero.
        const before = JSON.stringify(claimState(database));
        resetCursorForReplay(database);
        applyMirrorPage({ db: database, page: insertPage });
        applyMirrorPage({ db: database, page: contentPage });
        applyMirrorPage({ db: database, page: telemetryPage });
        expect(JSON.stringify(claimState(database))).toBe(before);
        expect(getMirrorCursor(database, "memories")).toBe(3);
    });

    test("a module tombstone adopts an unlinked preimage, retires the claim, removes the projection, and commits the cursor", () => {
        const database = db();
        const memoryId = runInMemoryClaimsWriteTransaction(database, () => {
            const result = database
                .prepare(
                    `INSERT INTO memories (project_path, category, content, normalized_hash,
                        first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?, 'CONSTRAINTS', 'preimage fact', 'mm-pre', 1, 1, 1, 1)`,
                )
                .run(MODULE_PROJECT) as { lastInsertRowid: number | bigint };
            return Number(result.lastInsertRowid);
        });
        expect(database.prepare("SELECT COUNT(*) AS c FROM legacy_memory_claims").get()).toEqual({
            c: 0,
        });
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, 31, ?)",
                )
                .run(MODULE_PROJECT, memoryId);
        });

        applyMirrorPage({
            db: database,
            page: page(0, [
                {
                    feedSeq: 1,
                    op: "tombstone",
                    moduleRowId: 31,
                    snapshot: moduleSnapshot(31, "preimage fact", "mm-pre"),
                },
            ]),
        });

        expect(
            database.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(memoryId),
        ).toEqual({ c: 0 });
        const link = database
            .prepare("SELECT memory_id, claim_id FROM legacy_memory_claims WHERE memory_id = ?")
            .get(memoryId) as { claim_id: number };
        expect(link).toBeDefined();
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(link.claim_id),
        ).toEqual({ state: "archived" });
        expect(
            database
                .prepare("SELECT content FROM claim_revisions WHERE claim_id = ?")
                .all(link.claim_id),
        ).toEqual([{ content: "preimage fact" }]);
        expect(claimState(database).outbox).toEqual([
            { effect_key: `memory:${memoryId}:upsert`, effect_type: "upsert", generation: 1 },
            { effect_key: `memory:${memoryId}:lifecycle`, effect_type: "lifecycle", generation: 1 },
        ]);
        expect(getMirrorCursor(database, "memories")).toBe(1);
    });

    test("store.db may already be committed while context.db is pending: a mid-page failure rolls back the whole page and the replayed page converges", () => {
        const database = db();
        // The module committed this page to store.db before mirroring; the
        // context.db application is the only side under test here — the two
        // databases share no transaction.
        const twoRowPage = page(0, [
            {
                feedSeq: 1,
                op: "insert",
                moduleRowId: 11,
                snapshot: moduleSnapshot(11, "first", "mm-h1"),
            },
            {
                feedSeq: 2,
                op: "insert",
                moduleRowId: 12,
                snapshot: moduleSnapshot(12, "second", "mm-h2"),
            },
        ]);
        let claimHits = 0;
        setMemoryClaimFailpoint("memory-claim.010.claim.after", () => {
            claimHits += 1;
            if (claimHits === 2) throw new Error("injected mid-page failure");
        });
        try {
            expect(() => applyMirrorPage({ db: database, page: twoRowPage })).toThrow(
                /injected mid-page failure/,
            );
        } finally {
            clearMemoryClaimFailpoints();
        }

        // Complete pre-page state: nothing from either row survived.
        expect(database.prepare("SELECT COUNT(*) AS c FROM memories").get()).toEqual({ c: 0 });
        expect(database.prepare("SELECT COUNT(*) AS c FROM claims").get()).toEqual({ c: 0 });
        expect(database.prepare("SELECT COUNT(*) AS c FROM claim_operations").get()).toEqual({
            c: 0,
        });
        expect(database.prepare("SELECT COUNT(*) AS c FROM claim_change_outbox").get()).toEqual({
            c: 0,
        });
        expect(getMirrorCursor(database, "memories")).toBe(0);

        // The module replays the same committed page; context.db converges.
        applyMirrorPage({ db: database, page: twoRowPage });
        expect(database.prepare("SELECT COUNT(*) AS c FROM memories").get()).toEqual({ c: 2 });
        const state = claimState(database);
        expect(state.revisions).toBe(2);
        expect(state.outbox).toHaveLength(2);
        expect(getMirrorCursor(database, "memories")).toBe(2);
    });

    test("a pending supersession resolves when its target arrives without duplicate lineage on replay", () => {
        const database = db();
        const sourcePage = page(0, [
            {
                feedSeq: 1,
                op: "insert",
                moduleRowId: 11,
                snapshot: moduleSnapshot(11, "old fact", "mm-h1", {
                    superseded_by_memory_id: 12,
                    status: "archived",
                }),
            },
        ]);
        applyMirrorPage({ db: database, page: sourcePage });
        expect(claimState(database).conflicts).toBe(0);
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 1 });

        const targetPage = page(1, [
            {
                feedSeq: 2,
                op: "insert",
                moduleRowId: 12,
                snapshot: moduleSnapshot(12, "new fact", "mm-h2"),
            },
        ]);
        applyMirrorPage({ db: database, page: targetPage });
        const sourceId = (
            database.prepare("SELECT id FROM memories WHERE normalized_hash = 'mm-h1'").get() as {
                id: number;
            }
        ).id;
        const targetId = (
            database.prepare("SELECT id FROM memories WHERE normalized_hash = 'mm-h2'").get() as {
                id: number;
            }
        ).id;
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ s: targetId });
        expect(claimState(database).conflicts).toBe(1);
        expect(
            database
                .prepare("SELECT COUNT(*) AS c FROM claim_operations WHERE operation_key = ?")
                .get(`memories:supersede:${sourceId}:${targetId}`),
        ).toEqual({ c: 1 });

        // Page replay re-creates and re-resolves the pending reference.
        resetCursorForReplay(database);
        applyMirrorPage({ db: database, page: sourcePage });
        applyMirrorPage({ db: database, page: targetPage });
        expect(claimState(database).conflicts).toBe(1);
        expect(database.prepare("SELECT COUNT(*) AS c FROM claim_merge_lineage").get()).toEqual({
            c: 0,
        });
    });

    test("a placeholder-empty supersession target keeps its pending reference instead of committing a false pair envelope", () => {
        const database = db();
        // The target module row 12 arrives only as a sparse snapshot, so the
        // mirror mints a placeholder-empty context row for it.
        const sparsePage = page(0, [
            {
                feedSeq: 1,
                op: "insert",
                moduleRowId: 11,
                snapshot: moduleSnapshot(11, "old fact", "mm-h1", {
                    superseded_by_memory_id: 12,
                }),
            },
            {
                feedSeq: 2,
                op: "insert",
                moduleRowId: 12,
                snapshot: {
                    id: 12,
                    project_path: MODULE_PROJECT,
                    category: "CONSTRAINTS",
                    updated_at: 1,
                    last_seen_at: 1,
                },
            },
        ]);
        applyMirrorPage({ db: database, page: sparsePage });

        // The pair is not yet adoptable: the pending reference survives, no
        // supersede envelope is committed, and the pointer stays untranslated.
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 1 });
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS c FROM claim_operations WHERE operation_key LIKE 'memories:supersede:%'",
                )
                .get(),
        ).toEqual({ c: 0 });
        expect(
            database
                .prepare(
                    "SELECT superseded_by_memory_id AS s FROM memories WHERE normalized_hash = 'mm-h1'",
                )
                .get(),
        ).toEqual({ s: null });
        expect(claimState(database).conflicts).toBe(0);

        // The target's real content arrives: the pair completes — pointer
        // written, claim supersession edge recorded, pending reference gone.
        const contentPage = page(2, [
            {
                feedSeq: 3,
                op: "update",
                moduleRowId: 12,
                snapshot: moduleSnapshot(12, "new fact", "mm-h2"),
            },
        ]);
        applyMirrorPage({ db: database, page: contentPage });
        const sourceId = (
            database.prepare("SELECT id FROM memories WHERE normalized_hash = 'mm-h1'").get() as {
                id: number;
            }
        ).id;
        const targetId = (
            database.prepare("SELECT id FROM memories WHERE normalized_hash = 'mm-h2'").get() as {
                id: number;
            }
        ).id;
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ s: targetId });
        expect(claimState(database).conflicts).toBe(1);
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 0 });
        expect(
            database
                .prepare("SELECT COUNT(*) AS c FROM claim_operations WHERE operation_key = ?")
                .get(`memories:supersede:${sourceId}:${targetId}`),
        ).toEqual({ c: 1 });
        expect(
            claimState(database).outbox.filter(
                (effect) => effect.effect_key === `memory:${targetId}:supersede`,
            ),
        ).toHaveLength(1);
        // The relationship-source snapshot reflects the written pointer, so
        // later relationship mutations on the source row pass the guard.
        expect(
            database
                .prepare(
                    `SELECT superseded_by_memory_id AS s FROM claim_memory_relationship_sources
                      WHERE memory_id = ? ORDER BY id DESC LIMIT 1`,
                )
                .get(sourceId),
        ).toEqual({ s: targetId });

        // Replay of both pages converges without duplicate lineage.
        const before = JSON.stringify(claimState(database));
        resetCursorForReplay(database);
        applyMirrorPage({ db: database, page: sparsePage });
        applyMirrorPage({ db: database, page: contentPage });
        expect(JSON.stringify(claimState(database))).toBe(before);
    });

    test("a mapped placeholder target does not translate through the per-row apply path", () => {
        const database = db();
        // The placeholder target is minted BEFORE the source row applies, so
        // the source sees a mapped target identity during its own apply; the
        // pair must still wait for adoptable content instead of writing a
        // pointer with no claim edge and no pending row left to retry. The
        // sparse snapshot carries a hash but no content, so the minted row
        // stays placeholder-empty without colliding with the source's mint.
        const sparsePage = page(0, [
            {
                feedSeq: 1,
                op: "insert",
                moduleRowId: 12,
                snapshot: {
                    id: 12,
                    project_path: MODULE_PROJECT,
                    category: "CONSTRAINTS",
                    normalized_hash: "mm-h2",
                    updated_at: 1,
                    last_seen_at: 1,
                },
            },
            {
                feedSeq: 2,
                op: "insert",
                moduleRowId: 11,
                snapshot: moduleSnapshot(11, "old fact", "mm-h1", {
                    superseded_by_memory_id: 12,
                }),
            },
        ]);
        applyMirrorPage({ db: database, page: sparsePage });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 1 });
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS c FROM claim_operations WHERE operation_key LIKE 'memories:supersede:%'",
                )
                .get(),
        ).toEqual({ c: 0 });
        expect(
            database
                .prepare(
                    "SELECT superseded_by_memory_id AS s FROM memories WHERE normalized_hash = 'mm-h1'",
                )
                .get(),
        ).toEqual({ s: null });

        applyMirrorPage({
            db: database,
            page: page(2, [
                {
                    feedSeq: 3,
                    op: "update",
                    moduleRowId: 12,
                    snapshot: moduleSnapshot(12, "new fact", "mm-h2"),
                },
            ]),
        });
        const rows = database
            .prepare("SELECT id, superseded_by_memory_id FROM memories ORDER BY id")
            .all() as Array<{ id: number; superseded_by_memory_id: number | null }>;
        const source = rows.find((row) => row.superseded_by_memory_id !== null);
        expect(source?.superseded_by_memory_id).toBe(rows.find((row) => row.id !== source?.id)?.id);
        expect(claimState(database).conflicts).toBe(1);
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 0 });
    });

    test("a claim-invalid supersession target keeps its pending reference until a repaired page links the pair", () => {
        const database = db();
        // The target carries real content but claim-invalid metadata, so the
        // content gate passes while adoption fails.
        const invalidPage = page(0, [
            {
                feedSeq: 1,
                op: "insert",
                moduleRowId: 11,
                snapshot: moduleSnapshot(11, "old fact", "mm-h1", {
                    superseded_by_memory_id: 12,
                }),
            },
            {
                feedSeq: 2,
                op: "insert",
                moduleRowId: 12,
                snapshot: moduleSnapshot(12, "new fact", "mm-h2", { scope: "bogus" }),
            },
        ]);
        applyMirrorPage({ db: database, page: invalidPage });

        const sourceId = (
            database.prepare("SELECT id FROM memories WHERE normalized_hash = 'mm-h1'").get() as {
                id: number;
            }
        ).id;
        const targetId = (
            database.prepare("SELECT id FROM memories WHERE normalized_hash = 'mm-h2'").get() as {
                id: number;
            }
        ).id;
        // Projection convergence: the pointer is written, but the pending
        // reference survives with no supersede envelope, so the pair stays
        // reachable for a retry after repair.
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ s: targetId });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 1 });
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS c FROM claim_operations WHERE operation_key LIKE 'memories:supersede:%'",
                )
                .get(),
        ).toEqual({ c: 0 });
        expect(claimState(database).conflicts).toBe(0);

        // The module repairs the target's metadata: the next page adopts the
        // target, records the claim edge, and clears the pending reference.
        const repairedPage = page(2, [
            {
                feedSeq: 3,
                op: "update",
                moduleRowId: 12,
                snapshot: moduleSnapshot(12, "new fact", "mm-h2"),
            },
        ]);
        applyMirrorPage({ db: database, page: repairedPage });
        expect(claimState(database).conflicts).toBe(1);
        expect(
            database
                .prepare("SELECT COUNT(*) AS c FROM claim_operations WHERE operation_key = ?")
                .get(`memories:supersede:${sourceId}:${targetId}`),
        ).toEqual({ c: 1 });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 0 });
        // The pointer predates the pair link, so the edge translates through
        // the lineage-snapshot path; exactly one supersession evidence effect
        // reaches the outbox.
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS c FROM claim_change_outbox
                      WHERE effect_type = 'evidence'
                        AND (effect_key = ? OR effect_key LIKE ?)`,
                )
                .get(`memory:${targetId}:supersede`, `memory:${sourceId}:relations:%:supersession`),
        ).toEqual({ c: 1 });
    });

    test("a claim-invalid lineage-bearing source skips the pointer write instead of aborting the page", () => {
        const database = db();
        // The source carries claim-invalid metadata AND nonblank merged_from,
        // so it cannot adopt (no relationship snapshot) while the projection
        // update installs lineage; the pointer write must be skipped or the
        // relationship guard would roll back the whole page.
        applyMirrorPage({
            db: database,
            page: page(0, [
                {
                    feedSeq: 1,
                    op: "insert",
                    moduleRowId: 11,
                    snapshot: moduleSnapshot(11, "old fact", "mm-lb-h1", {
                        superseded_by_memory_id: 12,
                        merged_from: "7",
                        scope: "bogus",
                    }),
                },
                {
                    feedSeq: 2,
                    op: "insert",
                    moduleRowId: 12,
                    snapshot: moduleSnapshot(12, "new fact", "mm-lb-h2"),
                },
            ]),
        });

        const sourceId = (
            database
                .prepare("SELECT id FROM memories WHERE normalized_hash = 'mm-lb-h1'")
                .get() as { id: number }
        ).id;
        const targetId = (
            database
                .prepare("SELECT id FROM memories WHERE normalized_hash = 'mm-lb-h2'")
                .get() as { id: number }
        ).id;
        // The page committed with the pointer write skipped: the pending
        // reference is the pair's retry driver, and the unadoptable source
        // records a blocking diagnostic.
        expect(getMirrorCursor(database, "memories")).toBe(2);
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ s: null });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 1 });
        expect(
            database
                .prepare(
                    "SELECT reason_code, disposition FROM claim_backfill_failures WHERE phase = 'rows' AND item_kind = 'memory' AND item_key = ?",
                )
                .get(String(sourceId)),
        ).toEqual({ reason_code: "invalid-scope", disposition: "blocking" });

        // The module repairs the source's metadata: the next page adopts both
        // endpoints, writes the pointer inside the pair envelope, and clears
        // the pending reference.
        applyMirrorPage({
            db: database,
            page: page(2, [
                {
                    feedSeq: 3,
                    op: "update",
                    moduleRowId: 11,
                    snapshot: moduleSnapshot(11, "old fact", "mm-lb-h1", {
                        superseded_by_memory_id: 12,
                        merged_from: "7",
                    }),
                },
            ]),
        });
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ s: targetId });
        expect(
            database
                .prepare("SELECT COUNT(*) AS c FROM claim_operations WHERE operation_key = ?")
                .get(`memories:supersede:${sourceId}:${targetId}`),
        ).toEqual({ c: 1 });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 0 });
        expect(readMemoryClaimLink(database, sourceId)).not.toBeNull();
        expect(readMemoryClaimLink(database, targetId)).not.toBeNull();
    });

    /** Pre-v84 mirrored corpus shape: two boundary rows (inserted before the
     * migration chain, so they never linked) mapped in mirror_identity with a
     * pending supersession reference between them. */
    function v82MirroredPendingPairDb(
        options: { targetScope?: string; sourceVerified?: boolean } = {},
    ): {
        database: Database;
        sourceId: number;
        targetId: number;
    } {
        const database = new Database(":memory:");
        initializeDatabase(database);
        const insert = database.prepare(
            `INSERT INTO memories (project_path, category, content, normalized_hash, scope,
                verification_status, verified_at, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?, 'CONSTRAINTS', ?, ?, ?, ?, ?, 1, 1, 1, 1)`,
        );
        const sourceId = Number(
            insert.run(
                MODULE_PROJECT,
                "old boundary fact",
                "mm-pp-h1",
                "project",
                options.sourceVerified ? "verified" : "unverified",
                options.sourceVerified ? 5 : null,
            ).lastInsertRowid,
        );
        const targetId = Number(
            insert.run(
                MODULE_PROJECT,
                "new boundary fact",
                "mm-pp-h2",
                options.targetScope ?? "project",
                "unverified",
                null,
            ).lastInsertRowid,
        );
        runMigrations(database);
        withPrivilegedWriter(database, () => {
            const identity = database.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, ?, ?)",
            );
            identity.run(MODULE_PROJECT, 11, sourceId);
            identity.run(MODULE_PROJECT, 12, targetId);
            database
                .prepare(
                    "INSERT INTO mirror_pending_references(domain, module_project, module_row_id, target_module_row_id) VALUES ('memories', ?, 11, 12)",
                )
                .run(MODULE_PROJECT);
        });
        return { database, sourceId, targetId };
    }

    test("a pending pair between two unlinked boundary rows adopts both endpoints with upsert effects in the pair envelope", () => {
        const { database, sourceId, targetId } = v82MirroredPendingPairDb();
        applyMirrorPage({
            db: database,
            page: page(0, [
                {
                    feedSeq: 1,
                    op: "insert",
                    moduleRowId: 99,
                    snapshot: moduleSnapshot(99, "unrelated fact", "mm-pp-h99"),
                },
            ]),
        });

        const sourceLink = readMemoryClaimLink(database, sourceId);
        const targetLink = readMemoryClaimLink(database, targetId);
        expect(sourceLink).not.toBeNull();
        expect(targetLink).not.toBeNull();
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ s: targetId });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 0 });
        expect(claimState(database).conflicts).toBe(1);

        // Both adoptions committed inside the pair envelope, each with its
        // upsert effect, plus the supersession evidence effect.
        const operation = database
            .prepare("SELECT id FROM claim_operations WHERE operation_key = ?")
            .get(`memories:supersede:${sourceId}:${targetId}`) as { id: number } | undefined;
        expect(operation).toBeDefined();
        const effectKeys = (
            database
                .prepare(
                    "SELECT effect_key FROM claim_change_outbox WHERE operation_id = ? ORDER BY effect_key",
                )
                .all(operation?.id) as Array<{ effect_key: string }>
        ).map((row) => row.effect_key);
        expect(effectKeys).toContain(`memory:${sourceId}:upsert`);
        expect(effectKeys).toContain(`memory:${targetId}:upsert`);
        expect(effectKeys).toContain(`memory:${targetId}:supersede`);

        // Boundary reconciliation is clean apart from the standing v22 gate:
        // both boundary rows carry links and outbox effects.
        expect(inspectClaimsBackfillReconciliation(database).problems).toEqual([
            "pending v22 identity work",
        ]);
    });

    test("a pending pair with an unadoptable target adopts neither endpoint and records a diagnostic", () => {
        const { database, sourceId, targetId } = v82MirroredPendingPairDb({
            targetScope: "bogus",
        });
        applyMirrorPage({
            db: database,
            page: page(0, [
                {
                    feedSeq: 1,
                    op: "insert",
                    moduleRowId: 99,
                    snapshot: moduleSnapshot(99, "unrelated fact", "mm-pp-h99"),
                },
            ]),
        });

        // No claim write outside an envelope: neither endpoint linked, no
        // pair envelope, only the unrelated feed row's claim exists.
        expect(readMemoryClaimLink(database, sourceId)).toBeNull();
        expect(readMemoryClaimLink(database, targetId)).toBeNull();
        expect(database.prepare("SELECT COUNT(*) AS c FROM claims").get()).toEqual({ c: 1 });
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS c FROM claim_operations WHERE operation_key LIKE 'memories:supersede:%'",
                )
                .get(),
        ).toEqual({ c: 0 });
        expect(claimState(database).conflicts).toBe(0);
        // Projection convergence: pointer written, pending reference retained
        // so a repaired page re-attempts the pair.
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(sourceId),
        ).toEqual({ s: targetId });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 1 });
        // The unadoptable target records a blocking rows-phase diagnostic;
        // the adoptable source records nothing and just waits for the pair.
        expect(
            database
                .prepare(
                    "SELECT reason_code, disposition FROM claim_backfill_failures WHERE phase = 'rows' AND item_kind = 'memory' AND item_key = ?",
                )
                .get(String(targetId)),
        ).toEqual({ reason_code: "invalid-scope", disposition: "blocking" });
        expect(
            database
                .prepare("SELECT COUNT(*) AS c FROM claim_backfill_failures WHERE item_key = ?")
                .get(String(sourceId)),
        ).toEqual({ c: 0 });
    });

    test("a pair adoption carries a verified endpoint's verification onto its claim as a verified event", () => {
        const { database, sourceId, targetId } = v82MirroredPendingPairDb({
            sourceVerified: true,
        });
        applyMirrorPage({
            db: database,
            page: page(0, [
                {
                    feedSeq: 1,
                    op: "insert",
                    moduleRowId: 99,
                    snapshot: moduleSnapshot(99, "unrelated fact", "mm-pp-h99"),
                },
            ]),
        });

        const sourceLink = readMemoryClaimLink(database, sourceId);
        const targetLink = readMemoryClaimLink(database, targetId);
        expect(sourceLink).not.toBeNull();
        expect(targetLink).not.toBeNull();
        // The verified source claim carries one verified event; the
        // unverified target records none — the boundary backfill skips
        // linked rows, so this envelope is the only carrier.
        const verifiedEvents = (claimId: number | undefined) =>
            (
                database
                    .prepare(
                        `SELECT COUNT(*) AS c FROM verification_events ev
                          JOIN claim_revisions rev ON rev.id = ev.revision_id
                         WHERE rev.claim_id = ? AND ev.outcome = 'verified'`,
                    )
                    .get(claimId ?? -1) as { c: number }
            ).c;
        expect(verifiedEvents(sourceLink?.claimId)).toBe(1);
        expect(verifiedEvents(targetLink?.claimId)).toBe(0);
        const operation = database
            .prepare("SELECT id FROM claim_operations WHERE operation_key = ?")
            .get(`memories:supersede:${sourceId}:${targetId}`) as { id: number } | undefined;
        const effectKeys = (
            database
                .prepare("SELECT effect_key FROM claim_change_outbox WHERE operation_id = ?")
                .all(operation?.id) as Array<{ effect_key: string }>
        ).map((row) => row.effect_key);
        expect(effectKeys).toContain(`memory:${sourceId}:evidence`);
        expect(effectKeys).not.toContain(`memory:${targetId}:evidence`);
    });

    test("a pair endpoint that dedup-adopts an archived canonical reactivates the claim with a lifecycle effect", () => {
        const database = new Database(":memory:");
        initializeDatabase(database);
        runMigrations(database);
        // Archived canonical owning the target's (category, hash): created
        // and deleted through the kernel before the boundary rows exist.
        const created = runInMemoryClaimsWriteTransaction(database, () =>
            createMemoryWithClaimsInCurrentTransaction(
                database,
                {
                    producer: "test",
                    operationKey: "pair-revive-seed",
                    requestDigest: computeClaimRequestDigest("pair-revive-seed"),
                },
                {
                    projectPath: MODULE_PROJECT,
                    category: "CONSTRAINTS",
                    content: "new boundary fact",
                    normalizedHash: "mm-pr-h2",
                    nowMs: 1_000,
                },
            ),
        );
        runInMemoryClaimsWriteTransaction(database, () =>
            deleteMemoryWithClaimsInCurrentTransaction(
                database,
                {
                    producer: "test",
                    operationKey: "pair-revive-delete",
                    requestDigest: computeClaimRequestDigest("pair-revive-delete"),
                },
                { memoryId: created.result.memoryId },
            ),
        );
        const archivedClaimId = created.result.claimId as number;
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(archivedClaimId),
        ).toEqual({ state: "archived" });

        // Unlinked boundary endpoints; the target shares the archived
        // canonical's (category, hash).
        let sourceId = 0;
        let targetId = 0;
        runInMemoryClaimsWriteTransaction(database, () => {
            const insert = database.prepare(
                `INSERT INTO memories (project_path, category, content, normalized_hash, scope,
                    first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (?, 'CONSTRAINTS', ?, ?, 'project', 1, 1, 1, 1)`,
            );
            sourceId = Number(
                insert.run(MODULE_PROJECT, "old boundary fact", "mm-pr-h1").lastInsertRowid,
            );
            targetId = Number(
                insert.run(MODULE_PROJECT, "new boundary fact", "mm-pr-h2").lastInsertRowid,
            );
        });
        withPrivilegedWriter(database, () => {
            const identity = database.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, ?, ?)",
            );
            identity.run(MODULE_PROJECT, 11, sourceId);
            identity.run(MODULE_PROJECT, 12, targetId);
            database
                .prepare(
                    "INSERT INTO mirror_pending_references(domain, module_project, module_row_id, target_module_row_id) VALUES ('memories', ?, 11, 12)",
                )
                .run(MODULE_PROJECT);
        });
        applyMirrorPage({
            db: database,
            page: page(0, [
                {
                    feedSeq: 1,
                    op: "insert",
                    moduleRowId: 99,
                    snapshot: moduleSnapshot(99, "unrelated fact", "mm-pr-h99"),
                },
            ]),
        });

        // The active target dedup-adopted the archived canonical: the claim
        // re-derives to active with a lifecycle effect in the pair envelope.
        const targetLink = readMemoryClaimLink(database, targetId);
        expect(targetLink?.claimId).toBe(archivedClaimId);
        expect(
            database.prepare("SELECT state FROM claims WHERE id = ?").get(archivedClaimId),
        ).toEqual({ state: "active" });
        const operation = database
            .prepare("SELECT id FROM claim_operations WHERE operation_key = ?")
            .get(`memories:supersede:${sourceId}:${targetId}`) as { id: number } | undefined;
        const effectKeys = (
            database
                .prepare("SELECT effect_key FROM claim_change_outbox WHERE operation_id = ?")
                .all(operation?.id) as Array<{ effect_key: string }>
        ).map((row) => row.effect_key);
        expect(effectKeys).toContain(`memory:${targetId}:lifecycle`);
    });

    test("a self-referential pending pair clears without a pointer write or claim work", () => {
        const database = new Database(":memory:");
        initializeDatabase(database);
        const rowId = Number(
            database
                .prepare(
                    `INSERT INTO memories (project_path, category, content, normalized_hash, scope,
                        first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?, 'CONSTRAINTS', 'boundary fact', 'mm-sp-h1', 'project', 1, 1, 1, 1)`,
                )
                .run(MODULE_PROJECT).lastInsertRowid,
        );
        runMigrations(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, 11, ?)",
                )
                .run(MODULE_PROJECT, rowId);
            // Module row referencing itself: source and target coordinates
            // collapse onto one context row.
            database
                .prepare(
                    "INSERT INTO mirror_pending_references(domain, module_project, module_row_id, target_module_row_id) VALUES ('memories', ?, 11, 11)",
                )
                .run(MODULE_PROJECT);
        });
        applyMirrorPage({
            db: database,
            page: page(0, [
                {
                    feedSeq: 1,
                    op: "insert",
                    moduleRowId: 99,
                    snapshot: moduleSnapshot(99, "unrelated fact", "mm-sp-h99"),
                },
            ]),
        });

        // The malformed pair is dropped, not translated: the page commits,
        // the pending row clears, no self-pointer and no claim work exist,
        // and the row stays unlinked boundary work for the backfill.
        expect(getMirrorCursor(database, "memories")).toBe(1);
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get(),
        ).toEqual({ c: 0 });
        expect(
            database
                .prepare("SELECT superseded_by_memory_id AS s FROM memories WHERE id = ?")
                .get(rowId),
        ).toEqual({ s: null });
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS c FROM claim_operations WHERE operation_key LIKE 'memories:supersede:%'",
                )
                .get(),
        ).toEqual({ c: 0 });
        expect(readMemoryClaimLink(database, rowId)).toBeNull();
    });
});
