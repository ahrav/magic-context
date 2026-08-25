/**
 * Reusable scripted tool_use driving for incident cases (U4, KTD7, R10).
 *
 * A case drives the REAL `ctx_memory` / `ctx_search` / `ctx_note` loops by
 * scripting one tool_use response through the mock provider and capturing:
 *   - the published tool name (from the provider-visible tools array),
 *   - the validated arguments the loop executed,
 *   - the provider-visible tool result (the tool_result block the harness
 *     sends back on the wire — the agent-visible outcome R10 requires).
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
import type { CaseDriverContext } from "../registry";

/** Low-pressure pure-defer usage (below a 20% execute threshold at 100k). */
export const DEFER_USAGE: MockUsage = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};

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

function isMainAgentRequest(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes("## Magic Context");
}

function publishedToolName(
    body: Record<string, unknown>,
    tool: string,
): string | null {
    const tools = body.tools;
    if (!Array.isArray(tools)) return null;
    for (const entry of tools) {
        if (!entry || typeof entry !== "object") continue;
        const name = (entry as { name?: unknown }).name;
        if (name === tool) return name;
    }
    return null;
}

let scriptedCallCounter = 0;

export interface ScriptedToolCallOptions {
    /** Exact published tool name, e.g. "ctx_memory". */
    tool: string;
    input: Record<string, unknown>;
    prompt: string;
    /** Usage for the tool_use response and the follow-up default. */
    usage?: MockUsage;
    followUpText?: string;
}

export interface ScriptedToolCall {
    /** Tool name as published on the provider wire. */
    publishedToolName: string;
    /** The validated arguments the loop executed. */
    input: Record<string, unknown>;
    callId: string;
    /** Provider-visible tool result (the wire tool_result text). */
    resultText: string;
}

interface WireContentBlock {
    type?: string;
    text?: string;
    tool_use_id?: string;
    content?: unknown;
}

function toolResultTextOf(block: WireContentBlock): string {
    const content = block.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((inner) =>
                inner && typeof inner === "object"
                    ? ((inner as WireContentBlock).text ?? "")
                    : "",
            )
            .join("\n");
    }
    return "";
}

/** Find the provider-visible tool_result for one scripted call id. */
export function findToolResultText(
    h: TestHarness,
    callId: string,
): string | null {
    for (const request of h.mock.requests()) {
        const messages = request.body.messages;
        if (!Array.isArray(messages)) continue;
        for (const message of messages) {
            const content = (message as { content?: unknown }).content;
            if (!Array.isArray(content)) continue;
            for (const block of content as WireContentBlock[]) {
                if (
                    block?.type === "tool_result" &&
                    block.tool_use_id === callId
                ) {
                    return toolResultTextOf(block);
                }
            }
        }
    }
    return null;
}

/**
 * Drive ONE real tool loop: script a tool_use response for `tool`, send the
 * prompt, and capture the provider-visible tool result. Throws an
 * infrastructure error when the tool never published or no result reached
 * the wire — a missing loop must never look like a behavioral verdict.
 */
export async function runScriptedToolCall(
    h: TestHarness,
    sessionId: string,
    options: ScriptedToolCallOptions,
): Promise<ScriptedToolCall> {
    const usage = options.usage ?? DEFER_USAGE;
    const callId = `toolu_incident_${++scriptedCallCounter}`;
    let published: string | null = null;
    h.mock.reset();
    h.mock.addMatcher((body) => {
        if (published !== null || !isMainAgentRequest(body)) return null;
        const name = publishedToolName(body, options.tool);
        if (!name) return null;
        published = name;
        return {
            content: [
                { type: "tool_use", id: callId, name, input: options.input },
            ],
            stop_reason: "tool_use" as const,
            usage,
        };
    });
    h.mock.setDefault({
        text: options.followUpText ?? "scripted tool follow-up",
        usage,
    });
    await h.sendPrompt(sessionId, options.prompt);
    if (published === null) {
        throw new Error(
            `tool ${options.tool} was never published on the provider wire`,
        );
    }
    const resultText = findToolResultText(h, callId);
    if (resultText === null) {
        throw new Error(
            `no provider-visible tool_result for scripted ${options.tool} call`,
        );
    }
    return {
        publishedToolName: published,
        input: options.input,
        callId,
        resultText,
    };
}

const HISTORIAN_SYSTEM_MARKER =
    "the hippocampus of a long-running coding agent";

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
        const blocks = Array.isArray(message.content) ? message.content : [];
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

/** Open the case harness's context.db read-only and run `fn` over it. */
export function readContextDb<T>(h: TestHarness, fn: (db: Database) => T): T {
    const dbPath = join(
        h.opencode.env.dataDir,
        "cortexkit",
        "magic-context",
        "context.db",
    );
    const db = new Database(dbPath, { readonly: true });
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
    const dbPath = join(
        h.opencode.env.dataDir,
        "cortexkit",
        "magic-context",
        "context.db",
    );
    const db = new Database(dbPath);
    try {
        return fn(db);
    } finally {
        db.close();
    }
}
