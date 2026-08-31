/// <reference types="bun-types" />

/**
 *
 *
 *
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    type PendingCompactionMarker,
    type PersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    applyDeferredCompactionMarker,
    closeCompactionMarkerConnection,
    MARKER_SUMMARY_TEXT,
    updateCompactionMarkerAfterPublication,
} from "./compaction-marker-manager";
import type { MessageLike } from "./tag-messages";
import { reconcileMarkerRepresentation } from "./transform-postprocess-phase";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "opencode"), { recursive: true });
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    return dir;
}

function createOpenCodeDb(dataHome: string): Database {
    const dbPath = join(dataHome, "opencode", "opencode.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    db.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    return db;
}

function insertUserMessage(db: Database, id: string, sessionId: string, timeCreated: number): void {
    insertMessage(db, id, sessionId, timeCreated, "user");
}

function insertMessage(
    db: Database,
    id: string,
    sessionId: string,
    timeCreated: number,
    role: string,
): void {
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(id, sessionId, timeCreated, timeCreated, JSON.stringify({ role }));
}

function makePending(overrides: Partial<PendingCompactionMarker> = {}): PendingCompactionMarker {
    return {
        ordinal: 10,
        endMessageId: "msg-boundary",
        publishedAt: Date.now(),
        ...overrides,
    };
}

function insertCompartment(
    db: ReturnType<typeof openDatabase>,
    sessionId: string,
    ordinal: number,
    endMessageId: string,
): void {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: ordinal,
            startMessageId: `msg-${1}`,
            endMessageId,
            title: "test compartment",
            content: "test content",
        },
    ]);
}

function serializeAnthropicWireWithAdjacentAssistantMerge(messages: MessageLike[]): string {
    const merged: MessageLike[] = [];
    for (const message of messages) {
        const previous = merged.at(-1);
        if (previous?.info.role === "assistant" && message.info.role === "assistant") {
            previous.parts.push(...message.parts);
        } else {
            merged.push(structuredClone(message));
        }
    }
    return JSON.stringify(
        merged.map((message) => ({ role: message.info.role, content: message.parts })),
    );
}

function markerServeWire(
    db: Database,
    sessionId: string,
    state: PersistedCompactionMarkerState,
): string {
    const messages = [
        {
            info: { role: "user", sessionID: sessionId, syntheticHead: true },
            parts: [{ type: "text", text: "m0", synthetic: true }],
        },
        {
            info: { role: "user", sessionID: sessionId, syntheticHead: true },
            parts: [{ type: "text", text: "m1", synthetic: true }],
        },
        {
            info: { id: "tail-assistant", role: "assistant", sessionID: sessionId },
            parts: [
                {
                    type: "tool_use",
                    id: "toolu-tail",
                    name: "read",
                    input: { path: "README.md" },
                },
            ],
        },
    ] as MessageLike[];
    reconcileMarkerRepresentation(messages, state, {
        db,
        sessionId,
        tagger: createTagger(),
        ctxReduceAvailability: { callable: true, frozen: true },
    });
    return serializeAnthropicWireWithAdjacentAssistantMerge(messages);
}

function insertMarkerRows(
    db: Database,
    sessionId: string,
    state: PersistedCompactionMarkerState,
): void {
    db.prepare(
        "INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 1, 1, ?)",
    ).run(
        state.summaryMessageId,
        sessionId,
        JSON.stringify({ role: "assistant", summary: true, finish: "stop" }),
    );
    db.prepare(
        "INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 1, 1, ?)",
    ).run(state.compactionPartId, state.boundaryMessageId, sessionId, '{"type":"compaction"}');
    db.prepare(
        "INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 1, 1, ?)",
    ).run(state.summaryPartId, state.summaryMessageId, sessionId, '{"type":"text","text":"old"}');
}

afterEach(() => {
    closeCompactionMarkerConnection();
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Windows can retain database file handles after close, so cleanup ignores EBUSY.
        }
    }
    tempDirs.length = 0;
});

describe("applyDeferredCompactionMarker — outcomes", () => {
    it("returns `applied` on the happy path (no existing marker)", () => {
        const dataHome = useTempDataHome("apply-deferred-applied-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        // The fixture seeds a `session_meta` row so the manager can write boundary state.
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("applied");
        if (outcome.kind === "applied") {
            expect(outcome.markerOrdinal).toBe(10);
        }
        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted).not.toBeNull();
        expect(persisted?.boundaryOrdinal).toBe(10);
    });

    it("retries a post-insert state failure without minting duplicate marker rows", () => {
        const dataHome = useTempDataHome("apply-deferred-post-insert-retry-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-retry", 1_000);
        insertMessage(opencodeDb, "legacy-summary", "ses-retry", 1_001, "assistant");
        opencodeDb.prepare("UPDATE message SET data = ? WHERE id = 'legacy-summary'").run(
            JSON.stringify({
                role: "assistant",
                parentID: "msg-boundary",
                summary: true,
                finish: "stop",
                mode: "compaction",
                agent: "compaction",
                modelID: "magic-context",
                providerID: "magic-context",
            }),
        );
        opencodeDb
            .prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
                "legacy-summary-part",
                "legacy-summary",
                "ses-retry",
                1_001,
                1_001,
                JSON.stringify({ type: "text", text: MARKER_SUMMARY_TEXT }),
            );
        opencodeDb
            .prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
                "legacy-compaction-part",
                "msg-boundary",
                "ses-retry",
                1_000,
                1_000,
                JSON.stringify({ type: "compaction", auto: true }),
            );
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-retry", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-retry");
        db.exec(`CREATE TRIGGER fail_marker_state_persist
            BEFORE UPDATE OF compaction_marker_state ON session_meta
            WHEN NEW.compaction_marker_state <> ''
            BEGIN
                SELECT RAISE(ABORT, 'simulated marker state persist failure');
            END`);

        const first = applyDeferredCompactionMarker(db, "ses-retry", makePending(), dataHome);
        expect(first.kind).toBe("retryable-failure");

        const inspectAfterCrash = new Database(join(dataHome, "opencode", "opencode.db"));
        const firstSummaryIds = inspectAfterCrash
            .prepare(
                "SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.summary') = 1 ORDER BY id",
            )
            .all("ses-retry") as Array<{ id: string }>;
        expect(firstSummaryIds).toHaveLength(1);
        expect(firstSummaryIds[0]?.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
        closeQuietly(inspectAfterCrash);

        db.exec("DROP TRIGGER fail_marker_state_persist");
        const retry = applyDeferredCompactionMarker(db, "ses-retry", makePending(), dataHome);
        expect(retry.kind).toBe("applied");

        const inspectAfterRetry = new Database(join(dataHome, "opencode", "opencode.db"));
        const summaryIds = inspectAfterRetry
            .prepare(
                "SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.summary') = 1 ORDER BY id",
            )
            .all("ses-retry") as Array<{ id: string }>;
        const compactionParts = inspectAfterRetry
            .prepare(
                "SELECT id FROM part WHERE session_id = ? AND message_id = ? AND json_extract(data, '$.type') = 'compaction' ORDER BY id",
            )
            .all("ses-retry", "msg-boundary") as Array<{ id: string }>;
        expect(summaryIds.map((row) => row.id)).toEqual(firstSummaryIds.map((row) => row.id));
        expect(compactionParts).toHaveLength(1);
        const retryState = getPersistedCompactionMarkerState(db, "ses-retry");
        expect(retryState?.summaryMessageId).toBe(firstSummaryIds[0]?.id);

        insertUserMessage(inspectAfterRetry, "clean-boundary", "ses-clean", 2_000);
        closeQuietly(inspectAfterRetry);
        insertCompartment(db, "ses-clean", 10, "clean-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-clean");
        const clean = applyDeferredCompactionMarker(
            db,
            "ses-clean",
            makePending({ endMessageId: "clean-boundary" }),
            dataHome,
        );
        expect(clean.kind).toBe("applied");
        const cleanState = getPersistedCompactionMarkerState(db, "ses-clean");
        if (!retryState || !cleanState) throw new Error("expected both marker states");
        expect(markerServeWire(db, "ses-retry", retryState)).toBe(
            markerServeWire(db, "ses-clean", cleanState),
        );
    });

    it("returns `already-current` when persisted boundary >= pending ordinal", () => {
        const dataHome = useTempDataHome("apply-deferred-current-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-boundary",
            summaryMessageId: "msg-summary",
            compactionPartId: "prt-comp",
            summaryPartId: "prt-summary",
            boundaryOrdinal: 10,
            targetEndMessageId: "msg-boundary",
        });

        const outcome = applyDeferredCompactionMarker(
            db,
            "ses-1",
            makePending({ ordinal: 10 }),
            dataHome,
        );

        expect(outcome.kind).toBe("already-current");
        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted?.boundaryMessageId).toBe("msg-boundary");
    });

    it("returns `stale-skip / compartment-removed` when raw OpenCode message is gone", () => {
        const dataHome = useTempDataHome("apply-deferred-msg-gone-");
        const opencodeDb = createOpenCodeDb(dataHome);
        // The fixture omits `msg-boundary` to simulate cleanup.
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("stale-skip");
        if (outcome.kind === "stale-skip") {
            expect(outcome.reason).toBe("compartment-removed");
        }
    });

    it("returns `stale-skip / compartment-removed` when local compartment row is gone", () => {
        const dataHome = useTempDataHome("apply-deferred-compart-gone-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        // The fixture omits the compartment to simulate recompaction that removed local state.
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("stale-skip");
        if (outcome.kind === "stale-skip") {
            expect(outcome.reason).toBe("compartment-removed");
        }
    });

    it("returns `stale-skip / target-superseded` when compartment ordinal advanced past pending", () => {
        const dataHome = useTempDataHome("apply-deferred-superseded-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        // A later partial recompaction can resequence `msg-boundary` from pending ordinal 10 to compartment ordinal 20.
        // A later partial recompaction can resequence `msg-boundary` from pending ordinal 10 to compartment ordinal 20.
        // A later partial recompaction can resequence `msg-boundary` from pending ordinal 10 to compartment ordinal 20.
        insertCompartment(db, "ses-1", 20, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(
            db,
            "ses-1",
            makePending({ ordinal: 10 }),
            dataHome,
        );

        expect(outcome.kind).toBe("stale-skip");
        if (outcome.kind === "stale-skip") {
            expect(outcome.reason).toBe("target-superseded");
        }
    });

    it("returns `retryable-failure` when injectCompactionMarker cannot find a boundary message", () => {
        //
        // An assistant boundary makes findBoundaryUserMessage return null.
        // The marker injector returns `null`, mapping to retryable failure.
        const dataHome = useTempDataHome("apply-deferred-retryable-");
        const opencodeDb = createOpenCodeDb(dataHome);
        // getOpenCodeMessageById validates only message existence; the marker injector requires a user-role boundary anchor.
        // The marker injector requires a user-role boundary anchor even though `getOpenCodeMessageById` only checks message existence.
        // The marker injector requires a user-role boundary anchor even though `getOpenCodeMessageById` only checks message existence; otherwise `inject` returns `null`.
        opencodeDb
            .prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run("msg-boundary", "ses-1", 1_000, 1_000, JSON.stringify({ role: "assistant" }));
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        // No user message at or before the boundary makes `inject` return `null`, a retryable failure.
        // `inject` returning `null` is a retryable failure.
        expect(outcome.kind).toBe("retryable-failure");
        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted).toBeNull();
    });

    it("returns `retryable-failure` on raw OpenCode DB access errors", () => {
        // The missing opencode/ directory makes opening the writable OpenCode database fail.
        // getOpenCodeMessageById propagates the open error to applyDeferredCompactionMarker's outer try/catch.
        const dataHome = mkdtempSync(join(tmpdir(), "apply-deferred-db-err-"));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        mkdirSync(join(dataHome, "cortexkit", "magic-context"), { recursive: true });

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("retryable-failure");
    });

    it("preserves an existing marker when the new target has no user boundary", () => {
        const dataHome = useTempDataHome("apply-deferred-no-boundary-preserve-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertMessage(opencodeDb, "msg-boundary", "ses-1", 1_000, "assistant");
        const oldState: PersistedCompactionMarkerState = {
            boundaryMessageId: "msg-old-missing-boundary",
            summaryMessageId: "msg-old-summary",
            compactionPartId: "prt-old-compaction",
            summaryPartId: "prt-old-summary",
            boundaryOrdinal: 5,
            targetEndMessageId: "msg-old-target",
        };
        insertMarkerRows(opencodeDb, "ses-1", oldState);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        setPersistedCompactionMarkerState(db, "ses-1", oldState);

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("retryable-failure");
        expect(getPersistedCompactionMarkerState(db, "ses-1")?.summaryMessageId).toBe(
            "msg-old-summary",
        );
    });

    it("repairs an equal-ordinal marker whose boundary is after the target endMessageId", () => {
        const dataHome = useTempDataHome("apply-deferred-repair-overextended-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg_009_prior_user", "ses-1", 900);
        insertMessage(opencodeDb, "msg_010_target", "ses-1", 1_000, "assistant");
        insertUserMessage(opencodeDb, "msg_020_after_user", "ses-1", 2_000);
        const corruptState: PersistedCompactionMarkerState = {
            boundaryMessageId: "msg_020_after_user",
            summaryMessageId: "msg-corrupt-summary",
            compactionPartId: "prt-corrupt-compaction",
            summaryPartId: "prt-corrupt-summary",
            boundaryOrdinal: 10,
            targetEndMessageId: null,
        };
        insertMarkerRows(opencodeDb, "ses-1", corruptState);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg_010_target");
        setPersistedCompactionMarkerState(db, "ses-1", corruptState);

        const outcome = applyDeferredCompactionMarker(
            db,
            "ses-1",
            makePending({ endMessageId: "msg_010_target" }),
            dataHome,
        );

        expect(outcome.kind).toBe("applied");
        const repaired = getPersistedCompactionMarkerState(db, "ses-1");
        expect(repaired?.boundaryMessageId).toBe("msg_009_prior_user");
        expect(repaired?.targetEndMessageId).toBe("msg_010_target");
    });

    it("direct publication path resolves the compartment endMessageId instead of ordinal", () => {
        const dataHome = useTempDataHome("direct-marker-end-id-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg_001_deleted_user", "ses-1", 100);
        insertMessage(opencodeDb, "msg_002_deleted_assistant", "ses-1", 200, "assistant");
        insertUserMessage(opencodeDb, "msg_003_prior_user", "ses-1", 300);
        insertMessage(opencodeDb, "msg_004_target", "ses-1", 400, "assistant");
        insertUserMessage(opencodeDb, "msg_005_after_user", "ses-1", 500);
        opencodeDb
            .prepare(
                "DELETE FROM message WHERE id IN ('msg_001_deleted_user', 'msg_002_deleted_assistant')",
            )
            .run();
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 4, "msg_004_target");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        expect(updateCompactionMarkerAfterPublication(db, "ses-1", 4, dataHome)).toBe(true);

        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted?.boundaryMessageId).toBe("msg_003_prior_user");
        expect(persisted?.boundaryOrdinal).toBe(4);
        expect(persisted?.targetEndMessageId).toBe("msg_004_target");
    });

    it("no-ops (success) on the pi harness without touching opencode.db", () => {
        // Pi reaches this function through recompilation runners without any `opencode.db` access.
        // Pi reaches this function through recompilation runners without any `opencode.db` access.
        const dataHome = useTempDataHome("pi-harness-no-oc-db-");
        rmSync(join(dataHome, "opencode"), { recursive: true, force: true });

        const db = openDatabase();
        insertCompartment(db, "ses-pi", 4, "msg_004_target");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-pi");

        setHarness("pi");
        try {
            expect(updateCompactionMarkerAfterPublication(db, "ses-pi", 4, dataHome)).toBe(true);
        } finally {
            _resetHarnessForTesting();
        }
        // Opening a missing `opencode.db` must throw instead of creating an empty database that later fails with `no such table`.
        // Creating an empty `opencode.db` causes later queries to fail with `no such table`.
        expect(existsSync(join(dataHome, "opencode", "opencode.db"))).toBe(false);
    });

    it("fails loud without creating a junk opencode.db when the file is missing on opencode", () => {
        // Opening a missing opencode.db must throw instead of creating an empty database.
        // Opening a missing opencode.db must throw instead of creating an empty database.
        // Opening a missing `opencode.db` must throw instead of creating an empty database that later fails with `no such table`.
        const dataHome = useTempDataHome("oc-harness-missing-db-");
        rmSync(join(dataHome, "opencode"), { recursive: true, force: true });
        mkdirSync(join(dataHome, "opencode"), { recursive: true });

        const db = openDatabase();
        insertCompartment(db, "ses-2", 4, "msg_004_target");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-2");

        expect(() => updateCompactionMarkerAfterPublication(db, "ses-2", 4, dataHome)).toThrow(
            /OpenCode database not found/,
        );
        expect(existsSync(join(dataHome, "opencode", "opencode.db"))).toBe(false);
    });
});
