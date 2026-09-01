/// <reference types="bun-types" />

//
// then:
//
// When the m0/m1 path owns rendering and isCacheBustingPass is false, prepareCompartmentInjection preserves raw messages beyond persisted m[1]'s boundary until an exec pass updates m[1].

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

        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });

        // Historian publishes B for m1; messages m2+ remain in the live tail.
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo just-published")]);

        // clearInjectionCache(SESSION_ID) simulates a restart by discarding the in-memory injection cache.
        // cached_m1_bytes predates B because no cache-busting pass has run since B was published.
        clearInjectionCache(SESSION_ID);

        // A deferred pass below the execute threshold cannot consume the rehydrated deferred-history signal.
        // isCacheBustingPass=false.
        const post = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });

        // B must be represented by its summary in m[0] or m[1], or by raw messages in the live tail.
        const bInSummary =
            post.m1.includes("Bravo just-published") || post.m0.includes("Bravo just-published");
        // B covers m1; trimming through B's boundary removes m1 from the tail.
        const bRawStillPresent = post.tailIds.includes("m1");

        expect(bInSummary || bRawStillPresent).toBe(true);

        // On the cold defer pass, B is absent from the summary.
        // The defer pass retains B's raw messages because stale m[1] does not summarize B.
        expect(bInSummary).toBe(false);
        expect(bRawStillPresent).toBe(true);

        // The next cache-busting pass folds B into m[1] and advances the tail.
        // The cache-busting pass advances the tail after folding B into m[1], preventing permanent duplication.
        const exec = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });
        expect(exec.m1).toContain("Bravo just-published");
        expect(exec.tailIds).not.toContain("m1");
    });

    it("does NOT drop the first compartment when m[0] was materialized before any compartment existed (null persisted boundary)", () => {
        // Falling back to the latest boundary when the cached m[0] boundary is null drops uncompacted messages.
        const projectDirectory = makeProjectDir();

        // With no compartments, lastCompartmentBoundaryId([]) persists a null baseline boundary.
        runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });

        // Persisted cached_m1_bytes predates C, and the baseline boundary remains null.
        appendCompartments(db, SESSION_ID, [compartment(1, "C", "Charlie first-ever")]);

        // clearInjectionCache(SESSION_ID) simulates a cold in-memory cache.
        clearInjectionCache(SESSION_ID);

        const post = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });

        const cInSummary =
            post.m1.includes("Charlie first-ever") || post.m0.includes("Charlie first-ever");
        const cRawStillPresent = post.tailIds.includes("m1");

        // C's raw messages must remain in the tail because stale m[1] does not summarize C.
        expect(cInSummary).toBe(false);
        expect(cRawStillPresent).toBe(true);
    });

    it("clearing the injection cache after an m[0]/m[1] failure routes the next defer pass to cold-rebuild (no history loss)", () => {
        // If injectM0M1 throws after caching the latest boundary, persisted m[1] can predate that boundary.
        // A same-process DEFER pass can trim the new compartment's raw messages while replaying stale m[1], losing history.
        // The failure catch clears the injection cache so the next defer pass cold-rebuilds and trims only to the persisted baseline.
        const projectDirectory = makeProjectDir();

        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });

        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo just-published")]);

        // prepareCompartmentInjection trims to B and caches m1 in memory before injectM0M1 throws.
        const failMsgs = makeMessages(6);
        prepareCompartmentInjection(db, SESSION_ID, failMsgs, true, PROJECT_PATH);

        // Without clearInjectionCache(SESSION_ID), a defer pass reuses the cached m1 boundary.
        // The defer pass trims B's raw m1 messages, and stale m[1] (A) does not summarize B.
        const hazard = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });
        expect(hazard.m1.includes("Bravo just-published")).toBe(false);
        expect(hazard.tailIds.includes("m1")).toBe(false); // B lost without the fix

        // clearInjectionCache(SESSION_ID) forces the next defer pass to rebuild from the persisted boundary.
        // The rebuilt defer pass retains B's raw messages.
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
