/**
 * Registered shared drivers for the promoted fixed regressions (U3):
 *
 *   - parity A1 — first-render tag stability on pure-defer growth
 *   - parity A3 — aged ctx_reduce prefix survival on defer growth
 *   - thinking-block green successor — Bug A/B/C of the Anthropic 400 family,
 *     scoped with `auto_search` disabled per the committed adjudication in
 *     `mutations/thinking-block-adjudication.md`
 *
 * Each regression is a driver returning serializable observations plus a PURE
 * verifier mapping observations to static check IDs and a behavioral verdict.
 * The original Bun suites (`tests/cache-invariants.test.ts`,
 * `tests/thinking-block-safety.test.ts`) remain thin green wrappers over these
 * exports, so one behavioral oracle serves both the ordinary green suite and
 * the incident registry.
 */

import { detectRustPrerequisites } from "../../../scripts/check-rust-prerequisites";
import {
    findBusts,
    formatBustReport,
    mainAgentRequests,
} from "../../cache-analysis";
import type { TestHarness, TestHarnessOptions } from "../../harness";
import type { MockUsage } from "../../mock-provider/server";
import type {
    CaseDriverContext,
    JsonValue,
    PreconditionOutcome,
    RegisteredIncidentCase,
} from "../registry";
import { createCaseHarness } from "../support/tool-loop";

export interface RegressionCheck {
    id: string;
    passed: boolean;
}

export interface RegressionResult {
    verdict: "pass" | "assertion_fail";
    checks: RegressionCheck[];
}

function resultFromChecks(checks: RegressionCheck[]): RegressionResult {
    return {
        verdict: checks.every((check) => check.passed)
            ? "pass"
            : "assertion_fail",
        checks,
    };
}

/** Failed-check IDs, for wrapper assertions and error messages. */
export function failedCheckIds(result: RegressionResult): string[] {
    return result.checks
        .filter((check) => !check.passed)
        .map((check) => check.id);
}

// ---------------------------------------------------------------------------
// Parity A1/A3 — first-render tag stability (fixed Rust parity defects).
// Assumes the wrapper harness uses a 100k model limit with a 20% execute
// threshold, so this usage keeps every pass a pure defer pass.
// ---------------------------------------------------------------------------

const DEFER_USAGE: MockUsage = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};

export const FIRST_RENDER_HARNESS_OPTIONS = {
    modelContextLimit: 100_000,
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
} as const satisfies TestHarnessOptions;

export const FIRST_RENDER_A1_CHECKS = [
    "check-a1-defer-request-floor",
    "check-a1-zero-prefix-busts",
] as const;

export const FIRST_RENDER_A3_CHECKS = [
    "check-a3-reduce-on-wire",
    "check-a3-zero-prefix-busts",
    "check-a3-reduce-retained-final-wire",
] as const;

export interface FirstRenderDeferObservation extends Record<string, JsonValue> {
    mainRequestCount: number;
    bustCount: number;
    bustReport: string;
}

export interface AgedCtxReduceObservation extends Record<string, JsonValue> {
    sawReduceOnWire: boolean;
    bustCount: number;
    bustReport: string;
    finalWireHasCtxReduce: boolean;
}

export async function driveFirstRenderPureDeferStability(
    h: TestHarness,
): Promise<FirstRenderDeferObservation> {
    const sessionId = await h.createSession();
    for (let i = 1; i <= 6; i++) {
        h.mock.setDefault({ text: `A1 reply ${i}`, usage: DEFER_USAGE });
        await h.sendPrompt(
            sessionId,
            `A1 turn ${i}: low-pressure cache-stability probe.`,
        );
    }
    const requests = mainAgentRequests(h.mock.requests());
    const busts = findBusts(requests);
    return {
        mainRequestCount: requests.length,
        bustCount: busts.length,
        bustReport: busts.length > 0 ? formatBustReport(busts) : "",
    };
}

export function verifyFirstRenderPureDeferStability(
    observation: FirstRenderDeferObservation,
): RegressionResult {
    return resultFromChecks([
        {
            id: "check-a1-defer-request-floor",
            passed: observation.mainRequestCount >= 6,
        },
        {
            id: "check-a1-zero-prefix-busts",
            passed: observation.bustCount === 0,
        },
    ]);
}

function messageBlocks(message: unknown): Array<Record<string, unknown>> {
    if (!message || typeof message !== "object") return [];
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.filter(
        (block): block is Record<string, unknown> =>
            block !== null &&
            typeof block === "object" &&
            !Array.isArray(block),
    );
}

/** Require the emitted ctx_reduce use/result pair, not its tool declaration. */
export function hasCtxReducePair(
    body: Record<string, unknown>,
    callId: string,
): boolean {
    if (!Array.isArray(body.messages)) return false;
    for (let index = 0; index < body.messages.length - 1; index += 1) {
        const assistant = body.messages[index];
        const user = body.messages[index + 1];
        if (
            !assistant ||
            typeof assistant !== "object" ||
            (assistant as { role?: unknown }).role !== "assistant" ||
            !user ||
            typeof user !== "object" ||
            (user as { role?: unknown }).role !== "user"
        ) {
            continue;
        }
        const use = messageBlocks(assistant).some(
            (block) =>
                block.type === "tool_use" &&
                block.id === callId &&
                typeof block.name === "string" &&
                /ctx_reduce/.test(block.name),
        );
        const result = messageBlocks(user).some(
            (block) =>
                block.type === "tool_result" && block.tool_use_id === callId,
        );
        if (use && result) return true;
    }
    return false;
}

/** Emit a single ctx_reduce tool call on the first main-agent request that exposes it. */
function emitCtxReduceOnce(h: TestHarness, drop: string, callId: string): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted) return null;
        const sys = JSON.stringify(body.system ?? "");
        if (!sys.includes("## Magic Context")) return null;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const name = tools
            .map((t) =>
                t && typeof t === "object"
                    ? (t as { name?: unknown }).name
                    : null,
            )
            .find((n) => typeof n === "string" && /ctx_reduce/.test(n)) as
            | string
            | undefined;
        if (!name) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: callId,
                    name,
                    input: { drop },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: DEFER_USAGE,
        };
    });
}

export async function driveAgedCtxReduceSurvival(
    h: TestHarness,
): Promise<AgedCtxReduceObservation> {
    const sessionId = await h.createSession();
    h.mock.setDefault({ text: "A3 reply 1", usage: DEFER_USAGE });
    await h.sendPrompt(sessionId, "A3 turn 1: establish baseline content.");

    emitCtxReduceOnce(
        h,
        FIRST_RENDER_A3_FIXTURE.drop,
        FIRST_RENDER_A3_FIXTURE.callId,
    );
    h.mock.setDefault({
        text: "A3 reply 2 (after ctx_reduce tool call)",
        usage: DEFER_USAGE,
    });
    await h.sendPrompt(
        sessionId,
        "A3 turn 2: this turn issues a ctx_reduce call.",
    );

    // Age the ctx_reduce call past the protected window with pure-defer growth.
    let sawReduceOnWire = false;
    for (let i = 3; i <= 8; i++) {
        h.mock.setDefault({ text: `A3 defer reply ${i}`, usage: DEFER_USAGE });
        await h.sendPrompt(
            sessionId,
            `A3 turn ${i}: defer growth ages the ctx_reduce call.`,
        );
        const body = h.mock.lastRequest()?.body;
        if (body && hasCtxReducePair(body, FIRST_RENDER_A3_FIXTURE.callId)) {
            sawReduceOnWire = true;
        }
    }

    const requests = mainAgentRequests(h.mock.requests());
    const busts = findBusts(requests);
    const finalBody = requests.at(-1)?.body;
    return {
        sawReduceOnWire,
        bustCount: busts.length,
        bustReport: busts.length > 0 ? formatBustReport(busts) : "",
        finalWireHasCtxReduce:
            finalBody !== undefined &&
            hasCtxReducePair(finalBody, FIRST_RENDER_A3_FIXTURE.callId),
    };
}

export function verifyAgedCtxReduceSurvival(
    observation: AgedCtxReduceObservation,
): RegressionResult {
    return resultFromChecks([
        { id: "check-a3-reduce-on-wire", passed: observation.sawReduceOnWire },
        {
            id: "check-a3-zero-prefix-busts",
            passed: observation.bustCount === 0,
        },
        {
            id: "check-a3-reduce-retained-final-wire",
            passed: observation.finalWireHasCtxReduce,
        },
    ]);
}

// ---------------------------------------------------------------------------
// Thinking-block green successor (Anthropic 400 family, Bug A/B/C).
// ---------------------------------------------------------------------------

/**
 * Harness options for the thinking-block successor suite. `auto_search` is off
 * because Bug B asserts the dropped paste body is absent from ALL user text.
 * Dropped content intentionally stays searchable, so when the async FTS index
 * catches up in time the auto-search hint quotes an 80-char fragment of the
 * paste back into the next user message — a timing coin-flip that failed 3 of
 * 20 serial runs (see `mutations/thinking-block-adjudication.md`). This suite
 * tests thinking-block safety, not search recall.
 */
export const THINKING_BLOCK_HARNESS_OPTIONS = {
    magicContextConfig: {
        execute_threshold_percentage: 80,
        memory: { auto_search: { enabled: false } },
    },
    modelContextLimit: 50_000,
} as const;

export const THINKING_NUDGE_ANCHOR_CHECKS = [
    "check-thinking-a-no-nudge-in-signed-assistant",
    "check-thinking-a-signature-byte-stable",
    "check-thinking-a-nonvacuous-inspection",
] as const;

export const THINKING_DROPPED_SHELL_CHECKS = [
    "check-thinking-b-drop-emitted",
    "check-thinking-b-paste-body-absent",
    "check-thinking-b-shell-preserved",
    "check-thinking-b-signed-replay-intact",
    "check-thinking-b-turn-boundary-preserved",
] as const;

export const THINKING_IMAGE_SURVIVAL_CHECKS = [
    "check-thinking-c-drop-emitted",
    "check-thinking-c-dropped-text-absent",
    "check-thinking-c-shell-preserved",
    "check-thinking-c-image-part-survives",
] as const;

interface AnthropicContentBlock {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
}

interface AnthropicMessage {
    role: string;
    content: AnthropicContentBlock[] | string;
}

function messagesOf(body: Record<string, unknown>): AnthropicMessage[] {
    return Array.isArray(body.messages)
        ? (body.messages as AnthropicMessage[])
        : [];
}

function mainRequests(
    h: TestHarness,
): Array<{ body: Record<string, unknown> }> {
    return h.mock
        .requests()
        .filter((request) =>
            JSON.stringify(request.body.system ?? "").includes(
                "## Magic Context",
            ),
        );
}

function blocksOfRole(
    body: Record<string, unknown>,
    role: string,
): AnthropicContentBlock[] {
    return messagesOf(body)
        .filter((m) => m.role === role)
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []));
}

function userText(body: Record<string, unknown>): string {
    return blocksOfRole(body, "user")
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
}

function findThinkingBlocks(
    body: Record<string, unknown>,
): AnthropicContentBlock[] {
    const out: AnthropicContentBlock[] = [];
    for (const msg of messagesOf(body)) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (block.type === "thinking" || block.type === "redacted_thinking")
                out.push(block);
        }
    }
    return out;
}

function toolName(
    body: Record<string, unknown>,
    pattern: RegExp,
): string | null {
    const tools = body.tools;
    if (!Array.isArray(tools)) return null;
    for (const tool of tools) {
        if (!tool || typeof tool !== "object") continue;
        const name = (tool as { name?: unknown }).name;
        if (typeof name === "string" && pattern.test(name)) return name;
    }
    return null;
}

function emitThinkingCtxReduceOnce(h: TestHarness, tag: number): () => boolean {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (
            emitted ||
            !JSON.stringify(body.system ?? "").includes("## Magic Context")
        )
            return null;
        const name = toolName(body, /^ctx_reduce$/);
        if (!name) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_reduce_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input: { drop: String(tag) },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: {
                input_tokens: 45_000,
                output_tokens: 20,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        };
    });
    return () => emitted;
}

/** Resolve the public §N§ handle for a message containing `needle`. */
function tagForText(body: Record<string, unknown>, needle: string): number {
    for (const message of messagesOf(body)) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
            const text = block.text;
            if (typeof text !== "string" || !text.includes(needle)) continue;
            const match = text.match(/§(\d+)§/u);
            if (match) return Number(match[1]);
        }
    }
    throw new Error(`no §N§ tag found for ${JSON.stringify(needle)}`);
}

async function ageTagBeyondProtectedWindow(
    h: TestHarness,
    sessionId: string,
): Promise<void> {
    h.mock.reset();
    h.mock.setDefault({
        text: "aging response",
        usage: {
            input_tokens: 1_000,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1_000,
        },
    });
    for (let turn = 0; turn < 6; turn += 1) {
        await h.sendPrompt(sessionId, `aging turn ${turn + 1}`);
    }
}

async function dropAndMaterialize(
    h: TestHarness,
    sessionId: string,
    tag: number,
): Promise<{ body: Record<string, unknown>; dropEmitted: boolean }> {
    h.mock.reset();
    const wasDropEmitted = emitThinkingCtxReduceOnce(h, tag);
    h.mock.setDefault({
        text: "after reduce",
        usage: {
            input_tokens: 45_000,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
    });
    await h.sendPrompt(sessionId, `mark §${tag}§ spent`);

    h.mock.reset();
    h.mock.setDefault({
        text: "after materialization",
        usage: {
            input_tokens: 1_000,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1_000,
        },
    });
    await h.sendPrompt(sessionId, "inspect the reduced history");
    return {
        body: mainRequests(h).at(-1)!.body,
        dropEmitted: wasDropEmitted(),
    };
}

const NUDGE_MARKERS = [
    '<instruction name="context_',
    "context_iteration",
    "context_warning",
    "context_critical",
] as const;

export interface ThinkingNudgeAnchorObservation
    extends Record<string, JsonValue> {
    rustMode: boolean;
    mainRequestCount: number;
    inspectedSignedAssistants: number;
    nudgeMarkerFound: boolean;
    thinkingByteStable: boolean;
    rustThinkingBlockCount: number;
}

export async function driveThinkingNudgeAnchor(
    h: TestHarness,
    options: { rustMode: boolean },
): Promise<ThinkingNudgeAnchorObservation> {
    h.mock.reset();

    const signedThinking = "Let me work through this carefully step by step.";
    const signature = "opaque-provider-signature-bug-a";

    // Respond with thinking + text so the assistant carries a signed thinking
    // block; ~46% of 50K keeps the nudge band (reinjectNudgeAtAnchor) live.
    h.mock.setDefault({
        content: [
            { type: "thinking", thinking: signedThinking, signature },
            { type: "text", text: "Here is the answer." },
        ],
        usage: {
            input_tokens: 23_000,
            output_tokens: 200,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
    });

    const sessionId = await h.createSession();
    await h.sendPrompt(sessionId, "turn 1 — establish the thinking block");
    await h.sendPrompt(
        sessionId,
        "turn 2 — give nudge logic a chance to anchor",
    );
    await h.sendPrompt(
        sessionId,
        "turn 3 — defer pass must not mutate signed msg",
    );

    const reqs = mainRequests(h);
    const lastBody = reqs.at(-1)?.body ?? {};
    const assistants = messagesOf(lastBody).filter(
        (m) => m.role === "assistant",
    );

    let inspected = 0;
    let nudgeMarkerFound = false;
    let thinkingByteStable = true;
    for (const asst of assistants) {
        if (!Array.isArray(asst.content)) continue;
        const hasMatchingSig = asst.content.some(
            (b) => b.type === "thinking" && b.signature === signature,
        );
        if (!hasMatchingSig) {
            if (options.rustMode) {
                const serialized = JSON.stringify(asst.content);
                if (NUDGE_MARKERS.some((marker) => serialized.includes(marker)))
                    nudgeMarkerFound = true;
            }
            continue;
        }
        inspected++;
        for (const block of asst.content) {
            if (block.type !== "text") continue;
            if (
                NUDGE_MARKERS.some((marker) =>
                    (block.text ?? "").includes(marker),
                )
            ) {
                nudgeMarkerFound = true;
            }
        }
        const thinking = asst.content.find((b) => b.type === "thinking");
        if (
            thinking?.thinking !== signedThinking ||
            thinking?.signature !== signature
        ) {
            thinkingByteStable = false;
        }
    }

    return {
        rustMode: options.rustMode,
        mainRequestCount: reqs.length,
        inspectedSignedAssistants: inspected,
        nudgeMarkerFound,
        thinkingByteStable,
        rustThinkingBlockCount: findThinkingBlocks(lastBody).length,
    };
}

export function verifyThinkingNudgeAnchor(
    observation: ThinkingNudgeAnchorObservation,
): RegressionResult {
    return resultFromChecks([
        {
            id: "check-thinking-a-no-nudge-in-signed-assistant",
            passed: !observation.nudgeMarkerFound,
        },
        {
            // PARITY.md defines Rust historical reasoning as CLEARED rather
            // than signature-preserving, so absence is the safe Rust shape.
            id: "check-thinking-a-signature-byte-stable",
            passed: observation.rustMode
                ? observation.rustThinkingBlockCount === 0
                : observation.thinkingByteStable,
        },
        {
            id: "check-thinking-a-nonvacuous-inspection",
            passed:
                observation.mainRequestCount >= 3 &&
                (observation.rustMode ||
                    observation.inspectedSignedAssistants > 0),
        },
    ]);
}

export interface ThinkingDroppedShellObservation
    extends Record<string, JsonValue> {
    rustMode: boolean;
    dropEmitted: boolean;
    pasteBodyAbsent: boolean;
    shellPreserved: boolean;
    signedReplayIntact: boolean;
    turnBoundaryPreserved: boolean;
}

export async function driveThinkingDroppedShell(
    h: TestHarness,
    options: { rustMode: boolean },
): Promise<ThinkingDroppedShellObservation> {
    h.mock.reset();

    const signedThinkingA = "First thinking block for turn one.";
    const signedThinkingB = "Second thinking block for turn two.";
    const sigA = "sig-bug-b-turn-one";
    const sigB = "sig-bug-b-turn-two";

    h.mock.script([
        {
            content: [
                {
                    type: "thinking",
                    thinking: signedThinkingA,
                    signature: sigA,
                },
                { type: "text", text: "Response to turn 1." },
            ],
            usage: {
                input_tokens: 15_000,
                output_tokens: 100,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        },
        {
            content: [
                {
                    type: "thinking",
                    thinking: signedThinkingB,
                    signature: sigB,
                },
                { type: "text", text: "Response to turn 2." },
            ],
            usage: {
                input_tokens: 18_000,
                output_tokens: 100,
                cache_creation_input_tokens: 10_000,
                cache_read_input_tokens: 5_000,
            },
        },
    ]);
    h.mock.setDefault({
        content: [{ type: "text", text: "follow-up" }],
        usage: {
            input_tokens: 19_000,
            output_tokens: 50,
            cache_creation_input_tokens: 10_000,
            cache_read_input_tokens: 9_000,
        },
    });

    const sessionId = await h.createSession();
    await h.sendPrompt(sessionId, "please explain how the drop logic works");

    // A massive user paste that the scenario drops afterwards through its
    // public §N§ handle, avoiding coupling either mode to its private store.
    const paste = `Here is a log of the failing session:\n${"ERROR: call_failed at line 42.\n".repeat(60)}`;
    await h.sendPrompt(sessionId, paste);

    const pasteTag = tagForText(
        mainRequests(h).at(-1)!.body,
        "Here is a log of the failing session:",
    );
    await ageTagBeyondProtectedWindow(h, sessionId);
    const reduced = await dropAndMaterialize(h, sessionId, pasteTag);
    const body = reduced.body;

    const allUserText = userText(body);
    const pasteBodyAbsent = !allUserText.includes(
        "ERROR: call_failed at line 42.",
    );
    // TS keeps the `[dropped §N§]` shell; Rust supersedes covered turns with
    // one safe published history summary.
    const shellPreserved = options.rustMode
        ? allUserText.includes("<session-history>")
        : /\[dropped \u00a7\d+\u00a7\]/.test(allUserText);

    const thinkings = findThinkingBlocks(body);
    const signatures = new Set(thinkings.map((t) => t.signature));
    let signedReplayIntact: boolean;
    if (options.rustMode) {
        signedReplayIntact = thinkings.length === 0;
    } else {
        signedReplayIntact = signatures.has(sigA) || signatures.has(sigB);
        for (const t of thinkings) {
            if (t.signature === sigA && t.thinking !== signedThinkingA)
                signedReplayIntact = false;
            if (t.signature === sigB && t.thinking !== signedThinkingB)
                signedReplayIntact = false;
        }
    }

    const messages = messagesOf(body);
    let turnBoundaryPreserved: boolean;
    if (options.rustMode) {
        turnBoundaryPreserved = true;
        for (let i = 1; i < messages.length; i++) {
            if (
                messages[i - 1]!.role === "assistant" &&
                messages[i]!.role === "assistant"
            ) {
                turnBoundaryPreserved = false;
            }
        }
    } else {
        let userToAssistantTransitions = 0;
        for (let i = 1; i < messages.length; i++) {
            if (
                messages[i - 1]!.role === "user" &&
                messages[i]!.role === "assistant"
            ) {
                userToAssistantTransitions++;
            }
        }
        turnBoundaryPreserved = userToAssistantTransitions >= 2;
    }

    return {
        rustMode: options.rustMode,
        dropEmitted: reduced.dropEmitted,
        pasteBodyAbsent,
        shellPreserved,
        signedReplayIntact,
        turnBoundaryPreserved,
    };
}

export function verifyThinkingDroppedShell(
    observation: ThinkingDroppedShellObservation,
): RegressionResult {
    return resultFromChecks([
        {
            id: "check-thinking-b-drop-emitted",
            passed: observation.dropEmitted,
        },
        {
            id: "check-thinking-b-paste-body-absent",
            passed: observation.pasteBodyAbsent,
        },
        {
            id: "check-thinking-b-shell-preserved",
            passed: observation.shellPreserved,
        },
        {
            id: "check-thinking-b-signed-replay-intact",
            passed: observation.signedReplayIntact,
        },
        {
            id: "check-thinking-b-turn-boundary-preserved",
            passed: observation.turnBoundaryPreserved,
        },
    ]);
}

export interface ThinkingImageSurvivalObservation
    extends Record<string, JsonValue> {
    rustMode: boolean;
    dropEmitted: boolean;
    droppedTextAbsent: boolean;
    coveredByRustHistory: boolean;
    imageBlockCount: number;
    placeholderPresent: boolean;
    userWithImagePresent: boolean;
}

export async function driveThinkingImageSurvival(
    h: TestHarness,
    options: { rustMode: boolean },
): Promise<ThinkingImageSurvivalObservation> {
    h.mock.reset();
    h.mock.setDefault({
        content: [{ type: "text", text: "I see the screenshot." }],
        usage: {
            input_tokens: 22_000,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
    });

    const sessionId = await h.createSession();

    // Drive an OpenCode prompt carrying both text + a file part. The SdkClient
    // helper is text-only, so call the raw client to include a file part.
    const sdk = await import("@opencode-ai/sdk");
    // SAFETY: widen the client so the prompt body can include a file part;
    // the server accepts it even though the published type omits it. commentlint: allow(JUDGE)
    const rawClient = sdk.createOpencodeClient({
        baseUrl: h.opencode.url,
    }) as unknown as {
        session: {
            prompt: (opts: {
                path: { id: string };
                body: {
                    model: { providerID: string; modelID: string };
                    parts: Array<{
                        type: "text" | "file";
                        text?: string;
                        mime?: string;
                        url?: string;
                        filename?: string;
                    }>;
                };
            }) => Promise<unknown>;
        };
    };

    // 1x1 transparent PNG data URL.
    const imageDataUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    await rawClient.session.prompt({
        path: { id: sessionId },
        body: {
            model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
            parts: [
                { type: "text", text: "see this screenshot for the bug" },
                {
                    type: "file",
                    mime: "image/png",
                    url: imageDataUrl,
                    filename: "bug.png",
                },
            ],
        },
    });

    // Drop only the text block via its public §N§ handle; the image is a
    // sibling content block.
    const userTextTag = tagForText(
        mainRequests(h).at(-1)!.body,
        "see this screenshot for the bug",
    );
    await ageTagBeyondProtectedWindow(h, sessionId);
    const reduced = await dropAndMaterialize(h, sessionId, userTextTag);
    const body = reduced.body;

    const allUserBlocks = blocksOfRole(body, "user");
    const imageBlocks = allUserBlocks.filter((b) => b.type === "image");
    const allUserText = allUserBlocks
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");

    return {
        rustMode: options.rustMode,
        dropEmitted: reduced.dropEmitted,
        droppedTextAbsent: !allUserText.includes(
            "see this screenshot for the bug",
        ),
        coveredByRustHistory:
            options.rustMode && allUserText.includes("<session-history>"),
        imageBlockCount: imageBlocks.length,
        placeholderPresent: /\[dropped \u00a7\d+\u00a7\]/.test(allUserText),
        userWithImagePresent: messagesOf(body).some(
            (m) =>
                m.role === "user" &&
                Array.isArray(m.content) &&
                m.content.some((b) => b.type === "image"),
        ),
    };
}

export function verifyThinkingImageSurvival(
    observation: ThinkingImageSurvivalObservation,
): RegressionResult {
    // A published Rust history range owns every raw block it covers, so the
    // summary legitimately supersedes both the text shell and the image.
    const covered = observation.coveredByRustHistory;
    return resultFromChecks([
        {
            id: "check-thinking-c-drop-emitted",
            passed: observation.dropEmitted,
        },
        {
            id: "check-thinking-c-dropped-text-absent",
            passed: observation.droppedTextAbsent,
        },
        {
            id: "check-thinking-c-shell-preserved",
            passed: covered || observation.placeholderPresent,
        },
        {
            id: "check-thinking-c-image-part-survives",
            passed: covered
                ? observation.imageBlockCount === 0
                : observation.imageBlockCount > 0 &&
                  observation.userWithImagePresent,
        },
    ]);
}

const SOURCE_LINKED_IMPLEMENTATION_FILES = [
    "packages/e2e-tests/src/incident-pool/scenarios/source-linked-regressions.ts",
    "packages/e2e-tests/src/incident-pool/support/tool-loop.ts",
    "packages/e2e-tests/src/harness.ts",
    "packages/e2e-tests/src/opencode-runner/spawn.ts",
    "packages/plugin/src/hooks/magic-context/hook-handlers.ts",
    // The product transform pipeline these cases actually exercise: A1/A3 read
    // the rendered prefix it emits, and the thinking variants depend on its
    // replay, shell-drop, and image-preservation behavior. Hashing only the
    // importing hook file would leave the digest unchanged when this behavior
    // changes.
    "packages/plugin/src/hooks/magic-context/transform.ts",
    "packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts",
    "packages/plugin/src/hooks/magic-context/strip-content.ts",
];

export const FIRST_RENDER_A1_FIXTURE = {
    scenario: "pure-defer-growth",
    turns: 6,
    modelContextLimit: 100_000,
    executeThresholdPercentage: 20,
} as const;

export const FIRST_RENDER_A3_FIXTURE = {
    scenario: "aged-ctx-reduce-defer-growth",
    turns: 8,
    drop: "99999",
    callId: "toolu_incident_a3_ctx_reduce",
    requiredWireEvidence: "matching ctx_reduce tool_use and tool_result blocks",
    modelContextLimit: 100_000,
    executeThresholdPercentage: 20,
} as const;

export const THINKING_NUDGE_FIXTURE = {
    scenario: "signed-thinking-nudge-anchor",
    rustMode: false,
    autoSearch: false,
    modelContextLimit: 50_000,
} as const;

export const THINKING_DROPPED_SHELL_FIXTURE = {
    scenario: "dropped-user-shell-boundary",
    rustMode: false,
    autoSearch: false,
    modelContextLimit: 50_000,
} as const;

export const THINKING_IMAGE_FIXTURE = {
    scenario: "dropped-text-image-survival",
    rustMode: false,
    autoSearch: false,
    modelContextLimit: 50_000,
} as const;

function exactPrimitiveObservation(
    raw: JsonValue,
    kind: string,
    fields: Record<string, "boolean" | "number" | "string">,
): Record<string, JsonValue> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`${kind} observation must be an object`);
    }
    const keys = Object.keys(raw).sort();
    const expected = Object.keys(fields).sort();
    if (keys.join("\0") !== expected.join("\0")) {
        throw new Error(`${kind} observation fields do not match the contract`);
    }
    for (const [field, type] of Object.entries(fields)) {
        if (typeof raw[field] !== type) {
            throw new Error(`${kind}.${field} must be ${type}`);
        }
    }
    return raw;
}

function numberField(
    observation: Record<string, JsonValue>,
    field: string,
): number {
    const value = observation[field];
    if (typeof value !== "number") throw new Error(`${field} must be number`);
    return value;
}

function stringField(
    observation: Record<string, JsonValue>,
    field: string,
): string {
    const value = observation[field];
    if (typeof value !== "string") throw new Error(`${field} must be string`);
    return value;
}

function booleanField(
    observation: Record<string, JsonValue>,
    field: string,
): boolean {
    const value = observation[field];
    if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
    return value;
}

function normalizeFirstRenderA1(raw: JsonValue): FirstRenderDeferObservation {
    const value = exactPrimitiveObservation(raw, "parity-a1", {
        mainRequestCount: "number",
        bustCount: "number",
        bustReport: "string",
    });
    return {
        mainRequestCount: numberField(value, "mainRequestCount"),
        bustCount: numberField(value, "bustCount"),
        bustReport: stringField(value, "bustReport"),
    };
}

function normalizeFirstRenderA3(raw: JsonValue): AgedCtxReduceObservation {
    const value = exactPrimitiveObservation(raw, "parity-a3", {
        sawReduceOnWire: "boolean",
        bustCount: "number",
        bustReport: "string",
        finalWireHasCtxReduce: "boolean",
    });
    return {
        sawReduceOnWire: booleanField(value, "sawReduceOnWire"),
        bustCount: numberField(value, "bustCount"),
        bustReport: stringField(value, "bustReport"),
        finalWireHasCtxReduce: booleanField(value, "finalWireHasCtxReduce"),
    };
}

function normalizeThinkingNudge(
    raw: JsonValue,
): ThinkingNudgeAnchorObservation {
    const value = exactPrimitiveObservation(raw, "thinking-nudge-anchor", {
        rustMode: "boolean",
        mainRequestCount: "number",
        inspectedSignedAssistants: "number",
        nudgeMarkerFound: "boolean",
        thinkingByteStable: "boolean",
        rustThinkingBlockCount: "number",
    });
    return {
        rustMode: booleanField(value, "rustMode"),
        mainRequestCount: numberField(value, "mainRequestCount"),
        inspectedSignedAssistants: numberField(
            value,
            "inspectedSignedAssistants",
        ),
        nudgeMarkerFound: booleanField(value, "nudgeMarkerFound"),
        thinkingByteStable: booleanField(value, "thinkingByteStable"),
        rustThinkingBlockCount: numberField(value, "rustThinkingBlockCount"),
    };
}

function normalizeThinkingShell(
    raw: JsonValue,
): ThinkingDroppedShellObservation {
    const value = exactPrimitiveObservation(raw, "thinking-dropped-shell", {
        rustMode: "boolean",
        dropEmitted: "boolean",
        pasteBodyAbsent: "boolean",
        shellPreserved: "boolean",
        signedReplayIntact: "boolean",
        turnBoundaryPreserved: "boolean",
    });
    return {
        rustMode: booleanField(value, "rustMode"),
        dropEmitted: booleanField(value, "dropEmitted"),
        pasteBodyAbsent: booleanField(value, "pasteBodyAbsent"),
        shellPreserved: booleanField(value, "shellPreserved"),
        signedReplayIntact: booleanField(value, "signedReplayIntact"),
        turnBoundaryPreserved: booleanField(value, "turnBoundaryPreserved"),
    };
}

function normalizeThinkingImage(
    raw: JsonValue,
): ThinkingImageSurvivalObservation {
    const value = exactPrimitiveObservation(raw, "thinking-image-survival", {
        rustMode: "boolean",
        dropEmitted: "boolean",
        droppedTextAbsent: "boolean",
        coveredByRustHistory: "boolean",
        imageBlockCount: "number",
        placeholderPresent: "boolean",
        userWithImagePresent: "boolean",
    });
    return {
        rustMode: booleanField(value, "rustMode"),
        dropEmitted: booleanField(value, "dropEmitted"),
        droppedTextAbsent: booleanField(value, "droppedTextAbsent"),
        coveredByRustHistory: booleanField(value, "coveredByRustHistory"),
        imageBlockCount: numberField(value, "imageBlockCount"),
        placeholderPresent: booleanField(value, "placeholderPresent"),
        userWithImagePresent: booleanField(value, "userWithImagePresent"),
    };
}

async function withCaseHarness<T extends JsonValue>(
    context: CaseDriverContext,
    options: TestHarnessOptions,
    run: (harness: TestHarness) => Promise<T>,
): Promise<T> {
    const harness = await createCaseHarness(context, options);
    try {
        return await run(harness);
    } finally {
        await harness.dispose();
    }
}

function rustPrerequisite(): { ok: true } | { ok: false; reason: string } {
    const result = detectRustPrerequisites();
    return result.ok
        ? { ok: true }
        : { ok: false, reason: result.missing.join("; ") };
}

function satisfiedPrecondition(): PreconditionOutcome {
    return { satisfied: true };
}

export function sourceLinkedRegressionIncidentCases(): RegisteredIncidentCase[] {
    return [
        {
            variantId: "var-parity-a1-pure-defer-stability",
            implementationFiles: SOURCE_LINKED_IMPLEMENTATION_FILES,
            fixtures: { ...FIRST_RENDER_A1_FIXTURE },
            driver: (context) =>
                withCaseHarness(context, FIRST_RENDER_HARNESS_OPTIONS, (h) =>
                    driveFirstRenderPureDeferStability(h),
                ),
            normalizer: normalizeFirstRenderA1,
            precondition: satisfiedPrecondition,
            verifier: (raw) =>
                verifyFirstRenderPureDeferStability(normalizeFirstRenderA1(raw))
                    .checks,
            binding: {
                driver: driveFirstRenderPureDeferStability,
                verifier: verifyFirstRenderPureDeferStability,
            },
            prerequisite: rustPrerequisite,
        },
        {
            variantId: "var-parity-a3-ctx-reduce-survival",
            implementationFiles: SOURCE_LINKED_IMPLEMENTATION_FILES,
            fixtures: { ...FIRST_RENDER_A3_FIXTURE },
            driver: (context) =>
                withCaseHarness(context, FIRST_RENDER_HARNESS_OPTIONS, (h) =>
                    driveAgedCtxReduceSurvival(h),
                ),
            normalizer: normalizeFirstRenderA3,
            precondition: satisfiedPrecondition,
            verifier: (raw) =>
                verifyAgedCtxReduceSurvival(normalizeFirstRenderA3(raw)).checks,
            binding: {
                driver: driveAgedCtxReduceSurvival,
                verifier: verifyAgedCtxReduceSurvival,
            },
            prerequisite: rustPrerequisite,
        },
        {
            variantId: "var-thinking-nudge-anchor",
            implementationFiles: SOURCE_LINKED_IMPLEMENTATION_FILES,
            fixtures: { ...THINKING_NUDGE_FIXTURE },
            driver: (context) =>
                withCaseHarness(context, THINKING_BLOCK_HARNESS_OPTIONS, (h) =>
                    driveThinkingNudgeAnchor(h, { rustMode: false }),
                ),
            normalizer: normalizeThinkingNudge,
            precondition: satisfiedPrecondition,
            verifier: (raw) =>
                verifyThinkingNudgeAnchor(normalizeThinkingNudge(raw)).checks,
            binding: {
                driver: driveThinkingNudgeAnchor,
                verifier: verifyThinkingNudgeAnchor,
            },
        },
        {
            variantId: "var-thinking-dropped-shell",
            implementationFiles: SOURCE_LINKED_IMPLEMENTATION_FILES,
            fixtures: { ...THINKING_DROPPED_SHELL_FIXTURE },
            driver: (context) =>
                withCaseHarness(context, THINKING_BLOCK_HARNESS_OPTIONS, (h) =>
                    driveThinkingDroppedShell(h, { rustMode: false }),
                ),
            normalizer: normalizeThinkingShell,
            precondition: satisfiedPrecondition,
            verifier: (raw) =>
                verifyThinkingDroppedShell(normalizeThinkingShell(raw)).checks,
            binding: {
                driver: driveThinkingDroppedShell,
                verifier: verifyThinkingDroppedShell,
            },
        },
        {
            variantId: "var-thinking-image-survival",
            implementationFiles: SOURCE_LINKED_IMPLEMENTATION_FILES,
            fixtures: { ...THINKING_IMAGE_FIXTURE },
            driver: (context) =>
                withCaseHarness(context, THINKING_BLOCK_HARNESS_OPTIONS, (h) =>
                    driveThinkingImageSurvival(h, { rustMode: false }),
                ),
            normalizer: normalizeThinkingImage,
            precondition: satisfiedPrecondition,
            verifier: (raw) =>
                verifyThinkingImageSurvival(normalizeThinkingImage(raw)).checks,
            binding: {
                driver: driveThinkingImageSurvival,
                verifier: verifyThinkingImageSurvival,
            },
        },
    ];
}
