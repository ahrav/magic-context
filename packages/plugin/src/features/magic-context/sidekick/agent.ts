import { withContentLanguageDirective } from "../../../agents/language-directive";
import { SIDEKICK_AGENT } from "../../../agents/sidekick";
import type { SidekickConfig } from "../../../config/schema/magic-context";
import {
    childSessionMessagesFetcher,
    createChildSessionWithFence,
} from "../../../hooks/magic-context/child-session-spawn";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log, sessionLog } from "../../../shared/logger";
import { resolveFallbackChain } from "../../../shared/resolve-fallbacks";
import { openDatabase } from "../storage";
import { recordChildInvocation } from "../subagent-token-capture";
import { SIDEKICK_SYSTEM_PROMPT, stripThinkingBlocks } from "./core";

export { SIDEKICK_SYSTEM_PROMPT };

export async function runSidekick(deps: {
    client: PluginContext["client"];
    sessionId?: string;
    projectPath: string;
    userMessage: string;
    config: SidekickConfig;
    sessionDirectory?: string;
    language?: string;
}): Promise<string | null> {
    const fallbackModels = resolveFallbackChain(deps.config.fallback_models);
    let agentSessionId: string | null = null;
    const startedAt = Date.now();
    let invocationRecorded = false;
    const recordInvocation = (params: {
        status: "completed" | "failed";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!deps.sessionId || invocationRecorded) return;
        invocationRecorded = true;
        try {
            recordChildInvocation({
                db: openDatabase(),
                parentSessionId: deps.sessionId,
                harness: "opencode",
                subagent: "sidekick",
                startedAt,
                status: params.status,
                messages: params.messages,
                error: params.error,
            });
        } catch (error) {
            sessionLog(deps.sessionId, "subagent token accounting unavailable:", error);
        }
    };

    try {
        const createResponse = await createChildSessionWithFence({
            client: deps.client,
            db: openDatabase(),
            parentSessionId: deps.sessionId,
            title: "magic-context-sidekick",
            directory: deps.sessionDirectory ?? deps.projectPath,
        });
        const createdSession = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;
        if (!agentSessionId) {
            const error = new Error("Sidekick could not create its child session.");
            recordInvocation({ status: "failed", error });
            throw error;
        }
        const childSessionId = agentSessionId;

        const systemPrompt = withContentLanguageDirective(
            deps.config.system_prompt?.trim() ||
                deps.config.prompt?.trim() ||
                SIDEKICK_SYSTEM_PROMPT,
            deps.language,
        );

        const sidekickRun = await shared.promptSyncWithValidatedOutputRetry(
            deps.client,
            {
                path: { id: childSessionId },
                query: { directory: deps.sessionDirectory ?? deps.projectPath },
                body: {
                    agent: SIDEKICK_AGENT,
                    system: systemPrompt,
                    // synthetic: true hides the sidekick prompt from the TUI subagent
                    // pane while still delivering it to the model.
                    parts: [{ type: "text", text: deps.userMessage, synthetic: true }],
                },
            },
            {
                timeoutMs: deps.config.timeout_ms,
                fallbackModels,
                callContext: "sidekick",
                fetchOutput: childSessionMessagesFetcher(
                    deps.client,
                    childSessionId,
                    deps.sessionDirectory ?? deps.projectPath,
                    50,
                ),
                validateOutput: (messages) => {
                    const taskResult = extractLatestAssistantText(messages);
                    if (!taskResult) {
                        throw new Error("Sidekick returned no assistant output.");
                    }
                    const finalText = stripThinkingBlocks(taskResult);
                    if (finalText.length === 0) {
                        throw new Error("Sidekick returned no assistant output.");
                    }
                    return finalText;
                },
            },
        );

        recordInvocation({ status: "completed", messages: sidekickRun.output });
        return sidekickRun.validated;
    } catch (error) {
        recordInvocation({ status: "failed", error });
        if (deps.sessionId) {
            sessionLog(deps.sessionId, "sidekick failed:", error);
        } else {
            log("[magic-context] sidekick failed:", error);
        }
        return null;
    } finally {
        if (agentSessionId && !shouldKeepSubagents()) {
            await deps.client.session
                .delete({
                    path: { id: agentSessionId },
                })
                .catch((error: unknown) => {
                    log("[magic-context] failed to delete sidekick child session:", error);
                });
        }
    }
}
