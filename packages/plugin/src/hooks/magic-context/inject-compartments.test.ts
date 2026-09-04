/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    appendCompartments,
    replaceAllCompartmentState,
} from "../../features/magic-context/compartment-storage";
import type { Memory } from "../../features/magic-context/memory/types";
import {
    bumpSessionFactsVersion,
    getOrCreateSessionMeta,
    queueM0Mutation,
    setProjectState,
} from "../../features/magic-context/storage";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import { type KernelMemorySnapshot, unavailable } from "../../shared/kernel-client";
import { FakeKernel } from "../../shared/kernel-client-testing/fake-kernel";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    COMPARTMENT_RENDER_EPOCH,
    encodeCachedM0UpgradeIdentity,
} from "./compartment-render-epoch";
import {
    clearInjectionCache,
    getVisibleRevisionLocators,
    injectM0M1,
    MaterializeContentionError,
    materializeM0,
    materializeWithRetry,
    mustMaterialize,
    prepareCompartmentInjection,
    readCurrentM0SnapshotMarkers,
    renderCompartmentInjection,
    renderMemoryBlockV2,
    renderMemoryLineV2,
    trimMemoriesToBudgetV2,
} from "./inject-compartments";
import { memorySnapshotKey } from "./kernel-memory-render";
import { closeReadOnlySessionDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_test_inject";
const PROJECT_PATH = "/tmp/test-inject-project";

let db: Database;
const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
/**
 * One fake kernel per database stands in for the daemon; `memoryFor` is the
 * snapshot the transform would have read before this pass.
 */
const kernels = new WeakMap<Database, FakeKernel>();
let testMemoryId = 0;

function kernelFor(database: Database): FakeKernel {
    let kernel = kernels.get(database);
    if (!kernel) {
        kernel = new FakeKernel();
        kernels.set(database, kernel);
    }
    return kernel;
}

function memoryFor(database: Database): KernelMemorySnapshot {
    return kernelFor(database).snapshot();
}

function memoryObjectId(id: number): string {
    return `mem_${id.toString(16).padStart(32, "0")}`;
}

/** A seeded memory row; `id` is the object id the kernel serves it under. */
interface SeededMemory {
    id: string;
    projectPath: string;
    category: string;
    content: string;
}

function insertMemory(
    database: Database,
    input: {
        projectPath: string;
        category: string;
        content: string;
        importance?: number;
        expiresAt?: number | null;
        sourceSessionId?: string;
        sourceType?: string;
        metadataJson?: string;
    },
): SeededMemory {
    testMemoryId += 1;
    const id = memoryObjectId(testMemoryId);
    kernelFor(database).seedDecision({
        object_id: id,
        decision_kind: input.category,
        summary: input.content,
    });
    return { id, projectPath: input.projectPath, category: input.category, content: input.content };
}

/** A change to the object outside this pass's view; the next snapshot key differs. */
function reviseSeededMemory(database: Database, id: string): void {
    const kernel = kernelFor(database);
    const object = kernel.objects.get(id);
    if (!object?.decision) throw new Error(`missing seeded memory ${id}`);
    kernel.touch(id);
    object.decision.payload.summary = `${object.decision.payload.summary} (revised)`;
}

function archiveSeededMemory(database: Database, id: string): void {
    const kernel = kernelFor(database);
    const object = kernel.objects.get(id);
    if (!object) throw new Error(`missing seeded memory ${id}`);
    kernel.touch(id);
    object.invalidated_commit_seq = kernel.tip;
}

function makeDb(): Database {
    const d = createDirectTestDatabase().db;
    // session_meta row must exist for memory_block_cache writes
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function makeProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-renderer-test-"));
    tempDirs.push(dir);
    return dir;
}

function createOpenCodeMessageTimes(rows: Array<{ id: string; timestamp: number }>): void {
    const dataHome = mkdtempSync(join(tmpdir(), "mc-inject-dates-"));
    tempDirs.push(dataHome);
    process.env.XDG_DATA_HOME = dataHome;
    process.env.XDG_CACHE_HOME = dataHome;
    closeReadOnlySessionDb();

    const dbPath = join(dataHome, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const source = new Database(dbPath);
    try {
        source.exec(`
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL
            );
        `);
        const insert = source.prepare(
            "INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)",
        );
        for (const row of rows) insert.run(row.id, SESSION_ID, row.timestamp);
    } finally {
        source.close();
    }
}

function readStateFromMeta(): ReturnType<typeof getOrCreateSessionMeta> {
    return getOrCreateSessionMeta(db, SESSION_ID);
}

function renderedText(message: MessageLike): string {
    const part = message.parts[0] as { type: string; text?: string } | undefined;
    return part?.type === "text" ? (part.text ?? "") : "";
}

function userMessage(id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: SESSION_ID },
        parts: [{ type: "text", text }],
    };
}

function storeDatedCompartment(): void {
    replaceAllCompartmentState(
        db,
        SESSION_ID,
        [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m1",
                endMessageId: "m2",
                title: "dated compartment",
                content: "full summary",
                p1: "full summary",
                p2: "dense summary",
                p3: "brief summary",
                p4: "anchor",
                importance: 80,
            },
        ],
        [],
    );
}

afterEach(() => {
    if (db) db.close();
    closeReadOnlySessionDb();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function renderMemory(id: number, category: string, content: string, importance = 50): Memory {
    return { id, category, content, importance } as unknown as Memory;
}

describe("compact project-memory wire", () => {
    it("groups by canonical then alphabetical categories and escapes facts and attribution", () => {
        const memories = [
            renderMemory(9, "Z_LEGACY", "last"),
            renderMemory(5, "ARCHITECTURE", "owned by service"),
            renderMemory(4, "PROJECT_RULES", "second rule"),
            renderMemory(3, "PROJECT_RULES", "use <fast> & safe mode"),
            renderMemory(8, "A&LEGACY", "first unknown"),
        ];

        expect(
            renderMemoryBlockV2(memories, "project-memory", {
                sourceNameByMemoryId: new Map([[5, "svc<&"]]),
            }),
        ).toBe(`<project-memory>
<PROJECT_RULES>
#3: use &lt;fast&gt; &amp; safe mode
#4: second rule
</PROJECT_RULES>
<ARCHITECTURE>
#5 [svc&lt;&amp;]: owned by service
</ARCHITECTURE>
<A&amp;LEGACY>
#8: first unknown
</A&amp;LEGACY>
<Z_LEGACY>
#9: last
</Z_LEGACY>
</project-memory>`);
        expect(renderMemoryLineV2(memories[0]!)).toBe("#9: last");
    });

    it("measures the complete grouped block so a dropped category has no tag overhead", () => {
        const kept = renderMemory(1, "PROJECT_RULES", "always run focused tests", 100);
        const dropped = renderMemory(2, "ARCHITECTURE", "a separate category", 1);
        const budget = estimateTokens(renderMemoryBlockV2([kept]));
        expect(estimateTokens(renderMemoryBlockV2([kept, dropped]))).toBeGreaterThan(budget);

        const trimmed = trimMemoriesToBudgetV2(SESSION_ID, [dropped, kept], budget);
        expect(trimmed.selected.map((memory) => memory.id)).toEqual([kept.id]);
        const block = renderMemoryBlockV2(trimmed.renderOrder);
        expect(estimateTokens(block)).toBeLessThanOrEqual(budget);
        expect(block).not.toContain("<ARCHITECTURE>");
    });

    it("keeps rendered bytes identical across importance-only classification updates", () => {
        db = makeDb();
        const inserted = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "CONSTRAINTS",
            content: "Never bypass the validation gate.",
            importance: 20,
        });
        const before = renderMemoryBlockV2([inserted]);
        const after = renderMemoryBlockV2([{ ...inserted, importance: 95 }]);

        expect(after).toBe(before);
        expect(after).not.toContain("importance");
    });
});

describe("prepareCompartmentInjection — empty compartments fallback", () => {
    it("renders only the empty-project marker when compartments, facts, and memories are all empty", () => {
        db = makeDb();
        const messages: MessageLike[] = [userMessage("m1", "hi")];
        const result = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages,
            isCacheBusting: true,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });
        expect(result?.memoryCount).toBe(0);
        expect(result?.compartmentCount).toBe(0);
        expect(result?.block).toBe(
            "<project-memory>\nmemory: no memories recorded for this project yet\n</project-memory>",
        );
        expect(messages.length).toBe(1);
    });

    it("returns null when the session has no project to bind memory to", () => {
        db = makeDb();
        const messages: MessageLike[] = [userMessage("m1", "hi")];
        const result = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages,
            isCacheBusting: true,
            memory: memoryFor(db),
        });
        expect(result).toBeNull();
    });

    it("renders only the unavailable marker when the daemon cannot be reached", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "hidden while the daemon is absent",
        });
        const result = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages: [userMessage("m1", "hi")],
            isCacheBusting: true,
            memory: { state: unavailable("daemon_absent"), rows: [], knownAsOf: null },
            projectPath: PROJECT_PATH,
        });
        expect(result?.memoryCount).toBe(0);
        expect(result?.block).toContain("<project-memory>");
        expect(result?.block).not.toContain("hidden while the daemon is absent");
        expect(result?.block).toContain("memory:");
    });

    it("injects memories-only block when no compartments exist", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "User prefers concise responses",
        });

        const messages: MessageLike[] = [userMessage("m1", "original")];
        const result = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages,
            isCacheBusting: true,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });

        expect(result).not.toBeNull();
        expect(result?.compartmentCount).toBe(0);
        expect(result?.compartmentEndMessage).toBe(0);
        expect(result?.compartmentEndMessageId).toBe("");
        expect(result?.skippedVisibleMessages).toBe(0);
        expect(result?.factCount).toBe(0);
        expect(result?.memoryCount).toBe(1);
        expect(result?.block).toContain("<project-memory>");
        expect(result?.block).toContain("User prefers concise responses");
        // Injection preserves the original message without splicing.
        expect(messages.length).toBe(1);
        expect(messages[0].info.id).toBe("m1");
    });

    it("does NOT render session_facts (v2: facts retired as a render source)", () => {
        db = makeDb();
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [],
            [{ category: "DECISIONS", content: "Use SQLite" }],
        );

        const messages: MessageLike[] = [userMessage("m1", "go")];
        const result = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages,
            isCacheBusting: true,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });

        // session_facts is not a render source.
        // Facts are rendered only after promotion to memories.
        expect(result?.factCount).toBe(0);
        expect(result?.block).not.toContain("Use SQLite");
    });

    it("injects memories block (facts not rendered) when no compartments", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "CONSTRAINTS",
            content: "Never commit without tests",
        });
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [],
            [{ category: "DECISIONS", content: "Monorepo layout" }],
        );

        const messages: MessageLike[] = [userMessage("m1", "hello")];
        const result = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages,
            isCacheBusting: true,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });

        expect(result).not.toBeNull();
        expect(result?.compartmentCount).toBe(0);
        expect(result?.memoryCount).toBe(1);
        expect(result?.block).toContain("<project-memory>");
        expect(result?.block).toContain("Never commit without tests");
        expect(result?.block).not.toContain("Monorepo layout");
    });

    it("renderCompartmentInjection wraps memory-only block in <session-history>", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "test directive",
        });

        const messages: MessageLike[] = [userMessage("m1", "original")];
        const prepared = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages,
            isCacheBusting: true,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });
        expect(prepared).not.toBeNull();
        if (!prepared) return;

        const renderResult = renderCompartmentInjection(SESSION_ID, messages, prepared);
        expect(renderResult.injected).toBe(true);
        expect(renderResult.compartmentCount).toBe(0);

        const firstPart = messages[0].parts[0] as { type: string; text: string };
        expect(firstPart.text).toContain("<session-history>");
        expect(firstPart.text).toContain("</session-history>");
        expect(firstPart.text).toContain("test directive");
        expect(firstPart.text).toContain("original");
    });
});

describe("prepareCompartmentInjection — cross-database cache isolation", () => {
    it("does not replay a block rendered from a different database", () => {
        // The process-global injection cache is keyed only by session ID.
        // stores that share a session id must not see each other's blocks.
        const first = makeDb();
        try {
            insertMemory(first, {
                projectPath: PROJECT_PATH,
                category: "CONSTRAINTS",
                content: "MEMORY-ONLY-IN-FIRST-DATABASE",
            });
            const populated = prepareCompartmentInjection({
                db: first,
                sessionId: SESSION_ID,
                messages: [userMessage("m1", "hi")],
                isCacheBusting: true,
                memory: memoryFor(first),
                projectPath: PROJECT_PATH,
            });
            expect(populated?.block).toContain("MEMORY-ONLY-IN-FIRST-DATABASE");
        } finally {
            closeQuietly(first);
        }

        // Stores that share a session ID must not see each other's blocks.
        db = makeDb();
        const messages: MessageLike[] = [userMessage("m1", "hi")];
        const replayed = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages,
            isCacheBusting: false,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });

        expect(replayed?.block ?? "").not.toContain("MEMORY-ONLY-IN-FIRST-DATABASE");
        expect(replayed?.memoryCount).toBe(0);
    });
});

describe("prepareCompartmentInjection — transition from empty to compartment", () => {
    it("switches from memories-only to boundary-based splice after first compartment", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "initial directive",
        });

        const pass1Messages: MessageLike[] = [
            userMessage("m1", "hello"),
            userMessage("m2", "follow up"),
        ];
        const pass1 = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages: pass1Messages,
            isCacheBusting: true,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });
        expect(pass1?.compartmentCount).toBe(0);
        expect(pass1?.compartmentEndMessageId).toBe("");
        expect(pass1Messages.length).toBe(2);

        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m1",
                    endMessageId: "m1",
                    title: "first compartment",
                    content: "Summary of early messages.",
                },
            ],
            [],
        );
        clearInjectionCache(SESSION_ID);

        // A compartment boundary splices m1 from session history.
        const pass2Messages: MessageLike[] = [
            userMessage("m1", "hello"),
            userMessage("m2", "follow up"),
        ];
        const pass2 = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages: pass2Messages,
            isCacheBusting: true,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });
        expect(pass2?.compartmentCount).toBe(1);
        expect(pass2?.compartmentEndMessageId).toBe("m1");
        expect(pass2?.skippedVisibleMessages).toBe(1);
        expect(pass2Messages.length).toBe(1);
        expect(pass2Messages[0].info.id).toBe("m2");
        expect(pass2?.block).toContain("first compartment");
        expect(pass2?.block).toContain("initial directive");
    });

    it("defer pass replays memories-only cached injection without splicing", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "directive",
        });

        const bustMessages: MessageLike[] = [userMessage("m1", "hi")];
        const busted = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages: bustMessages,
            isCacheBusting: true,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });
        expect(busted?.compartmentCount).toBe(0);

        // Cached replay leaves messages unchanged.
        const deferMessages: MessageLike[] = [userMessage("m1", "hi"), userMessage("m2", "new")];
        const cached = prepareCompartmentInjection({
            db,
            sessionId: SESSION_ID,
            messages: deferMessages,
            isCacheBusting: false,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });
        // The replayed output matches the busted output except for rebuiltFromDb.
        // rebuiltFromDb is true on a bust and false on replay.
        // rebuiltFromDb signals per-pass provenance to the postprocess drain.
        expect(busted?.rebuiltFromDb).toBe(true);
        expect(cached?.rebuiltFromDb).toBe(false);
        expect(cached?.block).toBe(busted?.block);
        expect(cached?.compartmentEndMessage).toBe(busted?.compartmentEndMessage);
        expect(cached?.compartmentEndMessageId).toBe(busted?.compartmentEndMessageId);
        expect(cached?.compartmentCount).toBe(busted?.compartmentCount);
        expect(cached?.skippedVisibleMessages).toBe(busted?.skippedVisibleMessages);
        expect(cached?.factCount).toBe(busted?.factCount);
        expect(cached?.memoryCount).toBe(busted?.memoryCount);
        // An empty boundary ID prevents splicing.
        expect(deferMessages.length).toBe(2);
    });
});

describe("prepareCompartmentInjection — SQLITE_BUSY handling (issue #23)", () => {
    it("swallows SQLITE_BUSY on memory_block_cache UPDATE and returns computed block anyway", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "never run migrations manually",
        });

        const busyProxy: Database = new Proxy(db, {
            get(target, prop, receiver) {
                if (prop === "transaction") return target.transaction.bind(target);
                if (prop === "prepare") {
                    return (sql: string) => {
                        if (sql.includes("UPDATE session_meta SET memory_block_count")) {
                            return {
                                run: () => {
                                    const err = new Error("database is locked") as Error & {
                                        code: string;
                                        errno: number;
                                    };
                                    err.code = "SQLITE_BUSY";
                                    err.errno = 5;
                                    throw err;
                                },
                                get: () => null,
                                all: () => [],
                            };
                        }
                        return target.prepare(sql);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });

        const messages: MessageLike[] = [userMessage("m1", "hello")];
        // prepareCompartmentInjection must swallow SQLITE_BUSY from the optional cache write.
        const result = prepareCompartmentInjection({
            db: busyProxy,
            sessionId: SESSION_ID,
            messages,
            isCacheBusting: true,
            memory: memoryFor(db),
            projectPath: PROJECT_PATH,
        });

        expect(result).not.toBeNull();
        expect(result?.memoryCount).toBe(1);
        expect(result?.block).toContain("never run migrations manually");
    });

    it("rethrows non-BUSY errors from memory_block_cache UPDATE", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "test directive",
        });

        const errorProxy: Database = new Proxy(db, {
            get(target, prop, receiver) {
                if (prop === "transaction") return target.transaction.bind(target);
                if (prop === "prepare") {
                    return (sql: string) => {
                        if (sql.includes("UPDATE session_meta SET memory_block_count")) {
                            return {
                                run: () => {
                                    const err = new Error("schema mismatch") as Error & {
                                        code: string;
                                    };
                                    err.code = "SQLITE_CORRUPT";
                                    throw err;
                                },
                                get: () => null,
                                all: () => [],
                            };
                        }
                        return target.prepare(sql);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });

        const messages: MessageLike[] = [userMessage("m1", "hello")];
        expect(() =>
            prepareCompartmentInjection({
                db: errorProxy,
                sessionId: SESSION_ID,
                messages,
                isCacheBusting: true,
                memory: memoryFor(db),
                projectPath: PROJECT_PATH,
            }),
        ).toThrow("schema mismatch");
    });
});

describe("m[0]/m[1] materialization", () => {
    it("renders complete date ranges into m[0] only when temporal awareness is enabled", () => {
        db = makeDb();
        storeDatedCompartment();
        createOpenCodeMessageTimes([
            { id: "m1", timestamp: new Date(2026, 0, 2, 12).getTime() },
            { id: "m2", timestamp: new Date(2026, 0, 3, 12).getTime() },
        ]);

        const rendered = materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            temporalAwareness: true,
        });

        expect(rendered.m0Text).toContain("## 1-2 · 2026-01-02→03 · dated compartment");
    });

    it("omits compartment date ranges from m[0] when temporal awareness is disabled", () => {
        db = makeDb();
        storeDatedCompartment();
        createOpenCodeMessageTimes([
            { id: "m1", timestamp: new Date(2026, 0, 2, 12).getTime() },
            { id: "m2", timestamp: new Date(2026, 0, 3, 12).getTime() },
        ]);

        const rendered = materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            temporalAwareness: false,
        });

        expect(rendered.m0Text).toContain("## 1-2 · dated compartment");
        expect(rendered.m0Text).not.toContain("2026-01-02");
    });

    it("replays date-bearing m[0]/m[1] bytes unchanged on consecutive defer passes", () => {
        db = makeDb();
        storeDatedCompartment();
        createOpenCodeMessageTimes([
            { id: "m1", timestamp: new Date(2026, 0, 2, 12).getTime() },
            { id: "m2", timestamp: new Date(2026, 0, 3, 12).getTime() },
        ]);
        const state = readStateFromMeta();

        const first = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state,
            temporalAwareness: true,
            isCacheBustingPass: true,
        });
        const second = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state,
            temporalAwareness: true,
            isCacheBustingPass: false,
        });
        const third = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state,
            temporalAwareness: true,
            isCacheBustingPass: false,
        });

        expect(first.m0Bytes?.toString("utf8")).toContain(
            "## 1-2 · 2026-01-02→03 · dated compartment",
        );
        expect(second.m0Bytes).toEqual(first.m0Bytes);
        expect(second.m1Text).toBe(first.m1Text);
        expect(third.m0Bytes).toEqual(second.m0Bytes);
        expect(third.m1Text).toBe(second.m1Text);
    });

    it("keeps mixed message bytes identical when the marker probe replays cached injection", () => {
        db = makeDb();
        const state = readStateFromMeta();
        const fixture = [
            userMessage("mixed-user", "[dropped §1§] user boundary"),
            {
                info: { id: "mixed-a", role: "assistant", sessionID: SESSION_ID },
                parts: [
                    { type: "reasoning", text: "signed reasoning", signature: "sig" },
                    { type: "text", text: "<thinking>inline trace</thinking>answer" },
                    { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
                ],
            },
            {
                info: { id: "mixed-b", role: "assistant", sessionID: SESSION_ID },
                parts: [{ type: "text", text: "[dropped §2§]" }],
            },
        ] as unknown as MessageLike[];
        const firstMessages = structuredClone(fixture) as MessageLike[];
        const secondMessages = structuredClone(fixture) as MessageLike[];

        const first = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: firstMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            isCacheBustingPass: true,
        });
        const second = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: secondMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            isCacheBustingPass: false,
        });

        expect(first.prependedMessageCount).toBe(2);
        expect(second.prependedMessageCount).toBe(2);
        expect(second.m0Bytes).toEqual(first.m0Bytes);
        expect(second.m1Text).toBe(first.m1Text);
        expect(JSON.stringify(secondMessages)).toBe(JSON.stringify(firstMessages));
    });

    it("mustMaterialize returns true on first call", () => {
        db = makeDb();
        const decision = mustMaterialize({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory: makeProjectDir(),
        });
        expect(decision).toEqual({ value: true, reason: "first_render" });
    });

    it("mustMaterialize returns false when cached markers match current state", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();

        const decision = mustMaterialize({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(decision).toEqual({ value: false, reason: null });
    });

    it("changes the memory snapshot key when the kernel serves a different snapshot", () => {
        db = makeDb();
        const read = () =>
            readCurrentM0SnapshotMarkers({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                projectPath: PROJECT_PATH,
                projectDirectory: "",
            });
        const before = read();
        const seeded = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "PROJECT_RULES",
            content: "A background write must change the key.",
        });
        const afterWrite = read();
        expect(afterWrite.memorySnapshotKey).not.toBe(before.memorySnapshotKey);

        kernelFor(db).touch(seeded.id);
        expect(read().memorySnapshotKey).toBe(afterWrite.memorySnapshotKey);

        reviseSeededMemory(db, seeded.id);
        const afterRevision = read();
        expect(afterRevision.memorySnapshotKey).not.toBe(afterWrite.memorySnapshotKey);

        const unavailableRead = readCurrentM0SnapshotMarkers({
            db,
            memory: { state: unavailable("daemon_absent"), rows: [], knownAsOf: null },
            sessionId: SESSION_ID,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
        });
        expect(unavailableRead.memorySnapshotKey).not.toBe(afterRevision.memorySnapshotKey);
    });

    it("returns the same memory snapshot key for an unchanged snapshot", () => {
        db = makeDb();
        const args = {
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
        };

        const before = readCurrentM0SnapshotMarkers(args);
        const after = readCurrentM0SnapshotMarkers(args);

        expect(after.memorySnapshotKey).toEqual(before.memorySnapshotKey);
        expect(after.renderedRevisionLocators).toEqual(before.renderedRevisionLocators);
    });

    it("folds a legacy render epoch once, then replays m[0]/m[1] byte-identically", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_upgrade_state = ? WHERE session_id = ?",
        ).run(
            Buffer.from("<session-history>legacy renderer bytes</session-history>"),
            "ready",
            SESSION_ID,
        );
        const state = readStateFromMeta();

        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }),
        ).toEqual({ value: true, reason: "compartment_render_epoch" });

        const folded = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const replay1 = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const replay2 = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(folded.m0RematerializedThisPass).toBe(true);
        expect(folded.decision.reason).toBe("compartment_render_epoch");
        expect(replay1.m0RematerializedThisPass).toBe(false);
        expect(replay2.m0RematerializedThisPass).toBe(false);
        expect(replay1.m0Bytes).toEqual(folded.m0Bytes);
        expect(replay2.m0Bytes).toEqual(folded.m0Bytes);
        expect(replay1.m1Text).toBe(folded.m1Text);
        expect(replay2.m1Text).toBe(folded.m1Text);
        expect(state.cachedM0UpgradeState).toContain(COMPARTMENT_RENDER_EPOCH);
        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }),
        ).toEqual({ value: false, reason: null });
    });

    it("keeps single-project m[0]/m[1] bytes identical with the no-workspace context", () => {
        const render = (explicitSingleProjectContext: boolean): string => {
            const localDb = makeDb();
            try {
                insertMemory(localDb, {
                    projectPath: PROJECT_PATH,
                    category: "CONSTRAINTS",
                    content: "Never commit without tests",
                });
                const rendered = materializeM0({
                    db: localDb,
                    memory: memoryFor(localDb),
                    sessionId: SESSION_ID,
                    state: getOrCreateSessionMeta(localDb, SESSION_ID),
                    projectPath: PROJECT_PATH,
                    projectDirectory: "",
                    workspaceIdentitySet: explicitSingleProjectContext
                        ? { identities: [PROJECT_PATH], namesByIdentity: new Map() }
                        : undefined,
                });
                return `${rendered.m0Bytes.toString("utf8")}\n---m1---\n${rendered.m1Text}`;
            } finally {
                closeQuietly(localDb);
            }
        };

        const normalizeLocator = (value: string) =>
            value.replace(/mem_[a-f0-9]{32}/g, "mem_OBJECT_ID");
        expect(normalizeLocator(render(true))).toBe(normalizeLocator(render(false)));
    });

    it("mustMaterialize folds when the cached memory snapshot key is not the current one", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "Snapshot key mismatch fixture",
        });
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        expect(state.cachedM0ClaimSnapshotVector).toBe(memorySnapshotKey(memoryFor(db)));
        state.cachedM0ClaimSnapshotVector = "available@99#1";

        const decision = mustMaterialize({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        expect(decision.value).toBe(true);
        expect(decision.reason).toBe("project_memory_change");
    });

    it("mustMaterialize does NOT materialize m[0] on a new compartment (it rides m[1])", () => {
        // New compartments with sequence > cachedM0Seq render in m[1] until a HARD bust.
        // New compartments remain in m[1] so routine historian publishes preserve the m[0] prompt-cache prefix.
        // New compartments fold into m[0] only on a HARD bust.
        db = makeDb();
        createOpenCodeMessageTimes([{ id: "m1", timestamp: new Date(2026, 0, 4, 12).getTime() }]);
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
            temporalAwareness: true,
        });
        const state = readStateFromMeta();
        appendCompartments(db, SESSION_ID, [
            {
                sequence: 2,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "m1",
                endMessageId: "m1",
                title: "New",
                content: "New summary",
                p1: "New summary",
            },
        ]);

        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).value,
        ).toBe(false);
        const refreshed = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            temporalAwareness: true,
            isCacheBustingPass: true,
        });
        expect(refreshed.m0RematerializedThisPass).toBe(false);
        expect(refreshed.m1Text).toContain("## 1-1 · 2026-01-04 · New");
    });

    it("mustMaterialize folds m[0] when a new direct claim changes the snapshot vector", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();

        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "PROJECT_RULES",
            content:
                "Verify provider-executed tool availability before describing it as supported.",
            sourceSessionId: SESSION_ID,
            sourceType: "dreamer",
            metadataJson: JSON.stringify({ source: "retrospective" }),
        });

        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }),
        ).toMatchObject({ value: true, reason: "project_memory_change" });
    });

    it("mustMaterialize does NOT materialize m[0] on the FIRST compartment (sequence 0)", () => {
        // Use -1 as EMPTY_MAX_COMPARTMENT_SEQ so readNewCompartments includes sequence 0.
        // `mustMaterialize` leaves sequence 0 in m[1] until the next HARD bust.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m1",
                    endMessageId: "m1",
                    title: "First",
                    content: "First summary",
                    p1: "First summary",
                },
            ],
            [],
        );

        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).value,
        ).toBe(false);
    });

    it("mustMaterialize detects a new m0_mutation_log entry by monotonic id", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        queueM0Mutation(db, {
            sessionId: SESSION_ID,
            mutationType: "compartment_merge",
            queuedAt: 1,
        });

        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).reason,
        ).toBe("max_mutation_id");
    });

    it("mustMaterialize treats project docs hash changes as a SOFT defer input", () => {
        // Docs-only edits remain outside m[0] until a HARD bust refreshes it.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        writeFileSync(join(projectDirectory, "ARCHITECTURE.md"), "# New architecture\n");

        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }),
        ).toEqual({ value: false, reason: null });
    });

    it("omits project docs with injectDocs=false and replays byte-identical defer bytes", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        writeFileSync(
            join(projectDirectory, "ARCHITECTURE.md"),
            "# FLAG_OFF_ARCH_DOCS\nArchitecture bytes must stay out.\n",
        );
        writeFileSync(
            join(projectDirectory, "STRUCTURE.md"),
            "# FLAG_OFF_STRUCTURE_DOCS\nStructure bytes must stay out.\n",
        );
        const state = readStateFromMeta();
        const hardSignals = {
            systemHash: "sys-docs-off",
            modelKey: "model-docs-off",
            cacheExpired: false,
            lastResponseTime: 0,
        };

        const first = [userMessage("m1", "hello")];
        const firstResult = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            injectDocs: false,
            hardSignals,
        });
        const firstM0 = renderedText(first[0]);
        const firstM1 = renderedText(first[1]);

        expect(firstResult.m0RematerializedThisPass).toBe(true);
        expect(firstM0).not.toContain("<project-docs>");
        expect(firstM0).not.toContain("FLAG_OFF_ARCH_DOCS");
        expect(firstM0).not.toContain("FLAG_OFF_STRUCTURE_DOCS");
        expect(state.cachedM0ProjectDocsHash).toBe("");
        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
                injectDocs: false,
                hardSignals,
            }),
        ).toEqual({ value: false, reason: null });

        const second = [userMessage("m2", "hello again")];
        const secondResult = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: second,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            injectDocs: false,
            hardSignals,
        });

        expect(secondResult.m0RematerializedThisPass).toBe(false);
        expect(renderedText(second[0])).toBe(firstM0);
        expect(renderedText(second[1])).toBe(firstM1);
        expect(renderedText(second[0])).not.toContain("FLAG_OFF_ARCH_DOCS");
        expect(renderedText(second[0])).not.toContain("FLAG_OFF_STRUCTURE_DOCS");
    });

    it("folds current project docs on the next natural HARD materialization", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        writeFileSync(join(projectDirectory, "ARCHITECTURE.md"), "# Old architecture\n");
        const state = readStateFromMeta();
        const first = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            hardSignals: {
                systemHash: "sys-v1",
                modelKey: "model-v1",
                cacheExpired: false,
                lastResponseTime: 0,
            },
        });
        expect(renderedText(first[0])).toContain("Old architecture");
        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
                injectDocs: false,
                hardSignals: {
                    systemHash: "sys-v1",
                    modelKey: "model-v1",
                    cacheExpired: false,
                    lastResponseTime: 0,
                },
            }),
        ).toEqual({ value: false, reason: null });

        writeFileSync(
            join(projectDirectory, "ARCHITECTURE.md"),
            "# Updated architecture\nFresh docs folded on hard bust.\n",
        );
        const second = [userMessage("m2", "hello again")];
        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: second,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            hardSignals: {
                systemHash: "sys-v2",
                modelKey: "model-v1",
                cacheExpired: false,
                lastResponseTime: 0,
            },
        });

        expect(result.m0RematerializedThisPass).toBe(true);
        expect(result.decision.reason).toBe("system_hash");
        expect(renderedText(second[0])).toContain("Updated architecture");
        expect(renderedText(second[0])).toContain("Fresh docs folded on hard bust.");
        expect(renderedText(second[0])).not.toContain("Old architecture");
    });

    it("v2: a session facts version bump does NOT trigger re-materialization", () => {
        // Changes to session_facts do not rebuild m[0] because m[0] does not render session_facts.
        // `facts-version` changes must not rebuild m[0] because m[0] does not render `session_facts`.
        // Changes to session_facts do not rebuild m[0].
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        db.exec("BEGIN");
        bumpSessionFactsVersion(db, SESSION_ID);
        db.exec("COMMIT");

        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).reason,
        ).not.toBe("session_facts_version");
    });

    it("materializeM0 Phase 3 commits all cached_m0 fields", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const result = materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const row = db
            .prepare(
                `SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_claim_format_epoch,
                        cached_m0_claim_snapshot_vector, cached_m0_rendered_revision_locators,
                        cached_m0_project_user_profile_version, cached_m0_max_compartment_seq,
                        cached_m0_max_mutation_id, cached_m0_project_docs_hash,
                        cached_m0_materialized_at, cached_m0_session_facts_version,
                        cached_m0_upgrade_state
                   FROM session_meta WHERE session_id = ?`,
            )
            .get(SESSION_ID) as Record<string, unknown>;

        expect(row.cached_m0_bytes).not.toBeNull();
        expect(row.cached_m1_bytes).not.toBeNull();
        expect(Buffer.from(row.cached_m0_bytes as Buffer).toString("utf8")).toBe(result.m0Text);
        expect(Buffer.from(row.cached_m1_bytes as Buffer).toString("utf8")).toBe(result.m1Text);
        expect(typeof row.cached_m0_claim_format_epoch).toBe("number");
        expect(row.cached_m0_claim_snapshot_vector).toBe(result.snapshotMarkers.memorySnapshotKey);
        expect(JSON.parse(String(row.cached_m0_rendered_revision_locators))).toEqual([]);
        expect(row.cached_m0_project_user_profile_version).toBe(0);
        expect(row.cached_m0_max_compartment_seq).toBe(-1);
        expect(row.cached_m0_max_mutation_id).toBe(0);
        expect(row.cached_m0_project_docs_hash).toBe("");
        expect(typeof row.cached_m0_materialized_at).toBe("number");
        expect(row.cached_m0_session_facts_version).toBe(0);
        expect(row.cached_m0_upgrade_state).toBe(
            encodeCachedM0UpgradeIdentity("ready", COMPARTMENT_RENDER_EPOCH, false, "m8000-h60000"),
        );
    });

    it("materializeM0 persists memory_block_ids/count for the rendered memory set", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const id1 = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "memory one",
        }).id;
        const id2 = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "memory two",
        }).id;
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const row = db
            .prepare(
                "SELECT memory_block_count, memory_block_ids FROM session_meta WHERE session_id = ?",
            )
            .get(SESSION_ID) as { memory_block_count: number; memory_block_ids: string };
        expect(row.memory_block_count).toBe(2);
        const locators = JSON.parse(row.memory_block_ids) as string[];
        expect(new Set(locators)).toEqual(new Set([id1, id2]));
    });

    it("publishes new claim locators only after the snapshot-vector fold", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const initialId = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "Initial visible claim",
        }).id;
        materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        expect(getVisibleRevisionLocators(db, SESSION_ID)).toEqual(new Set([initialId]));

        const newId = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "New claim appears after vector fold",
        }).id;
        expect(getVisibleRevisionLocators(db, SESSION_ID)?.has(newId)).toBe(false);

        const messages = [userMessage("m2", "fold")];
        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        expect(result.m0RematerializedThisPass).toBe(true);
        expect(result.decision.reason).toBe("project_memory_change");
        expect(renderedText(messages[0])).toContain("New claim appears after vector fold");
        expect(getVisibleRevisionLocators(db, SESSION_ID)).toEqual(new Set([initialId, newId]));
    });

    it("materializeM0 sizes session-history to the HISTORY budget, not budget minus project-docs", () => {
        // The history budget applies only to the `<session-history>` slice.
        // Large <project-docs> blocks must not reduce the history budget or archive additional compartments.
        const HISTORY_BUDGET = 40_000;
        const mkCompartments = () =>
            Array.from({ length: 120 }, (_, i) => ({
                sequence: i,
                startMessage: i * 10 + 1,
                endMessage: i * 10 + 9,
                startMessageId: `s${i}`,
                endMessageId: `e${i}`,
                title: `Compartment ${i} doing substantive work`,
                content: `P1 full body ${i}: ${"detail ".repeat(40)}`,
                p1: `P1 full body ${i}: ${"detail ".repeat(40)}`,
                p2: `P2 body ${i}: ${"detail ".repeat(20)}`,
                p3: `P3 body ${i}: ${"detail ".repeat(8)}`,
                p4: `P4 ${i}; anchor${i}`,
                importance: 70,
                episodeType: "feature",
                legacy: 0,
            }));

        db = makeDb();
        const smallDir = makeProjectDir();
        writeFileSync(join(smallDir, "ARCHITECTURE.md"), "# Small\n");
        replaceAllCompartmentState(db, SESSION_ID, mkCompartments(), []);
        const small = materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory: smallDir,
            historyBudgetTokens: HISTORY_BUDGET,
        });
        const smallHist =
            small.m0Text.match(/<session-history>[\s\S]*?<\/session-history>/)?.[0] ?? "";
        const smallTags = (smallHist.match(/<compartment\b/g) ?? []).length;
        db.close();

        db = makeDb();
        const bigDir = makeProjectDir();
        writeFileSync(
            join(bigDir, "ARCHITECTURE.md"),
            `# Big\n${"docs line of content\n".repeat(800)}`,
        );
        replaceAllCompartmentState(db, SESSION_ID, mkCompartments(), []);
        const big = materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory: bigDir,
            historyBudgetTokens: HISTORY_BUDGET,
        });
        const bigHist = big.m0Text.match(/<session-history>[\s\S]*?<\/session-history>/)?.[0] ?? "";
        const bigTags = (bigHist.match(/<compartment\b/g) ?? []).length;

        expect(big.m0Text.length).toBeGreaterThan(small.m0Text.length);
        expect(bigTags).toBe(smallTags);
        expect(bigHist.length).toBe(smallHist.length);
    });

    it("materializeM0 renders the snapshot it was handed even when the kernel moves before Phase 3", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "Frozen for this pass.",
        });
        const memory = memoryFor(db);

        const result = materializeM0({
            db,
            memory,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
            beforePhase3ForTest: () => {
                setProjectState(db, PROJECT_PATH, { projectMemoryEpoch: 1 });
                insertMemory(db, {
                    projectPath: PROJECT_PATH,
                    category: "ARCHITECTURE",
                    content: "Landed after the read.",
                });
            },
        });
        expect(result.m0Text).toContain("Frozen for this pass.");
        expect(result.m0Text).not.toContain("Landed after the read.");
        expect(result.snapshotMarkers.memorySnapshotKey).toBe(memorySnapshotKey(memory));
    });

    it("materializeWithRetry retries three times then throws", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        let attempts = 0;

        expect(() =>
            materializeWithRetry(
                {
                    db,
                    memory: memoryFor(db),
                    sessionId: SESSION_ID,
                    state: readStateFromMeta(),
                    projectPath: PROJECT_PATH,
                    projectDirectory,
                    beforePhase3ForTest: () => {
                        attempts += 1;
                        queueM0Mutation(db, {
                            sessionId: SESSION_ID,
                            mutationType: "compartment_merge",
                        });
                    },
                },
                3,
            ),
        ).toThrow(MaterializeContentionError);
        expect(attempts).toBe(3);
    });

    it("injectM0M1 updates root cached state after successful materialization", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const messages = [userMessage("m1", "hello")];

        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(result.injected).toBe(true);
        expect(result.m0RematerializedThisPass).toBe(true);
        expect(state.cachedM0Bytes).toBeInstanceOf(Buffer);
        expect(state.cachedM1Bytes).toBeInstanceOf(Buffer);
        expect(typeof state.cachedM0ClaimFormatEpoch).toBe("number");
        expect(state.cachedM0ClaimSnapshotVector).not.toBeNull();
        expect(state.cachedM0RenderedRevisionLocators).toBe("[]");
        expect(state.cachedM0MaxCompartmentSeq).toBe(-1);
        expect(state.cachedM0MaxMutationId).toBe(0);
        expect(state.cachedM0ProjectDocsHash).toBe("");
        expect(typeof state.cachedM0MaterializedAt).toBe("number");
        expect(state.cachedM0SessionFactsVersion).toBe(0);
        expect(state.cachedM0UpgradeState).toBe(
            encodeCachedM0UpgradeIdentity("ready", COMPARTMENT_RENDER_EPOCH, false, "m8000-h60000"),
        );
        expect(state.snapshotMarkers?.renderedRevisionLocators).toEqual([]);
        expect(state.snapshotMarkers?.memorySnapshotKey).toBeDefined();
        expect(
            mustMaterialize({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).value,
        ).toBe(false);
    });

    it("injectM0M1 does NOT render <project-memory> when projectPath is undefined (memory.enabled=false config bypass guard)", () => {
        // Pass `undefined` for `projectPath` so `materializeM0` omits `<project-memory>` when memory is disabled.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "Should NOT appear when memory disabled",
        });
        const state = readStateFromMeta();
        const messages = [userMessage("m1", "hello")];

        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: undefined,
            projectDirectory,
        });

        expect(result.injected).toBe(true);
        const m0 = renderedText(messages[0]);
        expect(m0).not.toContain("<project-memory>");
        expect(m0).not.toContain("Should NOT appear when memory disabled");
    });

    it("injectM0M1 still injects history when materialization contention exhausts with NO cached baseline (no throw, no empty history)", () => {
        // On exhausted contention without cached M0, render a non-persisted m[0].
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        state.cachedM0Bytes = null;
        const messages = [userMessage("m1", "hello")];

        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            // The queued mutation runs between every snapshot and swap, exhausting all retries.
            beforePhase3ForTest: () => {
                queueM0Mutation(db, {
                    sessionId: SESSION_ID,
                    mutationType: "compartment_merge",
                });
            },
        });

        expect(result.injected).toBe(true);
        const m0 = renderedText(messages[0]);
        expect(m0).toContain("<session-history>");
        expect(state.cachedM0Bytes).toBeInstanceOf(Buffer);
    });

    it("injectM0M1 does not throw on contention when m[0] is cached but m[1] is missing (partial-cache state)", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        state.cachedM0Bytes = Buffer.from("<session-history>stale</session-history>", "utf8");
        state.cachedM1Bytes = null;
        const messages = [userMessage("m1", "hello")];

        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            beforePhase3ForTest: () => {
                queueM0Mutation(db, {
                    sessionId: SESSION_ID,
                    mutationType: "compartment_merge",
                });
            },
        });

        expect(result.injected).toBe(true);
        expect(renderedText(messages[0])).toContain("<session-history>");
    });

    it("fresh-render contention fallback freezes materializedAt (stable across passes, not live Date.now())", () => {
        // Use the persisted materializedAt value, or 0 when none exists, as the m[1] expiry cutoff.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        state.cachedM0Bytes = null;
        state.cachedM0MaterializedAt = null;
        const messages = [userMessage("m1", "hello")];
        const forceContention = () => {
            queueM0Mutation(db, {
                sessionId: SESSION_ID,
                mutationType: "compartment_merge",
            });
        };
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            beforePhase3ForTest: forceContention,
        });
        expect(state.snapshotMarkers?.materializedAt).toBe(0);
    });

    it("defer pass reuses byte-identical m[0] bytes from the prior materialization", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const firstMessages = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: firstMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const firstM0 = renderedText(firstMessages[0]);

        const secondMessages = [userMessage("m2", "hello again")];
        const second = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: secondMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(second.m0RematerializedThisPass).toBe(false);
        expect(renderedText(secondMessages[0])).toBe(firstM0);
    });

    it("project identity changes hard-materialize while legacy null adopts silently", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const firstMessages = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: firstMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        state.cachedM0ProjectIdentity = null;
        db.prepare(
            "UPDATE session_meta SET cached_m0_project_identity = NULL WHERE session_id = ?",
        ).run(SESSION_ID);
        const legacyNullDecision = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: [userMessage("m2", "legacy")],
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        expect(legacyNullDecision.m0RematerializedThisPass).toBe(false);
        expect(getOrCreateSessionMeta(db, SESSION_ID).cachedM0ProjectIdentity).toBe(PROJECT_PATH);

        const changedDecision = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: [userMessage("m3", "changed")],
            state,
            projectPath: "git:changed-project",
            projectDirectory,
        });
        expect(changedDecision.decision).toEqual({ value: true, reason: "project_change" });
        expect(changedDecision.m0RematerializedThisPass).toBe(true);
    });

    it("SOFT /ctx-flush pass keeps m0 byte-identical, refreshes m1, and avoids first_render", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const hardV1 = {
            systemHash: "sys-v1",
            modelKey: "model-v1",
            cacheExpired: false,
            lastResponseTime: 0,
        };
        const baselineMessages = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: baselineMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            hardSignals: hardV1,
        });
        const m0BeforeFlush =
            baselineMessages[0].parts[0] &&
            renderedText(baselineMessages[0]).match(
                /<session-history>[\s\S]*?<\/session-history>/,
            )?.[0];
        expect(m0BeforeFlush).toBeTruthy();

        const flushMessages = [userMessage("m2", "after flush")];
        const flushPass = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: flushMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        expect(flushPass.decision.reason).not.toBe("first_render");
        expect(flushPass.m0RematerializedThisPass).toBe(false);
        const m0AfterFlush = renderedText(flushMessages[0]).match(
            /<session-history>[\s\S]*?<\/session-history>/,
        )?.[0];
        expect(m0AfterFlush).toBe(m0BeforeFlush);

        const deferMessages = [userMessage("m3", "defer")];
        const deferPass = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: deferMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        expect(deferPass.m0RematerializedThisPass).toBe(false);
        expect(renderedText(deferMessages[0])).toBe(renderedText(flushMessages[0]));
    });

    it("HARD fold binds memory expiry cutoff and materializedAt to one timestamp", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "KNOWN_ISSUES",
            content: "D16c expiry-gap memory",
            expiresAt: 10_500,
        });
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "D16c permanent anchor",
        });

        const realNow = Date.now;
        const foldAt = 10_000;
        let nowCalls = 0;
        Date.now = () => {
            nowCalls += 1;
            return nowCalls === 1 ? foldAt : 99_000;
        };

        try {
            const state = readStateFromMeta();
            const hard = {
                systemHash: "fold-a",
                modelKey: "model-v1",
                cacheExpired: false,
                lastResponseTime: 0,
            };
            const first = materializeM0({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
                hardSignals: hard,
            });
            expect(first.m0Text).toContain("D16c expiry-gap memory");
            expect(getOrCreateSessionMeta(db, SESSION_ID).cachedM0MaterializedAt).toBe(foldAt);

            nowCalls = 0;
            const state2 = readStateFromMeta();
            const second = materializeM0({
                db,
                memory: memoryFor(db),
                sessionId: SESSION_ID,
                state: state2,
                projectPath: PROJECT_PATH,
                projectDirectory,
                hardSignals: { ...hard, systemHash: "fold-b" },
            });
            expect(second.m0Text).toContain("D16c expiry-gap memory");
            expect(second.m0Text.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0]).toBe(
                first.m0Text.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0],
            );
        } finally {
            Date.now = realNow;
        }
    });

    it("does NOT drift-refold on a defer pass when m[1] is the empty placeholder (tiny-baseline guard)", () => {
        // The refold threshold excludes the empty m[1] placeholder; otherwise it can exceed 15% of a tiny m[0].
        // Including the placeholder would rematerialize m[0] on every defer pass and violate byte-identical defer caching.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const first = [userMessage("m1", "hi")];
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const firstM0 = renderedText(first[0]);

        // A defer pass with no new memories or compartments uses the empty m[1] placeholder.
        const second = [userMessage("m2", "hi again")];
        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: second,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(result.m0RematerializedThisPass).toBe(false);
        expect(renderedText(second[0])).toBe(firstM0);
        expect(result.m1Text).toContain("no new content since last materialization");
    });

    it("folds a new claim into m[0] when its snapshot vector changes", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "Initial OpenCode claim.",
        });
        const state = readStateFromMeta();
        const first = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        const initialM0 = renderedText(first[0]);

        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "New OpenCode claim folds after vector change.",
        });
        const folded = [userMessage("m2", "fold")];
        const foldResult = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: folded,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: false,
        });
        expect(foldResult.m0RematerializedThisPass).toBe(true);
        expect(foldResult.decision.reason).toBe("project_memory_change");
        expect(renderedText(folded[0])).toContain("New OpenCode claim folds after vector change.");
        expect(renderedText(folded[0])).not.toBe(initialM0);

        const replay = [userMessage("m3", "replay")];
        const replayResult = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: replay,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: false,
        });
        expect(replayResult.m0RematerializedThisPass).toBe(false);
        expect(renderedText(replay[0])).toBe(renderedText(folded[0]));
    });

    it("folds an archived claim out of m[0] and updates the locator manifest", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const memory = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "OpenCode claim removed by lifecycle fold.",
        });
        const state = readStateFromMeta();
        const first = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        expect(renderedText(first[0])).toContain("OpenCode claim removed by lifecycle fold.");
        expect(getVisibleRevisionLocators(db, SESSION_ID)).toEqual(new Set([memory.id]));

        archiveSeededMemory(db, memory.id);
        const folded = [userMessage("m2", "fold")];
        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: folded,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        expect(result.m0RematerializedThisPass).toBe(true);
        expect(result.decision.reason).toBe("project_memory_change");
        expect(renderedText(folded[0])).not.toContain("OpenCode claim removed by lifecycle fold.");
        expect(getVisibleRevisionLocators(db, SESSION_ID)).toBeNull();
    });

    it("an archive that lands before Phase 3 folds out on the next pass, not this one", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const memory = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "Frozen OpenCode claim.",
        });
        const state = readStateFromMeta();
        const first = materializeM0({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            beforePhase3ForTest: () => archiveSeededMemory(db, memory.id),
        });
        expect(first.m0Text).toContain("Frozen OpenCode claim.");

        const next = mustMaterialize({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        expect(next).toEqual({ value: true, reason: "project_memory_change" });
    });

    it("soft m1 refresh CAS rolls back and replays a sibling cached m1 on marker mismatch", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: [userMessage("m1", "hello")],
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        db.prepare(
            "UPDATE session_meta SET cached_m0_max_mutation_id = ?, cached_m1_bytes = ? WHERE session_id = ?",
        ).run(99, Buffer.from("sibling cached m1", "utf8"), SESSION_ID);

        const bust = [userMessage("m2", "bust")];
        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: bust,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });

        expect(result.m0RematerializedThisPass).toBe(false);
        expect(result.m1Text).toBe("sibling cached m1");
        expect(renderedText(bust[1])).toBe("sibling cached m1");
        expect(state.cachedM0MaxMutationId).toBe(99);
    });

    it("soft m1 refresh CAS rejects byte-different m[0] even when non-doc markers match", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: [userMessage("m1", "hello")],
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        const siblingM0 = Buffer.from(
            `<session-history>${"byte mismatch ".repeat(300)}</session-history>`,
            "utf8",
        );
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
        ).run(siblingM0, Buffer.from("sibling cached m1 byte mismatch", "utf8"), SESSION_ID);

        const bust = [userMessage("m2", "bust")];
        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: bust,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });

        expect(result.m0RematerializedThisPass).toBe(false);
        expect(result.m1Text).toBe("sibling cached m1 byte mismatch");
        expect(renderedText(bust[0])).toBe(siblingM0.toString("utf8"));
        expect(state.cachedM0Bytes?.toString("utf8")).toBe(siblingM0.toString("utf8"));
    });

    it("claim vector changes force a hard fold despite docs-marker drift", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const first = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        const baselineM0 = renderedText(first[0]);
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "docs-hash-only CAS delta memory",
        });
        db.prepare(
            "UPDATE session_meta SET cached_m0_project_docs_hash = ? WHERE session_id = ?",
        ).run("docs-only-marker-drift", SESSION_ID);

        const bust = [userMessage("m2", "bust")];
        const result = injectM0M1({
            db,
            memory: memoryFor(db),
            sessionId: SESSION_ID,
            messages: bust,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });

        expect(result.m0RematerializedThisPass).toBe(true);
        expect(renderedText(bust[0])).not.toBe(baselineM0);
        expect(renderedText(bust[0])).toContain("docs-hash-only CAS delta memory");
        expect(result.m1Text).not.toContain("<new-memories>");
    });
});
