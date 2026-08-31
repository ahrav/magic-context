import { describe, expect, test } from "bun:test";
import { type Database, withPrivilegedWriter } from "../../shared/sqlite";
import type { AuthorityModuleClient, AuthorityStatus } from "./context-authority";
import {
    applyMirrorPage,
    bumpDomainMutationEpoch,
    drainAuthority,
    ensureContextStoreUuid,
    getAuthorityManagedMarker,
    getMirrorCursor,
    getModuleNoteEvaluationBridge,
    installAuthorityManagedMarker,
    prepareAuthority,
    registerModuleNoteEvaluationBridge,
} from "./context-authority";
import { createDirectTestDatabase } from "./test-database";

function db(): Database {
    const value = createDirectTestDatabase().db;
    return value;
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
            domains: ["notes"],
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
            domains: ["notes"],
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
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'notes' AND module_project = '/repo' AND module_row_id = 900",
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
                domains: ["notes"],
                module,
                seedPages: async () => [
                    { source_row_id: 1, snapshot: { id: 1, project_path: "/repo" } },
                ],
            }),
        ).rejects.toThrow("verification failed");
        expect(getAuthorityManagedMarker(database, "/repo")).toBeNull();
        database
            .prepare(
                "INSERT INTO notes (type, status, content, project_path, session_id, created_at, updated_at) VALUES ('smart', 'active', 'ts works', ?, 'session', 0, 0)",
            )
            .run("/repo");
        expect(database.prepare("SELECT COUNT(*) AS count FROM notes").get()).toEqual({
            count: 1,
        });
    });

    test("re-captures and replays when drain finish reports a later feed head", async () => {
        const database = db();
        const contextStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO notes (id, type, status, content, project_path, session_id, created_at, updated_at) VALUES (41, 'smart', 'active', 'local note', '/repo', 'session', 10, 20)",
                )
                .run();
        });
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
                    domain: "notes",
                    cursor: args.cursor,
                    next_cursor: 1,
                    has_more: false,
                    rows: [
                        {
                            feed_seq: 1,
                            domain: "notes",
                            op: "insert",
                            module_row_id: 9,
                            full_row_snapshot: {
                                context_store_uuid: contextStoreUuid,
                                context_row_id: 41,
                                project_path: "/repo",
                                session_id: "session",
                                content: "late note",
                                status: "active",
                                updated_at_ms: 30,
                            },
                            content_hash: null,
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
                        domain: "notes",
                        captured_upper_bound: begins === 1 ? 0 : 1,
                        coordinator_token: `token-${begins}`,
                    },
                };
            },
        };

        const result = await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "notes",
            module,
            checksum: "same",
        });
        expect({ begins, finishes, state: result.state }).toEqual({
            begins: 2,
            finishes: 2,
            state: "TS",
        });
        expect(
            database.prepare("SELECT cursor FROM mirror_cursors WHERE domain = 'notes'").get(),
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
        database
            .prepare(
                "INSERT INTO notes (type, status, content, project_path, session_id, created_at, updated_at) VALUES ('smart', 'active', 'before marker', '/repo', 'session', 0, 0)",
            )
            .run();
        let seededIds: number[] = [];
        await prepareAuthority({
            db: database,
            projectPath: "/repo",
            domains: ["notes"],
            module: protocol({ bytes: [] }),
            seedPages: async () => {
                expect(() =>
                    database
                        .prepare(
                            "INSERT INTO notes (type, status, content, project_path, session_id, created_at, updated_at) VALUES ('smart', 'active', 'after marker', '/repo', 'session', 0, 0)",
                        )
                        .run(),
                ).toThrow("managed by the Rust module");
                const rows = database
                    .prepare("SELECT * FROM notes WHERE project_path = ? ORDER BY id")
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

    test("privileged same-connection UPDATE between capture and verify aborts prepare", async () => {
        const database = db();
        database
            .prepare(
                "INSERT INTO notes (type, status, content, project_path, session_id, created_at, updated_at) VALUES ('smart', 'active', 'seed', '/repo', 'session', 0, 0)",
            )
            .run();
        const module = protocol({ bytes: [] });
        const ordinaryPrepare = module.authorityPrepare;
        module.authorityPrepare = async (args) => {
            if (args.phase === "complete") {
                withPrivilegedWriter(database, () => {
                    database
                        .prepare("UPDATE notes SET content = 'drifted' WHERE project_path = ?")
                        .run("/repo");
                    bumpDomainMutationEpoch(database, "/repo", "notes");
                });
            }
            return ordinaryPrepare(args);
        };
        await expect(
            prepareAuthority({
                db: database,
                projectPath: "/repo",
                domains: ["notes"],
                module,
                seedPages: async () => {
                    const rows = database
                        .prepare("SELECT * FROM notes WHERE project_path = ? ORDER BY id")
                        .all("/repo") as Array<Record<string, unknown>>;
                    return rows.map((snapshot) => ({ source_row_id: snapshot.id, snapshot }));
                },
            }),
        ).rejects.toThrow("authority capture bound changed");
        expect(getAuthorityManagedMarker(database, "/repo")).toBeNull();
    });

    test("applyMirrorPage refuses a memories-domain page without touching state", () => {
        const database = db();
        expect(() =>
            applyMirrorPage({
                db: database,
                page: {
                    domain: "memories",
                    cursor: 0,
                    next_cursor: 1,
                    has_more: false,
                    rows: [],
                },
            }),
        ).toThrow("unsupported mirror domain");
        expect(getMirrorCursor(database, "memories")).toBe(0);
    });

    test("memories drain fails closed on legacy module feed rows", async () => {
        const database = db();
        installAuthorityManagedMarker(database, "/repo");
        const module: AuthorityModuleClient = {
            authorityStatus: async (args) => ({
                authority: { ...authority("DRAINING", 2), domain: args.domain },
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
            authorityDrain: async () => ({
                authority: {
                    ...authority("DRAINING", 2),
                    captured_upper_bound: 3,
                    coordinator_token: "legacy-token",
                },
            }),
        };
        await expect(
            drainAuthority({
                db: database,
                projectPath: "/repo",
                domain: "memories",
                module,
                checksum: "same",
            }),
        ).rejects.toThrow("legacy module feed rows");
        expect(getAuthorityManagedMarker(database, "/repo")).not.toBeNull();
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
        await import("./context-authority").then((m) =>
            m.disposeModuleNoteEvaluationBridges([keyA]),
        );
        expect(getModuleNoteEvaluationBridge("/shared-id", "/worktree-a")).toBeUndefined();
        expect(getModuleNoteEvaluationBridge("/shared-id", "/worktree-b")).toBeDefined();
    });
});
