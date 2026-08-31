import {
    type FailClosedController,
    isFailClosedBlockingError,
    resolveAgentNameFromMessages,
    shouldBypassFailClosedBlock,
} from "../features/magic-context/fail-closed-block";
import { getOrCreateSessionMeta, openDatabase } from "../features/magic-context/storage";
import {
    getOverflowState,
    isEmergencyRecoveryArmed,
} from "../features/magic-context/storage-meta-persisted";
import { updateSessionMeta } from "../features/magic-context/storage-meta-session";
import { EmergencyFailClosedError } from "../hooks/magic-context/emergency-fail-closed";
import { replayLkg, resolveLkgModelKeys } from "../hooks/magic-context/lkg-replay";
import { dropSlot, getSlot, noteEntry } from "../hooks/magic-context/lkg-slot";
import { RawFallbackContextLimitError } from "../hooks/magic-context/raw-fallback-context-limit";
import type { MessageLike } from "../hooks/magic-context/transform-operations";
import { log, sessionLog } from "../shared/logger";

// The next transform pass retries SQLITE_BUSY and SQLITE_LOCKED.
// covered defensively).
const TRANSIENT_SQLITE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

type MessageWithParts = {
    info: import("@opencode-ai/sdk").Message;
    parts: import("@opencode-ai/sdk").Part[];
};

type MessagesTransformOutput = { messages: MessageWithParts[] };

type MagicContextTransformHooks = {
    "experimental.chat.messages.transform"?: (
        input: Record<string, never>,
        output: MessagesTransformOutput,
    ) => Promise<void>;
} | null;

function replaceMessagesInPlace(output: MessagesTransformOutput, next: MessageWithParts[]): void {
    if (output.messages !== next) output.messages.splice(0, output.messages.length, ...next);
}

/**
 * https://github.com/cortexkit/magic-context/issues/23
 *
 *
 *
 *
 *        observability.
 *
 * Errors other than `FailClosedBlockingError` leave the turn without injection or drops.
 * When `fail_closed_blocking` is enabled, `FailClosedBlockingError` aborts the turn.
 *
 * Persistent state mutations in the inner transform are idempotent across passes.
 */
export function createMessagesTransformHandler(args: {
    magicContext: MagicContextTransformHooks;
    /**
     * getMagicContext lets a healed storage reopen swap in real hooks without rebuilding the outer wrapper.
     */
    getMagicContext?: () => MagicContextTransformHooks;
    failClosed?: FailClosedController | null;
    failClosedBlockingEnabled?: boolean;
    /**
     * When compactionOff is true, fail-closed blocking is inert because native compaction or no compaction controls the context window.
     * With compactionOff, a failed transform passes through the input messages without injection or drops.
     * Passthrough emits no blocking message, cancels no request, and logs one diagnostic.
     * When compactionOff is true, FailClosedBlockingError from failClosed.enforce degrades to passthrough.
     */
    compactionOff?: boolean;
    internalChildSessions?: Set<string>;
    tryReopenStorage?: () => boolean | Promise<boolean>;
}): (input: Record<string, never>, output: MessagesTransformOutput) => Promise<MessageWithParts[]> {
    return async (input, output): Promise<MessageWithParts[]> => {
        const sessionId = resolveSessionId(output);
        const agent = resolveAgentNameFromMessages(output.messages);
        const isInternalChild =
            typeof sessionId === "string" &&
            sessionId.length > 0 &&
            args.internalChildSessions?.has(sessionId) === true;
        // Compaction-off gates every stage that writes retained message internals.
        // The compaction-off additive path prepends only new synthetic message objects.
        // Retained input messages remain read-only.
        // stay read-only.
        const compactionOffInputSnapshot = args.compactionOff ? [...output.messages] : null;
        const restoreCompactionOffInput = (): void => {
            if (compactionOffInputSnapshot && output.messages !== compactionOffInputSnapshot) {
                output.messages.splice(0, output.messages.length, ...compactionOffInputSnapshot);
            }
        };

        if (args.failClosed) {
            try {
                await args.failClosed.enforce({
                    blockingEnabled: args.failClosedBlockingEnabled !== false,
                    exempt: shouldBypassFailClosedBlock({
                        agent,
                        isInternalChildSession: isInternalChild,
                    }),
                    tryReopen: args.tryReopenStorage,
                });
            } catch (error) {
                // When compactionOff is true, a storage-unavailable fail-closed gate returns passthrough instead of blocking the turn.
                if (args.compactionOff && isFailClosedBlockingError(error)) {
                    log(
                        `[magic-context] compaction-off: fail-closed inert, passing through: ${error.message}`,
                    );
                    restoreCompactionOffInput();
                    return output.messages;
                }
                throw error;
            }
        }

        const magicContext = args.getMagicContext ? args.getMagicContext() : args.magicContext;
        const slotAtEntry = sessionId ? getSlot(sessionId) : undefined;
        const entry = slotAtEntry
            ? (() => {
                  try {
                      return noteEntry(sessionId as string, output.messages as MessageLike[]);
                  } catch (error) {
                      sessionLog(
                          sessionId as string,
                          "lkg entry snapshot failed; replay unavailable",
                          error,
                      );
                      return null;
                  }
              })()
            : null;
        try {
            await magicContext?.["experimental.chat.messages.transform"]?.(input, output);
            return output.messages;
        } catch (error) {
            if (error instanceof RawFallbackContextLimitError) throw error;
            if (error instanceof EmergencyFailClosedError || isFailClosedBlockingError(error)) {
                if (!args.compactionOff) throw error;
                log(
                    `[magic-context] compaction-off: fail-closed inert, passing through: ${error instanceof Error ? error.message : String(error)}`,
                );
                restoreCompactionOffInput();
                return output.messages;
            }
            if (args.compactionOff) {
                // When compactionOff is true, the transform does not replay LKG.
                // transformed array.
                restoreCompactionOffInput();
            } else if (sessionId && slotAtEntry && !entry) {
                dropSlot(sessionId, "lkg_invalidated_reshape");
                sessionLog(sessionId, "lkg_invalidated_reshape");
            } else if (sessionId && entry) {
                let replayBlocked = false;
                try {
                    const db = openDatabase();
                    if (
                        !db ||
                        isEmergencyRecoveryArmed(sessionId) ||
                        getOverflowState(db, sessionId).needsEmergencyRecovery
                    ) {
                        replayBlocked = true;
                        sessionLog(sessionId, "lkg_emergency_armed");
                    } else {
                        const keys = resolveLkgModelKeys(output.messages as MessageLike[]);
                        const replay = replayLkg({
                            sessionId,
                            messages: output.messages as MessageLike[],
                            modelKey: keys.modelKey,
                            providerKey: keys.providerKey,
                            entry,
                        });
                        if (replay.ok) {
                            replaceMessagesInPlace(
                                output,
                                replay.messages as unknown as MessageWithParts[],
                            );
                            sessionLog(sessionId, "lkg_replay_served");
                            return output.messages;
                        }
                        sessionLog(sessionId, replay.reason);
                    }
                } catch (replayError) {
                    replayBlocked = true;
                    sessionLog(sessionId, "lkg_replay_unavailable", replayError);
                }
                if (replayBlocked) {
                    sessionLog(sessionId, "lkg_replay_declined");
                }
            } else if (sessionId) {
                sessionLog(sessionId, "lkg_miss");
            }
            const code = (error as { code?: string } | null)?.code;
            const name = (error as { name?: string } | null)?.name;
            const message = error instanceof Error ? error.message : String(error);
            const isTransient = typeof code === "string" && TRANSIENT_SQLITE_CODES.has(code);

            if (isTransient) {
                log(
                    `[magic-context] transform skipped this pass — ${code} (transient; retrying next pass): ${message}`,
                );
                restoreCompactionOffInput();
                return output.messages;
            }

            log(
                `[magic-context] transform FAILED code=${code ?? "none"} name=${name ?? "none"}: ${message}. Continuing with unmodified messages for this pass.`,
                error,
            );

            const persistSessionId = resolveSessionId(output);
            if (persistSessionId) {
                try {
                    const db = openDatabase();
                    if (db) {
                        const summary = truncateError(name, code, message);
                        const current = getOrCreateSessionMeta(
                            db,
                            persistSessionId,
                        ).lastTransformError;
                        if (current !== summary) {
                            updateSessionMeta(db, persistSessionId, {
                                lastTransformError: summary,
                            });
                        }
                    }
                } catch (persistError) {
                    log("[magic-context] failed to persist transform error:", persistError);
                }
            }
        }
        restoreCompactionOffInput();
        return output.messages;
    };
}

function resolveSessionId(output: MessagesTransformOutput): string | null {
    for (const message of output.messages) {
        const sid = (message.info as { sessionID?: string } | undefined)?.sessionID;
        if (typeof sid === "string" && sid.length > 0) return sid;
    }
    return null;
}

function truncateError(
    name: string | undefined,
    code: string | undefined,
    message: string,
    maxLen = 240,
): string {
    const prefix = `${name ?? "Error"}${code ? ` [${code}]` : ""}: `;
    const budget = Math.max(20, maxLen - prefix.length);
    const trimmed = message.length > budget ? `${message.slice(0, budget)}…` : message;
    return `${prefix}${trimmed}`;
}
