/**
 *
 */

import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../../../plugin/src/shared/sqlite";
import { TestHarness, type TestHarnessOptions } from "../../harness";
import type { MockUsage } from "../../mock-provider/server";
import { openTestDb } from "../../test-db";
import { DEFAULT_SCRIPTED_TOOL_USAGE } from "../../scripted-tool-call";
import type { CaseDriverContext } from "../registry";
import { HISTORIAN_SYSTEM_MARKER, isHistorianRequest } from "../../cache-analysis";

/** Shared low-pressure usage stays below a 20% execute threshold at 100k. */
export const DEFER_USAGE = DEFAULT_SCRIPTED_TOOL_USAGE;

/** High usage that marks the NEXT transform pass as an execute pass. */
export const EXECUTE_USAGE: MockUsage = {
    input_tokens: 30_000,
    output_tokens: 20,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
};

/** 90,000 input and cache-creation tokens trigger the historian. */
export const HISTORIAN_TRIGGER_USAGE: MockUsage = {
    input_tokens: 90_000,
    output_tokens: 20,
    cache_creation_input_tokens: 90_000,
    cache_read_input_tokens: 0,
};

/**
 * `TestHarness.create` allocates under `os.tmpdir()`, so `createCaseHarness` redirects sandbox-directory variables during creation and rejects a resolved `dataDir` outside `context.workspaceRoot`.
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

/* */
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

/* */
export function caseNamespaceIsUnique(context: CaseDriverContext): boolean {
    return (
        context.storeNamespace.startsWith("incident-") &&
        context.storeNamespace.length > "incident-".length
    );
}

/**
 * HISTORIAN_SYSTEM_MARKER excludes dreamer, sidekick, and OpenCode title, summary, and compaction requests; HISTORIAN_SYSTEM_MARKER must remain a substring of the production opener.
 *
 */
export const HISTORIAN_SYSTEM_MARKER_FOR_DRIFT_TEST = HISTORIAN_SYSTEM_MARKER;

/** Parse the `[N] U:` / `[N] A:` ordinal range from a historian prompt. */
function findOrdinalRange(
    body: Record<string, unknown>,
): { start: number; end: number } | null {
    const messages =
        (body.messages as Array<{ content: unknown }> | undefined) ?? [];
    for (const message of messages) {
        // Provider messages may use string content; treating it as no blocks produces no compartments for the offered chunk.
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
 * The adapter returns one valid compartment spanning the offered range; its content is fixture-free so search assertions cannot pass accidentally.
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
 *
 * Case reads use `openTestDb` because they can overlap plugin writes to `context.db`.
 * `busy_timeout = 0` makes lock collisions fail immediately with `SQLITE_BUSY`.
 * A lock collision reports "database is locked" in the colliding driver.
 * The harness supplies the path to prevent duplicate path definitions from drifting.
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
 */
export function writeContextDb<T>(h: TestHarness, fn: (db: Database) => T): T {
    const db = openTestDb(h.contextDbPath());
    try {
        return fn(db);
    } finally {
        db.close();
    }
}
