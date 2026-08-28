/// <reference types="bun-types" />

/**
 * Pi cache-invariant suite — the Pi-harness mirror of tests/cache-invariants.ts.
 *
 * Pi's m[0]/m[1] renderer (inject-compartments-pi.ts) is a SEPARATE
 * implementation from OpenCode's, and the Pi parity audit repeatedly found
 * cache divergences there. This suite asserts the portable replay and
 * m[0]/m[1] taxonomy invariants using the SAME harness-agnostic bust oracle
 * (src/cache-analysis.ts) the OpenCode suite uses, so both harnesses are held
 * to one definition of a cache bust.
 */

import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { reconcileCompatibilityVerifications } from "../../plugin/src/features/magic-context/claim-policy-backfill";
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
import type { CapturedRequest, MockUsage } from "../src/mock-provider/server";
import { PiTestHarness } from "../src/pi-harness";
import { openTestDb } from "../src/test-db";

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";
const MODEL_LIMIT = 100_000;

const LOW_USAGE: MockUsage = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};

// Above execute_threshold (20% of 100k = 20k) → the next pass executes.
const HIGH_USAGE: MockUsage = {
    input_tokens: 30_000,
    output_tokens: 20,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
};

// High enough to trip the historian trigger while still below the model limit.
const HISTORIAN_TRIGGER_USAGE: MockUsage = {
    input_tokens: 90_000,
    output_tokens: 20,
    cache_creation_input_tokens: 90_000,
    cache_read_input_tokens: 0,
};

function isHistorianRequest(body: Record<string, unknown>): boolean {
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

/** Line-anchored [N] U:/A: ordinal range, scoped to the <new_messages> block. */
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

function installHistorianMatcher(h: PiTestHarness): void {
    h.mock.addMatcher((body) => {
        if (!isHistorianRequest(body)) return null;
        const range = findOrdinalRange(body);
        const usage: MockUsage = {
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
            `<compartment start="${range.start}" end="${range.end}" title="pi cache-invariant chunk" importance="50" episode_type="feature">`,
            "<p1>Driven by the Pi cache-invariant harness exercising the m[0]/m[1] SOFT-delta taxonomy.</p1>",
            "<p2>Pi cache-invariant chunk exercising historian publish.</p2>",
            "<p3>pi cache-invariant chunk</p3>",
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

function mainRequests(h: PiTestHarness): CapturedRequest[] {
    return mainAgentRequests(h.mock.requests());
}

function requestText(request: CapturedRequest | undefined): string {
    return JSON.stringify(request?.body ?? {});
}

function countCompartments(h: PiTestHarness, sessionId: string): number {
    try {
        const row = h
            .contextDb()
            .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?")
            .get(sessionId) as { n: number } | null;
        return row?.n ?? 0;
    } catch {
        return 0;
    }
}

function projectIdentity(h: PiTestHarness): string {
    return resolveProjectIdentity(realpathSync(pathResolve(h.env.workdir)));
}

function writeDb<T>(h: PiTestHarness, fn: (db: Database) => T): T {
    const db = openTestDb(h.contextDbPath(), { readwrite: true });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** Promote a memory to verified and settle the epoch bump its verification
 * event queues. `reconcileCompatibilityVerifications` is the synchronous
 * reconciler the plugin itself runs during injection: draining it here makes
 * the write's ONE epoch bump land now instead of during the next turn, after
 * `setProjectEpoch` has already pinned. Without this the pin is silently
 * undone mid-turn and m[0] HARD-refolds
 * (reason=project_memory_change), which routes the write into m[0] and leaves
 * the m[1] delta lanes untested. */
function verifyAndSettle(db: Database, memoryId: number): void {
    updateMemoryVerification(db, memoryId, "verified");
    reconcileCompatibilityVerifications(db);
}

function seedMemory(
    h: PiTestHarness,
    content: string,
    category: Memory["category"] = "PROJECT_RULES",
): number {
    return writeDb(h, (db) => {
        const id = insertMemory(db, {
            projectPath: projectIdentity(h),
            category,
            content,
            // v86 trust policy: explicit-user origin rows are auto-eligible,
            // but the effective policy is computed by an ASYNC evaluator; a
            // synchronous verification promotion makes eligibility
            // deterministic before the next turn materializes m[0].
            sourceType: "user",
        }).id;
        verifyAndSettle(db, id);
        return id;
    });
}

function projectEpoch(h: PiTestHarness): number {
    return writeDb(
        h,
        (db) =>
            (
                db
                    .prepare(
                        "SELECT project_memory_epoch AS epoch FROM project_state WHERE project_path = ?",
                    )
                    .get(projectIdentity(h)) as { epoch: number } | null
            )?.epoch ?? 0,
    );
}

/** Pin the project epoch to a captured value. Eligible writes and
 * verification promotions bump the epoch, which HARD-refolds m[0]; the
 * m[1] delta lanes under test only fire when memory ids advance WITHOUT an
 * epoch change, so tests pin the epoch back after seeding. */
function setProjectEpoch(h: PiTestHarness, epoch: number): void {
    writeDb(h, (db) => {
        db.prepare(
            `INSERT INTO project_state (project_path, project_memory_epoch)
             VALUES (?, ?)
             ON CONFLICT(project_path) DO UPDATE SET project_memory_epoch = excluded.project_memory_epoch`,
        ).run(projectIdentity(h), epoch);
    });
}

/** Queue the memory-update record used when a memory is replaced, archived, or deleted. */
function queueMemoryUpdate(h: PiTestHarness, targetId: number, newContent: string): void {
    writeDb(h, (db) => {
        db.prepare(
            `INSERT INTO memory_mutation_log
                (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
             VALUES (?, 'update', ?, NULL, NULL, ?, ?)`,
        ).run(projectIdentity(h), targetId, newContent, Date.now());
        updateMemoryContent(db, targetId, newContent, computeNormalizedHash(newContent));
    });
}

/** Increment the project epoch so other processes notice the memory change and reload the initial session-history baseline. */
function bumpProjectEpoch(h: PiTestHarness): void {
    writeDb(h, (db) => {
        db.prepare(
            `INSERT INTO project_state (project_path, project_memory_epoch)
             VALUES (?, 1)
             ON CONFLICT(project_path) DO UPDATE SET project_memory_epoch = project_memory_epoch + 1`,
        ).run(projectIdentity(h));
    });
}

function readOldestActiveTag(h: PiTestHarness, sessionId: string): number {
    const row = h
        .contextDb()
        .prepare(
            "SELECT tag_number AS tag FROM tags WHERE session_id = ? AND harness = 'pi' AND type = 'message' AND status = 'active' ORDER BY tag_number ASC LIMIT 1",
        )
        .get(sessionId) as { tag: number } | null;
    return row?.tag ?? 0;
}

/** Emit a single ctx_reduce tool call on the first main-agent request that exposes it. */
function emitCtxReduceOnce(h: PiTestHarness, drop: string): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted) return null;
        const sys = JSON.stringify(body.system ?? "");
        if (!sys.includes("## Magic Context")) return null;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const name = tools
            .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
            .find((n) => typeof n === "string" && /^ctx_reduce$/.test(n)) as string | undefined;
        if (!name) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_pi_ci_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input: { drop },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: LOW_USAGE,
        };
    });
}

async function waitForLeaseFree(h: PiTestHarness, sessionId: string, label: string): Promise<void> {
    await h.waitFor(
        () => {
            try {
                const lease = h
                    .contextDb()
                    .prepare("SELECT holder_id FROM compartment_state_lease WHERE session_id = ?")
                    .get(sessionId) as { holder_id: string } | null;
                return lease === null ? true : null;
            } catch {
                return true;
            }
        },
        { timeoutMs: 60_000, label },
    );
}

function assertNoBusts(label: string, requests: CapturedRequest[]): void {
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const busts = findBusts(requests);
    if (busts.length > 0) {
        console.error(`[pi-cache-invariant:${label}] ${busts.length} bust(s):\n${formatBustReport(busts)}`);
    }
    expect({ label, busts: busts.length }).toEqual({ label, busts: 0 });
}

async function createHarness(): Promise<PiTestHarness> {
    return PiTestHarness.create({
        modelContextLimit: MODEL_LIMIT,
        magicContextConfig: {
            execute_threshold_percentage: 20,
            protected_tags: 1,
            dreamer: { disable: true },
            sidekick: { disable: true },
            compressor: { enabled: false },
            historian: { model: "anthropic/claude-haiku-4-5" },
            memory: {
                enabled: true,
                auto_promote: false,
                auto_search: { enabled: false },
                git_commit_indexing: { enabled: false },
            },
        },
    });
}

async function sendTurn(
    h: PiTestHarness,
    prompt: string,
    responseText: string,
    usage: MockUsage = LOW_USAGE,
    timeoutMs = 90_000,
): Promise<void> {
    h.mock.setDefault({ text: responseText, usage });
    await h.sendPrompt(prompt, { timeoutMs, continueSession: true });
}

describe("pi cache invariants — replay class", () => {
    it("A1: low-pressure pure-defer growth never busts the cached prefix", async () => {
        const h = await createHarness();
        try {
            for (let i = 1; i <= 6; i++) {
                await sendTurn(h, `pi A1 turn ${i}: low-pressure cache-stability probe.`, `pi A1 reply ${i}`);
            }

            const requests = mainRequests(h);
            expect(requests.length).toBeGreaterThanOrEqual(6);
            assertNoBusts("A1-low-pressure-defer", requests);
        } finally {
            await h.dispose();
        }
    }, 180_000);

    it("A2: defer passes after an execute pass have zero busts", async () => {
        const h = await createHarness();
        try {
            await sendTurn(h, "pi A2 turn 1: warmup.", "pi A2 warmup 1");
            await sendTurn(h, "pi A2 turn 2: warmup.", "pi A2 warmup 2");
            await sendTurn(h, "pi A2 turn 3: high usage marks next pass execute.", "pi A2 high usage", HIGH_USAGE);

            const firstPostExecuteIndex = mainRequests(h).length;
            for (let i = 4; i <= 8; i++) {
                await sendTurn(h, `pi A2 turn ${i}: defer growth after execute.`, `pi A2 defer reply ${i}`);
            }

            const postExecuteWindow = mainRequests(h).slice(firstPostExecuteIndex);
            assertNoBusts("A2-post-execute-defer", postExecuteWindow);
        } finally {
            await h.dispose();
        }
    }, 220_000);

    it("A3: materialized ctx_reduce placeholders do not vanish during defer growth", async () => {
        const h = await createHarness();
        try {
            await sendTurn(h, "pi A3 turn 1: establish reducible baseline content.", "pi A3 reply 1");
            const sessionId = h.lastTurn?.sessionId ?? "";
            expect(sessionId).toBeTruthy();
            const reduceTarget = await h.waitFor(() => readOldestActiveTag(h, sessionId), {
                timeoutMs: 60_000,
                label: "pi A3 active tag for ctx_reduce",
            });
            expect(reduceTarget).toBeGreaterThan(0);

            emitCtxReduceOnce(h, String(reduceTarget));
            await sendTurn(h, `pi A3 turn 2: issue ctx_reduce for old tag ${reduceTarget}.`, "pi A3 after ctx_reduce");
            await sendTurn(h, "pi A3 turn 3: pressure so pending drop applies next.", "pi A3 pressure", HIGH_USAGE);
            await sendTurn(h, "pi A3 turn 4: execute pass materializes the dropped placeholder.", "pi A3 materialize");

            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare("SELECT status FROM tags WHERE session_id = ? AND tag_number = ? AND harness = 'pi'")
                        .get(sessionId, reduceTarget) as { status: string } | null;
                    return row?.status === "dropped" ? true : null;
                },
                { timeoutMs: 60_000, label: "pi A3 ctx_reduce target dropped" },
            );
            expect(requestText(mainRequests(h).at(-1))).toContain("[dropped");

            const postReduceStart = mainRequests(h).length - 1;
            for (let i = 5; i <= 8; i++) {
                await sendTurn(h, `pi A3 turn ${i}: low-pressure defer growth ages the placeholder.`, `pi A3 defer ${i}`);
            }

            const postReduceWindow = mainRequests(h).slice(postReduceStart);
            assertNoBusts("A3-ctx_reduce-placeholder-defer", postReduceWindow);
            expect(requestText(mainRequests(h).at(-1))).toContain("[dropped");
        } finally {
            await h.dispose();
        }
    }, 260_000);
});

describe("pi cache invariants — m[0]/m[1] taxonomy", () => {
    it("B9: published compartments ride m[1] while m[0] and m[1] replay byte-identically", async () => {
        const h = await createHarness();
        try {
            installHistorianMatcher(h);

            // Force an early execute so the baseline session-history block materializes empty before any compartment exists.
            await sendTurn(h, "pi B9 turn 1: warmup.", "pi B9 warm");
            const sessionId = h.lastTurn?.sessionId ?? "";
            expect(sessionId).toBeTruthy();
            await sendTurn(h, "pi B9 turn 2: high usage marks next pass execute.", "pi B9 high", HIGH_USAGE);
            await sendTurn(h, "pi B9 turn 3: execute pass materializes empty m[0].", "pi B9 materialize");

            const m0BaselineEmpty = extractM0(mainRequests(h).at(-1)!.body);
            expect(m0BaselineEmpty).toContain("<session-history></session-history>");

            // Build enough raw conversation text for historian compaction, then trigger and publish it.
            for (let i = 4; i <= 11; i++) {
                await sendTurn(
                    h,
                    `pi B9 turn ${i}: durable content for compartment chunk ${i}. ${h.ballast(3_000)}`,
                    `pi B9 reply ${i}`,
                );
            }
            await sendTurn(h, "pi B9 turn 12: high-usage historian trigger.", "pi B9 trigger", HISTORIAN_TRIGGER_USAGE, 120_000);
            await sendTurn(h, "pi B9 turn 13: follow-up starts + awaits the historian publish.", "pi B9 post", LOW_USAGE, 120_000);

            await h.waitFor(() => countCompartments(h, sessionId) >= 1, {
                timeoutMs: 120_000,
                label: "pi B9 compartment publishes",
            });

            // Keep sending execute-eligible turns until the new compartment appears in the second
            // request body. If historian still holds the lease, Pi defers mutations, so retry under pressure.
            let surfaceReq = mainRequests(h).find((r) => extractM1(r.body)?.includes("<new-compartments>"));
            for (let attempt = 0; attempt < 4 && !surfaceReq; attempt++) {
                await waitForLeaseFree(h, sessionId, "historian lease free before B9 surface execute");
                await sendTurn(h, `pi B9 turn ${14 + attempt}: execute pass to surface.`, `pi B9 surface ${attempt}`, HIGH_USAGE);
                surfaceReq = mainRequests(h).find((r) => extractM1(r.body)?.includes("<new-compartments>"));
            }

            expect(surfaceReq).toBeDefined();
            const m1 = extractM1(surfaceReq!.body)!;
            const m0 = extractM0(surfaceReq!.body)!;
            expect(m1).toContain("<new-compartments>");
            expect(m1).toContain("pi cache-invariant chunk");
            expect(m0).not.toContain("pi cache-invariant chunk");
            expect(m0).toBe(m0BaselineEmpty!);

            const surfaceIdx = mainRequests(h).indexOf(surfaceReq!);
            await sendTurn(h, "pi B9 defer replay 1.", "pi B9 replay 1");
            await sendTurn(h, "pi B9 defer replay 2.", "pi B9 replay 2");

            const after = mainRequests(h).slice(surfaceIdx);
            expect(new Set(after.map((r) => extractM1(r.body))).size).toBe(1);
            expect(new Set(after.map((r) => extractM0(r.body))).size).toBe(1);
            assertNoBusts("B9-soft-publish-replay", mainRequests(h).slice(-2));
        } finally {
            await h.dispose();
        }
    }, 360_000);

    it("B10: additive memory writes ride m[1] <new-memories> while m[0] stays frozen", async () => {
        const h = await createHarness();
        try {
            await sendTurn(h, "pi B10 bootstrap: create the context DB before seeding memory.", "pi B10 bootstrap");
            seedMemory(h, "B10 baseline rule: prefer the project's own tools over shell fallbacks.");
            await h.newSession();
            h.mock.reset();
            await sendTurn(h, "pi B10 turn 1: warmup after baseline memory exists.", "pi B10 warm");
            await sendTurn(h, "pi B10 turn 2: high usage marks next pass execute.", "pi B10 high", HIGH_USAGE);
            await sendTurn(h, "pi B10 turn 3: execute pass materializes m[0] with baseline memory.", "pi B10 materialize");

            const m0Baseline = extractM0(mainRequests(h).at(-1)!.body);
            expect(m0Baseline).toContain("B10 baseline rule");

            await sendTurn(h, "pi B10 turn 4: high usage marks the next pass execute.", "pi B10 pressure", HIGH_USAGE);
            const epochBeforeAdditive = projectEpoch(h);
            seedMemory(h, "B10 fresh rule: always run the full gate before a release.");
            setProjectEpoch(h, epochBeforeAdditive);
            await sendTurn(h, "pi B10 turn 5: execute pass surfaces the new memory.", "pi B10 surface");

            const surfaceReq = mainRequests(h).find((r) => extractM1(r.body)?.includes("B10 fresh rule"));
            expect(surfaceReq).toBeDefined();
            const m1 = extractM1(surfaceReq!.body)!;
            const m0 = extractM0(surfaceReq!.body)!;
            expect(m1).toContain("<new-memories>");
            expect(m1).toContain("B10 fresh rule");
            expect(m0).toContain("B10 baseline rule");
            expect(m0).not.toContain("B10 fresh rule");
            expect(m0).toBe(m0Baseline!);

            await sendTurn(h, "pi B10 turn 6: defer replay.", "pi B10 replay 1");
            await sendTurn(h, "pi B10 turn 7: defer replay again.", "pi B10 replay 2");
            assertNoBusts("B10-additive-memory-replay", mainRequests(h).slice(-2));
        } finally {
            await h.dispose();
        }
    }, 260_000);

    it("B11: an in-place rewrite of a rendered memory HARD-refolds m[0] instead of replaying a stale frozen block", async () => {
        const h = await createHarness();
        try {
            await sendTurn(h, "pi B11 bootstrap: create the context DB before seeding memory.", "pi B11 bootstrap");
            const memId = seedMemory(h, "B11 original rule: deploys go through the staging pipeline first.");
            await h.newSession();
            h.mock.reset();
            await sendTurn(h, "pi B11 turn 1: warmup after baseline memory exists.", "pi B11 warm");
            await sendTurn(h, "pi B11 turn 2: high usage marks next pass execute.", "pi B11 high", HIGH_USAGE);
            await sendTurn(h, "pi B11 turn 3: execute pass materializes m[0] with the memory.", "pi B11 materialize");

            const m0Baseline = extractM0(mainRequests(h).at(-1)!.body);
            expect(m0Baseline).toContain("B11 original rule");

            await sendTurn(h, "pi B11 turn 4: high usage marks the next pass execute.", "pi B11 pressure", HIGH_USAGE);
            const epochBeforeUpdate = projectEpoch(h);
            queueMemoryUpdate(h, memId, "B11 revised rule: deploys go straight to production with a feature flag.");
            // `sessionMemoryBlockStillEligible` compares each rendered id's
            // render-time content digest against the row's current digest, so an
            // in-place rewrite makes the cached block ineligible and m[0] must
            // re-materialize. A content rewrite also withdraws verification (the
            // successor revision starts CANDIDATE), so re-verify through the real
            // API to keep the revised row render-eligible for the refold. Pinning
            // the epoch back proves the refold comes from the digest gate rather
            // than from a project_memory_change bump.
            writeDb(h, (db) => verifyAndSettle(db, memId));
            setProjectEpoch(h, epochBeforeUpdate);
            await sendTurn(h, "pi B11 turn 5: execute pass refolds the revised bytes into m[0].", "pi B11 refold");

            const refoldReq = mainRequests(h)
                .filter((r) => extractM0(r.body)?.includes("B11 revised rule"))
                .at(-1);
            expect(refoldReq).toBeDefined();
            const m1 = extractM1(refoldReq!.body)!;
            const m0 = extractM0(refoldReq!.body)!;
            // Fail-closed invariant: a cached memory block never replays stale
            // bytes, so m[0] carries the revised text and is not the frozen
            // baseline.
            expect(m0).toContain("B11 revised rule");
            expect(m0).not.toContain("B11 original rule");
            expect(m0).not.toBe(m0Baseline!);
            // The refold folds the change into m[0] and advances the mutation
            // cursor, so no <memory-updates> delta is left to render.
            expect(m1).not.toContain("<memory-updates>");

            await sendTurn(h, "pi B11 turn 6: defer replay.", "pi B11 replay 1");
            await sendTurn(h, "pi B11 turn 7: defer replay again.", "pi B11 replay 2");
            assertNoBusts("B11-in-place-rewrite-refold-replay", mainRequests(h).slice(-2));
        } finally {
            await h.dispose();
        }
    }, 260_000);

    it("B12: project epoch bump HARD-refolds a surfaced m[1] delta into m[0]", async () => {
        const h = await createHarness();
        try {
            await sendTurn(h, "pi B12 turn 1: warmup creates the context DB.", "pi B12 warm");
            await sendTurn(h, "pi B12 turn 2: high usage marks next pass execute.", "pi B12 high", HIGH_USAGE);
            await sendTurn(h, "pi B12 turn 3: execute pass materializes empty m[0].", "pi B12 materialize-empty");
            expect(extractM0(mainRequests(h).at(-1)!.body)).toContain("<session-history></session-history>");

            await sendTurn(h, "pi B12 turn 4: high usage marks next pass execute.", "pi B12 pressure", HIGH_USAGE);
            const epochBeforeSeed = projectEpoch(h);
            seedMemory(h, "B12 delta rule: keep the cache prefix byte-identical across defer passes.");
            setProjectEpoch(h, epochBeforeSeed);
            await sendTurn(h, "pi B12 turn 5: execute pass surfaces the memory into m[1].", "pi B12 surface");

            let requests = mainRequests(h);
            const surfaceReq = requests.find((r) => extractM1(r.body)?.includes("B12 delta rule"));
            expect(surfaceReq).toBeDefined();
            expect(extractM0(surfaceReq!.body)).toContain("<session-history></session-history>");
            expect(extractM0(surfaceReq!.body)).not.toContain("B12 delta rule");
            expect(extractM1(surfaceReq!.body)).toContain("B12 delta rule");

            await sendTurn(h, "pi B12 turn 6: high usage marks next pass execute.", "pi B12 hard-pressure", HIGH_USAGE);
            bumpProjectEpoch(h);
            await sendTurn(h, "pi B12 turn 7: execute pass HARD-refolds m[0].", "pi B12 refold");

            requests = mainRequests(h);
            const refoldReq = requests.find(
                (r, i) => i > requests.indexOf(surfaceReq!) && (extractM0(r.body)?.includes("B12 delta rule") ?? false),
            );
            expect(refoldReq).toBeDefined();
            const m0 = extractM0(refoldReq!.body)!;
            const m1 = extractM1(refoldReq!.body)!;
            expect(m0).toContain("B12 delta rule");
            expect(m1).toContain("(no new content since last materialization)");
            expect(m1).not.toContain("B12 delta rule");

            const refoldIdx = requests.indexOf(refoldReq!);
            await sendTurn(h, "pi B12 turn 8: defer replay after refold.", "pi B12 replay 1");
            await sendTurn(h, "pi B12 turn 9: defer replay again.", "pi B12 replay 2");
            const after = mainRequests(h).slice(refoldIdx);
            expect(new Set(after.map((r) => extractM0(r.body))).size).toBe(1);
            assertNoBusts("B12-hard-refold-replay", mainRequests(h).slice(-2));
        } finally {
            await h.dispose();
        }
    }, 280_000);
});
