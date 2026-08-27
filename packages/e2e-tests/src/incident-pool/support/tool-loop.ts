/**
 * Incident-case harness and context-database support.
 *
 * `createCaseHarness` boots the shared TestHarness INSIDE the case-owned
 * workspace (relocated TMPDIR) and enforces the KTD7 canonical-path check so
 * a driver can never mutate the ambient developer store.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../../../plugin/src/shared/sqlite";
import { TestHarness, type TestHarnessOptions } from "../../harness";
import type { MockUsage } from "../../mock-provider/server";
import { openTestDb } from "../../test-db";
import { DEFAULT_SCRIPTED_TOOL_USAGE } from "../../scripted-tool-call";
import type { CaseDriverContext } from "../registry";

/** Shared low-pressure usage stays below a 20% execute threshold at 100k. */
export const DEFER_USAGE = DEFAULT_SCRIPTED_TOOL_USAGE;

/** High usage that marks the NEXT transform pass as an execute pass. */
export const EXECUTE_USAGE: MockUsage = {
    input_tokens: 30_000,
    output_tokens: 20,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
};

/** High enough to trip the historian trigger (threshold-relative pressure). */
export const HISTORIAN_TRIGGER_USAGE: MockUsage = {
    input_tokens: 90_000,
    output_tokens: 20,
    cache_creation_input_tokens: 90_000,
    cache_read_input_tokens: 0,
};

/**
 * Boot the shared TestHarness inside the case-owned workspace. The harness
 * allocates its isolated env under `os.tmpdir()`, so TMPDIR is pointed at a
 * workspace subdirectory for the duration of the boot; the KTD7 canonical-path
 * check then proves the durable store really lives inside the workspace.
 */
export async function createCaseHarness(
    context: CaseDriverContext,
    options: TestHarnessOptions,
): Promise<TestHarness> {
    const harnessTmp = join(context.workspaceRoot, "case-harness");
    mkdirSync(harnessTmp, { recursive: true });
    const saved = {
        TMPDIR: process.env.TMPDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
    };
    process.env.TMPDIR = harnessTmp;
    process.env.TMP = harnessTmp;
    process.env.TEMP = harnessTmp;
    let harness: TestHarness;
    try {
        harness = await TestHarness.create(options);
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
    if (!caseHarnessIsWorkspaceScoped(harness, context)) {
        await harness.dispose();
        throw new Error(
            "case harness escaped the case-owned workspace (canonical-path check failed)",
        );
    }
    return harness;
}

/** KTD7 canonical-path check: the durable store lives inside the workspace. */
export function caseHarnessIsWorkspaceScoped(
    h: TestHarness,
    context: CaseDriverContext,
): boolean {
    try {
        const dataDir = realpathSync(h.opencode.env.dataDir);
        const root = realpathSync(context.workspaceRoot);
        return dataDir === root || dataDir.startsWith(`${root}/`);
    } catch {
        return false;
    }
}

/** KTD7 unique-namespace check for the case-owned store namespace. */
export function caseNamespaceIsUnique(context: CaseDriverContext): boolean {
    return (
        context.storeNamespace.startsWith("incident-") &&
        context.storeNamespace.length > "incident-".length
    );
}

/**
 * Historian identity substring, deliberately shorter than the production
 * signature line so this stays a *selector* rather than the broad hidden-agent
 * *filter* in `cache-analysis.ts`. This one answers "should my matcher reply to
 * this request", so it must match the historian and not the dreamer, sidekick,
 * or OpenCode's own title/summary/compaction agents.
 *
 * Its relationship to the shared signature is pinned by a test in
 * `cache-analysis.test.ts`: editing the production historian opener without
 * updating this marker fails loudly instead of silently desyncing.
 */
const HISTORIAN_SYSTEM_MARKER =
    "the hippocampus of a long-running coding agent";

export const HISTORIAN_SYSTEM_MARKER_FOR_DRIFT_TEST = HISTORIAN_SYSTEM_MARKER;

function isHistorianRequest(body: Record<string, unknown>): boolean {
    if (JSON.stringify(body.messages ?? "").includes("<new_messages>"))
        return true;
    const system = body.system;
    if (typeof system === "string")
        return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        return system.some(
            (block) =>
                block &&
                typeof block === "object" &&
                typeof (block as { text?: unknown }).text === "string" &&
                (block as { text: string }).text.includes(
                    HISTORIAN_SYSTEM_MARKER,
                ),
        );
    }
    return false;
}

/** Parse the `[N] U:` / `[N] A:` ordinal range from a historian prompt. */
function findOrdinalRange(
    body: Record<string, unknown>,
): { start: number; end: number } | null {
    const messages =
        (body.messages as Array<{ content: unknown }> | undefined) ?? [];
    for (const message of messages) {
        // A provider message may carry content as a bare string; treating that
        // as "no blocks" silently degraded the historian response to an empty
        // compartment set instead of covering the offered chunk.
        const blocks = Array.isArray(message.content)
            ? message.content
            : typeof message.content === "string"
              ? [{ text: message.content }]
              : [];
        for (const block of blocks) {
            const text = (block as { text?: string }).text;
            if (!text || !text.includes("<new_messages>")) continue;
            const start = text.indexOf("<new_messages>");
            const end = text.indexOf("</new_messages>");
            const scope =
                end > start ? text.slice(start, end) : text.slice(start);
            const ordinals = [...scope.matchAll(/^\[(\d+)\] [UA]:/gm)].map(
                (match) => Number(match[1]),
            );
            if (ordinals.length > 0) {
                return {
                    start: Math.min(...ordinals),
                    end: Math.max(...ordinals),
                };
            }
        }
    }
    return null;
}

/**
 * Route historian requests to a valid single-compartment response covering
 * the offered chunk (same shape as tests/cache-invariants.test.ts). The
 * synthetic payload deliberately carries NO scenario fixture tokens so it can
 * never satisfy a search assertion by accident.
 */
export function installHistorianMatcher(h: TestHarness): void {
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
            `<compartment start="${range.start}" end="${range.end}" title="incident-pool chunk" importance="50" episode_type="feature">`,
            "<p1>Synthetic incident-pool compartment covering the offered chunk for message-lane cutoff purposes.</p1>",
            "<p2>Synthetic incident-pool compartment chunk.</p2>",
            "<p3>incident-pool chunk</p3>",
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

/**
 * Open the case harness's context.db read-only and run `fn` over it.
 *
 * Through `openTestDb`, never a bare `new Database`: the plugin under test writes
 * to this same file while a case reads it, and a handle with the default
 * `busy_timeout = 0` fails instantly with SQLITE_BUSY the moment the writer holds
 * the lock. That surfaces as "database is locked" in whichever driver happens to
 * collide, not as a real regression. The path comes from the harness for the same
 * reason it is not rebuilt by hand — one definition, no drift.
 */
export function readContextDb<T>(h: TestHarness, fn: (db: Database) => T): T {
    const db = openTestDb(h.contextDbPath(), { readonly: true });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/**
 * Open the case harness's context.db WRITABLE. KTD7: callers may use this
 * only after the canonical-path / schema-sentinel / empty-state / unique-
 * namespace preconditions passed, and only for the source-documented
 * out-of-band setup a case reproduces.
 */
export function writeContextDb<T>(h: TestHarness, fn: (db: Database) => T): T {
    const db = openTestDb(h.contextDbPath());
    try {
        return fn(db);
    } finally {
        db.close();
    }
}
