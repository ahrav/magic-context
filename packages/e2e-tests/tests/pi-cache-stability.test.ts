/// <reference types="bun-types" />

import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database as CoreDatabase } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { PiTestHarness } from "../src/pi-harness";
import { openTestDb } from "../src/test-db";

interface HarnessOptions {
    magicContextConfig?: Record<string, unknown>;
    modelContextLimit?: number;
    sharedDataDir?: string;
}

async function withPiHarness<T>(
    options: HarnessOptions,
    fn: (h: PiTestHarness) => Promise<T>,
): Promise<T> {
    const h = await PiTestHarness.create(options);
    try {
        return await fn(h);
    } finally {
        await h.dispose();
    }
}

function createCurrentSchemaDataDir(): { dataDir: string; rootDir: string } {
    // This test covers request transforms rather than startup migration.
    // Initialize a current-schema data directory so the migration safety check
    // does not disable the extension when another local Pi process is running.
    const rootDir = mkdtempSync(join(tmpdir(), "pi-cache-stability-schema-"));
    const dataDir = join(rootDir, "data");
    const dbDir = join(dataDir, "cortexkit", "magic-context");
    mkdirSync(dbDir, { recursive: true });
    const db = new CoreDatabase(join(dbDir, "context.db"));
    try {
    } finally {
        closeQuietly(db);
    }
    return { dataDir, rootDir };
}

function openWritableDb(h: PiTestHarness): Database {
    return openTestDb(h.contextDbPath(), { readwrite: true });
}

function readDb<T>(h: PiTestHarness, fn: (db: Database) => T): T {
    const db = openTestDb(h.contextDbPath(), { readonly: true });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

function writeDb<T>(h: PiTestHarness, fn: (db: Database) => T): T {
    const db = openWritableDb(h);
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

function mainRequests(h: PiTestHarness) {
    return h.mock.requests().filter((request) => {
        const system = request.body.system;
        if (system === undefined || system === null) return false;
        const asString =
            typeof system === "string" ? system : JSON.stringify(system);
        return asString.includes("## Magic Context");
    });
}

function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === "object") {
        const output: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            if (key === "cache_control") continue;
            output[key] = stripCacheControl(child);
        }
        return output;
    }
    return value;
}

function serialize(value: unknown): string {
    return JSON.stringify(value);
}

function serializeDurablePrefix(value: unknown): string {
    return JSON.stringify(stripCacheControl(value));
}

function requestMessages(request: { body: { messages?: unknown } }): unknown[] {
    return Array.isArray(request.body.messages) ? request.body.messages : [];
}

/**
 *
 * v2 moves <project-docs>/<user-profile>/<key-files> out of the system
 * prompt and into the m[0]/m[1] messages (prepended as the first two user
 * messages by prependM0M1Messages). Content-presence assertions must scan
 * the whole wire, not just body.system.
 */
function wireText(request: {
    body: { system?: unknown; messages?: unknown };
}): string {
    const parts: string[] = [];
    const sys = request.body.system;
    if (typeof sys === "string") parts.push(sys);
    else if (sys != null) parts.push(JSON.stringify(sys));
    for (const msg of requestMessages(request)) {
        if (msg && typeof msg === "object") {
            const content = (msg as { content?: unknown }).content;
            if (typeof content === "string") parts.push(content);
            else if (Array.isArray(content)) {
                for (const block of content) {
                    if (block && typeof block === "object" && "text" in block) {
                        const t = (block as { text: unknown }).text;
                        if (typeof t === "string") parts.push(t);
                    }
                }
            }
        }
    }
    return parts.join("\n");
}

function firstUserMessage(request: { body: { messages?: unknown } }): unknown {
    return requestMessages(request).find(
        (message) =>
            message !== null &&
            typeof message === "object" &&
            (message as { role?: unknown }).role === "user",
    );
}

function maxTagNumber(h: PiTestHarness, sessionId: string): number {
    return readDb(h, (db) => {
        const row = db
            .prepare(
                "SELECT COALESCE(MAX(tag_number), 0) AS n FROM tags WHERE session_id = ?",
            )
            .get(sessionId) as { n: number } | null;
        return row?.n ?? 0;
    });
}

function minTagNumber(h: PiTestHarness, sessionId: string): number {
    return readDb(h, (db) => {
        const row = db
            .prepare(
                "SELECT COALESCE(MIN(tag_number), 0) AS n FROM tags WHERE session_id = ?",
            )
            .get(sessionId) as { n: number } | null;
        return row?.n ?? 0;
    });
}

function queueDrop(
    h: PiTestHarness,
    sessionId: string,
    tagNumber: number,
): void {
    writeDb(h, (db) => {
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, 'pi')",
        ).run(sessionId, tagNumber, Date.now());
    });
}

function piBustCount(h: PiTestHarness, sessionId: string, sinceMs = 0): number {
    return readDb(h, (db) => {
        const row = db
            .prepare(
                "SELECT COUNT(*) AS n FROM transform_decisions WHERE session_id = ? AND harness = 'pi' AND ts_ms >= ?",
            )
            .get(sessionId, sinceMs) as { n: number } | null;
        return row?.n ?? 0;
    });
}

describe("pi cache stability", () => {
    it("keeps three quiet mural-enabled passes byte-stable with zero cache busts", async () => {
        const isolated = createCurrentSchemaDataDir();
        try {
            await withPiHarness(
                {
                    sharedDataDir: isolated.dataDir,
                    magicContextConfig: {
                        protected_tags: 0,
                        execute_threshold_percentage: 90,
                        mural: { enabled: true },
                        memory: {
                            auto_search: { enabled: false },
                            git_commit_indexing: { enabled: false },
                        },
                    },
                },
                async (h) => {
                    h.mock.setDefault({
                        text: "ok",
                        usage: {
                            input_tokens: 100,
                            output_tokens: 10,
                            cache_creation_input_tokens: 100,
                        },
                    });

                    const warm = await h.sendPrompt("warm the Pi session", {
                        timeoutMs: 60_000,
                    });
                    expect(warm.sessionId).toBeTruthy();
                    await h.sendPrompt(
                        "establish the stable mural-enabled baseline",
                        {
                            timeoutMs: 60_000,
                            continueSession: true,
                        },
                    );
                    await h.waitFor(() => h.countTags(warm.sessionId!) > 0, {
                        label: "quiet-pass baseline tag",
                    });
                    const cachedUpgradeState = readDb(h, (db) => {
                        const row = db
                            .prepare(
                                "SELECT cached_m0_upgrade_state AS value FROM session_meta WHERE session_id = ?",
                            )
                            .get(warm.sessionId!) as {
                            value: string | null;
                        } | null;
                        return row?.value ?? "";
                    });
                    expect(cachedUpgradeState).toContain("mural-enabled:1");
                    const queuedTag = minTagNumber(h, warm.sessionId!);
                    queueDrop(h, warm.sessionId!, queuedTag);

                    const quietStartedAt = Date.now();
                    const requestStart = h.requests().length - 1;
                    const quietPasses = 3;
                    for (let index = 0; index < quietPasses; index += 1) {
                        await h.sendPrompt(`quiet pass ${index + 1}`, {
                            timeoutMs: 60_000,
                            continueSession: true,
                        });
                    }

                    expect(h.countPendingOps(warm.sessionId!)).toBe(1);
                    expect(
                        piBustCount(h, warm.sessionId!, quietStartedAt),
                    ).toBe(0);
                    const requests = h.requests().slice(requestStart);
                    expect(requests).toHaveLength(quietPasses + 1);
                    for (
                        let index = 0;
                        index < requests.length - 1;
                        index += 1
                    ) {
                        const earlier = requestMessages(requests[index]!);
                        const later = requestMessages(requests[index + 1]!);
                        expect(earlier.length).toBeLessThanOrEqual(
                            later.length,
                        );
                        for (
                            let messageIndex = 0;
                            messageIndex < earlier.length;
                            messageIndex += 1
                        ) {
                            expect(
                                serializeDurablePrefix(later[messageIndex]),
                            ).toBe(
                                serializeDurablePrefix(earlier[messageIndex]),
                            );
                        }
                    }
                },
            );
        } finally {
            rmSync(isolated.rootDir, { recursive: true, force: true });
        }
    }, 180_000);

    it("persists tag source_contents once with harness='pi' and keeps original unprefixed text", async () => {
        await withPiHarness({}, async (h) => {
            const original =
                "pi source persistence: keep this exact unprefixed user text";
            h.mock.setDefault({
                text: "first response",
                usage: {
                    input_tokens: 120,
                    output_tokens: 10,
                    cache_creation_input_tokens: 120,
                },
            });

            const first = await h.sendPrompt(original, { timeoutMs: 60_000 });
            expect(first.exitCode).toBeNull();
            expect(first.sessionId).toBeTruthy();

            await h.waitFor(() => h.countTags(first.sessionId!) > 0, {
                label: "pi tags persisted",
            });

            const initial = readDb(h, (db) => {
                return db
                    .prepare(
                        `SELECT t.tag_number, t.harness AS tag_harness, s.content, s.harness AS source_harness, s.created_at
                         FROM tags t
                         JOIN source_contents s ON s.session_id = t.session_id AND s.tag_id = t.tag_number
                         WHERE t.session_id = ? AND t.type = 'message'
                         ORDER BY t.tag_number ASC
                         LIMIT 1`,
                    )
                    .get(first.sessionId!) as {
                    tag_number: number;
                    tag_harness: string;
                    source_harness: string;
                    content: string;
                    created_at: number;
                } | null;
            });
            expect(initial).not.toBeNull();
            expect(initial!.tag_harness).toBe("pi");
            expect(initial!.source_harness).toBe("pi");
            expect(initial!.content).toBe(original);
            expect(initial!.content).not.toContain("§");

            h.mock.setDefault({
                text: "second response",
                usage: {
                    input_tokens: 125,
                    output_tokens: 10,
                    cache_creation_input_tokens: 125,
                },
            });
            const second = await h.sendPrompt(
                "second pass retags prior content",
                {
                    timeoutMs: 60_000,
                    continueSession: true,
                },
            );
            expect(second.exitCode).toBeNull();

            const after = readDb(h, (db) => {
                const count = db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM source_contents WHERE session_id = ? AND tag_id = ?",
                    )
                    .get(first.sessionId!, initial!.tag_number) as {
                    n: number;
                } | null;
                const row = db
                    .prepare(
                        "SELECT content, harness, created_at FROM source_contents WHERE session_id = ? AND tag_id = ?",
                    )
                    .get(first.sessionId!, initial!.tag_number) as {
                    content: string;
                    harness: string;
                    created_at: number;
                } | null;
                return { count: count?.n ?? 0, row };
            });
            expect(after.count).toBe(1);
            expect(after.row?.content).toBe(original);
            expect(after.row?.harness).toBe("pi");
            expect(after.row?.created_at).toBe(initial!.created_at);
        });
    }, 120_000);

    it("replays caveman-compressed text byte-identically from source_contents on defer passes", async () => {
        await withPiHarness(
            {
                magicContextConfig: {
                    execute_threshold_percentage: 90,
                    caveman_text_compression: { enabled: true, min_chars: 40 },
                    memory: {
                        auto_search: { enabled: false },
                        git_commit_indexing: { enabled: false },
                    },
                },
            },
            async (h) => {
                const largeOriginal =
                    "Pi caveman replay source. " +
                    "This sentence intentionally has many connective words and repeated structure so lite compression has material. ".repeat(
                        8,
                    );
                h.mock.setDefault({
                    text: "ok",
                    usage: {
                        input_tokens: 80,
                        output_tokens: 10,
                        cache_creation_input_tokens: 80,
                    },
                });

                const first = await h.sendPrompt(largeOriginal, {
                    timeoutMs: 60_000,
                });
                expect(first.sessionId).toBeTruthy();
                await h.waitFor(() => h.countTags(first.sessionId!) > 0, {
                    label: "tag ready",
                });

                const tagNumber = readDb(h, (db) => {
                    const row = db
                        .prepare(
                            "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'message' ORDER BY tag_number ASC LIMIT 1",
                        )
                        .get(first.sessionId!) as { tag_number: number } | null;
                    return row?.tag_number ?? 0;
                });
                expect(tagNumber).toBeGreaterThan(0);

                // Simulate the execute pass that escalated this tag to lite/depth 2.
                // Subsequent low-pressure Pi turns replay from the pristine source row, not already-compressed text.
                writeDb(h, (db) => {
                    db.prepare(
                        "UPDATE tags SET caveman_depth = 2 WHERE session_id = ? AND tag_number = ?",
                    ).run(first.sessionId!, tagNumber);
                });

                await h.sendPrompt("defer pass one after caveman", {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                const replayOne = firstUserMessage(mainRequests(h).at(-1)!);

                await h.sendPrompt("defer pass two after caveman", {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                const replayTwo = firstUserMessage(mainRequests(h).at(-1)!);

                expect(serialize(replayTwo)).toBe(serialize(replayOne));

                const source = readDb(h, (db) => {
                    const row = db
                        .prepare(
                            "SELECT content FROM source_contents WHERE session_id = ? AND tag_id = ?",
                        )
                        .get(first.sessionId!, tagNumber) as {
                        content: string;
                    } | null;
                    return row?.content ?? "";
                });
                expect(source).toBe(largeOriginal);
            },
        );
    }, 180_000);

    it("materializes queued text drops only on an execute pass, preserving defer-pass prefix stability", async () => {
        await withPiHarness(
            {
                modelContextLimit: 200,
                magicContextConfig: {
                    protected_tags: 1,
                    execute_threshold_percentage: 20,
                },
            },
            async (h) => {
                h.mock.script([
                    // A fresh Pi session starts with stable-ID scheme 0.
                    // The first pass that resolves real `SessionEntry` IDs changes the stable-ID scheme to 1 and forces execute and materialize.
                    // The first pass that resolves real SessionEntry IDs performs the one-time v25 cutover, forcing execute and materialize.
                    // Run this turn before the defer assertion because the v25 cutover forces execute+materialize on first SessionEntry-ID resolution.
                    {
                        text: "warm-up: absorb the one-time stable-id cutover",
                        usage: {
                            input_tokens: 10,
                            output_tokens: 5,
                            cache_creation_input_tokens: 10,
                        },
                    },
                    {
                        text: "low pressure one",
                        usage: {
                            input_tokens: 10,
                            output_tokens: 5,
                            cache_creation_input_tokens: 10,
                        },
                    },
                    {
                        text: "high pressure marker for next transform",
                        usage: {
                            input_tokens: 150,
                            output_tokens: 5,
                            cache_creation_input_tokens: 150,
                        },
                    },
                    {
                        text: "after materialization",
                        usage: {
                            input_tokens: 20,
                            output_tokens: 5,
                            cache_creation_input_tokens: 20,
                        },
                    },
                ]);

                // Warm-up turn: lets the stable-id cutover complete (scheme → 1)
                // before we queue a drop, so the next turn is a genuine defer.
                const warm = await h.sendPrompt("warm-up turn", {
                    timeoutMs: 60_000,
                });
                expect(warm.sessionId).toBeTruthy();

                const firstText =
                    "pi queued drop target should survive one defer pass";
                const first = await h.sendPrompt(firstText, {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                expect(first.sessionId).toBeTruthy();
                await h.waitFor(() => h.countTags(first.sessionId!) > 0, {
                    label: "tag ready",
                });
                // Drop the firstText message's tag. Resolve its tag number from
                // the DB rather than hardcoding — with the warm-up turn ahead of
                // it, firstText is no longer guaranteed to be tag 1.
                const dropTag = readDb(h, (db) => {
                    const row = db
                        .prepare(
                            `SELECT t.tag_number AS n FROM tags t
                             JOIN source_contents sc
                               ON sc.session_id = t.session_id AND sc.tag_id = t.tag_number
                             WHERE t.session_id = ? AND t.type = 'message'
                               AND sc.content LIKE '%queued drop target%'
                             ORDER BY t.tag_number DESC LIMIT 1`,
                        )
                        .get(first.sessionId!) as { n: number } | undefined;
                    return row?.n;
                });
                expect(dropTag).toBeGreaterThan(0);
                queueDrop(h, first.sessionId!, dropTag!);

                await h.sendPrompt(
                    "second turn stays defer and must not drain pending_ops",
                    {
                        timeoutMs: 60_000,
                        continueSession: true,
                    },
                );
                expect(h.countPendingOps(first.sessionId!)).toBe(1);
                expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain(
                    firstText,
                );
                expect(
                    JSON.stringify(h.mock.lastRequest()!.body),
                ).not.toContain(`dropped §${dropTag}§`);

                await h.sendPrompt(
                    "third turn sees prior high usage and executes drops",
                    {
                        timeoutMs: 60_000,
                        continueSession: true,
                    },
                );
                expect(h.countPendingOps(first.sessionId!)).toBe(0);
                expect(
                    h.countDroppedTags(first.sessionId!),
                ).toBeGreaterThanOrEqual(1);
                expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain(
                    `dropped §${dropTag}§`,
                );
            },
        );
    }, 180_000);

    it("keeps toolCall/toolResult pairing intact when a queued Pi tool drop materializes", async () => {
        await withPiHarness(
            {
                modelContextLimit: 200,
                magicContextConfig: {
                    protected_tags: 1,
                    execute_threshold_percentage: 20,
                },
            },
            async (h) => {
                const callId = "toolu_pi_pairing_cache_stability";
                h.mock.script([
                    {
                        content: [
                            {
                                type: "tool_use",
                                id: callId,
                                name: "ctx_search",
                                input: {
                                    query: "pi no result expected",
                                    limit: 1,
                                },
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: {
                            input_tokens: 20,
                            output_tokens: 5,
                            cache_creation_input_tokens: 20,
                        },
                    },
                    {
                        text: "tool loop complete",
                        usage: {
                            input_tokens: 30,
                            output_tokens: 5,
                            cache_creation_input_tokens: 30,
                        },
                    },
                    {
                        text: "high usage before materialization",
                        usage: {
                            input_tokens: 150,
                            output_tokens: 5,
                            cache_creation_input_tokens: 150,
                        },
                    },
                    {
                        text: "after tool drop",
                        usage: {
                            input_tokens: 20,
                            output_tokens: 5,
                            cache_creation_input_tokens: 20,
                        },
                    },
                ]);

                const first = await h.sendPrompt(
                    "call ctx_search once so Pi stores a tool pair",
                    {
                        timeoutMs: 60_000,
                    },
                );
                expect(first.sessionId).toBeTruthy();

                const toolTag = await h.waitFor(
                    () =>
                        readDb(h, (db) => {
                            const row = db
                                .prepare(
                                    "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number ASC LIMIT 1",
                                )
                                .get(first.sessionId!) as {
                                tag_number: number;
                            } | null;
                            return row?.tag_number ?? 0;
                        }),
                    { label: "tool tag persisted" },
                );
                queueDrop(h, first.sessionId!, toolTag);

                await h.sendPrompt(
                    "record high usage for the next execute pass",
                    {
                        timeoutMs: 60_000,
                        continueSession: true,
                    },
                );
                await h.sendPrompt("materialize the queued tool drop", {
                    timeoutMs: 60_000,
                    continueSession: true,
                });

                const body = JSON.stringify(h.mock.lastRequest()!.body);
                expect(body).toContain(callId);
                // The tool call is within the newest-20 skeleton window, so the
                // drop materializes as a skeleton: tool_use survives with its
                // input replaced and the paired result set to the one canonical
                // `[dropped §N§]` placeholder — pairing stays intact instead of
                // the pair being fully removed. (`__magic_context_replacement__`
                // is the arg-replacement marker, distinct from the output text.)
                expect(body).toContain("__magic_context_replacement__");
                expect(body).toContain(`dropped \u00a7${toolTag}\u00a7`);
                expect(body).not.toContain("__magic_context_dropped__");

                const occurrences = body.split(callId).length - 1;
                expect(occurrences).toBeGreaterThanOrEqual(2);
            },
        );
    }, 180_000);

    it("keeps Pi system prompt bytes stable across unchanged defer turns", async () => {
        await withPiHarness(
            {
                magicContextConfig: {
                    execute_threshold_percentage: 90,
                    dreamer: {},
                },
            },
            async (h) => {
                writeFileSync(
                    join(h.env.workdir, "ARCHITECTURE.md"),
                    "Pi cache-stability architecture note that should render consistently.",
                );
                h.mock.setDefault({
                    text: "ok",
                    usage: {
                        input_tokens: 100,
                        output_tokens: 10,
                        cache_creation_input_tokens: 100,
                    },
                });

                const first = await h.sendPrompt(
                    "system prompt stable turn 1",
                    { timeoutMs: 60_000 },
                );
                expect(first.sessionId).toBeTruthy();
                for (let i = 2; i <= 4; i++) {
                    await h.sendPrompt(`system prompt stable turn ${i}`, {
                        timeoutMs: 60_000,
                        continueSession: true,
                    });
                }

                const requests = mainRequests(h);
                const systems = requests.map((request) =>
                    serialize(request.body.system),
                );
                expect(systems.length).toBeGreaterThanOrEqual(4);
                // System field stays byte-identical across defer turns 2..N.
                expect(new Set(systems.slice(1)).size).toBe(1);
                // v2: <project-docs> moved from system → m[0]/m[1] messages.
                const lastWire = wireText(requests.at(-1)!);
                expect(lastWire).toContain("<project-docs>");
                expect(lastWire).toContain(
                    "Pi cache-stability architecture note",
                );
            },
        );
    }, 180_000);

    it("keeps prior Pi message prefix bytes stable across defer turns", async () => {
        await withPiHarness(
            {
                magicContextConfig: { execute_threshold_percentage: 90 },
            },
            async (h) => {
                h.mock.setDefault({
                    text: "ok",
                    usage: {
                        input_tokens: 100,
                        output_tokens: 10,
                        cache_creation_input_tokens: 100,
                    },
                });
                const first = await h.sendPrompt("prefix stable turn 1", {
                    timeoutMs: 60_000,
                });
                expect(first.sessionId).toBeTruthy();
                for (let i = 2; i <= 5; i++) {
                    await h.sendPrompt(`prefix stable turn ${i}`, {
                        timeoutMs: 60_000,
                        continueSession: true,
                    });
                }

                const requests = mainRequests(h);
                expect(requests.length).toBeGreaterThanOrEqual(5);
                for (let i = 1; i < requests.length - 1; i++) {
                    const earlier = requestMessages(requests[i]!);
                    const later = requestMessages(requests[i + 1]!);
                    expect(earlier.length).toBeLessThanOrEqual(later.length);
                    // The newest user/assistant tail can legitimately gain fresh §N§ tags
                    // on the next Pi subprocess. The older prefix is the cache-sensitive
                    // part and should be byte-identical across defer passes.
                    const stablePrefixLength = Math.max(0, earlier.length - 2);
                    for (let j = 0; j < stablePrefixLength; j++) {
                        expect(serialize(later[j])).toBe(serialize(earlier[j]));
                    }
                }
            },
        );
    }, 180_000);

    it("resumes the tag counter from DB max across Pi --print restarts", async () => {
        await withPiHarness({}, async (h) => {
            h.mock.script([
                {
                    content: Array.from({ length: 49 }, (_, index) => ({
                        type: "text",
                        text: `assistant block ${index + 1} for tag counter restart coverage`,
                    })),
                    usage: {
                        input_tokens: 120,
                        output_tokens: 60,
                        cache_creation_input_tokens: 120,
                    },
                },
                {
                    text: "second response after many assistant blocks",
                    usage: {
                        input_tokens: 120,
                        output_tokens: 10,
                        cache_creation_input_tokens: 120,
                    },
                },
                {
                    text: "third response after restart",
                    usage: {
                        input_tokens: 120,
                        output_tokens: 10,
                        cache_creation_input_tokens: 120,
                    },
                },
            ]);

            const first = await h.sendPrompt(
                "bootstrap tag counter restart coverage",
                {
                    timeoutMs: 60_000,
                },
            );
            expect(first.sessionId).toBeTruthy();

            await h.sendPrompt(
                "second turn tags all prior assistant text blocks",
                {
                    timeoutMs: 60_000,
                    continueSession: true,
                },
            );
            const beforeRestart = maxTagNumber(h, first.sessionId!);
            expect(beforeRestart).toBeGreaterThanOrEqual(50);

            await h.sendPrompt(
                "third turn must allocate after the persisted max",
                {
                    timeoutMs: 60_000,
                    continueSession: true,
                },
            );
            const afterRestart = maxTagNumber(h, first.sessionId!);
            expect(afterRestart).toBeGreaterThan(beforeRestart);
            expect(afterRestart).not.toBe(1);
        });
    }, 180_000);

    // TODO: Verify that background publication during defer passes preserves history-injection cache parity.
    // TODO: Verify that background publication during defer passes preserves history-injection cache parity.
    it.skip("does not rebuild <session-history> after historian publishes during a defer pass", () => {});

    // TODO: Add a print-mode harness that waits for async historian completion after the parent turn.
    it.skip("fires historian on commit cluster trigger and publishes harness='pi' compartments", () => {});

    // TODO: Verify fallback-model retries after the print-mode historian child drains.
    it.skip("publishes historian output through fallback_models after primary 503", () => {});

    // TODO: Test that ctx_memory writes refresh the system prompt only after /ctx-flush across Pi --print user turns.
    it.skip("refreshes system-prompt memory adjuncts only after explicit /ctx-flush", () => {});

    // TODO: Test sticky reminder anchor persistence through session_meta across restarts.
    // TODO: Add a harness scenario for multi-turn sticky-reminder anchor recovery across restart.
    it.skip("keeps sticky reminder anchored at the same message across defer passes and restart", () => {});

    // TODO: Add an e2e harness hook that triggers Pi's native compact event in print mode.
    it.skip("cancels native Pi compaction and lets Magic Context own compaction", () => {});

    // TODO: Verify historian publication writes a Pi compaction marker and resumes after it.
    it.skip("writes a Pi compaction marker at the historian boundary and resumes after it", () => {});

    // TODO: Add a print-mode harness that waits for the child Pi process and inspects its session rows during /ctx-aug subagent runs.
    it.skip("marks Pi subagents isolated and skips historian/project-docs/user-profile/key-files", () => {});

    // TODO: Add a print-mode subagent command harness to verify cross-session memory visibility through ctx_search.
    it.skip("allows Pi subagents to search parent-written project memory", () => {});

    // TODO: Add a print-mode scenario that kills the historian mid-publication and verifies stale-state cleanup after restart.
    it.skip("clears stale compartment_in_progress after Pi restart", () => {});
});
