import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { computeSyntheticCallId } from "../../../../plugin/src/hooks/magic-context/todo-view";
import { detectRustPrerequisites } from "../../../scripts/check-rust-prerequisites";
import type { TestHarness } from "../../harness";
import type { MockProvider, MockUsage } from "../../mock-provider/server";
import { RustTestHarness } from "../../rust-harness";
import { openTestDb } from "../../test-db";
import type {
    CaseDriverContext,
    JsonValue,
    NormalizedObservation,
    PreconditionOutcome,
    RegisteredIncidentCase,
    VerifierCheck,
} from "../registry";

export type Todo = {
    content: string;
    status: string;
    priority?: string;
};

export type TodoMeta = {
    last_todo_state: string | null;
    todo_synthetic_call_id: string | null;
    todo_synthetic_anchor_message_id: string | null;
    todo_synthetic_state_json: string | null;
    is_subagent: number | null;
};

type WireMessage = { role?: string; content?: unknown };
type RequestBody = Record<string, unknown>;

export const TODO_MODEL_CONTEXT_LIMIT = 64_000;
const TODO_EXECUTE_THRESHOLD_PERCENTAGE = 20;
const TODO_PRESSURE_TOKENS = 45_000;
const TODO_PRESSURE_PERCENTAGE = 65;

export const STATE_X_TODOS: Todo[] = [
    { content: "Build feature", status: "in_progress", priority: "high" },
    { content: "Write tests", status: "pending", priority: "medium" },
];

export const STATE_Y_TODOS: Todo[] = [
    { content: "Review cache safety", status: "in_progress", priority: "high" },
    { content: "Ship regression", status: "pending", priority: "low" },
];

export const MISSING_PRIORITY_TODOS: Todo[] = [
    { content: "Capture todo without priority", status: "in_progress" },
    { content: "Replay default priority", status: "pending" },
];

export const TERMINAL_TODOS: Todo[] = [
    { content: "Build feature", status: "completed", priority: "high" },
    { content: "Write tests", status: "cancelled", priority: "medium" },
];

const LOW_USAGE: MockUsage = {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 100,
};

export type TodoParityMatrixRow = {
    interface: "opencode-ts" | "opencode-rust" | "pi-ts";
    toolAvailability: "todowrite";
    schema: "todos-content-status-priority";
    actionSequence: readonly string[];
    providerResult: "synthetic-tool-pair";
    durableTransition: "captured-frozen-replayed-cleared";
    mode: "ts" | "rust";
    harness: "opencode" | "rust" | "pi";
    prerequisites: readonly string[];
    normalizer: "anthropic-tool-use-result";
};

export const TODO_PRESSURE_FIXTURE = {
    source: "full-provider-message-bytes",
    modelContextLimit: TODO_MODEL_CONTEXT_LIMIT,
    percentage: TODO_PRESSURE_PERCENTAGE,
} as const;

export const TODO_PARITY_MATRIX: readonly TodoParityMatrixRow[] = [
    {
        interface: "opencode-ts",
        toolAvailability: "todowrite",
        schema: "todos-content-status-priority",
        actionSequence: ["capture", "pressure", "bust", "defer", "terminal"],
        providerResult: "synthetic-tool-pair",
        durableTransition: "captured-frozen-replayed-cleared",
        mode: "ts",
        harness: "opencode",
        prerequisites: ["bun", "opencode"],
        normalizer: "anthropic-tool-use-result",
    },
    {
        interface: "opencode-rust",
        toolAvailability: "todowrite",
        schema: "todos-content-status-priority",
        actionSequence: ["capture", "pressure", "bust", "defer", "terminal"],
        providerResult: "synthetic-tool-pair",
        durableTransition: "captured-frozen-replayed-cleared",
        mode: "rust",
        harness: "rust",
        prerequisites: ["cargo", "ck-mc", "commons", "subconscious"],
        normalizer: "anthropic-tool-use-result",
    },
    {
        interface: "pi-ts",
        toolAvailability: "todowrite",
        schema: "todos-content-status-priority",
        actionSequence: ["capture", "pressure", "bust", "defer", "terminal"],
        providerResult: "synthetic-tool-pair",
        durableTransition: "captured-frozen-replayed-cleared",
        mode: "ts",
        harness: "pi",
        prerequisites: ["bun", "pi"],
        normalizer: "anthropic-tool-use-result",
    },
] as const;

export type TodoParitySetup = {
    promptMatched: boolean;
    toolRegistryMatched: boolean;
    environmentMatched: boolean;
    clonedStateMatched: boolean;
    modeMatched: boolean;
    harnessMatched: boolean;
    prerequisitesMet: boolean;
};

export type TodoScriptAdapter = {
    mock: MockProvider;
    ballast(tokens: number): string;
    sendPrompt(text: string): Promise<void>;
    mainRequests(): Array<{ body: RequestBody }>;
    waitForPressure?(): Promise<boolean>;
};

export type TodoExecutionProbe = {
    executed: boolean;
    toolName: string | null;
};

export type SyntheticPair = {
    index: number;
    callId: string;
    bytes: string;
};

export function normalizedTodoJson(todos: Todo[]): string {
    return JSON.stringify(
        todos.map(({ content, status, priority }) => ({
            content,
            status,
            priority: priority ?? "medium",
        })),
    );
}

export function isMagicContextRequest(body: RequestBody): boolean {
    return JSON.stringify(body.system ?? "").includes("## Magic Context");
}

export function findTodoToolName(body: RequestBody): string | null {
    const tools = body.tools;
    if (!Array.isArray(tools)) return null;
    for (const tool of tools) {
        if (!tool || typeof tool !== "object") continue;
        const name = (tool as { name?: unknown }).name;
        if (
            typeof name === "string" &&
            /todo.*write|write.*todo|todowrite/i.test(name)
        ) {
            return name;
        }
    }
    return null;
}

function contentBlocks(content: unknown): unknown[] {
    if (Array.isArray(content)) return content;
    return typeof content === "string" ? [{ type: "text", text: content }] : [];
}

function findToolUseId(
    message: WireMessage,
    expectedCallId?: string,
): string | null {
    return findToolUseIds(message, expectedCallId)[0] ?? null;
}

/**
 * Every todowrite tool-use id in one assistant message.
 *
 * Returning only the first id makes a second pair inside the SAME assistant
 * message invisible, which is one of the two ways a premature newer state hides
 * beside a frozen pair (the other is a second assistant/user shell).
 */
function findToolUseIds(
    message: WireMessage,
    expectedCallId?: string,
): string[] {
    if (message.role !== "assistant") return [];
    const ids: string[] = [];
    for (const block of contentBlocks(message.content)) {
        if (!block || typeof block !== "object") continue;
        const value = block as {
            type?: unknown;
            id?: unknown;
            name?: unknown;
        };
        if (value.type !== "tool_use") continue;
        if (
            typeof value.name !== "string" ||
            !/todo.*write|write.*todo|todowrite/i.test(value.name)
        ) {
            continue;
        }
        if (typeof value.id !== "string") continue;
        if (expectedCallId && value.id !== expectedCallId) continue;
        ids.push(value.id);
    }
    return ids;
}

function findToolResultBlock(
    message: WireMessage,
    callId: string,
): unknown | null {
    if (message.role !== "user") return null;
    for (const block of contentBlocks(message.content)) {
        if (!block || typeof block !== "object") continue;
        const value = block as { type?: unknown; tool_use_id?: unknown };
        if (value.type === "tool_result" && value.tool_use_id === callId) {
            return block;
        }
    }
    return null;
}

/** Deterministic prefix carried by every injected synthetic call id. */
export const SYNTHETIC_TODO_CALL_ID_PREFIX = "mc_synthetic_todo_";

/**
 * Every pair on the wire whose tool name is todowrite, in message order.
 *
 * A check that only looks for one expected call id cannot see an ADDITIONAL
 * pair beside it, which is how a premature newer state leaks onto a defer turn
 * while the expected frozen bytes stay intact. All matching ids within an
 * assistant message are enumerated, not just the first, so a second pair sharing
 * one assistant/user shell is counted too.
 *
 * This matches on tool NAME, so a real executed todowrite pair replayed in
 * history also qualifies. Callers that need injected pairs only must filter on
 * `SYNTHETIC_TODO_CALL_ID_PREFIX` — see `injectedTodoPairs`.
 */
export function findSyntheticPairs(
    body: RequestBody,
    expectedCallId?: string,
): SyntheticPair[] {
    const messages = body.messages;
    if (!Array.isArray(messages)) return [];
    const pairs: SyntheticPair[] = [];
    for (let index = 0; index < messages.length - 1; index += 1) {
        const assistant = messages[index] as WireMessage;
        const user = messages[index + 1] as WireMessage;
        for (const callId of findToolUseIds(assistant, expectedCallId)) {
            const toolResult = findToolResultBlock(user, callId);
            if (!toolResult) continue;
            const toolUse = contentBlocks(assistant.content).find((block) => {
                if (!block || typeof block !== "object") return false;
                const value = block as { type?: unknown; id?: unknown };
                return value.type === "tool_use" && value.id === callId;
            });
            pairs.push({
                index,
                callId,
                bytes: JSON.stringify([toolUse, toolResult]),
            });
        }
    }
    return pairs;
}

/**
 * The pairs an injector produced, identified by the deterministic call-id
 * prefix rather than by tool name, so a real executed todowrite pair replayed in
 * history is never counted as an injected one.
 */
export function injectedTodoPairs(body: RequestBody): SyntheticPair[] {
    return findSyntheticPairs(body).filter((pair) =>
        pair.callId.startsWith(SYNTHETIC_TODO_CALL_ID_PREFIX),
    );
}

export function findSyntheticPair(
    body: RequestBody,
    expectedCallId?: string,
): SyntheticPair | null {
    return findSyntheticPairs(body, expectedCallId)[0] ?? null;
}

export function syntheticPairBytes(
    body: RequestBody,
    callId: string,
): string | null {
    return findSyntheticPair(body, callId)?.bytes ?? null;
}

/** The `todos` array carried by a pair's tool-use input. */
export function pairTodoInput(pair: SyntheticPair | null): unknown {
    if (pair === null) return null;
    const parsed = JSON.parse(pair.bytes) as unknown;
    if (!Array.isArray(parsed)) return null;
    const toolUse = parsed[0] as { input?: { todos?: unknown } } | undefined;
    return toolUse?.input?.todos ?? null;
}

/**
 * Do the wire todos carry exactly the expected items, with priorities already
 * defaulted? Compared field by field on purpose: running the wire side through
 * `normalizedTodoJson` would default a MISSING priority to `medium` and mask the
 * very omission this is meant to catch.
 */
export function wireTodosMatch(
    wire: unknown,
    expected: readonly Todo[],
): boolean {
    if (!Array.isArray(wire) || wire.length !== expected.length) return false;
    return expected.every((todo, index) => {
        const actual = wire[index];
        if (!actual || typeof actual !== "object") return false;
        const value = actual as Record<string, unknown>;
        return (
            value.content === todo.content &&
            value.status === todo.status &&
            value.priority === (todo.priority ?? "medium")
        );
    });
}

export function emitTodoOnce(
    adapter: TodoScriptAdapter,
    todos: Todo[],
    usage: MockUsage = LOW_USAGE,
): TodoExecutionProbe {
    const probe: TodoExecutionProbe = { executed: false, toolName: null };
    adapter.mock.addMatcher((body) => {
        if (probe.executed || !isMagicContextRequest(body)) return null;
        const toolName = findTodoToolName(body);
        if (!toolName) return null;
        probe.executed = true;
        probe.toolName = toolName;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_todo_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name: toolName,
                    input: { todos },
                },
            ],
            stop_reason: "tool_use",
            usage,
        };
    });
    return probe;
}

function usageForWireBytes(bytes: number): MockUsage {
    const estimatedTokens = Math.max(100, Math.ceil(bytes / 4));
    return {
        input_tokens: estimatedTokens,
        output_tokens: 20,
        cache_creation_input_tokens: estimatedTokens,
        cache_read_input_tokens: 0,
    };
}

export async function captureTodoState(
    adapter: TodoScriptAdapter,
    todos: Todo[],
    label = "capture todo state",
): Promise<TodoExecutionProbe> {
    adapter.mock.reset();
    const probe = emitTodoOnce(adapter, todos);
    adapter.mock.setDefault({ text: "after todo", usage: LOW_USAGE });
    await adapter.sendPrompt(
        `${label}: ${todos.map((todo) => todo.content).join(", ")}`,
    );
    return probe;
}

export async function primeNextTurnAsCacheBust(
    adapter: TodoScriptAdapter,
): Promise<boolean> {
    const requiredBytes =
        TODO_MODEL_CONTEXT_LIMIT * 4 * (TODO_PRESSURE_PERCENTAGE / 100);
    const priorBody = adapter.mainRequests().at(-1)?.body;
    const priorBytes = priorBody
        ? Buffer.byteLength(JSON.stringify(priorBody.messages ?? []), "utf8")
        : 0;
    const pressurePrompt =
        priorBytes >= requiredBytes
            ? "pressure turn using retained real message bytes"
            : `pressure turn: ${adapter.ballast(TODO_PRESSURE_TOKENS)}`;
    adapter.mock.reset();
    let emitted = false;
    adapter.mock.addMatcher((body) => {
        if (emitted || !isMagicContextRequest(body)) return null;
        emitted = true;
        const bytes = Buffer.byteLength(
            JSON.stringify(body.messages ?? []),
            "utf8",
        );
        return { text: "pressure", usage: usageForWireBytes(bytes) };
    });
    adapter.mock.setDefault({ text: "pressure", usage: LOW_USAGE });
    await adapter.sendPrompt(pressurePrompt);
    const body = adapter.mainRequests().at(-1)?.body;
    const wireBytes = body
        ? Buffer.byteLength(JSON.stringify(body.messages ?? []), "utf8")
        : 0;
    const pressureRecorded = adapter.waitForPressure
        ? await adapter.waitForPressure()
        : true;
    return pressureRecorded && wireBytes >= requiredBytes;
}

export async function sendAndCaptureMainRequest(
    adapter: TodoScriptAdapter,
    prompt: string,
): Promise<RequestBody | null> {
    adapter.mock.reset();
    adapter.mock.setDefault({ text: "ok", usage: LOW_USAGE });
    await adapter.sendPrompt(prompt);
    return adapter.mainRequests()[0]?.body ?? null;
}

function check(id: string, passed: boolean): VerifierCheck {
    return { id, passed };
}

function unmet(): PreconditionOutcome {
    return { satisfied: false, reason: "precondition_unmet", blockedBy: [] };
}

function blockedByTodo1(): PreconditionOutcome {
    return {
        satisfied: false,
        reason: "blocked_by_dependency",
        blockedBy: ["var-todo-1-synthetic-injection"],
    };
}

function setupSatisfied(setup: TodoParitySetup): boolean {
    return Object.values(setup).every(Boolean);
}

function exactBooleanObservation<T>(
    raw: unknown,
    kind: string,
    fields: readonly string[],
): T {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`${kind} observation must be an object`);
    }
    const record = raw as Record<string, unknown>;
    const expected = ["kind", ...fields].sort();
    const actual = Object.keys(record).sort();
    if (
        record.kind !== kind ||
        expected.length !== actual.length ||
        expected.some((key, index) => key !== actual[index])
    ) {
        throw new Error(
            `${kind} observation must contain exactly ${expected.join(", ")}`,
        );
    }
    for (const field of fields) {
        if (typeof record[field] !== "boolean") {
            throw new Error(
                `${kind} observation field ${field} must be boolean`,
            );
        }
    }
    return raw as T;
}

const SETUP_FIELDS = [
    "promptMatched",
    "toolRegistryMatched",
    "environmentMatched",
    "clonedStateMatched",
    "modeMatched",
    "harnessMatched",
    "prerequisitesMet",
] as const;

function setupFromObservation(
    observation: Record<(typeof SETUP_FIELDS)[number], boolean>,
): TodoParitySetup {
    return {
        promptMatched: observation.promptMatched,
        toolRegistryMatched: observation.toolRegistryMatched,
        environmentMatched: observation.environmentMatched,
        clonedStateMatched: observation.clonedStateMatched,
        modeMatched: observation.modeMatched,
        harnessMatched: observation.harnessMatched,
        prerequisitesMet: observation.prerequisitesMet,
    };
}

export type Todo1Observation = TodoParitySetup & {
    kind: "rust-todo-1-synthetic-injection";
    todoWriteExecuted: boolean;
    schemaAccepted: boolean;
    pressureUsedRealBytes: boolean;
    providerRequestCaptured: boolean;
    moduleTodoStateCaptured: boolean;
    providerSyntheticPairPresent: boolean;
    deterministicCallIdMatched: boolean;
};

const TODO1_FIELDS = [
    ...SETUP_FIELDS,
    "todoWriteExecuted",
    "schemaAccepted",
    "pressureUsedRealBytes",
    "providerRequestCaptured",
    "moduleTodoStateCaptured",
    "providerSyntheticPairPresent",
    "deterministicCallIdMatched",
] as const;

export function normalizeTodoSyntheticInjection(
    raw: JsonValue,
): Todo1Observation {
    return exactBooleanObservation<Todo1Observation>(
        raw,
        "rust-todo-1-synthetic-injection",
        TODO1_FIELDS,
    );
}

export function preconditionTodoSyntheticInjection(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const value = observation as Todo1Observation;
    return setupSatisfied(setupFromObservation(value)) &&
        value.todoWriteExecuted &&
        value.schemaAccepted &&
        value.pressureUsedRealBytes &&
        value.providerRequestCaptured &&
        value.moduleTodoStateCaptured
        ? { satisfied: true }
        : unmet();
}

export function verifyTodoSyntheticInjection(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const value = observation as Todo1Observation;
    return [
        check("check-todo1-todo-state-captured", value.moduleTodoStateCaptured),
        check(
            "check-todo1-synthetic-pair-present",
            value.providerSyntheticPairPresent &&
                value.deterministicCallIdMatched,
        ),
    ];
}

export type DependentTodoObservation = TodoParitySetup & {
    kind:
        | "rust-todo-2-defer-replay"
        | "rust-todo-3-newer-todo-deferral"
        | "rust-todo-4-legacy-anchor-heal"
        | "rust-todo-5-terminal-clear";
    rootTodoWriteExecuted: boolean;
    rootModuleStateCaptured: boolean;
    rootSyntheticPairPresent: boolean;
    ownActionExecuted: boolean;
    providerTransitionCorrect: boolean;
    durableTransitionCorrect: boolean;
};

const DEPENDENT_FIELDS = [
    ...SETUP_FIELDS,
    "rootTodoWriteExecuted",
    "rootModuleStateCaptured",
    "rootSyntheticPairPresent",
    "ownActionExecuted",
    "providerTransitionCorrect",
    "durableTransitionCorrect",
] as const;

function normalizeDependentTodo(
    raw: JsonValue,
    kind: DependentTodoObservation["kind"],
): DependentTodoObservation {
    return exactBooleanObservation<DependentTodoObservation>(
        raw,
        kind,
        DEPENDENT_FIELDS,
    );
}

function preconditionDependentTodo(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const value = observation as DependentTodoObservation;
    // A missing toolchain is a prerequisite gap, not a blocked dependency
    // on the root injection variant. Registration-level
    // `prerequisite: rustPrerequisite` publishes `unavailable` before the
    // driver runs, so this branch is defense in depth for an observation
    // produced without the toolchain.
    if (!value.prerequisitesMet) {
        return unmet();
    }
    if (!value.rootSyntheticPairPresent) {
        return blockedByTodo1();
    }
    if (
        !setupSatisfied(setupFromObservation(value)) ||
        !value.rootTodoWriteExecuted ||
        !value.rootModuleStateCaptured ||
        !value.ownActionExecuted
    ) {
        return unmet();
    }
    return { satisfied: true };
}

function verifyDependentTodo(
    observation: NormalizedObservation,
    checkId: string,
): VerifierCheck[] {
    const value = observation as DependentTodoObservation;
    return [
        check(
            checkId,
            value.providerTransitionCorrect && value.durableTransitionCorrect,
        ),
    ];
}

export function normalizeTodoDeferReplay(
    raw: JsonValue,
): DependentTodoObservation {
    return normalizeDependentTodo(raw, "rust-todo-2-defer-replay");
}

export function normalizeTodoNewerDeferral(
    raw: JsonValue,
): DependentTodoObservation {
    return normalizeDependentTodo(raw, "rust-todo-3-newer-todo-deferral");
}

export function normalizeTodoLegacyAnchorHeal(
    raw: JsonValue,
): DependentTodoObservation {
    return normalizeDependentTodo(raw, "rust-todo-4-legacy-anchor-heal");
}

export function normalizeTodoTerminalClear(
    raw: JsonValue,
): DependentTodoObservation {
    return normalizeDependentTodo(raw, "rust-todo-5-terminal-clear");
}

export const preconditionTodoDeferReplay = preconditionDependentTodo;
export const preconditionTodoNewerDeferral = preconditionDependentTodo;
export const preconditionTodoLegacyAnchorHeal = preconditionDependentTodo;
export const preconditionTodoTerminalClear = preconditionDependentTodo;

export function verifyTodoDeferReplay(
    observation: NormalizedObservation,
): VerifierCheck[] {
    return verifyDependentTodo(
        observation,
        "check-todo2-byte-identical-replay",
    );
}

export function verifyTodoNewerDeferral(
    observation: NormalizedObservation,
): VerifierCheck[] {
    return verifyDependentTodo(observation, "check-todo3-newer-todo-deferred");
}

export function verifyTodoLegacyAnchorHeal(
    observation: NormalizedObservation,
): VerifierCheck[] {
    return verifyDependentTodo(
        observation,
        "check-todo4-legacy-anchor-self-heal",
    );
}

export function verifyTodoTerminalClear(
    observation: NormalizedObservation,
): VerifierCheck[] {
    return verifyDependentTodo(
        observation,
        "check-todo5-terminal-state-clears-anchor",
    );
}

function opencodeAdapter(h: TestHarness, sessionId: string): TodoScriptAdapter {
    return {
        mock: h.mock,
        ballast: (tokens) => h.ballast(tokens),
        sendPrompt: async (text) => {
            await h.sendPrompt(sessionId, text);
        },
        mainRequests: () =>
            h.mock
                .requests()
                .filter((request) => isMagicContextRequest(request.body)),
        waitForPressure: () =>
            h
                .waitFor(
                    () => {
                        const row = h
                            .contextDb()
                            .prepare(
                                "SELECT last_context_percentage FROM session_meta WHERE session_id = ?",
                            )
                            .get(sessionId) as {
                            last_context_percentage: number;
                        } | null;
                        return (
                            (row?.last_context_percentage ?? 0) >=
                            TODO_PRESSURE_PERCENTAGE
                        );
                    },
                    {
                        timeoutMs: 60_000,
                        label: "todo real-byte pressure recorded",
                    },
                )
                .then(
                    () => true,
                    () => false,
                ),
    };
}

function readOpenCodeTodoMeta(
    h: TestHarness,
    sessionId: string,
): TodoMeta | null {
    return h
        .contextDb()
        .prepare(
            `SELECT last_todo_state, todo_synthetic_call_id, todo_synthetic_anchor_message_id,
                    todo_synthetic_state_json, is_subagent
               FROM session_meta
              WHERE session_id = ?`,
        )
        .get(sessionId) as TodoMeta | null;
}

async function waitForOpenCodeTodoState(
    h: TestHarness,
    sessionId: string,
    stateJson: string,
): Promise<void> {
    await h.waitFor(
        () => readOpenCodeTodoMeta(h, sessionId)?.last_todo_state === stateJson,
        { timeoutMs: 60_000, label: "last_todo_state captured" },
    );
}

async function prepareOpenCodeCacheBust(
    h: TestHarness,
    sessionId: string,
    todos: Todo[] = STATE_X_TODOS,
): Promise<{
    stateJson: string;
    callId: string;
    body: RequestBody | null;
    pressureUsedRealBytes: boolean;
}> {
    const adapter = opencodeAdapter(h, sessionId);
    const stateJson = normalizedTodoJson(todos);
    await captureTodoState(adapter, todos);
    await waitForOpenCodeTodoState(h, sessionId, stateJson);
    const pressureUsedRealBytes = await primeNextTurnAsCacheBust(adapter);
    const body = await sendAndCaptureMainRequest(adapter, "cache-bust turn");
    return {
        stateJson,
        callId: computeSyntheticCallId(stateJson),
        body,
        pressureUsedRealBytes,
    };
}

function updateOpenCodeTodoMeta(
    h: TestHarness,
    sessionId: string,
    sql: string,
): void {
    const path = join(
        h.opencode.env.dataDir,
        "cortexkit",
        "magic-context",
        "context.db",
    );
    const db = openTestDb(path);
    try {
        db.prepare(sql).run(sessionId);
    } finally {
        db.close();
    }
}

export type OpenCodeTodoScenario =
    | "capture"
    | "injection"
    | "replay"
    | "newer-deferral"
    | "legacy-heal"
    | "subagent-gate"
    | "terminal-clear";

export async function runOpenCodeTodoScenario(
    h: TestHarness,
    scenario: OpenCodeTodoScenario,
): Promise<string[]> {
    if (scenario === "capture") {
        const sessionId = await h.createSession();
        const stateJson = normalizedTodoJson(STATE_X_TODOS);
        const probe = await captureTodoState(
            opencodeAdapter(h, sessionId),
            STATE_X_TODOS,
        );
        await waitForOpenCodeTodoState(h, sessionId, stateJson);
        return [
            probe.executed ? null : "todowrite-executed",
            readOpenCodeTodoMeta(h, sessionId)?.last_todo_state === stateJson
                ? null
                : "last-todo-state",
        ].filter((id): id is string => id !== null);
    }

    if (scenario === "subagent-gate") {
        const parentId = await h.createSession();
        const childId = await h.createChildSession(
            parentId,
            "todo-synthesis-child",
        );
        await h.waitFor(() => h.isSubagent(childId), {
            timeoutMs: 60_000,
            label: "child is_subagent=true",
        });
        const probe = await captureTodoState(
            opencodeAdapter(h, childId),
            STATE_X_TODOS,
            "child writes todos",
        );
        const meta = readOpenCodeTodoMeta(h, childId);
        return [
            probe.executed ? null : "todowrite-executed",
            meta?.is_subagent === 1 ? null : "subagent-flag",
            (meta?.last_todo_state ?? "") === "" ? null : "subagent-last-state",
            (meta?.todo_synthetic_call_id ?? "") === ""
                ? null
                : "subagent-call-id",
            (meta?.todo_synthetic_anchor_message_id ?? "") === ""
                ? null
                : "subagent-anchor",
            (meta?.todo_synthetic_state_json ?? "") === ""
                ? null
                : "subagent-state-json",
        ].filter((id): id is string => id !== null);
    }

    const sessionId = await h.createSession();
    const prepared = await prepareOpenCodeCacheBust(h, sessionId);
    const pair = prepared.body
        ? findSyntheticPair(prepared.body, prepared.callId)
        : null;
    const preparedMeta = readOpenCodeTodoMeta(h, sessionId);

    if (scenario === "injection") {
        return [
            prepared.pressureUsedRealBytes ? null : "real-byte-pressure",
            pair?.callId === prepared.callId ? null : "synthetic-call-id",
            prepared.callId === computeSyntheticCallId(prepared.stateJson)
                ? null
                : "deterministic-call-id",
            preparedMeta?.todo_synthetic_call_id === prepared.callId
                ? null
                : "persisted-call-id",
            (preparedMeta?.todo_synthetic_anchor_message_id ?? "")
                ? null
                : "persisted-anchor",
            preparedMeta?.todo_synthetic_state_json === prepared.stateJson
                ? null
                : "persisted-state-json",
            preparedMeta?.last_todo_state === prepared.stateJson
                ? null
                : "last-todo-state",
        ].filter((id): id is string => id !== null);
    }

    if (!pair) return ["initial-synthetic-pair"];

    if (scenario === "replay") {
        const adapter = opencodeAdapter(h, sessionId);
        const t0 = await sendAndCaptureMainRequest(adapter, "defer replay t0");
        const metaT0 = readOpenCodeTodoMeta(h, sessionId);
        const t1 = await sendAndCaptureMainRequest(adapter, "defer replay t1");
        const metaT1 = readOpenCodeTodoMeta(h, sessionId);
        const t0Bytes = t0 ? syntheticPairBytes(t0, prepared.callId) : null;
        const t1Bytes = t1 ? syntheticPairBytes(t1, prepared.callId) : null;
        return [
            t0Bytes === null ? "replay-t0-present" : null,
            t1Bytes === t0Bytes ? null : "replay-byte-identity",
            metaT1?.todo_synthetic_call_id === metaT0?.todo_synthetic_call_id
                ? null
                : "replay-call-id",
            metaT1?.todo_synthetic_anchor_message_id ===
            metaT0?.todo_synthetic_anchor_message_id
                ? null
                : "replay-anchor",
            metaT1?.todo_synthetic_state_json ===
            metaT0?.todo_synthetic_state_json
                ? null
                : "replay-state-json",
        ].filter((id): id is string => id !== null);
    }

    if (scenario === "newer-deferral") {
        const adapter = opencodeAdapter(h, sessionId);
        const baselineBody = await sendAndCaptureMainRequest(
            adapter,
            "baseline defer",
        );
        const baselineBytes = baselineBody
            ? syntheticPairBytes(baselineBody, prepared.callId)
            : null;
        await captureTodoState(adapter, STATE_Y_TODOS, "write changed todos");
        await waitForOpenCodeTodoState(
            h,
            sessionId,
            normalizedTodoJson(STATE_Y_TODOS),
        );
        const deferBody = await sendAndCaptureMainRequest(
            adapter,
            "defer after changed todos",
        );
        const deferBytes = deferBody
            ? syntheticPairBytes(deferBody, prepared.callId)
            : null;
        const meta = readOpenCodeTodoMeta(h, sessionId);
        return [
            baselineBytes === null ? "baseline-pair" : null,
            deferBytes === baselineBytes ? null : "newer-todo-deferred",
            meta?.todo_synthetic_call_id === prepared.callId
                ? null
                : "frozen-call-id",
            meta?.todo_synthetic_state_json ===
            normalizedTodoJson(STATE_X_TODOS)
                ? null
                : "frozen-state",
            meta?.last_todo_state === normalizedTodoJson(STATE_Y_TODOS)
                ? null
                : "newer-state-captured",
        ].filter((id): id is string => id !== null);
    }

    if (scenario === "legacy-heal") {
        updateOpenCodeTodoMeta(
            h,
            sessionId,
            "UPDATE session_meta SET todo_synthetic_state_json = '' WHERE session_id = ?",
        );
        const before = readOpenCodeTodoMeta(h, sessionId);
        const adapter = opencodeAdapter(h, sessionId);
        const pressureUsedRealBytes = await primeNextTurnAsCacheBust(adapter);
        const bust = await sendAndCaptureMainRequest(
            adapter,
            "legacy self-heal cache bust",
        );
        const bustBytes = bust
            ? syntheticPairBytes(bust, prepared.callId)
            : null;
        const after = readOpenCodeTodoMeta(h, sessionId);
        const defer = await sendAndCaptureMainRequest(
            adapter,
            "legacy self-heal defer",
        );
        const deferBytes = defer
            ? syntheticPairBytes(defer, prepared.callId)
            : null;
        return [
            before?.todo_synthetic_state_json === "" ? null : "legacy-seed",
            pressureUsedRealBytes ? null : "real-byte-pressure",
            bustBytes === null ? "legacy-bust-pair" : null,
            after?.todo_synthetic_state_json ===
            normalizedTodoJson(STATE_X_TODOS)
                ? null
                : "legacy-state-healed",
            deferBytes === bustBytes ? null : "legacy-replay",
        ].filter((id): id is string => id !== null);
    }

    const adapter = opencodeAdapter(h, sessionId);
    await captureTodoState(adapter, TERMINAL_TODOS, "write terminal todos");
    await waitForOpenCodeTodoState(
        h,
        sessionId,
        normalizedTodoJson(TERMINAL_TODOS),
    );
    const pressureUsedRealBytes = await primeNextTurnAsCacheBust(adapter);
    const body = await sendAndCaptureMainRequest(
        adapter,
        "terminal cache-bust turn",
    );
    const meta = readOpenCodeTodoMeta(h, sessionId);
    return [
        pressureUsedRealBytes ? null : "real-byte-pressure",
        // Any synthetic pair, not just the prior call id: a terminal state must
        // clear the anchor outright, so a REBUILT pair under a fresh call id is
        // the same defect and must not read as a clean clear.
        body && findSyntheticPair(body)
            ? "terminal-pair-still-present"
            : null,
        meta?.last_todo_state === normalizedTodoJson(TERMINAL_TODOS)
            ? null
            : "terminal-state",
        (meta?.todo_synthetic_call_id ?? "") === "" ? null : "terminal-call-id",
        (meta?.todo_synthetic_anchor_message_id ?? "") === ""
            ? null
            : "terminal-anchor",
        (meta?.todo_synthetic_state_json ?? "") === ""
            ? null
            : "terminal-state-json",
    ].filter((id): id is string => id !== null);
}

async function withCaseTmp<T>(
    context: CaseDriverContext,
    create: () => Promise<T>,
): Promise<T> {
    const harnessTmp = join(context.workspaceRoot, "todo-harness");
    mkdirSync(harnessTmp, { recursive: true });
    const saved = {
        TMPDIR: process.env.TMPDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
    };
    process.env.TMPDIR = harnessTmp;
    process.env.TMP = harnessTmp;
    process.env.TEMP = harnessTmp;
    try {
        return await create();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function pathInside(root: string, path: string): boolean {
    try {
        const canonicalRoot = realpathSync(root);
        const canonicalPath = realpathSync(path);
        return (
            canonicalPath === canonicalRoot ||
            canonicalPath.startsWith(`${canonicalRoot}/`)
        );
    } catch {
        return false;
    }
}

function rustAdapter(h: RustTestHarness, sessionId: string): TodoScriptAdapter {
    return {
        mock: h.mock,
        ballast: (tokens) => h.ballast(tokens),
        sendPrompt: async (text) => {
            await h.sendPrompt(sessionId, text);
        },
        mainRequests: () => h.mainRequests(),
        waitForPressure: () =>
            h
                .waitFor(
                    () => {
                        const state = h.readModuleTodoState(sessionId);
                        if (!state || state.contextLimitTokens <= 0)
                            return false;
                        return (
                            (state.currentTotalInputTokens /
                                state.contextLimitTokens) *
                                100 >=
                            TODO_PRESSURE_PERCENTAGE
                        );
                    },
                    {
                        timeoutMs: 30_000,
                        label: "Rust real-byte pressure recorded",
                    },
                )
                .then(
                    () => true,
                    () => false,
                ),
    };
}

function rustPrerequisite() {
    const result = detectRustPrerequisites();
    return result.ok
        ? ({ ok: true } as const)
        : ({ ok: false, reason: result.missing.join("; ") } as const);
}

function unavailableDependentObservation(
    kind: DependentTodoObservation["kind"],
): DependentTodoObservation {
    return {
        kind,
        promptMatched: true,
        toolRegistryMatched: true,
        environmentMatched: true,
        clonedStateMatched: true,
        modeMatched: true,
        harnessMatched: true,
        prerequisitesMet: false,
        rootTodoWriteExecuted: false,
        rootModuleStateCaptured: false,
        rootSyntheticPairPresent: false,
        ownActionExecuted: false,
        providerTransitionCorrect: false,
        durableTransitionCorrect: false,
    };
}

async function createRustTodoHarness(
    context: CaseDriverContext,
): Promise<RustTestHarness> {
    return withCaseTmp(context, () =>
        RustTestHarness.create({
            modelContextLimit: TODO_MODEL_CONTEXT_LIMIT,
            magicContextConfig: {
                execute_threshold_percentage: TODO_EXECUTE_THRESHOLD_PERCENTAGE,
                dreamer: { disable: true },
                sidekick: { disable: true },
            },
        }),
    );
}

async function driveRustRoot(context: CaseDriverContext): Promise<{
    observation: Todo1Observation;
    h: RustTestHarness;
    sessionId: string;
    callId: string;
}> {
    const h = await createRustTodoHarness(context);
    try {
        const sessionId = await h.createSession();
        const adapter = rustAdapter(h, sessionId);
        const initialModuleState = h.readModuleTodoState(sessionId);
        const stateJson = normalizedTodoJson(STATE_X_TODOS);
        const callId = computeSyntheticCallId(stateJson);
        const probe = await captureTodoState(adapter, STATE_X_TODOS);
        const moduleTodoStateCaptured = await h
            .waitFor(
                () =>
                    h.readModuleTodoState(sessionId)?.lastTodoState ===
                    stateJson,
                {
                    timeoutMs: 30_000,
                    label: "Rust module-owned todo state captured",
                },
            )
            .then(
                () => true,
                () => false,
            );
        const pressureUsedRealBytes = await primeNextTurnAsCacheBust(adapter);
        const body = await sendAndCaptureMainRequest(
            adapter,
            "cache-bust turn",
        );
        const pair = body ? findSyntheticPair(body, callId) : null;
        return {
            h,
            sessionId,
            callId,
            observation: {
                kind: "rust-todo-1-synthetic-injection",
                promptMatched: true,
                toolRegistryMatched: probe.toolName === "todowrite",
                environmentMatched: pathInside(
                    context.workspaceRoot,
                    h.env.dataDir,
                ),
                clonedStateMatched: initialModuleState === null,
                modeMatched: true,
                harnessMatched: true,
                prerequisitesMet: true,
                todoWriteExecuted: probe.executed,
                schemaAccepted: probe.executed,
                pressureUsedRealBytes,
                providerRequestCaptured: body !== null,
                moduleTodoStateCaptured,
                providerSyntheticPairPresent: pair !== null,
                // The call id is a hash of the normalized state, so an id match
                // alone says the injector DERIVED the id from the right state,
                // not that it shipped that state. Stale or fabricated argument
                // bytes under the expected id would otherwise read as correct
                // while the agent sees the wrong todos, and
                // `moduleTodoStateCaptured` only proves the durable side.
                deterministicCallIdMatched:
                    pair?.callId === callId &&
                    wireTodosMatch(pairTodoInput(pair), STATE_X_TODOS),
            },
        };
    } catch (error) {
        // Callers own disposal only once this returns a harness; a setup
        // failure here would otherwise leak the Rust host for the whole run.
        await h.dispose();
        throw error;
    }
}

export async function driveTodoSyntheticInjection(
    context: CaseDriverContext,
): Promise<Todo1Observation> {
    const root = await driveRustRoot(context);
    try {
        return root.observation;
    } finally {
        await root.h.dispose();
    }
}

/**
 * Drop the frozen synthetic pair from module-owned state while keeping
 * `last_todo_state`, which is exactly the legacy shape: a session that
 * captured `last_todo_state` before anchors existed. The module rebuilds the
 * pair from that state on the next bust pass
 * (`advance_injection_from_meta`).
 */
function seedRustLegacyAnchor(h: RustTestHarness, sessionId: string): boolean {
    const path = join(h.env.dataDir, "cortexkit", "magic-context", "store.db");
    const db = openTestDb(path, { readwrite: true });
    try {
        const row = db
            .prepare("SELECT meta FROM mc_cache_state WHERE session_id = ?")
            .get(sessionId) as { meta: string } | null;
        if (!row) return false;
        const meta = JSON.parse(row.meta) as Record<string, unknown>;
        if (typeof meta.last_todo_state !== "string") return false;
        delete meta.synthetic_todo;
        db.prepare(
            "UPDATE mc_cache_state SET meta = ? WHERE session_id = ?",
        ).run(JSON.stringify(meta), sessionId);
        return true;
    } finally {
        db.close();
    }
}

async function driveDependent(
    context: CaseDriverContext,
    kind: DependentTodoObservation["kind"],
): Promise<DependentTodoObservation> {
    if (!rustPrerequisite().ok) return unavailableDependentObservation(kind);
    const root = await driveRustRoot(context);
    const base: DependentTodoObservation = {
        kind,
        promptMatched: root.observation.promptMatched,
        toolRegistryMatched: root.observation.toolRegistryMatched,
        environmentMatched: root.observation.environmentMatched,
        clonedStateMatched: root.observation.clonedStateMatched,
        modeMatched: root.observation.modeMatched,
        harnessMatched: root.observation.harnessMatched,
        prerequisitesMet: true,
        rootTodoWriteExecuted: root.observation.todoWriteExecuted,
        rootModuleStateCaptured: root.observation.moduleTodoStateCaptured,
        rootSyntheticPairPresent:
            root.observation.providerSyntheticPairPresent &&
            root.observation.deterministicCallIdMatched,
        ownActionExecuted: false,
        providerTransitionCorrect: false,
        durableTransitionCorrect: false,
    };
    try {
        if (!base.rootSyntheticPairPresent) return base;
        const adapter = rustAdapter(root.h, root.sessionId);
        if (kind === "rust-todo-2-defer-replay") {
            const t0 = await sendAndCaptureMainRequest(
                adapter,
                "defer replay t0",
            );
            const state0 = root.h.readModuleTodoState(root.sessionId);
            const t1 = await sendAndCaptureMainRequest(
                adapter,
                "defer replay t1",
            );
            const state1 = root.h.readModuleTodoState(root.sessionId);
            const bytes0 = t0 ? syntheticPairBytes(t0, root.callId) : null;
            const bytes1 = t1 ? syntheticPairBytes(t1, root.callId) : null;
            return {
                ...base,
                ownActionExecuted: true,
                providerTransitionCorrect: bytes0 !== null && bytes1 === bytes0,
                durableTransitionCorrect:
                    state0?.syntheticCallId === root.callId &&
                    // Both reads being null satisfies plain equality, so an
                    // implementation that replays the pair while never
                    // persisting anchor_mid reads as a correct frozen
                    // transition. Reanchoring each defer can preserve the
                    // compared bytes too, so the anchor must exist and hold.
                    state0.syntheticAnchorMessageId !== null &&
                    state1?.syntheticCallId === state0.syntheticCallId &&
                    state1?.syntheticAnchorMessageId ===
                        state0.syntheticAnchorMessageId,
            };
        }
        if (kind === "rust-todo-3-newer-todo-deferral") {
            const baseline = await sendAndCaptureMainRequest(
                adapter,
                "baseline defer",
            );
            const baselineBytes = baseline
                ? syntheticPairBytes(baseline, root.callId)
                : null;
            const newerProbe = await captureTodoState(
                adapter,
                STATE_Y_TODOS,
                "write changed todos",
            );
            const newerState = normalizedTodoJson(STATE_Y_TODOS);
            const newerCaptured = await root.h
                .waitFor(
                    () =>
                        root.h.readModuleTodoState(root.sessionId)
                            ?.lastTodoState === newerState,
                    {
                        timeoutMs: 30_000,
                        label: "newer Rust todo state captured",
                    },
                )
                .then(
                    () => true,
                    () => false,
                );
            const defer = await sendAndCaptureMainRequest(
                adapter,
                "defer after changed todos",
            );
            const deferBytes = defer
                ? syntheticPairBytes(defer, root.callId)
                : null;
            // Byte-comparing the frozen call id cannot see a SECOND injected
            // pair emitted for the newer state beside it, and the durable
            // fields stay frozen in that case too. Require the frozen pair to
            // be the only injected pair on this wire.
            const deferInjectedPairs = defer ? injectedTodoPairs(defer).length : 0;
            const state = root.h.readModuleTodoState(root.sessionId);
            return {
                ...base,
                ownActionExecuted: newerProbe.executed,
                providerTransitionCorrect:
                    baselineBytes !== null &&
                    deferBytes === baselineBytes &&
                    deferInjectedPairs === 1,
                durableTransitionCorrect:
                    newerCaptured &&
                    state?.lastTodoState === newerState &&
                    state.syntheticCallId === root.callId,
            };
        }
        if (kind === "rust-todo-4-legacy-anchor-heal") {
            const legacySeeded = seedRustLegacyAnchor(root.h, root.sessionId);
            const before = root.h.readModuleTodoState(root.sessionId);
            const pressureUsedRealBytes =
                await primeNextTurnAsCacheBust(adapter);
            const bust = await sendAndCaptureMainRequest(
                adapter,
                "legacy self-heal cache bust",
            );
            const bustBytes = bust
                ? syntheticPairBytes(bust, root.callId)
                : null;
            const after = root.h.readModuleTodoState(root.sessionId);
            const defer = await sendAndCaptureMainRequest(
                adapter,
                "legacy self-heal defer",
            );
            const deferBytes = defer
                ? syntheticPairBytes(defer, root.callId)
                : null;
            return {
                ...base,
                ownActionExecuted:
                    legacySeeded &&
                    before?.syntheticCallId === null &&
                    pressureUsedRealBytes,
                // The rebuilt pair must carry the deterministic call id for the
                // retained state, and the following defer pass must replay it
                // byte-for-byte rather than rebuild it again.
                providerTransitionCorrect:
                    bustBytes !== null && deferBytes === bustBytes,
                durableTransitionCorrect:
                    after?.syntheticCallId === root.callId &&
                    after?.lastTodoState ===
                        normalizedTodoJson(STATE_X_TODOS) &&
                    // Healing must persist the anchor linkage too. The provider
                    // bytes cannot stand in: they can be byte-identical while
                    // `anchor_mid` stays null, which is exactly the catalog's
                    // invalid "wrong persisted state linkage" shape this
                    // known-red case is supposed to keep reproducing.
                    after?.syntheticAnchorMessageId !== null,
            };
        }
        const terminalProbe = await captureTodoState(
            adapter,
            TERMINAL_TODOS,
            "write terminal todos",
        );
        const terminalState = normalizedTodoJson(TERMINAL_TODOS);
        const terminalCaptured = await root.h
            .waitFor(
                () =>
                    root.h.readModuleTodoState(root.sessionId)
                        ?.lastTodoState === terminalState,
                {
                    timeoutMs: 30_000,
                    label: "terminal Rust todo state captured",
                },
            )
            .then(
                () => true,
                () => false,
            );
        await primeNextTurnAsCacheBust(adapter);
        const body = await sendAndCaptureMainRequest(
            adapter,
            "terminal cache-bust turn",
        );
        const state = root.h.readModuleTodoState(root.sessionId);
        return {
            ...base,
            ownActionExecuted: terminalProbe.executed,
            // Any pair, not just the prior call id: a rebuilt pair under a
            // fresh call id is the same failure to clear the anchor.
            providerTransitionCorrect:
                body !== null && findSyntheticPair(body) === null,
            // Both halves of the frozen pair must go. Clearing the call id
            // alone also removes the provider pair, so `providerTransitionCorrect`
            // cannot catch a durable anchor left behind — this case would score
            // as a resolution candidate with a stale `anchor_mid` still on disk.
            durableTransitionCorrect:
                terminalCaptured &&
                state?.lastTodoState === terminalState &&
                state.syntheticCallId === null &&
                state.syntheticAnchorMessageId === null,
        };
    } finally {
        await root.h.dispose();
    }
}

export function driveTodoDeferReplay(
    context: CaseDriverContext,
): Promise<DependentTodoObservation> {
    return driveDependent(context, "rust-todo-2-defer-replay");
}

export function driveTodoNewerDeferral(
    context: CaseDriverContext,
): Promise<DependentTodoObservation> {
    return driveDependent(context, "rust-todo-3-newer-todo-deferral");
}

export function driveTodoLegacyAnchorHeal(
    context: CaseDriverContext,
): Promise<DependentTodoObservation> {
    return driveDependent(context, "rust-todo-4-legacy-anchor-heal");
}

export function driveTodoTerminalClear(
    context: CaseDriverContext,
): Promise<DependentTodoObservation> {
    return driveDependent(context, "rust-todo-5-terminal-clear");
}

const RUST_IMPLEMENTATION_FILES = [
    "packages/e2e-tests/src/incident-pool/scenarios/parity-synthetic-todo.ts",
    "packages/e2e-tests/src/rust-harness.ts",
    "packages/e2e-tests/src/rust-runner/hermetic-mc-host.ts",
    "packages/plugin/src/hooks/magic-context/hook-handlers.ts",
    "crates/mc-module/src/injection.rs",
    // `injection.rs` supplies the pure producer (call id, pair bytes, capture
    // and advance decisions); `transform.rs` is what calls it and performs the
    // behavior the five Rust cases actually assert — provider-wire insertion,
    // anchor persistence and reanchoring, and terminal clearing. Omitting it
    // lets every Rust verdict change while the implementation and selected-set
    // digests stay constant.
    "crates/mc-module/src/transform.rs",
];

const RUST_MATRIX_FIXTURE = TODO_PARITY_MATRIX.find(
    (row) => row.interface === "opencode-rust",
)!;

export function paritySyntheticTodoIncidentCases(): RegisteredIncidentCase[] {
    return [
        {
            variantId: "var-todo-1-synthetic-injection",
            implementationFiles: RUST_IMPLEMENTATION_FILES,
            fixtures: {
                matrix: RUST_MATRIX_FIXTURE,
                todoState: "active-two-item",
                pressure: TODO_PRESSURE_FIXTURE,
            },
            driver: driveTodoSyntheticInjection,
            normalizer: normalizeTodoSyntheticInjection,
            precondition: preconditionTodoSyntheticInjection,
            verifier: verifyTodoSyntheticInjection,
            binding: {
                driver: driveTodoSyntheticInjection,
                verifier: verifyTodoSyntheticInjection,
            },
            prerequisite: rustPrerequisite,
        },
        {
            variantId: "var-todo-2-defer-replay",
            implementationFiles: RUST_IMPLEMENTATION_FILES,
            fixtures: {
                matrix: RUST_MATRIX_FIXTURE,
                todoState: "frozen-active-two-item",
                action: "two-defer-byte-identity",
                pressure: TODO_PRESSURE_FIXTURE,
            },
            driver: driveTodoDeferReplay,
            normalizer: normalizeTodoDeferReplay,
            precondition: preconditionTodoDeferReplay,
            verifier: verifyTodoDeferReplay,
            binding: {
                driver: driveTodoDeferReplay,
                verifier: verifyTodoDeferReplay,
            },
            prerequisite: rustPrerequisite,
        },
        {
            variantId: "var-todo-3-newer-todo-deferral",
            implementationFiles: RUST_IMPLEMENTATION_FILES,
            fixtures: {
                matrix: RUST_MATRIX_FIXTURE,
                todoState: "active-state-x-then-active-state-y",
                action: "newer-state-waits-for-next-bust",
                pressure: TODO_PRESSURE_FIXTURE,
            },
            driver: driveTodoNewerDeferral,
            normalizer: normalizeTodoNewerDeferral,
            precondition: preconditionTodoNewerDeferral,
            verifier: verifyTodoNewerDeferral,
            binding: {
                driver: driveTodoNewerDeferral,
                verifier: verifyTodoNewerDeferral,
            },
            prerequisite: rustPrerequisite,
        },
        {
            variantId: "var-todo-4-legacy-anchor-heal",
            implementationFiles: RUST_IMPLEMENTATION_FILES,
            fixtures: {
                matrix: RUST_MATRIX_FIXTURE,
                todoState: "legacy-empty-state-anchor",
                setup: "module-owned-public-surface-required",
                pressure: TODO_PRESSURE_FIXTURE,
            },
            driver: driveTodoLegacyAnchorHeal,
            normalizer: normalizeTodoLegacyAnchorHeal,
            precondition: preconditionTodoLegacyAnchorHeal,
            verifier: verifyTodoLegacyAnchorHeal,
            binding: {
                driver: driveTodoLegacyAnchorHeal,
                verifier: verifyTodoLegacyAnchorHeal,
            },
            prerequisite: rustPrerequisite,
        },
        {
            variantId: "var-todo-5-terminal-clear",
            implementationFiles: RUST_IMPLEMENTATION_FILES,
            fixtures: {
                matrix: RUST_MATRIX_FIXTURE,
                todoState: "active-then-terminal",
                action: "terminal-bust-clears-frozen-pair",
                pressure: TODO_PRESSURE_FIXTURE,
            },
            driver: driveTodoTerminalClear,
            normalizer: normalizeTodoTerminalClear,
            precondition: preconditionTodoTerminalClear,
            verifier: verifyTodoTerminalClear,
            binding: {
                driver: driveTodoTerminalClear,
                verifier: verifyTodoTerminalClear,
            },
            prerequisite: rustPrerequisite,
        },
    ];
}
