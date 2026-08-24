/// <reference types="bun-types" />

/**
 * Cache-invariant suite — the durable guard against prompt-cache regressions.
 *
 * Motivation: a stale-ctx_reduce strip regression shipped because the existing
 * cache-stability test only drove LOW-PRESSURE PURE-DEFER turns. The bug needed
 * three things that test never combined: conversation GROWTH + an EXECUTE pass
 * (to freeze drop state) + a SUBSEQUENT DEFER pass (where a volatile boundary
 * re-stripped a mid-prefix message). The wire byte-diff caught it in production;
 * nothing in CI did.
 *
 * This suite drives the plugin into those exact states and asserts — using the
 * SAME bust definition the production diagnostic (analyze-cache-busts.ts) uses,
 * ported to `src/cache-analysis.ts` — that DEFER passes never bust the cached
 * prefix. A "bust" = a wire segment BEFORE the final cache_control breakpoint
 * changed between two consecutive requests (i.e. the plugin rewrote bytes that
 * were supposed to stay cached).
 *
 * Invariant classes covered here (the replay class — the regression's family):
 *   A1  low-pressure pure-defer growth stays byte-stable
 *   A2  defer passes AFTER an execute pass + growth stay byte-stable
 *   A3  an aged ctx_reduce call never vanishes mid-prefix on a defer pass
 *       (the exact regression shape)
 *
 * The m[0]/m[1] taxonomy, supersede-delta, boundary, pressure, and restart
 * classes are layered on in sibling describe blocks as the suite grows.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { insertMemory, updateMemoryContent, updateMemoryVerification } from "../../plugin/src/features/magic-context/memory";
import { computeNormalizedHash } from "../../plugin/src/features/magic-context/memory/normalize-hash";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import type { Memory } from "../../plugin/src/features/magic-context/memory/types";
import { Database } from "../../plugin/src/shared/sqlite";
import {
    extractM0,
    extractM1,
    findBusts,
    formatBustReport,
    mainAgentRequests,
} from "../src/cache-analysis";
import { TestHarness } from "../src/harness";
import type { MockUsage } from "../src/mock-provider/server";
import { openTestDb } from "../src/test-db";

const RUST_MODE = process.env.MC_E2E_MODE === "rust";
const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";

function wireValueText(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value);
}

function isHistorianRequest(body: Record<string, unknown>): boolean {
    if (JSON.stringify(body.messages ?? "").includes("<new_messages>")) return true;
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        return system.some(
            (b) =>
                b &&
                typeof b === "object" &&
                typeof (b as { text?: unknown }).text === "string" &&
                ((b as { text: string }).text).includes(HISTORIAN_SYSTEM_MARKER),
        );
    }
    return false;
}

/**
 * Parse the [N] ordinal range from a historian prompt's <new_messages> block.
 *
 * Ordinals are matched ONLY in the exact line-anchored form the historian
 * prompt emits — `[N] U:` / `[N] A:` at the start of a line. Matching any
 * bracketed digit in the prose would pick up stray `[0]`-shaped text (e.g. a
 * prompt that literally mentions `m[0]`), producing a 0-N compartment range
 * that fails the historian's "range maps to raw session lines 1-N" validation.
 * This bit a real test run — the `[N] U:` anchor is the robust contract.
 */
function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const messages = (body.messages as Array<{ content: unknown }> | undefined) ?? [];
    for (const m of messages) {
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const block of blocks) {
            const text = (block as { text?: string }).text;
            if (!text || !text.includes("<new_messages>")) continue;
            const start = text.indexOf("<new_messages>");
            const end = text.indexOf("</new_messages>");
            const scope = end > start ? text.slice(start, end) : text.slice(start);
            const nums = [...scope.matchAll(/^\[(\d+)\] [UA]:/gm)].map((mm) => Number(mm[1]));
            if (nums.length > 0) return { start: Math.min(...nums), end: Math.max(...nums) };
        }
    }
    return null;
}

/** Route historian requests to a valid single-compartment response covering the chunk. */
function installHistorianMatcher(h: TestHarness): void {
    h.mock.addMatcher((body) => {
        if (!isHistorianRequest(body)) return null;
        const range = findOrdinalRange(body);
        const usage = {
            input_tokens: 500,
            output_tokens: 200,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 0,
        };
        if (!range) {
            return {
                text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                usage,
            };
        }
        const payload = [
            "<output>",
            "<compartments>",
            `<compartment start="${range.start}" end="${range.end}" title="cache-invariant chunk" importance="50" episode_type="feature">`,
            "<p1>Driven by the cache-invariant harness: durable signal exercising historian publish and the m[0]/m[1] SOFT-delta taxonomy.</p1>",
            "<p2>Cache-invariant harness chunk exercising historian publish.</p2>",
            "<p3>cache-invariant harness chunk</p3>",
            "<p4/>",
            "</compartment>",
            "</compartments>",
            "<facts></facts>",
            "<events></events>",
            `<unprocessed_from>${range.end + 1}</unprocessed_from>`,
            "</output>",
        ].join("\n");
        return { text: payload, usage };
    });
}

const MODEL_LIMIT = 100_000;

// Below execute_threshold (20% of 100k = 20k) → defer pass.
const DEFER_USAGE: MockUsage = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};

// Above execute_threshold → the next pass is an execute pass.
const EXECUTE_USAGE: MockUsage = {
    input_tokens: 30_000,
    output_tokens: 20,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
};

// High enough to trip the historian trigger (threshold-relative pressure).
const HISTORIAN_TRIGGER_USAGE: MockUsage = {
    input_tokens: 90_000,
    output_tokens: 20,
    cache_creation_input_tokens: 90_000,
    cache_read_input_tokens: 0,
};

let h: TestHarness;

beforeEach(async () => {
    h = await TestHarness.create({
        modelContextLimit: MODEL_LIMIT,
        magicContextConfig: {
            execute_threshold_percentage: 20,
            protected_tags: 1,
            dreamer: { disable: true },
            sidekick: { disable: true },
            compressor: { enabled: false },
            memory: {
                enabled: true,
                auto_promote: false,
                auto_search: { enabled: false },
                git_commit_indexing: { enabled: false },
            },
        },
    });
});

afterEach(async () => {
    await h.dispose();
});

function setDefer(text: string): void {
    h.mock.setDefault({ text, usage: DEFER_USAGE });
}

/** Project identity the plugin resolves at runtime for the harness workdir. */
function projectIdentity(): string {
    return resolveProjectIdentity(realpathSync(pathResolve(h.opencode.env.workdir)));
}

function writeContextDb<T>(fn: (db: Database) => T): T {
    const dbPath = join(h.opencode.env.dataDir, "cortexkit", "magic-context", "context.db");
    const db = openTestDb(dbPath, { readwrite: true });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

function seedMemory(content: string, category: Memory["category"] = "PROJECT_RULES"): number {
    return writeContextDb((db) => {
        const id = insertMemory(db, {
            projectPath: projectIdentity(),
            category,
            content,
            // v86 trust policy: explicit-user origin rows are auto-eligible,
            // but the effective policy is computed by an ASYNC evaluator; a
            // synchronous verification promotion makes eligibility
            // deterministic before the next turn materializes m[0].
            sourceType: "user",
        }).id;
        updateMemoryVerification(db, id, "verified");
        return id;
    });
}

function projectEpoch(): number {
    return writeContextDb(
        (db) =>
            (
                db
                    .prepare(
                        "SELECT project_memory_epoch AS epoch FROM project_state WHERE project_path = ?",
                    )
                    .get(projectIdentity()) as { epoch: number } | null
            )?.epoch ?? 0,
    );
}

/** Pin the project epoch to a captured value. Eligible writes and
 * verification promotions bump the epoch, which HARD-refolds m[0]; the
 * m[1] delta lanes under test only fire when memory ids advance WITHOUT an
 * epoch change, so tests pin the epoch back after seeding. */
function setProjectEpoch(epoch: number): void {
    writeContextDb((db) => {
        db.prepare(
            `INSERT INTO project_state (project_path, project_memory_epoch)
             VALUES (?, ?)
             ON CONFLICT(project_path) DO UPDATE SET project_memory_epoch = excluded.project_memory_epoch`,
        ).run(projectIdentity(), epoch);
    });
}

/**
 * Queue a non-additive memory mutation (the supersede-delta path). Mirrors the
 * production `queueMemoryMutation` columns exactly — this is what `ctx_memory`
 * update/archive/delete records instead of bumping the project epoch, so the
 * change reconciles via the m[1] <memory-updates> delta rather than a HARD m[0]
 * refold. For `update` we also flip the underlying row content so a later m[0]
 * re-materialize would reconcile to the new value.
 */
function queueMemoryUpdate(targetId: number, newContent: string): void {
    writeContextDb((db) => {
        db.prepare(
            `INSERT INTO memory_mutation_log
                (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
             VALUES (?, 'update', ?, NULL, NULL, ?, ?)`,
        ).run(projectIdentity(), targetId, newContent, Date.now());
        updateMemoryContent(db, targetId, newContent, computeNormalizedHash(newContent));
    });
}

/**
 * Bump the project memory epoch — the cross-process HARD-bust signal an external
 * (dashboard) memory mutation or a session upgrade fires. Unlike the in-session
 * supersede-delta path (B11), this MUST force a full m[0] re-materialization.
 */
function bumpProjectEpoch(): void {
    writeContextDb((db) => {
        db.prepare(
            `INSERT INTO project_state (project_path, project_memory_epoch)
             VALUES (?, 1)
             ON CONFLICT(project_path) DO UPDATE SET project_memory_epoch = project_memory_epoch + 1`,
        ).run(projectIdentity());
    });
}

/** Emit a single ctx_reduce tool call on the first main-agent request that exposes it. */
function emitCtxReduceOnce(drop: string): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted) return null;
        const sys = JSON.stringify(body.system ?? "");
        if (!sys.includes("## Magic Context")) return null;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const name = tools
            .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
            .find((n) => typeof n === "string" && /ctx_reduce/.test(n)) as string | undefined;
        if (!name) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_ci_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input: { drop },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: DEFER_USAGE,
        };
    });
}

function emitMemoryToolOnce(input: Record<string, unknown>): () => boolean {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted || !JSON.stringify(body.system ?? "").includes("## Magic Context")) return null;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const name = tools
            .map((tool) =>
                tool && typeof tool === "object" ? (tool as { name?: unknown }).name : null,
            )
            .find((value) => value === "ctx_memory");
        if (typeof name !== "string") return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_memory_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input,
                },
            ],
            stop_reason: "tool_use" as const,
            usage: DEFER_USAGE,
        };
    });
    return () => emitted;
}

async function runMemoryTool(
    sessionId: string,
    input: Record<string, unknown>,
    prompt: string,
): Promise<void> {
    h.mock.reset();
    const wasEmitted = emitMemoryToolOnce(input);
    setDefer("memory tool follow-up");
    await h.sendPrompt(sessionId, prompt);
    expect(wasEmitted()).toBe(true);
}

function memoryIdContaining(body: Record<string, unknown>, content: string): number {
    const m0 = extractM0(body) ?? "";
    const escaped = content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = m0.match(new RegExp(`#(\\d+)(?: \\[[^\n]+\\])?: ${escaped}`));
    if (!match) throw new Error(`no rendered memory id found for ${JSON.stringify(content)}`);
    return Number(match[1]);
}

function thrownMessage(fn: () => unknown): string {
    try {
        fn();
        return "";
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

async function waitForRustCompartment(sessionId: string): Promise<void> {
    const stack = h.rustStack;
    if (!stack) throw new Error("Rust compartment wait requires the hermetic module stack");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const status = await stack.moduleStatus(sessionId, h.opencode.env.workdir, "session.status");
        if (Number(status.compartment_count ?? 0) > 0) return;
        await Bun.sleep(100);
    }
    throw new Error("waitForRustCompartment timed out after 60000ms");
}

function assertNoBusts(label: string): void {
    const requests = mainAgentRequests(h.mock.requests());
    const busts = findBusts(requests);
    if (busts.length > 0) {
        // Surface the exact wire divergence so a CI failure is actionable.
        console.error(`[cache-invariant:${label}] ${busts.length} bust(s):\n${formatBustReport(busts)}`);
    }
    expect({ label, busts: busts.length }).toEqual({ label, busts: 0 });
}

describe("cache invariants — replay class", () => {
    describe("#given a low-pressure conversation (A1)", () => {
        describe("#when several pure-defer turns grow the tail", () => {
            it("#then the cached prefix never busts across defer passes", async () => {
                //#given / #when
                const sessionId = await h.createSession();
                for (let i = 1; i <= 6; i++) {
                    setDefer(`A1 reply ${i}`);
                    await h.sendPrompt(sessionId, `A1 turn ${i}: low-pressure cache-stability probe.`);
                }

                //#then
                const requests = mainAgentRequests(h.mock.requests());
                expect(requests.length).toBeGreaterThanOrEqual(6);
                assertNoBusts("A1-low-pressure-defer");
            }, 120_000);
        });
    });

    describe("#given a conversation that crossed an execute pass (A2)", () => {
        describe("#when defer passes follow the execute pass with continued growth", () => {
            it("#then defer passes after the execute settle to a stable prefix", async () => {
                //#given — warm up, then a high-usage turn so the NEXT pass executes
                const sessionId = await h.createSession();
                setDefer("A2 warmup 1");
                await h.sendPrompt(sessionId, "A2 turn 1: warmup.");
                setDefer("A2 warmup 2");
                await h.sendPrompt(sessionId, "A2 turn 2: warmup.");

                // High usage marks the next transform as an execute pass.
                h.mock.setDefault({ text: "A2 high usage", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "A2 turn 3: high usage triggers an execute pass.");

                // Now several defer turns. The execute pass may legitimately bust
                // once (drops/markers materialize); the invariant is that the
                // DEFER passes that follow it are byte-stable.
                const firstDeferIndex = h.mock.requests().length;
                for (let i = 4; i <= 8; i++) {
                    setDefer(`A2 defer reply ${i}`);
                    await h.sendPrompt(sessionId, `A2 turn ${i}: defer growth after execute.`);
                }

                //#then — analyze only the post-execute defer window
                const deferRequests = mainAgentRequests(h.mock.requests().slice(firstDeferIndex));
                expect(deferRequests.length).toBeGreaterThanOrEqual(4);
                const busts = findBusts(deferRequests);
                if (busts.length > 0) {
                    console.error(
                        `[cache-invariant:A2-post-execute-defer] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                    );
                }
                expect(busts.length).toBe(0);
            }, 150_000);
        });
    });

    describe("#given an aged ctx_reduce call in the conversation (A3 — the regression)", () => {
        describe("#when pure-defer turns grow the tail past the protected window", () => {
            it("#then the ctx_reduce message never vanishes mid-prefix and the prefix never busts", async () => {
                //#given — a normal turn, then a turn that emits a real ctx_reduce
                // tool call, then enough defer growth to push it well past
                // protected_tags (1).
                const sessionId = await h.createSession();
                setDefer("A3 reply 1");
                await h.sendPrompt(sessionId, "A3 turn 1: establish baseline content.");

                emitCtxReduceOnce("99999");
                setDefer("A3 reply 2 (after ctx_reduce tool call)");
                await h.sendPrompt(sessionId, "A3 turn 2: this turn issues a ctx_reduce call.");

                // Capture the wire signature of the ctx_reduce call once it's on
                // the wire, then grow the conversation with pure-defer turns.
                let sawReduceOnWire = false;
                for (let i = 3; i <= 8; i++) {
                    setDefer(`A3 defer reply ${i}`);
                    await h.sendPrompt(sessionId, `A3 turn ${i}: defer growth ages the ctx_reduce call.`);
                    const body = JSON.stringify(h.mock.lastRequest()?.body ?? {});
                    if (body.includes("ctx_reduce")) sawReduceOnWire = true;
                }

                //#then — across the whole post-ctx_reduce window, zero busts.
                // Pre-fix, one of these defer passes would strip the aged
                // ctx_reduce call mid-prefix (vanish + shift) → a bust here.
                expect(sawReduceOnWire).toBe(true);
                assertNoBusts("A3-ctx_reduce-defer-growth");

                // And the ctx_reduce call must still be present on the final wire
                // (never silently removed on a defer pass).
                const finalBody = JSON.stringify(mainAgentRequests(h.mock.requests()).at(-1)?.body ?? {});
                expect(finalBody).toContain("ctx_reduce");
            }, 150_000);
        });
    });
});

describe("cache invariants — m[0]/m[1] taxonomy (B class)", () => {
    describe("#given a compartment published after m[0] materialized empty (B9 — the seq-refold regression)", () => {
        describe("#when publication surfaces and defer passes follow", () => {
            it(
                RUST_MODE
                    ? "#then the one-time renderer transition folds into m[0], then defer replay freezes"
                    : "#then m[0] stays empty/frozen (SOFT) — the compartment rides m[1], never folds into m[0]",
                async () => {
                    //#given — TypeScript materializes an empty m[0] before the
                    // compartment exists. Rust follows the same setup but may consume
                    // a renderer transition when the first compartment appears.
                    installHistorianMatcher(h);
                    const sessionId = await h.createSession();

                    // Force an early execute pass so m[0] materializes EMPTY
                    // (0 compartments yet). A high-usage turn marks the next pass as
                    // execute; the pass after it does the empty materialization.
                    setDefer("B9 warm 1");
                    await h.sendPrompt(sessionId, "B9 turn 1: warmup.");
                    h.mock.setDefault({
                        text: "B9 high",
                        usage: RUST_MODE
                            ? { input_tokens: 19_000, output_tokens: 20, cache_creation_input_tokens: 19_000, cache_read_input_tokens: 0 }
                            : EXECUTE_USAGE,
                    });
                    await h.sendPrompt(sessionId, "B9 turn 2: high usage marks the next pass execute.");
                    setDefer("B9 materialize-empty");
                    await h.sendPrompt(sessionId, "B9 turn 3: execute pass materializes empty m[0].");

                    const m0BaselineEmpty = wireValueText(
                        extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body),
                    );
                    expect(m0BaselineEmpty).toContain("<session-history></session-history>");

                    // Build an eligible tail, then trigger and run the historian.
                    for (let i = 4; i <= 11; i++) {
                        setDefer(`B9 reply ${i}`);
                        await h.sendPrompt(sessionId, `B9 turn ${i}: durable content for compartment chunk ${i}. ${h.ballast(3_000)}`);
                    }
                    h.mock.setDefault({ text: "B9 trigger", usage: HISTORIAN_TRIGGER_USAGE });
                    await h.sendPrompt(sessionId, "B9 turn 12: high-usage historian trigger.");
                    setDefer("B9 post-trigger");
                    await h.sendPrompt(sessionId, "B9 turn 13: follow-up starts + awaits the historian publish.");

                    if (RUST_MODE) {
                        // a5b7d61d moved Rust publication to the out-of-band Broca
                        // stack. The next real turn surfaces the committed module state
                        // on the provider wire instead of waiting for a synthetic request.
                        await waitForRustCompartment(sessionId);
                        setDefer("B9 surface published Rust compartment");
                        await h.sendPrompt(sessionId, "B9 turn 14: surface the published compartment.");
                    } else {
                        await h.waitFor(() => h.countCompartments(sessionId) >= 1, {
                            timeoutMs: 60_000,
                            label: "B9 compartment publishes to DB",
                        });
                    }

                    //#then — TypeScript keeps the additive publication in the m[1]
                    // delta lane. Rust first consumes the pending hard transition for
                    // this newly detected renderer shape, then replays that result.
                    const requests = mainAgentRequests(h.mock.requests());
                    const surfaceReq = RUST_MODE
                        ? requests.at(-1)
                        : requests.find((r) => wireValueText(extractM1(r.body)).includes("<new-compartments>"));
                    expect(surfaceReq).toBeDefined();
                    const m1 = wireValueText(extractM1(surfaceReq!.body));
                    const m0 = wireValueText(extractM0(surfaceReq!.body));
                    if (RUST_MODE) {
                        // 887696d9 gives each newly detected renderer shape one hard
                        // transition. cc842547 stores the consumed marker per shape, so
                        // this compartment cannot fold again or receive another replay identifier.
                        expect(m0).toContain("Hermetic Broca chunk");
                        expect(m0).not.toBe(m0BaselineEmpty!);
                        expect(m1).not.toContain("<new-compartments>");
                    } else {
                        expect(m1).toContain("<new-compartments>");
                        expect(m1).toContain("</new-compartments>");
                        expect(m0).toBe(m0BaselineEmpty!);
                    }

                    const surfaceIdx = requests.indexOf(surfaceReq!);
                    setDefer("B9 replay 1");
                    await h.sendPrompt(
                        sessionId,
                        RUST_MODE
                            ? "B9 turn 15: defer replay of the surfaced compartment."
                            : "B9 turn 14: defer replay of the surfaced compartment.",
                    );
                    setDefer("B9 replay 2");
                    await h.sendPrompt(
                        sessionId,
                        RUST_MODE ? "B9 turn 16: defer replay again." : "B9 turn 15: defer replay again.",
                    );

                    // From the surface request through every subsequent defer-only
                    // replay, both message lanes must remain byte-identical. The existing
                    // delta or transition result is reused rather than rendered again.
                    const after = mainAgentRequests(h.mock.requests()).slice(surfaceIdx);
                    const m1s = new Set(after.map((r) => wireValueText(extractM1(r.body))));
                    const m0s = new Set(after.map((r) => wireValueText(extractM0(r.body))));
                    expect(m1s.size).toBe(1);
                    expect(m0s.size).toBe(1);

                    // Whole-wire no-bust is asserted only over the trailing defer
                    // pair. The surface request may legitimately bust once.
                    const replayPair = mainAgentRequests(h.mock.requests()).slice(-2);
                    const busts = findBusts(replayPair);
                    if (busts.length > 0) {
                        console.error(
                            `[cache-invariant:B9-soft-publish] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                        );
                    }
                    expect(busts.length).toBe(0);
                },
                220_000,
            );
        });
    });

    describe("#given an additive memory write after m[0] materialized (B10 — maxMemoryId is not a HARD trigger)", () => {
        describe("#when a new memory is added and an execute pass surfaces it", () => {
            it("#then it rides m[1] <new-memories> and m[0] stays byte-identical (SOFT)", async () => {
                //#given — seed a baseline memory, then force m[0] to materialize
                // WITH that memory in the baseline (early execute pass). This
                // freezes cachedM0MaxMemoryId at the baseline's id.
                const sessionId = await h.createSession();
                if (RUST_MODE) {
                    const freshRule = "B10 fresh rule: always run the full gate before a release.";
                    await runMemoryTool(
                        sessionId,
                        { action: "write", category: "PROJECT_RULES", content: freshRule },
                        "B10 Rust writer: save the release rule.",
                    );

                    // PARITY.md assigns memory rows to module authority. Observe the
                    // committed write through a fresh session's provider wire; a direct
                    // TypeScript context.db insert is rejected instead of mutating m[1].
                    const readerSessionId = await h.createSession();
                    h.mock.reset();
                    setDefer("B10 Rust reader");
                    await h.sendPrompt(readerSessionId, "B10 Rust reader: load project memory.");
                    const readerM0 = extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body)!;
                    expect(readerM0).toContain(freshRule);
                    expect(thrownMessage(() => seedMemory("B10 forbidden TS-side write"))).toContain(
                        "managed by the Rust module",
                    );
                    return;
                }
                seedMemory("B10 baseline rule: prefer the project's own tools over shell fallbacks.");
                setDefer("B10 warm 1");
                await h.sendPrompt(sessionId, "B10 turn 1: warmup.");
                h.mock.setDefault({ text: "B10 high", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B10 turn 2: high usage marks next pass execute.");
                setDefer("B10 materialize");
                await h.sendPrompt(sessionId, "B10 turn 3: execute pass materializes m[0] with baseline memory.");

                const m0Baseline = extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body);
                expect(m0Baseline).toContain("B10 baseline rule");

                //#when — add a NEW memory after the baseline froze, then drive an
                // execute pass to surface it. The execute DECISION for a turn is
                // read from the PREVIOUS turn's recorded usage, so turn 4 records
                // high usage to make turn 5 the cache-busting (execute) pass.
                // maxMemoryId advances when the new memory is seeded, but it must
                // NOT re-materialize m[0] (not a HARD trigger); the new memory is
                // an m[1] delta via the readNewMemoriesForM1 watermark.
                h.mock.setDefault({ text: "B10 pressure", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B10 turn 4: high usage marks the next pass execute.");
                const epochBeforeAdditive = projectEpoch();
                seedMemory("B10 fresh rule: always run the full gate before a release.");
                setProjectEpoch(epochBeforeAdditive);
                setDefer("B10 surface");
                await h.sendPrompt(sessionId, "B10 turn 5: execute pass surfaces the new memory.");

                //#then
                const requests = mainAgentRequests(h.mock.requests());
                const surfaceReq = requests.find((r) => extractM1(r.body)?.includes("B10 fresh rule"));
                expect(surfaceReq).toBeDefined();
                const m1 = extractM1(surfaceReq!.body)!;
                const m0 = extractM0(surfaceReq!.body)!;
                // Delta invariant: the new memory rides m[1] <new-memories>.
                expect(m1).toContain("<new-memories>");
                expect(m1).toContain("B10 fresh rule");
                // SOFT invariant: m[0] still holds ONLY the baseline memory; the
                // new one was NOT folded into the m[0] baseline.
                expect(m0).toContain("B10 baseline rule");
                expect(m0).not.toContain("B10 fresh rule");
                expect(m0).toBe(m0Baseline!);

                // Trailing pure-defer replay pair must be byte-stable.
                setDefer("B10 replay 1");
                await h.sendPrompt(sessionId, "B10 turn 6: defer replay.");
                setDefer("B10 replay 2");
                await h.sendPrompt(sessionId, "B10 turn 7: defer replay again.");
                const replayPair = mainAgentRequests(h.mock.requests()).slice(-2);
                const busts = findBusts(replayPair);
                if (busts.length > 0) {
                    console.error(
                        `[cache-invariant:B10-additive-memory] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                    );
                }
                expect(busts.length).toBe(0);
            }, 220_000);
        });
    });

    describe("#given a non-additive memory mutation (B11 — supersede-delta)", () => {
        describe("#when a rendered memory is updated and an execute pass reconciles it", () => {
            it("#then a <memory-updates> delta rides m[1] and m[0] stays byte-identical (stale-but-frozen)", async () => {
                //#given — seed a memory and materialize m[0] WITH it in the
                // baseline (so it's a rendered memory the mutation can target).
                const sessionId = await h.createSession();
                if (RUST_MODE) {
                    const original = "B11 original rule: deploys go through the staging pipeline first.";
                    await runMemoryTool(
                        sessionId,
                        { action: "write", category: "PROJECT_RULES", content: original },
                        "B11 Rust writer: save the baseline rule.",
                    );

                    const mutationSessionId = await h.createSession();
                    h.mock.reset();
                    setDefer("B11 Rust baseline materialize");
                    await h.sendPrompt(mutationSessionId, "B11 Rust turn 1: load project memory.");
                    const baselineBody = mainAgentRequests(h.mock.requests()).at(-1)!.body;
                    expect(extractM0(baselineBody)).toContain(original);
                    const rustMemoryId = memoryIdContaining(baselineBody, original);

                    const revised =
                        "B11 revised rule: deploys go straight to production with a feature flag.";
                    await runMemoryTool(
                        mutationSessionId,
                        { action: "update", ids: [rustMemoryId], content: revised },
                        "B11 Rust turn 2: revise the deployment rule.",
                    );
                    const readerSessionId = await h.createSession();
                    h.mock.reset();
                    setDefer("B11 Rust reader");
                    await h.sendPrompt(readerSessionId, "B11 Rust reader: load revised project memory.");
                    const revisedM0 = extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body)!;
                    expect(revisedM0).toContain(revised);
                    expect(revisedM0).not.toContain(original);
                    expect(
                        thrownMessage(() => queueMemoryUpdate(rustMemoryId, "forbidden TS update")),
                    ).toContain("managed by the Rust module");
                    return;
                }
                const memId = seedMemory(
                    "B11 original rule: deploys go through the staging pipeline first.",
                );
                setDefer("B11 warm 1");
                await h.sendPrompt(sessionId, "B11 turn 1: warmup.");
                h.mock.setDefault({ text: "B11 high", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B11 turn 2: high usage marks next pass execute.");
                setDefer("B11 materialize");
                await h.sendPrompt(sessionId, "B11 turn 3: execute pass materializes m[0] with the memory.");

                const m0Baseline = extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body);
                expect(m0Baseline).toContain("B11 original rule");

                //#when — a non-additive mutation (update). This queues a
                // memory_mutation_log row WITHOUT bumping the project epoch, so
                // m[0] must NOT re-materialize: the stale baseline still shows the
                // ORIGINAL text, and m[1] carries a <memory-updates> correction.
                // Turn 4 records high usage so turn 5 is the cache-busting pass.
                h.mock.setDefault({ text: "B11 pressure", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B11 turn 4: high usage marks the next pass execute.");
                const epochBeforeUpdate = projectEpoch();
                queueMemoryUpdate(memId, "B11 revised rule: deploys go straight to production with a feature flag.");
                // A content rewrite withdraws verification (the successor revision
                // starts CANDIDATE); re-verify through the real API so the revised
                // row stays render-eligible, then pin the epoch so the mutation
                // rides the m[1] delta instead of HARD-refolding m[0].
                writeContextDb((db) => updateMemoryVerification(db, memId, "verified"));
                setProjectEpoch(epochBeforeUpdate);
                setDefer("B11 reconcile");
                await h.sendPrompt(sessionId, "B11 turn 5: execute pass renders the memory-updates delta.");

                //#then
                const requests = mainAgentRequests(h.mock.requests());
                const reconcileReq = requests.find((r) => extractM1(r.body)?.includes("<memory-updates>"));
                expect(reconcileReq).toBeDefined();
                const m1 = extractM1(reconcileReq!.body)!;
                const m0 = extractM0(reconcileReq!.body)!;
                // Delta invariant: m[1] carries the correction targeting this id.
                expect(m1).toContain("<memory-updates>");
                expect(m1).toContain(`<updated id="${memId}">`);
                expect(m1).toContain("B11 revised rule");
                // Stale-but-frozen invariant: m[0] is byte-identical and STILL
                // shows the original text (the mutation did NOT HARD-refold m[0]).
                expect(m0).toContain("B11 original rule");
                expect(m0).not.toContain("B11 revised rule");
                expect(m0).toBe(m0Baseline!);

                // Trailing pure-defer replay pair must be byte-stable.
                setDefer("B11 replay 1");
                await h.sendPrompt(sessionId, "B11 turn 6: defer replay.");
                setDefer("B11 replay 2");
                await h.sendPrompt(sessionId, "B11 turn 7: defer replay again.");
                const replayPair = mainAgentRequests(h.mock.requests()).slice(-2);
                const busts = findBusts(replayPair);
                if (busts.length > 0) {
                    console.error(
                        `[cache-invariant:B11-supersede-delta] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                    );
                }
                expect(busts.length).toBe(0);
            }, 220_000);
        });
    });

    describe("#given a genuine HARD trigger — project epoch bump (B12 — the fold direction)", () => {
        describe("#when a memory rode m[1], then the epoch bumps", () => {
            it("#then m[0] re-materializes folding the delta in, m[1] resets, and defer re-stabilizes", async () => {
                //#given — get a memory riding m[1] (the B10 setup): materialize an
                // empty m[0], then add a memory and surface it as an m[1] delta.
                const sessionId = await h.createSession();
                if (RUST_MODE) {
                    const deltaRule =
                        "B12 delta rule: keep the cache prefix byte-identical across defer passes.";
                    await runMemoryTool(
                        sessionId,
                        { action: "write", category: "PROJECT_RULES", content: deltaRule },
                        "B12 Rust writer: save a delta rule.",
                    );
                    const readerSessionId = await h.createSession();
                    h.mock.reset();
                    setDefer("B12 Rust reader");
                    await h.sendPrompt(readerSessionId, "B12 Rust reader: load project memory.");
                    const moduleOwnedM0 = extractM0(
                        mainAgentRequests(h.mock.requests()).at(-1)!.body,
                    )!;
                    expect(moduleOwnedM0).toContain(deltaRule);

                    // PARITY.md assigns the effective epoch to Rust authority. Mutating
                    // the TS mirror succeeds but is intentionally inert on provider bytes;
                    // the module unit gate pins the real epoch-bump HARD fold.
                    bumpProjectEpoch();
                    setDefer("B12 Rust inert TS epoch replay");
                    await h.sendPrompt(readerSessionId, "B12 Rust reader: replay after TS mirror bump.");
                    expect(extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body)).toBe(
                        moduleOwnedM0,
                    );
                    return;
                }
                setDefer("B12 warm 1");
                await h.sendPrompt(sessionId, "B12 turn 1: warmup.");
                h.mock.setDefault({ text: "B12 high", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B12 turn 2: high usage marks next pass execute.");
                setDefer("B12 materialize-empty");
                await h.sendPrompt(sessionId, "B12 turn 3: execute pass materializes empty m[0].");

                h.mock.setDefault({ text: "B12 pressure", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B12 turn 4: high usage marks next pass execute.");
                const epochBeforeSeed = projectEpoch();
                seedMemory("B12 delta rule: keep the cache prefix byte-identical across defer passes.");
                setProjectEpoch(epochBeforeSeed);
                setDefer("B12 surface");
                await h.sendPrompt(sessionId, "B12 turn 5: execute pass surfaces the memory into m[1].");

                let requests = mainAgentRequests(h.mock.requests());
                const surfaceReq = requests.find((r) => extractM1(r.body)?.includes("B12 delta rule"));
                expect(surfaceReq).toBeDefined();
                // Pre-bump: memory is in m[1], NOT in the empty m[0].
                expect(extractM0(surfaceReq!.body)).toContain("<session-history></session-history>");
                expect(extractM1(surfaceReq!.body)).toContain("B12 delta rule");

                //#when — a HARD trigger fires (epoch bump = external/dashboard
                // mutation). Turn 6 records high usage so turn 7 is cache-busting;
                // mustMaterialize must re-materialize m[0] on the epoch change.
                h.mock.setDefault({ text: "B12 hard-pressure", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B12 turn 6: high usage marks the next pass execute.");
                bumpProjectEpoch();
                setDefer("B12 refold");
                await h.sendPrompt(sessionId, "B12 turn 7: execute pass HARD-refolds m[0].");

                //#then — the memory has folded INTO the m[0] baseline, and m[1]
                // reset to the empty placeholder (delta reconciled away).
                requests = mainAgentRequests(h.mock.requests());
                const refoldReq = requests.find(
                    (r, i) =>
                        i > requests.indexOf(surfaceReq!) &&
                        (extractM0(r.body)?.includes("B12 delta rule") ?? false),
                );
                expect(refoldReq).toBeDefined();
                const m0 = extractM0(refoldReq!.body)!;
                const m1 = extractM1(refoldReq!.body)!;
                // Fold invariant: the memory is now in the m[0] baseline...
                expect(m0).toContain("B12 delta rule");
                // ...and m[1] reset to the empty placeholder (no <new-memories>).
                expect(m1).toContain("(no new content since last materialization)");
                expect(m1).not.toContain("B12 delta rule");

                // After the one-time HARD fold, defer passes re-stabilize: the new
                // m[0]+m[1] replay byte-identical across the trailing defer pair.
                const refoldIdx = requests.indexOf(refoldReq!);
                setDefer("B12 replay 1");
                await h.sendPrompt(sessionId, "B12 turn 8: defer replay after refold.");
                setDefer("B12 replay 2");
                await h.sendPrompt(sessionId, "B12 turn 9: defer replay again.");
                const after = mainAgentRequests(h.mock.requests()).slice(refoldIdx);
                expect(new Set(after.map((r) => extractM0(r.body))).size).toBe(1);
                const replayPair = mainAgentRequests(h.mock.requests()).slice(-2);
                const busts = findBusts(replayPair);
                if (busts.length > 0) {
                    console.error(
                        `[cache-invariant:B12-hard-refold] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                    );
                }
                expect(busts.length).toBe(0);
            }, 240_000);
        });
    });
});
