import { realpathSync } from "node:fs";
import { computeSyntheticCallId } from "../../../../plugin/src/hooks/magic-context/todo-view";
import { PiTestHarness } from "../../pi-harness";
import { openTestDb } from "../../test-db";
import type {
    CaseDriverContext,
    JsonValue,
    NormalizedObservation,
    PreconditionOutcome,
    RegisteredIncidentCase,
    VerifierCheck,
} from "../registry";
import {
    MISSING_PRIORITY_TODOS,
    STATE_X_TODOS,
    STATE_Y_TODOS,
    TERMINAL_TODOS,
    TODO_MODEL_CONTEXT_LIMIT,
    TODO_PARITY_MATRIX,
    TODO_PRESSURE_FIXTURE,
    captureTodoState,
    findSyntheticPair,
    injectedTodoPairs,
    pairToolResultTodos,
    pairTodoInput,
    isMagicContextRequest,
    normalizedTodoJson,
    primeNextTurnAsCacheBust,
    sendAndCaptureMainRequest,
    syntheticPairBytes,
    wireTodosMatch,
    type TodoMeta,
    type TodoParitySetup,
    type TodoScriptAdapter,
} from "./parity-synthetic-todo";

const SETUP_FIELDS = [
    "promptMatched",
    "toolRegistryMatched",
    "environmentMatched",
    "clonedStateMatched",
    "modeMatched",
    "harnessMatched",
    "prerequisitesMet",
] as const;

function check(id: string, passed: boolean): VerifierCheck {
    return { id, passed };
}

function unmet(): PreconditionOutcome {
    return { satisfied: false, reason: "precondition_unmet", blockedBy: [] };
}

function setupSatisfied(setup: TodoParitySetup): boolean {
    return Object.values(setup).every(Boolean);
}

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

function piAdapter(h: PiTestHarness): TodoScriptAdapter {
    return {
        mock: h.mock,
        ballast: (tokens) => h.ballast(tokens),
        sendPrompt: async (text) => {
            await h.sendPrompt(text, {
                timeoutMs: 90_000,
                continueSession: true,
            });
        },
        mainRequests: () =>
            h.mock
                .requests()
                .filter((request) => isMagicContextRequest(request.body)),
        waitForPressure: () =>
            h
                .waitFor(
                    () => {
                        const sessionId = h.lastTurn?.sessionId;
                        if (!sessionId) return false;
                        const row = h
                            .contextDb()
                            .prepare(
                                "SELECT last_context_percentage FROM session_meta WHERE session_id = ?",
                            )
                            .get(sessionId) as {
                            last_context_percentage: number;
                        } | null;
                        return (row?.last_context_percentage ?? 0) >= 65;
                    },
                    {
                        timeoutMs: 10_000,
                        label: "Pi todo real-byte pressure recorded",
                    },
                )
                .then(
                    () => true,
                    () => false,
                ),
    };
}

function readPiTodoMeta(h: PiTestHarness, sessionId: string): TodoMeta | null {
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

function updatePiTodoMeta(
    h: PiTestHarness,
    sessionId: string,
    sql: string,
): void {
    h.closeContextDb();
    const db = openTestDb(h.contextDbPath(), { readwrite: true });
    try {
        db.prepare(sql).run(sessionId);
    } finally {
        db.close();
    }
}

async function newPiSessionId(h: PiTestHarness): Promise<string> {
    await h.newSession();
    const first = await h.sendPrompt("start synthetic todo incident session", {
        timeoutMs: 90_000,
    });
    if (!first.sessionId) throw new Error("Pi session did not return an id");
    return first.sessionId;
}

async function createPiHarness(
    context: CaseDriverContext,
): Promise<PiTestHarness> {
    return PiTestHarness.create({
        modelContextLimit: TODO_MODEL_CONTEXT_LIMIT,
        sharedDataDir: context.storeDir,
        workdir: context.workspaceRoot,
        magicContextConfig: {
            execute_threshold_percentage: 20,
            dreamer: { disable: true },
            sidekick: { disable: true },
        },
    });
}

function baseSetup(
    context: CaseDriverContext,
    h: PiTestHarness,
    initialMeta: TodoMeta | null,
): TodoParitySetup {
    return {
        promptMatched: true,
        toolRegistryMatched: true,
        environmentMatched: pathInside(
            context.workspaceRoot,
            h.contextDbPath(),
        ),
        clonedStateMatched:
            initialMeta === null ||
            ((initialMeta.last_todo_state ?? "") === "" &&
                (initialMeta.todo_synthetic_call_id ?? "") === ""),
        modeMatched: true,
        harnessMatched: true,
        prerequisitesMet: true,
    };
}

/**
 * The id of the newest assistant message an injector may anchor to.
 *
 * The Pi injector appends the synthetic pair to the newest assistant message
 * that did not abort or error, and persists THAT message's id, so it is the only
 * legal anchor for a pair built from the same history. Deriving it here from
 * Pi's own message fields keeps the expectation independent of the injector: a
 * check that only requires a nonempty id accepts any string, and one that reused
 * the injector's own id helper would agree with it however it were derived.
 */
function latestReplayableAssistantId(
    messages: readonly Record<string, unknown>[],
): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || typeof message !== "object") continue;
        if (message.role !== "assistant") continue;
        if (message.stopReason === "aborted" || message.stopReason === "error")
            continue;
        const responseId = message.responseId;
        if (typeof responseId === "string" && responseId.length > 0)
            return responseId;
        const timestamp = message.timestamp;
        if (typeof timestamp === "number") return `pi-ts-${timestamp}`;
    }
    return null;
}

async function preparePiCacheBust(
    context: CaseDriverContext,
    h: PiTestHarness,
): Promise<{
    setup: TodoParitySetup;
    sessionId: string;
    callId: string;
    expectedAnchorId: string | null;
    toolExecuted: boolean;
    pressureUsedRealBytes: boolean;
    body: Record<string, unknown> | null;
    meta: TodoMeta | null;
}> {
    const sessionId = await newPiSessionId(h);
    const initialMeta = readPiTodoMeta(h, sessionId);
    const adapter = piAdapter(h);
    const stateJson = normalizedTodoJson(STATE_X_TODOS);
    const callId = computeSyntheticCallId(stateJson);
    const probe = await captureTodoState(adapter, STATE_X_TODOS);
    const pressureUsedRealBytes = await primeNextTurnAsCacheBust(adapter);
    // Snapshot before the bust turn: the request that injects the pair is built
    // from this history, so the anchor must name a message already in it.
    const expectedAnchorId = latestReplayableAssistantId(await h.getMessages());
    const body = await sendAndCaptureMainRequest(adapter, "Pi cache-bust turn");
    return {
        setup: {
            ...baseSetup(context, h, initialMeta),
            toolRegistryMatched: probe.toolName === "todowrite",
        },
        sessionId,
        callId,
        expectedAnchorId,
        toolExecuted: probe.executed,
        pressureUsedRealBytes,
        body,
        meta: readPiTodoMeta(h, sessionId),
    };
}

export type PiTodoCaptureObservation = TodoParitySetup & {
    kind: "pi-todo-capture";
    parentToolExecuted: boolean;
    parentStateCaptured: boolean;
    missingPriorityToolExecuted: boolean;
    missingPriorityDefaulted: boolean;
};

const CAPTURE_FIELDS = [
    ...SETUP_FIELDS,
    "parentToolExecuted",
    "parentStateCaptured",
    "missingPriorityToolExecuted",
    "missingPriorityDefaulted",
] as const;

export function normalizePiTodoCapture(
    raw: JsonValue,
): PiTodoCaptureObservation {
    return exactBooleanObservation<PiTodoCaptureObservation>(
        raw,
        "pi-todo-capture",
        CAPTURE_FIELDS,
    );
}

export function preconditionPiTodoCapture(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const value = observation as PiTodoCaptureObservation;
    return setupSatisfied(setupFromObservation(value)) &&
        value.parentToolExecuted &&
        value.missingPriorityToolExecuted
        ? { satisfied: true }
        : unmet();
}

export function verifyPiTodoCapture(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const value = observation as PiTodoCaptureObservation;
    return [
        check("check-pi-todo-capture-last-state", value.parentStateCaptured),
        check(
            "check-pi-todo-missing-priority-default",
            value.missingPriorityDefaulted,
        ),
    ];
}

export async function drivePiTodoCapture(
    context: CaseDriverContext,
): Promise<PiTodoCaptureObservation> {
    const h = await createPiHarness(context);
    try {
        const parentSession = await newPiSessionId(h);
        const initialMeta = readPiTodoMeta(h, parentSession);
        const parentProbe = await captureTodoState(piAdapter(h), STATE_X_TODOS);
        const parentStateCaptured =
            readPiTodoMeta(h, parentSession)?.last_todo_state ===
            normalizedTodoJson(STATE_X_TODOS);

        const missingPrioritySession = await newPiSessionId(h);
        const missingPriorityAdapter = piAdapter(h);
        const missingPriorityProbe = await captureTodoState(
            missingPriorityAdapter,
            MISSING_PRIORITY_TODOS,
        );
        // Capture-side state is only half the behavior. Persisting `medium` and
        // then omitting or mis-serializing it on the provider wire is the defect
        // an agent would actually see, and no other variant covers it: the
        // injection case drives STATE_X_TODOS, whose priorities are all
        // explicit. Drive the defaulted state through a bust and read the pair.
        const missingPriorityState = normalizedTodoJson(MISSING_PRIORITY_TODOS);
        await primeNextTurnAsCacheBust(missingPriorityAdapter);
        const missingPriorityBust = await sendAndCaptureMainRequest(
            missingPriorityAdapter,
            "Pi missing-priority cache-bust turn",
        );
        const missingPriorityPair = missingPriorityBust
            ? findSyntheticPair(
                  missingPriorityBust,
                  computeSyntheticCallId(missingPriorityState),
              )
            : null;
        return {
            kind: "pi-todo-capture",
            ...baseSetup(context, h, initialMeta),
            toolRegistryMatched:
                parentProbe.toolName === "todowrite" &&
                missingPriorityProbe.toolName === "todowrite",
            parentToolExecuted: parentProbe.executed,
            parentStateCaptured,
            missingPriorityToolExecuted: missingPriorityProbe.executed,
            missingPriorityDefaulted:
                readPiTodoMeta(h, missingPrioritySession)?.last_todo_state ===
                    missingPriorityState &&
                wireTodosMatch(
                    pairTodoInput(missingPriorityPair),
                    MISSING_PRIORITY_TODOS,
                ) &&
                // The agent reads the RESULT, so a correct defaulted input
                // beside a stale result is still a contradictory pair.
                wireTodosMatch(
                    pairToolResultTodos(missingPriorityPair),
                    MISSING_PRIORITY_TODOS,
                ) &&
                // Looking the expected pair up by id cannot see another beside
                // it, and the durable read is identical either way.
                missingPriorityBust !== null &&
                injectedTodoPairs(missingPriorityBust).length === 1,
        };
    } finally {
        await h.dispose();
    }
}

export type PiTodoInjectionObservation = TodoParitySetup & {
    kind: "pi-todo-injection";
    todoWriteExecuted: boolean;
    pressureUsedRealBytes: boolean;
    providerRequestCaptured: boolean;
    syntheticPairPresent: boolean;
    deterministicCallIdMatched: boolean;
    persistedAnchorMatched: boolean;
};

const INJECTION_FIELDS = [
    ...SETUP_FIELDS,
    "todoWriteExecuted",
    "pressureUsedRealBytes",
    "providerRequestCaptured",
    "syntheticPairPresent",
    "deterministicCallIdMatched",
    "persistedAnchorMatched",
] as const;

export function normalizePiTodoInjection(
    raw: JsonValue,
): PiTodoInjectionObservation {
    return exactBooleanObservation<PiTodoInjectionObservation>(
        raw,
        "pi-todo-injection",
        INJECTION_FIELDS,
    );
}

export function preconditionPiTodoInjection(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const value = observation as PiTodoInjectionObservation;
    return setupSatisfied(setupFromObservation(value)) &&
        value.todoWriteExecuted &&
        value.pressureUsedRealBytes &&
        value.providerRequestCaptured
        ? { satisfied: true }
        : unmet();
}

export function verifyPiTodoInjection(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const value = observation as PiTodoInjectionObservation;
    return [
        check(
            "check-pi-todo-synthetic-pair-injected",
            value.syntheticPairPresent &&
                value.deterministicCallIdMatched &&
                value.persistedAnchorMatched,
        ),
    ];
}

export async function drivePiTodoInjection(
    context: CaseDriverContext,
): Promise<PiTodoInjectionObservation> {
    const h = await createPiHarness(context);
    try {
        const prepared = await preparePiCacheBust(context, h);
        const pair = prepared.body
            ? findSyntheticPair(prepared.body, prepared.callId)
            : null;
        return {
            kind: "pi-todo-injection",
            ...prepared.setup,
            todoWriteExecuted: prepared.toolExecuted,
            pressureUsedRealBytes: prepared.pressureUsedRealBytes,
            providerRequestCaptured: prepared.body !== null,
            // A correct pair beside a second injected one satisfies a bare
            // existence check, and neither the id nor the anchor assertion can
            // see the extra pair, so duplicate or conflicting todos could reach
            // the agent unnoticed.
            syntheticPairPresent:
                pair !== null &&
                prepared.body !== null &&
                injectedTodoPairs(prepared.body).length === 1,
            // The call id is a hash of the normalized state, so matching it
            // proves the id was DERIVED from the right state, not that the pair
            // carries it. Both halves are compared: the agent reads the tool
            // result, so a correct input beside a fabricated result is still a
            // contradictory pair.
            deterministicCallIdMatched:
                pair?.callId === prepared.callId &&
                wireTodosMatch(pairTodoInput(pair), STATE_X_TODOS) &&
                wireTodosMatch(pairToolResultTodos(pair), STATE_X_TODOS),
            // A nonempty anchor id proves nothing: an implementation that
            // persists the correct call id and state alongside an arbitrary
            // message id satisfies the catalog's invalid "correct provider bytes
            // linked to the wrong persisted anchor" shape, and the defer pass
            // then re-anchors somewhere else or drops the pair. Require the id
            // of the message the pair was actually appended to.
            persistedAnchorMatched:
                prepared.meta?.todo_synthetic_call_id === prepared.callId &&
                prepared.expectedAnchorId !== null &&
                prepared.meta.todo_synthetic_anchor_message_id ===
                    prepared.expectedAnchorId &&
                prepared.meta.todo_synthetic_state_json ===
                    normalizedTodoJson(STATE_X_TODOS),
        };
    } finally {
        await h.dispose();
    }
}

export type PiTodoReplayObservation = TodoParitySetup & {
    kind: "pi-todo-replay";
    rootTodoWriteExecuted: boolean;
    pressureUsedRealBytes: boolean;
    providerRequestCaptured: boolean;
    firstReplayPresent: boolean;
    byteIdenticalReplay: boolean;
    durableReplayIdentityStable: boolean;
    newerTodoExecuted: boolean;
    newerTodoDeferred: boolean;
    legacyAnchorExisted: boolean;
    legacyAnchorHealed: boolean;
};

const REPLAY_FIELDS = [
    ...SETUP_FIELDS,
    "rootTodoWriteExecuted",
    "pressureUsedRealBytes",
    "providerRequestCaptured",
    "firstReplayPresent",
    "byteIdenticalReplay",
    "durableReplayIdentityStable",
    "newerTodoExecuted",
    "newerTodoDeferred",
    "legacyAnchorExisted",
    "legacyAnchorHealed",
] as const;

export function normalizePiTodoDeferReplay(
    raw: JsonValue,
): PiTodoReplayObservation {
    return exactBooleanObservation<PiTodoReplayObservation>(
        raw,
        "pi-todo-replay",
        REPLAY_FIELDS,
    );
}

export function preconditionPiTodoDeferReplay(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const value = observation as PiTodoReplayObservation;
    return setupSatisfied(setupFromObservation(value)) &&
        value.rootTodoWriteExecuted &&
        value.pressureUsedRealBytes &&
        value.providerRequestCaptured &&
        value.newerTodoExecuted
        ? { satisfied: true }
        : unmet();
}

export function verifyPiTodoDeferReplay(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const value = observation as PiTodoReplayObservation;
    return [
        check(
            "check-pi-todo-byte-identical-replay",
            value.firstReplayPresent &&
                value.byteIdenticalReplay &&
                value.durableReplayIdentityStable,
        ),
        check("check-pi-todo-newer-state-deferred", value.newerTodoDeferred),
        check(
            "check-pi-todo-legacy-anchor-self-heal",
            value.legacyAnchorExisted && value.legacyAnchorHealed,
        ),
    ];
}

export async function drivePiTodoDeferReplay(
    context: CaseDriverContext,
): Promise<PiTodoReplayObservation> {
    const h = await createPiHarness(context);
    try {
        const replay = await preparePiCacheBust(context, h);
        const replayAdapter = piAdapter(h);
        const t0 = await sendAndCaptureMainRequest(
            replayAdapter,
            "Pi defer replay t0",
        );
        const metaT0 = readPiTodoMeta(h, replay.sessionId);
        const t1 = await sendAndCaptureMainRequest(
            replayAdapter,
            "Pi defer replay t1",
        );
        const metaT1 = readPiTodoMeta(h, replay.sessionId);
        const pair0 = t0 ? findSyntheticPair(t0, replay.callId) : null;
        const replayPairCounts = [t0, t1].map((body) =>
            body ? injectedTodoPairs(body).length : 0,
        );
        const bytes0 = pair0?.bytes ?? null;
        const bytes1 = t1 ? syntheticPairBytes(t1, replay.callId) : null;

        const newer = await preparePiCacheBust(context, h);
        const newerAdapter = piAdapter(h);
        const newerBaseline = await sendAndCaptureMainRequest(
            newerAdapter,
            "Pi baseline defer",
        );
        const newerBaselineBytes = newerBaseline
            ? syntheticPairBytes(newerBaseline, newer.callId)
            : null;
        const newerProbe = await captureTodoState(
            newerAdapter,
            STATE_Y_TODOS,
            "write changed Pi todos",
        );
        const newerDefer = await sendAndCaptureMainRequest(
            newerAdapter,
            "Pi defer after changed todos",
        );
        const newerMeta = readPiTodoMeta(h, newer.sessionId);
        const newerBytes = newerDefer
            ? syntheticPairBytes(newerDefer, newer.callId)
            : null;
        // Deferral means the newer state is not on the wire AT ALL, not merely
        // that the frozen pair survived beside it. Byte-comparing the old call
        // id cannot see a second pair injected for the newer state, and the
        // durable fields stay frozen in that case too, so without a count the
        // case reads as deferred while already exposing the newer todos. Count
        // injected pairs by their deterministic call-id prefix: a real executed
        // todowrite pair replayed in history is not a second injection.
        const newerDeferPairCount = newerDefer
            ? injectedTodoPairs(newerDefer).length
            : 0;

        const legacy = await preparePiCacheBust(context, h);
        const legacyAdapter = piAdapter(h);
        const legacyAnchorExisted =
            legacy.meta?.todo_synthetic_call_id === legacy.callId;
        // The anchor the frozen pair is already replayed at. Healing rebuilds the
        // deleted state json and must keep pointing here.
        const legacyPreHealAnchorId =
            legacy.meta?.todo_synthetic_anchor_message_id ?? null;
        updatePiTodoMeta(
            h,
            legacy.sessionId,
            "UPDATE session_meta SET todo_synthetic_state_json = '' WHERE session_id = ?",
        );
        const legacyPressure = await primeNextTurnAsCacheBust(legacyAdapter);
        const legacyBust = await sendAndCaptureMainRequest(
            legacyAdapter,
            "Pi legacy self-heal cache bust",
        );
        const legacyBytes = legacyBust
            ? syntheticPairBytes(legacyBust, legacy.callId)
            : null;
        const legacyMeta = readPiTodoMeta(h, legacy.sessionId);
        const legacyDefer = await sendAndCaptureMainRequest(
            legacyAdapter,
            "Pi legacy self-heal defer",
        );
        const legacyDeferBytes = legacyDefer
            ? syntheticPairBytes(legacyDefer, legacy.callId)
            : null;

        return {
            kind: "pi-todo-replay",
            ...replay.setup,
            rootTodoWriteExecuted:
                replay.toolExecuted &&
                newer.toolExecuted &&
                legacy.toolExecuted,
            pressureUsedRealBytes:
                replay.pressureUsedRealBytes &&
                newer.pressureUsedRealBytes &&
                legacy.pressureUsedRealBytes &&
                legacyPressure,
            providerRequestCaptured:
                replay.body !== null &&
                newer.body !== null &&
                legacy.body !== null,
            firstReplayPresent: bytes0 !== null && bytes1 !== null,
            // Byte-equality across the two defer passes proves the replay is
            // stable, not that what is replayed is right: this variant declares
            // no `blocked_by` dependency on the injection variant, so a
            // consistently malformed pair would otherwise publish a resolution
            // candidate here.
            byteIdenticalReplay:
                bytes0 !== null &&
                bytes1 === bytes0 &&
                wireTodosMatch(pairTodoInput(pair0), STATE_X_TODOS) &&
                wireTodosMatch(pairToolResultTodos(pair0), STATE_X_TODOS) &&
                // Both passes must carry exactly one injected pair: the byte and
                // payload checks resolve the expected call id, so a conflicting
                // second pair on either wire is invisible to them, and the
                // durable identity fields cannot see a provider-only duplicate.
                replayPairCounts.every((count) => count === 1),
            // Comparing the two reads only to each other is satisfied by two
            // nulls, so an implementation that replays the deterministic pair
            // while persisting no anchor at all reads as stable — the catalog's
            // invalid "replay compared while no synthetic anchor was persisted"
            // shape. Two identical but wrong state values pass for the same
            // reason. Anchor both reads to the expected values, then require
            // T1 to still equal T0.
            durableReplayIdentityStable:
                metaT0?.todo_synthetic_call_id === replay.callId &&
                replay.expectedAnchorId !== null &&
                metaT0.todo_synthetic_anchor_message_id ===
                    replay.expectedAnchorId &&
                metaT0.todo_synthetic_state_json ===
                    normalizedTodoJson(STATE_X_TODOS) &&
                metaT1?.todo_synthetic_call_id ===
                    metaT0.todo_synthetic_call_id &&
                metaT1?.todo_synthetic_anchor_message_id ===
                    metaT0.todo_synthetic_anchor_message_id &&
                metaT1?.todo_synthetic_state_json ===
                    metaT0.todo_synthetic_state_json,
            newerTodoExecuted: newerProbe.executed,
            newerTodoDeferred:
                newerBaselineBytes !== null &&
                newerBytes === newerBaselineBytes &&
                newerDeferPairCount === 1 &&
                newerMeta?.last_todo_state ===
                    normalizedTodoJson(STATE_Y_TODOS) &&
                newerMeta.todo_synthetic_call_id === newer.callId &&
                newerMeta.todo_synthetic_state_json ===
                    normalizedTodoJson(STATE_X_TODOS),
            legacyAnchorExisted,
            // A rebuilt pair plus a correct state json is not a healed anchor:
            // the durable linkage is the third field, and leaving it unset is
            // the catalog's invalid wrong-persisted-state-linkage shape.
            //
            // Nonempty is not enough either — an unrelated message id admits the
            // same invalid shape. Healing must PRESERVE the anchor recorded
            // before the heal, because that is the message the frozen pair is
            // replayed at; re-anchoring elsewhere changes the wire position on
            // later defers. So compare against the pre-heal value rather than
            // `legacy.expectedAnchorId`, which names the newest assistant of the
            // heal turn and is not where the original pair lives.
            legacyAnchorHealed:
                legacyBytes !== null &&
                legacyDeferBytes === legacyBytes &&
                (legacyPreHealAnchorId ?? "") !== "" &&
                legacyMeta?.todo_synthetic_anchor_message_id ===
                    legacyPreHealAnchorId &&
                legacyMeta?.todo_synthetic_state_json ===
                    normalizedTodoJson(STATE_X_TODOS),
        };
    } finally {
        await h.dispose();
    }
}

export type PiTodoAnchorObservation = TodoParitySetup & {
    kind: "pi-todo-anchor-lifecycle";
    rootTodoWriteExecuted: boolean;
    providerRequestCaptured: boolean;
    activeAnchorExisted: boolean;
    postTerminalRootCapture: boolean;
    subagentTodoExecuted: boolean;
    subagentGated: boolean;
    terminalTodoExecuted: boolean;
    terminalStateCaptured: boolean;
    terminalPairAbsent: boolean;
    terminalAnchorCleared: boolean;
};

const ANCHOR_FIELDS = [
    ...SETUP_FIELDS,
    "rootTodoWriteExecuted",
    "providerRequestCaptured",
    "activeAnchorExisted",
    "postTerminalRootCapture",
    "subagentTodoExecuted",
    "subagentGated",
    "terminalTodoExecuted",
    "terminalStateCaptured",
    "terminalPairAbsent",
    "terminalAnchorCleared",
] as const;

export function normalizePiTodoAnchorLifecycle(
    raw: JsonValue,
): PiTodoAnchorObservation {
    return exactBooleanObservation<PiTodoAnchorObservation>(
        raw,
        "pi-todo-anchor-lifecycle",
        ANCHOR_FIELDS,
    );
}

export function preconditionPiTodoAnchorLifecycle(
    observation: NormalizedObservation,
): PreconditionOutcome {
    const value = observation as PiTodoAnchorObservation;
    return setupSatisfied(setupFromObservation(value)) &&
        value.rootTodoWriteExecuted &&
        value.providerRequestCaptured &&
        value.subagentTodoExecuted &&
        value.terminalTodoExecuted
        ? { satisfied: true }
        : unmet();
}

export function verifyPiTodoAnchorLifecycle(
    observation: NormalizedObservation,
): VerifierCheck[] {
    const value = observation as PiTodoAnchorObservation;
    return [
        check(
            "check-pi-todo-subagent-gated",
            value.activeAnchorExisted &&
                value.postTerminalRootCapture &&
                value.subagentGated,
        ),
        check(
            "check-pi-todo-terminal-anchor-clear",
            value.activeAnchorExisted &&
                value.terminalStateCaptured &&
                value.terminalPairAbsent &&
                value.terminalAnchorCleared,
        ),
    ];
}

export async function drivePiTodoAnchorLifecycle(
    context: CaseDriverContext,
): Promise<PiTodoAnchorObservation> {
    const h = await createPiHarness(context);
    try {
        const prepared = await preparePiCacheBust(context, h);
        const activeAnchorExisted =
            prepared.meta?.todo_synthetic_call_id === prepared.callId &&
            (prepared.meta.todo_synthetic_anchor_message_id ?? "") !== "";

        const terminalAdapter = piAdapter(h);
        const terminalProbe = await captureTodoState(
            terminalAdapter,
            TERMINAL_TODOS,
            "write terminal Pi todos",
        );
        await primeNextTurnAsCacheBust(terminalAdapter);
        const terminalBody = await sendAndCaptureMainRequest(
            terminalAdapter,
            "Pi terminal cache-bust turn",
        );
        const terminalMeta = readPiTodoMeta(h, prepared.sessionId);

        const rootControlSession = await newPiSessionId(h);
        const rootControlProbe = await captureTodoState(
            piAdapter(h),
            STATE_X_TODOS,
            "Pi post-terminal root capture control",
        );
        const rootControlMeta = readPiTodoMeta(h, rootControlSession);
        const postTerminalRootCapture =
            rootControlProbe.executed &&
            rootControlMeta?.last_todo_state ===
                normalizedTodoJson(STATE_X_TODOS);

        const subagentSession = await newPiSessionId(h);
        updatePiTodoMeta(
            h,
            subagentSession,
            "UPDATE session_meta SET is_subagent = 1 WHERE session_id = ?",
        );
        const subagentProbe = await captureTodoState(
            piAdapter(h),
            STATE_X_TODOS,
            "Pi subagent writes todos",
        );
        const subagentMeta = readPiTodoMeta(h, subagentSession);
        const subagentGated =
            subagentMeta?.is_subagent === 1 &&
            (subagentMeta.last_todo_state ?? "") === "" &&
            (subagentMeta.todo_synthetic_call_id ?? "") === "" &&
            (subagentMeta.todo_synthetic_anchor_message_id ?? "") === "" &&
            (subagentMeta.todo_synthetic_state_json ?? "") === "";
        return {
            kind: "pi-todo-anchor-lifecycle",
            ...prepared.setup,
            rootTodoWriteExecuted: prepared.toolExecuted,
            providerRequestCaptured: prepared.body !== null,
            activeAnchorExisted,
            postTerminalRootCapture,
            subagentTodoExecuted: subagentProbe.executed,
            subagentGated,
            terminalTodoExecuted: terminalProbe.executed,
            terminalStateCaptured:
                terminalMeta?.last_todo_state ===
                normalizedTodoJson(TERMINAL_TODOS),
            terminalPairAbsent:
                terminalBody !== null &&
                findSyntheticPair(terminalBody) === null,
            terminalAnchorCleared:
                (terminalMeta?.todo_synthetic_call_id ?? "") === "" &&
                (terminalMeta?.todo_synthetic_anchor_message_id ?? "") === "" &&
                (terminalMeta?.todo_synthetic_state_json ?? "") === "",
        };
    } finally {
        await h.dispose();
    }
}

const PI_IMPLEMENTATION_FILES = [
    "packages/e2e-tests/src/incident-pool/scenarios/parity-pi-todo.ts",
    "packages/e2e-tests/src/incident-pool/scenarios/parity-synthetic-todo.ts",
    "packages/e2e-tests/src/pi-harness.ts",
    "packages/pi-plugin/src/index.ts",
    "packages/pi-plugin/src/context-handler.ts",
    "packages/pi-plugin/src/pi-todo-inject.ts",
    // Every Pi variant drives the real todowrite tool: the cases assert
    // `toolName === "todowrite"`, which depends on the registration in
    // tools/index.ts, and the capture case asserts missing-priority behavior,
    // which is the optional `priority` in the todowrite schema. Without these
    // the verdict could change while the digest stayed constant.
    "packages/pi-plugin/src/tools/index.ts",
    "packages/pi-plugin/src/tools/todowrite.ts",
    // The Pi injector is only the wire adapter. It imports the deterministic
    // call id and the byte-exact synthetic pair (`computeSyntheticCallId`,
    // `buildSyntheticTodoPart`, terminal-state handling) from the shared view
    // module, and the durable anchor read/write/clear functions from the
    // persisted metadata module — `storage-meta.ts` only re-exports those.
    // Every Pi variant's verdict turns on that behavior, so without these two
    // the call id, pair bytes, or anchor persistence could change while both
    // the implementation and selected-set digests stayed constant.
    "packages/plugin/src/hooks/magic-context/todo-view.ts",
    "packages/plugin/src/features/magic-context/storage-meta-persisted.ts",
];

const PI_MATRIX_FIXTURE = TODO_PARITY_MATRIX.find(
    (row) => row.interface === "pi-ts",
)!;

export function parityPiTodoIncidentCases(): RegisteredIncidentCase[] {
    return [
        {
            variantId: "var-pi-todo-capture",
            implementationFiles: PI_IMPLEMENTATION_FILES,
            fixtures: {
                matrix: PI_MATRIX_FIXTURE,
                assertions: ["capture-parent", "default-missing-priority"],
                pressure: TODO_PRESSURE_FIXTURE,
            },
            driver: drivePiTodoCapture,
            normalizer: normalizePiTodoCapture,
            precondition: preconditionPiTodoCapture,
            verifier: verifyPiTodoCapture,
            binding: {
                driver: drivePiTodoCapture,
                verifier: verifyPiTodoCapture,
            },
        },
        {
            variantId: "var-pi-todo-synthetic-injection",
            implementationFiles: PI_IMPLEMENTATION_FILES,
            fixtures: {
                matrix: PI_MATRIX_FIXTURE,
                assertions: ["deterministic-pair", "persisted-anchor-link"],
                pressure: TODO_PRESSURE_FIXTURE,
            },
            driver: drivePiTodoInjection,
            normalizer: normalizePiTodoInjection,
            precondition: preconditionPiTodoInjection,
            verifier: verifyPiTodoInjection,
            binding: {
                driver: drivePiTodoInjection,
                verifier: verifyPiTodoInjection,
            },
        },
        {
            variantId: "var-pi-todo-defer-replay",
            implementationFiles: PI_IMPLEMENTATION_FILES,
            fixtures: {
                matrix: PI_MATRIX_FIXTURE,
                assertions: ["byte-replay", "newer-deferral", "legacy-heal"],
                pressure: TODO_PRESSURE_FIXTURE,
            },
            driver: drivePiTodoDeferReplay,
            normalizer: normalizePiTodoDeferReplay,
            precondition: preconditionPiTodoDeferReplay,
            verifier: verifyPiTodoDeferReplay,
            binding: {
                driver: drivePiTodoDeferReplay,
                verifier: verifyPiTodoDeferReplay,
            },
        },
        {
            variantId: "var-pi-todo-anchor-lifecycle",
            implementationFiles: PI_IMPLEMENTATION_FILES,
            fixtures: {
                matrix: PI_MATRIX_FIXTURE,
                assertions: [
                    "subagent-gate-with-fresh-post-terminal-root-control",
                    "terminal-clear-with-any-pair-scan",
                ],
                pressure: TODO_PRESSURE_FIXTURE,
            },
            driver: drivePiTodoAnchorLifecycle,
            normalizer: normalizePiTodoAnchorLifecycle,
            precondition: preconditionPiTodoAnchorLifecycle,
            verifier: verifyPiTodoAnchorLifecycle,
            binding: {
                driver: drivePiTodoAnchorLifecycle,
                verifier: verifyPiTodoAnchorLifecycle,
            },
        },
    ];
}
