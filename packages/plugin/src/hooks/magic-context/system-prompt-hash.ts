import { createHash } from "node:crypto";
import { buildMagicContextSection } from "../../agents/magic-context-prompt";
import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import {
    createPromptSurfaceGuidanceEpochCache,
    createPromptSurfaceRuntime,
    promptSurfaceHashMaterial,
} from "../../shared/prompt-surface-runtime";
import { resolveCtxReduceAvailability } from "./ctx-reduce-availability";
import {
    INTERNAL_OPENCODE_AGENT_SIGNATURES,
    MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES,
} from "./internal-agent-signatures";

import { estimateTokens } from "./read-session-formatting";

const MAGIC_CONTEXT_MARKER = "## Magic Context";
const SYSTEM_PROMPT_GUIDANCE_SEPARATOR = "\n\n";
// The `session.deleted` handler clears cached entries to bound cache growth.
/**
 */
export function clearSystemPromptHashSession(
    sessionId: string,
    handleMaps: {
        stickyDateBySession: Map<string, string>;
        cachedDocsBySession: Map<string, string | null>;
    },
): void {
    handleMaps.stickyDateBySession.delete(sessionId);
    handleMaps.cachedDocsBySession.delete(sessionId);
}

/**
 * prompt/{title,summary,compaction}.txt`).
 *
 *
 */
function isInternalOpenCodeAgent(systemPromptContent: string): boolean {
    return INTERNAL_OPENCODE_AGENT_SIGNATURES.some((signature) =>
        systemPromptContent.includes(signature),
    );
}

/**
 * Hidden child agents use fixed identities, so they must not receive the MC guidance block.
 *
 *
 */
export function isMagicContextInternalAgent(systemPromptContent: string): boolean {
    return MAGIC_CONTEXT_INTERNAL_AGENT_SIGNATURES.some((signature) =>
        systemPromptContent.includes(signature),
    );
}

/**
 *
 *
 */
export function createSystemPromptHashHandler(deps: {
    db: ContextDatabase;
    protectedTags: number;
    dreamerEnabled: boolean;
    /**
     * `ctx_search` guidance remains because `ctx_search` recalls conversations and Git commits.
     * */
    memoryEnabled?: boolean;
    /* */
    language?: string;
    promptSurface?: PromptSurfaceConfig;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    /** `resolveModel` recovers the session's latest model when the transform input omits it. */
    resolveModel?: (sessionId: string) => { providerID: string; modelID: string } | undefined;
    /**
     */
    systemPromptRefreshSessions: Set<string>;
    /**
     */
    historyRefreshSessions: Set<string>;
    pendingMaterializationSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    /**
     * When false, Magic Context skips all system-prompt injection for all agents.
     */
    injectionEnabled?: boolean;
    /**
     * Magic Context skips all injection for a call when the agent's system prompt contains a configured substring.
     * globally.
     */
    injectionSkipSignatures?: string[];
    /**
     * `internalChildSessions` contains Magic Context hidden child sessions, which receive no injection.
     * Internal child sessions receive no injection because they use fixed agent prompts.
     * Prompt-signature detection skips internal child sessions during pass 1 when session-created tracking has not completed.
     */
    internalChildSessions?: Set<string>;
    /** @deprecated user memories now render in m[0]/m[1], not system prompt. */
    experimentalUserMemories?: boolean;
    /** @deprecated key files now render in m[1], not system prompt. */
    experimentalPinKeyFiles?: boolean;
    /** @deprecated key files now render in m[1], not system prompt. */
    experimentalPinKeyFilesTokenBudget?: number;
    /** `experimentalTemporalAwareness` adds a temporal-awareness guidance paragraph and surface compartment dates when true. */
    experimentalTemporalAwareness?: boolean;
    /** `experimentalCavemanTextCompression` warns the agent when history compression is enabled so the agent does not mimic compressed output.
     * */
    experimentalCavemanTextCompression?: boolean;
}): {
    handler: (
        input: {
            sessionID?: string;
            model?: { providerID?: string; modelID?: string };
        },
        output: { system: string[] },
    ) => Promise<void>;
    clearSession: (sessionId: string) => void;
} {
    const promptSurfaceRuntime =
        deps.promptSurfaceRuntime ??
        createPromptSurfaceRuntime({
            userConfigDirectory: process.cwd(),
            warn: (message) => console.warn(`[magic-context] config warning: ${message}`),
        });
    const guidanceEpochs = createPromptSurfaceGuidanceEpochCache(promptSurfaceRuntime);

    // Sticky dates change only on cache-busting passes, preventing midnight cache rebuilds.
    const stickyDateBySession = new Map<string, string>();

    const handler = async (
        input: {
            sessionID?: string;
            model?: { providerID?: string; modelID?: string };
        },
        output: { system: string[] },
    ): Promise<void> => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        // The handler skips OpenCode's internal hidden agents.
        //
        // OpenCode invokes `experimental.chat.system.transform` for every session LLM call, including hidden agents.
        //   - "title": runs once on the first user turn against `small_model`
        // The title agent uses `small_model` or the active model's small variant.
        // The title agent generates a session title from the first user message.
        // The `summary` agent produces session exports and pull-request-style descriptions.
        // The `compaction` agent performs OpenCode auto-compaction summarization.
        //
        // These agents:
        // These agents have no tools, `ctx_reduce`, or nudges, so Magic Context guidance cannot affect their fixed single-shot tasks.
        // OpenCode's internal agents receive project and user context irrelevant to their fixed tasks.
        // OpenCode's internal agents receive Magic Context guidance irrelevant to their fixed tasks.
        //
        // The hook exposes only `{ sessionID, model }`, so detection cannot dispatch by agent name.
        // These signatures are the first instruction lines of each internal prompt.
        const fullPromptForDetection = output.system.join("\n");
        if (isInternalOpenCodeAgent(fullPromptForDetection)) {
            sessionLog(
                sessionId,
                "system-prompt-hash skipped (OpenCode internal agent: title/summary/compaction)",
            );
            return;
        }

        // Magic Context's historian, dreamer, sidekick, and memory-migration sessions must not receive Magic Context injection.
        // A Magic Context internal-agent match skips injection and hash tracking.
        if (
            deps.internalChildSessions?.has(sessionId) ||
            isMagicContextInternalAgent(fullPromptForDetection)
        ) {
            sessionLog(
                sessionId,
                "system-prompt-hash skipped (Magic Context internal child: historian/dreamer/sidekick/migration)",
            );
            return;
        }

        //
        // `system_prompt_injection.enabled: false` disables injection globally.
        // `system_prompt_injection.skip_signatures` disables injection for matching prompt signatures.
        // A matching signature skips injection only for the current call.
        //
        // Skipping hash tracking prevents matching prompts from causing cross-agent hash-change flushes.
        // hash-change flushes.
        const injectionEnabled = deps.injectionEnabled !== false;
        const skipSignatures = deps.injectionSkipSignatures ?? [];
        if (!injectionEnabled) {
            sessionLog(sessionId, "system-prompt-hash skipped (injection globally disabled)");
            return;
        }
        if (skipSignatures.some((sig) => sig.length > 0 && fullPromptForDetection.includes(sig))) {
            sessionLog(
                sessionId,
                "system-prompt-hash skipped (matched system_prompt_injection.skip_signatures)",
            );
            return;
        }

        // Subagents that can call `ctx_reduce` receive only drop-mechanics guidance.
        // `ctx_reduce`-disabled subagents receive no Magic Context guidance.
        // The primary-session no-reduce block describes memory, search, and note behavior that does not apply to bounded, parent-driven child tasks.
        let sessionMetaEarly: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            sessionMetaEarly = getOrCreateSessionMeta(deps.db, sessionId);
        } catch (error) {
            sessionLog(sessionId, "system-prompt-hash session meta load failed:", error);
        }
        const isSubagentSession = sessionMetaEarly?.isSubagent === true;
        // `ctx_reduce` is disabled for sessions whose spawn-tool map excludes it because guidance for an uncallable tool would direct the subagent to an unavailable action.
        // `resolveCtxReduceAvailability` freezes the reduce-enabled verdict on the first user message to avoid changing a persisted hash and busting the prompt cache.
        const availability = resolveCtxReduceAvailability(sessionId);
        const ctxReduceCallable = availability.callable;
        const subagentReduceMode = isSubagentSession && ctxReduceCallable;
        const effectiveCtxReduceEnabled = isSubagentSession ? false : ctxReduceCallable;
        const skipGuidanceForDisabledSubagent = isSubagentSession && !ctxReduceCallable;
        const inputModel = input.model;
        const liveModel =
            inputModel?.providerID && inputModel.modelID
                ? { providerID: inputModel.providerID, modelID: inputModel.modelID }
                : deps.resolveModel?.(sessionId);
        const modelKey =
            liveModel?.providerID && liveModel.modelID
                ? piModelRefToCanonical(`${liveModel.providerID}/${liveModel.modelID}`)
                : undefined;
        const promptSurface = guidanceEpochs.resolve(sessionId, deps.promptSurface, modelKey);
        const fullPrompt = output.system.join("\n");
        if (
            fullPrompt.length > 0 &&
            !fullPrompt.includes(MAGIC_CONTEXT_MARKER) &&
            !skipGuidanceForDisabledSubagent
        ) {
            const guidance = buildMagicContextSection(
                null,
                deps.protectedTags,
                effectiveCtxReduceEnabled,
                deps.dreamerEnabled,
                deps.experimentalTemporalAwareness,
                deps.experimentalCavemanTextCompression,
                subagentReduceMode,
                deps.language,
                deps.memoryEnabled !== false,
                promptSurface.preset,
                promptSurface.primaryOverride,
            );
            // OpenAI-compatible templates append guidance to the host entry because they allow only one system message.
            output.system[0] = `${output.system[0]}${SYSTEM_PROMPT_GUIDANCE_SEPARATOR}${guidance}`;
            sessionLog(
                sessionId,
                `injected generic guidance into system prompt (ctxReduce=${effectiveCtxReduceEnabled}, subagent=${isSubagentSession}, subagentReduceMode=${subagentReduceMode})`,
            );
        }

        const isCacheBusting = deps.systemPromptRefreshSessions.has(sessionId);

        const DATE_PATTERN = /Today's date: .+/;
        const DATE_PATTERN_ALL = /Today's date: .+/g;
        const liveSystemContent = output.system.join("\n");
        if (liveSystemContent.length === 0) return;
        const previousHash = sessionMetaEarly?.systemPromptHash ?? "";
        const hasPersistedHash = previousHash !== "" && previousHash !== "0";
        // Every element containing a date line participates in freezing.
        // A host prompt with a matching date line must freeze that line too; otherwise its hash changes at midnight.
        const dateElementIndexes: number[] = [];
        let currentDate: string | undefined;
        for (let i = 0; i < output.system.length; i++) {
            const match = output.system[i].match(DATE_PATTERN);
            if (!match) continue;
            dateElementIndexes.push(i);
            currentDate ??= match[0];
        }
        const stickyDate = stickyDateBySession.get(sessionId);
        const stableCandidate =
            currentDate && stickyDate && currentDate !== stickyDate
                ? liveSystemContent.replace(DATE_PATTERN_ALL, stickyDate)
                : liveSystemContent;
        const stableCandidateHash = createHash("md5")
            .update(promptSurfaceHashMaterial(stableCandidate, promptSurface.preset))
            .digest("hex");
        const contentOrPresetChanged = hasPersistedHash && stableCandidateHash !== previousHash;
        const dateMayAdvance = isCacheBusting || contentOrPresetChanged;

        if (currentDate && !stickyDate) {
            stickyDateBySession.set(sessionId, currentDate);
        } else if (currentDate && stickyDate && currentDate !== stickyDate) {
            if (dateMayAdvance) {
                stickyDateBySession.set(sessionId, currentDate);
                sessionLog(
                    sessionId,
                    `system prompt date updated: ${stickyDate} → ${currentDate} (cache-busting pass)`,
                );
            } else if (dateElementIndexes.length > 0) {
                for (const index of dateElementIndexes) {
                    output.system[index] = output.system[index].replace(
                        DATE_PATTERN_ALL,
                        stickyDate,
                    );
                }
                sessionLog(
                    sessionId,
                    `system prompt date frozen: real=${currentDate}, using=${stickyDate} (defer pass)`,
                );
            }
        }

        const systemContent = output.system.join("\n");

        // A provisional tool verdict or unknown model may render a prompt but must not persist its hash.
        if (!availability.frozen || !modelKey) return;

        // The code uses a hex digest to prevent SQLite INTEGER coercion from losing hash precision on read-back and causing infinite hash-change flushes.
        const currentHash = createHash("md5")
            .update(promptSurfaceHashMaterial(systemContent, promptSurface.preset))
            .digest("hex");

        // The function returns after a failed Step 1 read because hash-change detection requires prior metadata.
        // previous hash.
        if (!sessionMetaEarly) {
            return;
        }
        const sessionMeta = sessionMetaEarly;
        if (previousHash !== "" && previousHash !== "0" && previousHash !== currentHash) {
            sessionLog(
                sessionId,
                `system prompt hash changed: ${previousHash} → ${currentHash} (len=${systemContent.length}), triggering flush`,
            );
            // A prompt-content or preset change must refresh history, adjuncts, and materialization together.
            deps.historyRefreshSessions.add(sessionId);
            deps.systemPromptRefreshSessions.add(sessionId);
            deps.pendingMaterializationSessions.add(sessionId);
            deps.lastHeuristicsTurnId.delete(sessionId);
        } else if (previousHash === "" || previousHash === "0") {
            sessionLog(
                sessionId,
                `system prompt hash initialized: ${currentHash} (len=${systemContent.length})`,
            );
        }

        //
        // Token-estimation and metadata-write failures must not abort the LLM call.
        // The handler attempts to persist currentHash after token-estimation failure to avoid re-flushing on the next pass.
        if (currentHash !== previousHash) {
            let systemPromptTokens = sessionMeta.systemPromptTokens;
            try {
                systemPromptTokens = estimateTokens(systemContent);
            } catch (error) {
                sessionLog(
                    sessionId,
                    "system prompt token estimate failed (using prior count):",
                    error,
                );
            }
            try {
                updateSessionMeta(deps.db, sessionId, {
                    systemPromptHash: currentHash,
                    systemPromptTokens,
                });
            } catch (error) {
                sessionLog(sessionId, "system prompt meta persist failed (fail-open):", error);
            }
        }

        // Later passes within the TTL must reuse cached adjuncts to preserve the system-prompt cache prefix.
        //
        //
        //
        // A hash change can add isCacheBusting after adjuncts have already been read.
        // The handler retains a flag added after the adjunct read for the next pass.
        //    forever.
        //
        //
        if (isCacheBusting) {
            deps.systemPromptRefreshSessions.delete(sessionId);
        }
    };

    return {
        handler,
        clearSession: (sessionId: string) => {
            guidanceEpochs.clear(sessionId);
            clearSystemPromptHashSession(sessionId, {
                stickyDateBySession,
                cachedDocsBySession: new Map(),
            });
        },
    };
}
