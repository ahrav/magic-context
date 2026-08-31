/// <reference types="bun-types" />

/**
 *
 * A defer replay must preserve the previous defer pass's message array structure.
 * Defer replays use the same tool callID, anchor message, and input.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearPersistedTodoSyntheticAnchor,
    closeDatabase,
    getOrCreateSessionMeta,
    getPersistedTodoSyntheticAnchor,
    openDatabase,
    setPersistedTodoSyntheticAnchor,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { clearToolPermissionDenied } from "./ctx-reduce-availability";
import { buildSyntheticTodoPart, computeSyntheticCallId, isSyntheticTodoPart } from "./todo-view";
import {
    injectToolPartIntoAssistantById,
    injectToolPartIntoLatestAssistant,
} from "./transform-message-helpers";
import type { MessageLike } from "./transform-operations";
import { applyTodoSynthesis } from "./transform-postprocess-phase";

const tempDirs: string[] = [];

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs)
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* */
        }
    tempDirs.length = 0;
    process.env.XDG_DATA_HOME = undefined;
});

const ACTIVE_TODOS_JSON = JSON.stringify([
    { content: "Build feature", status: "in_progress", priority: "high" },
    { content: "Write tests", status: "pending", priority: "medium" },
]);

const TERMINAL_TODOS_JSON = JSON.stringify([
    { content: "All done", status: "completed", priority: "high" },
]);
const TODO_HEAD_ANCHOR_ID = "__magic_context_todo_head__";

type SyntheticTodoPart = NonNullable<ReturnType<typeof buildSyntheticTodoPart>>;

function injectSyntheticTodoAtHead(messages: MessageLike[], part: SyntheticTodoPart): string {
    const existing = messages[0];
    if (existing?.info.id === TODO_HEAD_ANCHOR_ID) {
        injectToolPartIntoAssistantById(messages, TODO_HEAD_ANCHOR_ID, part);
        return TODO_HEAD_ANCHOR_ID;
    }
    messages.unshift({
        info: { id: TODO_HEAD_ANCHOR_ID, role: "assistant", sessionID: "ses-1" },
        parts: [part],
    });
    return TODO_HEAD_ANCHOR_ID;
}

function injectPersistedTodoAnchor(
    messages: MessageLike[],
    messageId: string,
    part: SyntheticTodoPart,
): boolean {
    if (injectToolPartIntoAssistantById(messages, messageId, part)) return true;
    if (messageId !== TODO_HEAD_ANCHOR_ID) return false;
    injectSyntheticTodoAtHead(messages, part);
    return true;
}

function buildMessages(): MessageLike[] {
    return [
        {
            info: { id: "msg-user-1", role: "user", sessionID: "ses-1" },
            parts: [{ type: "text", text: "Please help me" }],
        },
        {
            info: { id: "msg-asst-1", role: "assistant", sessionID: "ses-1" },
            parts: [{ type: "text", text: "On it" }],
        },
        {
            info: { id: "msg-user-2", role: "user", sessionID: "ses-1" },
            parts: [{ type: "text", text: "Now please add tests" }],
        },
        {
            info: { id: "msg-asst-2", role: "assistant", sessionID: "ses-1" },
            parts: [{ type: "text", text: "Working on it" }],
        },
    ];
}

/**
 * The helper must match `applyTodoSynthesis` placement behavior.
 */
function runTodoSynthesis(args: {
    db: ReturnType<typeof openDatabase>;
    sessionId: string;
    messages: MessageLike[];
    isCacheBustingPass: boolean;
    fullFeatureMode: boolean;
}): void {
    if (!args.fullFeatureMode) return;
    const { db, sessionId, messages, isCacheBustingPass } = args;
    const sessionMeta = getOrCreateSessionMeta(db, sessionId);
    const persistedAnchor = getPersistedTodoSyntheticAnchor(db, sessionId);

    if (isCacheBustingPass) {
        const part = buildSyntheticTodoPart(sessionMeta.lastTodoState);
        if (part === null) {
            if (persistedAnchor) clearPersistedTodoSyntheticAnchor(db, sessionId);
            return;
        }
        if (
            persistedAnchor &&
            persistedAnchor.callId === part.callID &&
            injectPersistedTodoAnchor(messages, persistedAnchor.messageId, part)
        ) {
            // Empty `stateJson` identifies legacy rows; the backfill upgrades them.
            if (persistedAnchor.stateJson.length === 0) {
                setPersistedTodoSyntheticAnchor(
                    db,
                    sessionId,
                    persistedAnchor.callId,
                    persistedAnchor.messageId,
                    sessionMeta.lastTodoState,
                );
            }
            return;
        }
        const anchoredMessageId =
            injectToolPartIntoLatestAssistant(messages, part) ??
            injectSyntheticTodoAtHead(messages, part);
        setPersistedTodoSyntheticAnchor(
            db,
            sessionId,
            part.callID,
            anchoredMessageId,
            sessionMeta.lastTodoState,
        );
    } else if (persistedAnchor && persistedAnchor.stateJson.length > 0) {
        // During a defer pass, replay rebuilds from persisted `stateJson`.
        const part = buildSyntheticTodoPart(persistedAnchor.stateJson);
        if (part !== null && part.callID === persistedAnchor.callId) {
            injectPersistedTodoAnchor(messages, persistedAnchor.messageId, part);
        }
    }
}

function findSyntheticPart(messages: MessageLike[]): { messageId: string; part: unknown } | null {
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (isSyntheticTodoPart(part)) {
                return { messageId: msg.info.id ?? "", part };
            }
        }
    }
    return null;
}

function countSyntheticParts(messages: MessageLike[]): number {
    let n = 0;
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (isSyntheticTodoPart(part)) n += 1;
        }
    }
    return n;
}

describe("todo state synthesis — live permission cache boundaries", () => {
    it("clears on a denied bust, replays defer bytes, and resumes after re-enable", async () => {
        useTempDataHome("todo-permission-flip-");
        const db = openDatabase();
        const sessionId = "ses-permission-flip";
        let denied = false;
        const client = {
            app: {
                agents: async () => ({
                    data: [
                        {
                            name: "build",
                            permission: {
                                todowrite: denied ? "deny" : "allow",
                            },
                        },
                    ],
                }),
            },
            session: {
                get: async () => ({ data: { agent: "build" } }),
            },
        } as never;
        clearToolPermissionDenied(sessionId);
        updateSessionMeta(db, sessionId, { lastTodoState: ACTIVE_TODOS_JSON });

        const bustMessages = buildMessages();
        await applyTodoSynthesis({
            db,
            sessionId,
            messages: bustMessages,
            fullFeatureMode: true,
            isCacheBustingPass: true,
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
            todowriteAvailability: { callable: true, frozen: true },
            client,
        });
        expect(countSyntheticParts(bustMessages)).toBe(1);
        const frozenBytes = JSON.stringify(bustMessages);

        // A permission flip cannot mutate a defer prefix; the cached allow verdict is replayed until the next cache-busting pass.
        denied = true;
        updateSessionMeta(db, sessionId, {
            lastTodoState: JSON.stringify([
                { content: "Changed after bust", status: "pending", priority: "low" },
            ]),
        });
        const deferMessages = buildMessages();
        await applyTodoSynthesis({
            db,
            sessionId,
            messages: deferMessages,
            fullFeatureMode: true,
            isCacheBustingPass: false,
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
            todowriteAvailability: { callable: true, frozen: true },
            client,
        });
        expect(JSON.stringify(deferMessages)).toBe(frozenBytes);

        const deniedBustMessages = buildMessages();
        const priorSyntheticPart = buildSyntheticTodoPart(ACTIVE_TODOS_JSON);
        if (!priorSyntheticPart) throw new Error("expected active synthetic part");
        deniedBustMessages
            .find((message) => message.info.id === "msg-asst-2")
            ?.parts.push(priorSyntheticPart);
        await applyTodoSynthesis({
            db,
            sessionId,
            messages: deniedBustMessages,
            fullFeatureMode: true,
            isCacheBustingPass: true,
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
            todowriteAvailability: { callable: true, frozen: true },
            client,
        });
        expect(countSyntheticParts(deniedBustMessages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT todo_synthetic_call_id, todo_synthetic_anchor_message_id, todo_synthetic_state_json FROM session_meta WHERE session_id = ?",
                )
                .get(sessionId),
        ).toEqual({
            todo_synthetic_call_id: "",
            todo_synthetic_anchor_message_id: "",
            todo_synthetic_state_json: "",
        });

        denied = false;
        const reenabledMessages = buildMessages();
        await applyTodoSynthesis({
            db,
            sessionId,
            messages: reenabledMessages,
            fullFeatureMode: true,
            isCacheBustingPass: true,
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
            todowriteAvailability: { callable: true, frozen: true },
            client,
        });
        expect(countSyntheticParts(reenabledMessages)).toBe(1);
        expect(getPersistedTodoSyntheticAnchor(db, sessionId)?.stateJson).toBe(
            getOrCreateSessionMeta(db, sessionId).lastTodoState,
        );
    });
});

describe("todo state synthesis — cache-busting branches", () => {
    it("Branch 1: cache-bust + render null + no sticky → no-op", () => {
        useTempDataHome("todo-b1-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, "ses-1"); // ensure row
        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });
        expect(countSyntheticParts(messages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toBeNull();
    });

    it("Branch 2: cache-bust + render null + sticky exists → DB clear, no message mutation", () => {
        useTempDataHome("todo-b2-");
        const db = openDatabase();
        // Set sticky
        // Sticky carries an old active state JSON; current snapshot is terminal-only.
        setPersistedTodoSyntheticAnchor(
            db,
            "ses-1",
            "mc_synthetic_todo_old",
            "msg-asst-1",
            ACTIVE_TODOS_JSON,
        );
        updateSessionMeta(db, "ses-1", { lastTodoState: TERMINAL_TODOS_JSON });

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toBeNull();
    });

    it("Branch 3: cache-bust + render same as sticky + anchor present → idempotent re-inject", () => {
        useTempDataHome("todo-b3-");
        const db = openDatabase();
        const expectedCallId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(
            db,
            "ses-1",
            expectedCallId,
            "msg-asst-2",
            ACTIVE_TODOS_JSON,
        );

        const messages = buildMessages();
        // The pre-seeded part simulates injection on a prior persisted pass.
        const part = buildSyntheticTodoPart(ACTIVE_TODOS_JSON);
        if (!part) throw new Error("part null");
        const asst2 = messages.find((m) => m.info.id === "msg-asst-2");
        if (!asst2) throw new Error("asst-2 missing");
        asst2.parts.push(part);

        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        expect(found?.messageId).toBe("msg-asst-2");
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toEqual({
            callId: expectedCallId,
            messageId: "msg-asst-2",
            stateJson: ACTIVE_TODOS_JSON,
        });
    });

    it("Branch 3 (fresh-message variant): cache-bust + matching anchor + no pre-seeded synthetic → injection lands at persisted anchor", () => {
        // The replay injects at the matching persisted anchor when OpenCode rebuilds messages without synthetic parts.
        // OpenCode can rebuild messages without synthetic parts while the persisted anchor remains valid.
        // Injection must land at the persisted anchor message.
        useTempDataHome("todo-b3-fresh-");
        const db = openDatabase();
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        // Injection must anchor at `msg-asst-1`, not the latest assistant message.
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-asst-1", ACTIVE_TODOS_JSON);

        const messages = buildMessages(); // fresh, no synthetic seeded

        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        expect(found?.messageId).toBe("msg-asst-1");
        // Anchor unchanged.
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toEqual({
            callId,
            messageId: "msg-asst-1",
            stateJson: ACTIVE_TODOS_JSON,
        });
    });

    it("Branch 4: cache-bust + sticky callId matches but anchor missing → re-anchor + persist", () => {
        useTempDataHome("todo-b4-");
        const db = openDatabase();
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-gone", ACTIVE_TODOS_JSON);

        const messages = buildMessages(); // no msg-gone

        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        expect(found?.messageId).toBe("msg-asst-2"); // latest assistant
        const anchor = getPersistedTodoSyntheticAnchor(db, "ses-1");
        expect(anchor?.callId).toBe(callId);
        expect(anchor?.messageId).toBe("msg-asst-2"); // re-anchored
    });

    it("cache-bust skips an errored persisted anchor and re-anchors to a replayable assistant", () => {
        useTempDataHome("todo-errored-reanchor-");
        const db = openDatabase();
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-asst-2", ACTIVE_TODOS_JSON);

        const messages = buildMessages();
        const errored = messages.find((m) => m.info.id === "msg-asst-2");
        if (!errored) throw new Error("errored anchor missing");
        errored.info.error = { name: "MessageAbortedError", data: { message: "aborted" } };

        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        expect(found?.messageId).toBe("msg-asst-1");
        expect(errored.parts.some((part) => isSyntheticTodoPart(part))).toBe(false);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")?.messageId).toBe("msg-asst-1");
    });

    it("Branch 5: cache-bust + render different from sticky → fresh inject + persist new callId", () => {
        useTempDataHome("todo-b5-");
        const db = openDatabase();
        const oldCallId = "mc_synthetic_todo_oldoldoldoldold0";
        const newCallId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        // Different persisted `stateJson` produces a different callId.
        setPersistedTodoSyntheticAnchor(db, "ses-1", oldCallId, "msg-asst-1", TERMINAL_TODOS_JSON);

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const anchor = getPersistedTodoSyntheticAnchor(db, "ses-1");
        expect(anchor?.callId).toBe(newCallId);
        expect(anchor?.callId).not.toBe(oldCallId);
        expect(anchor?.messageId).toBe("msg-asst-2");
    });

    it("Branch 5b: cache-bust + no assistant message uses the deterministic head anchor", () => {
        useTempDataHome("todo-b5b-");
        const db = openDatabase();
        const oldCallId = "mc_synthetic_todo_stalestale00000a";
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(db, "ses-1", oldCallId, "msg-prior", ACTIVE_TODOS_JSON);

        const messages: MessageLike[] = [
            {
                info: { id: "msg-user-only", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "hi" }],
            },
        ];

        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        expect(messages[0]?.info.id).toBe(TODO_HEAD_ANCHOR_ID);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")?.messageId).toBe(TODO_HEAD_ANCHOR_ID);
    });
});

describe("todo state synthesis — defer branches and byte stability", () => {
    it("Branch 6: defer + sticky exists → byte-identical replay only", () => {
        useTempDataHome("todo-b6-");
        const db = openDatabase();
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-asst-2", ACTIVE_TODOS_JSON);

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        expect(found?.messageId).toBe("msg-asst-2");
        // Anchor unchanged
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toEqual({
            callId,
            messageId: "msg-asst-2",
            stateJson: ACTIVE_TODOS_JSON,
        });
    });

    it("Branch 6b: defer skips an errored persisted anchor without relocating it", () => {
        useTempDataHome("todo-errored-defer-");
        const db = openDatabase();
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-asst-2", ACTIVE_TODOS_JSON);

        const messages = buildMessages();
        const errored = messages.find((m) => m.info.id === "msg-asst-2");
        if (!errored) throw new Error("errored anchor missing");
        errored.info.error = { name: "APIError", data: { message: "failed" } };

        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")?.messageId).toBe("msg-asst-2");
    });

    it("Branch 7: defer + no sticky → no-op", () => {
        useTempDataHome("todo-b7-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toBeNull();
    });

    it("CACHE STABILITY: 5 consecutive defer passes produce byte-identical message arrays", () => {
        useTempDataHome("todo-stable-");
        const db = openDatabase();
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-asst-2", ACTIVE_TODOS_JSON);

        const initialMessages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: initialMessages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });
        const baseline = JSON.stringify(initialMessages);

        for (let i = 0; i < 5; i += 1) {
            const messages = buildMessages();
            runTodoSynthesis({
                db,
                sessionId: "ses-1",
                messages,
                isCacheBustingPass: false,
                fullFeatureMode: true,
            });
            expect(JSON.stringify(messages)).toBe(baseline);
        }
    });

    it("CACHE STABILITY: defer replays PERSISTED state JSON, not last_todo_state (Council Finding #1)", () => {
        // A real `todowrite` can update `lastTodoState` between cache-busting and defer passes.
        // The defer pass must replay the state persisted by the preceding cache-busting pass.
        // The defer pass replays the state at the persisted anchor to preserve the cached prefix.
        // Replaying newer state changes the prefix at the persisted anchor.
        // A changed prefix prevents prompt-cache reuse.
        useTempDataHome("todo-finding1-");
        const db = openDatabase();
        const oldCallId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        setPersistedTodoSyntheticAnchor(db, "ses-1", oldCallId, "msg-asst-2", ACTIVE_TODOS_JSON);
        const newState = JSON.stringify([
            { content: "Brand new todo", status: "pending", priority: "low" },
        ]);
        updateSessionMeta(db, "ses-1", { lastTodoState: newState });

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });

        expect(countSyntheticParts(messages)).toBe(1);
        const found = findSyntheticPart(messages);
        expect(found?.messageId).toBe("msg-asst-2");
        const part = found?.part as { callID?: string };
        expect(part?.callID).toBe(oldCallId);
        // The next cache-busting pass uses `lastTodoState` instead of the persisted anchor state.
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toEqual({
            callId: oldCallId,
            messageId: "msg-asst-2",
            stateJson: ACTIVE_TODOS_JSON,
        });
    });

    it("CACHE STABILITY: T0 cache-bust → T1 defer with fresh messages → byte-identical (Council Finding #3)", () => {
        // Rebuilt-message defer passes must reproduce cache-busting output byte-for-byte.
        useTempDataHome("todo-t0-t1-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });

        const t0Messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t0Messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });
        const t0Bytes = JSON.stringify(t0Messages);
        expect(countSyntheticParts(t0Messages)).toBe(1);

        const t1Messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t1Messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });
        const t1Bytes = JSON.stringify(t1Messages);

        expect(t1Bytes).toBe(t0Bytes);
    });

    it("CACHE STABILITY: T0 cache-bust → real todowrite → T1 defer → still byte-identical (Council Finding #1 e2e)", () => {
        // The defer output must equal the preceding cache-busting output byte-for-byte.
        useTempDataHome("todo-t0-t1-changed-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });

        const t0Messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t0Messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });
        const t0Bytes = JSON.stringify(t0Messages);

        // A real `todowrite` fires between T0 and T1, updating `lastTodoState`.
        const newState = JSON.stringify([
            { content: "different", status: "in_progress", priority: "high" },
        ]);
        updateSessionMeta(db, "ses-1", { lastTodoState: newState });

        const t1Messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t1Messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });
        const t1Bytes = JSON.stringify(t1Messages);

        // T1 must equal T0 byte-for-byte even though `lastTodoState` changed.
        expect(t1Bytes).toBe(t0Bytes);
    });

    it("CACHE STABILITY: legacy row with empty stateJson self-heals on cache-bust + replays on next defer (Oracle final audit)", () => {
        // Persisted `stateJson === ""` identifies a legacy anchor requiring repair.
        // The repair backfills anchors with `stateJson === ""` before defer replay.
        // An empty stateJson prevents the defer pass from replaying the synthetic part.
        useTempDataHome("todo-legacy-stateJson-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });
        const callId = computeSyntheticCallId(ACTIVE_TODOS_JSON);
        setPersistedTodoSyntheticAnchor(db, "ses-1", callId, "msg-asst-2", "");

        // The cache-bust pass must preserve the anchor message's existing synthetic part.
        const part = buildSyntheticTodoPart(ACTIVE_TODOS_JSON);
        if (!part) throw new Error("part null");
        const asst2 = buildMessages().find((m) => m.info.id === "msg-asst-2");
        if (!asst2) throw new Error("asst-2 missing");

        const t0Messages = buildMessages();
        const t0Asst2 = t0Messages.find((m) => m.info.id === "msg-asst-2");
        if (!t0Asst2) throw new Error("t0 asst-2 missing");
        t0Asst2.parts.push(part);
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t0Messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });
        const t0Bytes = JSON.stringify(t0Messages);

        const after = getPersistedTodoSyntheticAnchor(db, "ses-1");
        expect(after?.callId).toBe(callId);
        expect(after?.messageId).toBe("msg-asst-2");
        expect(after?.stateJson).toBe(ACTIVE_TODOS_JSON);

        // Without stateJson backfill, the defer pass skips injection and changes the serialized messages.
        const t1Messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages: t1Messages,
            isCacheBustingPass: false,
            fullFeatureMode: true,
        });
        const t1Bytes = JSON.stringify(t1Messages);

        expect(t1Bytes).toBe(t0Bytes);
    });
});

describe("todo state synthesis — feature gates", () => {
    it("subagent sessions skip synthesis (fullFeatureMode=false)", () => {
        useTempDataHome("todo-subagent-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: false,
        });

        expect(countSyntheticParts(messages)).toBe(0);
        expect(getPersistedTodoSyntheticAnchor(db, "ses-1")).toBeNull();
    });
});

describe("todo state synthesis — wire shape", () => {
    it("injected part matches OpenCode's todowrite tool part shape exactly", () => {
        useTempDataHome("todo-wire-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", { lastTodoState: ACTIVE_TODOS_JSON });

        const messages = buildMessages();
        runTodoSynthesis({
            db,
            sessionId: "ses-1",
            messages,
            isCacheBustingPass: true,
            fullFeatureMode: true,
        });

        const found = findSyntheticPart(messages);
        if (!found) throw new Error("synthetic part missing");
        const part = found.part as Record<string, unknown>;

        // serialization downstream.
        expect(part.type).toBe("tool");
        expect(part.tool).toBe("todowrite");
        expect(typeof part.callID).toBe("string");
        expect(part.state).toBeDefined();
        const state = part.state as Record<string, unknown>;
        expect(state.status).toBe("completed");
        expect((state.input as { todos: unknown[] }).todos).toBeDefined();
        expect(typeof state.output).toBe("string");
        expect(state.metadata).toBeDefined();
        expect(state.time).toBeDefined();
    });
});
