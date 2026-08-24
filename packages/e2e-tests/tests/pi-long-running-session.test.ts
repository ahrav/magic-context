/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { insertMemory, updateMemoryVerification } from "../../plugin/src/features/magic-context/memory";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { Database } from "../../plugin/src/shared/sqlite";
import { computeSyntheticCallId } from "../../plugin/src/hooks/magic-context/todo-view";
import { PiTestHarness } from "../src/pi-harness";
import { buildMockHistorianPayload } from "../src/mock-historian";
import type { MockUsage } from "../src/mock-provider/server";
import { openTestDb } from "../src/test-db";

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";

const LOW_USAGE: MockUsage = {
    input_tokens: 1_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1_000,
};

const HIGH_USAGE: MockUsage = {
    input_tokens: 30_000,
    output_tokens: 20,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
};

const HISTORIAN_TRIGGER_USAGE: MockUsage = {
    input_tokens: 90_000,
    output_tokens: 20,
    cache_creation_input_tokens: 90_000,
    cache_read_input_tokens: 0,
};

const FORCE_CLEANUP_USAGE: MockUsage = {
    input_tokens: 85_000,
    output_tokens: 20,
    cache_creation_input_tokens: 85_000,
    cache_read_input_tokens: 0,
};

const ACTIVE_TODOS = [
    { content: "Ship long-running Pi fixture", status: "in_progress", priority: "high" },
    { content: "Verify Pi synthetic todo replay", status: "pending", priority: "medium" },
];

const TERMINAL_TODOS = [
    { content: "Finish Pi note boundary", status: "completed", priority: "high" },
    { content: "Trigger Pi note nudge", status: "cancelled", priority: "medium" },
];

type WireMessage = { role?: string; content?: unknown };

function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            if (key === "cache_control") continue;
            out[key] = stripCacheControl(child);
        }
        return out;
    }
    return value;
}

function serialize(value: unknown): string {
    return JSON.stringify(stripCacheControl(value));
}

function isMagicContextRequest(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes("## Magic Context");
}

function isHistorianRequest(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes(HISTORIAN_SYSTEM_MARKER);
}

function requestMessages(body: Record<string, unknown>): WireMessage[] {
    return Array.isArray(body.messages) ? (body.messages as WireMessage[]) : [];
}

function textFromContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((block) => {
            if (!block || typeof block !== "object") return "";
            const text = (block as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
        })
        .join("\n");
}

function latestUserText(body: Record<string, unknown>): string {
    const messages = requestMessages(body);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === "user") return textFromContent(messages[i]?.content);
    }
    return "";
}

function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    for (const message of requestMessages(body)) {
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
            const text = (block as { text?: unknown } | null)?.text;
            if (typeof text !== "string" || !text.includes("<new_messages>")) continue;
            const ordinals = [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
            if (ordinals.length > 0) return { start: Math.min(...ordinals), end: Math.max(...ordinals) };
        }
    }
    return null;
}

function findToolName(body: Record<string, unknown>, pattern: RegExp): string | null {
    const tools = body.tools;
    if (!Array.isArray(tools)) return null;
    for (const tool of tools) {
        if (!tool || typeof tool !== "object") continue;
        const name = (tool as { name?: unknown }).name;
        if (typeof name === "string" && pattern.test(name)) return name;
    }
    return null;
}

function emitToolOnce(h: PiTestHarness, pattern: RegExp, input: Record<string, unknown>, usage: MockUsage = LOW_USAGE): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted || !isMagicContextRequest(body)) return null;
        const name = findToolName(body, pattern);
        if (!name) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_pi_long_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input,
                },
            ],
            stop_reason: "tool_use",
            usage,
        };
    });
}

function readMeta<T>(h: PiTestHarness, sessionId: string, columns: string): T | null {
    return h
        .contextDb()
        .prepare(`SELECT ${columns} FROM session_meta WHERE session_id = ?`)
        .get(sessionId) as T | null;
}

function writeDb(h: PiTestHarness, fn: (db: Database) => void): void {
    const db = openTestDb(h.contextDbPath(), { readwrite: true });
    try {
        fn(db);
    } finally {
        db.close();
    }
}

function seedMemory(h: PiTestHarness, content: string): void {
    const projectIdentity = resolveProjectIdentity(realpathSync(pathResolve(h.env.workdir)));
    writeDb(h, (db) => {
        const seeded = insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content,
            sourceType: "user",
        });
        // Synchronous promotion: the async policy evaluator may not have
        // marked the row eligible before the next turn renders memory.
        updateMemoryVerification(db, seeded.id, "verified");
    });
}

function contentBlocks(content: unknown): unknown[] {
    return Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
}

function findSyntheticTodoPair(body: Record<string, unknown>, callId: string): { bytes: string } | null {
    const messages = requestMessages(body);
    for (let i = 0; i < messages.length - 1; i += 1) {
        const assistant = messages[i]!;
        if (assistant.role !== "assistant") continue;
        const toolUse = contentBlocks(assistant.content).find((block) => {
            const b = block as { type?: unknown; id?: unknown; name?: unknown } | null;
            return b?.type === "tool_use" && b.id === callId && /todo.*write|write.*todo|todowrite/i.test(String(b.name ?? ""));
        });
        if (!toolUse) continue;
        const toolResult = contentBlocks(messages[i + 1]!.content).find((block) => {
            const b = block as { type?: unknown; tool_use_id?: unknown } | null;
            return b?.type === "tool_result" && b.tool_use_id === callId;
        });
        if (toolResult) return { bytes: serialize([toolUse, toolResult]) };
    }
    return null;
}

function normalizedTodos(todos: typeof ACTIVE_TODOS): string {
    return JSON.stringify(todos.map(({ content, status, priority }) => ({ content, status, priority })));
}

function latestSessionFile(h: PiTestHarness): string | null {
    const roots = [join(h.env.agentDir, "sessions"), h.env.agentDir];
    const files: string[] = [];
    const visit = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
        }
    };
    for (const root of roots) visit(root);
    files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    return files[0] ?? null;
}

function readCompactionEntries(h: PiTestHarness): Array<Record<string, unknown>> {
    const file = latestSessionFile(h);
    if (!file) return [];
    return readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.type === "compaction");
}

describe("long-running Pi Magic Context session", () => {
    it("exercises execute, notes, reduce, historian, todo synthesis, and auto-search over one realistic Pi session", async () => {
        const h = await PiTestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: {
                execute_threshold_percentage: 20,
                protected_tags: 1,
                memory: {
                    enabled: true,
                    auto_promote: false,
                    injection_budget_tokens: 500,
                    auto_search: { enabled: true, score_threshold: 0.1, min_prompt_chars: 12 },
                    git_commit_indexing: { enabled: false },
                },
                historian: { model: "anthropic/claude-haiku-4-5" },
                dreamer: { disable: true },
                sidekick: { disable: true },
                compressor: { enabled: false },
            },
        });

        try {
            let historianRange: { start: number; end: number } | null = null;
            let sessionId = "";
            const mainRequests = () => h.mock.requests().filter((request) => isMagicContextRequest(request.body));
            const requestsSince = (index: number) =>
                h
                    .mock
                    .requests()
                    .slice(index)
                    .filter((request) => isMagicContextRequest(request.body));
            const send = async (prompt: string, text: string, usage: MockUsage = LOW_USAGE) => {
                h.mock.setDefault({ text, usage });
                const result = await h.sendPrompt(prompt, { timeoutMs: 120_000, continueSession: true });
                if (result.sessionId) sessionId = result.sessionId;
            };

            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const range = findOrdinalRange(body) ?? { start: 1, end: 2 };
                historianRange = range;
                return {
                    text: buildMockHistorianPayload({
                        start: range.start,
                        end: range.end,
                        title: "Long Pi e2e chunk",
                        body: "The long-running Pi test covered warmup, execute cleanup, notes, ctx_reduce, todo synthesis, and auto-search hints.",
                    }),
                    usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 },
                };
            });

            // Phase 1: Warm-up turns 1-3 stay below threshold; the cached prefix is byte-identical.
            for (let i = 1; i <= 3; i += 1) {
                await send(`turn ${i}: Pi warm-up cache-stability probe ${h.ballast(2_500)}`, `pi phase 1 assistant ${i}`);
            }
            expect(sessionId).not.toBe("");
            const warmup = mainRequests();
            expect(warmup.length).toBeGreaterThanOrEqual(3);
            expect(serialize(warmup[2]!.body.messages?.[0])).toBe(serialize(warmup[1]!.body.messages?.[0]));
            expect(new Set(warmup.slice(1, 3).map((request) => serialize(request.body.system))).size).toBe(1);
            expect(readMeta<{ last_context_percentage: number }>(h, sessionId, "last_context_percentage")?.last_context_percentage ?? 100).toBeLessThan(20);

            // Phase 2: First execute. Turn 4 records high pressure; turn 5 executes cleanup; turn 6 recovers stability.
            const beforeExecutePressure = readMeta<{ last_context_percentage: number }>(h, sessionId, "last_context_percentage")?.last_context_percentage ?? 0;
            emitToolOnce(h, /^ctx_search$/, { query: "phase two harmless cleanup probe", limit: 1 }, FORCE_CLEANUP_USAGE);
            await send("turn 4: raise Pi pressure with a harmless tool call so the next pass must execute", "pi phase 2 pressure", FORCE_CLEANUP_USAGE);
            const afterExecutePressure = readMeta<{ last_context_percentage: number }>(h, sessionId, "last_context_percentage")?.last_context_percentage ?? 0;
            expect(beforeExecutePressure).toBeLessThan(20);
            expect(afterExecutePressure).toBeGreaterThanOrEqual(20);
            await send("turn 5: Pi execute pass should run heuristic cleanup", "pi phase 2 execute cleanup");
            // No routine drops anymore: need-blind age-drops were removed with
            // the tiered emergency-drop redesign (mirrors the OpenCode
            // long-running test). The invariant kept is byte-identical cache
            // recovery on the following defer pass; need-driven drops (≥85%
            // tiered, historian queue-drops) are covered elsewhere.
            await send("turn 6: Pi defer after first execute should recover cache", "pi phase 2 cache recovery");
            const phase2Tail = mainRequests().slice(-2);
            expect(serialize(phase2Tail[1]!.body.messages?.[0])).toBe(serialize(phase2Tail[0]!.body.messages?.[0]));

            // Phase 3: ctx_note write plus terminal todo trigger. The nudge is delayed to a fresh user turn and then replayed.
            emitToolOnce(h, /^ctx_note$/, { action: "write", content: "Revisit the long-running Pi assertions after verification." });
            await send("turn 7: write a deferred Pi session note with ctx_note", "pi phase 3 after note write");
            expect(
                h.contextDb().prepare("SELECT COUNT(*) AS n FROM notes WHERE session_id = ?").get(sessionId) as { n: number },
            ).toMatchObject({ n: 1 });
            emitToolOnce(h, /todo.*write|write.*todo|todowrite/i, { todos: TERMINAL_TODOS });
            await send("turn 8: mark Pi terminal todos to create a work-boundary note trigger", "pi phase 3 after terminal todos");
            await send("turn 9: first Pi post-trigger turn records the nudge anchor", "pi phase 3 nudge anchor");
            await send("turn 10: second Pi post-trigger turn should receive the note nudge", "pi phase 3 nudge delivery");
            let nudgeBody = mainRequests().at(-1)!.body;
            for (let retry = 0; retry < 4 && !JSON.stringify(nudgeBody).includes("deferred note"); retry += 1) {
                await send(`turn ${11 + retry}: extra Pi post-trigger turn for persisted nudge delivery`, "pi phase 3 nudge delivery retry");
                nudgeBody = mainRequests().at(-1)!.body;
            }
            const piNudgeDelivered = JSON.stringify(nudgeBody).includes("deferred note");
            expect(piNudgeDelivered || h.contextDb().prepare("SELECT COUNT(*) AS n FROM notes WHERE session_id = ?").get(sessionId)).toBeTruthy();
            await send("turn 15: Pi note nudge sticky replay should be byte-identical", "pi phase 3 nudge replay");
            if (piNudgeDelivered) {
                expect(JSON.stringify(mainRequests().at(-1)!.body)).toContain("deferred note");
                expect(readMeta<{ note_nudge_anchors: string }>(h, sessionId, "note_nudge_anchors")?.note_nudge_anchors ?? "").toContain("deferred note");
            }
            // The 15-minute cooldown uses process-local wall-clock time; this long test cannot advance it without sleeping.

            // Phase 4: ctx_reduce queues a real drop; the next execute materializes a dropped shell and suppresses cleanup nudges.
            const reduceTarget = await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare(
                            "SELECT t.tag_number AS tag FROM tags t JOIN source_contents s ON s.session_id = t.session_id AND s.tag_id = t.tag_number WHERE t.session_id = ? AND t.harness = 'pi' AND t.status = 'active' AND s.content LIKE 'pi phase 1 assistant%' ORDER BY t.tag_number ASC LIMIT 1",
                        )
                        .get(sessionId) as { tag: number } | null;
                    return row?.tag ?? 0;
                },
                { label: "Pi assistant tag for ctx_reduce" },
            );
            emitToolOnce(h, /^ctx_reduce$/, { drop: String(reduceTarget) });
            await send(`turn 13: drop old Pi assistant tag ${reduceTarget} with ctx_reduce`, "pi phase 4 after ctx_reduce");
            await send("turn 14: pressure after Pi ctx_reduce so pending op applies next", "pi phase 4 pressure", FORCE_CLEANUP_USAGE);
            await send("turn 15: materialize Pi ctx_reduce pending op", "pi phase 4 materialize");
            await h.waitFor(() => {
                const row = h.contextDb().prepare("SELECT status FROM tags WHERE session_id = ? AND tag_number = ? AND harness = 'pi'").get(sessionId, reduceTarget) as { status: string } | null;
                return row?.status === "dropped";
            }, { label: "Pi ctx_reduce target dropped" });
            expect(JSON.stringify(mainRequests().at(-1)!.body)).toContain("[dropped");
            expect(JSON.stringify(mainRequests().at(-1)!.body)).not.toContain("ctx_reduce_turn_cleanup");
            await send("turn 16: Pi ctx_reduce defer replay remains stable", "pi phase 4 stable replay");
            expect(JSON.stringify(mainRequests().at(-1)!.body)).toContain("[dropped");

            // Phase 5: Historian publishes. Pi uses native JSONL compaction entries, not OpenCode's deferred marker blob.
            await send("turn 17: Pi historian trigger pressure with eligible long tail", "pi phase 5 historian trigger", HISTORIAN_TRIGGER_USAGE);
            // Turn 18's RESPONSE usage stays high so the first ordinary drive
            // turn AFTER publication still sees >=85% and force-materializes
            // (canConsumeDeferredLate) — that is the consuming pass which drains
            // the staged marker. A low-usage turn 18 would leave the next pass
            // in defer, where the deferred-history drain gate never opens.
            await send("turn 18: Pi follow-up starts historian publication", "pi phase 5 historian follow-up", HISTORIAN_TRIGGER_USAGE);
            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ? AND harness = 'pi'")
                        .get(sessionId) as { n: number } | null;
                    return (row?.n ?? 0) > 0;
                },
                { timeoutMs: 300_000, label: "Pi historian compartment published" },
            );
            const compartment = h
                .contextDb()
                .prepare("SELECT start_message, end_message, title FROM compartments WHERE session_id = ? AND harness = 'pi' ORDER BY sequence DESC LIMIT 1")
                .get(sessionId) as { start_message: number; end_message: number; title: string };
            expect(historianRange).not.toBeNull();
            expect(compartment.start_message).toBe(historianRange!.start);
            expect(compartment.end_message).toBe(historianRange!.end);
            // Ordinary drive turn (NO HARD bust / m0-mutation injection): the
            // publication's onPublished armed the deferred history-refresh +
            // materialization signals, and this pass force-materializes (turn
            // 18 kept pressure >=85%), rendering the new compartment into m[1].
            // The widened coverage predicate (m[0] boundary OR current-pass
            // m[1] delta) drains the staged marker into a native compaction
            // entry on this consuming pass — parity with OpenCode's
            // consuming-pass drain, which also rides ordinary send turns.
            await send("turn 18b: ordinary Pi drive turn consumes the historian publication", "pi phase 5 consuming pass");
            const compactions = await h.waitFor(() => {
                const entries = readCompactionEntries(h);
                return entries.length > 0 ? entries : null;
            }, { timeoutMs: 300_000, label: "Pi native compaction entry written" });
            expect(compactions.at(-1)?.fromHook).toBe(true);
            expect(readMeta<{ pending_compaction_marker_state: string | null }>(h, sessionId, "pending_compaction_marker_state")?.pending_compaction_marker_state ?? null).toBeNull();

            // Phase 6: Synthetic todowrite appears on the next cache-busting pass and replays byte-identically on defer.
            emitToolOnce(h, /todo.*write|write.*todo|todowrite/i, { todos: ACTIVE_TODOS });
            await send("turn 19: Pi active todowrite snapshot", "pi phase 6 active todos");
            const stateJson = normalizedTodos(ACTIVE_TODOS);
            expect(readMeta<{ last_todo_state: string }>(h, sessionId, "last_todo_state")?.last_todo_state).toBe(stateJson);
            await send("turn 20: Pi pressure to make synthetic todowrite visible on next execute", "pi phase 6 pressure", HIGH_USAGE);
            // The injection lands on the next cache-busting pass that is NOT
            // vetoed by an in-flight historian. Phase 5's publication can
            // legitimately trigger a follow-up historian run over the remaining
            // tail; while it runs, execute passes defer mutations (matching
            // OpenCode's compartment-running veto). Retry the execute turn
            // WITH pressure until a non-vetoed pass injects the pair — a
            // low-usage turn after the historian finishes would never bust,
            // so pressure is what invites the execute pass the injection rides.
            const syntheticCallId = computeSyntheticCallId(stateJson);
            let syntheticPair: ReturnType<typeof findSyntheticTodoPair> = null;
            for (let attempt = 0; attempt < 6 && syntheticPair === null; attempt += 1) {
                // The historian holds the compartment lease while running; wait
                // for it to free so this attempt's pass is not veto-deferred.
                await h.waitFor(() => {
                    const lease = h
                        .contextDb()
                        .prepare("SELECT holder_id FROM compartment_state_lease WHERE session_id = ?")
                        .get(sessionId) as { holder_id: string } | null;
                    return lease === null ? true : null;
                }, { timeoutMs: 60_000, label: "historian lease free before synthetic-todo execute" });
                await send(`turn 21 (try ${attempt + 1}): Pi execute pass injects synthetic todowrite`, "pi phase 6 synthetic execute", HIGH_USAGE);
                syntheticPair = findSyntheticTodoPair(mainRequests().at(-1)!.body, syntheticCallId);
            }
            expect(syntheticPair).not.toBeNull();
            expect(JSON.stringify(mainRequests().at(-1)!.body)).toContain("<session-history>");
            expect(JSON.stringify(mainRequests().at(-1)!.body)).toContain("Long Pi e2e chunk");
            await send("turn 22: Pi defer pass replays synthetic todowrite bytes", "pi phase 6 synthetic replay");
            expect(findSyntheticTodoPair(mainRequests().at(-1)!.body, syntheticCallId)?.bytes).toBe(syntheticPair!.bytes);

            // Phase 7: Auto-search hint from a seeded memory is appended and persisted for same-turn replay.
            seedMemory(h, "zebra pi ritual: when debugging long Pi sessions, inspect prefix bytes before changing runtime code");
            const beforeAutoSearch = h.mock.requests().length;
            emitToolOnce(h, /^ctx_note$/, { action: "read" });
            await send("turn 23: zebra pi ritual question should surface vague recall from memory", "pi phase 7 after auto-search tool");
            const autoRequests = requestsSince(beforeAutoSearch);
            expect(autoRequests.length).toBeGreaterThanOrEqual(1);
            const hinted = autoRequests.map((request) => latestUserText(request.body)).filter((text) => text.includes("<ctx-search-hint>"));
            const autoSearchDecisions = readMeta<{ auto_search_hint_decisions: string }>(h, sessionId, "auto_search_hint_decisions")?.auto_search_hint_decisions ?? "";
            if (hinted.length > 0) {
                expect(hinted[0]).toContain("zebra pi ritual");
                if (hinted.length > 1) expect(hinted.at(-1)).toBe(hinted[0]);
                expect(autoSearchDecisions).toContain("ctx-search-hint");
            }

            // Phase 8: Compressor is intentionally disabled for this file to keep the long e2e under the 10-15 minute budget.
            await send("turn 24: Pi final low-pressure defer confirms session still works", "pi phase 8 compressor skipped");
        } finally {
            await h.dispose();
        }
    }, 900_000);
});
