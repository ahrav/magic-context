/// <reference types="bun-types" />

// Repro + regression guard for the "restart history omission" failure mode:
//
// A historian publish sets only IN-MEMORY deferred-refresh signals. If the
// process restarts before the next transform consumes them, and the first
// post-restart pass is a defer pass (below the execute threshold, within TTL),
// then:
//   - prepareCompartmentInjection rebuilds from DB with a COLD in-memory cache
//     and trims the live tail through the LATEST compartment boundary (incl. the
//     freshly published compartment B).
//   - injectM0M1, with isCacheBustingPass=false and no HARD trigger, replays the
//     STALE persisted cached_m1_bytes (which predates B).
// Net: B's raw messages are trimmed out AND B's summary is in neither m[0] nor
// m[1] → that slice of history silently disappears from what the model sees.
//
// The fix makes prepareCompartmentInjection cap its tail-trim at the compartment
// boundary the persisted m[1] actually covers when the m0/m1 path owns rendering
// and this is NOT a cache-busting pass — so a compartment newer than the cached
// m[1] keeps its raw messages in the tail until an exec pass folds it into m[1].

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendCompartments,
    type CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import type { Database } from "../../shared/sqlite";
import {
    clearInjectionCache,
    injectM0M1,
    type M0HardSignals,
    type M0M1State,
    prepareCompartmentInjection,
} from "./inject-compartments";
import type { MessageLike } from "./transform-operations";

const SESSION_ID = "ses_restart_omit";
const PROJECT_PATH = "/tmp/test-restart-omit-project";

let db: Database;
const tempDirs: string[] = [];

function makeDb(): Database {
    const d = createDirectTestDatabase().db;
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function makeProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-restart-omit-"));
    tempDirs.push(dir);
    return dir;
}

function compartment(seq: number, title: string, body: string): CompartmentInput {
    return {
        sequence: seq,
        startMessage: seq,
        endMessage: seq,
        startMessageId: `m${seq}`,
        endMessageId: `m${seq}`,
        title,
        content: body,
        p1: body,
    };
}

// Raw conversation messages with ids m0..mN matching the compartment boundaries.
function makeMessages(count: number): MessageLike[] {
    const out: MessageLike[] = [];
    for (let i = 0; i < count; i++) {
        out.push({
            info: { id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", sessionID: SESSION_ID },
            parts: [{ type: "text", text: `raw message ${i}` }],
        });
    }
    return out;
}

const BASE_HARD: M0HardSignals = {
    systemHash: "sys-v1",
    modelKey: "anthropic/opus",
    cacheExpired: false,
    lastResponseTime: 0,
};

function runProductionFlow(opts: {
    projectDirectory: string;
    isCacheBustingPass: boolean;
    messages: MessageLike[];
}): { m0: string; m1: string; tailIds: string[] } {
    // Mirror the transform→postprocess order: prepareCompartmentInjection first
    // (trims the live tail), then injectM0M1 (prepends m[0]/m[1]).
    prepareCompartmentInjection(
        db,
        SESSION_ID,
        opts.messages,
        opts.isCacheBustingPass,
        PROJECT_PATH,
    );
    const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
    const result = injectM0M1({
        db,
        sessionId: SESSION_ID,
        messages: opts.messages,
        state,
        projectPath: PROJECT_PATH,
        projectDirectory: opts.projectDirectory,
        historyBudgetTokens: 98_000,
        isCacheBustingPass: opts.isCacheBustingPass,
        hardSignals: BASE_HARD,
    });
    // After injectM0M1 the first two messages are the synthetic m[0]/m[1].
    const tailIds = opts.messages
        .slice(2)
        .map((m) => (typeof m.info.id === "string" ? m.info.id : ""));
    return {
        m0: result.m0Bytes ? result.m0Bytes.toString("utf8") : "",
        m1: result.m1Text ?? "",
        tailIds,
    };
}

beforeEach(() => {
    db = makeDb();
    clearInjectionCache(SESSION_ID);
});

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("restart history omission", () => {
    it("does NOT drop a compartment published just before a restart on the first defer pass", () => {
        const projectDirectory = makeProjectDir();

        // Baseline: compartment A covers m0; materialize m[0]/m[1] with A only.
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });

        // Historian publishes compartment B covering m1 (raw messages m2+ remain
        // the live tail). In production this also sets in-memory deferred signals.
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo just-published")]);

        // RESTART: the in-memory injection cache is lost. The persisted
        // cached_m1_bytes still predates B (m[1] only updates on cache-busting
        // passes, which haven't run since B was published).
        clearInjectionCache(SESSION_ID);

        // First post-restart pass is a DEFER pass (below execute threshold): the
        // rehydrated deferred-history signal is NOT consumable here, so
        // isCacheBustingPass=false.
        const post = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });

        // The invariant: B must NOT silently vanish. Either its summary is present
        // (in m[1] or m[0]) OR its raw messages are still in the live tail. The
        // bug is when BOTH are false.
        const bInSummary =
            post.m1.includes("Bravo just-published") || post.m0.includes("Bravo just-published");
        // B's boundary is m1, so its raw slice is messages with id m1 (and the
        // tail m2+). If trimmed through B's boundary, m1 is gone from the tail.
        const bRawStillPresent = post.tailIds.includes("m1");

        expect(bInSummary || bRawStillPresent).toBe(true);

        // Specifically: on the cold defer pass, B is NOT yet in the summary
        // (m[1] replays stale), so its raw messages MUST be retained in the tail.
        expect(bInSummary).toBe(false);
        expect(bRawStillPresent).toBe(true);

        // And the NEXT exec (cache-busting) pass folds B into m[1] and the tail
        // trims forward — no permanent duplication.
        const exec = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });
        expect(exec.m1).toContain("Bravo just-published");
        expect(exec.tailIds).not.toContain("m1");
    });

    it("does NOT drop the first compartment when m[0] was materialized before any compartment existed (null persisted boundary)", () => {
        // Regression for the null-boundary hole in the restart-omission fix: the
        // cold-rebuild trim must distinguish "cached m[0] exists but boundary is
        // null" (m[0] materialized before any compartment → its m[1] covers NOTHING
        // → must NOT trim) from "no cached m[0] / legacy v1" (fall back to latest
        // boundary). Falling back to the latest boundary in the null case
        // reintroduces exactly the history loss the fix exists to prevent.
        const projectDirectory = makeProjectDir();

        // Materialize m[0]/m[1] with ZERO compartments → persisted baseline
        // boundary is null (lastCompartmentBoundaryId([]) === null).
        runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });

        // First compartment C publishes (covers m1). Persisted cached_m1_bytes
        // still predates C and the baseline boundary is still null.
        appendCompartments(db, SESSION_ID, [compartment(1, "C", "Charlie first-ever")]);

        // RESTART: cold in-memory cache.
        clearInjectionCache(SESSION_ID);

        // First post-restart DEFER pass.
        const post = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });

        const cInSummary =
            post.m1.includes("Charlie first-ever") || post.m0.includes("Charlie first-ever");
        const cRawStillPresent = post.tailIds.includes("m1");

        // Must not vanish: C's summary isn't in the stale m[1] yet, so its raw
        // messages MUST remain in the tail (the null-boundary no-trim path).
        expect(cInSummary).toBe(false);
        expect(cRawStillPresent).toBe(true);
    });

    it("clearing the injection cache after an m[0]/m[1] failure routes the next defer pass to cold-rebuild (no history loss)", () => {
        // Regression for the failure-path drain bug: a cache-busting pass trims
        // the tail to the LATEST compartment and caches that NEW boundary, but if
        // injectM0M1 then throws, the persisted m[1] still predates that
        // compartment. WITHOUT clearing the in-memory injection cache, a later
        // same-process DEFER pass reuses the cached new boundary and trims the
        // compartment's raw messages while replaying the stale m[1] → silent loss.
        // The fix clears the injection cache in the failure catch so the next
        // defer pass cold-rebuilds and trims only to the persisted baseline.
        const projectDirectory = makeProjectDir();

        // Baseline: compartment A; materialize m[0]/m[1] with A → persisted
        // baseline boundary = A's (m0), persisted m[1] = A.
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });

        // Compartment B publishes (covers m1).
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo just-published")]);

        // Simulate the failing cache-busting pass: prepareCompartmentInjection runs
        // (trims to latest = B, caches boundary m1 IN MEMORY) but injectM0M1 throws
        // — so persisted m[1] stays = A and the in-memory cache now holds boundary
        // m1. We reproduce that by calling prepare directly without injectM0M1.
        const failMsgs = makeMessages(6);
        prepareCompartmentInjection(db, SESSION_ID, failMsgs, true, PROJECT_PATH);

        // HAZARD (no clear): a defer pass reuses the cached m1 boundary → B's raw
        // messages (m1) are trimmed out, and the stale m[1] (A) doesn't summarize B.
        const hazard = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });
        expect(hazard.m1.includes("Bravo just-published")).toBe(false);
        expect(hazard.tailIds.includes("m1")).toBe(false); // B lost without the fix

        // FIX: clear the injection cache (what the failure catch now does), then
        // the next defer pass cold-rebuilds and trims only to the persisted
        // baseline (A's boundary) → B's raw messages are retained.
        clearInjectionCache(SESSION_ID);
        const fixed = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });
        expect(fixed.m1.includes("Bravo just-published")).toBe(false); // still not in stale m[1]
        expect(fixed.tailIds.includes("m1")).toBe(true); // but raw retained → no loss
    });
});
