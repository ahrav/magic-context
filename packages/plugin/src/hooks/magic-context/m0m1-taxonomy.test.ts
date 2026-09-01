/// <reference types="bun-types" />

//
//   SOFT+ (defer pass, nothing new)      → m[0] AND m[1] replay BYTE-IDENTICAL.
//   SOFT  (exec / cache-busting pass)    → m[1] re-renders, m[0] stays identical.
// A HARD pass folds m[1] into rematerialized m[0] and resets m[1] to the placeholder.
// A HARD pass caused by TTL idle, system, tools, model change, or content resets m[1] to the placeholder.
//
// A routine historian publish must not mutate m[0].
// `m[1]` delta folds into `m[0]` only on a HARD bust.

import { afterEach, describe, expect, it } from "bun:test";
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
import { clearInjectionCache, injectM0M1, type M0HardSignals } from "./inject-compartments";

const SESSION_ID = "ses_taxonomy";
const PROJECT_PATH = "/tmp/test-taxonomy-project";
const M1_PLACEHOLDER =
    "<session-history-since>(no new content since last materialization)</session-history-since>";

let db: Database;
const tempDirs: string[] = [];

function makeDb(): Database {
    const d = createDirectTestDatabase().db;
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function makeProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-taxonomy-test-"));
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
        // `p1` stores the compartment as v2, so `upgrade_state` remains `"ready"`.
        // `p1` does not trigger a HARD bust.
        p1: body,
    };
}

// The test holds `BASE_HARD` constant to prevent HARD signals and isolate compartment/SOFT behavior.
const BASE_HARD: M0HardSignals = {
    systemHash: "sys-v1",
    modelKey: "anthropic/opus",
    cacheExpired: false,
    lastResponseTime: 0,
};

interface PassResult {
    m0: string;
    m1: string;
    rematerialized: boolean;
    reason: string | null;
}

function pass(opts: {
    projectDirectory: string;
    isCacheBustingPass: boolean;
    hard?: M0HardSignals;
}): PassResult {
    // Each pass rereads session_meta because persisted m[0]/m[1] markers determine the decision.
    const state = getOrCreateSessionMeta(db, SESSION_ID);
    const result = injectM0M1({
        db,
        sessionId: SESSION_ID,
        state,
        projectPath: PROJECT_PATH,
        projectDirectory: opts.projectDirectory,
        historyBudgetTokens: 98_000,
        isCacheBustingPass: opts.isCacheBustingPass,
        hardSignals: opts.hard ?? BASE_HARD,
    });
    return {
        m0: result.m0Bytes ? result.m0Bytes.toString("utf8") : "",
        m1: result.m1Text ?? "",
        rematerialized: result.m0RematerializedThisPass,
        reason: result.decision.reason,
    };
}

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("m[0]/m[1] materialization taxonomy", () => {
    it("SOFT+: a new compartment + defer passes replay m[0] AND m[1] byte-identical", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // The `first_render` pass folds compartment A into `m[0]`.
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const baseline = pass({ projectDirectory, isCacheBustingPass: true });
        expect(baseline.reason).toBe("first_render");

        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);

        // Compartment B appears only on an exec pass.
        const d1 = pass({ projectDirectory, isCacheBustingPass: false });
        const d2 = pass({ projectDirectory, isCacheBustingPass: false });
        expect(d1.rematerialized).toBe(false);
        expect(d1.m0).toBe(baseline.m0);
        expect(d1.m1).toBe(baseline.m1);
        expect(d2.m0).toBe(baseline.m0);
        expect(d2.m1).toBe(baseline.m1);
        expect(d1.m1).not.toContain("Bravo delta");
    });

    it("SOFT: an exec pass surfaces the new compartment in m[1] WITHOUT mutating m[0]", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const baseline = pass({ projectDirectory, isCacheBustingPass: true });
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);

        const soft = pass({ projectDirectory, isCacheBustingPass: true });
        expect(soft.rematerialized).toBe(false);
        expect(soft.m0).toBe(baseline.m0);
        // `m[1]` re-renders and carries B as a `<new-compartments>` delta.
        expect(soft.m1).not.toBe(baseline.m1);
        expect(soft.m1).toContain("Bravo delta");
        expect(soft.m0).not.toContain("Bravo delta");
    });

    it("HARD (model change): folds m[1] into m[0] and resets m[1] to placeholder", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        const hard = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "anthropic/sonnet" },
        });
        expect(hard.reason).toBe("model_change");
        expect(hard.rematerialized).toBe(true);
        // `m[0]` includes B; `m[1]` resets to the placeholder.
        expect(hard.m0).toContain("Bravo delta");
        expect(hard.m1).toBe(M1_PLACEHOLDER);
    });

    it("HARD (system hash change): re-materializes m[0]", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        const hard = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, systemHash: "sys-v2" },
        });
        expect(hard.reason).toBe("system_hash");
        expect(hard.rematerialized).toBe(true);
    });

    it("an EMPTY current HARD signal is never treated as a change (no spurious fold)", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        // `""` means no signal; unknown tool definitions do not trigger a HARD fold.
        const unknown = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: {
                systemHash: "",
                modelKey: "",
                cacheExpired: false,
                lastResponseTime: 0,
            },
        });
        expect(unknown.rematerialized).toBe(false);
    });

    it("HARD (TTL idle): folds ONCE, then is idempotent across the multi-pass turn", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        // `materializedAt < lastResponseTime` simulates an idle return.
        // `materializedAt` greater than `lastResponseTime` prevents another idle fold.
        const tPast = Date.now() - 60 * 60 * 1000;
        db.prepare(
            "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
        ).run(tPast, SESSION_ID);
        const ttlHard: M0HardSignals = {
            ...BASE_HARD,
            cacheExpired: true,
            lastResponseTime: tPast + 1000,
        };

        const fold = pass({ projectDirectory, isCacheBustingPass: true, hard: ttlHard });
        expect(fold.reason).toBe("ttl_idle");
        expect(fold.rematerialized).toBe(true);

        // The fold advances `materializedAt` past `lastResponseTime`, preventing another fold.
        const again = pass({ projectDirectory, isCacheBustingPass: true, hard: ttlHard });
        expect(again.rematerialized).toBe(false);
        expect(again.reason).not.toBe("ttl_idle");
    });

    it("consumer-contract: mustMaterialize respects cacheExpired=false (never-ttl lanes stay warm)", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        // `cacheExpired: false` prevents a `ttl_idle` fold regardless of `lastResponseTime`.
        const tPast = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
        db.prepare(
            "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
        ).run(tPast - 1000, SESSION_ID);
        const neverHard: M0HardSignals = {
            ...BASE_HARD,
            cacheExpired: false, // "never" → hardCacheExpired stays false
            lastResponseTime: tPast,
        };

        const result = pass({ projectDirectory, isCacheBustingPass: true, hard: neverHard });
        expect(result.reason).not.toBe("ttl_idle");
        expect(result.rematerialized).toBe(false);
    });

    it("pressure backstop: small m[0] + large m[1] folds via the absolute m[1] cap", () => {
        // `m[0]` below 2,000 characters disables the `m[1] > 15% of m[0]` ratio test.
        // An absolute cap prevents unbounded `m[1]` growth when `m[0]` is below 2,000 characters.
        // The absolute cap folds when `m[1]` exceeds 20% of the history budget.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // `m[0]` starts below the 2,000-character ratio floor.
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Ax")]);
        // With a 60-token history budget, the absolute cap is 12 tokens.
        const smallBudget: M0HardSignals = BASE_HARD;
        const baseline = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state: getOrCreateSessionMeta(db, SESSION_ID),
            projectPath: PROJECT_PATH,
            projectDirectory,
            historyBudgetTokens: 60,
            isCacheBustingPass: true,
            hardSignals: smallBudget,
        });
        expect(baseline.decision.reason).toBe("first_render");

        appendCompartments(db, SESSION_ID, [
            compartment(1, "B", "Bravo delta with enough words to consume tokens"),
            compartment(2, "C", "Charlie delta with more words again to consume more tokens"),
            compartment(3, "D", "Delta delta even more words here for tokens and tokens"),
        ]);
        const folded = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state: getOrCreateSessionMeta(db, SESSION_ID),
            projectPath: PROJECT_PATH,
            projectDirectory,
            historyBudgetTokens: 60,
            isCacheBustingPass: true,
            hardSignals: smallBudget,
        });
        // `m[1]` exceeds the absolute cap, so this pass folds it into `m[0]`.
        expect(folded.m0RematerializedThisPass).toBe(true);
        expect(folded.m1Text).toBe(M1_PLACEHOLDER);
    });

    it("HARD markers persist across a simulated restart (DB read, not in-memory)", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true, hard: BASE_HARD });

        // Persisted markers must match `BASE_HARD` so a same-identity pass does not fold after a restart.
        const restartState = getOrCreateSessionMeta(db, SESSION_ID);
        expect(restartState.cachedM0ModelKey).toBe("anthropic/opus");
        expect(restartState.cachedM0SystemHash).toBe("sys-v1");

        const noFold = pass({ projectDirectory, isCacheBustingPass: true, hard: BASE_HARD });
        expect(noFold.rematerialized).toBe(false);
    });
    it("does not hard-fold when the current model switches from canonical to Pi alias spelling", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const canonical = { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" };
        pass({ projectDirectory, isCacheBustingPass: true, hard: canonical });

        const aliasOnly = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai-codex/gpt-5.6-sol" },
        });

        expect(aliasOnly.rematerialized).toBe(false);
        expect(aliasOnly.reason).toBeNull();
    });

    it("persists a Pi-native baseline canonically, then accepts the reverse spelling flip", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai-codex/gpt-5.6-sol" },
        });

        expect(getOrCreateSessionMeta(db, SESSION_ID).cachedM0ModelKey).toBe("openai/gpt-5.6-sol");
        const aliasOnly = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" },
        });

        expect(aliasOnly.rematerialized).toBe(false);
        expect(aliasOnly.reason).toBeNull();
    });

    it("does not hard-fold when an existing cached baseline stores a native alias", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" },
        });
        db.prepare("UPDATE session_meta SET cached_m0_model_key = ? WHERE session_id = ?").run(
            "openai-codex/gpt-5.6-sol",
            SESSION_ID,
        );

        const upgraded = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" },
        });

        expect(upgraded.rematerialized).toBe(false);
        expect(upgraded.reason).toBeNull();
    });

    it("still hard-folds for different models in the same alias family", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai-codex/gpt-5.6-sol" },
        });

        const realSwitch = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-codex" },
        });

        expect(realSwitch.rematerialized).toBe(true);
        expect(realSwitch.reason).toBe("model_change");
    });
});
